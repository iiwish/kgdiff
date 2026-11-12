//! `apply_delta`, `invert_delta` and reading deltas (from `packages/core/test/delta.test.ts`).

use kgdiff_core::js::{Value, json};
use kgdiff_core::{
    ApplyOptions, Delta, DiffOptions, ErrorCode, NormalizeOptions, apply_delta, diff, hash_graph,
    invert_delta, normalize,
};

fn graph(text: &str) -> Value {
    json::parse(text).unwrap()
}

const BEFORE: &str = r#"{"nodes":[{"id":"a","label":"Alpha"},{"id":"b"}],"edges":[{"source":"a","target":"b","predicate":"p"}]}"#;
const AFTER: &str = r#"{"nodes":[{"id":"a","label":"Alpha 2","attrs":{"k":1}},{"id":"c"}],"edges":[{"source":"a","target":"c","predicate":"p"}]}"#;

#[test]
fn applies_strictly_and_inverts() {
    let d = diff(&graph(BEFORE), &graph(AFTER), &DiffOptions::default()).unwrap();
    let (after, skipped) = apply_delta(&d.before, &d.delta, ApplyOptions::default()).unwrap();
    assert!(skipped.is_empty());
    assert_eq!(hash_graph(&after), hash_graph(&d.after));
    let (back, _) = apply_delta(&after, &invert_delta(&d.delta), ApplyOptions::default()).unwrap();
    assert_eq!(hash_graph(&back), hash_graph(&d.before));
}

#[test]
fn rejects_another_base_and_reports_conflicts() {
    let d = diff(&graph(BEFORE), &graph(AFTER), &DiffOptions::default()).unwrap();
    let other = normalize(
        &graph(r#"{"nodes":[{"id":"a","label":"Alpha"}],"edges":[]}"#),
        NormalizeOptions::default(),
    )
    .unwrap();
    let e = apply_delta(&other, &d.delta, ApplyOptions::default()).unwrap_err();
    assert_eq!(e.code, ErrorCode::DeltaBaseMismatch);
    assert_eq!(
        e.message,
        format!(
            "The graph ({}) is not the base of this delta ({})",
            hash_graph(&other),
            d.delta.base_hash().unwrap()
        )
    );

    // Same base hash, but a node is missing: the first op that does not fit is the error.
    let mut delta = d.delta.clone();
    delta.base.insert("hash", hash_graph(&other));
    let e = apply_delta(&other, &delta, ApplyOptions::default()).unwrap_err();
    assert_eq!(e.code, ErrorCode::DeltaConflict);
    assert!(
        e.message.starts_with("Cannot apply op #0 (edge.remove): "),
        "{}",
        e.message
    );
    assert_eq!(e.details.unwrap().get("opIndex"), Some(&Value::Number(0.0)));

    // Leniently, the ops that do not fit are skipped and reported in op order.
    let (_, skipped) = apply_delta(&other, &d.delta, {
        let mut o = ApplyOptions::default();
        o.strict = false;
        o
    })
    .unwrap();
    assert!(!skipped.is_empty());
    assert!(skipped.windows(2).all(|w| w[0].index < w[1].index));
    assert_eq!(skipped[0].reason, "edge not found");
}

#[test]
fn reads_deltas_as_check_delta_does() {
    let reject = |text: &str| Delta::from_value(&json::parse(text).unwrap()).unwrap_err();
    let e = reject(r#"{"format":"kgdiff.diff"}"#);
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            ErrorCode::UnsupportedVersion,
            "Not a kgdiff delta (expected format \"kgdiff.delta\")"
        )
    );
    let e = reject(r#"{"format":"kgdiff.delta","version":2}"#);
    assert_eq!(
        e.message,
        "Unsupported delta version 2; this reader supports version 1"
    );
    let e = reject(r#"{"format":"kgdiff.delta","version":1,"base":{}}"#);
    assert_eq!(
        e.message,
        "delta.base must describe the base graph (with a hash)"
    );
    let e = reject(
        r#"{"format":"kgdiff.delta","version":1,"base":{"hash":"x"},"ops":[{"op":"node.set","id":"a","field":"color","from":"a","to":"b"}]}"#,
    );
    assert_eq!(
        e.message,
        "delta.ops[0] has values that do not fit the field \"color\""
    );
    let e = reject(
        r#"{"format":"kgdiff.delta","version":1,"base":{"hash":"x"},"ops":[{"op":"node.drop"}]}"#,
    );
    assert_eq!(e.message, "delta.ops[0] has an unknown op \"node.drop\"");
    // A missing edge identity is the default, structure.
    let delta = Delta::from_value(
        &json::parse(r#"{"format":"kgdiff.delta","version":1,"base":{"hash":"x"},"ops":[]}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(delta.edge_identity, kgdiff_core::EdgeIdentity::Structure);
}

#[test]
fn a_delta_read_back_writes_the_same_bytes() {
    let d = diff(&graph(BEFORE), &graph(AFTER), &DiffOptions::default()).unwrap();
    let text = json::to_string(&d.delta.to_value());
    let read = Delta::from_value(&json::parse(&text).unwrap()).unwrap();
    assert_eq!(json::to_string(&read.to_value()), text);
    assert_eq!(read, d.delta);
}
