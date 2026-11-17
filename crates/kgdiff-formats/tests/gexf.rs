//! GEXF: one graph saved as GEXF and as node-link JSON is the same graph, and what Gephi adds
//! (drawing data, time, a hierarchy) is dropped or flattened with a warning.
//!
//! `fixtures/networkx-*.gexf` are the graphs of `fixtures/networkx-*.json`, in the form
//! NetworkX's `write_gexf` writes them; `fixtures/networkx.py` writes them.

use kgdiff_core::js::{Value, json};
use kgdiff_core::{NormalizeOptions, hash_graph, normalize};
use kgdiff_formats::{FormatId, ParseOptions, ParseResult, detect_format, parse_graph};

const UNDIRECTED: &str = include_str!("fixtures/networkx-undirected.gexf");
const UNDIRECTED_JSON: &str = include_str!("fixtures/networkx-undirected.json");
const DIRECTED: &str = include_str!("fixtures/networkx-directed.gexf");
const DIRECTED_JSON: &str = include_str!("fixtures/networkx-directed.json");
const GEPHI: &str = include_str!("fixtures/gephi.gexf");

fn parse(text: &str, format: FormatId) -> ParseResult {
    let mut options = ParseOptions::default();
    options.format = Some(format);
    parse_graph(text, &options).unwrap()
}

fn gexf(text: &str) -> ParseResult {
    parse(text, FormatId::Gexf)
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
    options.format = Some(FormatId::Gexf);
    parse_graph(text, &options).unwrap_err().to_string()
}

fn list<'a>(result: &'a ParseResult, name: &str) -> &'a [Value] {
    result.graph.get(name).and_then(Value::as_array).unwrap()
}

/// The node or edge of `result` that `found` picks, as JSON text.
fn element(result: &ParseResult, name: &str, found: impl Fn(&Value) -> bool) -> String {
    let hits: Vec<&Value> = list(result, name).iter().filter(|v| found(v)).collect();
    assert_eq!(hits.len(), 1, "{name}");
    json::to_string(hits[0])
}

fn has(value: &Value, key: &str, text: &str) -> bool {
    value
        .as_object()
        .and_then(|o| o.get(key))
        .and_then(Value::as_str)
        == Some(text)
}

/// The edges without their ids: NetworkX numbers the edges of a GEXF file, and node-link JSON
/// has no such number.
fn edges_without_ids(result: &ParseResult) -> Vec<String> {
    list(result, "edges")
        .iter()
        .map(|edge| {
            let kept: kgdiff_core::js::Object = edge
                .as_object()
                .unwrap()
                .iter()
                .filter(|(key, _)| **key != "id")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            json::to_string(&Value::Object(kept))
        })
        .collect()
}

#[test]
fn the_same_graph_as_gexf_and_as_node_link_json() {
    for (xml, node_link) in [(UNDIRECTED, UNDIRECTED_JSON), (DIRECTED, DIRECTED_JSON)] {
        let from_xml = gexf(xml);
        let from_json = parse(node_link, FormatId::Json);
        assert_eq!(list(&from_xml, "nodes"), list(&from_json, "nodes"));
        assert_eq!(edges_without_ids(&from_xml), edges_without_ids(&from_json));
        // Edge ids are not part of a graph's content unless edges are identified by id.
        assert_eq!(hash(&from_xml), hash(&from_json));
        assert!(from_xml.warnings.is_empty(), "{:?}", from_xml.warnings);
        assert_eq!(from_xml.format, FormatId::Gexf);
        assert_eq!(from_xml.dialect, None);
    }
}

#[test]
fn nodes_edges_and_their_typed_attributes() {
    let result = gexf(UNDIRECTED);
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "赤壁")),
        r#"{"id":"赤壁","label":"赤壁之战","type":"事件","attrs":{"description":"孙刘联军 & 曹军 <长江>","year":208}}"#
    );
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "孙权")),
        r#"{"id":"孙权","type":"人物","attrs":{"born":182,"famous":false}}"#
    );
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "0")),
        r#"{"id":"0","source":"曹操","target":"赤壁","predicate":"参战","attrs":{"weight":1}}"#
    );
    // The graph's name is its `name` attribute.
    let meta = result.graph.get("meta").map(json::to_string);
    assert_eq!(meta.as_deref(), Some(r#"{"name":"chibi"}"#));
}

#[test]
fn what_gephi_adds_is_dropped_or_flattened_with_a_warning() {
    let result = gexf(GEPHI);
    let warnings: Vec<(&str, &str)> = result
        .warnings
        .iter()
        .map(|w| (w.code.as_str(), w.message.as_str()))
        .collect();
    assert_eq!(
        warnings,
        [
            (
                "gexf-dynamic",
                "A dynamic graph, read as one static graph: 5 time marks ignored."
            ),
            (
                "gexf-hierarchy",
                "3 nested nodes read as plain nodes: the hierarchy is not kept."
            ),
            (
                "gexf-ignored-viz",
                "4 viz elements dropped (position, colour, size, shape)."
            ),
            (
                "gexf-invalid-value",
                "2 values not of the type its attribute declares: kept as text."
            ),
        ]
    );
    // Defaults fill what a node has no <attvalue> for.
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "animal")),
        r#"{"id":"animal","label":"Animal","type":"concept","attrs":{"rank":1,"reviewed":false}}"#
    );
    // A node inside another is a node; `TRUE` is a boolean; `first` is not an integer.
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "cat")),
        r#"{"id":"cat","label":"Cat & kitten","type":"concept","attrs":{"rank":"first","reviewed":true}}"#
    );
    // An <attvalue> whose attribute is not declared is a text field named by its `for`.
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "dog")),
        r#"{"id":"dog","label":"Dog","type":"concept","attrs":{"note":"undeclared attribute","reviewed":false}}"#
    );
    // `kind` is the relation; without one, the label is.
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "0")),
        r#"{"id":"0","source":"mammals","target":"animal","predicate":"is_a"}"#
    );
    // `type="directed"` is not the predicate; of an attribute that changes over time, the last
    // value is read.
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "1")),
        r#"{"id":"1","source":"cat","target":"dog","predicate":"chases","label":"chases","attrs":{"score":0.9,"weight":0.5}}"#
    );
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "2")),
        r#"{"id":"2","source":"bird","target":"animal","predicate":"is_a","label":"is a","attrs":{"weight":"heavy"}}"#
    );
    assert_eq!(
        (list(&result, "nodes").len(), list(&result, "edges").len()),
        (5, 3)
    );
}

#[test]
fn is_detected_from_the_extension_and_from_the_content() {
    assert_eq!(
        detect_format("", Some("graph.gexf")).unwrap(),
        FormatId::Gexf
    );
    for text in [UNDIRECTED, GEPHI, "<gexf><graph/></gexf>"] {
        assert_eq!(detect_format(text, None).unwrap(), FormatId::Gexf);
        assert_eq!(
            detect_format(text, Some("export.xml")).unwrap(),
            FormatId::Gexf
        );
    }
    let mut options = ParseOptions::default();
    options.filename = Some("g.gexf".to_owned());
    assert_eq!(
        parse_graph(DIRECTED, &options).unwrap().format,
        FormatId::Gexf
    );
    assert_eq!(FormatId::from_id("gexf"), Some(FormatId::Gexf));
    assert!(FormatId::ALL.contains(&FormatId::Gexf));
}

#[test]
fn an_empty_document_is_an_empty_graph() {
    for text in [
        "",
        " \n",
        "<gexf/>",
        "<gexf><graph><nodes/><edges/></graph></gexf>",
    ] {
        let result = gexf(text);
        assert_eq!(
            (list(&result, "nodes").len(), list(&result, "edges").len()),
            (0, 0),
            "{text:?}"
        );
        assert!(result.warnings.is_empty());
    }
}

#[test]
fn the_id_and_the_ends_of_an_element_are_its_own() {
    let result = gexf(
        r#"<gexf><graph>
             <attributes class="node"><attribute id="0" title="id" type="string"/></attributes>
             <attributes class="edge"><attribute id="0" title="source" type="string"/></attributes>
             <nodes>
               <node id="a"><attvalues><attvalue for="0" value="other"/></attvalues></node>
               <node id="b"/>
             </nodes>
             <edges>
               <edge id="e" source="a" target="b"><attvalues><attvalue id="0" value="b"/></attvalues></edge>
             </edges>
           </graph></gexf>"#,
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
        error("<gexf><graph><nodes>\n<node label=\"x\"/></nodes></graph></gexf>"),
        "Invalid GEXF: <node> has no `id` attribute on line 2."
    );
    assert_eq!(
        error("<gexf><graph><edges>\n\n<edge source=\"a\"/></edges></graph></gexf>"),
        "Invalid GEXF: <edge> has no `target` attribute on line 3."
    );
    assert_eq!(
        error(
            "<gexf><graph><nodes><node id=\"a\"><attvalues>\n<attvalue value=\"1\"/></attvalues></node></nodes></graph></gexf>"
        ),
        "Invalid GEXF: <attvalue> has no `for` attribute on line 2."
    );
    assert_eq!(
        error("<graphml/>"),
        "Invalid GEXF: the root element is <graphml>, not <gexf> on line 1."
    );
    assert!(error("<gexf><graph>").starts_with("Invalid GEXF: "));
}

#[test]
fn gexf_read_as_rdf_xml_says_what_it_is() {
    let mut options = ParseOptions::default();
    options.format = Some(FormatId::RdfXml);
    assert_eq!(
        parse_graph(GEPHI, &options).unwrap_err().to_string(),
        "The document is GEXF, not RDF/XML: read it with the format `gexf`."
    );
}

/// NetworkX writes `label` on every node, the id when the node has none, and an edge attribute
/// named `type` as the edge's `type`.
#[test]
fn what_networkx_puts_in_label_and_type() {
    let result = gexf(
        r#"<gexf xmlns="http://www.gexf.net/1.2draft" version="1.2"><graph defaultedgetype="directed" mode="static" name="">
             <attributes mode="static" class="node"><attribute id="0" title="name" type="string"/></attributes>
             <nodes>
               <node id="ada" label="ada"><attvalues><attvalue for="0" value="Ada Lovelace"/></attvalues></node>
               <node id="cb" label="cb"/>
             </nodes>
             <edges>
               <edge source="ada" target="cb" id="0" type="KNOWS"/>
               <edge source="cb" target="ada" id="1" type="directed"/>
             </edges>
           </graph></gexf>"#,
    );
    let node_link = parse(
        r#"{"directed":true,"multigraph":false,"graph":{},"nodes":[{"name":"Ada Lovelace","id":"ada"},{"id":"cb"}],
            "links":[{"type":"KNOWS","source":"ada","target":"cb"},{"source":"cb","target":"ada"}]}"#,
        FormatId::Json,
    );
    assert_eq!(
        element(&result, "nodes", |n| has(n, "id", "ada")),
        r#"{"id":"ada","label":"Ada Lovelace"}"#
    );
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "0")),
        r#"{"id":"0","source":"ada","target":"cb","predicate":"KNOWS"}"#
    );
    assert_eq!(
        element(&result, "edges", |e| has(e, "id", "1")),
        r#"{"id":"1","source":"cb","target":"ada"}"#
    );
    assert_eq!(list(&result, "nodes"), list(&node_link, "nodes"));
    assert_eq!(hash(&result), hash(&node_link));
    assert!(result.warnings.is_empty());
}

#[test]
fn the_ends_of_an_undirected_edge_are_in_one_order() {
    let graph = |default: &str, edge: &str| {
        gexf(&format!(
            r#"<gexf><graph defaultedgetype="{default}"><nodes><node id="a"/><node id="b"/></nodes><edges>{edge}</edges></graph></gexf>"#
        ))
    };
    let ends = |result: &ParseResult| element(result, "edges", |_| true);
    let ab = r#"{"source":"a","target":"b"}"#;
    let ba = r#"{"source":"b","target":"a"}"#;
    assert_eq!(
        ends(&graph("undirected", r#"<edge source="b" target="a"/>"#)),
        ab
    );
    assert_eq!(
        ends(&graph("directed", r#"<edge source="b" target="a"/>"#)),
        ba
    );
    assert_eq!(
        ends(&graph(
            "directed",
            r#"<edge source="b" target="a" type="undirected"/>"#
        )),
        ab
    );
    assert_eq!(
        ends(&graph(
            "undirected",
            r#"<edge source="b" target="a" type="directed"/>"#
        )),
        ba
    );
}

#[test]
fn defaults_cannot_add_more_fields_than_the_input_allows() {
    let mut text = String::from(r#"<gexf><graph><attributes class="node">"#);
    for k in 0..2000 {
        text.push_str(&format!(
            r#"<attribute id="k{k}" title="a{k}" type="string"><default>v</default></attribute>"#
        ));
    }
    text.push_str("</attributes><nodes>");
    for n in 0..600 {
        text.push_str(&format!(r#"<node id="n{n}"/>"#));
    }
    text.push_str("</nodes></graph></gexf>");
    assert_eq!(
        error(&text),
        "Invalid GEXF: the <default> values add more than 1000000 fields to the nodes and edges, the limit for an input of this size."
    );
}

#[test]
fn parents_are_a_hierarchy_too() {
    let result = gexf(
        r#"<gexf><graph><nodes>
             <node id="a"/>
             <node id="b"><parents><parent for="a"/></parents></node>
           </nodes></graph></gexf>"#,
    );
    assert_eq!(
        result
            .warnings
            .iter()
            .map(|w| w.code.as_str())
            .collect::<Vec<_>>(),
        ["gexf-hierarchy"]
    );
}
