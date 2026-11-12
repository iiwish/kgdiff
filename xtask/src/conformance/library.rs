//! The library outputs of a case (README, "Library outputs"): each input decoded and parsed with
//! kgdiff-formats, the two diffed with kgdiff-core, the layout contract from kgdiff-layout.

use std::io::Read as _;

use kgdiff_core::js::{self, JsStr, Object, Value};
use kgdiff_core::{
    DiffOptions, DiffResult, Locale, diff_to_json, format_hunk, graph_to_json, hash_graph,
    invert_delta, pack_diff_json, resolve_options,
};
use kgdiff_formats::{FormatId, ParseOptions, ParseResult, RdfOptions, parse_graph};
use kgdiff_layout::{LayoutOptions, LayoutStrategy, layout_diff, layout_to_json};

use super::definitions::{Definition, Side, input_filename};
use super::{compact, pretty};

/// README step 1: gunzip when the input starts with `1f 8b`; then UTF-16LE / BE by byte order
/// mark, else UTF-8, strictly and without the byte order mark.
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
        let chunks = bytes[2..].chunks_exact(2);
        if !chunks.remainder().is_empty() {
            return Err("an odd number of UTF-16 bytes".to_owned());
        }
        let units: Vec<u16> = chunks
            .map(|c| {
                let pair = [c[0], c[1]];
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
            .map_or_else(|| text.clone(), str::to_owned))
    }
}

/// README step 2: one input parsed exactly as `kgdiff <before> <after>` reads it.
pub fn parse_input(def: &Definition, side: Side, bytes: &[u8]) -> Result<ParseResult, String> {
    let input = def.inputs.get(side);
    let text = decode(bytes).map_err(|e| format!("{input}: {e}"))?;
    let filename = Some(input_filename(input));
    let result = if def.allow_empty && js::trim(&text).is_empty() {
        // --allow-empty: the empty graph, without asking a parser to guess the format of nothing.
        parse_graph("{\"nodes\":[],\"edges\":[]}", &{
            let mut o = ParseOptions::default();
            o.format = Some(FormatId::Json);
            o.filename = filename;
            o
        })
    } else {
        let format = match def.formats.get(side) {
            None => None,
            Some(id) => Some(FormatId::from_id(id).ok_or_else(|| format!("unknown format {id}"))?),
        };
        parse_graph(&text, &{
            let mut o = ParseOptions::default();
            o.format = format;
            o.filename = filename;
            o.rdf = {
                let mut o = RdfOptions::default();
                o.languages = def.languages.clone();
                o
            };
            o
        })
    };
    result.map_err(|e| format!("parse({}): {} {}", side.name(), e.code, e.message))
}

/// What the library computes for a case, and the files it writes.
pub struct Library {
    pub options: DiffOptions,
    pub result: DiffResult,
    pub hashes: [String; 2],
    pub diff_text: String,
    pub packed_text: String,
    pub delta_text: String,
    /// Path below the case directory and contents, in the order the generator writes them.
    pub files: Vec<(&'static str, String)>,
}

pub fn compute(def: &Definition, inputs: [&[u8]; 2]) -> Result<Library, String> {
    let parsed = [
        parse_input(def, Side::Before, inputs[0])?,
        parse_input(def, Side::After, inputs[1])?,
    ];
    let options = resolve_options(Some(&def.options)).map_err(|e| e.message)?;
    let result = kgdiff_core::diff(
        &Value::Object(parsed[0].graph.clone()),
        &Value::Object(parsed[1].graph.clone()),
        &options,
    )
    .map_err(|e| format!("diff: {} {}", e.code, e.message))?;
    let json = diff_to_json(&result);
    let diff_text = compact(&json);
    let packed_text = compact(&pack_diff_json(&json));
    let delta = result.delta.to_value();
    let delta_text = compact(&delta);
    let hashes = [
        hash_graph(&result.before).to_owned(),
        hash_graph(&result.after).to_owned(),
    ];
    let named = |side: &str| {
        delta
            .get(side)
            .and_then(|s| s.get("hash"))
            .and_then(Value::as_str)
    };
    if named("base") != Some(hashes[0].as_str()) || named("target") != Some(hashes[1].as_str()) {
        return Err("the delta does not name the hashes of the two graphs".to_owned());
    }

    let mut issues = Object::new();
    let mut hash_record = Object::new();
    for (side, (graph, hash)) in ["before", "after"]
        .into_iter()
        .zip([&result.before, &result.after].into_iter().zip(&hashes))
    {
        issues.insert(
            side,
            Value::Array(graph.issues().iter().map(|i| i.to_value()).collect()),
        );
        hash_record.insert(side, hash.as_str());
    }
    let files = vec![
        ("expected/parse.before.json", pretty(&parsed[0].to_value())),
        ("expected/parse.after.json", pretty(&parsed[1].to_value())),
        (
            "expected/graph.before.json",
            compact(&graph_to_json(&result.before)),
        ),
        (
            "expected/graph.after.json",
            compact(&graph_to_json(&result.after)),
        ),
        ("expected/issues.json", pretty(&Value::Object(issues))),
        ("expected/hashes.json", pretty(&Value::Object(hash_record))),
        ("expected/diff.json", diff_text.clone()),
        ("expected/diff.packed.json", packed_text.clone()),
        ("expected/delta.json", delta_text.clone()),
        (
            "expected/delta.inverse.json",
            compact(&invert_delta(&result.delta).to_value()),
        ),
        ("expected/titles.json", pretty(&titles(&result)?)),
        (
            "expected/layout-contract.json",
            pretty(&layout_contract(def, &result)?),
        ),
    ];
    Ok(Library {
        options,
        result,
        hashes,
        diff_text,
        packed_text,
        delta_text,
        files,
    })
}

/// `formatHunk` of every hunk, in English and Chinese.
fn titles(result: &DiffResult) -> Result<Value, String> {
    let mut out = Object::new();
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
        out.insert(locale.as_str(), Value::Array(list));
    }
    Ok(Value::Object(out))
}

/// The part of the layout that does not depend on floating-point simulation. Iteration counts
/// only for union layouts: an anchored layout simulates a window found by a range query on
/// positions, so its tick count depends on geometry.
fn layout_contract(def: &Definition, result: &DiffResult) -> Result<Value, String> {
    let options = LayoutOptions::from_value(&def.layout).map_err(|e| e.message)?;
    let layout = layout_diff(result, &options).map_err(|e| e.message)?;
    let document = layout_to_json(&layout);
    let field = |name: &str| document.get(name).cloned().unwrap_or_default();
    let mut out = Object::new();
    out.insert("options", def.layout.clone());
    out.insert("strategy", field("strategy"));
    out.insert("scope", field("scope"));
    if layout.stats.strategy == LayoutStrategy::Union {
        out.insert("iterations", field("iterations"));
    }
    let mut nodes: Vec<&JsStr> = layout.positions.keys().collect();
    nodes.sort();
    out.insert(
        "nodes",
        Value::Array(nodes.into_iter().map(Value::from).collect()),
    );
    out.insert("radii", field("radii"));
    out.insert("hidden", field("hidden"));
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
    Ok(Value::Object(out))
}

/// The layout document a report of the case carries: `layout_diff` with the default options.
pub fn report_layout(result: &DiffResult) -> Result<Value, String> {
    let layout = layout_diff(result, &LayoutOptions::default()).map_err(|e| e.message)?;
    Ok(layout_to_json(&layout))
}
