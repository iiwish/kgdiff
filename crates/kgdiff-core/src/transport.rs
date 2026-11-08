//! The lossless, deterministic JSON transport of a diff (`json.ts`, `kgdiff.diff` version 1).

use crate::canonical::attrs_equal;
use crate::graph_json::{edge_to_json, node_content_equals, node_to_json};
use crate::js::{Object, Value};
use crate::model::{KGEdge, UnionEdge, UnionNode};
use crate::pipeline::DiffResult;

fn same_edge(a: &KGEdge, b: &KGEdge) -> bool {
    a.source == b.source
        && a.target == b.target
        && a.predicate == b.predicate
        && a.label == b.label
        && a.id == b.id
        && attrs_equal(&a.attrs, &b.attrs, None)
}

/// A union node as `diffToJSON` writes it: the before snapshot only when it differs from after.
pub fn union_node_to_json(n: &UnionNode) -> Value {
    let mut out = Object::new();
    out.insert("id", &n.id);
    if let Some(id) = &n.before_id {
        out.insert("beforeId", id);
    }
    if let Some(id) = &n.after_id {
        out.insert("afterId", id);
    }
    if let Some(before) = &n.before {
        let same = n.after.as_ref().is_some_and(|after| {
            before.implicit == after.implicit && node_content_equals(before, after)
        });
        if !same {
            out.insert("before", node_to_json(before, None));
        }
    }
    if let Some(after) = &n.after {
        out.insert("after", node_to_json(after, None));
    }
    out.insert("status", n.status.as_str());
    if !n.facets.is_empty() {
        out.insert(
            "facets",
            Value::Array(n.facets.iter().map(|f| f.to_value()).collect()),
        );
    }
    if let Some(hunk) = &n.hunk {
        out.insert("hunk", hunk);
    }
    Value::Object(out)
}

/// A union edge as `diffToJSON` writes it.
pub fn union_edge_to_json(e: &UnionEdge) -> Value {
    let mut out = Object::new();
    out.insert("id", &e.id);
    out.insert("source", &e.source);
    out.insert("target", &e.target);
    if let Some(v) = &e.source_before {
        out.insert("sourceBefore", v);
    }
    if let Some(v) = &e.target_before {
        out.insert("targetBefore", v);
    }
    if let Some(v) = &e.predicate_before {
        out.insert("predicateBefore", v);
    }
    if let Some(before) = &e.before
        && !e
            .after
            .as_ref()
            .is_some_and(|after| same_edge(before, after))
    {
        out.insert("before", edge_to_json(before, None, None));
    }
    if let Some(after) = &e.after {
        out.insert("after", edge_to_json(after, None, None));
    }
    out.insert("status", e.status.as_str());
    if !e.facets.is_empty() {
        out.insert(
            "facets",
            Value::Array(e.facets.iter().map(|f| f.to_value()).collect()),
        );
    }
    if let Some(hunk) = &e.hunk {
        out.insert("hunk", hunk);
    }
    Value::Object(out)
}

/// Lossless, deterministic serialization of a diff (`diffToJSON`): the same diff always
/// produces the same bytes under `js::json::to_string`.
pub fn diff_to_json(result: &DiffResult) -> Value {
    let mut meta = Object::new();
    meta.insert("before", result.before.meta.clone());
    meta.insert("after", result.after.meta.clone());
    let mut out = Object::new();
    out.insert("format", "kgdiff.diff");
    out.insert("version", 1.0);
    out.insert("meta", meta);
    out.insert("options", result.options.to_value());
    out.insert(
        "nodes",
        Value::Array(result.nodes.iter().map(union_node_to_json).collect()),
    );
    out.insert(
        "edges",
        Value::Array(result.edges.iter().map(union_edge_to_json).collect()),
    );
    out.insert(
        "hunks",
        Value::Array(result.hunks.iter().map(|h| h.to_value()).collect()),
    );
    out.insert(
        "matches",
        Value::Array(result.matches.iter().map(|m| m.to_value()).collect()),
    );
    out.insert(
        "suggestions",
        Value::Array(result.suggestions.iter().map(|s| s.to_value()).collect()),
    );
    out.insert("delta", result.delta.to_value());
    out.insert("stats", result.stats.to_value());
    Value::Object(out)
}
