//! The library outputs of a case (README, "Library outputs"): each input decoded and parsed with
//! kgdiff-formats (steps 1 and 2), then diffed with kgdiff-core.

use std::io::Read;

use kgdiff_core::js::{JsStr, Object, Value, json, number_to_string};
use kgdiff_core::{
    EdgeInput, GraphInput, KGraph, NodeInput, NormalizeOptions, Point, graph_to_json, hash_graph,
    normalize, normalize_input, normalize_json, resolve_options,
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
        parse_graph("{\"nodes\":[],\"edges\":[]}", &{
            let mut o = ParseOptions::default();
            o.format = Some(FormatId::Json);
            o.filename = filename;
            o
        })
    } else {
        let format = match parse.get("format").and_then(Value::as_str) {
            None | Some("auto") => None,
            Some(id) => Some(FormatId::from_id(id).ok_or_else(|| format!("unknown format {id}"))?),
        };
        parse_graph(&text, &{
            let mut o = ParseOptions::default();
            o.format = format;
            o.filename = filename;
            o.rdf = {
                let mut o = RdfOptions::default();
                o.languages = languages;
                o
            };
            o
        })
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
        let options = {
            let mut o = NormalizeOptions::default();
            o.edge_identity = options.edge_identity;
            o
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

// ─── The other ways into a graph (RFC 0003, part 3) ─────────────────────────

/// An id as `normalize` reads one: a string, or a finite number as text; empty otherwise.
fn id_of(value: Option<&Value>) -> Option<JsStr> {
    match value {
        None => Some(JsStr::default()),
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(x)) if x.is_finite() => Some(JsStr::from(number_to_string(*x))),
        Some(_) => Some(JsStr::default()),
    }
}

fn text_of(value: Option<&Value>) -> Option<Option<JsStr>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

fn texts_of(value: Option<&Value>) -> Option<Vec<JsStr>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::String(s)) => Some(vec![s.clone()]),
        Some(Value::Array(items)) => items.iter().map(|i| i.as_js_str().cloned()).collect(),
        Some(_) => None,
    }
}

fn attrs_of(value: Option<&Value>) -> Option<Object> {
    match value {
        None | Some(Value::Null) => Some(Object::new()),
        Some(Value::Object(attrs)) => Some(attrs.clone()),
        Some(_) => None,
    }
}

/// The graph a parsed input stands for, as Rust values; `None` if it has a field `normalize`
/// rejects (the typed input cannot hold it).
fn input_of(graph: &Value) -> Option<GraphInput> {
    let record = graph.as_object()?;
    let mut input = {
        let mut o = GraphInput::default();
        o.meta = record
            .get("meta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        o
    };
    for node in record.get("nodes")?.as_array()? {
        let node = node.as_object()?;
        let mut types = texts_of(node.get("type"))?;
        types.extend(texts_of(node.get("types"))?);
        let position = node
            .get("position")
            .and_then(Value::as_object)
            .and_then(|p| {
                Some(Point {
                    x: p.get("x")?.as_f64()?,
                    y: p.get("y")?.as_f64()?,
                })
            });
        input.nodes.push({
            let mut o = NodeInput::default();
            o.id = id_of(node.get("id"))?;
            o.label = text_of(node.get("label"))?;
            o.types = types;
            o.aliases = texts_of(node.get("aliases"))?;
            o.attrs = attrs_of(node.get("attrs"))?;
            o.deprecated = match node.get("deprecated") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(b)) => *b,
                Some(_) => return None,
            };
            o.replaces = texts_of(node.get("replaces"))?;
            o.replaced_by = texts_of(node.get("replacedBy"))?;
            o.implicit = node.get("implicit") == Some(&Value::Bool(true));
            o.position = position;
            o
        });
    }
    let edges = match record.get("edges") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items,
        Some(_) => return None,
    };
    for edge in edges {
        let edge = edge.as_object()?;
        input.edges.push({
            let mut o = EdgeInput::default();
            o.id = id_of(edge.get("id")).filter(|id| !id.is_empty());
            o.source = id_of(edge.get("source"))?;
            o.target = id_of(edge.get("target"))?;
            o.predicate = text_of(edge.get("predicate"))?.unwrap_or_default();
            o.label = text_of(edge.get("label"))?;
            o.attrs = attrs_of(edge.get("attrs"))?;
            o
        });
    }
    Some(input)
}

/// What the contract compares: the `graph_to_json` bytes, the hash and the issues.
fn outcome(graph: &kgdiff_core::Result<KGraph>) -> String {
    match graph {
        Ok(graph) => format!(
            "{}\n{}\n{}",
            json::to_string(&graph_to_json(graph)),
            hash_graph(graph),
            json::to_string(&Value::Array(
                graph.issues().iter().map(|i| i.to_value()).collect()
            ))
        ),
        Err(e) => format!("error {} {}", e.code, e.message),
    }
}

/// One side normalized four ways — from the parsed value, from Rust values (`normalize_input`)
/// and their JSON (`to_value`), and from JSON text (`normalize_json`) — which must agree; then the
/// graph, which must be the expected one.
fn every_way(case: &Case, side: &str) -> Result<Vec<u8>, String> {
    let options = resolve_options(Some(&options(case)?)).map_err(|e| e.message)?;
    let options = {
        let mut o = NormalizeOptions::default();
        o.edge_identity = options.edge_identity;
        o
    };
    let graph = graph_of(case, side)?;
    let reference = normalize(&graph, options);
    let expected = outcome(&reference);
    let text = outcome(&normalize_json(&json::to_string(&graph), options));
    if text != expected {
        return Err(format!("normalize_json({side}) differs from normalize"));
    }
    let input = input_of(&graph).ok_or_else(|| format!("{side} has no typed form"))?;
    let typed = outcome(&normalize_input(input.clone(), options));
    if typed != outcome(&normalize(&input.to_value(), options)) {
        return Err(format!(
            "normalize_input({side}) differs from normalize(to_value)"
        ));
    }
    if typed != expected {
        return Err(format!("normalize_input({side}) differs from normalize"));
    }
    let graph = reference.map_err(|e| format!("normalize({side}): {} {}", e.code, e.message))?;
    Ok(line(&graph_to_json(&graph)))
}

pub fn input_before(case: &Case) -> Result<Vec<u8>, String> {
    every_way(case, "before")
}

pub fn input_after(case: &Case) -> Result<Vec<u8>, String> {
    every_way(case, "after")
}

pub fn issues(case: &Case) -> Result<Vec<u8>, String> {
    let graphs = graphs(case)?;
    let mut out = Object::new();
    for (side, graph) in SIDES.iter().zip(&graphs) {
        out.insert(
            *side,
            Value::Array(
                graph
                    .issues()
                    .iter()
                    .map(|issue| issue.to_value())
                    .collect(),
            ),
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
    let mut options = NormalizeOptions::default();
    options.edge_identity = delta.edge_identity;
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
