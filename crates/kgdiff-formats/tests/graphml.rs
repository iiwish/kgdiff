//! GraphML: one graph saved as GraphML and as node-link JSON is the same graph, and what a
//! graph editor adds is merged, skipped or dropped with a warning.
//!
//! `fixtures/networkx-*.graphml` and `.json` are one graph each, in the form NetworkX's
//! `write_graphml` and `node_link_data` write it; `fixtures/networkx.py` writes them.

use kgdiff_core::js::{Value, json};
use kgdiff_core::{NormalizeOptions, hash_graph, normalize};
use kgdiff_formats::{
    FormatId, JsonFields, ParseOptions, ParseResult, ParseWarningCode, detect_format, parse_graph,
};

const UNDIRECTED: &str = include_str!("fixtures/networkx-undirected.graphml");
const UNDIRECTED_JSON: &str = include_str!("fixtures/networkx-undirected.json");
const DIRECTED: &str = include_str!("fixtures/networkx-directed.graphml");
const DIRECTED_JSON: &str = include_str!("fixtures/networkx-directed.json");
const EDITOR: &str = include_str!("fixtures/editor.graphml");

fn parse(text: &str, format: FormatId) -> ParseResult {
    let mut options = ParseOptions::default();
    options.format = Some(format);
    parse_graph(text, &options).unwrap()
}

fn graphml(text: &str) -> ParseResult {
    parse(text, FormatId::GraphMl)
}

fn hash(result: &ParseResult) -> String {
    let graph = normalize(
        &Value::Object(result.graph.clone()),
        NormalizeOptions::default(),
    )
    .unwrap();
    hash_graph(&graph).to_owned()
}

fn error(text: &str) -> String {
    let mut options = ParseOptions::default();
    options.format = Some(FormatId::GraphMl);
    parse_graph(text, &options).unwrap_err().to_string()
}

/// The node or edge of `result` that `found` picks, as JSON text.
fn element(result: &ParseResult, list: &str, found: impl Fn(&Value) -> bool) -> String {
    let items = result.graph.get(list).and_then(Value::as_array).unwrap();
    let hits: Vec<&Value> = items.iter().filter(|v| found(v)).collect();
    assert_eq!(hits.len(), 1, "{list}");
    json::to_string(hits[0])
}

fn has(value: &Value, key: &str, text: &str) -> bool {
    value
        .as_object()
        .and_then(|o| o.get(key))
        .and_then(Value::as_str)
        == Some(text)
}

fn codes(result: &ParseResult) -> Vec<&'static str> {
    result.warnings.iter().map(|w| w.code.as_str()).collect()
}

#[test]
fn the_same_graph_as_graphml_and_as_node_link_json() {
    for (xml, node_link) in [(UNDIRECTED, UNDIRECTED_JSON), (DIRECTED, DIRECTED_JSON)] {
        let from_xml = graphml(xml);
        let from_json = parse(node_link, FormatId::Json);
        assert_eq!(from_xml.graph, from_json.graph);
        assert_eq!(hash(&from_xml), hash(&from_json));
        assert!(from_xml.warnings.is_empty(), "{:?}", from_xml.warnings);
        assert_eq!(from_xml.format, FormatId::GraphMl);
        // The dialect is the JSON reader's; a GraphML result has none.
        assert_eq!(from_xml.dialect, None);
    }
}

#[test]
fn fields_are_typed_by_their_keys_and_mapped_as_in_json() {
    let result = graphml(UNDIRECTED);
    // A label that only repeats the id is left out, as everywhere.
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "曹操")),
        r#"{"id":"曹操","type":"人物","attrs":{"born":155,"famous":true,"weight":0.75}}"#
    );
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "赤壁")),
        r#"{"id":"赤壁","label":"赤壁之战","type":"事件","attrs":{"description":"孙刘联军 & 曹军 <长江>","year":208}}"#
    );
    assert_eq!(
        element(&result, "edges", |e| has(e, "predicate", "结盟")),
        r#"{"source":"刘备","target":"孙权","predicate":"结盟","attrs":{"since":208}}"#
    );
    let meta = result.graph.get("meta").map(json::to_string);
    assert_eq!(meta.as_deref(), Some(r#"{"name":"chibi","version":"1"}"#));
}

#[test]
fn what_an_editor_adds_is_merged_skipped_or_dropped_with_a_warning() {
    let result = graphml(EDITOR);
    assert_eq!(
        codes(&result),
        [
            "graphml-ignored-data",
            "graphml-invalid-value",
            "graphml-merged-graphs",
            "graphml-unsupported-elements"
        ]
    );
    let messages: Vec<&str> = result.warnings.iter().map(|w| w.message.as_str()).collect();
    assert_eq!(
        messages,
        [
            "1 <data> element with XML content dropped (the drawing data of yEd and other editors).",
            "1 value not of the type its <key> declares: kept as text.",
            "1 <graph> element (nested, or after the first) merged into one graph.",
            "2 <hyperedge> or <port> elements skipped.",
        ]
    );
    // Defaults fill what an element has no <data> for; a key `for="all"` reaches nodes and edges.
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "animal")),
        r#"{"id":"animal","label":"Animal","attrs":{"kind":"concept","rank":1,"reviewed":false}}"#
    );
    // The nested graph's nodes are nodes of the one graph; CDATA is text; `TRUE` is a boolean;
    // `first` is not an int and stays text.
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "cat")),
        r#"{"id":"cat","label":"Cat & kitten","attrs":{"kind":"concept","rank":"first","reviewed":true}}"#
    );
    // A <data> whose key is not declared is a text field named by the key.
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "dog")),
        r#"{"id":"dog","label":"Dog","attrs":{"kind":"concept","note":"undeclared key","reviewed":false}}"#
    );
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "e1")),
        r#"{"id":"e1","source":"cat","target":"mammals","predicate":"related to","attrs":{"reviewed":false}}"#
    );
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "e2")),
        r#"{"id":"e2","source":"cat","target":"dog","predicate":"chases","attrs":{"reviewed":false,"weight":0.5}}"#
    );
    let count = |list: &str| {
        result
            .graph
            .get(list)
            .and_then(Value::as_array)
            .map(<[Value]>::len)
    };
    assert_eq!((count("nodes"), count("edges")), (Some(4), Some(3)));
}

#[test]
fn the_json_field_overrides_apply() {
    let mut options = ParseOptions::default();
    options.format = Some(FormatId::GraphMl);
    options.json = JsonFields::default();
    options.json.label = Some("entity_id".to_owned());
    options.json.r#type = Some("entity_type".to_owned());
    options.json.predicate = Some("keywords".to_owned());
    let result = parse_graph(DIRECTED, &options).unwrap();
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "1")),
        r#"{"id":"1","label":"Ada","type":"person","attrs":{"description":"Wrote the first program","source_id":"chunk-1"}}"#
    );
    assert!(element(&result, "edges", |_| true).contains(r#""predicate":"program,design""#));
}

#[test]
fn is_detected_from_the_extension_and_from_the_content() {
    assert_eq!(
        detect_format("", Some("graph_chunk_entity_relation.graphml")).unwrap(),
        FormatId::GraphMl
    );
    assert_eq!(
        detect_format("", Some("https://example.org/G.GraphML?v=2")).unwrap(),
        FormatId::GraphMl
    );
    for text in [UNDIRECTED, EDITOR, "<graphml><graph/></graphml>"] {
        assert_eq!(detect_format(text, None).unwrap(), FormatId::GraphMl);
        assert_eq!(
            detect_format(text, Some("export.xml")).unwrap(),
            FormatId::GraphMl
        );
    }
    let mut options = ParseOptions::default();
    options.filename = Some("g.graphml".to_owned());
    let result = parse_graph(DIRECTED, &options).unwrap();
    assert_eq!(result.format, FormatId::GraphMl);
    assert_eq!(FormatId::from_id("graphml"), Some(FormatId::GraphMl));
    assert_eq!(FormatId::GraphMl.id(), "graphml");
    assert!(FormatId::ALL.contains(&FormatId::GraphMl));
}

#[test]
fn an_empty_document_is_an_empty_graph() {
    for text in [
        "",
        " \n",
        "<graphml/>",
        "<graphml><graph edgedefault=\"directed\"/></graphml>",
    ] {
        let result = graphml(text);
        let count = |list: &str| {
            result
                .graph
                .get(list)
                .and_then(Value::as_array)
                .map(<[Value]>::len)
        };
        assert_eq!(
            (count("nodes"), count("edges")),
            (Some(0), Some(0)),
            "{text:?}"
        );
        assert!(result.warnings.is_empty());
    }
}

#[test]
fn several_graphs_are_one_graph() {
    let result = graphml(
        r#"<graphml>
             <graph><node id="a"/></graph>
             <graph><node id="b"/><edge source="a" target="b"/></graph>
           </graphml>"#,
    );
    let count = |list: &str| {
        result
            .graph
            .get(list)
            .and_then(Value::as_array)
            .map(<[Value]>::len)
    };
    assert_eq!((count("nodes"), count("edges")), (Some(2), Some(1)));
    assert_eq!(codes(&result), ["graphml-merged-graphs"]);
    assert_eq!(
        result.warnings[0].code,
        ParseWarningCode::GraphMlMergedGraphs
    );
}

#[test]
fn the_id_and_the_ends_of_an_element_are_its_own() {
    // As NetworkX's node-link data: a field named like the element's own attribute loses.
    let result = graphml(
        r#"<graphml>
             <key id="k0" for="all" attr.name="id" attr.type="string"/>
             <key id="k1" for="edge" attr.name="source" attr.type="string"/>
             <graph>
               <node id="a"><data key="k0">other</data></node>
               <node id="b"/>
               <edge id="e" source="a" target="b"><data key="k0">x</data><data key="k1">b</data></edge>
             </graph>
           </graphml>"#,
    );
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "a")),
        r#"{"id":"a"}"#
    );
    assert_eq!(
        element(&result, "edges", |_| true),
        r#"{"id":"e","source":"a","target":"b"}"#
    );
}

#[test]
fn errors_name_the_line() {
    assert_eq!(
        error("<graphml>\n<graph>\n<node/>\n</graph></graphml>"),
        "Invalid GraphML: <node> has no `id` attribute on line 3."
    );
    assert_eq!(
        error("<graphml><graph>\n<edge source=\"a\"/></graph></graphml>"),
        "Invalid GraphML: <edge> has no `target` attribute on line 2."
    );
    assert_eq!(
        error("<graphml><graph><node id=\"a\">\n\n<data>x</data></node></graph></graphml>"),
        "Invalid GraphML: <data> has no `key` attribute on line 3."
    );
    assert_eq!(
        error("<gexf xmlns=\"http://gexf.net/1.3\"/>"),
        "Invalid GraphML: the root element is <gexf>, not <graphml> on line 1."
    );
    assert!(error("<graphml><graph>").starts_with("Invalid GraphML: "));
    // External entities are never loaded.
    assert!(
        error("<!DOCTYPE graphml [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><graphml><graph><node id=\"&x;\"/></graph></graphml>")
            .starts_with("Invalid GraphML: ")
    );
}

#[test]
fn graphml_read_as_rdf_xml_says_what_it_is() {
    let mut options = ParseOptions::default();
    options.format = Some(FormatId::RdfXml);
    let message = parse_graph(UNDIRECTED, &options).unwrap_err().to_string();
    assert_eq!(
        message,
        "The document is GraphML, not RDF/XML: read it with the format `graphml`."
    );
}
