//! RDF/XML → quads (W3C RDF 1.1 XML Syntax), on the XML parser of `xml.rs` (`rdfxml.ts`,
//! ported as it is; RFC 0002, D-9). The quads go through the same mapping as Turtle.

use std::rc::Rc;

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{self, IndexMap, Lookup, Object};

use crate::detect::{XmlKind, XmlRootInfo, classify_xml_root, unsupported_format};
use crate::iri::resolve_iri;
use crate::prefixes::RDF_NS;
use crate::rdf::RdfDocument;
use crate::shared::{compare_strings, invalid_input_with, slice_utf16, strip_bom};
use crate::term::{Literal, LiteralKind, Quad, Term};
use crate::xml::{
    XML_NS, XmlAttribute, XmlElement, XmlError, XmlHandler, is_nc_name, is_xml_space, line_of,
    parse_xml, syntax,
};

/// `rdf:` names that are syntax: never node elements, property elements or properties.
const SYNTAX_NAMES: &[&str] = &[
    "RDF",
    "ID",
    "about",
    "parseType",
    "resource",
    "nodeID",
    "datatype",
    "aboutEach",
    "aboutEachPrefix",
    "bagID",
];

/// Syntax attributes of property elements.
const PROPERTY_SYNTAX: &[&str] = &["ID", "parseType", "resource", "nodeID", "datatype"];

/// Unqualified attributes RDF/XML still reads as `rdf:` names.
const LEGACY_UNQUALIFIED: &[&str] = &["ID", "about", "resource", "parseType", "type"];

/// In-scope `xml:base` and `xml:lang`.
#[derive(Clone, PartialEq)]
struct Scope {
    base: Option<String>,
    language: String,
}

/// The triple a property element asserts, and the IRI that reifies it (`rdf:ID`).
#[derive(Clone)]
struct Statement {
    subject: Term,
    predicate: Term,
    reifier: Option<Term>,
}

struct PropertyFrame {
    scope: Rc<Scope>,
    statement: Statement,
    resource: Option<String>,
    node_id: Option<String>,
    datatype: Option<String>,
    properties: Vec<(Term, String)>,
    offset: usize,
    text: String,
    object: Option<Term>,
}

enum Frame {
    Document(Rc<Scope>),
    Nodes(Rc<Scope>),
    Node {
        scope: Rc<Scope>,
        subject: Term,
        li: usize,
    },
    Collection {
        scope: Rc<Scope>,
        statement: Statement,
        items: Vec<Term>,
    },
    Property(Box<PropertyFrame>),
    /// Set on the property element itself; nested literal elements only write markup.
    Literal(Option<Statement>),
}

/// What an attribute means: an `rdf:` syntax name or a property.
enum Meaning {
    Syntax(String),
    Property(Term),
}

/// Reads RDF/XML into quads (`readRdfXml`). Whitespace-only input is an empty graph.
pub fn read_rdf_xml(text: &str, base: Option<&str>) -> Result<RdfDocument, KgdiffError> {
    let source = strip_bom(text);
    if is_xml_space(source) {
        return Ok(RdfDocument {
            quads: Vec::new(),
            prefixes: Vec::new(),
        });
    }
    let mut reader = RdfXmlReader::new(base);
    match parse_xml(source, &mut reader) {
        Ok(()) => Ok(RdfDocument {
            quads: reader.quads,
            prefixes: reader.prefixes.into_iter().collect(),
        }),
        Err((XmlError::Other(error), _)) => Err(*error),
        Err((XmlError::Syntax { message, offset }, normalized)) => {
            let line = line_of(&normalized, offset);
            let mut details = Object::new();
            details.insert("format", "rdfxml");
            details.insert("line", line);
            Err(invalid_input_with(
                format!("Invalid RDF/XML: {message} on line {line}."),
                details,
            ))
        }
    }
}

struct RdfXmlReader {
    quads: Vec<Quad>,
    prefixes: IndexMap<String, String>,
    stack: Vec<Frame>,
    /// IRIs minted by `rdf:ID`, which must be unique in a document.
    ids: Lookup<String, ()>,
    iris: Lookup<String, Rc<str>>,
    blanks: usize,
    literal: Option<XmlLiteralWriter>,
    rdf_type: Term,
}

impl RdfXmlReader {
    fn new(base: Option<&str>) -> RdfXmlReader {
        RdfXmlReader {
            quads: Vec::new(),
            prefixes: IndexMap::default(),
            stack: vec![Frame::Document(Rc::new(Scope {
                base: base.map(str::to_owned),
                language: String::new(),
            }))],
            ids: Lookup::new(),
            iris: Lookup::new(),
            blanks: 0,
            literal: None,
            rdf_type: Term::named(format!("{RDF_NS}type")),
        }
    }

    fn scope_of(frame: &Frame) -> Option<&Rc<Scope>> {
        match frame {
            Frame::Document(s) | Frame::Nodes(s) => Some(s),
            Frame::Node { scope, .. } | Frame::Collection { scope, .. } => Some(scope),
            Frame::Property(p) => Some(&p.scope),
            Frame::Literal(_) => None,
        }
    }

    // ─── Grammar ────────────────────────────────────────────────────────────

    fn root(&mut self, element: &XmlElement, scope: Rc<Scope>) -> Result<(), XmlError> {
        if element.uri == RDF_NS && element.local == "RDF" {
            self.stack.push(Frame::Nodes(scope));
            return Ok(());
        }
        // A lone node element is RDF/XML too, but OWL/XML, GraphML and GEXF roots are
        // recognisably something else.
        let kind = classify_xml_root(&XmlRootInfo {
            local: &element.local,
            rdf_attributes: element.attributes.iter().any(|a| a.uri == RDF_NS),
            rdf_namespace: element.namespaces.iter().any(|(_, uri)| uri == RDF_NS),
        });
        if let XmlKind::Unsupported(kind) = kind
            && kind != crate::detect::Unsupported::Xml
        {
            return Err(XmlError::Other(Box::new(unsupported_format(
                kind, None, None,
            ))));
        }
        self.node_element(element, scope).map(|_| ())
    }

    fn node_element(&mut self, element: &XmlElement, scope: Rc<Scope>) -> Result<Term, XmlError> {
        let type_iri = self.element_iri(element, true)?;
        let mut subject = None;
        let mut identifiers = 0;
        let mut properties = Vec::new();
        for attribute in &element.attributes {
            match self.attribute(attribute, element.offset)? {
                None => {}
                Some(Meaning::Property(predicate)) => {
                    properties.push((predicate, attribute.value.clone()));
                }
                Some(Meaning::Syntax(meaning)) => {
                    identifiers += 1;
                    subject = Some(match meaning.as_str() {
                        "about" => self.iri(&resolve_iri(&attribute.value, scope.base.as_deref())),
                        "ID" => self.id_iri(&attribute.value, &scope, element.offset)?,
                        "nodeID" => labelled(&attribute.value, element.offset)?,
                        _ => {
                            return syntax(
                                format!("rdf:{meaning} is not allowed on a node element"),
                                element.offset,
                            );
                        }
                    });
                }
            }
        }
        if identifiers > 1 {
            return syntax(
                "A node element can have only one of rdf:about, rdf:ID and rdf:nodeID",
                element.offset,
            );
        }
        let subject = match subject {
            Some(subject) => subject,
            None => self.blank(),
        };
        if type_iri != format!("{RDF_NS}Description") {
            let object = self.iri(&type_iri);
            let predicate = self.rdf_type.clone();
            self.emit(subject.clone(), predicate, object);
        }
        self.property_attributes(&subject, &properties, &scope);
        self.stack.push(Frame::Node {
            scope,
            subject: subject.clone(),
            li: 0,
        });
        Ok(subject)
    }

    fn property_element(&mut self, element: &XmlElement, scope: Rc<Scope>) -> Result<(), XmlError> {
        let mut iri = self.element_iri(element, false)?;
        if iri == format!("{RDF_NS}li") {
            let Some(Frame::Node { li, .. }) = self.stack.last_mut() else {
                return syntax("rdf:li outside a node element", element.offset);
            };
            *li += 1;
            iri = format!("{RDF_NS}_{li}");
        }
        let parent_subject = match self.stack.last() {
            Some(Frame::Node { subject, .. }) => subject.clone(),
            _ => return syntax("A property element outside a node element", element.offset),
        };
        let mut syntax_attrs: IndexMap<String, String> = IndexMap::default();
        let mut properties = Vec::new();
        for attribute in &element.attributes {
            match self.attribute(attribute, element.offset)? {
                None => {}
                Some(Meaning::Property(predicate)) => {
                    properties.push((predicate, attribute.value.clone()));
                }
                Some(Meaning::Syntax(meaning)) => {
                    if !PROPERTY_SYNTAX.contains(&meaning.as_str()) {
                        return syntax(
                            format!("rdf:{meaning} is not allowed on a property element"),
                            element.offset,
                        );
                    }
                    if syntax_attrs.contains_key(&meaning) {
                        return syntax(format!("rdf:{meaning} is given twice"), element.offset);
                    }
                    syntax_attrs.insert(meaning, attribute.value.clone());
                }
            }
        }
        let reifier = match syntax_attrs.get("ID") {
            Some(id) => Some(self.id_iri(id, &scope, element.offset)?),
            None => None,
        };
        let statement = Statement {
            subject: parent_subject,
            predicate: self.iri(&iri),
            reifier,
        };
        let get = |name: &str| syntax_attrs.get(name).cloned();
        let (parse_type, resource, node_id, datatype) = (
            get("parseType"),
            get("resource"),
            get("nodeID"),
            get("datatype"),
        );
        if let Some(parse_type) = parse_type {
            if resource.is_some()
                || node_id.is_some()
                || datatype.is_some()
                || !properties.is_empty()
            {
                return syntax(
                    "rdf:parseType cannot be combined with rdf:resource, rdf:nodeID, rdf:datatype or property attributes",
                    element.offset,
                );
            }
            match parse_type.as_str() {
                "Resource" => {
                    let object = self.blank();
                    self.assert(&statement, object.clone());
                    self.stack.push(Frame::Node {
                        scope,
                        subject: object,
                        li: 0,
                    });
                }
                "Collection" => self.stack.push(Frame::Collection {
                    scope,
                    statement,
                    items: Vec::new(),
                }),
                // "Literal", and any other value (RDF/XML §7.2.20).
                _ => {
                    self.literal = Some(XmlLiteralWriter::default());
                    self.stack.push(Frame::Literal(Some(statement)));
                }
            }
            return Ok(());
        }
        if [&resource, &node_id, &datatype]
            .iter()
            .filter(|v| v.is_some())
            .count()
            > 1
        {
            return syntax(
                "A property element can have only one of rdf:resource, rdf:nodeID and rdf:datatype",
                element.offset,
            );
        }
        if datatype.is_some() && !properties.is_empty() {
            return syntax(
                "rdf:datatype cannot be combined with property attributes",
                element.offset,
            );
        }
        self.stack.push(Frame::Property(Box::new(PropertyFrame {
            scope,
            statement,
            resource,
            node_id,
            datatype,
            properties,
            offset: element.offset,
            text: String::new(),
            object: None,
        })));
        Ok(())
    }

    /// Literal, empty and resource-valued property elements, decided by what they contained.
    fn end_property(&mut self, frame: PropertyFrame) -> Result<(), XmlError> {
        if frame.object.is_some() {
            return Ok(()); // A node element: asserted when it started.
        }
        let PropertyFrame {
            scope,
            statement,
            resource,
            node_id,
            datatype,
            properties,
            offset,
            text,
            ..
        } = frame;
        let resource_like = resource.is_some() || node_id.is_some() || !properties.is_empty();
        if !text.is_empty() && !resource_like {
            let literal = self.literal_term(&text, &scope, datatype.as_deref());
            self.assert(&statement, literal);
            return Ok(());
        }
        if !is_xml_space(&text) {
            return syntax(
                "A property element with rdf:resource, rdf:nodeID or property attributes cannot contain text",
                offset,
            );
        }
        if !resource_like {
            let literal = self.literal_term("", &scope, datatype.as_deref());
            self.assert(&statement, literal);
            return Ok(());
        }
        let object = if let Some(resource) = &resource {
            self.iri(&resolve_iri(resource, scope.base.as_deref()))
        } else if let Some(node_id) = &node_id {
            labelled(node_id, offset)?
        } else {
            self.blank()
        };
        self.property_attributes(&object, &properties, &scope);
        self.assert(&statement, object);
        Ok(())
    }

    fn property_attributes(
        &mut self,
        subject: &Term,
        properties: &[(Term, String)],
        scope: &Scope,
    ) {
        for (predicate, value) in properties {
            let object = if *predicate == self.rdf_type {
                self.iri(&resolve_iri(value, scope.base.as_deref()))
            } else {
                self.literal_term(value, scope, None)
            };
            self.emit(subject.clone(), predicate.clone(), object);
        }
    }

    /// The IRI an element names, rejecting syntax names in the wrong place.
    fn element_iri(&self, element: &XmlElement, node: bool) -> Result<String, XmlError> {
        let (uri, local) = (&element.uri, &element.local);
        if uri.is_empty() {
            return syntax(
                format!("Element <{local}> is in no namespace"),
                element.offset,
            );
        }
        if uri == RDF_NS
            && (SYNTAX_NAMES.contains(&local.as_str())
                || local == if node { "li" } else { "Description" })
        {
            let role = if node { "node" } else { "property" };
            return syntax(
                format!("rdf:{local} cannot be used as a {role} element"),
                element.offset,
            );
        }
        Ok(format!("{uri}{local}"))
    }

    /// What an attribute means: an `rdf:` syntax name, a property, or nothing (reserved `xml…`
    /// names, which RDF/XML ignores).
    fn attribute(
        &mut self,
        attribute: &XmlAttribute,
        offset: usize,
    ) -> Result<Option<Meaning>, XmlError> {
        let starts_xml = |s: &str| s.len() >= 3 && s.as_bytes()[..3].eq_ignore_ascii_case(b"xml");
        let XmlAttribute {
            prefix, local, uri, ..
        } = attribute;
        if starts_xml(prefix) || (prefix.is_empty() && starts_xml(local)) {
            return Ok(None);
        }
        if uri.is_empty() {
            if !LEGACY_UNQUALIFIED.contains(&local.as_str()) {
                return syntax(format!("Attribute \"{local}\" is in no namespace"), offset);
            }
            return Ok(Some(if local == "type" {
                Meaning::Property(self.rdf_type.clone())
            } else {
                Meaning::Syntax(local.clone())
            }));
        }
        if uri == RDF_NS {
            if SYNTAX_NAMES.contains(&local.as_str()) {
                return Ok(Some(Meaning::Syntax(local.clone())));
            }
            if local == "li" || local == "Description" {
                return syntax(
                    format!("rdf:{local} cannot be used as an attribute"),
                    offset,
                );
            }
        }
        Ok(Some(Meaning::Property(self.iri(&format!("{uri}{local}")))))
    }

    // ─── Terms ──────────────────────────────────────────────────────────────

    /// `rdf:ID` → `base#id`, unique per document.
    fn id_iri(&mut self, id: &str, scope: &Scope, offset: usize) -> Result<Term, XmlError> {
        if !is_nc_name(id) {
            return syntax(format!("rdf:ID \"{id}\" is not an XML name"), offset);
        }
        let iri = resolve_iri(&format!("#{id}"), scope.base.as_deref());
        if self.ids.contains_key(&iri) {
            return syntax(format!("rdf:ID \"{id}\" is used twice"), offset);
        }
        self.ids.insert(iri.clone(), ());
        Ok(self.iri(&iri))
    }

    fn blank(&mut self) -> Term {
        let term = Term::blank(format!("g{}", self.blanks));
        self.blanks += 1;
        term
    }

    fn iri(&mut self, value: &str) -> Term {
        if let Some(shared) = self.iris.get(value) {
            return Term::Named(shared.clone());
        }
        let shared: Rc<str> = value.into();
        self.iris.insert(value.to_owned(), shared.clone());
        Term::Named(shared)
    }

    fn literal_term(&mut self, value: &str, scope: &Scope, datatype: Option<&str>) -> Term {
        if let Some(datatype) = datatype {
            let resolved = resolve_iri(datatype, scope.base.as_deref());
            return Term::Literal(Literal::new(value, LiteralKind::Datatype(&resolved)));
        }
        Term::Literal(if scope.language.is_empty() {
            Literal::string(value)
        } else {
            Literal::new(value, LiteralKind::Language(&scope.language, None))
        })
    }

    fn assert(&mut self, statement: &Statement, object: Term) {
        let Statement {
            subject,
            predicate,
            reifier,
        } = statement;
        self.emit(subject.clone(), predicate.clone(), object.clone());
        let Some(reifier) = reifier else {
            return;
        };
        let statement_type = self.iri(&format!("{RDF_NS}Statement"));
        let (s, p, o) = (
            self.iri(&format!("{RDF_NS}subject")),
            self.iri(&format!("{RDF_NS}predicate")),
            self.iri(&format!("{RDF_NS}object")),
        );
        let rdf_type = self.rdf_type.clone();
        self.emit(reifier.clone(), rdf_type, statement_type);
        self.emit(reifier.clone(), s, subject.clone());
        self.emit(reifier.clone(), p, predicate.clone());
        self.emit(reifier.clone(), o, object);
    }

    fn emit(&mut self, subject: Term, predicate: Term, object: Term) {
        self.quads.push(Quad {
            subject,
            predicate,
            object,
            graph: Term::DefaultGraph,
        });
    }
}

/// `rdf:nodeID` blank nodes; their labels cannot clash with generated ones (`g…`).
fn labelled(label: &str, offset: usize) -> Result<Term, XmlError> {
    if !is_nc_name(label) {
        return syntax(format!("rdf:nodeID \"{label}\" is not an XML name"), offset);
    }
    Ok(Term::blank(format!("n{label}")))
}

/// `xml:base` and `xml:lang` of an element, inheriting the enclosing scope.
fn in_scope(element: &XmlElement, outer: &Rc<Scope>) -> Rc<Scope> {
    let mut base = outer.base.clone();
    let mut language = outer.language.clone();
    for attribute in &element.attributes {
        if attribute.uri != XML_NS {
            continue;
        }
        if attribute.local == "base" {
            base = Some(resolve_iri(&attribute.value, base.as_deref()));
        } else if attribute.local == "lang" {
            language.clone_from(&attribute.value);
        }
    }
    if base == outer.base && language == outer.language {
        Rc::clone(outer)
    } else {
        Rc::new(Scope { base, language })
    }
}

impl XmlHandler for RdfXmlReader {
    fn start_element(&mut self, element: XmlElement) -> Result<(), XmlError> {
        for (prefix, uri) in &element.namespaces {
            if prefix != "xml" && !self.prefixes.contains_key(prefix) {
                self.prefixes.insert(prefix.clone(), uri.clone());
            }
        }
        if let Some(writer) = self.literal.as_mut()
            && matches!(self.stack.last(), Some(Frame::Literal(_)))
        {
            writer.start(&element);
            self.stack.push(Frame::Literal(None));
            return Ok(());
        }
        let Some(parent) = self.stack.last() else {
            return Ok(());
        };
        let Some(parent_scope) = Self::scope_of(parent) else {
            return Ok(());
        };
        let scope = in_scope(&element, parent_scope);
        match parent {
            Frame::Document(_) => self.root(&element, scope),
            Frame::Nodes(_) => self.node_element(&element, scope).map(|_| ()),
            Frame::Collection { .. } => {
                let item = self.node_element(&element, scope)?;
                // The node frame is on top now; the collection is below it.
                let at = self.stack.len() - 2;
                if let Frame::Collection { items, .. } = &mut self.stack[at] {
                    items.push(item);
                }
                Ok(())
            }
            Frame::Node { .. } => self.property_element(&element, scope),
            Frame::Property(frame) => {
                if frame.object.is_some() {
                    return syntax(
                        "A property element can contain only one node element",
                        element.offset,
                    );
                }
                if !is_xml_space(&frame.text) {
                    return syntax(
                        "A property element cannot mix text and a node element",
                        element.offset,
                    );
                }
                if frame.resource.is_some()
                    || frame.node_id.is_some()
                    || frame.datatype.is_some()
                    || !frame.properties.is_empty()
                {
                    return syntax(
                        "A property element with rdf:resource, rdf:nodeID, rdf:datatype or property attributes cannot contain a node element",
                        element.offset,
                    );
                }
                let property_at = self.stack.len() - 1;
                let object = self.node_element(&element, scope)?;
                let statement = match &mut self.stack[property_at] {
                    Frame::Property(frame) => {
                        frame.object = Some(object.clone());
                        frame.statement.clone()
                    }
                    _ => return Ok(()),
                };
                self.assert(&statement, object);
                Ok(())
            }
            Frame::Literal(_) => Ok(()),
        }
    }

    fn end_element(&mut self, _offset: usize) -> Result<(), XmlError> {
        let Some(frame) = self.stack.pop() else {
            return Ok(());
        };
        match frame {
            Frame::Property(frame) => self.end_property(*frame),
            Frame::Collection {
                statement, items, ..
            } => {
                let mut head = self.iri(&format!("{RDF_NS}nil"));
                let (first, rest) = (
                    self.iri(&format!("{RDF_NS}first")),
                    self.iri(&format!("{RDF_NS}rest")),
                );
                for item in items.into_iter().rev() {
                    let cell = self.blank();
                    self.emit(cell.clone(), first.clone(), item);
                    self.emit(cell.clone(), rest.clone(), head);
                    head = cell;
                }
                self.assert(&statement, head);
                Ok(())
            }
            Frame::Literal(Some(statement)) => {
                let value = self.literal.take().map(|w| w.out).unwrap_or_default();
                let datatype = format!("{RDF_NS}XMLLiteral");
                let datatype = self.iri(&datatype);
                let literal = Term::Literal(Literal::new(
                    &value,
                    LiteralKind::Datatype(datatype.value()),
                ));
                self.assert(&statement, literal);
                Ok(())
            }
            Frame::Literal(None) => {
                if let Some(writer) = self.literal.as_mut() {
                    writer.end();
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn text(&mut self, value: &str, offset: usize) -> Result<(), XmlError> {
        match self.stack.last_mut() {
            Some(Frame::Literal(_)) => {
                if let Some(writer) = self.literal.as_mut() {
                    writer.text(value);
                }
                Ok(())
            }
            Some(Frame::Property(frame)) if frame.object.is_none() => {
                frame.text.push_str(value);
                Ok(())
            }
            frame => {
                if is_xml_space(value) {
                    return Ok(());
                }
                let message = if matches!(frame, Some(Frame::Property(_))) {
                    "A property element cannot mix text and a node element".to_owned()
                } else {
                    format!("Unexpected text \"{}\"", slice_utf16(js::trim(value), 40))
                };
                syntax(message, offset)
            }
        }
    }

    fn processing_instruction(&mut self, target: &str, data: &str) -> Result<(), XmlError> {
        if matches!(self.stack.last(), Some(Frame::Literal(_)))
            && let Some(writer) = self.literal.as_mut()
        {
            writer.processing_instruction(target, data);
        }
        Ok(())
    }

    fn comment(&mut self, value: &str) -> Result<(), XmlError> {
        if matches!(self.stack.last(), Some(Frame::Literal(_)))
            && let Some(writer) = self.literal.as_mut()
        {
            writer.comment(value);
        }
        Ok(())
    }
}

// ─── XML literals ────────────────────────────────────────────────────────────

/// The lexical form of an `rdf:parseType="Literal"` value: Exclusive XML Canonicalization (with
/// comments, empty InclusiveNamespaces list) of the element content. Namespaces are declared
/// where they are first visibly used.
#[derive(Default)]
struct XmlLiteralWriter {
    out: String,
    open: Vec<(String, Rc<IndexMap<String, String>>)>,
}

fn qualified(prefix: &str, local: &str) -> String {
    if prefix.is_empty() {
        local.to_owned()
    } else {
        format!("{prefix}:{local}")
    }
}

fn escape_attribute(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("&#x9;"),
            '\n' => out.push_str("&#xA;"),
            '\r' => out.push_str("&#xD;"),
            c => out.push(c),
        }
    }
    out
}

impl XmlLiteralWriter {
    fn start(&mut self, element: &XmlElement) {
        let outer = self
            .open
            .last()
            .map_or_else(|| Rc::new(IndexMap::default()), |(_, r)| Rc::clone(r));
        let mut used: IndexMap<String, String> = IndexMap::default();
        used.insert(element.prefix.clone(), element.uri.clone());
        for attribute in &element.attributes {
            if !attribute.prefix.is_empty() && attribute.prefix != "xml" {
                used.insert(attribute.prefix.clone(), attribute.uri.clone());
            }
        }
        let mut declarations: Vec<(String, String)> = used
            .into_iter()
            .filter(|(prefix, uri)| outer.get(prefix).map_or("", String::as_str) != uri)
            .collect();
        declarations.sort_by(|a, b| compare_strings(&a.0, &b.0));
        let rendered = if declarations.is_empty() {
            outer
        } else {
            let mut next = (*outer).clone();
            for (prefix, uri) in &declarations {
                next.insert(prefix.clone(), uri.clone());
            }
            Rc::new(next)
        };
        let mut attributes: Vec<&XmlAttribute> = element.attributes.iter().collect();
        attributes.sort_by(|a, b| {
            compare_strings(&a.uri, &b.uri).then_with(|| compare_strings(&a.local, &b.local))
        });
        let name = qualified(&element.prefix, &element.local);
        self.out.push('<');
        self.out.push_str(&name);
        for (prefix, uri) in &declarations {
            self.out.push_str(" xmlns");
            if !prefix.is_empty() {
                self.out.push(':');
                self.out.push_str(prefix);
            }
            self.out.push_str("=\"");
            self.out.push_str(&escape_attribute(uri));
            self.out.push('"');
        }
        for attribute in attributes {
            self.out.push(' ');
            self.out
                .push_str(&qualified(&attribute.prefix, &attribute.local));
            self.out.push_str("=\"");
            self.out.push_str(&escape_attribute(&attribute.value));
            self.out.push('"');
        }
        self.out.push('>');
        self.open.push((name, rendered));
    }

    fn end(&mut self) {
        if let Some((name, _)) = self.open.pop() {
            self.out.push_str("</");
            self.out.push_str(&name);
            self.out.push('>');
        }
    }

    fn text(&mut self, value: &str) {
        for c in value.chars() {
            match c {
                '&' => self.out.push_str("&amp;"),
                '<' => self.out.push_str("&lt;"),
                '>' => self.out.push_str("&gt;"),
                '\r' => self.out.push_str("&#xD;"),
                c => self.out.push(c),
            }
        }
    }

    fn comment(&mut self, value: &str) {
        self.out.push_str("<!--");
        self.out.push_str(value);
        self.out.push_str("-->");
    }

    fn processing_instruction(&mut self, target: &str, data: &str) {
        self.out.push_str("<?");
        self.out.push_str(target);
        if !data.is_empty() {
            self.out.push(' ');
            self.out.push_str(data);
        }
        self.out.push_str("?>");
    }
}
