//! The packed transport of a diff (`packed.ts`, `kgdiff.diff.packed` version 1): unchanged
//! elements as tables of indices into one string table, the rest as it is. Lossless:
//! `unpack_diff_json(pack_diff_json(j))` is `j` for what `diff_to_json` writes.

use crate::canonical::triple_key;
use crate::error::{ErrorCode, KgdiffError, Result};
use crate::js::{JsStr, Lookup, Object, Value};
use crate::util::{count_to_f64, f64_to_count};

/// `Object.keys(value).join(',')`.
fn keys_of(value: &Object) -> String {
    value
        .keys()
        .map(JsStr::as_str)
        .collect::<Vec<_>>()
        .join(",")
}

fn id_of(value: &Value) -> Option<&JsStr> {
    value.get("id").and_then(Value::as_js_str)
}

fn sorted_by_id(list: &[Value]) -> bool {
    list.windows(2)
        .all(|w| matches!((id_of(&w[0]), id_of(&w[1])), (Some(a), Some(b)) if a < b))
}

fn text<'a>(o: &'a Object, key: &str) -> Option<&'a JsStr> {
    o.get(key).and_then(Value::as_js_str)
}

/// An unchanged node that unpacks from its id and its after snapshot alone (`packableNode`).
fn packable_node(n: &Object) -> bool {
    let id = text(n, "id");
    n.get("status").and_then(Value::as_str) == Some("unchanged")
        && id.is_some()
        && text(n, "beforeId") == id
        && text(n, "afterId") == id
        && keys_of(n) == "id,beforeId,afterId,after,status"
        && matches!(n.get("after"), Some(Value::Object(after)) if text(after, "id") == id && after.keys().next().is_some_and(|k| k == "id"))
}

/// An unchanged edge that unpacks from its triple alone (`packableEdge`).
fn packable_edge(e: &Object) -> bool {
    if e.get("status").and_then(Value::as_str) != Some("unchanged")
        || keys_of(e) != "id,source,target,after,status"
    {
        return false;
    }
    let Some(Value::Object(a)) = e.get("after") else {
        return false;
    };
    let (Some(source), Some(target)) = (text(e, "source"), text(e, "target")) else {
        return false;
    };
    if text(a, "source") != Some(source) || text(a, "target") != Some(target) {
        return false;
    }
    let keys = keys_of(a);
    let predicate = a.get("predicate");
    if keys != "source,target"
        && !(keys == "source,target,predicate"
            && predicate
                .and_then(Value::as_str)
                .is_none_or(|p| !p.is_empty()))
    {
        return false;
    }
    if predicate.is_some_and(|p| p.as_str().is_none()) {
        return false;
    }
    let predicate = predicate.and_then(Value::as_str).unwrap_or("");
    text(e, "id").is_some_and(|id| *id == triple_key(source, predicate, target))
}

/// Packs the unchanged elements of a diff document into string-indexed tables
/// (`packDiffJSON`). Deterministic.
pub fn pack_diff_json(json: &Value) -> Value {
    let empty = Object::new();
    let doc = json.as_object().unwrap_or(&empty);
    let list = |key: &str| doc.get(key).and_then(Value::as_array).unwrap_or(&[]);
    let (all_nodes, all_edges) = (list("nodes"), list("edges"));
    let pack = sorted_by_id(all_nodes) && sorted_by_id(all_edges);
    let mut strings: Vec<Value> = Vec::new();
    let mut at: Lookup<JsStr, usize> = Lookup::new();
    let mut reference = |s: &JsStr| -> Value {
        let i = *at.get_or_insert_with(s.clone(), || {
            strings.push(Value::from(s));
            strings.len() - 1
        });
        Value::from(i)
    };
    let mut unchanged_nodes = Vec::new();
    let mut nodes = Vec::new();
    for n in all_nodes {
        match n.as_object() {
            Some(o) if pack && packable_node(o) => {
                let after = o.get("after").and_then(Value::as_object).unwrap_or(&empty);
                let snapshot: Object = after
                    .iter()
                    .filter(|(k, _)| *k != "id")
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                unchanged_nodes.push(reference(text(o, "id").unwrap_or(&JsStr::default())));
                unchanged_nodes.push(if snapshot.is_empty() {
                    Value::Number(0.0)
                } else {
                    Value::Object(snapshot)
                });
            }
            _ => nodes.push(n.clone()),
        }
    }
    let mut unchanged_edges = Vec::new();
    let mut edges = Vec::new();
    for e in all_edges {
        match e.as_object() {
            Some(o) if pack && packable_edge(o) => {
                let after = o.get("after").and_then(Value::as_object).unwrap_or(&empty);
                let none = JsStr::default();
                unchanged_edges.push(reference(text(o, "source").unwrap_or(&none)));
                unchanged_edges.push(reference(text(after, "predicate").unwrap_or(&none)));
                unchanged_edges.push(reference(text(o, "target").unwrap_or(&none)));
            }
            _ => edges.push(e.clone()),
        }
    }
    let mut out = Object::new();
    out.insert("format", "kgdiff.diff.packed");
    out.insert("version", 1.0);
    for key in ["meta", "options"] {
        if let Some(v) = doc.get(key) {
            out.insert(key, v.clone());
        }
    }
    out.insert("strings", Value::Array(strings));
    out.insert("unchangedNodes", Value::Array(unchanged_nodes));
    out.insert("unchangedEdges", Value::Array(unchanged_edges));
    out.insert("nodes", Value::Array(nodes));
    out.insert("edges", Value::Array(edges));
    for key in ["hunks", "matches", "suggestions", "delta", "stats"] {
        if let Some(v) = doc.get(key) {
            out.insert(key, v.clone());
        }
    }
    Value::Object(out)
}

fn invalid(message: &str) -> KgdiffError {
    KgdiffError::invalid_input(format!("Packed diff: {message}"))
}

/// Merges two lists sorted by id.
fn merge(a: Vec<Value>, b: &[Value]) -> Vec<Value> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let a_first = matches!((id_of(&a[i]), id_of(&b[j])), (Some(x), Some(y)) if x < y);
        if a_first {
            out.push(a[i].clone());
            i += 1;
        } else {
            out.push(b[j].clone());
            j += 1;
        }
    }
    out.extend(a[i..].iter().cloned());
    out.extend(b[j..].iter().cloned());
    out
}

/// The diff document a packed diff was made from (`unpackDiffJSON`). The tables are validated
/// here; the diff itself when read (`diff_from_json`).
///
/// # Errors
///
/// `unsupported-version` for another format or version, `invalid-input` for malformed tables.
pub fn unpack_diff_json(packed: &Value) -> Result<Value> {
    let doc = packed
        .as_object()
        .filter(|o| o.get("format").and_then(Value::as_str) == Some("kgdiff.diff.packed"));
    let Some(doc) = doc else {
        return Err(KgdiffError::new(
            ErrorCode::UnsupportedVersion,
            "Not a packed kgdiff diff (expected format \"kgdiff.diff.packed\")",
        ));
    };
    let version = doc.get("version");
    if version != Some(&Value::Number(1.0)) {
        let mut details = Object::new();
        if let Some(v) = version {
            details.insert("version", v.clone());
        }
        let shown = version.map_or_else(|| "undefined".to_owned(), Value::to_js_string);
        return Err(KgdiffError::new(
            ErrorCode::UnsupportedVersion,
            format!("Unsupported packed diff version {shown}; this reader supports version 1"),
        )
        .with_details(details));
    }
    let strings: Vec<&JsStr> = match doc.get("strings") {
        Some(Value::Array(items)) if items.iter().all(|s| s.as_str().is_some()) => {
            items.iter().filter_map(Value::as_js_str).collect()
        }
        _ => return Err(invalid("strings must be a list of strings")),
    };
    let unchanged_nodes = match doc.get("unchangedNodes") {
        Some(Value::Array(items)) if items.len() % 2 == 0 => items,
        _ => {
            return Err(invalid(
                "unchangedNodes must be a list of (id, snapshot) pairs",
            ));
        }
    };
    let unchanged_edges = match doc.get("unchangedEdges") {
        Some(Value::Array(items)) if items.len() % 3 == 0 => items,
        _ => {
            return Err(invalid(
                "unchangedEdges must be a list of (source, predicate, target) triples",
            ));
        }
    };
    let (Some(Value::Array(packed_nodes)), Some(Value::Array(packed_edges))) =
        (doc.get("nodes"), doc.get("edges"))
    else {
        return Err(invalid("nodes and edges must be lists"));
    };
    let str_at = |v: &Value, where_: String| -> Result<JsStr> {
        match v {
            Value::Number(x)
                if x.fract() == 0.0 && *x >= 0.0 && *x < count_to_f64(strings.len()) =>
            {
                Ok(strings[f64_to_count(*x)].clone())
            }
            _ => Err(invalid(&format!("{where_} is not an index into strings"))),
        }
    };
    let mut nodes = Vec::with_capacity(unchanged_nodes.len() / 2);
    for k in (0..unchanged_nodes.len()).step_by(2) {
        let id = str_at(&unchanged_nodes[k], format!("unchangedNodes[{k}]"))?;
        let snapshot = &unchanged_nodes[k + 1];
        let mut after = Object::new();
        after.insert("id", &id);
        match snapshot {
            Value::Number(x) if *x == 0.0 => {}
            Value::Object(o) if !o.contains_key("id") => {
                for (key, v) in o {
                    after.insert(key.clone(), v.clone());
                }
            }
            _ => {
                return Err(invalid(&format!(
                    "unchangedNodes[{}] is not a snapshot without an id",
                    k + 1
                )));
            }
        }
        let mut node = Object::new();
        node.insert("id", &id);
        node.insert("beforeId", &id);
        node.insert("afterId", &id);
        node.insert("after", after);
        node.insert("status", "unchanged");
        nodes.push(Value::Object(node));
    }
    let mut edges = Vec::with_capacity(unchanged_edges.len() / 3);
    for k in (0..unchanged_edges.len()).step_by(3) {
        let source = str_at(&unchanged_edges[k], format!("unchangedEdges[{k}]"))?;
        let predicate = str_at(
            &unchanged_edges[k + 1],
            format!("unchangedEdges[{}]", k + 1),
        )?;
        let target = str_at(
            &unchanged_edges[k + 2],
            format!("unchangedEdges[{}]", k + 2),
        )?;
        let mut after = Object::new();
        after.insert("source", &source);
        after.insert("target", &target);
        if !predicate.is_empty() {
            after.insert("predicate", &predicate);
        }
        let mut edge = Object::new();
        edge.insert("id", triple_key(&source, &predicate, &target));
        edge.insert("source", &source);
        edge.insert("target", &target);
        edge.insert("after", after);
        edge.insert("status", "unchanged");
        edges.push(Value::Object(edge));
    }
    let mut out = Object::new();
    out.insert("format", "kgdiff.diff");
    out.insert("version", 1.0);
    for key in ["meta", "options"] {
        if let Some(v) = doc.get(key) {
            out.insert(key, v.clone());
        }
    }
    out.insert("nodes", Value::Array(merge(nodes, packed_nodes)));
    out.insert("edges", Value::Array(merge(edges, packed_edges)));
    for key in ["hunks", "matches", "suggestions", "delta", "stats"] {
        if let Some(v) = doc.get(key) {
            out.insert(key, v.clone());
        }
    }
    Ok(Value::Object(out))
}
