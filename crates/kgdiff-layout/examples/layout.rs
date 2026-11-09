//! Lays out a diff and prints the `kgdiff.layout` document.
//!
//! ```sh
//! # A kgdiff.diff document (kgdiff --json), with optional LayoutOptions as JSON:
//! cargo run --release -p kgdiff-layout --example layout -- diff.json [options.json]
//! # Two graphs diffed here first: { "before", "after", "options"?, "layoutOptions"? }
//! cargo run --release -p kgdiff-layout --example layout -- --job job.json
//! ```
//!
//! `crates/kgdiff-layout/scripts/quality.ts` compares what this writes with the TypeScript
//! layout of the same diff.

use std::process::ExitCode;

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{DiffResult, diff_from_json, resolve_options};
use kgdiff_layout::{LayoutOptions, layout_diff, layout_to_json};

fn read(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    json::parse(&text).map_err(|e| format!("{path}: {e}"))
}

fn member(object: &Value, name: &str) -> Value {
    object
        .get(name)
        .cloned()
        .unwrap_or_else(|| Value::Object(Object::new()))
}

fn run() -> Result<String, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (diff, options): (DiffResult, Value) = match args.as_slice() {
        [flag, job] if flag == "--job" => {
            let job = read(job)?;
            let options = resolve_options(Some(&member(&job, "options"))).map_err(|e| e.message)?;
            let diff = kgdiff_core::diff(&member(&job, "before"), &member(&job, "after"), &options)
                .map_err(|e| e.message)?;
            (diff, member(&job, "layoutOptions"))
        }
        [diff] => (
            diff_from_json(&read(diff)?).map_err(|e| e.message)?,
            Value::Object(Object::new()),
        ),
        [diff, options] => (
            diff_from_json(&read(diff)?).map_err(|e| e.message)?,
            read(options)?,
        ),
        _ => {
            return Err(
                "usage: layout <diff.json> [options.json] | layout --job <job.json>".to_owned(),
            );
        }
    };
    let options = LayoutOptions::from_value(&options).map_err(|e| e.message)?;
    let layout = layout_diff(&diff, &options).map_err(|e| e.message)?;
    Ok(json::to_string(&layout_to_json(&layout)))
}

fn main() -> ExitCode {
    match run() {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
