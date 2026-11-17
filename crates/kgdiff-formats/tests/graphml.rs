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
            "1 <data> element with XML content dropped (the drawing data of yEd and other editors; yEd's labels are kept).",
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

/// yEd keeps a node's label in its drawing data, and an edge's too: the first one with text is
/// the element's label, unless a field already is.
#[test]
fn yed_labels_are_the_labels() {
    let yed = |node: &str, edge: &str| {
        format!(
            r#"<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:y="http://www.yworks.com/xml/graphml">
                 <key for="node" id="d5" yfiles.type="nodegraphics"/>
                 <key for="edge" id="d9" yfiles.type="edgegraphics"/>
                 <key for="node" id="d6" attr.name="label" attr.type="string"/>
                 <graph edgedefault="directed" id="G">
                   <node id="n0"><data key="d5"><y:ShapeNode>
                     <y:Geometry height="30.0" width="30.0" x="0.0" y="0.0"/>
                     <y:NodeLabel alignment="center" visible="true">{node}<y:LabelModel><y:SmartNodeLabelModel distance="4.0"/></y:LabelModel></y:NodeLabel>
                     <y:NodeLabel>second label</y:NodeLabel>
                     <y:Shape type="rectangle"/>
                   </y:ShapeNode></data></node>
                   <node id="n1"><data key="d5"><y:ShapeNode><y:NodeLabel hasText="false"/></y:ShapeNode></data></node>
                   <node id="n2"><data key="d6">Own label</data><data key="d5"><y:ShapeNode><y:NodeLabel>Drawn label</y:NodeLabel></y:ShapeNode></data></node>
                   <edge id="e0" source="n0" target="n1"><data key="d9"><y:PolyLineEdge><y:EdgeLabel>{edge}</y:EdgeLabel></y:PolyLineEdge></data></edge>
                 </graph>
               </graphml>"#
        )
    };
    let result = graphml(&yed("Ada", "knows"));
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "n0")),
        r#"{"id":"n0","label":"Ada"}"#
    );
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "n1")),
        r#"{"id":"n1"}"#
    );
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "n2")),
        r#"{"id":"n2","label":"Own label"}"#
    );
    assert_eq!(
        element(&result, "edges", |_| true),
        r#"{"id":"e0","source":"n0","target":"n1","predicate":"knows","label":"knows"}"#
    );
    assert_eq!(codes(&result), ["graphml-ignored-data"]);
    // A label that changes is a change.
    assert_ne!(hash(&result), hash(&graphml(&yed("Ada Lovelace", "knows"))));
    assert_ne!(hash(&result), hash(&graphml(&yed("Ada", "worked with"))));
}

/// A library writes the ends of an undirected edge in the order it met the nodes.
#[test]
fn the_ends_of_an_undirected_edge_are_in_one_order() {
    let graph = |default: &str, edge: &str| {
        graphml(&format!(
            r#"<graphml><graph edgedefault="{default}"><node id="a"/><node id="b"/>{edge}</graph></graphml>"#
        ))
    };
    let ends = |result: &ParseResult| element(result, "edges", |_| true);
    let ab = r#"{"source":"a","target":"b"}"#;
    let ba = r#"{"source":"b","target":"a"}"#;
    assert_eq!(
        ends(&graph("undirected", r#"<edge source="a" target="b"/>"#)),
        ab
    );
    assert_eq!(
        ends(&graph("undirected", r#"<edge source="b" target="a"/>"#)),
        ab
    );
    assert_eq!(
        ends(&graph("directed", r#"<edge source="b" target="a"/>"#)),
        ba
    );
    // The edge's own `directed` wins over the graph's default.
    assert_eq!(
        ends(&graph(
            "directed",
            r#"<edge source="b" target="a" directed="false"/>"#
        )),
        ab
    );
    assert_eq!(
        ends(&graph(
            "undirected",
            r#"<edge source="b" target="a" directed="true"/>"#
        )),
        ba
    );
    assert_eq!(
        hash(&graph("undirected", r#"<edge source="a" target="b"/>"#)),
        hash(&graph("undirected", r#"<edge source="b" target="a"/>"#))
    );
}

/// NetworkX writes the keys of a multigraph's parallel edges as edge ids, from 0 for every pair
/// of nodes: ids that are not unique are no ids.
#[test]
fn edge_ids_that_edges_share_are_not_read() {
    let result = graphml(
        r#"<graphml><graph edgedefault="directed">
             <node id="a"/><node id="b"/><node id="c"/>
             <edge id="0" source="a" target="b"/>
             <edge id="1" source="a" target="b"/>
             <edge id="0" source="b" target="c"/>
           </graph></graphml>"#,
    );
    let edges = result.graph.get("edges").and_then(Value::as_array).unwrap();
    assert_eq!(edges.len(), 3);
    assert!(
        edges
            .iter()
            .all(|e| e.as_object().is_some_and(|o| !o.contains_key("id")))
    );
    assert_eq!(codes(&result), ["graphml-shared-edge-ids"]);
    assert_eq!(
        result.warnings[0].message,
        "2 edges with an id another edge has too: the edge ids are not read."
    );
}

/// A default costs the file one declaration and the graph a field on every element.
#[test]
fn defaults_cannot_add_more_fields_than_the_input_allows() {
    let document = |keys: usize, nodes: usize| {
        let mut text = String::from("<graphml>");
        for k in 0..keys {
            text.push_str(&format!(
                r#"<key id="k{k}" for="node" attr.name="a{k}"><default>v</default></key>"#
            ));
        }
        text.push_str("<graph>");
        for n in 0..nodes {
            text.push_str(&format!(r#"<node id="n{n}"/>"#));
        }
        text.push_str("</graph></graphml>");
        text
    };
    // 2000 keys on 600 nodes: 1.2 million fields from about 150 kB.
    assert_eq!(
        error(&document(2000, 600)),
        "Invalid GraphML: the <default> values add more than 1000000 fields to the nodes and edges, the limit for an input of this size."
    );
    // 20 defaults on 20,000 nodes are 400,000 fields: an ordinary file.
    let result = graphml(&document(20, 20_000));
    let nodes = result.graph.get("nodes").and_then(Value::as_array).unwrap();
    assert_eq!(nodes.len(), 20_000);
    assert!(result.warnings.is_empty());
}

/// Fields the JSON reader drops as drawing state are reported under the format's name.
#[test]
fn ignored_fields_are_reported_as_graphml() {
    let result = graphml(
        r#"<graphml><key id="x" for="node" attr.name="x" attr.type="double"/>
             <graph><node id="a"><data key="x">1.5</data></node></graph></graphml>"#,
    );
    assert_eq!(
        result.warnings[0].message,
        "Ignored GraphML fields that are not part of the graph: x (1)."
    );
}
