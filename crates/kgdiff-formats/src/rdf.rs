//! RDF → `GraphInput` (`rdf.ts`), following docs/architecture.md, "Formats: mapping
//! conventions". Every RDF syntax produces quads first — the Turtle family through oxttl
//! (`turtle.rs`), RDF/XML through `rdfxml.rs`, JSON-LD through `jsonld.rs` — and [`map_rdf`]
//! maps them all the same way, so one graph diffs identically in any syntax.
//!
//! - Triples are a set: repeated triples count once, whatever the syntax.
//! - Node ids: OBO PURLs become CURIEs, other IRIs stay whole; blank nodes get content-hashed ids
//!   `_:b<hash>` (hash of their sorted outgoing triples, recursive, cycle-safe).
//! - Labels by language preference; the other label values become aliases.
//! - Identities (predicates, attribute keys, types) are compacted with well-known and user
//!   prefixes only, by default.
//! - Literal-valued properties → attributes; IRI-valued properties → edges.
//! - `rdf:type` → types; `owl:deprecated` → deprecated; `IAO:0100001` → replacedBy.
//! - OWL existential restrictions and intersections → edges; `owl:Ontology` → `meta`.
//! - Lists: literal lists → attribute arrays; lists of resources → (unordered) edges.
//! - Statement annotations (`owl:Axiom`, `rdf:Statement`, RDF 1.2 `rdf:reifies`) are folded into
//!   the attributes of the annotated edge (or node).

use std::cmp::Ordering;
use std::rc::Rc;

use kgdiff_core::js::{self, IndexMap, IndexSet, JsStr, Lookup, Object, Value};
use kgdiff_core::text::to_lowercase;

use crate::prefixes::{
    DC_NS, DCTERMS_NS, FOAF_NS, OBO_IN_OWL_NS, OBO_PURL, OWL_NS, PrefixSource, PrefixTable, RDF_NS,
    RDFS_NS, SKOS_NS, node_id_for_iri, readable_name, well_known,
};
use crate::shared::{
    AttrBag, EdgeFields, NodeBuilder, Warnings, compare_strings, hash53, make_edge, make_meta,
    plural, sort_edges, sort_nodes, typed_value,
};
use crate::term::{Literal, Quad, Term, Triple, xsd_local};
use crate::{CompactWith, ParseWarningCode, RdfOptions};

/// The quads of one RDF document and the prefixes it declares (for display only).
pub struct RdfDocument {
    pub quads: Vec<Quad>,
    pub prefixes: Vec<(String, String)>,
}

/// What [`map_rdf`] gives.
pub struct RdfParseOutput {
    pub graph: Object,
    pub prefixes: Object,
    /// Labels the file gives the properties it uses, by compact predicate.
    pub predicate_labels: Vec<(String, String)>,
}

fn iri(ns: &str, local: &str) -> String {
    format!("{ns}{local}")
}

struct Names {
    rdf_type: String,
    rdf_first: String,
    rdf_rest: String,
    rdf_nil: String,
    rdf_list: String,
    rdf_reifies: String,
    rdf_statement: String,
    rdf_subject: String,
    rdf_predicate: String,
    rdf_object: String,
    rdfs_subclass_of: String,
    owl_ontology: String,
    owl_imports: String,
    owl_version_info: String,
    owl_version_iri: String,
    owl_deprecated: String,
    owl_class: String,
    owl_restriction: String,
    owl_on_property: String,
    owl_some_values_from: String,
    owl_equivalent_class: String,
    owl_intersection_of: String,
    owl_union_of: String,
    owl_axiom: String,
    owl_annotated_source: String,
    owl_annotated_property: String,
    owl_annotated_target: String,
    iao_replaced_by: String,
    dc_title: String,
    dcterms_title: String,
}

impl Names {
    fn new() -> Names {
        Names {
            rdf_type: iri(RDF_NS, "type"),
            rdf_first: iri(RDF_NS, "first"),
            rdf_rest: iri(RDF_NS, "rest"),
            rdf_nil: iri(RDF_NS, "nil"),
            rdf_list: iri(RDF_NS, "List"),
            rdf_reifies: iri(RDF_NS, "reifies"),
            rdf_statement: iri(RDF_NS, "Statement"),
            rdf_subject: iri(RDF_NS, "subject"),
            rdf_predicate: iri(RDF_NS, "predicate"),
            rdf_object: iri(RDF_NS, "object"),
            rdfs_subclass_of: iri(RDFS_NS, "subClassOf"),
            owl_ontology: iri(OWL_NS, "Ontology"),
            owl_imports: iri(OWL_NS, "imports"),
            owl_version_info: iri(OWL_NS, "versionInfo"),
            owl_version_iri: iri(OWL_NS, "versionIRI"),
            owl_deprecated: iri(OWL_NS, "deprecated"),
            owl_class: iri(OWL_NS, "Class"),
            owl_restriction: iri(OWL_NS, "Restriction"),
            owl_on_property: iri(OWL_NS, "onProperty"),
            owl_some_values_from: iri(OWL_NS, "someValuesFrom"),
            owl_equivalent_class: iri(OWL_NS, "equivalentClass"),
            owl_intersection_of: iri(OWL_NS, "intersectionOf"),
            owl_union_of: iri(OWL_NS, "unionOf"),
            owl_axiom: iri(OWL_NS, "Axiom"),
            owl_annotated_source: iri(OWL_NS, "annotatedSource"),
            owl_annotated_property: iri(OWL_NS, "annotatedProperty"),
            owl_annotated_target: iri(OWL_NS, "annotatedTarget"),
            iao_replaced_by: iri(OBO_PURL, "IAO_0100001"),
            dc_title: iri(DC_NS, "title"),
            dcterms_title: iri(DCTERMS_NS, "title"),
        }
    }
}

const SCHEMA_HTTPS: &str = "https://schema.org/";
const SCHEMA_HTTP: &str = "http://schema.org/";

fn default_label_predicates() -> Vec<String> {
    vec![
        iri(RDFS_NS, "label"),
        iri(SKOS_NS, "prefLabel"),
        iri(SCHEMA_HTTPS, "name"),
        iri(DCTERMS_NS, "title"),
        iri(FOAF_NS, "name"),
    ]
}

fn default_alias_predicates() -> Vec<String> {
    vec![
        iri(SKOS_NS, "altLabel"),
        iri(OBO_IN_OWL_NS, "hasExactSynonym"),
        iri(OBO_IN_OWL_NS, "hasRelatedSynonym"),
        iri(OBO_IN_OWL_NS, "hasBroadSynonym"),
        iri(OBO_IN_OWL_NS, "hasNarrowSynonym"),
        iri(OBO_IN_OWL_NS, "hasSynonym"),
    ]
}

/// All triples of one subject, grouped by predicate IRI in document order.
struct Subject {
    term: Term,
    props: IndexMap<Rc<str>, Vec<Term>>,
}

/// A statement about a statement: owl:Axiom, rdf:Statement or an RDF 1.2 reifier.
struct Reification {
    subject: Term,
    predicate: Rc<str>,
    object: Term,
    annotations: Vec<(Rc<str>, Vec<Term>)>,
}

struct LabelCandidate<'a> {
    tier: usize,
    rank: usize,
    value: &'a str,
    language: String,
}

struct EdgeBuilder {
    source: String,
    predicate: String,
    target: String,
    label: String,
    attrs: AttrBag,
}

fn key_of(term: &Term) -> String {
    match term {
        Term::Blank(label) => format!("_:{label}"),
        other => other.value().to_owned(),
    }
}

fn is_blank_key(key: &str) -> bool {
    key.starts_with("_:")
}

/// Value lists up to this length are de-duplicated by a linear scan.
const SCAN_LIMIT: usize = 8;

/// Maps the quads of an RDF document (any syntax) to a `GraphInput` (`mapRdf`).
pub fn map_rdf(
    document: RdfDocument,
    options: &RdfOptions,
    warnings: &mut Warnings,
) -> RdfParseOutput {
    let user = options.prefixes.clone().unwrap_or_default();
    let well_known = well_known();
    let display = PrefixTable::new(&[
        (PrefixSource::WellKnown, &well_known),
        (PrefixSource::Declared, &document.prefixes),
        (PrefixSource::User, &user),
    ]);
    // Identities must not depend on how a file happens to abbreviate IRIs.
    let identity = match options.compact_with {
        CompactWith::Declared => None,
        CompactWith::WellKnown => Some(PrefixTable::new(&[
            (PrefixSource::WellKnown, &well_known),
            (PrefixSource::User, &user),
        ])),
    };
    let data = Data::ingest(document.quads);
    let table = identity.as_ref().unwrap_or(&display);
    let mut mapper = Mapper::new(&data, table, &display, options);
    let graph = mapper.build(warnings);
    let predicate_labels = mapper.property_labels();
    RdfParseOutput {
        graph,
        prefixes: display.record_object(),
        predicate_labels,
    }
}

/// What ingestion collects; read-only while the graph is built.
struct Data {
    subjects: IndexMap<String, Subject>,
    /// Distinct (subject, predicate) pairs using each blank node as object.
    referrers: Lookup<String, IndexSet<String>>,
    /// The first (subject, predicate) using each blank node.
    parents: Lookup<String, (String, Rc<str>)>,
    /// RDF 1.2 `rdf:reifies` triple terms by reifier key.
    reifies: Lookup<String, Rc<Triple>>,
    named_graphs: IndexSet<String>,
    skipped_triple_terms: usize,
    names: Names,
}

impl Data {
    fn ingest(quads: Vec<Quad>) -> Data {
        let mut data = Data {
            subjects: IndexMap::default(),
            referrers: Lookup::new(),
            parents: Lookup::new(),
            reifies: Lookup::new(),
            named_graphs: IndexSet::default(),
            skipped_triple_terms: 0,
            names: Names::new(),
        };
        // Term keys of long value lists, for `contains`.
        let mut value_index: Lookup<(String, Rc<str>), Lookup<String, ()>> = Lookup::new();
        for Quad {
            subject,
            predicate,
            object,
            graph,
        } in quads
        {
            if !matches!(graph, Term::DefaultGraph) {
                data.named_graphs.insert(graph.value().to_owned());
            }
            let (Term::Named(_) | Term::Blank(_), Term::Named(predicate)) = (&subject, predicate)
            else {
                data.skipped_triple_terms += 1;
                continue;
            };
            let subject_key = key_of(&subject);
            match object {
                Term::Named(_) | Term::Blank(_) | Term::Literal(_) => {
                    data.add(&mut value_index, subject, subject_key, predicate, object);
                }
                Term::Triple(triple)
                    if &*predicate == data.names.rdf_reifies.as_str() && subject.is_blank() =>
                {
                    data.reifies.insert(subject_key.clone(), triple);
                    data.subject_of(subject, subject_key);
                }
                _ => data.skipped_triple_terms += 1,
            }
        }
        data
    }

    fn subject_of(&mut self, term: Term, key: String) -> &mut Subject {
        self.subjects.entry(key).or_insert_with(|| Subject {
            term,
            props: IndexMap::default(),
        })
    }

    fn add(
        &mut self,
        index: &mut Lookup<(String, Rc<str>), Lookup<String, ()>>,
        term: Term,
        key: String,
        predicate: Rc<str>,
        object: Term,
    ) {
        let props = &mut self.subject_of(term, key.clone()).props;
        match props.get_mut(&predicate) {
            None => {
                props.insert(predicate.clone(), vec![object.clone()]);
            }
            Some(values) => {
                // RDF graphs are sets, and syntaxes differ in how often they repeat a triple.
                if values.len() < SCAN_LIMIT {
                    if values.contains(&object) {
                        return;
                    }
                } else {
                    let keys = index.get_or_insert_with((key.clone(), predicate.clone()), || {
                        let mut keys = Lookup::new();
                        for value in values.iter() {
                            keys.insert(value.key(), ());
                        }
                        keys
                    });
                    if keys.insert(object.key(), ()).is_some() {
                        return;
                    }
                }
                values.push(object.clone());
            }
        }
        if let Term::Blank(label) = &object {
            let object_key = format!("_:{label}");
            if !self.referrers.contains_key(&object_key) {
                self.referrers
                    .insert(object_key.clone(), IndexSet::default());
                self.parents
                    .insert(object_key.clone(), (key.clone(), predicate.clone()));
            }
            if let Some(referrers) = self.referrers.get_mut(&object_key) {
                referrers.insert(format!("{key}\u{0}{predicate}"));
            }
        }
    }

    fn reference_count(&self, key: &str) -> usize {
        self.referrers.get(key).map_or(0, IndexSet::len)
    }

    fn has_type(&self, subject: &Subject, type_iri: &str) -> bool {
        subject
            .props
            .get(self.names.rdf_type.as_str())
            .is_some_and(|values| {
                values
                    .iter()
                    .any(|value| value.value() == type_iri && value.is_named())
            })
    }

    /// Calls `visit` for every blank node a blank node points to (triple terms included).
    fn for_each_blank_child(&self, key: &str, visit: &mut dyn FnMut(String)) {
        fn term(value: &Term, visit: &mut dyn FnMut(String)) {
            match value {
                Term::Blank(label) => visit(format!("_:{label}")),
                Term::Triple(triple) => {
                    term(&triple.subject, visit);
                    term(&triple.object, visit);
                }
                _ => {}
            }
        }
        if let Some(subject) = self.subjects.get(key) {
            for values in subject.props.values() {
                for value in values {
                    term(value, visit);
                }
            }
        }
        if let Some(triple) = self.reifies.get(key) {
            term(&Term::Triple(triple.clone()), visit);
        }
    }
}

struct Mapper<'a> {
    data: &'a Data,
    table: &'a PrefixTable,
    names: &'a Names,
    label_ranks: Lookup<String, usize>,
    alias_predicates: Lookup<String, ()>,
    languages: Vec<String>,
    type_edges: bool,
    owl_restrictions: bool,
    fold_annotations: bool,

    ontologies: IndexSet<String>,
    nodes: IndexMap<String, NodeBuilder>,
    edges: IndexMap<String, EdgeBuilder>,
    /// Compact predicate → IRI of every predicate used for an edge or attribute.
    used_predicates: IndexMap<String, Rc<str>>,

    lists: Lookup<String, Option<Vec<Term>>>,
    existentials: Lookup<String, Option<(String, String)>>,
    blank_hashes: Option<Lookup<String, String>>,
    cyclic_blanks: Lookup<String, ()>,
    blank_ids: Lookup<String, String>,
    emitted_blanks: Lookup<String, ()>,
    blank_queue: Vec<String>,
    blank_cursor: usize,
    /// Counted `rdf-list-resources` warnings, reported when the build ends.
    list_resources: usize,
}

/// `schemaVariants`: schema.org is published under both http and https.
fn schema_variants(iri: &str) -> Vec<String> {
    if let Some(rest) = iri.strip_prefix(SCHEMA_HTTPS) {
        return vec![iri.to_owned(), format!("{SCHEMA_HTTP}{rest}")];
    }
    if let Some(rest) = iri.strip_prefix(SCHEMA_HTTP) {
        return vec![iri.to_owned(), format!("{SCHEMA_HTTPS}{rest}")];
    }
    vec![iri.to_owned()]
}

fn compare_candidates(a: &LabelCandidate<'_>, b: &LabelCandidate<'_>) -> Ordering {
    a.tier
        .cmp(&b.tier)
        .then(a.rank.cmp(&b.rank))
        .then_with(|| compare_strings(a.value, b.value))
        .then_with(|| compare_strings(&a.language, &b.language))
}

/// The attribute value of a literal: typed XSD numbers / booleans, `"text@lang"` for tagged text.
fn literal_value(literal: &Literal) -> Value {
    let language = literal.language();
    if !language.is_empty() {
        return Value::from(format!("{}@{language}", literal.value()));
    }
    typed_value(literal.value(), xsd_local(literal.datatype()))
}

fn is_true(lexical: &str) -> bool {
    let value = js::trim(lexical);
    value == "true" || value == "1"
}

impl<'a> Mapper<'a> {
    fn new(
        data: &'a Data,
        table: &'a PrefixTable,
        display: &PrefixTable,
        options: &RdfOptions,
    ) -> Mapper<'a> {
        let label_predicates = options
            .label_predicates
            .as_ref()
            .map_or_else(default_label_predicates, |list| {
                list.iter().map(|p| display.expand(p)).collect()
            });
        let mut label_ranks = Lookup::new();
        for (rank, iri) in label_predicates.iter().enumerate() {
            for variant in schema_variants(iri) {
                if !label_ranks.contains_key(&variant) {
                    label_ranks.insert(variant, rank);
                }
            }
        }
        let alias_list = options
            .alias_predicates
            .as_ref()
            .map_or_else(default_alias_predicates, |list| {
                list.iter().map(|p| display.expand(p)).collect()
            });
        let mut alias_predicates = Lookup::new();
        for iri in &alias_list {
            for variant in schema_variants(iri) {
                alias_predicates.insert(variant, ());
            }
        }
        let mut languages: Vec<String> = options
            .languages
            .clone()
            .unwrap_or_else(|| vec![String::new(), "en".to_owned()])
            .iter()
            .map(|language| to_lowercase(language).into_owned())
            .collect();
        if !languages.iter().any(String::is_empty) {
            languages.push(String::new());
        }
        Mapper {
            data,
            table,
            names: &data.names,
            label_ranks,
            alias_predicates,
            languages,
            type_edges: options.type_edges,
            owl_restrictions: options.owl_restrictions,
            fold_annotations: options.fold_annotations,
            ontologies: IndexSet::default(),
            nodes: IndexMap::default(),
            edges: IndexMap::default(),
            used_predicates: IndexMap::default(),
            lists: Lookup::new(),
            existentials: Lookup::new(),
            blank_hashes: None,
            cyclic_blanks: Lookup::new(),
            blank_ids: Lookup::new(),
            emitted_blanks: Lookup::new(),
            blank_queue: Vec::new(),
            blank_cursor: 0,
            list_resources: 0,
        }
    }

    // ─── Build ──────────────────────────────────────────────────────────────

    fn build(&mut self, warnings: &mut Warnings) -> Object {
        let data = self.data;
        let mut reifications: Vec<(String, Reification)> = Vec::new();
        let mut roots: Vec<String> = Vec::new();
        for (key, subject) in &data.subjects {
            if data.has_type(subject, &self.names.owl_ontology) {
                self.ontologies.insert(key.clone());
            }
        }
        for (key, subject) in &data.subjects {
            if self.ontologies.contains(key) {
                continue;
            }
            if !is_blank_key(key) {
                self.emit_resource(subject, &node_id_for_iri(key));
                continue;
            }
            if data.reference_count(key) > 0 {
                continue;
            }
            let reification = if self.fold_annotations {
                self.reification(key, subject)
            } else {
                None
            };
            match reification {
                Some(reification) => reifications.push((key.clone(), reification)),
                None => roots.push(key.clone()),
            }
        }
        for key in roots {
            self.request_blank(&key);
        }
        for key in self.orphan_blanks() {
            self.request_blank(&key);
        }
        self.drain_blanks();
        for (key, reification) in &reifications {
            if !self.fold_reification(reification) {
                self.request_blank(key);
            }
        }
        self.drain_blanks();

        if !data.named_graphs.is_empty() {
            warnings.add(
                ParseWarningCode::NamedGraphs,
                format!(
                    "Merged {} into one graph.",
                    plural(data.named_graphs.len(), "named graph")
                ),
                None,
            );
        }
        if data.skipped_triple_terms > 0 {
            warnings.add(
                ParseWarningCode::TripleTerms,
                format!(
                    "Skipped {} with RDF 1.2 triple terms (not representable as edges).",
                    plural(data.skipped_triple_terms, "triple")
                ),
                None,
            );
        }
        if self.list_resources > 0 {
            warnings.count(
                ParseWarningCode::RdfListResources,
                |n| {
                    format!(
                        "{} of resources mapped to unordered edges (item order is not kept).",
                        plural(n, "RDF list")
                    )
                },
                self.list_resources,
            );
        }

        let mut nodes: Vec<Object> = self.nodes.values().map(|node| node.build(None)).collect();
        let mut edges: Vec<Object> = self
            .edges
            .values()
            .map(|edge| {
                make_edge(&EdgeFields {
                    id: None,
                    source: edge.source.clone(),
                    target: edge.target.clone(),
                    predicate: Some(edge.predicate.clone()),
                    label: Some(edge.label.clone()),
                    attrs: edge.attrs.build(None),
                })
            })
            .collect();
        sort_nodes(&mut nodes);
        sort_edges(&mut edges);
        let meta = self.ontology_meta(warnings);
        let mut graph = Object::new();
        graph.insert(
            "nodes",
            Value::Array(nodes.into_iter().map(Value::Object).collect()),
        );
        graph.insert(
            "edges",
            Value::Array(edges.into_iter().map(Value::Object).collect()),
        );
        if let Some(meta) = meta {
            graph.insert("meta", Value::Object(meta));
        }
        graph
    }

    /// Blank nodes that nothing outside their own cycle points to.
    fn orphan_blanks(&self) -> Vec<String> {
        let data = self.data;
        let mut reached: Lookup<String, ()> = Lookup::new();
        let mut queue: Vec<String> = Vec::new();
        let reach = |key: String, reached: &mut Lookup<String, ()>, queue: &mut Vec<String>| {
            if !reached.contains_key(&key) {
                reached.insert(key.clone(), ());
                queue.push(key);
            }
        };
        for key in data.subjects.keys() {
            if !is_blank_key(key) || data.reference_count(key) == 0 {
                reach(key.clone(), &mut reached, &mut queue);
            }
        }
        while let Some(key) = queue.pop() {
            let mut children = Vec::new();
            data.for_each_blank_child(&key, &mut |child| children.push(child));
            for child in children {
                reach(child, &mut reached, &mut queue);
            }
        }
        data.subjects
            .keys()
            .filter(|key| is_blank_key(key) && !reached.contains_key(key.as_str()))
            .cloned()
            .collect()
    }

    fn drain_blanks(&mut self) {
        while self.blank_cursor < self.blank_queue.len() {
            let key = self.blank_queue[self.blank_cursor].clone();
            self.blank_cursor += 1;
            let id = self.blank_id(&key);
            match self.data.subjects.get(&key) {
                Some(subject) => self.emit_resource(subject, &id),
                None => {
                    self.node_builder(&id);
                }
            }
        }
    }

    fn request_blank(&mut self, key: &str) {
        if self.emitted_blanks.contains_key(key) {
            return;
        }
        self.emitted_blanks.insert(key.to_owned(), ());
        self.blank_queue.push(key.to_owned());
    }

    fn node_builder(&mut self, id: &str) -> &mut NodeBuilder {
        self.nodes
            .entry(id.to_owned())
            .or_insert_with(|| NodeBuilder::new(id))
    }

    // ─── Resources ──────────────────────────────────────────────────────────

    fn emit_resource(&mut self, subject: &'a Subject, id: &str) {
        if self.node_builder(id).label.is_none() {
            let label =
                self.best_label(subject)
                    .map(str::to_owned)
                    .or_else(|| match &subject.term {
                        Term::Named(iri) => Some(self.table.compact(iri)),
                        _ => None,
                    });
            self.node_builder(id).label = label;
        }
        let names = self.names;
        for (predicate, values) in &subject.props {
            let predicate: &str = predicate;
            if predicate == names.rdf_type {
                for value in values {
                    if let Term::Named(type_iri) = value {
                        let compact = self.table.compact(type_iri);
                        self.node_builder(id).types.insert(compact);
                        if self.type_edges {
                            self.emit_value(id, predicate, value);
                        }
                    } else {
                        self.emit_value(id, predicate, value);
                    }
                }
            } else if self.label_ranks.contains_key(predicate)
                || self.alias_predicates.contains_key(predicate)
            {
                // Label values that were not chosen become aliases (makeNode drops the label).
                for value in values {
                    if let Term::Literal(literal) = value {
                        self.node_builder(id)
                            .aliases
                            .insert(literal.value().to_owned());
                    }
                }
            } else if predicate == names.owl_deprecated {
                if values
                    .iter()
                    .any(|value| value.is_literal() && is_true(value.value()))
                {
                    self.node_builder(id).deprecated = true;
                }
            } else if predicate == names.iao_replaced_by {
                for value in values {
                    match value {
                        Term::Named(target) => {
                            self.node_builder(id)
                                .replaced_by
                                .insert(node_id_for_iri(target));
                        }
                        Term::Literal(literal) if !js::trim(literal.value()).is_empty() => {
                            let target = node_id_for_iri(js::trim(literal.value()));
                            self.node_builder(id).replaced_by.insert(target);
                        }
                        _ => {}
                    }
                }
            } else {
                for value in values {
                    self.emit_value(id, predicate, value);
                }
            }
        }
    }

    fn emit_value(&mut self, source_id: &str, predicate: &str, value: &Term) {
        match value {
            Term::Literal(literal) => {
                let key = self.attr_key(predicate);
                let value = literal_value(literal);
                self.node_builder(source_id).attrs.add(key, value);
            }
            Term::Named(target) => {
                if **target == *self.names.rdf_nil {
                    let key = self.attr_key(predicate);
                    self.node_builder(source_id)
                        .attrs
                        .add(key, Value::Array(Vec::new()));
                } else if self.ontologies.contains(&**target) {
                    // The ontology is metadata, not a node: references to it stay as values.
                    let key = self.attr_key(predicate);
                    self.node_builder(source_id)
                        .attrs
                        .add(key, Value::from(&**target));
                } else {
                    self.add_edge(source_id, predicate, &node_id_for_iri(target));
                }
            }
            Term::Blank(label) => {
                let key = format!("_:{label}");
                if let Some(items) = self.list_items(&key) {
                    self.emit_list(source_id, predicate, &items);
                    return;
                }
                if predicate == self.names.rdfs_subclass_of
                    && self.owl_restrictions
                    && let Some((property, filler)) = self.existential(&key)
                {
                    self.add_edge(source_id, &property, &node_id_for_iri(&filler));
                    return;
                }
                if predicate == self.names.owl_equivalent_class
                    && let Some(members) = self.class_expression(&key)
                {
                    for (member_predicate, target) in members {
                        self.add_edge(source_id, &member_predicate, &target);
                    }
                    return;
                }
                let target = self.blank_id(&key);
                self.add_edge(source_id, predicate, &target);
                self.request_blank(&key);
            }
            Term::Triple(_) | Term::DefaultGraph => {}
        }
    }

    fn emit_list(&mut self, source_id: &str, predicate: &str, items: &[Term]) {
        if items.iter().all(Term::is_literal) {
            let key = self.attr_key(predicate);
            let values = items
                .iter()
                .filter_map(Term::as_literal)
                .map(literal_value)
                .collect();
            self.node_builder(source_id)
                .attrs
                .add(key, Value::Array(values));
            return;
        }
        self.list_resources += 1;
        for item in items {
            self.emit_value(source_id, predicate, item);
        }
    }

    fn add_edge(&mut self, source: &str, predicate: &str, target: &str) -> &mut EdgeBuilder {
        let compact = self.use_predicate(predicate);
        let key = format!("{source}\u{0}{compact}\u{0}{target}");
        self.edges.entry(key).or_insert_with(|| EdgeBuilder {
            source: source.to_owned(),
            label: readable_name(&compact),
            predicate: compact,
            target: target.to_owned(),
            attrs: AttrBag::new(),
        })
    }

    /// The attribute key of a literal-valued property (its compact form).
    fn attr_key(&mut self, predicate: &str) -> String {
        self.use_predicate(predicate)
    }

    /// The compact form of a predicate, remembered so its declared label can be reported.
    fn use_predicate(&mut self, predicate: &str) -> String {
        let compact = self.table.compact(predicate);
        self.used_predicates
            .insert(compact.clone(), Rc::from(predicate));
        compact
    }

    /// Labels the file declares for the properties used as predicates or keys, by compact
    /// predicate (`propertyLabels`).
    fn property_labels(&self) -> Vec<(String, String)> {
        let mut compacts: Vec<&String> = self.used_predicates.keys().collect();
        compacts.sort_by(|a, b| compare_strings(a, b));
        let mut labels = Vec::new();
        for compact in compacts {
            let iri = &self.used_predicates[compact];
            if let Some(subject) = self.data.subjects.get(&**iri)
                && let Some(label) = self.best_label(subject)
                && !label.is_empty()
            {
                labels.push((compact.clone(), label.to_owned()));
            }
        }
        labels
    }

    // ─── Labels ─────────────────────────────────────────────────────────────

    /// The label by language tier first, then label predicate priority, then lexicographically.
    fn best_label(&self, subject: &'a Subject) -> Option<&'a str> {
        let mut best: Option<LabelCandidate<'a>> = None;
        for (predicate, values) in &subject.props {
            let Some(&rank) = self.label_ranks.get(&**predicate) else {
                continue;
            };
            for value in values {
                let Term::Literal(literal) = value else {
                    continue;
                };
                let language = literal.language();
                let candidate = LabelCandidate {
                    tier: self.language_tier(&language),
                    rank,
                    value: literal.value(),
                    language,
                };
                if best
                    .as_ref()
                    .is_none_or(|best| compare_candidates(&candidate, best) == Ordering::Less)
                {
                    best = Some(candidate);
                }
            }
        }
        best.map(|best| best.value)
    }

    fn language_tier(&self, language: &str) -> usize {
        let tag = to_lowercase(language);
        for (i, preferred) in self.languages.iter().enumerate() {
            if *preferred == *tag {
                return 2 * i;
            }
            if !preferred.is_empty()
                && tag.starts_with(preferred.as_str())
                && tag[preferred.len()..].starts_with('-')
            {
                return 2 * i + 1;
            }
        }
        2 * self.languages.len()
    }

    // ─── Blank node structures ──────────────────────────────────────────────

    /// The items of a well-formed RDF list headed by `head`.
    fn list_items(&mut self, head: &str) -> Option<Vec<Term>> {
        if let Some(cached) = self.lists.get(head) {
            return cached.clone();
        }
        let data = self.data;
        let names = self.names;
        let mut items = Vec::new();
        let mut seen: Lookup<String, ()> = Lookup::new();
        let mut key = head.to_owned();
        let mut result = None;
        while let Some(cell) = data.subjects.get(&key) {
            if seen.contains_key(&key) || (key != head && data.reference_count(&key) != 1) {
                break;
            }
            seen.insert(key.clone(), ());
            let first = cell.props.get(names.rdf_first.as_str());
            let rest = cell.props.get(names.rdf_rest.as_str());
            let types = cell
                .props
                .get(names.rdf_type.as_str())
                .map_or(&[][..], Vec::as_slice);
            let extra = cell.props.len()
                - usize::from(first.is_some())
                - usize::from(rest.is_some())
                - usize::from(!types.is_empty());
            let (Some([item]), Some([next])) = (first.map(Vec::as_slice), rest.map(Vec::as_slice))
            else {
                break;
            };
            if extra > 0 {
                break;
            }
            if !types
                .iter()
                .all(|t| matches!(t, Term::Named(v) if **v == *names.rdf_list))
            {
                break;
            }
            items.push(item.clone());
            match next {
                Term::Named(v) if **v == *names.rdf_nil => {
                    result = Some(items);
                    break;
                }
                Term::Blank(label) => key = format!("_:{label}"),
                _ => break,
            }
        }
        self.lists.insert(head.to_owned(), result.clone());
        result
    }

    /// `[ a owl:Restriction ; owl:onProperty R ; owl:someValuesFrom D ]` with named R and D.
    fn existential(&mut self, key: &str) -> Option<(String, String)> {
        if let Some(cached) = self.existentials.get(key) {
            return cached.clone();
        }
        let names = self.names;
        let mut result = None;
        if let Some(subject) = self.data.subjects.get(key) {
            let (mut property, mut filler) = (None, None);
            let mut simple = true;
            for (predicate, values) in &subject.props {
                let predicate: &str = predicate;
                let named = match values.as_slice() {
                    [Term::Named(v)] => Some(v.to_string()),
                    _ => None,
                };
                if predicate == names.rdf_type {
                    simple = simple && values.iter().all(|v| v.value() == names.owl_restriction);
                } else if predicate == names.owl_on_property && named.is_some() {
                    property = named;
                } else if predicate == names.owl_some_values_from && named.is_some() {
                    filler = named;
                } else {
                    simple = false;
                }
            }
            if simple && let (Some(p), Some(f)) = (property, filler) {
                result = Some((p, f));
            }
        }
        self.existentials.insert(key.to_owned(), result.clone());
        result
    }

    /// The members of `C owl:equivalentClass X` worth an edge (`classExpression`).
    fn class_expression(&mut self, key: &str) -> Option<Vec<(String, String)>> {
        let restriction = if self.owl_restrictions {
            self.existential(key)
        } else {
            None
        };
        if let Some((property, filler)) = restriction {
            return Some(vec![(property, node_id_for_iri(&filler))]);
        }
        let names = self.names;
        let subject = self.data.subjects.get(key)?;
        let mut operator: Option<String> = None;
        let mut head: Option<String> = None;
        for (predicate, values) in &subject.props {
            let predicate: &str = predicate;
            if predicate == names.rdf_type {
                if !values.iter().all(|v| v.value() == names.owl_class) {
                    return None;
                }
            } else if (predicate == names.owl_intersection_of || predicate == names.owl_union_of)
                && operator.is_none()
                && let [Term::Blank(label)] = values.as_slice()
            {
                operator = Some(predicate.to_owned());
                head = Some(format!("_:{label}"));
            } else {
                return None;
            }
        }
        let items = match &head {
            Some(head) => self.list_items(head),
            None => None,
        };
        let (Some(operator), Some(items)) = (operator, items) else {
            return None;
        };
        let mut members = Vec::new();
        for item in &items {
            if let Term::Named(target) = item {
                members.push((operator.clone(), node_id_for_iri(target)));
                continue;
            }
            let nested = match item {
                Term::Blank(label)
                    if operator == names.owl_intersection_of && self.owl_restrictions =>
                {
                    self.existential(&format!("_:{label}"))
                }
                _ => None,
            };
            let (property, filler) = nested?;
            members.push((property, node_id_for_iri(&filler)));
        }
        Some(members)
    }

    // ─── Blank node identity ────────────────────────────────────────────────

    fn content(&mut self, blank: &str) -> String {
        self.ensure_hashes();
        self.blank_hashes
            .as_ref()
            .and_then(|hashes| hashes.get(blank).cloned())
            .unwrap_or_else(|| hash53(""))
    }

    fn ensure_hashes(&mut self) {
        if self.blank_hashes.is_none() {
            let hashes = self.hash_blanks();
            self.blank_hashes = Some(hashes);
        }
    }

    /// The id of a blank node (`blankId`): tree-shaped blank nodes are skolemized by context,
    /// shared, unreferenced and cyclic ones by content alone.
    fn blank_id(&mut self, key: &str) -> String {
        if let Some(known) = self.blank_ids.get(key) {
            return known.clone();
        }
        let mut chain: Vec<String> = Vec::new();
        let mut cursor = key.to_owned();
        while !self.blank_ids.contains_key(&cursor) {
            let Some((parent, _)) = self.tree_parent(&cursor) else {
                let id = format!("_:b{}", self.content(&cursor));
                self.blank_ids.insert(cursor.clone(), id);
                break;
            };
            chain.push(cursor.clone());
            if !is_blank_key(&parent) {
                break;
            }
            cursor = parent;
        }
        for child in chain.iter().rev() {
            let Some((parent, predicate)) = self.tree_parent(child) else {
                continue;
            };
            let parent_id = if is_blank_key(&parent) {
                self.blank_ids.get(&parent).cloned().unwrap_or_default()
            } else {
                node_id_for_iri(&parent)
            };
            let content = self.content(child);
            let hash = hash53(&format!("{parent_id}\n<{predicate}>\n{content}"));
            self.blank_ids.insert(child.clone(), format!("_:b{hash}"));
        }
        match self.blank_ids.get(key) {
            Some(id) => id.clone(),
            None => format!("_:b{}", self.content(key)),
        }
    }

    /// The single (subject, predicate) using a tree-shaped blank node, if it is one.
    fn tree_parent(&mut self, key: &str) -> Option<(String, Rc<str>)> {
        self.ensure_hashes();
        if self.data.reference_count(key) != 1 || self.cyclic_blanks.contains_key(key) {
            return None;
        }
        self.data.parents.get(key).cloned()
    }

    /// Content hashes for all blank nodes, independent of labels and statement order
    /// (`hashBlanks`): strongly connected components children first; cycles by colour
    /// refinement.
    fn hash_blanks(&mut self) -> Lookup<String, String> {
        let data = self.data;
        let mut keys: Vec<String> = Vec::new();
        let mut index_of: Lookup<String, usize> = Lookup::new();
        let add = |key: String, keys: &mut Vec<String>, index_of: &mut Lookup<String, usize>| {
            if let Some(&i) = index_of.get(&key) {
                return i;
            }
            let i = keys.len();
            index_of.insert(key.clone(), i);
            keys.push(key);
            i
        };
        for key in data.subjects.keys() {
            if is_blank_key(key) {
                add(key.clone(), &mut keys, &mut index_of);
            }
        }
        let mut children: Vec<Vec<usize>> = Vec::new();
        let mut i = 0;
        while i < keys.len() {
            let key = keys[i].clone();
            let mut found = Vec::new();
            data.for_each_blank_child(&key, &mut |child| found.push(child));
            let out = found
                .into_iter()
                .map(|child| add(child, &mut keys, &mut index_of))
                .collect();
            children.push(out);
            i += 1;
        }

        let mut hashes: Lookup<String, String> = Lookup::new();
        for component in strongly_connected(&children) {
            let Some(&first) = component.first() else {
                continue;
            };
            let self_loop = children[first].contains(&first);
            if component.len() == 1 && !self_loop {
                let key = &keys[first];
                let lines = canonical_lines(data, key, &mut |child| {
                    hashes.get(child).cloned().unwrap_or_default()
                });
                hashes.insert(key.clone(), hash53(&lines.join("\n")));
            } else {
                let members: Vec<String> = component.iter().map(|&i| keys[i].clone()).collect();
                for member in &members {
                    self.cyclic_blanks.insert(member.clone(), ());
                }
                for (key, color) in refine_cycle(data, &members, &hashes) {
                    hashes.insert(key, color);
                }
            }
        }
        hashes
    }

    // ─── Statement annotations ──────────────────────────────────────────────

    /// An unreferenced blank node that annotates a statement.
    fn reification(&self, key: &str, subject: &Subject) -> Option<Reification> {
        let names = self.names;
        let mut parts: IndexMap<&str, Term> = IndexMap::default();
        let mut annotations: Vec<(Rc<str>, Vec<Term>)> = Vec::new();
        for (predicate, values) in &subject.props {
            let p: &str = predicate;
            if p == names.owl_annotated_source
                || p == names.owl_annotated_property
                || p == names.owl_annotated_target
                || p == names.rdf_subject
                || p == names.rdf_predicate
                || p == names.rdf_object
            {
                let [only] = values.as_slice() else {
                    return None;
                };
                parts.insert(p, only.clone());
            } else if p == names.rdf_type {
                if !values
                    .iter()
                    .all(|v| v.value() == names.owl_axiom || v.value() == names.rdf_statement)
                {
                    return None;
                }
            } else {
                annotations.push((predicate.clone(), values.clone()));
            }
        }
        let triple = self.data.reifies.get(key);
        let (s, p, o) =
            if parts.len() == 3 && parts.contains_key(names.owl_annotated_source.as_str()) {
                (
                    parts.get(names.owl_annotated_source.as_str())?.clone(),
                    parts.get(names.owl_annotated_property.as_str())?.clone(),
                    parts.get(names.owl_annotated_target.as_str())?.clone(),
                )
            } else if parts.len() == 3 && parts.contains_key(names.rdf_subject.as_str()) {
                (
                    parts.get(names.rdf_subject.as_str())?.clone(),
                    parts.get(names.rdf_predicate.as_str())?.clone(),
                    parts.get(names.rdf_object.as_str())?.clone(),
                )
            } else if let (0, Some(triple)) = (parts.len(), triple) {
                (
                    triple.subject.clone(),
                    triple.predicate.clone(),
                    triple.object.clone(),
                )
            } else {
                return None;
            };
        if !matches!(s, Term::Named(_) | Term::Blank(_)) {
            return None;
        }
        let Term::Named(predicate) = p else {
            return None;
        };
        if !matches!(o, Term::Named(_) | Term::Blank(_) | Term::Literal(_)) {
            return None;
        }
        Some(Reification {
            subject: s,
            predicate,
            object: o,
            annotations,
        })
    }

    /// Attaches a statement's annotations to the edge it describes, or — for an asserted
    /// literal-valued statement — to the node as `<property>/<annotation>` (`foldReification`).
    fn fold_reification(&mut self, reification: &Reification) -> bool {
        let Reification {
            subject,
            predicate,
            object,
            annotations,
        } = reification;
        let source_key = key_of(subject);
        let source_id = match subject {
            Term::Named(iri) => node_id_for_iri(iri),
            _ if self.emitted_blanks.contains_key(&source_key) => self.blank_id(&source_key),
            _ => return false,
        };
        let mut values: Vec<(String, Value)> = Vec::new();
        for (annotation, annotation_values) in annotations {
            let key = self.attr_key(annotation);
            for value in annotation_values {
                match value {
                    Term::Blank(_) => return false,
                    Term::Literal(literal) => values.push((key.clone(), literal_value(literal))),
                    other => {
                        values.push((key.clone(), Value::from(node_id_for_iri(other.value()))))
                    }
                }
            }
        }
        if let Some(edge_key) = self.annotated_edge(&source_id, predicate, object) {
            if let Some(edge) = self.edges.get_mut(&edge_key) {
                for (key, value) in values {
                    edge.attrs.add(key, value);
                }
            }
            return true;
        }
        let asserted = self
            .data
            .subjects
            .get(&source_key)
            .and_then(|s| s.props.get(&**predicate))
            .is_some_and(|values| values.contains(object));
        if !object.is_literal() || !asserted || !self.nodes.contains_key(&source_id) {
            return false;
        }
        let property = self.attr_key(predicate);
        let node = self.node_builder(&source_id);
        for (key, value) in values {
            node.attrs.add(format!("{property}/{key}"), value);
        }
        true
    }

    /// The key of the edge an annotated statement describes, if there is one.
    fn annotated_edge(
        &mut self,
        source_id: &str,
        predicate: &str,
        object: &Term,
    ) -> Option<String> {
        let find = |mapper: &Self, p: &str, target: &str| {
            let key = format!("{source_id}\u{0}{}\u{0}{target}", mapper.table.compact(p));
            mapper.edges.contains_key(&key).then_some(key)
        };
        match object {
            Term::Named(target) => find(self, predicate, &node_id_for_iri(target)),
            Term::Blank(label) => {
                let key = format!("_:{label}");
                // OWL API repeats the annotated class expression as a fresh blank node.
                let restriction = if predicate == self.names.rdfs_subclass_of {
                    self.existential(&key)
                } else {
                    None
                };
                if let Some((property, filler)) = restriction {
                    return find(self, &property, &node_id_for_iri(&filler));
                }
                if self.emitted_blanks.contains_key(&key) {
                    let id = self.blank_id(&key);
                    find(self, predicate, &id)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    // ─── Ontology header ────────────────────────────────────────────────────

    fn ontology_meta(&self, warnings: &mut Warnings) -> Option<Object> {
        if self.ontologies.is_empty() {
            return None;
        }
        let names = self.names;
        let mut imported: Lookup<String, ()> = Lookup::new();
        for key in &self.ontologies {
            if let Some(values) = self
                .data
                .subjects
                .get(key)
                .and_then(|s| s.props.get(names.owl_imports.as_str()))
            {
                for value in values {
                    imported.insert(value.value().to_owned(), ());
                }
            }
        }
        let mut candidates: Vec<&String> = self.ontologies.iter().collect();
        candidates.sort_by(|a, b| {
            imported
                .contains_key(a.as_str())
                .cmp(&imported.contains_key(b.as_str()))
                .then(is_blank_key(a).cmp(&is_blank_key(b)))
                .then_with(|| compare_strings(a, b))
        });
        if candidates.len() > 1 {
            warnings.add(
                ParseWarningCode::MultipleOntologies,
                format!(
                    "Found {} owl:Ontology headers; using {} for name and version.",
                    candidates.len(),
                    candidates[0]
                ),
                None,
            );
        }
        let key = candidates[0];
        let subject = self.data.subjects.get(key)?;
        let literal = |predicate: &str| -> Option<String> {
            let mut values: Vec<&str> = subject
                .props
                .get(predicate)
                .map(|values| {
                    values
                        .iter()
                        .filter(|v| v.is_literal())
                        .map(Term::value)
                        .collect()
                })
                .unwrap_or_default();
            values.sort_by(|a, b| compare_strings(a, b));
            values.first().map(|v| (*v).to_owned())
        };
        let iri = |predicate: &str| -> Option<String> {
            subject
                .props
                .get(predicate)?
                .iter()
                .find(|v| v.is_named())
                .map(|v| v.value().to_owned())
        };
        let name = self
            .best_label(subject)
            .map(str::to_owned)
            .or_else(|| literal(&names.dcterms_title))
            .or_else(|| literal(&names.dc_title))
            .or_else(|| (!is_blank_key(key)).then(|| key.clone()));
        let version = literal(&names.owl_version_info).or_else(|| iri(&names.owl_version_iri));
        make_meta(vec![
            (JsStr::from("name"), name.map(Value::from)),
            (JsStr::from("version"), version.map(Value::from)),
        ])
    }
}

/// Sorted, de-duplicated canonical lines of a blank node; `blank` names blank objects.
fn canonical_lines(data: &Data, key: &str, blank: &mut dyn FnMut(&str) -> String) -> Vec<String> {
    fn term(value: &Term, blank: &mut dyn FnMut(&str) -> String) -> String {
        match value {
            Term::Blank(label) => format!("_:{}", blank(&format!("_:{label}"))),
            Term::Named(iri) => format!("<{iri}>"),
            Term::Literal(literal) => {
                let mut out = String::new();
                kgdiff_core::js::json::push_string(&mut out, literal.value());
                let language = literal.language();
                if language.is_empty() {
                    out.push_str("^^<");
                    out.push_str(literal.datatype());
                    out.push('>');
                } else {
                    out.push('@');
                    out.push_str(&language);
                }
                out
            }
            Term::Triple(t) => format!(
                "<<{} {} {}>>",
                term(&t.subject, blank),
                term(&t.predicate, blank),
                term(&t.object, blank)
            ),
            Term::DefaultGraph => "?".to_owned(),
        }
    }
    let mut lines: Vec<String> = Vec::new();
    if let Some(subject) = data.subjects.get(key) {
        for (predicate, values) in &subject.props {
            for value in values {
                lines.push(format!("<{predicate}> {}", term(value, blank)));
            }
        }
    }
    if let Some(reified) = data.reifies.get(key) {
        let reified = term(&Term::Triple(reified.clone()), blank);
        lines.push(format!("<{}> {reified}", data.names.rdf_reifies));
    }
    let unique: IndexSet<String> = lines.into_iter().collect();
    let mut lines: Vec<String> = unique.into_iter().collect();
    lines.sort_by(|a, b| compare_strings(a, b));
    lines
}

/// Colour refinement for the blank nodes of one cycle (`refineCycle`).
fn refine_cycle(
    data: &Data,
    members: &[String],
    hashes: &Lookup<String, String>,
) -> Vec<(String, String)> {
    let mut inside: Lookup<String, ()> = Lookup::new();
    for member in members {
        inside.insert(member.clone(), ());
    }
    let color_of = |key: &str, previous: Option<&IndexMap<String, String>>| {
        let lines = canonical_lines(data, key, &mut |child| {
            if inside.contains_key(child) {
                previous
                    .and_then(|p| p.get(child).cloned())
                    .unwrap_or_else(|| "~".to_owned())
            } else {
                hashes.get(child).cloned().unwrap_or_default()
            }
        });
        let own = previous
            .and_then(|p| p.get(key).cloned())
            .unwrap_or_else(|| "~".to_owned());
        hash53(&format!("{own}\n{}", lines.join("\n")))
    };
    let mut colors: IndexMap<String, String> = members
        .iter()
        .map(|key| (key.clone(), color_of(key, None)))
        .collect();
    for _ in 0..members.len() {
        let previous = colors;
        colors = members
            .iter()
            .map(|key| (key.clone(), color_of(key, Some(&previous))))
            .collect();
        let distinct = |m: &IndexMap<String, String>| m.values().collect::<IndexSet<_>>().len();
        if distinct(&colors) == distinct(&previous) {
            break;
        }
    }
    colors.into_iter().collect()
}

/// Strongly connected components (Tarjan, iterative), in reverse topological order.
fn strongly_connected(adjacency: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let n = adjacency.len();
    let mut index: Vec<Option<usize>> = vec![None; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut components = Vec::new();
    let mut counter = 0;
    for start in 0..n {
        if index[start].is_some() {
            continue;
        }
        let mut work: Vec<(usize, usize)> = Vec::new();
        index[start] = Some(counter);
        low[start] = counter;
        counter += 1;
        stack.push(start);
        on_stack[start] = true;
        work.push((start, 0));
        while let Some(&mut (node, ref mut position)) = work.last_mut() {
            if let Some(&next) = adjacency[node].get(*position) {
                *position += 1;
                match index[next] {
                    None => {
                        index[next] = Some(counter);
                        low[next] = counter;
                        counter += 1;
                        stack.push(next);
                        on_stack[next] = true;
                        work.push((next, 0));
                    }
                    Some(next_index) if on_stack[next] => low[node] = low[node].min(next_index),
                    Some(_) => {}
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[node]);
            }
            if Some(low[node]) == index[node] {
                let mut component = Vec::new();
                while let Some(member) = stack.pop() {
                    on_stack[member] = false;
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                components.push(component);
            }
        }
    }
    components
}
