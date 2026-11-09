//! Reading diff documents: `diff_from_json` and `unpack_diff_json` on every corpus case, and the
//! consistency checks on corrupted documents (ported from `packages/core/test/json.test.ts`).

use std::path::PathBuf;

use kgdiff_core::js::{Value, json};
use kgdiff_core::{
    ErrorCode, diff_from_json, diff_to_json, hash_graph, pack_diff_json, unpack_diff_json,
};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn read(path: &PathBuf) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn case_ids() -> Vec<String> {
    let manifest = json::parse(&read(&corpus().join("manifest.json"))).unwrap();
    manifest
        .get("cases")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|c| c.get("id").and_then(Value::as_str).unwrap().to_owned())
        .collect()
}

fn diff_text(id: &str) -> String {
    read(&corpus().join("cases").join(id).join("expected/diff.json"))
}

#[test]
fn every_corpus_diff_reads_back_to_the_same_bytes() {
    for id in case_ids() {
        let text = diff_text(&id);
        let document = json::parse(&text).unwrap();
        let result =
            diff_from_json(&document).unwrap_or_else(|e| panic!("{id}: {} {}", e.code, e.message));
        assert_eq!(
            format!("{}\n", json::to_string(&diff_to_json(&result))),
            text,
            "{id}"
        );
        let hashes = json::parse(&read(
            &corpus()
                .join("cases")
                .join(&id)
                .join("expected/hashes.json"),
        ))
        .unwrap();
        assert_eq!(
            hashes.get("before").and_then(Value::as_str),
            Some(hash_graph(&result.before)),
            "{id}"
        );
        assert_eq!(
            hashes.get("after").and_then(Value::as_str),
            Some(hash_graph(&result.after)),
            "{id}"
        );
    }
}

#[test]
fn every_corpus_packed_diff_unpacks_to_the_diff() {
    for id in case_ids() {
        let text = diff_text(&id);
        let packed = json::parse(&read(
            &corpus()
                .join("cases")
                .join(&id)
                .join("expected/diff.packed.json"),
        ))
        .unwrap();
        let unpacked = unpack_diff_json(&packed).unwrap_or_else(|e| panic!("{id}: {}", e.message));
        assert_eq!(format!("{}\n", json::to_string(&unpacked)), text, "{id}");
        assert_eq!(
            json::to_string(&pack_diff_json(&json::parse(&text).unwrap())),
            json::to_string(&packed),
            "{id}"
        );
    }
}

/// A corpus diff with one edit applied to its JSON.
fn corrupted(id: &str, edit: impl FnOnce(&mut kgdiff_core::js::Object)) -> Value {
    let Value::Object(mut doc) = json::parse(&diff_text(id)).unwrap() else {
        panic!("not an object")
    };
    edit(&mut doc);
    Value::Object(doc)
}

fn message(value: &Value) -> (ErrorCode, String) {
    let e = diff_from_json(value).expect_err("the document should be rejected");
    (e.code, e.message)
}

fn object(v: &mut Value) -> &mut kgdiff_core::js::Object {
    match v {
        Value::Object(o) => o,
        _ => panic!("not an object"),
    }
}

#[test]
fn rejects_other_formats_and_versions() {
    let (code, text) = message(&json::parse(r#"{"format":"kgdiff.delta","version":1}"#).unwrap());
    assert_eq!(
        (code, text.as_str()),
        (
            ErrorCode::UnsupportedVersion,
            "Not a kgdiff diff (expected format \"kgdiff.diff\")"
        )
    );
    let (code, text) = message(&corrupted("self-loops", |d| {
        d.insert("version", 2.0);
    }));
    assert_eq!(
        (code, text.as_str()),
        (
            ErrorCode::UnsupportedVersion,
            "Unsupported diff version 2; this reader supports version 1"
        )
    );
}

/// An edit of a diff document.
type Edit = Box<dyn FnOnce(&mut kgdiff_core::js::Object)>;

#[test]
fn reports_the_first_contradiction() {
    let cases: Vec<(Edit, &str)> = vec![
        (
            Box::new(|d| {
                d.remove("stats");
            }),
            "A kgdiff diff needs stats",
        ),
        (
            Box::new(|d| {
                let stats = object(d.get_mut("stats").unwrap());
                object(stats.get_mut("nodes").unwrap()).insert("added", 99.0);
            }),
            "diff.stats do not match the union elements and hunks",
        ),
        (
            Box::new(|d| {
                let delta = object(d.get_mut("delta").unwrap());
                object(delta.get_mut("base").unwrap()).insert("hash", "c53:00000000000000");
            }),
            "delta.base is another graph (hash c53:00000000000000) than the before graph of the diff",
        ),
        (
            Box::new(|d| {
                let Some(Value::Array(hunks)) = d.get_mut("hunks") else {
                    panic!()
                };
                object(&mut hunks[0]).insert("order", 5.0);
            }),
            "has order 5 but is listed at 0",
        ),
        (
            Box::new(|d| {
                let Some(Value::Array(nodes)) = d.get_mut("nodes") else {
                    panic!()
                };
                let changed = nodes
                    .iter_mut()
                    .find(|n| n.get("status").and_then(Value::as_str) == Some("modified"))
                    .unwrap();
                object(changed).remove("hunk");
            }),
            "is modified but belongs to no hunk",
        ),
        (
            Box::new(|d| {
                let Some(Value::Array(nodes)) = d.get_mut("nodes") else {
                    panic!()
                };
                let first = nodes[0].clone();
                nodes.push(first);
            }),
            "is used more than once",
        ),
    ];
    for (edit, expected) in cases {
        let (code, text) = message(&corrupted("self-loops", edit));
        assert_eq!(code, ErrorCode::InvalidInput, "{text}");
        assert!(
            text.contains(expected),
            "{text:?} should contain {expected:?}"
        );
    }
}
