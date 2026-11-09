//! The library outputs of a case (README, "Library outputs"): each input decoded and parsed with
//! kgdiff-formats (steps 1 and 2), then diffed with kgdiff-core.

use std::io::Read;

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{
    KGraph, NormalizeOptions, graph_to_json, hash_graph, normalize, resolve_options,
};
use kgdiff_formats::{FormatId, ParseOptions, ParseResult, RdfOptions, parse_graph};

use crate::corpus::Case;

pub const SIDES: [&str; 2] = ["before", "after"];

/// A file of the case read with kgdiff-core's own JSON reader.
fn read(case: &Case, relative: &str) -> Result<Value, String> {
    let bytes = case.read_bytes(relative)?;
    let text = String::from_utf8(bytes).map_err(|e| format!("{relative}: {e}"))?;
    json::parse(&text).map_err(|e| format!("{relative}: {e}"))
}

/// Step 1: gunzip when the input starts with `1f 8b`; then UTF-16LE / BE by byte order mark,
/// else strict UTF-8, without the byte order mark.
pub fn decode(bytes: &[u8]) -> Result<String, String> {
    let bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        out
    } else {
        bytes.to_vec()
    };
    let utf16 = |little: bool| {
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| {
                let pair = [c[0], *c.get(1).unwrap_or(&0)];
                if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|e| e.to_string())
    };
    if bytes.starts_with(&[0xff, 0xfe]) {
        utf16(true)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        utf16(false)
    } else {
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        Ok(text
            .strip_prefix('\u{feff}')
            .map(str::to_owned)
            .unwrap_or(text))
    }
}

/// Step 2: the `ParseResult` of one side, as `parse` of `case.json` says.
fn parse_side(case: &Case, side: &str) -> Result<ParseResult, String> {
    let spec = read(case, "case.json")?;
    let input = spec
        .get("inputs")
        .and_then(|i| i.get(side))
        .and_then(Value::as_str)
        .ok_or("case.json: no input")?;
    let parse = spec
        .get("parse")
        .and_then(|p| p.get(side))
        .ok_or("case.json: no parse options")?;
    let text = decode(&case.read_bytes(input)?).map_err(|e| format!("{input}: {e}"))?;
    let filename = parse
        .get("filename")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let languages = parse
        .get("languages")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        });
    let result = if parse.get("allowEmpty") == Some(&Value::Bool(true))
        && kgdiff_core::js::trim(&text).is_empty()
    {
        parse_graph(
            "{\"nodes\":[],\"edges\":[]}",
            &ParseOptions {
                format: Some(FormatId::Json),
                filename,
                ..ParseOptions::default()
            },
        )
    } else {
        let format = match parse.get("format").and_then(Value::as_str) {
            None | Some("auto") => None,
            Some(id) => Some(FormatId::from_id(id).ok_or_else(|| format!("unknown format {id}"))?),
        };
        parse_graph(
            &text,
            &ParseOptions {
                format,
                filename,
                rdf: RdfOptions {
                    languages,
                    ..RdfOptions::default()
                },
                ..ParseOptions::default()
            },
        )
    };
    result.map_err(|e| format!("parse({side}): {} {}", e.code, e.message))
}

/// Both sides of a case, parsed.
type Parsed = Result<[std::rc::Rc<ParseResult>; 2], String>;

thread_local! {
    /// The parse results of the case checked last: every part of a case is checked in a row.
    static PARSED: std::cell::RefCell<Option<(String, Parsed)>> =
        const { std::cell::RefCell::new(None) };
}

/// Both sides parsed, once per case.
fn parsed(case: &Case) -> Parsed {
    PARSED.with(|last| {
        let mut last = last.borrow_mut();
        if let Some((id, result)) = last.as_ref()
            && *id == case.id
        {
            return result.clone();
        }
        let result = (|| {
            Ok([
                std::rc::Rc::new(parse_side(case, "before")?),
                std::rc::Rc::new(parse_side(case, "after")?),
            ])
        })();
        *last = Some((case.id.clone(), result.clone()));
        result
    })
}

/// The parsed graph of one side (`parse.<side>.json`'s `graph`).
fn graph_of(case: &Case, side: &str) -> Result<Value, String> {
    let [before, after] = parsed(case)?;
    let result = if side == "before" { before } else { after };
    Ok(Value::Object(result.graph.clone()))
}

pub fn parse_before(case: &Case) -> Result<Vec<u8>, String> {
    let [before, _] = parsed(case)?;
    Ok(line(&before.to_value()))
}

pub fn parse_after(case: &Case) -> Result<Vec<u8>, String> {
    let [_, after] = parsed(case)?;
    Ok(line(&after.to_value()))
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
        let graph = graph_of(case, side)?;
        let options = NormalizeOptions {
            edge_identity: options.edge_identity,
            ..NormalizeOptions::default()
        };
        normalize(&graph, options)
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
            let side = |side: &str| graph_of(case, side);
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

pub fn packed(case: &Case) -> Result<Vec<u8>, String> {
    Ok(line(&kgdiff_core::pack_diff_json(
        &kgdiff_core::diff_to_json(&*diffed(case)?),
    )))
}

pub fn inverse(case: &Case) -> Result<Vec<u8>, String> {
    Ok(line(
        &kgdiff_core::invert_delta(&diffed(case)?.delta).to_value(),
    ))
}

/// `kgdiff apply <before> expected/delta.json`: the before graph (parsed) normalized with the delta's
/// edge identity, the delta (read from the file) applied strictly, written as kgdiff JSON without
/// `meta.source` (the CLI's `graphOutputJSON` for stdout).
pub fn apply(case: &Case) -> Result<Vec<u8>, String> {
    let delta = kgdiff_core::Delta::from_value(&read(case, "expected/delta.json")?)
        .map_err(|e| e.message)?;
    let graph = graph_of(case, "before")?;
    let options = NormalizeOptions {
        edge_identity: delta.edge_identity,
        ..NormalizeOptions::default()
    };
    let before = normalize(&graph, options).map_err(|e| e.message)?;
    let (applied, _) =
        kgdiff_core::apply_delta(&before, &delta, kgdiff_core::ApplyOptions::default())
            .map_err(|e| format!("{} {}", e.code, e.message))?;
    let Value::Object(mut out) = graph_to_json(&applied) else {
        return Err("graph_to_json is not an object".to_owned());
    };
    if let Some(Value::Object(meta)) = out.get_mut("meta") {
        meta.remove("source");
        if meta.is_empty() {
            out.remove("meta");
        }
    }
    Ok(line(&Value::Object(out)))
}
