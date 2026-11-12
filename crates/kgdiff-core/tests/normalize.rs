//! `normalize`, ported from `packages/core/test/normalize.test.ts`.

use kgdiff_core::js::{JsStr, Value, json};
use kgdiff_core::options::DanglingEdges;
use kgdiff_core::{
    EdgeIdentity, ErrorCode, GraphIssueCode, KGEdge, KGraph, NormalizeOptions, hash_graph,
    normalize,
};

fn graph(text: &str) -> Value {
    json::parse(text).unwrap()
}

fn norm(text: &str) -> KGraph {
    normalize(&graph(text), NormalizeOptions::default()).unwrap()
}

fn by_id(text: &str) -> KGraph {
    let mut options = NormalizeOptions::default();
    options.edge_identity = EdgeIdentity::Id;
    normalize(&graph(text), options).unwrap()
}

fn keys(g: &KGraph) -> Vec<String> {
    g.edges().map(|e| e.key().to_string()).collect()
}

fn edges_of(g: &KGraph) -> Vec<KGEdge> {
    g.edges().map(|e| e.to_edge()).collect()
}

fn codes(g: &KGraph) -> Vec<GraphIssueCode> {
    g.issues().iter().map(|i| i.code).collect()
}

#[test]
fn fills_defaults_and_canonicalizes_sets() {
    let g = norm(
        r#"{"nodes":[{"id":"a","type":["B","A","B",""],"aliases":["Y","a","X","Y"],"replaces":["r2","r1"]}],"edges":[]}"#,
    );
    let a = g.node("a").unwrap();
    assert_eq!(a.label().as_str(), "a");
    assert_eq!(a.types(), &["A", "B"].map(JsStr::from));
    assert_eq!(a.aliases(), &["X", "Y"].map(JsStr::from));
    assert_eq!(a.replaces(), &["r1", "r2"].map(JsStr::from));
    assert!(!a.is_deprecated() && !a.is_implicit());
}

#[test]
fn merges_duplicate_declarations_field_wise() {
    let g = norm(
        r#"{"nodes":[{"id":"a","label":"First","type":"A","attrs":{"k":1,"keep":true},"deprecated":true},{"id":"a","label":"Second","type":"B","attrs":{"k":2}}],"edges":[]}"#,
    );
    let a = g.node("a").unwrap();
    assert_eq!(a.label().as_str(), "Second");
    assert_eq!(a.types(), &["A", "B"].map(JsStr::from));
    assert_eq!(
        json::to_string(&Value::Object(a.attrs().clone())),
        r#"{"k":2,"keep":true}"#
    );
    assert!(a.is_deprecated());
    assert_eq!(codes(&g), [GraphIssueCode::DuplicateNode]);
}

#[test]
fn keys_parallel_copies_in_content_order() {
    let copies = [
        r#"{"source":"a","target":"b","predicate":"KNOWS","attrs":{"since":2021}}"#,
        r#"{"source":"a","target":"b","predicate":"KNOWS","attrs":{"since":2019}}"#,
        r#"{"source":"a","target":"b","predicate":"KNOWS","attrs":{"since":2020}}"#,
    ];
    let forward = norm(&format!(
        r#"{{"nodes":[{{"id":"a"}},{{"id":"b"}}],"edges":[{}]}}"#,
        copies.join(",")
    ));
    let reversed: Vec<&str> = copies.iter().rev().copied().collect();
    let backward = norm(&format!(
        r#"{{"nodes":[{{"id":"a"}},{{"id":"b"}}],"edges":[{}]}}"#,
        reversed.join(",")
    ));
    let base = r#"["a","KNOWS","b"]"#;
    assert_eq!(
        keys(&forward),
        [base.to_owned(), format!("{base}#2"), format!("{base}#3")]
    );
    assert_eq!(
        forward.edge(base).unwrap().attrs().get("since"),
        Some(&Value::Number(2019.0))
    );
    assert_eq!(edges_of(&forward), edges_of(&backward));
    assert_eq!(codes(&forward), [GraphIssueCode::DuplicateEdge]);
}

#[test]
fn collapses_identical_copies_keeping_the_smallest_id() {
    let g = norm(
        r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"id":"e2","source":"a","target":"b","predicate":"p"},{"id":"e1","source":"a","target":"b","predicate":"p"}]}"#,
    );
    assert_eq!(g.edge_count(), 1);
    assert_eq!(g.edge_at(0).unwrap().id().map(|id| id.as_str()), Some("e1"));
    assert_eq!(codes(&g), [GraphIssueCode::DuplicateEdge]);
}

#[test]
fn keys_edges_by_id_under_id_identity() {
    let g = by_id(
        r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"id":"e1","source":"a","target":"b","predicate":"p"},{"id":"e2","source":"a","target":"b","predicate":"p"},{"source":"b","target":"a","predicate":"q"}]}"#,
    );
    assert_eq!(keys(&g), ["e1", "e2", r#"["b","q","a"]"#]);
    let merged = by_id(
        r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"id":"e","source":"a","target":"b","predicate":"p","attrs":{"w":1,"keep":1}},{"id":"e","source":"a","target":"a","predicate":"q","attrs":{"w":2}}]}"#,
    );
    let e = merged.edge("e").unwrap();
    assert_eq!((e.target().as_str(), e.predicate().as_str()), ("a", "q"));
    assert_eq!(
        json::to_string(&Value::Object(e.attrs().clone())),
        r#"{"w":2,"keep":1}"#
    );
    assert_eq!(codes(&merged), [GraphIssueCode::DuplicateEdge]);
}

#[test]
fn keeps_edge_ids_and_structural_keys_apart() {
    let lookalike =
        r#"{"id":"[\"a\",\"p\",\"b\"]","source":"a","target":"b","predicate":"q","label":"X"}"#;
    let structural = r#"{"source":"a","target":"b","predicate":"p","label":"Y"}"#;
    let forward = by_id(&format!(
        r#"{{"nodes":[{{"id":"a"}},{{"id":"b"}}],"edges":[{lookalike},{structural}]}}"#
    ));
    let backward = by_id(&format!(
        r#"{{"nodes":[{{"id":"a"}},{{"id":"b"}}],"edges":[{structural},{lookalike}]}}"#
    ));
    assert_eq!(forward.edge_count(), 2);
    assert_eq!(
        forward.edge(r#"["a","p","b"]"#).unwrap().label().as_str(),
        "X"
    );
    assert_eq!(hash_graph(&forward), hash_graph(&backward));
}

#[test]
fn applies_the_dangling_edge_policies() {
    let g =
        norm(r#"{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"ghost","predicate":"p"}]}"#);
    assert!(g.node("ghost").unwrap().is_implicit());
    assert_eq!(g.issues()[0].reference.as_deref(), Some("ghost"));
    let mut drop = NormalizeOptions::default();
    drop.dangling_edges = DanglingEdges::Drop;
    let dropped = normalize(&graph(r#"{"nodes":[{"id":"a"}],"edges":[{"source":"ghost","target":"a"},{"source":"a","target":"a"}]}"#), drop).unwrap();
    assert_eq!(
        (dropped.edge_count(), dropped.contains_node("ghost")),
        (1, false)
    );
    let mut error = NormalizeOptions::default();
    error.dangling_edges = DanglingEdges::Error;
    let e = normalize(
        &graph(r#"{"nodes":[],"edges":[{"source":"a","target":"a"}]}"#),
        error,
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::DanglingEdge);
    assert_eq!(
        e.message,
        r#"Edge ["a","","a"] points to the missing node "a""#
    );
    assert_eq!(e.details.unwrap().get("missing"), Some(&Value::from("a")));
}

#[test]
fn rejects_malformed_input() {
    for (input, message) in [
        (
            "42",
            "normalize expects a graph of the form { nodes: [...], edges: [...] }",
        ),
        (
            r#"{"edges":[]}"#,
            "normalize expects a graph of the form { nodes: [...], edges: [...] }",
        ),
        (r#"{"nodes":[],"edges":{}}"#, "graph.edges must be an array"),
        (
            r#"{"nodes":["a"],"edges":[]}"#,
            "graph.nodes must contain objects",
        ),
        (
            r#"{"nodes":[{"id":"a","aliases":[1]}],"edges":[]}"#,
            r#"Node "a": aliases must be an array of strings"#,
        ),
        (
            r#"{"nodes":[{"id":"a","deprecated":"yes"}],"edges":[]}"#,
            r#"Node "a": deprecated must be a boolean"#,
        ),
        (
            r#"{"nodes":[{"id":"a","attrs":[]}],"edges":[]}"#,
            r#"Node "a": attrs must be an object"#,
        ),
        (
            r#"{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"a","predicate":3}]}"#,
            "Edge a → a: predicate must be a string",
        ),
    ] {
        let e = normalize(&graph(input), NormalizeOptions::default()).unwrap_err();
        assert_eq!(
            (e.code, e.message.as_str()),
            (ErrorCode::InvalidInput, message),
            "{input}"
        );
    }
}

#[test]
fn checks_the_format_marker() {
    let plain = r#""nodes":[{"id":"a"}],"edges":[]"#;
    let marked = norm(&format!(
        r#"{{"format":"kgdiff.graph","version":1,{plain}}}"#
    ));
    assert_eq!(
        hash_graph(&marked),
        hash_graph(&norm(&format!("{{{plain}}}")))
    );
    for version in ["2", "0", "\"1\"", "null"] {
        let e = normalize(
            &graph(&format!(
                r#"{{"format":"kgdiff.graph","version":{version},{plain}}}"#
            )),
            NormalizeOptions::default(),
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::UnsupportedVersion);
    }
    let e = normalize(
        &graph(&format!(r#"{{"format":"kgdiff.graph",{plain}}}"#)),
        NormalizeOptions::default(),
    )
    .unwrap_err();
    assert_eq!(
        e.message,
        "Unsupported graph version undefined; this reader supports version 1"
    );
    for format in ["kgdiff.diff", "kgdiff.delta", "kgdiff.graph2"] {
        let e = normalize(
            &graph(&format!(r#"{{"format":"{format}","version":1,{plain}}}"#)),
            NormalizeOptions::default(),
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::UnsupportedVersion);
    }
    for format in ["\"graphml\"", "7", "null"] {
        assert_eq!(
            norm(&format!(r#"{{"format":{format},"version":9,{plain}}}"#)).node_count(),
            1
        );
    }
}

#[test]
fn keeps_proto_as_an_ordinary_key_and_turns_non_finite_numbers_into_text() {
    let g = norm(
        r#"{"nodes":[{"id":"a","attrs":{"__proto__":{"x":1},"constructor":2,"big":1e400}}],"edges":[]}"#,
    );
    let node = g.node("a").unwrap();
    let attrs = node.attrs();
    assert_eq!(
        json::to_string(&Value::Object(attrs.clone())),
        r#"{"__proto__":{"x":1},"constructor":2,"big":"Infinity"}"#
    );
}

#[test]
fn composes_labels_aliases_and_types_to_nfc_but_not_ids() {
    let decomposed = "Cafe\u{301}";
    let g = norm(&format!(
        r#"{{"nodes":[{{"id":"{decomposed}","label":"{decomposed}","aliases":["{decomposed}","x"],"type":"{decomposed}"}}],"edges":[]}}"#
    ));
    let node = g.node(decomposed).unwrap();
    assert_eq!(node.label().as_str(), "Café");
    assert_eq!(node.types()[0].as_str(), "Café");
    assert_eq!(node.aliases(), &["x"].map(JsStr::from));
}
