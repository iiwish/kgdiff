//! The text outputs of the corpus's CLI runs (`conformance/README.md`, "CLI runs"): every summary,
//! `--stat`, `--name-status` and `--markdown` run whose stdout is recorded, rendered from the
//! case's inputs and options and compared byte for byte, and `report.json`, the payload's
//! format, version, meta and view; every case's payload also validates against
//! `packages/core/schema/report.v1.json`. Only what these runs need of the CLI is reproduced
//! here: the text flags, the width from `COLUMNS`, the default title; kgdiff's own binary runs
//! all of them.

#[path = "support/schema.rs"]
mod schema;

use std::io::Read;
use std::path::{Path, PathBuf};

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{DiffResult, Locale};
use kgdiff_formats::{FormatId, ParseOptions, ParseResult, RdfOptions, parse_graph};
use kgdiff_report::{
    MarkdownOptions, Painter, ReportInfo, ReportSide, TextContext, render_markdown,
    render_name_status, render_stat, render_summary,
};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn read_json(path: &Path) -> Value {
    json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn decode(bytes: &[u8]) -> String {
    let bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut out)
            .unwrap();
        out
    } else {
        bytes.to_vec()
    };
    let utf16 = |le: bool| {
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16(&units).unwrap()
    };
    if bytes.starts_with(&[0xff, 0xfe]) {
        utf16(true)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        utf16(false)
    } else {
        let text = String::from_utf8(bytes).unwrap();
        text.strip_prefix('\u{feff}')
            .map(str::to_owned)
            .unwrap_or(text)
    }
}

fn parse_side(dir: &Path, spec: &Value, side: &str) -> ParseResult {
    let input = spec
        .get("inputs")
        .and_then(|i| i.get(side))
        .and_then(Value::as_str)
        .unwrap();
    let parse = spec.get("parse").and_then(|p| p.get(side)).unwrap();
    let text = decode(&std::fs::read(dir.join(input)).unwrap());
    let filename = parse
        .get("filename")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let languages = parse
        .get("languages")
        .and_then(Value::as_array)
        .map(|l| l.iter().map(|v| v.as_str().unwrap().to_owned()).collect());
    if parse.get("allowEmpty") == Some(&Value::Bool(true))
        && kgdiff_core::js::trim(&text).is_empty()
    {
        let mut options = ParseOptions::default();
        options.format = Some(FormatId::Json);
        options.filename = filename;
        return parse_graph("{\"nodes\":[],\"edges\":[]}", &options).unwrap();
    }
    let format = match parse.get("format").and_then(Value::as_str) {
        None | Some("auto") => None,
        Some(id) => FormatId::from_id(id),
    };
    let options = {
        let mut o = ParseOptions::default();
        o.format = format;
        o.filename = filename;
        o.rdf = {
            let mut o = RdfOptions::default();
            o.languages = languages;
            o
        };
        o
    };
    parse_graph(&text, &options).unwrap()
}

/// `graphLabel`: `name version` from the graph's meta, else the input as given.
fn graph_label(meta: Option<&Value>, display: &str) -> String {
    let text = |key: &str| {
        meta.and_then(|m| m.get(key))
            .and_then(Value::as_str)
            .map(kgdiff_core::js::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    match (text("name"), text("version")) {
        (Some(name), Some(version)) => format!("{name} {version}"),
        (Some(name), None) => name,
        _ => display.to_owned(),
    }
}

/// `defaultTitle`.
fn default_title(before: (Option<&Value>, &str), after: (Option<&Value>, &str)) -> String {
    let (lb, la) = (
        graph_label(before.0, before.1),
        graph_label(after.0, after.1),
    );
    let raw = |meta: Option<&Value>, key: &str| {
        meta.and_then(|m| m.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let (nb, na) = (raw(before.0, "name"), raw(after.0, "name"));
    let (vb, va) = (raw(before.0, "version"), raw(after.0, "version"));
    let trim = |s: &str| kgdiff_core::js::trim(s).to_owned();
    if let (Some(nb), Some(vb), Some(va)) = (&nb, &vb, &va)
        && !trim(nb).is_empty()
        && Some(nb) == na.as_ref()
        && !trim(vb).is_empty()
        && !trim(va).is_empty()
        && vb != va
    {
        return format!("{} {} → {}", trim(nb), trim(vb), trim(va));
    }
    if lb != la {
        format!("{lb} → {la}")
    } else {
        format!("{} → {}", before.1, after.1)
    }
}

struct Case {
    dir: PathBuf,
    spec: Value,
    before: ParseResult,
    after: ParseResult,
    result: DiffResult,
}

fn load(id: &str) -> Case {
    let dir = corpus().join("cases").join(id);
    let spec = read_json(&dir.join("case.json"));
    let before = parse_side(&dir, &spec, "before");
    let after = parse_side(&dir, &spec, "after");
    let options = kgdiff_core::resolve_options(spec.get("options")).unwrap();
    let result = kgdiff_core::diff(
        &Value::Object(before.graph.clone()),
        &Value::Object(after.graph.clone()),
        &options,
    )
    .unwrap();
    Case {
        dir,
        spec,
        before,
        after,
        result,
    }
}

impl Case {
    fn title(&self) -> String {
        let display = |side: &str| {
            self.spec
                .get("inputs")
                .and_then(|i| i.get(side))
                .and_then(Value::as_str)
                .unwrap()
                .to_owned()
        };
        let meta = |r: &ParseResult| r.graph.get("meta").cloned();
        let (mb, ma) = (meta(&self.before), meta(&self.after));
        default_title(
            (mb.as_ref(), &display("before")),
            (ma.as_ref(), &display("after")),
        )
    }
}

/// The value of the last `--flag value` in `args`, and every value of a repeated flag.
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .rposition(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn all<'a>(args: &'a [String], name: &str) -> Vec<&'a str> {
    args.iter()
        .enumerate()
        .filter(|(_, a)| *a == name)
        .filter_map(|(i, _)| args.get(i + 1).map(String::as_str))
        .collect()
}

fn ids() -> Vec<String> {
    let manifest = read_json(&corpus().join("manifest.json"));
    manifest
        .get("cases")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|c| c.get("id").and_then(Value::as_str).unwrap().to_owned())
        .collect()
}

#[test]
fn text_outputs_are_byte_identical() {
    let mut failures = Vec::new();
    let mut checked = 0;
    for id in ids() {
        let case = load(&id);
        for run in case.spec.get("cli").and_then(Value::as_array).unwrap() {
            let args: Vec<String> = run
                .get("args")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().to_owned())
                .collect();
            let Some(stdout) = run
                .get("stdout")
                .and_then(|s| s.get("file"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if run.get("exit").and_then(Value::as_f64) == Some(2.0)
                || run.get("stdin").is_some()
                || args.first().is_some_and(|a| a == "apply")
                || args.iter().any(|a| a == "--json" || a == "--delta")
            {
                continue;
            }
            let locale = match flag(&args, "--locale") {
                Some("zh-CN") => Locale::ZhCn,
                _ => Locale::En,
            };
            // The corpus sets whole numbers of columns; the CLI clamps them to 40–120.
            let columns: usize = run
                .get("env")
                .and_then(|e| e.get("COLUMNS"))
                .and_then(Value::as_str)
                .and_then(|c| c.parse().ok())
                .unwrap_or(120);
            let width = columns.clamp(40, 120);
            let limit = flag(&args, "--limit").map_or(50, |l| l.parse().unwrap());
            let watch: Vec<String> = all(&args, "--watch-attr")
                .into_iter()
                .map(str::to_owned)
                .collect();
            let ctx = {
                let mut o = TextContext::new(Painter::plain(), locale);
                o.width = width;
                o.limit = limit;
                o.watch = if watch.is_empty() {
                    None
                } else {
                    Some(watch.clone())
                };
                o
            };
            let title = case.title();
            let actual = if args.iter().any(|a| a == "--markdown") {
                render_markdown(&case.result, &{
                    let mut o = MarkdownOptions::new(locale, &title, "kgdiff 9.9.9");
                    o.watch = if watch.is_empty() { None } else { Some(&watch) };
                    o
                })
                .unwrap()
                .replace("kgdiff 9.9.9", "kgdiff <version>")
            } else {
                let stat = args.iter().any(|a| a == "--stat");
                let name_status = args.iter().any(|a| a == "--name-status");
                if stat || name_status {
                    let mut parts = Vec::new();
                    if stat {
                        parts.push(render_stat(&case.result, &title, &ctx));
                    }
                    if name_status {
                        parts.push(render_name_status(&case.result, &ctx, false).unwrap());
                    }
                    parts
                        .into_iter()
                        .filter(|p| !p.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    render_summary(&case.result, &title, &ctx).unwrap()
                }
            };
            checked += 1;
            let expected = std::fs::read_to_string(case.dir.join(stdout)).unwrap();
            if actual != expected {
                let at = actual
                    .chars()
                    .zip(expected.chars())
                    .take_while(|(a, e)| a == e)
                    .count();
                let excerpt = |s: &str| {
                    s.chars()
                        .skip(at.saturating_sub(60))
                        .take(160)
                        .collect::<String>()
                };
                failures.push(format!(
                    "{id} {}:\n  actual   {:?}\n  expected {:?}",
                    run.get("name").and_then(Value::as_str).unwrap(),
                    excerpt(&actual),
                    excerpt(&expected)
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(checked >= 120, "only {checked} runs checked");
}

#[test]
fn report_payloads_match_report_json_and_layouts_their_contract() {
    let schemas = schema::Schemas::load();
    let mut failures = Vec::new();
    let mut with_options = Vec::new();
    for id in ids() {
        let case = load(&id);
        let locale = match case.spec.get("locale").and_then(Value::as_str) {
            Some("zh-CN") => Locale::ZhCn,
            _ => Locale::En,
        };
        let side = |r: &ParseResult, key: &str| {
            let display = case
                .spec
                .get("inputs")
                .and_then(|i| i.get(key))
                .and_then(Value::as_str)
                .unwrap();
            ReportSide::new(
                graph_label(r.graph.get("meta"), display),
                Some(r.format.id().to_owned()),
            )
        };
        let info = {
            let mut o = ReportInfo::new(
                case.title(),
                "kgdiff <version>".to_owned(),
                side(&case.before, "before"),
                side(&case.after, "after"),
            );
            o.generated_at = None;
            o.mode = None;
            o.scope = None;
            o.theme = None;
            o.locale = locale;
            o.panels = None;
            o.shapes = None;
            o
        };
        let mut payload = kgdiff_report::html::report_payload(&case.result, &info);
        let errors = schemas.errors("report.v1.json", &payload);
        if !errors.is_empty() {
            failures.push(format!(
                "{id}: not a report.v1.json\n  {}",
                errors.join("\n  ")
            ));
        }
        // `report.json` is the payload without its packed diff (`diff.packed.json`) and layout,
        // which is checked against the case's layout contract below.
        let mut layout = None;
        if let Value::Object(o) = &mut payload {
            o.remove("diff");
            layout = o.remove("layout");
        }
        let layout = layout.expect("a report with a layout");
        if layout.get("version").and_then(Value::as_f64) != Some(2.0)
            || layout.get("generator").and_then(Value::as_str) != Some(kgdiff_layout::GENERATOR)
        {
            failures.push(format!(
                "{id}: not a version 2 layout of {}",
                kgdiff_layout::GENERATOR
            ));
        }
        // The contract is recorded with the case's layout options; a report lays out with the
        // defaults, so the cases that set options (synthetic-600: scope `changes`) are compared
        // with the contract of the default layout's own run instead, by kgdiff-layout's tests.
        let contract = read_json(&case.dir.join("expected/layout-contract.json"));
        if contract
            .get("options")
            .and_then(Value::as_object)
            .is_some_and(Object::is_empty)
        {
            let actual = layout_contract(&layout);
            if actual != contract {
                failures.push(format!(
                    "{id} layout: {}\n  vs layout-contract.json {}",
                    json::to_string(&actual),
                    json::to_string(&contract)
                ));
            }
        } else {
            with_options.push(id.clone());
        }
        let expected = read_json(&case.dir.join("expected/report.json"));
        if payload != expected {
            failures.push(format!(
                "{id}: {} vs {}",
                json::to_string(&payload),
                json::to_string(&expected)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(
        with_options,
        ["synthetic-600"],
        "the cases whose contract has layout options"
    );
}

/// The layout contract of `xtask/src/conformance/library.rs`, from a layout document: the part
/// of the layout that does not depend on floating-point simulation (iteration counts of union
/// layouts only).
fn layout_contract(layout: &Value) -> Value {
    let mut out = Object::new();
    out.insert("options", Object::new());
    for key in ["strategy", "scope"] {
        out.insert(key, layout.get(key).cloned().unwrap_or(Value::Null));
    }
    if layout.get("strategy").and_then(Value::as_str) == Some("union") {
        out.insert(
            "iterations",
            layout.get("iterations").cloned().unwrap_or(Value::Null),
        );
    }
    // `[...positions.keys()].sort()`: UTF-16 code unit order.
    let mut nodes: Vec<String> = layout
        .get("positions")
        .and_then(Value::as_object)
        .map_or_else(Vec::new, |p| {
            p.keys().map(|k| k.as_str().to_owned()).collect()
        });
    nodes.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    out.insert(
        "nodes",
        Value::Array(nodes.into_iter().map(Value::from).collect()),
    );
    for key in ["radii", "hidden"] {
        out.insert(key, layout.get(key).cloned().unwrap_or(Value::Null));
    }
    let components: Vec<Value> = layout
        .get("components")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |c| {
            c.iter()
                .map(|c| c.get("nodes").cloned().unwrap_or(Value::Null))
                .collect()
        });
    out.insert("components", Value::Array(components));
    Value::Object(out)
}
