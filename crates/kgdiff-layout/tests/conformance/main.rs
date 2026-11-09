//! kgdiff-layout against the conformance corpus (`conformance/README.md`): the layout contract
//! of every case (`expected/layout-contract.json`: strategy, scope, the tick counts of union
//! layouts, the laid-out nodes, radii, `hidden`, component membership and order) and the label
//! widths and radii the scene shares (`primitives/label-width.json`). Positions are not in the
//! corpus (RFC 0002, "Layout decision"); the property tests check them.
//!
//! ```sh
//! cargo test -p kgdiff-layout --test conformance               # everything
//! cargo test -p kgdiff-layout --test conformance -- synthetic  # cases matching
//! ```

// The corpus reader of kgdiff-core's harness, shared so that a change of the corpus format lands
// once. This harness reads only some of what it offers.
#[allow(dead_code, reason = "kgdiff-core's harness uses the rest")]
#[path = "../../../kgdiff-core/tests/conformance/corpus.rs"]
mod corpus;

use std::fmt::Write as _;
use std::process::ExitCode;

use kgdiff_core::js::{self, Object, Value, json};
use kgdiff_core::{DiffResult, resolve_options};
use kgdiff_layout::{
    LayoutOptions, LayoutStrategy, estimate_label_width, layout_diff, node_radius,
};

use corpus::{Case, Corpus, Mode, compare, read_json};

const CONTRACT: &str = "expected/layout-contract.json";
const LABEL_WIDTH: &str = "primitives/label-width.json";

/// A file of the case read with kgdiff-core's JSON reader.
fn read(case: &Case, relative: &str) -> Result<Value, String> {
    let bytes = case.read_bytes(relative)?;
    let text = String::from_utf8(bytes).map_err(|e| format!("{relative}: {e}"))?;
    json::parse(&text).map_err(|e| format!("{relative}: {e}"))
}

fn member(object: &Value, name: &str) -> Value {
    object
        .get(name)
        .cloned()
        .unwrap_or_else(|| Value::Object(Object::new()))
}

/// `diff(parse.before.graph, parse.after.graph, options)` (README, "Library outputs").
fn diffed(case: &Case) -> Result<(DiffResult, Value), String> {
    let spec = read(case, "case.json")?;
    let options = resolve_options(Some(&member(&spec, "options"))).map_err(|e| e.message)?;
    let side = |side: &str| -> Result<Value, String> {
        read(case, &format!("expected/parse.{side}.json"))?
            .get("graph")
            .cloned()
            .ok_or_else(|| "parse result without a graph".to_owned())
    };
    let result = kgdiff_core::diff(&side("before")?, &side("after")?, &options)
        .map_err(|e| format!("diff: {} {}", e.code, e.message))?;
    Ok((result, member(&spec, "layoutOptions")))
}

/// `layout-contract.json` as the corpus generator computes it (`conformance/corpus.ts`), from
/// `layout_diff`: radii rounded to 0.01 as layout documents write them.
fn contract(case: &Case) -> Result<Vec<u8>, String> {
    let (diff, given) = diffed(case)?;
    let options = LayoutOptions::from_value(&given).map_err(|e| e.message)?;
    let layout = layout_diff(&diff, &options).map_err(|e| e.message)?;
    let mut out = Object::new();
    out.insert("options", given);
    out.insert("strategy", layout.stats.strategy.as_str());
    out.insert("scope", layout.scope.as_str());
    if layout.stats.strategy == LayoutStrategy::Union {
        out.insert("iterations", layout.stats.iterations);
    }
    let mut nodes: Vec<&js::JsStr> = layout.positions.keys().collect();
    nodes.sort();
    out.insert(
        "nodes",
        Value::Array(nodes.into_iter().map(Value::from).collect()),
    );
    let mut radii = Object::new();
    for (id, r) in &layout.radii {
        let rounded = js::math::round(r * 100.0) / 100.0;
        radii.insert(id.clone(), rounded);
    }
    out.insert("radii", radii);
    let mut hidden = Object::new();
    for (id, count) in &layout.hidden {
        hidden.insert(id.clone(), *count);
    }
    out.insert("hidden", hidden);
    out.insert(
        "components",
        Value::Array(
            layout
                .components
                .iter()
                .map(|c| Value::Array(c.nodes.iter().map(Value::from).collect()))
                .collect(),
        ),
    );
    let mut text = json::to_string_pretty(&Value::Object(out));
    text.push('\n');
    Ok(text.into_bytes())
}

/// `primitives/label-width.json`: `estimate_label_width` and `node_radius`, bit for bit.
fn label_width(corpus: &Corpus) -> Result<usize, Vec<String>> {
    let vector = read_json(&corpus.root.join(LABEL_WIDTH)).map_err(|e| vec![e])?;
    let mut failures = Vec::new();
    let mut count = 0;
    let rows = |key: &str| vector[key].as_array().cloned().unwrap_or_default();
    for row in rows("labelWidth") {
        count += 1;
        let (text, size, expected) = (row[0].as_str(), row[1].as_f64(), row[2].as_f64());
        let (Some(text), Some(size), Some(expected)) = (text, size, expected) else {
            failures.push(format!("malformed entry {row}"));
            continue;
        };
        let actual = estimate_label_width(text, size);
        if actual.to_bits() != expected.to_bits() {
            failures.push(format!(
                "estimate_label_width({text:?}, {size}) = {actual}, expected {expected}"
            ));
        }
    }
    for row in rows("nodeRadius") {
        count += 1;
        let (Some(degree), Some(expected)) = (row[0].as_f64(), row[1].as_f64()) else {
            failures.push(format!("malformed entry {row}"));
            continue;
        };
        let actual = node_radius(degree);
        if actual.to_bits() != expected.to_bits() {
            failures.push(format!(
                "node_radius({degree}) = {actual}, expected {expected}"
            ));
        }
    }
    if count == 0 {
        failures.push("no entries".to_owned());
    }
    if failures.is_empty() {
        Ok(count)
    } else {
        Err(failures)
    }
}

fn main() -> ExitCode {
    // `cargo test` hands its filter and libtest's flags to every test binary: keep the filters.
    let filters: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();
    let selected = |name: &str| filters.is_empty() || filters.iter().any(|f| name.contains(f));

    let corpus = match Corpus::open() {
        Ok(corpus) => corpus,
        Err(message) => {
            eprintln!("cannot read the conformance corpus: {message}");
            return ExitCode::FAILURE;
        }
    };
    if !corpus.primitives.iter().any(|p| p == LABEL_WIDTH) {
        eprintln!("the manifest does not list {LABEL_WIDTH}");
        return ExitCode::FAILURE;
    }
    let mut out = String::new();
    let mut failures = Vec::new();
    let mut passed = 0;
    writeln!(
        out,
        "kgdiff-layout against the conformance corpus: {} cases\n",
        corpus.cases.len()
    )
    .unwrap();
    for case in &corpus.cases {
        if !selected(&case.id) && !selected("contract") {
            continue;
        }
        let outcome = contract(case).and_then(|actual| {
            let expected = case.read_bytes(CONTRACT)?;
            compare(Mode::Value, &actual, &expected)
        });
        let mark = match outcome {
            Ok(()) => {
                passed += 1;
                "✓"
            }
            Err(message) => {
                failures.push(format!("{} layout-contract: {message}", case.id));
                "✗"
            }
        };
        writeln!(out, "  {mark} {}", case.id).unwrap();
    }
    if selected("label-width") {
        match label_width(&corpus) {
            Ok(entries) => {
                passed += 1;
                writeln!(out, "\n  ✓ label-width.json: {entries} entries").unwrap();
            }
            Err(errors) => {
                writeln!(out, "\n  ✗ label-width.json: {} failures", errors.len()).unwrap();
                failures.extend(
                    errors
                        .into_iter()
                        .take(20)
                        .map(|e| format!("label-width: {e}")),
                );
            }
        }
    }
    if !failures.is_empty() {
        writeln!(out, "\nfailures").unwrap();
        for failure in &failures {
            writeln!(out, "  {failure}").unwrap();
        }
    }
    writeln!(out, "\n{passed} checks pass, {} fail", failures.len()).unwrap();
    print!("{out}");
    if failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
