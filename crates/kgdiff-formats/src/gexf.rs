//! GEXF 1.1 to 1.3, as Gephi and NetworkX write it.
//!
//! Like GraphML (`graphml.rs`), the document is read into node-link data and mapped by the
//! JSON reader, so a field means the same as in every JSON graph (`docs/formats.md`).
//!
//! - `<node id label>` is the node id and its `label` field. A label that only repeats the id
//!   is none: NetworkX writes the id there when a node has no label, and the node's `name` or
//!   `title` is then its label, as in node-link JSON.
//! - `<edge source target>` is an edge, with `id`, `label` and `weight` (a number) as its
//!   fields. Its `kind`, GEXF 1.3's name for the type of a relationship, is its `relation`
//!   field. Its `type` says whether it is directed (`directed`, `undirected`, `mutual`); any
//!   other value is a `type` field, which is where NetworkX writes an edge attribute of that
//!   name.
//! - A directed edge keeps its ends as written; an undirected one (the graph's
//!   `defaultedgetype`, or the edge's `type`) has them in code unit order, as in GraphML.
//! - `<attvalue for value>` is a field, named by its attribute's `title` and typed by its
//!   `type`: `integer`, `long`, `float` and `double` are numbers, `boolean` a boolean,
//!   everything else text. An attribute's `<default>` is the value of every node or edge of its
//!   class that has no `<attvalue>` for it, within GraphML's limit on what defaults may add.
//! - With a warning each: `viz:` elements (position, colour, size, shape) are dropped; a
//!   dynamic graph is read as one static graph, with the value an attribute has last in the
//!   file when it changes over time; nodes inside other nodes, or with a `pid` or `<parents>`,
//!   are plain nodes.

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{IndexMap, IndexSet, Object, Value};

use crate::ParseWarningCode;
use crate::graphml::{DefaultBudget, Type, typed, undirected_ends};
use crate::shared::{Warnings, invalid_input_with, plural, strip_bom};
use crate::xml::{XmlElement, XmlError, XmlHandler, is_xml_space, line_of, parse_xml, syntax};

fn type_of(name: Option<&str>) -> Type {
    match name {
        Some("integer" | "long" | "short" | "byte") => Type::Integer,
        Some("float" | "double") => Type::Decimal,
        Some("boolean") => Type::Boolean,
        _ => Type::Text,
    }
}

/// What an `<attributes>` element declares attributes for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Node,
    Edge,
    Other,
}

struct Attribute {
    /// `title`; an attribute without one is named by its id.
    name: String,
    r#type: Type,
    default: Option<String>,
}

struct Data {
    attribute: String,
    value: String,
}

struct Node {
    id: String,
    label: Option<String>,
    data: Vec<Data>,
}

struct Edge {
    id: Option<String>,
    source: String,
    target: String,
    label: Option<String>,
    kind: Option<String>,
    /// `type` when it is not about direction: an edge attribute of that name.
    r#type: Option<String>,
    undirected: bool,
    weight: Option<String>,
    data: Vec<Data>,
}

#[derive(Clone, Copy)]
enum Owner {
    Node(usize),
    Edge(usize),
}

enum Frame {
    Root,
    Graph,
    Attributes(Class),
    Attribute {
        class: Class,
        id: String,
    },
    Default {
        class: Class,
        id: String,
        text: String,
    },
    /// `nested`: inside a node.
    Nodes {
        nested: bool,
    },
    /// `undirected`: the default of the graph the edges are in.
    Edges {
        undirected: bool,
    },
    Element(Owner),
    AttValues(Owner),
    Skipped,
}

#[derive(Default)]
struct Reader {
    stack: Vec<Frame>,
    node_attributes: IndexMap<String, Attribute>,
    edge_attributes: IndexMap<String, Attribute>,
    name: Option<String>,
    /// The `defaultedgetype` of the graph being read.
    undirected: bool,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    /// `viz:` elements of nodes and edges.
    viz: usize,
    /// Elements that say when something exists: time attributes, `<spells>`, dynamic modes.
    dynamic: usize,
    /// Nodes that have a parent.
    nested: usize,
}

fn attribute<'a>(element: &'a XmlElement, name: &str) -> Option<&'a str> {
    element
        .attributes
        .iter()
        .find(|a| a.uri.is_empty() && a.local == name)
        .map(|a| a.value.as_str())
}

fn required<'a>(element: &'a XmlElement, name: &str) -> Result<&'a str, XmlError> {
    match attribute(element, name) {
        Some(value) => Ok(value),
        None => syntax(
            format!("<{}> has no `{name}` attribute", element.local),
            element.offset,
        ),
    }
}

/// The visualization module: `viz:size` and its like.
fn is_viz(element: &XmlElement) -> bool {
    element.uri.ends_with("/viz") || element.prefix == "viz"
}

/// Whether the element says when it exists (`start`, `end` and their open variants).
fn is_timed(element: &XmlElement) -> bool {
    ["start", "end", "startopen", "endopen", "timestamp"]
        .iter()
        .any(|name| attribute(element, name).is_some())
}

impl Reader {
    fn attributes(&mut self, class: Class) -> &mut IndexMap<String, Attribute> {
        if class == Class::Edge {
            &mut self.edge_attributes
        } else {
            &mut self.node_attributes
        }
    }

    fn child(&mut self, element: &XmlElement) -> Result<Frame, XmlError> {
        let name = element.local.as_str();
        let Some(parent) = self.stack.last() else {
            return if name == "gexf" && !is_viz(element) {
                Ok(Frame::Root)
            } else {
                syntax(
                    format!("the root element is <{name}>, not <gexf>"),
                    element.offset,
                )
            };
        };
        if is_viz(element) {
            if matches!(parent, Frame::Element(_)) {
                self.viz += 1;
            }
            return Ok(Frame::Skipped);
        }
        if attribute(element, "mode") == Some("dynamic") || is_timed(element) {
            self.dynamic += 1;
        }
        match (parent, name) {
            (Frame::Root, "graph") => {
                if self.name.is_none() {
                    self.name = attribute(element, "name")
                        .filter(|n| !n.is_empty())
                        .map(str::to_owned);
                }
                self.undirected = attribute(element, "defaultedgetype") == Some("undirected");
                Ok(Frame::Graph)
            }
            (Frame::Graph, "attributes") => {
                Ok(Frame::Attributes(match attribute(element, "class") {
                    Some("node") => Class::Node,
                    Some("edge") => Class::Edge,
                    _ => Class::Other,
                }))
            }
            (Frame::Attributes(class), "attribute") => {
                let (class, id) = (*class, required(element, "id")?.to_owned());
                if class != Class::Other {
                    let declared = Attribute {
                        name: attribute(element, "title").unwrap_or(&id).to_owned(),
                        r#type: type_of(attribute(element, "type")),
                        default: None,
                    };
                    self.attributes(class).insert(id.clone(), declared);
                }
                Ok(Frame::Attribute { class, id })
            }
            (Frame::Attribute { class, id }, "default") => Ok(Frame::Default {
                class: *class,
                id: id.clone(),
                text: String::new(),
            }),
            (Frame::Graph, "nodes") => Ok(Frame::Nodes { nested: false }),
            (Frame::Element(Owner::Node(_)), "nodes") => Ok(Frame::Nodes { nested: true }),
            (Frame::Graph | Frame::Element(Owner::Node(_)), "edges") => Ok(Frame::Edges {
                undirected: self.undirected,
            }),
            (Frame::Nodes { nested }, "node") => {
                if *nested || attribute(element, "pid").is_some() {
                    self.nested += 1;
                }
                self.nodes.push(Node {
                    id: required(element, "id")?.to_owned(),
                    label: attribute(element, "label").map(str::to_owned),
                    data: Vec::new(),
                });
                Ok(Frame::Element(Owner::Node(self.nodes.len() - 1)))
            }
            (Frame::Edges { undirected }, "edge") => {
                let own = |name: &str| attribute(element, name).map(str::to_owned);
                // `type` is the edge's direction, and wins over the graph's default. NetworkX
                // also writes an edge attribute named `type` there: any other value is that.
                let (undirected, r#type) = match attribute(element, "type") {
                    Some("undirected") => (true, None),
                    Some("directed" | "mutual") => (false, None),
                    Some(other) => (*undirected, Some(other.to_owned())),
                    None => (*undirected, None),
                };
                self.edges.push(Edge {
                    id: own("id"),
                    source: required(element, "source")?.to_owned(),
                    target: required(element, "target")?.to_owned(),
                    label: own("label"),
                    kind: own("kind"),
                    r#type,
                    undirected,
                    weight: own("weight"),
                    data: Vec::new(),
                });
                Ok(Frame::Element(Owner::Edge(self.edges.len() - 1)))
            }
            (Frame::Element(owner), "attvalues") => Ok(Frame::AttValues(*owner)),
            (Frame::AttValues(owner), "attvalue") => {
                // GEXF 1.0 wrote `id` where later versions write `for`.
                let key = match attribute(element, "for").or_else(|| attribute(element, "id")) {
                    Some(key) => key,
                    None => return syntax("<attvalue> has no `for` attribute", element.offset),
                };
                let data = Data {
                    attribute: key.to_owned(),
                    value: required(element, "value")?.to_owned(),
                };
                match *owner {
                    Owner::Node(index) => self.nodes[index].data.push(data),
                    Owner::Edge(index) => self.edges[index].data.push(data),
                }
                Ok(Frame::Skipped)
            }
            (Frame::Element(_), "spells") => {
                self.dynamic += 1;
                Ok(Frame::Skipped)
            }
            (Frame::Element(Owner::Node(_)), "parents") => {
                self.nested += 1;
                Ok(Frame::Skipped)
            }
            // <meta>, <options>, elements of other vocabularies.
            _ => Ok(Frame::Skipped),
        }
    }
}

impl XmlHandler for Reader {
    fn start_element(&mut self, element: XmlElement) -> Result<(), XmlError> {
        let frame = self.child(&element)?;
        self.stack.push(frame);
        Ok(())
    }

    fn end_element(&mut self, _offset: usize) -> Result<(), XmlError> {
        if let Some(Frame::Default { class, id, text }) = self.stack.pop()
            && let Some(declared) = self.attributes(class).get_mut(&id)
            && class != Class::Other
        {
            declared.default = Some(text);
        }
        Ok(())
    }

    fn text(&mut self, value: &str, _offset: usize) -> Result<(), XmlError> {
        if let Some(Frame::Default { text, .. }) = self.stack.last_mut() {
            text.push_str(value);
        }
        Ok(())
    }

    fn processing_instruction(&mut self, _target: &str, _data: &str) -> Result<(), XmlError> {
        Ok(())
    }

    fn comment(&mut self, _value: &str) -> Result<(), XmlError> {
        Ok(())
    }
}

/// The fields of a node or an edge: its `<attvalue>`s, the defaults of the attributes it has
/// none for, then `own`, the fields of the element's own XML attributes, which win.
fn fields(
    data: &[Data],
    declared: &IndexMap<String, Attribute>,
    own: Object,
    mistyped: &mut usize,
    budget: &mut DefaultBudget,
) -> Result<Object, KgdiffError> {
    let mut out = Object::new();
    let mut add = |out: &mut Object, name: &str, text: &str, r#type: Type| {
        let (value, fits) = typed(text, r#type);
        if !fits {
            *mistyped += 1;
        }
        out.insert(name, value);
    };
    let mut given: IndexSet<&str> = IndexSet::default();
    for item in data {
        given.insert(&item.attribute);
        match declared.get(&item.attribute) {
            Some(a) => add(&mut out, &a.name, &item.value, a.r#type),
            None => add(&mut out, &item.attribute, &item.value, Type::Text),
        }
    }
    for (id, a) in declared {
        if let Some(default) = &a.default
            && !given.contains(id.as_str())
        {
            budget.take()?;
            add(&mut out, &a.name, default, a.r#type);
        }
    }
    for (name, value) in own.iter() {
        out.insert(name.clone(), value.clone());
    }
    Ok(out)
}

/// Reads a GEXF document into node-link data: `{ graph, nodes, links }`.
pub fn read_gexf(text: &str, warnings: &mut Warnings) -> Result<Value, KgdiffError> {
    let source = strip_bom(text);
    let mut reader = Reader::default();
    if !is_xml_space(source) {
        match parse_xml(source, &mut reader) {
            Ok(()) => {}
            Err((XmlError::Other(error), _)) => return Err(*error),
            Err((XmlError::Syntax { message, offset }, normalized)) => {
                let line = line_of(&normalized, offset);
                let mut details = Object::new();
                details.insert("format", "gexf");
                details.insert("line", line);
                return Err(invalid_input_with(
                    format!("Invalid GEXF: {message} on line {line}."),
                    details,
                ));
            }
        }
    }
    let mut mistyped = 0;
    let mut budget = DefaultBudget::new(source, "gexf");
    let mut nodes: Vec<Value> = Vec::with_capacity(reader.nodes.len());
    for node in &reader.nodes {
        let mut own = Object::new();
        // A label that repeats the id says nothing: the node's `name` or `title` may be its label.
        if let Some(label) = node.label.as_deref().filter(|label| *label != node.id) {
            own.insert("label", label);
        }
        own.insert("id", node.id.as_str());
        nodes.push(Value::Object(fields(
            &node.data,
            &reader.node_attributes,
            own,
            &mut mistyped,
            &mut budget,
        )?));
    }
    let mut links: Vec<Value> = Vec::with_capacity(reader.edges.len());
    for edge in &reader.edges {
        let mut own = Object::new();
        if let Some(label) = &edge.label {
            own.insert("label", label.as_str());
        }
        if let Some(r#type) = &edge.r#type {
            own.insert("type", r#type.as_str());
        }
        if let Some(kind) = &edge.kind {
            own.insert("relation", kind.as_str());
        }
        if let Some(weight) = &edge.weight {
            let (value, fits) = typed(weight, Type::Decimal);
            if !fits {
                mistyped += 1;
            }
            own.insert("weight", value);
        }
        if let Some(id) = &edge.id {
            own.insert("id", id.as_str());
        }
        let (source, target) = if edge.undirected {
            undirected_ends(&edge.source, &edge.target)
        } else {
            (edge.source.as_str(), edge.target.as_str())
        };
        own.insert("source", source);
        own.insert("target", target);
        links.push(Value::Object(fields(
            &edge.data,
            &reader.edge_attributes,
            own,
            &mut mistyped,
            &mut budget,
        )?));
    }

    if reader.viz > 0 {
        warnings.count(
            ParseWarningCode::GexfIgnoredViz,
            |n| {
                format!(
                    "{} dropped (position, colour, size, shape).",
                    plural(n, "viz element")
                )
            },
            reader.viz,
        );
    }
    if reader.dynamic > 0 {
        warnings.count(
            ParseWarningCode::GexfDynamic,
            |n| {
                format!(
                    "A dynamic graph, read as one static graph: {} ignored.",
                    plural(n, "time mark")
                )
            },
            reader.dynamic,
        );
    }
    if reader.nested > 0 {
        warnings.count(
            ParseWarningCode::GexfHierarchy,
            |n| {
                format!(
                    "{} read as plain nodes: the hierarchy is not kept.",
                    plural(n, "nested node")
                )
            },
            reader.nested,
        );
    }
    if mistyped > 0 {
        warnings.count(
            ParseWarningCode::GexfInvalidValue,
            |n| {
                format!(
                    "{} not of the type its attribute declares: kept as text.",
                    plural(n, "value")
                )
            },
            mistyped,
        );
    }

    let mut graph = Object::new();
    if let Some(name) = &reader.name {
        graph.insert("name", name.as_str());
    }
    let mut root = Object::new();
    root.insert("graph", Value::Object(graph));
    root.insert("nodes", Value::Array(nodes));
    root.insert("links", Value::Array(links));
    Ok(Value::Object(root))
}
