//! The Rust half of the differential run of RFC 0002 (§8): recomputes every pair that
//! `scripts/differential.ts` wrote and compares the outputs with TypeScript's, byte for byte.
//!
//! ```sh
//! pnpm tsx scripts/differential.ts --pairs 1000 --seed 1 --out target/differential.jsonl
//! KGDIFF_DIFFERENTIAL=target/differential.jsonl cargo test -p kgdiff-core --release --test differential
//! ```
//!
//! Without `KGDIFF_DIFFERENTIAL` the test has nothing to compare and passes.

use std::io::{BufRead, BufReader};

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{
    ApplyOptions, DiffResult, Locale, apply_delta, diff, diff_from_json, diff_to_json, format_hunk,
    graph_to_json, hash_graph, invert_delta, pack_diff_json, resolve_options,
};

/// The outputs of the port, by the names `scripts/differential.ts` gives them (`diff` twice: as
/// computed, and read back with `diff_from_json`).
fn outputs(result: &DiffResult) -> Result<Vec<(&'static str, String)>, String> {
    let sides = |f: &dyn Fn(&kgdiff_core::KGraph) -> Value| {
        let mut out = Object::new();
        out.insert("before", f(&result.before));
        out.insert("after", f(&result.after));
        json::to_string(&Value::Object(out))
    };
    let mut titles = Object::new();
    for locale in [Locale::En, Locale::ZhCn] {
        let mut list = Vec::new();
        for hunk in &result.hunks {
            let (title, subtitle) = format_hunk(hunk, result, locale).map_err(|e| e.message)?;
            let mut entry = Object::new();
            entry.insert("id", &hunk.id);
            entry.insert("title", title);
            entry.insert("subtitle", subtitle);
            list.push(Value::Object(entry));
        }
        titles.insert(locale.as_str(), Value::Array(list));
    }
    Ok(vec![
        (
            "graph.before",
            json::to_string(&graph_to_json(&result.before)),
        ),
        (
            "graph.after",
            json::to_string(&graph_to_json(&result.after)),
        ),
        (
            "issues",
            sides(&|g| Value::Array(g.issues().iter().map(|i| i.to_value()).collect())),
        ),
        ("hashes", sides(&|g| Value::from(hash_graph(g)))),
        ("diff", json::to_string(&diff_to_json(result))),
        ("titles", json::to_string(&Value::Object(titles))),
        ("delta", json::to_string(&result.delta.to_value())),
        (
            "packed",
            json::to_string(&pack_diff_json(&diff_to_json(result))),
        ),
        (
            "inverse",
            json::to_string(&invert_delta(&result.delta).to_value()),
        ),
        ("applied", {
            let (applied, _) = apply_delta(&result.before, &result.delta, ApplyOptions::default())
                .map_err(|e| format!("apply_delta: {} {}", e.code, e.message))?;
            json::to_string(&graph_to_json(&applied))
        }),
        ("diff", {
            // diff_from_json(diff_to_json(d)) round-trips: compared with TypeScript's diff again.
            let text = json::to_string(&diff_to_json(result));
            let back = diff_from_json(&json::parse(&text).map_err(|e| e.to_string())?)
                .map_err(|e| format!("diff_from_json: {} {}", e.code, e.message))?;
            json::to_string(&diff_to_json(&back))
        }),
    ])
}

/// Where two texts first differ, with some context.
fn first_difference(actual: &str, expected: &str) -> String {
    let at = actual
        .bytes()
        .zip(expected.bytes())
        .take_while(|(a, e)| a == e)
        .count();
    let around = |s: &str| {
        let start = (at.saturating_sub(60)..=at)
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(0);
        let end = (at + 60..=s.len())
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(s.len())
            .min(s.len());
        s.get(start..end).unwrap_or("").to_owned()
    };
    format!(
        "at byte {at}:\n      rust: …{}…\n      ts:   …{}…",
        around(actual),
        around(expected)
    )
}

#[test]
fn rust_and_typescript_agree_on_random_pairs() {
    let Ok(path) = std::env::var("KGDIFF_DIFFERENTIAL") else {
        eprintln!(
            "KGDIFF_DIFFERENTIAL is not set: nothing to compare (see scripts/differential.ts)"
        );
        return;
    };
    let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let (mut pairs, mut compared) = (0usize, 0usize);
    let mut failures: Vec<String> = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.unwrap_or_else(|e| panic!("{path}: {e}"));
        if line.is_empty() {
            continue;
        }
        pairs += 1;
        let record = json::parse(&line).unwrap_or_else(|e| panic!("{path}, line {pairs}: {e}"));
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_owned();
        let options = match resolve_options(record.get("options")) {
            Ok(options) => options,
            Err(e) => {
                failures.push(format!("{name}: options: {}", e.message));
                continue;
            }
        };
        let (Some(before), Some(after), Some(expected)) = (
            record.get("before"),
            record.get("after"),
            record.get("outputs").and_then(Value::as_object),
        ) else {
            failures.push(format!("{name}: not a differential record"));
            continue;
        };
        let result = match diff(before, after, &options) {
            Ok(result) => result,
            Err(e) => {
                failures.push(format!("{name}: diff failed: {} {}", e.code, e.message));
                continue;
            }
        };
        match outputs(&result) {
            Err(e) => failures.push(format!("{name}: {e}")),
            Ok(actual) => {
                for (part, text) in actual {
                    let Some(want) = expected.get(part).and_then(Value::as_str) else {
                        continue;
                    };
                    compared += 1;
                    if text != want {
                        failures.push(format!(
                            "{name} {part} differs {}",
                            first_difference(&text, want)
                        ));
                    }
                }
            }
        }
    }
    eprintln!(
        "differential: {pairs} pairs, {compared} outputs compared, {} mismatches",
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "{} mismatches:\n  {}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n  ")
    );
}
