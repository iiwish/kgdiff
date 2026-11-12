//! The graph file parsers of [kgdiff](https://github.com/iiwish/kgdiff): real-world files read
//! into the graphs [`kgdiff_core`] diffs.
//!
//! [`parse_graph`] reads kgdiff JSON and five other JSON graph dialects (d3 / NetworkX,
//! Cytoscape.js, AntV G6, graphology, vis-network), RDF (Turtle, N-Triples, N-Quads, TriG,
//! RDF/XML, JSON-LD) and OBO, from text, into the same `{ nodes, edges }` conventions, so that
//! diffs across formats behave identically. [`detect_format`] picks the format from the file
//! name and the content. Besides the graph, the result carries the prefixes, the display names
//! of relations and the warnings about input that was repaired or skipped; syntax errors are
//! `invalid-input` errors with the line. `docs/formats.md` in the repository lists the formats
//! and how RDF and OBO are mapped.
//!
//! Output is deterministic: nodes sorted by id, edges by (source, predicate, target), attribute
//! keys sorted, multi-valued fields as sorted arrays. Nothing is ever fetched.
//!
//! ```
//! use kgdiff_formats::{ParseOptions, parse_graph};
//!
//! let turtle = r#"@prefix ex: <http://example.org/> .
//! @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
//! ex:cat rdfs:label "Cat" ; rdfs:subClassOf ex:animal ."#;
//! let mut options = ParseOptions::default();
//! options.filename = Some("zoo.ttl".into());
//! let result = parse_graph(turtle, &options)?;
//! assert_eq!(result.format.id(), "turtle");
//! // kgdiff JSON, as kgdiff_core::normalize reads it: one node, and an edge to `ex:animal`,
//! // which normalize adds as an implicit node.
//! let count = |key: &str| result.graph.get(key).and_then(|v| v.as_array()).map(<[_]>::len);
//! assert_eq!((count("nodes"), count("edges")), (Some(1), Some(1)));
//! # Ok::<(), kgdiff_core::KgdiffError>(())
//! ```

#![warn(missing_docs)]

/// The README's examples, run as tests.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
struct ReadmeDoctests;

mod detect;
mod iri;
mod json;
mod jsonld;
mod obo;
mod prefixes;
mod rdf;
mod rdfxml;
mod shared;
mod term;
mod turtle;
mod xml;

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{JsStr, Object, Value};

pub use detect::FORMAT_EXTENSIONS;
/// Parses a JSON document as kgdiff reads it: any depth, and lone surrogate escapes refused.
/// `kgdiff apply` reads deltas with it.
pub use json::{JsonTextError, parse_deep_json};
pub use prefixes::{PrefixTable, WELL_KNOWN_PREFIXES};

use crate::shared::{Warnings, make_meta};

/// A graph format `parse_graph` reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum FormatId {
    /// kgdiff native JSON and the common JSON graph shapes (auto-detected).
    Json,
    /// JSON-LD 1.1, with inline contexts or contexts from a document loader.
    JsonLd,
    /// Turtle.
    Turtle,
    /// N-Triples.
    NTriples,
    /// N-Quads; named graphs are merged, with a warning.
    NQuads,
    /// TriG; named graphs are merged, with a warning.
    TriG,
    /// RDF/XML, including OWL ontologies saved by Protégé, the OWL API or ROBOT.
    RdfXml,
    /// OBO 1.4: synonyms, `is_a`, relationships, obsoletion with `replaced_by` and `alt_id`.
    Obo,
}

impl FormatId {
    /// Every format, in the order of `FORMAT_EXTENSIONS`.
    pub const ALL: [FormatId; 8] = [
        FormatId::Json,
        FormatId::JsonLd,
        FormatId::Turtle,
        FormatId::NTriples,
        FormatId::NQuads,
        FormatId::TriG,
        FormatId::RdfXml,
        FormatId::Obo,
    ];

    /// The format's id, as `--format` takes it (`json`, `jsonld`, `turtle`, `ntriples`, `nquads`, `trig`, `rdfxml` or `obo`).
    pub fn id(self) -> &'static str {
        match self {
            FormatId::Json => "json",
            FormatId::JsonLd => "jsonld",
            FormatId::Turtle => "turtle",
            FormatId::NTriples => "ntriples",
            FormatId::NQuads => "nquads",
            FormatId::TriG => "trig",
            FormatId::RdfXml => "rdfxml",
            FormatId::Obo => "obo",
        }
    }

    /// The format with id `id`.
    pub fn from_id(id: &str) -> Option<FormatId> {
        FormatId::ALL.into_iter().find(|f| f.id() == id)
    }
}

/// A JSON graph shape the `json` format recognises .
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum JsonDialect {
    /// kgdiff's own JSON (`{ nodes, edges }`).
    Kgdiff,
    /// d3 / NetworkX node-link data.
    D3,
    /// Cytoscape.js elements.
    Cytoscape,
    /// AntV G6 data.
    G6,
    /// graphology's serialized graph.
    Graphology,
    /// vis-network data.
    Vis,
}

impl JsonDialect {
    /// The dialect's name (`kgdiff`, `d3`, `cytoscape`, `g6`, `graphology` or `vis`).
    pub fn id(self) -> &'static str {
        match self {
            JsonDialect::Kgdiff => "kgdiff",
            JsonDialect::D3 => "d3",
            JsonDialect::Cytoscape => "cytoscape",
            JsonDialect::G6 => "g6",
            JsonDialect::Graphology => "graphology",
            JsonDialect::Vis => "vis",
        }
    }
}

/// The stable codes of recoverable parse warnings (`ParseWarningCode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ParseWarningCode {
    /// RDF: quads from named graphs were merged into one graph.
    NamedGraphs,
    /// RDF: triples with RDF 1.2 triple terms outside reification were skipped.
    TripleTerms,
    /// RDF: lists of resources became unordered edges.
    RdfListResources,
    /// RDF: several owl:Ontology headers; one was used for `meta`.
    MultipleOntologies,
    /// JSON (d3): nodes without ids got their array index as id.
    JsonIndexIds,
    /// JSON: element fields that are not part of the graph were dropped.
    JsonIgnoredFields,
    /// JSON: numbers beyond the range of a double were kept as `"Infinity"` / `"-Infinity"`.
    JsonNonFinite,
    /// JSON-LD: keys that expand to no IRI were dropped.
    JsonLdUnmappedTerms,
    /// OBO: a stanza type other than Term / Typedef / Instance was skipped.
    OboUnknownStanza,
    /// OBO: stanzas with the same id were merged.
    OboDuplicateId,
    /// OBO: a term has several names; extra ones became aliases.
    OboMultipleNames,
    /// OBO: a `relationship` without relation or target was skipped.
    OboInvalidRelationship,
    /// OBO: a tag without a value was skipped.
    OboMissingValue,
    /// OBO: a `def` without quotes was kept verbatim.
    OboUnquotedDef,
    /// OBO: an `idspace` header without prefix or IRI was skipped.
    OboInvalidIdspace,
}

impl ParseWarningCode {
    /// The code as written in warnings (`named-graphs`, `obo-duplicate-id`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            ParseWarningCode::NamedGraphs => "named-graphs",
            ParseWarningCode::TripleTerms => "triple-terms",
            ParseWarningCode::RdfListResources => "rdf-list-resources",
            ParseWarningCode::MultipleOntologies => "multiple-ontologies",
            ParseWarningCode::JsonIndexIds => "json-index-ids",
            ParseWarningCode::JsonIgnoredFields => "json-ignored-fields",
            ParseWarningCode::JsonNonFinite => "json-non-finite",
            ParseWarningCode::JsonLdUnmappedTerms => "jsonld-unmapped-terms",
            ParseWarningCode::OboUnknownStanza => "obo-unknown-stanza",
            ParseWarningCode::OboDuplicateId => "obo-duplicate-id",
            ParseWarningCode::OboMultipleNames => "obo-multiple-names",
            ParseWarningCode::OboInvalidRelationship => "obo-invalid-relationship",
            ParseWarningCode::OboMissingValue => "obo-missing-value",
            ParseWarningCode::OboUnquotedDef => "obo-unquoted-def",
            ParseWarningCode::OboInvalidIdspace => "obo-invalid-idspace",
        }
    }
}

/// A recoverable oddity of the input (`ParseWarning`).
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct ParseWarning {
    /// What kind of oddity this is.
    pub code: ParseWarningCode,
    /// A human-readable description.
    pub message: String,
    /// 1-based line, when known.
    pub line: Option<usize>,
}

/// Which prefixes compact identities (`RdfOptions.compactWith`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompactWith {
    /// Only the well-known prefixes, the OBO PURL rule and `RdfOptions::prefixes`.
    #[default]
    WellKnown,
    /// Also the file's own `@prefix` declarations.
    Declared,
}

/// Mapping options for every RDF syntax (`RdfOptions`).
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct RdfOptions {
    /// Predicates used for node labels, in priority order (IRIs or CURIEs with a known prefix).
    pub label_predicates: Option<Vec<String>>,
    /// Predicates used for aliases.
    pub alias_predicates: Option<Vec<String>>,
    /// Keep `rdf:type` as edges too.
    pub type_edges: bool,
    /// Turn `C rdfs:subClassOf [ owl:onProperty R ; owl:someValuesFrom D ]` into an edge.
    pub owl_restrictions: bool,
    /// Language preference for labels, e.g. `["zh", "en"]`.
    pub languages: Option<Vec<String>>,
    /// Extra prefixes used to compact IRIs, as `(name, namespace)` in insertion order.
    pub prefixes: Option<Vec<(String, String)>>,
    /// Which prefixes compact identities. Default [`CompactWith::WellKnown`].
    pub compact_with: CompactWith,
    /// Fold statement annotations into the attributes of the annotated edge.
    pub fold_annotations: bool,
}

impl Default for RdfOptions {
    fn default() -> RdfOptions {
        RdfOptions {
            label_predicates: None,
            alias_predicates: None,
            type_edges: false,
            owl_restrictions: true,
            languages: None,
            prefixes: None,
            compact_with: CompactWith::WellKnown,
            fold_annotations: true,
        }
    }
}

/// Field overrides for custom JSON shapes (`JsonOptions.fields`): keys or dotted paths.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct JsonFields {
    /// Field holding the node id.
    pub id: Option<String>,
    /// Field holding the node label.
    pub label: Option<String>,
    /// Field holding the node type.
    pub r#type: Option<String>,
    /// Field holding the edge source.
    pub source: Option<String>,
    /// Field holding the edge target.
    pub target: Option<String>,
    /// Field holding the edge predicate.
    pub predicate: Option<String>,
}

/// A JSON-LD context document a loader returns: parsed JSON or JSON text.
#[non_exhaustive]
pub enum LoadedDocument {
    /// The parsed JSON document.
    Value(Value),
    /// The document as JSON text.
    Text(String),
}

/// Provides remote JSON-LD contexts, synchronously, once per URL (`documentLoader`).
pub type DocumentLoader = dyn Fn(&str) -> Result<Option<LoadedDocument>, String>;

/// `ParseOptions`.
#[derive(Default)]
#[non_exhaustive]
pub struct ParseOptions<'a> {
    /// `None` is `auto`: detect from `filename` and content.
    pub format: Option<FormatId>,
    /// Used for format detection and as `meta.source`.
    pub filename: Option<String>,
    /// Base IRI for relative IRIs in RDF.
    pub base_iri: Option<String>,
    /// How RDF is mapped to a graph.
    pub rdf: RdfOptions,
    /// Field overrides for custom JSON shapes.
    pub json: JsonFields,
    /// Provides remote JSON-LD contexts; `None` (the default) means nothing is fetched.
    pub document_loader: Option<&'a DocumentLoader>,
}

/// What [`parse_graph`] gives (`ParseResult`).
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct ParseResult {
    /// The graph as kgdiff JSON (`GraphInput`), with its keys in kgdiff's canonical order.
    pub graph: Object,
    /// The format that was read: requested or detected (JSON-LD read as `json` is `jsonld`).
    pub format: FormatId,
    /// The detected JSON dialect (json only).
    pub dialect: Option<JsonDialect>,
    /// Prefix map (declared + well-known), sorted by name.
    pub prefixes: Object,
    /// Display names the source gives its relations, by edge predicate.
    pub predicate_labels: Object,
    /// Recoverable oddities of the input, in the order they were met.
    pub warnings: Vec<ParseWarning>,
}

impl ParseResult {
    /// The result as JSON: `graph`, `format`, `dialect` (when there is one), `prefixes`, `predicateLabels` and `warnings`.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("graph", Value::Object(self.graph.clone()));
        out.insert("format", self.format.id());
        if let Some(dialect) = self.dialect {
            out.insert("dialect", dialect.id());
        }
        out.insert("prefixes", Value::Object(self.prefixes.clone()));
        out.insert(
            "predicateLabels",
            Value::Object(self.predicate_labels.clone()),
        );
        let warnings = self
            .warnings
            .iter()
            .map(|warning| {
                let mut w = Object::new();
                w.insert("code", warning.code.as_str());
                w.insert("message", warning.message.as_str());
                if let Some(line) = warning.line {
                    w.insert("line", line);
                }
                Value::Object(w)
            })
            .collect();
        out.insert("warnings", Value::Array(warnings));
        Value::Object(out)
    }
}

/// What every parser hands back to [`parse_graph`].
struct Parsed {
    graph: Object,
    prefixes: Option<Object>,
    predicate_labels: Vec<(String, String)>,
    dialect: Option<JsonDialect>,
}

/// Parses graph text in any supported format (`parseGraph`). `invalid-input` with line
/// information on syntax errors.
///
/// # Errors
///
/// Returns an `invalid-input` error, with the line when known, when the text is not valid in its format, is in a format that is recognised but not read (such as OWL/XML or GraphML), or when a JSON-LD context cannot be loaded.
pub fn parse_graph(text: &str, options: &ParseOptions<'_>) -> Result<ParseResult, KgdiffError> {
    let filename = options.filename.as_deref();
    let mut format = match options.format {
        Some(format) => format,
        None => detect_format(text, filename)?,
    };
    let mut warnings = Warnings::new();
    let parsed = match format {
        FormatId::Json | FormatId::JsonLd => {
            let data = json::parse_json_text(text)?;
            // JSON-LD is RDF, also when it arrives as plain `.json`.
            if format == FormatId::JsonLd || detect::is_json_ld(&data) {
                format = FormatId::JsonLd;
                let document = jsonld::read_json_ld(
                    &data,
                    options.base_iri.as_deref(),
                    options.document_loader,
                    &mut warnings,
                )?;
                from_rdf(rdf::map_rdf(document, &options.rdf, &mut warnings))
            } else {
                let out = json::parse_json(&data, &options.json, &mut warnings)?;
                Parsed {
                    graph: out.graph,
                    prefixes: None,
                    predicate_labels: out.predicate_labels,
                    dialect: Some(out.dialect),
                }
            }
        }
        FormatId::Obo => {
            let out = obo::parse_obo(text, &mut warnings)?;
            Parsed {
                graph: out.graph,
                prefixes: Some(out.prefixes),
                predicate_labels: out.predicate_labels,
                dialect: None,
            }
        }
        FormatId::Turtle | FormatId::NTriples | FormatId::NQuads | FormatId::TriG => {
            let n3 = match format {
                FormatId::Turtle => turtle::N3Format::Turtle,
                FormatId::NTriples => turtle::N3Format::NTriples,
                FormatId::NQuads => turtle::N3Format::NQuads,
                _ => turtle::N3Format::TriG,
            };
            let document = turtle::read_n3(text, n3, options.base_iri.as_deref())?;
            from_rdf(rdf::map_rdf(document, &options.rdf, &mut warnings))
        }
        FormatId::RdfXml => {
            let document = rdfxml::read_rdf_xml(text, options.base_iri.as_deref())?;
            from_rdf(rdf::map_rdf(document, &options.rdf, &mut warnings))
        }
    };
    let Parsed {
        mut graph,
        prefixes,
        predicate_labels,
        dialect,
    } = parsed;
    let labels: Object = predicate_labels
        .iter()
        .map(|(k, v)| (JsStr::from(k.as_str()), v.as_str()))
        .collect();
    if filename.is_some() || !labels.is_empty() {
        let mut entries: Vec<(JsStr, Option<Value>)> = match graph.get("meta") {
            Some(Value::Object(meta)) => meta
                .iter()
                .map(|(k, v)| (k.clone(), Some(v.clone())))
                .collect(),
            _ => Vec::new(),
        };
        if !labels.is_empty() {
            entries.push((
                JsStr::from("predicateLabels"),
                Some(Value::Object(labels.clone())),
            ));
        }
        if let Some(filename) = filename {
            entries.push((JsStr::from("source"), Some(Value::from(filename))));
        }
        if let Some(meta) = make_meta(entries) {
            graph = with_meta(graph, meta);
        }
    }
    Ok(ParseResult {
        graph,
        format,
        dialect,
        prefixes: prefixes.unwrap_or_else(|| PrefixTable::for_user(None).record_object()),
        predicate_labels: labels,
        warnings: warnings.finish(),
    })
}

/// `{ ...graph, meta }`: `meta` replaced in place, or added last.
fn with_meta(mut graph: Object, meta: Object) -> Object {
    graph.insert("meta", Value::Object(meta));
    graph
}

fn from_rdf(out: rdf::RdfParseOutput) -> Parsed {
    Parsed {
        graph: out.graph,
        prefixes: Some(out.prefixes),
        predicate_labels: out.predicate_labels,
        dialect: None,
    }
}

/// Best-effort format detection from the file name and content sniffing (`detectFormat`).
///
/// # Errors
///
/// Returns an `invalid-input` error when the content is a format kgdiff recognises but does not read, or cannot be told apart from any supported format.
pub fn detect_format(text: &str, filename: Option<&str>) -> Result<FormatId, KgdiffError> {
    detect::detect(text, filename)
}

/// Compacts an IRI with the well-known prefixes overlaid with `prefixes` (`compactIri`):
/// `http://purl.obolibrary.org/obo/GO_0008150` → `GO:0008150`. For display only.
pub fn compact_iri(iri: &str, prefixes: Option<&[(String, String)]>) -> String {
    PrefixTable::for_user(prefixes).compact(iri)
}
