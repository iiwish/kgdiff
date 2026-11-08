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

/// A case's diff, or why it could not be computed.
type Diffed = Result<std::rc::Rc<kgdiff_core::DiffResult>, String>;

thread_local! {
    /// The diff of the case checked last: every part of a case is checked in a row.
    static LAST: std::cell::RefCell<Option<(String, Diffed)>> = const { std::cell::RefCell::new(None) };
}

/// `diff(parse.before.graph, parse.after.graph, options)`, computed once per case.
pub fn diffed(case: &Case) -> Diffed {
    LAST.with(|last| {
        let mut last = last.borrow_mut();
        if let Some((id, result)) = last.as_ref()
            && *id == case.id
        {
            return result.clone();
        }
        let result = (|| {
            let options = resolve_options(Some(&options(case)?)).map_err(|e| e.message)?;
            let side = |side: &str| -> Result<Value, String> {
                let parsed = read(case, &format!("expected/parse.{side}.json"))?;
                parsed
                    .get("graph")
                    .cloned()
                    .ok_or_else(|| "parse result without a graph".to_owned())
            };
            let result = kgdiff_core::diff(&side("before")?, &side("after")?, &options)
                .map_err(|e| format!("diff: {} {}", e.code, e.message))?;
            Ok(std::rc::Rc::new(result))
        })();
        *last = Some((case.id.clone(), result.clone()));
        result
    })
}

pub fn diff(case: &Case) -> Result<Vec<u8>, String> {
    Ok(line(&kgdiff_core::diff_to_json(&*diffed(case)?)))
}

pub fn delta(case: &Case) -> Result<Vec<u8>, String> {
    Ok(line(&diffed(case)?.delta.to_value()))
}

pub fn titles(case: &Case) -> Result<Vec<u8>, String> {
    let result = diffed(case)?;
    let mut out = Object::new();
    for locale in [kgdiff_core::Locale::En, kgdiff_core::Locale::ZhCn] {
        let mut list = Vec::new();
        for hunk in &result.hunks {
            let (title, subtitle) =
                kgdiff_core::format_hunk(hunk, &result, locale).map_err(|e| e.message)?;
            let mut entry = Object::new();
            entry.insert("id", &hunk.id);
            entry.insert("title", title);
            entry.insert("subtitle", subtitle);
            list.push(Value::Object(entry));
        }
        out.insert(locale.as_str(), Value::Array(list));
    }
    Ok(line(&Value::Object(out)))
}
