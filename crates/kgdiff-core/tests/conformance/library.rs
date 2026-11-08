//! The library outputs of a case (README, "Library outputs"), computed with kgdiff-core from
//! each side's `expected/parse.<side>.json` graph.

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{
    KGraph, NormalizeOptions, graph_to_json, hash_graph, normalize, resolve_options,
};

use crate::corpus::Case;

pub const SIDES: [&str; 2] = ["before", "after"];

/// A file of the case read with kgdiff-core's own JSON reader.
fn read(case: &Case, relative: &str) -> Result<Value, String> {
    let bytes = case.read_bytes(relative)?;
    let text = String::from_utf8(bytes).map_err(|e| format!("{relative}: {e}"))?;
    json::parse(&text).map_err(|e| format!("{relative}: {e}"))
}

/// The case's `DiffOptions`, as given.
fn options(case: &Case) -> Result<Value, String> {
    let spec = read(case, "case.json")?;
    Ok(spec
        .get("options")
        .cloned()
        .unwrap_or_else(|| Value::Object(Object::new())))
}

/// Both sides normalized as `diff` normalizes them: with the resolved edge identity.
pub fn graphs(case: &Case) -> Result<[KGraph; 2], String> {
    let options = resolve_options(Some(&options(case)?)).map_err(|e| e.message)?;
    let normalized = |side: &str| -> Result<KGraph, String> {
        let parsed = read(case, &format!("expected/parse.{side}.json"))?;
        let graph = parsed.get("graph").ok_or("parse result without a graph")?;
        let options = NormalizeOptions {
            edge_identity: options.edge_identity,
            ..NormalizeOptions::default()
        };
        normalize(graph, options)
            .map_err(|e| format!("normalize({side}): {} {}", e.code, e.message))
    };
    Ok([normalized("before")?, normalized("after")?])
}

fn line(value: &Value) -> Vec<u8> {
    let mut text = json::to_string(value);
    text.push('\n');
    text.into_bytes()
}

pub fn graph_before(case: &Case) -> Result<Vec<u8>, String> {
    let [before, _] = graphs(case)?;
    Ok(line(&graph_to_json(&before)))
}

pub fn graph_after(case: &Case) -> Result<Vec<u8>, String> {
    let [_, after] = graphs(case)?;
    Ok(line(&graph_to_json(&after)))
}

pub fn issues(case: &Case) -> Result<Vec<u8>, String> {
    let graphs = graphs(case)?;
    let mut out = Object::new();
    for (side, graph) in SIDES.iter().zip(&graphs) {
        out.insert(
            *side,
            Value::Array(graph.issues.iter().map(|issue| issue.to_value()).collect()),
        );
    }
    Ok(line(&Value::Object(out)))
}

pub fn hashes(case: &Case) -> Result<Vec<u8>, String> {
    let graphs = graphs(case)?;
    let mut out = Object::new();
    for (side, graph) in SIDES.iter().zip(&graphs) {
        out.insert(*side, hash_graph(graph));
    }
    Ok(line(&Value::Object(out)))
}
