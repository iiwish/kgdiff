//! JSON text and the JSON graph dialects → `GraphInput` (`json.ts`).
//!
//! Supported shapes (auto-detected, reported as `dialect`): kgdiff (`{ nodes, edges }`, for
//! certain with `format: 'kgdiff.graph', version: 1`), d3 / NetworkX (`{ nodes, links }`),
//! Cytoscape.js (`{ elements }` or a bare element array), AntV G6 v5, graphology and
//! vis-network. JSON-LD documents never get here: `parse_graph` reads them as RDF.

use std::borrow::Cow;

use kgdiff_core::js::{self, IndexMap, IndexSet, JsStr, Object, Value, json};
use kgdiff_core::util::{count_to_f64, f64_to_count};
use kgdiff_core::{ErrorCode, KgdiffError};

use crate::shared::{
    AttrBag, EdgeFields, MAX_NESTING, NodeFields, Position, Warnings, compare_strings,
    invalid_input, invalid_input_with, line_column_details, make_edge, make_meta, make_node,
    plural, sort_edges, sort_nodes, strip_bom, to_attr_value,
};
use crate::{JsonDialect, JsonFields, ParseWarningCode};

// ─── JSON text ───────────────────────────────────────────────────────────────

/// Nesting kept when a valid document is deeper than [`MAX_NESTING`]: everything that reads
/// values that deep fails before it reaches this level — attribute values, which start at most
/// five levels down (`elements.nodes[i].data.key`), at [`MAX_NESTING`] levels below them, and
/// JSON-LD at 200.
const KEPT_NESTING: usize = MAX_NESTING + 16;

/// Why JSON text is not what kgdiff reads.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonTextError {
    /// Not JSON: what was expected at the position (`JSON.parse` would throw).
    Syntax {
        /// UTF-16 offset of the problem.
        offset: usize,
        /// What was expected at that position.
        message: String,
    },
    /// Valid JSON with a lone surrogate escape (RFC 0002, D-2): `JSON.parse` would accept it.
    LoneSurrogate {
        /// UTF-16 offset of the escape's backslash.
        offset: usize,
        /// The escape as written (`\ud83d`).
        escape: String,
        /// `the escape \ud83d is a lone surrogate (half of a UTF-16 pair), which kgdiff does
        /// not accept` (no final period).
        reason: String,
    },
}

fn lone_reason(escape: &str) -> String {
    format!(
        "the escape {escape} is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept"
    )
}

/// `JSON.parse(text)` as kgdiff reads JSON: any depth, with a lone surrogate escape refused once
/// the text is otherwise valid JSON. No byte order mark is skipped.
///
/// # Errors
///
/// Returns a [`JsonTextError`] when `text` is not valid JSON or contains a lone surrogate escape.
pub fn parse_deep_json(text: &str) -> Result<Value, JsonTextError> {
    match json::Parser::new(text).max_depth(MAX_NESTING).parse() {
        Ok(value) => Ok(value),
        Err(error) => {
            let deep_or_lone = !matches!(error.kind, json::ErrorKind::Expected(_));
            match validate(text) {
                Validation::Valid if deep_or_lone => parse_shallow(text),
                Validation::Lone { at, escape } => Err(JsonTextError::LoneSurrogate {
                    offset: js::utf16_len(&text[..at]),
                    reason: lone_reason(&escape),
                    escape,
                }),
                _ => Err(JsonTextError::Syntax {
                    offset: error.offset,
                    message: error.to_string(),
                }),
            }
        }
    }
}

/// `parseJsonText`: `JSON.parse` after a byte order mark, with line and column in the
/// `invalid-input` error, worded as kgdiff's locator words it; a lone surrogate escape is an
/// error too (RFC 0002, D-2).
pub fn parse_json_text(text: &str) -> Result<Value, KgdiffError> {
    let source = strip_bom(text);
    let error = match json::Parser::new(source).max_depth(MAX_NESTING).parse() {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    let (offset, reason) = match &error.kind {
        json::ErrorKind::Expected(expected) => (
            error.offset,
            format!("expected {expected}, found {}", found(source, error.offset)),
        ),
        json::ErrorKind::LoneSurrogate(escape) => (error.offset, lone_reason(escape)),
        json::ErrorKind::TooDeep(_) => match validate(source) {
            // `JSON.parse` reads any depth: values this deep fail where they are read.
            Validation::Valid => {
                return parse_shallow(source).map_err(|_| invalid_input("Invalid JSON."));
            }
            Validation::Lone { at, escape } => (js::utf16_len(&source[..at]), lone_reason(&escape)),
            Validation::Invalid => (
                error.offset,
                format!("nested deeper than {MAX_NESTING} levels"),
            ),
        },
    };
    let (line, column) = json::line_and_column(source, offset);
    Err(invalid_input_with(
        format!("Invalid JSON on line {line}, column {column}: {reason}."),
        line_column_details(line, column),
    ))
}

/// `JSON.stringify(source[offset])`, or `end of input`: one UTF-16 unit, so half of a pair is
/// written as its escape (`"\ud83d"`).
fn found(source: &str, offset: usize) -> String {
    let at = crate::shared::byte_index(source, offset);
    match source[at..].chars().next() {
        None => "end of input".to_owned(),
        Some(c) if c.len_utf16() == 2 => {
            let mut units = [0u16; 2];
            c.encode_utf16(&mut units);
            format!("\"\\u{:04x}\"", units[0])
        }
        Some(c) => {
            let mut out = String::new();
            json::push_string(&mut out, c.encode_utf8(&mut [0; 4]));
            out
        }
    }
}

enum Validation {
    Valid,
    /// Valid JSON but for a lone surrogate escape at byte `at`.
    Lone {
        at: usize,
        escape: String,
    },
    Invalid,
}

/// Checks JSON syntax at any depth, without recursion; reports the first lone surrogate escape
/// of otherwise valid JSON.
fn validate(text: &str) -> Validation {
    let b = text.as_bytes();
    let mut i = 0;
    let mut lone: Option<(usize, String)> = None;
    // Open containers: true for objects.
    let mut stack: Vec<bool> = Vec::new();
    let space = |i: &mut usize| {
        while matches!(b.get(*i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            *i += 1;
        }
    };
    let hex4 = |at: usize| -> Option<u32> {
        let d = b.get(at..at + 4)?;
        d.iter()
            .try_fold(0, |acc, &c| Some(acc << 4 | char::from(c).to_digit(16)?))
    };
    let digits = |at: usize| {
        b[at.min(b.len())..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    // A key and its colon, at `*i` (the opening quote).
    let key = |i: &mut usize, lone: &mut Option<(usize, String)>| -> bool {
        if b.get(*i) != Some(&b'"') || !string(b, i, lone, &hex4) {
            return false;
        }
        space(i);
        if b.get(*i) != Some(&b':') {
            return false;
        }
        *i += 1;
        true
    };
    'value: loop {
        space(&mut i);
        match b.get(i) {
            Some(b'{') => {
                i += 1;
                space(&mut i);
                if b.get(i) == Some(&b'}') {
                    i += 1;
                } else {
                    stack.push(true);
                    if !key(&mut i, &mut lone) {
                        return Validation::Invalid;
                    }
                    continue 'value;
                }
            }
            Some(b'[') => {
                i += 1;
                space(&mut i);
                if b.get(i) == Some(&b']') {
                    i += 1;
                } else {
                    stack.push(false);
                    continue 'value;
                }
            }
            Some(b'"') => {
                if !string(b, &mut i, &mut lone, &hex4) {
                    return Validation::Invalid;
                }
            }
            Some(b't') if b[i..].starts_with(b"true") => i += 4,
            Some(b'f') if b[i..].starts_with(b"false") => i += 5,
            Some(b'n') if b[i..].starts_with(b"null") => i += 4,
            Some(b'-' | b'0'..=b'9') => {
                if b[i] == b'-' {
                    i += 1;
                }
                match b.get(i) {
                    Some(b'0') => i += 1,
                    Some(b'1'..=b'9') => i += digits(i),
                    _ => return Validation::Invalid,
                }
                if b.get(i) == Some(&b'.') && digits(i + 1) > 0 {
                    i += 1 + digits(i + 1);
                }
                if let Some(b'e' | b'E') = b.get(i) {
                    let sign = usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
                    let exp = digits(i + 1 + sign);
                    if exp > 0 {
                        i += 1 + sign + exp;
                    }
                }
            }
            _ => return Validation::Invalid,
        }
        // After a value: close containers until another value is due.
        loop {
            space(&mut i);
            match stack.last() {
                None => {
                    if i != b.len() {
                        return Validation::Invalid;
                    }
                    return match lone {
                        Some((at, escape)) => Validation::Lone { at, escape },
                        None => Validation::Valid,
                    };
                }
                Some(&object) => match b.get(i) {
                    Some(b',') => {
                        i += 1;
                        if object {
                            space(&mut i);
                            if !key(&mut i, &mut lone) {
                                return Validation::Invalid;
                            }
                        }
                        continue 'value;
                    }
                    Some(b'}') if object => {
                        i += 1;
                        stack.pop();
                    }
                    Some(b']') if !object => {
                        i += 1;
                        stack.pop();
                    }
                    _ => return Validation::Invalid,
                },
            }
        }
    }
}

/// A JSON string at `*i` (its opening quote); records the first lone surrogate escape.
fn string(
    b: &[u8],
    i: &mut usize,
    lone: &mut Option<(usize, String)>,
    hex4: &dyn Fn(usize) -> Option<u32>,
) -> bool {
    *i += 1;
    loop {
        match b.get(*i) {
            None => return false,
            Some(b'"') => {
                *i += 1;
                return true;
            }
            Some(b'\\') => {
                let escape = *i;
                *i += 1;
                match b.get(*i) {
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => *i += 1,
                    Some(b'u') => {
                        let Some(high) = hex4(*i + 1) else {
                            return false;
                        };
                        *i += 5;
                        if (0xD800..=0xDFFF).contains(&high) {
                            let paired = high < 0xDC00
                                && b[*i..].starts_with(b"\\u")
                                && hex4(*i + 2).is_some_and(|low| (0xDC00..=0xDFFF).contains(&low));
                            if paired {
                                *i += 6;
                            } else if lone.is_none() {
                                let written = String::from_utf8_lossy(&b[escape..escape + 6]);
                                *lone = Some((escape, written.into_owned()));
                            }
                        }
                    }
                    _ => return false,
                }
            }
            Some(0x00..=0x1F) => return false,
            Some(_) => *i += 1,
        }
    }
}

/// Parses valid JSON deeper than the reader's limit: containers below [`KEPT_NESTING`] become
/// `[]` (nothing reads that deep without failing first).
fn parse_shallow(text: &str) -> Result<Value, JsonTextError> {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'[' | b'{' if depth >= KEPT_NESTING => {
                // Skip the whole container.
                out.push_str(&text[last..i]);
                out.push_str("[]");
                let mut nested = 0usize;
                while i < b.len() {
                    match b[i] {
                        b'"' => {
                            i += 1;
                            while i < b.len() && b[i] != b'"' {
                                i += if b[i] == b'\\' { 2 } else { 1 };
                            }
                        }
                        b'[' | b'{' => nested += 1,
                        b']' | b'}' => {
                            nested -= 1;
                            if nested == 0 {
                                i += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
                last = i;
                continue;
            }
            b'[' | b'{' => {
                depth += 1;
                i += 1;
            }
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            _ => i += 1,
        }
    }
    out.push_str(&text[last..]);
    json::Parser::new(&out)
        .max_depth(KEPT_NESTING + 1)
        .parse()
        .map_err(|e| JsonTextError::Syntax {
            offset: e.offset,
            message: e.to_string(),
        })
}

// ─── Shape detection ─────────────────────────────────────────────────────────

/// What `parse_json` gives.
pub struct JsonParseOutput {
    pub graph: Object,
    pub dialect: JsonDialect,
    /// kgdiff JSON only: `meta.predicateLabels`, when it maps strings to strings (keys sorted).
    pub predicate_labels: Vec<(String, String)>,
}

struct Shape<'a> {
    dialect: JsonDialect,
    root: Option<&'a Object>,
    nodes: Vec<&'a Value>,
    edges: Vec<&'a Value>,
    nodes_key: &'static str,
    edges_key: &'static str,
}

const G6_NODE_KEYS: &[&str] = &[
    "id", "type", "data", "style", "states", "combo", "children", "depth",
];
const G6_EDGE_KEYS: &[&str] = &["id", "source", "target", "type", "data", "style", "states"];

const SHAPES_HELP: &str = "expected { nodes, edges } (kgdiff, AntV G6, graphology, vis-network), { nodes, links } (d3, NetworkX) or { elements } (Cytoscape.js)";

fn record(value: &Value) -> Option<&Object> {
    value.as_object()
}

fn unsupported_version(message: String, key: &str, value: Value) -> KgdiffError {
    let mut details = Object::new();
    details.insert(key, value);
    KgdiffError::new(ErrorCode::UnsupportedVersion, message).with_details(details)
}

/// The kgdiff JSON marker: true for `kgdiff.graph` version 1, false when there is none.
fn has_graph_marker(data: &Object) -> Result<bool, KgdiffError> {
    let Some(Value::String(format)) = data.get("format") else {
        return Ok(false);
    };
    if !format.starts_with("kgdiff.") {
        return Ok(false);
    }
    match format.as_str() {
        "kgdiff.graph" => {}
        "kgdiff.diff" => {
            return Err(unsupported_version(
                "This is a kgdiff diff (format \"kgdiff.diff\", as `kgdiff --json` writes it), not a graph.".to_owned(),
                "format",
                Value::from(format.clone()),
            ));
        }
        "kgdiff.delta" => {
            return Err(unsupported_version(
                "This is a kgdiff delta (format \"kgdiff.delta\"), not a graph: apply it to a graph with `kgdiff apply`.".to_owned(),
                "format",
                Value::from(format.clone()),
            ));
        }
        other => {
            return Err(unsupported_version(
                format!("Unknown kgdiff format \"{other}\"; expected \"kgdiff.graph\"."),
                "format",
                Value::from(format.clone()),
            ));
        }
    }
    let version = data.get("version");
    if version != Some(&Value::Number(1.0)) {
        let text = version.map_or_else(|| "undefined".to_owned(), Value::to_js_string);
        return Err(unsupported_version(
            format!("Unsupported kgdiff graph version {text}; this reader supports version 1."),
            "version",
            version.cloned().unwrap_or(Value::Null),
        ));
    }
    Ok(true)
}

fn items(value: &Value) -> Vec<&Value> {
    value
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

fn detect_shape(data: &Value) -> Result<Shape<'_>, KgdiffError> {
    if let Value::Object(root) = data
        && has_graph_marker(root)?
    {
        let Some(Value::Array(nodes)) = root.get("nodes") else {
            return Err(invalid_input("A kgdiff graph needs a `nodes` array."));
        };
        let edges = array_field(root, "edges")?;
        return Ok(Shape {
            dialect: JsonDialect::Kgdiff,
            root: Some(root),
            nodes: nodes.iter().collect(),
            edges,
            nodes_key: "nodes",
            edges_key: "edges",
        });
    }
    if let Value::Array(elements) = data {
        if !elements.is_empty()
            && elements
                .iter()
                .all(|e| record(e).is_some_and(|e| matches!(e.get("data"), Some(Value::Object(_)))))
        {
            return cytoscape_shape(None, data);
        }
        return Err(invalid_input(format!(
            "Unrecognized JSON graph: got an array; {SHAPES_HELP}."
        )));
    }
    let Value::Object(root) = data else {
        return Err(invalid_input(format!(
            "Unrecognized JSON graph: {SHAPES_HELP}."
        )));
    };
    if let Some(elements) = root.get("elements") {
        return cytoscape_shape(Some(root), elements);
    }
    let Some(Value::Array(nodes)) = root.get("nodes") else {
        let why = if root.contains_key("nodes") {
            "`nodes` is not an array"
        } else {
            "no `nodes` array"
        };
        return Err(invalid_input(format!(
            "Unrecognized JSON graph: {why}; {SHAPES_HELP}."
        )));
    };
    let nodes: Vec<&Value> = nodes.iter().collect();
    if root.contains_key("links") {
        return Ok(Shape {
            dialect: JsonDialect::D3,
            root: Some(root),
            nodes,
            edges: array_field(root, "links")?,
            nodes_key: "nodes",
            edges_key: "links",
        });
    }
    let edges = if root.contains_key("edges") {
        array_field(root, "edges")?
    } else {
        Vec::new()
    };
    fn records<'v>(list: &[&'v Value]) -> Vec<&'v Object> {
        list.iter().filter_map(|v| record(v)).collect()
    }
    fn base<'v>(
        root: &'v Object,
        dialect: JsonDialect,
        nodes: Vec<&'v Value>,
        edges: Vec<&'v Value>,
    ) -> Shape<'v> {
        Shape {
            dialect,
            root: Some(root),
            nodes,
            edges,
            nodes_key: "nodes",
            edges_key: "edges",
        }
    }
    let node_records = records(&nodes);
    let edge_records = records(&edges);
    if edge_records
        .iter()
        .any(|e| e.contains_key("from") && e.contains_key("to") && !e.contains_key("source"))
    {
        return Ok(base(root, JsonDialect::Vis, nodes, edges));
    }
    if node_records
        .iter()
        .any(|n| n.contains_key("key") && !n.contains_key("id"))
    {
        return Ok(base(root, JsonDialect::Graphology, nodes, edges));
    }
    if !node_records.is_empty()
        && node_records.iter().all(|n| {
            !n.contains_key("id")
                && matches!(n.get("data"), Some(Value::Object(d)) if d.contains_key("id"))
        })
    {
        return Ok(base(root, JsonDialect::Cytoscape, nodes, edges));
    }
    let combos: Vec<&Value> = match root.get("combos") {
        Some(Value::Array(c)) => c.iter().collect(),
        _ => Vec::new(),
    };
    let combo_records = records(&combos);
    let wrapped = node_records
        .iter()
        .chain(&edge_records)
        .chain(&combo_records)
        .any(|e| {
            matches!(e.get("data"), Some(Value::Object(_)))
                || matches!(e.get("style"), Some(Value::Object(_)))
        });
    // G6 v5 elements have nothing but these keys.
    let only = |list: &[&Object], allowed: &[&str]| {
        list.iter()
            .all(|e| e.keys().all(|k| allowed.contains(&k.as_str())))
    };
    if wrapped
        && only(&node_records, G6_NODE_KEYS)
        && only(&edge_records, G6_EDGE_KEYS)
        && only(&combo_records, G6_NODE_KEYS)
    {
        let mut all = nodes;
        all.extend(combos);
        return Ok(base(root, JsonDialect::G6, all, edges));
    }
    Ok(base(root, JsonDialect::Kgdiff, nodes, edges))
}

fn cytoscape_shape<'a>(
    root: Option<&'a Object>,
    elements: &'a Value,
) -> Result<Shape<'a>, KgdiffError> {
    match elements {
        Value::Array(list) => {
            let mut nodes = Vec::new();
            let mut edges = Vec::new();
            for element in list {
                let group = record(element).and_then(|e| e.get("group"));
                let data = record(element).and_then(|e| e.get("data"));
                let is_edge = group.and_then(Value::as_str) == Some("edges")
                    || (group.and_then(Value::as_str) != Some("nodes")
                        && matches!(data, Some(Value::Object(d)) if d.contains_key("source") && d.contains_key("target")));
                if is_edge {
                    edges.push(element);
                } else {
                    nodes.push(element);
                }
            }
            Ok(Shape {
                dialect: JsonDialect::Cytoscape,
                root,
                nodes,
                edges,
                nodes_key: "elements",
                edges_key: "elements",
            })
        }
        Value::Object(map) => Ok(Shape {
            dialect: JsonDialect::Cytoscape,
            root,
            nodes: map.get("nodes").map(items).unwrap_or_default(),
            edges: map.get("edges").map(items).unwrap_or_default(),
            nodes_key: "elements.nodes",
            edges_key: "elements.edges",
        }),
        _ => Err(invalid_input(
            "Cytoscape.js `elements` must be an array or an object with `nodes` / `edges`.",
        )),
    }
}

fn array_field<'a>(data: &'a Object, key: &str) -> Result<Vec<&'a Value>, KgdiffError> {
    match data.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(list)) => Ok(list.iter().collect()),
        Some(_) => Err(invalid_input(format!("`{key}` must be an array."))),
    }
}

/// Counts the numbers beyond the double range that `to_attr_value` keeps as strings, for one
/// `json-non-finite` warning per parse (RFC 0002, D-11).
fn non_finite(warnings: &mut Warnings) {
    warnings.count(
        ParseWarningCode::JsonNonFinite,
        |n| {
            format!(
                "Kept {} beyond the range of a double (such as 1e400) as the string \"Infinity\" or \"-Infinity\".",
                plural(n, "number")
            )
        },
        1,
    );
}

fn graph_meta(shape: &Shape<'_>, warnings: &mut Warnings) -> Result<Option<Object>, KgdiffError> {
    let Some(root) = shape.root else {
        return Ok(None);
    };
    if shape.dialect == JsonDialect::Kgdiff {
        let Some(Value::Object(meta)) = root.get("meta") else {
            return Ok(None);
        };
        let mut entries = Vec::new();
        for (key, value) in meta.iter() {
            let converted = to_attr_value(value, 0, &mut || non_finite(warnings))?;
            entries.push((key.clone(), converted));
        }
        return Ok(make_meta(entries));
    }
    let source = match shape.dialect {
        JsonDialect::Graphology => root.get("attributes"),
        JsonDialect::D3 => root.get("graph"),
        JsonDialect::Cytoscape => root.get("data"),
        _ => None,
    };
    let Some(Value::Object(source)) = source else {
        return Ok(None);
    };
    let text = |value: Option<&Value>| match value {
        Some(Value::String(s)) => Some(Value::from(s.clone())),
        Some(Value::Number(x)) => Some(Value::from(js::number_to_string(*x))),
        _ => None,
    };
    Ok(make_meta(vec![
        (JsStr::from("name"), text(source.get("name"))),
        (JsStr::from("version"), text(source.get("version"))),
    ]))
}

// ─── Element mapping ─────────────────────────────────────────────────────────

struct Ignored {
    nodes: &'static [&'static str],
    edges: &'static [&'static str],
}

/// Rendering / simulation state that would only add noise to a diff (`IGNORED_KEYS`).
fn ignored_keys(dialect: JsonDialect) -> Ignored {
    match dialect {
        JsonDialect::Kgdiff | JsonDialect::G6 => Ignored {
            nodes: &[],
            edges: &[],
        },
        JsonDialect::D3 => Ignored {
            nodes: &["index", "x", "y", "vx", "vy", "fx", "fy"],
            edges: &["index"],
        },
        JsonDialect::Cytoscape => Ignored {
            nodes: &["SUID", "selected"],
            edges: &["SUID", "selected"],
        },
        JsonDialect::Graphology => Ignored {
            nodes: &[
                "x",
                "y",
                "size",
                "color",
                "hidden",
                "forceLabel",
                "zIndex",
                "highlighted",
            ],
            edges: &["size", "color", "hidden", "forceLabel", "zIndex"],
        },
        JsonDialect::Vis => Ignored {
            nodes: &[
                "x",
                "y",
                "fixed",
                "physics",
                "shape",
                "color",
                "size",
                "font",
                "borderWidth",
                "borderWidthSelected",
                "image",
                "brokenImage",
                "shadow",
                "margin",
                "widthConstraint",
                "heightConstraint",
                "level",
                "mass",
                "hidden",
                "opacity",
                "chosen",
                "icon",
                "scaling",
                "shapeProperties",
                "imagePadding",
                "labelHighlightBold",
            ],
            edges: &[
                "arrows",
                "arrowStrikethrough",
                "color",
                "dashes",
                "width",
                "smooth",
                "physics",
                "hidden",
                "length",
                "font",
                "chosen",
                "endPointOffset",
                "hoverWidth",
                "selectionWidth",
                "shadow",
                "scaling",
                "background",
                "widthConstraint",
                "selfReference",
                "labelHighlightBold",
            ],
        },
    }
}

/// One JSON element (`ElementReader`): the raw object and the record that holds its properties
/// (`data` for Cytoscape / G6, `attributes` for graphology, the element itself otherwise).
struct ElementReader<'a> {
    raw: &'a Object,
    record: Cow<'a, Object>,
    /// The raw key holding the record, or `None` when the record is the element itself.
    container: Option<&'static str>,
    ignored: &'static [&'static str],
    consumed: IndexSet<String>,
    consumed_raw: IndexSet<String>,
}

fn get_path<'a>(source: &'a Object, path: &str) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let mut current = source.get(parts.next()?)?;
    for part in parts {
        current = current.as_object()?.get(part)?;
    }
    Some(current)
}

impl<'a> ElementReader<'a> {
    fn consume(&mut self, key: &str) {
        self.consumed.insert(key.to_owned());
        if self.container.is_none() {
            self.consumed_raw.insert(key.to_owned());
        }
    }

    fn raw_value(&mut self, key: &str) -> Option<&'a Value> {
        self.consumed_raw.insert(key.to_owned());
        if self.container.is_none() {
            self.consumed.insert(key.to_owned());
        }
        self.raw.get(key)
    }

    /// The first of `keys` holding a usable value; that key is consumed.
    fn first<T>(
        &mut self,
        keys: &[&str],
        accept: impl Fn(Option<&Value>) -> Option<T>,
    ) -> Option<T> {
        for key in keys {
            let value = accept(self.record.get(key));
            if value.is_some() {
                self.consume(key);
                return value;
            }
        }
        None
    }

    /// The value at a dotted path, looked up in the record, then in the raw element.
    fn path<T>(&mut self, path: &str, accept: impl Fn(Option<&Value>) -> Option<T>) -> Option<T> {
        let top = path.split('.').next().unwrap_or(path);
        let in_record = accept(get_path(&self.record, path));
        if in_record.is_some() {
            if top == path {
                self.consume(path);
            }
            return in_record;
        }
        let in_raw = accept(get_path(self.raw, path));
        if in_raw.is_some() {
            self.consumed_raw.insert(top.to_owned());
        }
        in_raw
    }

    /// The remaining record keys as attributes.
    fn rest(&self, into: &mut AttrBag, warnings: &mut Warnings) -> Result<(), KgdiffError> {
        for (key, value) in self.record.iter() {
            if self.consumed.contains(key.as_str()) || self.ignored.contains(&key.as_str()) {
                continue;
            }
            if let Some(value) = to_attr_value(value, 0, &mut || non_finite(warnings))? {
                into.add(key.clone(), value);
            }
        }
        Ok(())
    }

    /// Keys that did not make it into the graph: rendering state and unmapped raw keys.
    fn dropped(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .record
            .keys()
            .filter(|k| self.ignored.contains(&k.as_str()) && !self.consumed.contains(k.as_str()))
            .map(|k| k.to_string())
            .collect();
        if let Some(container) = self.container {
            for key in self.raw.keys() {
                if key.as_str() != container && !self.consumed_raw.contains(key.as_str()) {
                    keys.push(key.to_string());
                }
            }
        }
        keys
    }
}

fn as_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(s.to_string()),
        Value::Number(x) if x.is_finite() => Some(js::number_to_string(*x)),
        _ => None,
    }
}

fn as_strings(value: Option<&Value>) -> Option<Vec<String>> {
    match value? {
        Value::String(s) => Some(vec![s.to_string()]),
        Value::Array(items) => items
            .iter()
            .map(|i| i.as_str().map(str::to_owned))
            .collect(),
        _ => None,
    }
}

fn as_ids(value: Option<&Value>) -> Option<Vec<String>> {
    if let Some(single) = as_id(value) {
        return Some(vec![single]);
    }
    let Value::Array(items) = value? else {
        return None;
    };
    items.iter().map(|i| as_id(Some(i))).collect()
}

fn as_boolean(value: Option<&Value>) -> Option<bool> {
    value?.as_bool()
}

fn as_point(value: Option<&Value>) -> Option<Position> {
    let o = value?.as_object()?;
    match (o.get("x"), o.get("y")) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => Some(Position { x: *x, y: *y }),
        _ => None,
    }
}

fn as_record(value: Option<&Value>) -> Option<Object> {
    value?.as_object().cloned()
}

const LABEL_KEYS: &[&str] = &["label", "name", "title"];
const TYPE_KEYS: &[&str] = &["type", "types", "category", "labels"];
const VIS_TYPE_KEYS: &[&str] = &["type", "types", "category", "labels", "group"];
const ALIAS_KEYS: &[&str] = &["aliases", "synonyms"];
/// `interaction` is Cytoscape's (desktop) name for the relation type.
const PREDICATE_KEYS: &[&str] = &["predicate", "relation", "rel", "type", "interaction"];

struct JsonMapper<'a, 'w> {
    shape: &'a Shape<'a>,
    fields: &'a JsonFields,
    warnings: &'w mut Warnings,
    ignored: Ignored,
    extra_edges: Vec<Object>,
    /// d3 only: node ids by array index, for links that reference nodes by index.
    ids_by_index: Vec<Option<String>>,
    id_set: IndexSet<String>,
    /// Dropped field name → number of elements that had it.
    dropped: IndexMap<String, usize>,
}

/// `parseJson`: maps a parsed JSON graph in any supported dialect.
pub fn parse_json(
    data: &Value,
    fields: &JsonFields,
    warnings: &mut Warnings,
) -> Result<JsonParseOutput, KgdiffError> {
    let shape = detect_shape(data)?;
    let mut mapper = JsonMapper {
        shape: &shape,
        fields,
        warnings,
        ignored: ignored_keys(shape.dialect),
        extra_edges: Vec::new(),
        ids_by_index: Vec::new(),
        id_set: IndexSet::default(),
        dropped: IndexMap::default(),
    };
    // Nodes first: d3 links may reference nodes by index.
    let mut nodes = mapper.nodes()?;
    sort_nodes(&mut nodes);
    let mut edges = mapper.edges()?;
    sort_edges(&mut edges);
    mapper.report_dropped();
    let meta = graph_meta(&shape, mapper.warnings)?;
    let predicate_labels = match meta.as_ref().and_then(|m| m.get("predicateLabels")) {
        Some(Value::Object(labels)) if labels.values().all(|v| matches!(v, Value::String(_))) => {
            labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.as_str().unwrap_or("").to_owned()))
                .collect()
        }
        _ => Vec::new(),
    };
    let mut graph = Object::new();
    graph.insert(
        "nodes",
        Value::Array(nodes.into_iter().map(Value::Object).collect()),
    );
    graph.insert(
        "edges",
        Value::Array(edges.into_iter().map(Value::Object).collect()),
    );
    if let Some(meta) = meta {
        graph.insert("meta", Value::Object(meta));
    }
    Ok(JsonParseOutput {
        graph,
        dialect: shape.dialect,
        predicate_labels,
    })
}

impl<'a> JsonMapper<'a, '_> {
    fn nodes(&mut self) -> Result<Vec<Object>, KgdiffError> {
        let mut nodes = Vec::new();
        for (index, raw) in self.shape.nodes.iter().enumerate() {
            if let Some(node) = self.node(raw, index)? {
                nodes.push(node);
            }
        }
        Ok(nodes)
    }

    fn edges(&mut self) -> Result<Vec<Object>, KgdiffError> {
        let mut edges = Vec::new();
        for (index, raw) in self.shape.edges.iter().enumerate() {
            edges.push(self.edge(raw, index)?);
        }
        edges.append(&mut self.extra_edges);
        Ok(edges)
    }

    fn place(&self, node: bool, index: usize) -> String {
        let key = if node {
            self.shape.nodes_key
        } else {
            self.shape.edges_key
        };
        format!("{key}[{index}]")
    }

    fn reader(
        &self,
        raw: &'a Value,
        node: bool,
        index: usize,
    ) -> Result<ElementReader<'a>, KgdiffError> {
        let Value::Object(raw) = raw else {
            return Err(invalid_input(format!(
                "{} is not an object.",
                self.place(node, index)
            )));
        };
        let ignored = if node {
            self.ignored.nodes
        } else {
            self.ignored.edges
        };
        let wrapped = |container: &'static str| -> Result<ElementReader<'a>, KgdiffError> {
            let record = match raw.get(container) {
                None | Some(Value::Null) => Cow::Owned(Object::new()),
                Some(Value::Object(record)) => Cow::Borrowed(record),
                Some(_) => {
                    return Err(invalid_input(format!(
                        "{}.{container} is not an object.",
                        self.place(node, index)
                    )));
                }
            };
            Ok(ElementReader {
                raw,
                record,
                container: Some(container),
                ignored,
                consumed: IndexSet::default(),
                consumed_raw: IndexSet::default(),
            })
        };
        match self.shape.dialect {
            JsonDialect::Cytoscape | JsonDialect::G6 => {
                let mut reader = wrapped("data")?;
                if self.shape.dialect == JsonDialect::Cytoscape {
                    reader.raw_value("group");
                }
                Ok(reader)
            }
            JsonDialect::Graphology => wrapped("attributes"),
            JsonDialect::Kgdiff | JsonDialect::D3 | JsonDialect::Vis => Ok(ElementReader {
                raw,
                record: Cow::Borrowed(raw),
                container: None,
                ignored,
                consumed: IndexSet::default(),
                consumed_raw: IndexSet::default(),
            }),
        }
    }

    fn node_id(
        &mut self,
        reader: &mut ElementReader<'a>,
        index: usize,
    ) -> Result<String, KgdiffError> {
        let dialect = self.shape.dialect;
        let id = if let Some(field) = &self.fields.id {
            reader.path(field, as_id)
        } else {
            match dialect {
                JsonDialect::G6 => {
                    as_id(reader.raw_value("id")).or_else(|| reader.first(&["id"], as_id))
                }
                JsonDialect::Graphology => as_id(reader.raw_value("key")),
                _ => reader.first(&["id"], as_id),
            }
        };
        if let Some(id) = id {
            return Ok(id);
        }
        if dialect == JsonDialect::D3 && self.fields.id.is_none() {
            self.warnings.count(
                ParseWarningCode::JsonIndexIds,
                |n| {
                    format!(
                        "{} without an id: using the array index as id (d3 index links).",
                        plural(n, "node")
                    )
                },
                1,
            );
            return Ok(index.to_string());
        }
        let expected = match &self.fields.id {
            Some(field) => format!("`{field}`"),
            None => match dialect {
                JsonDialect::Graphology => "`key`".to_owned(),
                JsonDialect::Cytoscape => "`data.id`".to_owned(),
                _ => "`id`".to_owned(),
            },
        };
        let mut details = Object::new();
        details.insert("index", index);
        Err(invalid_input_with(
            format!(
                "{} has no id (expected {expected} as a string or number).",
                self.place(true, index)
            ),
            details,
        ))
    }

    fn node(&mut self, raw: &'a Value, index: usize) -> Result<Option<Object>, KgdiffError> {
        let mut reader = self.reader(raw, true, index)?;
        let id = self.node_id(&mut reader, index)?;
        if self.ids_by_index.len() <= index {
            self.ids_by_index.resize(index + 1, None);
        }
        self.ids_by_index[index] = Some(id.clone());
        self.id_set.insert(id.clone());
        let dialect = self.shape.dialect;
        let fields = self.fields;

        let label = match &fields.label {
            Some(field) => reader.path(field, as_id),
            None => reader.first(LABEL_KEYS, as_id).or_else(|| {
                if dialect == JsonDialect::G6 {
                    g6_label(&mut reader)
                } else {
                    None
                }
            }),
        };
        let types = match &fields.r#type {
            Some(field) => reader.path(field, as_strings),
            None => reader.first(
                if dialect == JsonDialect::Vis {
                    VIS_TYPE_KEYS
                } else {
                    TYPE_KEYS
                },
                as_strings,
            ),
        };
        let aliases = reader.first(ALIAS_KEYS, as_strings);
        let deprecated = reader.first(&["deprecated"], as_boolean);
        let replaces = reader.first(&["replaces"], as_ids);
        let replaced_by = reader.first(&["replacedBy"], as_ids);
        let position = if dialect == JsonDialect::Kgdiff {
            reader.first(&["position"], as_point)
        } else {
            None
        };
        // Core's graphToJSON marks nodes it created for dangling edge ends; normalize recreates them.
        let implicit = if dialect == JsonDialect::Kgdiff {
            reader.first(&["implicit"], as_boolean)
        } else {
            None
        };

        if let Some(parent) = self.parent_of(&mut reader) {
            self.extra_edges.push(make_edge(&EdgeFields {
                source: id.clone(),
                target: parent,
                predicate: Some("parent".to_owned()),
                ..EdgeFields::default()
            }));
        }

        let mut attrs = AttrBag::new();
        if dialect == JsonDialect::Kgdiff {
            let own = reader.first(&["attrs"], as_record);
            reader.rest(&mut attrs, self.warnings)?;
            // Explicit `attrs` win over loose top-level fields with the same key.
            if let Some(own) = own {
                merge_attrs(&mut attrs, &own, self.warnings)?;
            }
        } else {
            reader.rest(&mut attrs, self.warnings)?;
        }

        self.note_dropped(&reader);
        let types = types.unwrap_or_default();
        let aliases = aliases.unwrap_or_default();
        let replaces = replaces.unwrap_or_default();
        let replaced_by = replaced_by.unwrap_or_default();
        let node = make_node(&NodeFields {
            id: &id,
            label: label.as_deref(),
            types: types.iter().map(String::as_str).collect(),
            aliases: aliases.iter().map(String::as_str).collect(),
            attrs: attrs.build(None),
            deprecated: deprecated == Some(true),
            replaces: replaces.iter().map(String::as_str).collect(),
            replaced_by: replaced_by.iter().map(String::as_str).collect(),
            position,
        });
        Ok(if implicit == Some(true) && node.len() == 1 {
            None
        } else {
            Some(node)
        })
    }

    /// Counts the keys an element loses, for one `json-ignored-fields` warning per parse.
    fn note_dropped(&mut self, reader: &ElementReader<'_>) {
        for key in reader.dropped() {
            *self.dropped.entry(key).or_insert(0) += 1;
        }
    }

    fn report_dropped(&mut self) {
        if self.dropped.is_empty() {
            return;
        }
        let mut entries: Vec<(&String, &usize)> = self.dropped.iter().collect();
        entries.sort_by(|a, b| compare_strings(a.0, b.0));
        let fields: Vec<String> = entries.iter().map(|(k, n)| format!("{k} ({n})")).collect();
        self.warnings.add(
            ParseWarningCode::JsonIgnoredFields,
            format!(
                "Ignored {} fields that are not part of the graph: {}.",
                self.shape.dialect.id(),
                fields.join(", ")
            ),
            None,
        );
    }

    /// Compound parents (Cytoscape `data.parent`, G6 `combo`) become `parent` edges.
    fn parent_of(&self, reader: &mut ElementReader<'a>) -> Option<String> {
        match self.shape.dialect {
            JsonDialect::Cytoscape => reader.first(&["parent"], as_id),
            JsonDialect::G6 => as_id(reader.raw_value("combo")),
            _ => None,
        }
    }

    fn endpoint(
        &self,
        reader: &mut ElementReader<'a>,
        source: bool,
        index: usize,
    ) -> Result<String, KgdiffError> {
        let field = if source {
            &self.fields.source
        } else {
            &self.fields.target
        };
        let end = if source { "source" } else { "target" };
        let dialect = self.shape.dialect;
        let vis_key = if source { "from" } else { "to" };
        let value: Option<Value> = if let Some(field) = field {
            reader.path(field, |v| v.filter(|v| !v.is_null()).cloned())
        } else if dialect == JsonDialect::Cytoscape {
            let value = reader.record.get(end).cloned();
            reader.consume(end);
            value
        } else {
            reader
                .raw_value(if dialect == JsonDialect::Vis {
                    vis_key
                } else {
                    end
                })
                .cloned()
        };
        let id = if dialect == JsonDialect::D3 {
            self.d3_endpoint(value.as_ref())
        } else {
            as_id(value.as_ref())
        };
        match id {
            Some(id) => Ok(id),
            None => {
                let expected = field.clone().unwrap_or_else(|| {
                    if dialect == JsonDialect::Vis {
                        vis_key.to_owned()
                    } else {
                        end.to_owned()
                    }
                });
                let mut details = Object::new();
                details.insert("index", index);
                Err(invalid_input_with(
                    format!(
                        "{} has no {end} (expected `{expected}` as a node id).",
                        self.place(false, index)
                    ),
                    details,
                ))
            }
        }
    }

    /// d3 link ends: a node id, a node index (when no node has that id) or a node object.
    fn d3_endpoint(&self, value: Option<&Value>) -> Option<String> {
        // `idsByIndex[x]`: only a non-negative integer below the length names an entry.
        let index = |x: f64| -> Option<usize> {
            (x.is_finite()
                && x.trunc() == x
                && x >= 0.0
                && x < count_to_f64(self.ids_by_index.len()))
            .then(|| f64_to_count(x))
        };
        match value {
            Some(Value::Object(o)) => {
                if let Some(id) = as_id(o.get("id")) {
                    return Some(id);
                }
                match o.get("index") {
                    Some(Value::Number(x)) => index(*x).and_then(|i| self.ids_by_index[i].clone()),
                    _ => None,
                }
            }
            Some(Value::Number(x)) if !self.id_set.contains(&js::number_to_string(*x)) => {
                match index(*x) {
                    Some(i) => self.ids_by_index[i].clone(),
                    None => as_id(value),
                }
            }
            _ => as_id(value),
        }
    }

    fn edge(&mut self, raw: &'a Value, index: usize) -> Result<Object, KgdiffError> {
        let mut reader = self.reader(raw, false, index)?;
        let dialect = self.shape.dialect;
        let source = self.endpoint(&mut reader, true, index)?;
        let target = self.endpoint(&mut reader, false, index)?;
        let id = match dialect {
            JsonDialect::Graphology => as_id(reader.raw_value("key")),
            JsonDialect::G6 => {
                as_id(reader.raw_value("id")).or_else(|| reader.first(&["id"], as_id))
            }
            _ => reader.first(&["id"], as_id),
        };
        let mut predicate = match &self.fields.predicate {
            Some(field) => reader.path(field, as_id),
            None => reader.first(PREDICATE_KEYS, as_id),
        };
        let label = reader.first(&["label"], as_id);
        // Visualisation formats often name the relation only in `label`; kgdiff JSON never does.
        if dialect != JsonDialect::Kgdiff && predicate.is_none() {
            predicate.clone_from(&label);
        }
        let mut attrs = AttrBag::new();
        if dialect == JsonDialect::Kgdiff {
            let own = reader.first(&["attrs"], as_record);
            reader.rest(&mut attrs, self.warnings)?;
            if let Some(own) = own {
                merge_attrs(&mut attrs, &own, self.warnings)?;
            }
        } else {
            reader.rest(&mut attrs, self.warnings)?;
        }
        if dialect == JsonDialect::Graphology
            && reader.raw_value("undirected") == Some(&Value::Bool(true))
        {
            attrs.add("undirected", Value::Bool(true));
        }
        self.note_dropped(&reader);
        Ok(make_edge(&EdgeFields {
            id,
            source,
            target,
            predicate,
            label,
            attrs: attrs.build(None),
        }))
    }
}

/// G6 v5 keeps the visible label in `style.labelText`.
fn g6_label(reader: &mut ElementReader<'_>) -> Option<String> {
    let label = as_id(
        reader
            .raw
            .get("style")
            .and_then(|s| s.as_object())
            .and_then(|s| s.get("labelText")),
    );
    if label.is_some() {
        reader.raw_value("style");
    }
    label
}

/// Overwrites bag entries with `own` (the explicit `attrs` object).
fn merge_attrs(
    bag: &mut AttrBag,
    own: &Object,
    warnings: &mut Warnings,
) -> Result<(), KgdiffError> {
    for (key, value) in own.iter() {
        if let Some(converted) = to_attr_value(value, 0, &mut || non_finite(warnings))? {
            bag.set(key.clone(), converted);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(text: &str) -> String {
        parse_json_text(text).unwrap_err().message
    }

    #[test]
    fn words_errors_as_typescript() {
        assert_eq!(
            error("{\n  \"nodes\": [\n    { \"id\": \"a\" },\n  ]\n}"),
            "Invalid JSON on line 4, column 3: expected a value, found \"]\"."
        );
        assert_eq!(
            error("{\"nodes\": ["),
            "Invalid JSON on line 1, column 12: expected a value, found end of input."
        );
        assert_eq!(
            error("{\"nodes\": [😀]}"),
            "Invalid JSON on line 1, column 12: expected a value, found \"\\ud83d\"."
        );
        assert_eq!(
            error("[\"\\ud83d\", 1,]"),
            "Invalid JSON on line 1, column 3: the escape \\ud83d is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept."
        );
    }

    #[test]
    fn reads_any_depth_and_locates_deep_errors() {
        let nested = |depth: usize, close: bool| {
            format!(
                "{{\"nodes\":[{{\"id\":\"a\",\"attrs\":{{\"x\":{}{}}}}}]}}",
                "[".repeat(depth),
                if close {
                    "]".repeat(depth)
                } else {
                    String::new()
                }
            )
        };
        assert!(parse_json_text(&nested(20_000, true)).is_ok());
        assert_eq!(
            error(&nested(20_000, false)),
            "Invalid JSON on line 1, column 1030: nested deeper than 1000 levels."
        );
        assert_eq!(
            parse_deep_json("\u{feff}{}"),
            Err(JsonTextError::Syntax {
                offset: 0,
                message: "Invalid JSON on line 1, column 1: expected a value".to_owned()
            })
        );
    }
}
