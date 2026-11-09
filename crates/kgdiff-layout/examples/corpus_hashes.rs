//! Prints the SHA-256 of the layout document of every conformance corpus case, and of a few
//! larger layouts, one `<name> <hash>` line each: the `targets` CI job runs it on x86-64 Linux,
//! AArch64 macOS, x86-64 Windows and in WebAssembly (WASI) under Node, and requires the outputs
//! to be equal (RFC 0002, §3 rule 6: layouts are identical on every target).
//!
//! ```sh
//! cargo run --release -p kgdiff-layout --example corpus_hashes -- conformance
//! cargo build --release -p kgdiff-layout --example corpus_hashes --target wasm32-wasip1
//! node crates/kgdiff-layout/scripts/run-wasi.mjs \
//!   target/wasm32-wasip1/release/examples/corpus_hashes.wasm conformance
//! ```

#[path = "../tests/support/mod.rs"]
mod support;

use std::fmt::Write as _;
use std::process::ExitCode;

use kgdiff_core::js::{JsStr, Object, Value, json};
use kgdiff_core::resolve_options;
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, extend_layout, layout_diff, layout_to_json,
};
use sha2::{Digest, Sha256};

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

fn hash(layout: &LayoutResult) -> String {
    let digest = Sha256::digest(json::to_string(&layout_to_json(layout)).as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        write!(out, "{byte:02x}").unwrap();
    }
    out
}

fn line(out: &mut String, name: &str, layout: &LayoutResult) {
    writeln!(out, "{name} {}", hash(layout)).unwrap();
}

/// A changes-only layout and the same layout with its hidden neighbours added back.
fn extended(diff: &kgdiff_core::DiffResult) -> Result<(LayoutResult, LayoutResult), String> {
    let options = LayoutOptions {
        scope: Some(LayoutScope::Changes),
        ..LayoutOptions::default()
    };
    let focused = layout_diff(diff, &options).map_err(|e| e.message)?;
    let mut expand: Vec<JsStr> = Vec::new();
    for id in focused.hidden.keys() {
        for e in diff.edges_of(id) {
            for v in [&e.source, &e.target] {
                if !focused.positions.contains_key(v.as_str()) && !expand.contains(v) {
                    expand.push(v.clone());
                }
            }
        }
    }
    let grown =
        extend_layout(diff, &focused, &expand, &LayoutOptions::default()).map_err(|e| e.message)?;
    Ok((focused, grown))
}

fn run() -> Result<String, String> {
    let root = std::env::args()
        .nth(1)
        .ok_or("usage: corpus_hashes <conformance directory>")?;
    let manifest = read(&format!("{root}/manifest.json"))?;
    let cases = manifest
        .get("cases")
        .and_then(Value::as_array)
        .ok_or("manifest.json: no cases")?;
    let mut out = String::new();
    for entry in cases {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or("a case without an id")?;
        let dir = format!("{root}/cases/{id}");
        let spec = read(&format!("{dir}/case.json"))?;
        let graph = |side: &str| -> Result<Value, String> {
            read(&format!("{dir}/expected/parse.{side}.json"))?
                .get("graph")
                .cloned()
                .ok_or_else(|| format!("{id}: no {side} graph"))
        };
        let options = resolve_options(Some(&member(&spec, "options"))).map_err(|e| e.message)?;
        let diff = kgdiff_core::diff(&graph("before")?, &graph("after")?, &options)
            .map_err(|e| format!("{id}: {}", e.message))?;
        let layout_options =
            LayoutOptions::from_value(&member(&spec, "layoutOptions")).map_err(|e| e.message)?;
        let layout = layout_diff(&diff, &layout_options).map_err(|e| e.message)?;
        line(&mut out, id, &layout);
        let (focused, grown) = extended(&diff)?;
        line(&mut out, &format!("{id}/changes"), &focused);
        line(&mut out, &format!("{id}/extended"), &grown);
    }
    // Larger graphs, through every force and both packers.
    let all = LayoutOptions {
        scope: Some(LayoutScope::All),
        ..LayoutOptions::default()
    };
    for (name, spec) in [
        (
            "synthetic/tree-2k",
            support::tree(2000, 7, support::english_label),
        ),
        (
            "synthetic/scale-free-2k",
            support::scale_free(2000, 1.3, 11),
        ),
        ("synthetic/components", support::components(30, 40, 3)),
        ("synthetic/changes", support::changes(17)),
        ("synthetic/dense-10k", support::scale_free(10_000, 2.0, 11)),
    ] {
        let diff = spec.diff();
        line(
            &mut out,
            name,
            &layout_diff(&diff, &all).map_err(|e| e.message)?,
        );
        let (focused, grown) = extended(&diff)?;
        line(&mut out, &format!("{name}/changes"), &focused);
        line(&mut out, &format!("{name}/extended"), &grown);
    }
    Ok(out)
}

fn main() -> ExitCode {
    match run() {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
