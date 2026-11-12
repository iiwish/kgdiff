//! The other ways into a graph (RFC 0003, part 3): `normalize_input` from Rust values and
//! `normalize_json` from text give the graph `normalize` gives. The conformance corpus checks
//! both on every graph (`input.before`, `input.after`); these are the cases it does not have.

use kgdiff_core::js::{Value, json};
use kgdiff_core::options::DanglingEdges;
use kgdiff_core::{
    EdgeIdentity, EdgeInput, ErrorCode, GraphInput, KGraph, NodeInput, NormalizeOptions, Point,
    Result, graph_to_json, hash_graph, normalize, normalize_input, normalize_json,
};

fn outcome(graph: Result<KGraph>) -> String {
    match graph {
        Ok(graph) => format!(
            "{} {} {}",
            json::to_string(&graph_to_json(&graph)),
            hash_graph(&graph),
            json::to_string(&Value::Array(
                graph.issues().iter().map(|i| i.to_value()).collect()
            ))
        ),
        Err(e) => format!("error {} {}", e.code, e.message),
    }
}

fn by_value(text: &str, options: NormalizeOptions) -> String {
    match json::parse(text) {
        Ok(value) => outcome(normalize(&value, options)),
        Err(e) => format!("error invalid-input The graph is not JSON: {e}"),
    }
}

#[test]
fn text_read_in_one_pass_or_whole_gives_the_graph_of_its_value() {
    let documents = [
        // In one pass: nodes, then edges, other members anywhere.
        r#"{"meta":{"name":"n"},"nodes":[{"id":"a"},{"id":"b","label":"B"}],"edges":[{"source":"a","target":"b","predicate":"p"},{"source":"a","target":"b","predicate":"p"}],"format":"kgdiff.graph","version":1}"#,
        r#"{"nodes":[{"id":"a"},{"id":"a","label":"twice"}]}"#,
        r#"{"nodes":[],"edges":[]}"#,
        r#"{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"ghost"}]}"#,
        // Read whole: edges first, repeated arrays, errors of every kind.
        r#"{"edges":[{"source":"a","target":"b"}],"nodes":[{"id":"a"},{"id":"b"}]}"#,
        r#"{"nodes":[{"id":"a"}],"nodes":[{"id":"b"}]}"#,
        r#"{"nodes":[{"id":"a"}],"edges":[],"edges":[{"source":"a","target":"a"}]}"#,
        r#"{"nodes":[{"id":"a","attrs":1}],"format":"kgdiff.delta"}"#,
        r#"{"nodes":[{"id":"a","attrs":1}]}"#,
        r#"{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"a","label":2}]} x"#,
        r#"{"nodes":[{"id":"a"}],"edges":{}}"#,
        r#"{"edges":[]}"#,
        r#"[]"#,
        r#"{}"#,
        r#"{"nodes":[{"id":"a"}],"edges":null}"#,
    ];
    for options in [NormalizeOptions::default(), {
        let mut o = NormalizeOptions::default();
        o.edge_identity = EdgeIdentity::Id;
        o.dangling_edges = DanglingEdges::Error;
        o
    }] {
        for text in documents {
            assert_eq!(
                outcome(normalize_json(text, options)),
                by_value(text, options),
                "{text}"
            );
        }
    }
}

#[test]
fn values_give_the_graph_of_their_json() {
    let mut attrs = kgdiff_core::js::Object::new();
    attrs.insert("w", f64::NAN);
    attrs.insert("n", 1.5);
    let input = {
        let mut o = GraphInput::default();
        o.meta = json::parse(r#"{"name":"typed"}"#)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        o.nodes = vec![
            {
                let mut o = NodeInput::new("a");
                o.label = Some("Ａ".into());
                o.types = vec!["t2".into(), "t1".into(), "t1".into()];
                o.aliases = vec!["a".into(), "x".into()];
                o.attrs = attrs.clone();
                o.position = Some(Point { x: 1.0, y: 2.0 });
                o
            },
            {
                let mut o = NodeInput::new("b");
                o.label = Some(String::new().into());
                o.deprecated = true;
                o.replaces = vec!["old".into()];
                o
            },
            NodeInput::new(""),
            {
                let mut o = NodeInput::new("a");
                o.position = Some(Point {
                    x: f64::INFINITY,
                    y: 0.0,
                });
                o.label = Some("again".into());
                o
            },
        ];
        o.edges = vec![
            {
                let mut o = EdgeInput::new("a", "p", "b");
                o.id = Some("e1".into());
                o.attrs = attrs;
                o
            },
            {
                let mut o = EdgeInput::new("b", "p", "a");
                o.id = Some("e1".into());
                o.label = Some("Named".into());
                o
            },
            EdgeInput::new("a", "", "ghost"),
            EdgeInput::new("", "p", "a"),
            {
                let mut o = EdgeInput::new("a", "p", "b");
                o.id = Some(String::new().into());
                o
            },
        ];
        o
    };
    for edge_identity in [EdgeIdentity::Structure, EdgeIdentity::Id] {
        for dangling_edges in [
            DanglingEdges::Create,
            DanglingEdges::Drop,
            DanglingEdges::Error,
        ] {
            let mut options = NormalizeOptions::default();
            options.edge_identity = edge_identity;
            options.dangling_edges = dangling_edges;
            assert_eq!(
                outcome(normalize_input(input.clone(), options)),
                outcome(normalize(&input.to_value(), options)),
                "{options:?}"
            );
        }
    }
    let failed = normalize_input(input, {
        let mut o = NormalizeOptions::default();
        o.dangling_edges = DanglingEdges::Error;
        o
    });
    assert_eq!(
        failed.map(|_| ()).unwrap_err().code,
        ErrorCode::DanglingEdge
    );
}

#[test]
fn a_graph_is_read_through_its_methods() {
    let graph = normalize_json(
        r#"{"nodes":[{"id":"a","aliases":["x"]},{"id":"b"}],"edges":[{"source":"a","target":"b","predicate":"p","attrs":{"w":1}},{"source":"a","target":"b","predicate":"p","attrs":{"w":2}}]}"#,
        NormalizeOptions::default(),
    )
    .unwrap();
    assert_eq!((graph.node_count(), graph.edge_count()), (2, 2));
    let a = graph.node("a").unwrap();
    assert_eq!((a.label().as_str(), a.aliases().len()), ("a", 1));
    assert_eq!(graph.node_index("b"), Some(1));
    let keys: Vec<String> = graph.edges().map(|e| e.key().to_string()).collect();
    assert_eq!(keys, [r#"["a","p","b"]"#, r#"["a","p","b"]#2"#]);
    let second = graph.edge(&keys[1]).unwrap();
    assert_eq!(second.index(), 1);
    assert_eq!(second.attrs().get("w"), Some(&Value::Number(2.0)));
    assert_eq!(second.to_edge().key().as_str(), keys[1]);
    assert!(graph.edge(r#"["a","p","b"]#3"#).is_none());
    assert_eq!(graph.outgoing("a").count(), 2);
    assert_eq!(
        graph.incoming("b").map(|e| e.index()).collect::<Vec<_>>(),
        [0, 1]
    );
    assert_eq!(graph.degree(Some("b")), 2);
}
