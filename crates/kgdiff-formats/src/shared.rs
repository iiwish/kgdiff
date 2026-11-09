//! Helpers every parser shares (`shared.ts`): deterministic ordering, attribute bags, node and
//! edge builders, hashing, warnings and error construction. Nothing here knows a format.

use std::cmp::Ordering;

use kgdiff_core::canonical::Cyrb53;
use kgdiff_core::js::{self, IndexMap, IndexSet, JsStr, Object, Value, json};
use kgdiff_core::{ErrorCode, KgdiffError};

use crate::{ParseWarning, ParseWarningCode};

/// UTF-16 code unit order (`compareStrings`), the order of every sort in the parsers.
pub fn compare_strings(a: &str, b: &str) -> Ordering {
    js::cmp_utf16(a, b)
}

/// Sorted, de-duplicated copy of `values` (code unit order), as `sortedUnique`.
pub fn sorted_unique<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let set: IndexSet<&str> = values.into_iter().collect();
    let mut out: Vec<String> = set.into_iter().map(str::to_owned).collect();
    out.sort_by(|a, b| compare_strings(a, b));
    out
}

// ─── Attribute values ────────────────────────────────────────────────────────

/// Deepest nesting of arrays and objects accepted in attribute values (`MAX_NESTING`).
pub const MAX_NESTING: usize = 1000;

/// `toAttrValue`: a parsed JSON value as an attribute value, object keys sorted recursively.
/// Numbers beyond the double range (read as ±∞) are kept as `"Infinity"` / `"-Infinity"` and
/// counted through `on_non_finite` (RFC 0002, D-11). `None` is JavaScript's `undefined`, which
/// a JSON value never is; it is kept for the shape of the TypeScript function.
pub fn to_attr_value(
    value: &Value,
    depth: usize,
    on_non_finite: &mut dyn FnMut(),
) -> Result<Option<Value>, KgdiffError> {
    Ok(Some(match value {
        Value::Null | Value::Bool(_) | Value::String(_) => value.clone(),
        Value::Number(x) => {
            if x.is_finite() {
                value.clone()
            } else {
                on_non_finite();
                Value::String(JsStr::from(js::number_to_string(*x)))
            }
        }
        Value::Array(items) => {
            check_depth(depth)?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(to_attr_value(item, depth + 1, on_non_finite)?.unwrap_or(Value::Null));
            }
            Value::Array(out)
        }
        Value::Object(record) => {
            check_depth(depth)?;
            let mut keys: Vec<&JsStr> = record.keys().collect();
            keys.sort();
            let mut out = Object::with_capacity(keys.len());
            for key in keys {
                if let Some(item) = record.get(key)
                    && let Some(converted) = to_attr_value(item, depth + 1, on_non_finite)?
                {
                    out.insert(key.clone(), converted);
                }
            }
            Value::Object(out)
        }
    }))
}

fn check_depth(depth: usize) -> Result<(), KgdiffError> {
    if depth >= MAX_NESTING {
        return Err(invalid_input(format!(
            "Values nested deeper than {MAX_NESTING} levels are not supported."
        )));
    }
    Ok(())
}

/// `canonicalJson` of `shared.ts`: object keys in code-unit order (not array indices first),
/// to compare and de-duplicate attribute values.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    push_canonical(&mut out, value);
    out
}

fn push_canonical(out: &mut String, value: &Value) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_canonical(out, item);
            }
            out.push(']');
        }
        Value::Object(record) => {
            let mut keys: Vec<&JsStr> = record.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json::push_string(out, key);
                out.push(':');
                push_canonical(out, record.get(key).unwrap_or(&Value::Null));
            }
            out.push('}');
        }
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(x) => json::push_json_number(out, *x),
        Value::String(s) => json::push_string(out, s),
    }
}

fn value_rank(value: &Value) -> u8 {
    match value {
        Value::Null => 0,
        Value::Bool(_) => 1,
        Value::Number(_) => 2,
        Value::String(_) => 3,
        Value::Array(_) => 4,
        Value::Object(_) => 5,
    }
}

/// `compareAttrValues`: null < booleans < numbers < strings < arrays < objects.
fn compare_attr_values(a: &Value, b: &Value) -> Ordering {
    let rank = value_rank(a).cmp(&value_rank(b));
    if rank != Ordering::Equal {
        return rank;
    }
    match (a, b) {
        // `a - b` as a comparator: ties (and NaN) keep their order.
        (Value::Number(x), Value::Number(y)) => {
            let d = x - y;
            if d < 0.0 {
                Ordering::Less
            } else if d > 0.0 {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        }
        (Value::String(x), Value::String(y)) => compare_strings(x, y),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        _ => compare_strings(&canonical_json(a), &canonical_json(b)),
    }
}

/// Collects attribute values per key (`AttrBag`). `build` sorts keys, de-duplicates values and
/// turns a single value into a scalar (several become a sorted array), unless the key is listed
/// as always an array.
#[derive(Default, Debug, Clone)]
pub struct AttrBag {
    values: IndexMap<JsStr, Vec<Value>>,
}

impl AttrBag {
    pub fn new() -> AttrBag {
        AttrBag::default()
    }

    pub fn add(&mut self, key: impl Into<JsStr>, value: Value) {
        self.values.entry(key.into()).or_default().push(value);
    }

    /// Replaces every value collected for `key`.
    pub fn set(&mut self, key: impl Into<JsStr>, value: Value) {
        let key = key.into();
        match self.values.get_mut(&key) {
            Some(list) => *list = vec![value],
            None => {
                self.values.insert(key, vec![value]);
            }
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    pub fn build(&self, always_array: Option<&[&str]>) -> Option<Object> {
        if self.values.is_empty() {
            return None;
        }
        let mut keys: Vec<&JsStr> = self.values.keys().collect();
        keys.sort();
        let mut out = Object::with_capacity(keys.len());
        for key in keys {
            let mut unique: IndexMap<String, &Value> = IndexMap::default();
            for value in &self.values[key] {
                unique.insert(canonical_json(value), value);
            }
            let mut sorted: Vec<&Value> = unique.into_values().collect();
            sorted.sort_by(|a, b| compare_attr_values(a, b));
            let list = always_array.is_some_and(|keys| keys.contains(&key.as_str()));
            let value = if sorted.len() == 1 && !list {
                sorted[0].clone()
            } else {
                Value::Array(sorted.into_iter().cloned().collect())
            };
            out.insert(key.clone(), value);
        }
        Some(out)
    }
}

// ─── Nodes and edges ─────────────────────────────────────────────────────────

/// A node position (`Point`), as JSON gives it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// Mutable accumulator for one node (`NodeBuilder`); `build` emits a `NodeInput` without empty
/// fields.
#[derive(Debug, Clone)]
pub struct NodeBuilder {
    pub id: String,
    pub label: Option<String>,
    pub types: IndexSet<String>,
    pub aliases: IndexSet<String>,
    pub attrs: AttrBag,
    pub deprecated: bool,
    pub replaces: IndexSet<String>,
    pub replaced_by: IndexSet<String>,
}

impl NodeBuilder {
    pub fn new(id: impl Into<String>) -> NodeBuilder {
        NodeBuilder {
            id: id.into(),
            label: None,
            types: IndexSet::default(),
            aliases: IndexSet::default(),
            attrs: AttrBag::new(),
            deprecated: false,
            replaces: IndexSet::default(),
            replaced_by: IndexSet::default(),
        }
    }

    pub fn build(&self, always_array: Option<&[&str]>) -> Object {
        make_node(&NodeFields {
            id: &self.id,
            label: self.label.as_deref(),
            types: self.types.iter().map(String::as_str).collect(),
            aliases: self.aliases.iter().map(String::as_str).collect(),
            attrs: self.attrs.build(always_array),
            deprecated: self.deprecated,
            replaces: self.replaces.iter().map(String::as_str).collect(),
            replaced_by: self.replaced_by.iter().map(String::as_str).collect(),
            position: None,
        })
    }
}

/// The fields of `makeNode`.
#[derive(Default)]
pub struct NodeFields<'a> {
    pub id: &'a str,
    pub label: Option<&'a str>,
    pub types: Vec<&'a str>,
    pub aliases: Vec<&'a str>,
    pub attrs: Option<Object>,
    pub deprecated: bool,
    pub replaces: Vec<&'a str>,
    pub replaced_by: Vec<&'a str>,
    pub position: Option<Position>,
}

fn strings(values: Vec<String>) -> Value {
    Value::Array(values.into_iter().map(Value::from).collect())
}

/// `makeNode`: a `NodeInput` in a fixed key order without empty fields. One type becomes a
/// string, several a sorted array; aliases are sorted and never repeat the label.
pub fn make_node(fields: &NodeFields<'_>) -> Object {
    let types = sorted_unique(fields.types.iter().copied());
    let label = fields.label.unwrap_or(fields.id);
    let aliases: Vec<String> = sorted_unique(fields.aliases.iter().copied())
        .into_iter()
        .filter(|alias| alias != label)
        .collect();
    let replaces = sorted_unique(fields.replaces.iter().copied());
    let replaced_by = sorted_unique(fields.replaced_by.iter().copied());
    let mut node = Object::new();
    node.insert("id", fields.id);
    if let Some(label) = fields.label
        && label != fields.id
    {
        node.insert("label", label);
    }
    match types.len() {
        0 => {}
        1 => {
            node.insert("type", types[0].as_str());
        }
        _ => {
            node.insert("type", strings(types));
        }
    }
    if !aliases.is_empty() {
        node.insert("aliases", strings(aliases));
    }
    if let Some(attrs) = &fields.attrs
        && !attrs.is_empty()
    {
        node.insert("attrs", Value::Object(attrs.clone()));
    }
    if fields.deprecated {
        node.insert("deprecated", true);
    }
    if !replaces.is_empty() {
        node.insert("replaces", strings(replaces));
    }
    if !replaced_by.is_empty() {
        node.insert("replacedBy", strings(replaced_by));
    }
    if let Some(Position { x, y }) = fields.position {
        let mut point = Object::new();
        point.insert("x", x);
        point.insert("y", y);
        node.insert("position", Value::Object(point));
    }
    node
}

/// The fields of `makeEdge` (`EdgeFields`).
#[derive(Default, Clone, Debug)]
pub struct EdgeFields {
    pub id: Option<String>,
    pub source: String,
    pub target: String,
    pub predicate: Option<String>,
    pub label: Option<String>,
    pub attrs: Option<Object>,
}

/// `makeEdge`: an `EdgeInput` in a fixed key order without empty fields (an empty label is
/// kept: it differs from the default).
pub fn make_edge(fields: &EdgeFields) -> Object {
    let mut edge = Object::new();
    if let Some(id) = &fields.id {
        edge.insert("id", id.as_str());
    }
    edge.insert("source", fields.source.as_str());
    edge.insert("target", fields.target.as_str());
    if let Some(predicate) = &fields.predicate
        && !predicate.is_empty()
    {
        edge.insert("predicate", predicate.as_str());
    }
    if let Some(label) = &fields.label {
        edge.insert("label", label.as_str());
    }
    if let Some(attrs) = &fields.attrs
        && !attrs.is_empty()
    {
        edge.insert("attrs", Value::Object(attrs.clone()));
    }
    edge
}

fn text_of<'a>(object: &'a Object, key: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `sortNodes`: by id, ties (duplicate ids) by `JSON.stringify(node)`.
pub fn sort_nodes(nodes: &mut [Object]) {
    nodes.sort_by(|a, b| {
        compare_strings(text_of(a, "id"), text_of(b, "id")).then_with(|| {
            let a = json::to_string(&Value::Object(a.clone()));
            let b = json::to_string(&Value::Object(b.clone()));
            compare_strings(&a, &b)
        })
    });
}

/// `sortEdges`: by (source, predicate, target, id, label, attrs).
pub fn sort_edges(edges: &mut [Object]) {
    let attrs = |edge: &Object| match edge.get("attrs") {
        Some(value @ Value::Object(_)) => canonical_json(value),
        _ => String::new(),
    };
    edges.sort_by(|a, b| {
        compare_strings(text_of(a, "source"), text_of(b, "source"))
            .then_with(|| compare_strings(text_of(a, "predicate"), text_of(b, "predicate")))
            .then_with(|| compare_strings(text_of(a, "target"), text_of(b, "target")))
            .then_with(|| compare_strings(text_of(a, "id"), text_of(b, "id")))
            .then_with(|| compare_strings(text_of(a, "label"), text_of(b, "label")))
            .then_with(|| compare_strings(&attrs(a), &attrs(b)))
    });
}

/// `makeMeta`: keys sorted, `undefined` and `''` dropped; `None` when nothing is left.
/// `None` values stand for `undefined`.
pub fn make_meta(meta: Vec<(JsStr, Option<Value>)>) -> Option<Object> {
    let mut entries: Vec<(JsStr, Option<Value>)> = meta;
    // Later duplicates win, at the position of the first (an object's assignment).
    let mut merged: IndexMap<JsStr, Option<Value>> = IndexMap::default();
    for (key, value) in entries.drain(..) {
        merged.insert(key, value);
    }
    let mut keys: Vec<JsStr> = merged.keys().cloned().collect();
    keys.sort();
    let mut out = Object::new();
    for key in keys {
        match merged.swap_remove(&key).flatten() {
            None => {}
            Some(Value::String(s)) if s.is_empty() => {}
            Some(value) => {
                out.insert(key, value);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/// `hash53`: 53-bit cyrb53 of the UTF-16 code units, as 14 hex digits.
pub fn hash53(text: &str) -> String {
    let (h1, h2) = Cyrb53::new(0).update(text).digest_pair();
    format!("{:06x}{:08x}", h2 & 0x1f_ffff, h1)
}

// ─── Warnings and errors ─────────────────────────────────────────────────────

/// Collects warnings; counted warnings are reported once with their total (`Warnings`).
#[derive(Default)]
pub struct Warnings {
    list: Vec<ParseWarning>,
    counts: IndexMap<ParseWarningCode, (usize, Message)>,
}

/// The message of a counted warning, given the count.
type Message = fn(usize) -> String;

impl Warnings {
    pub fn new() -> Warnings {
        Warnings::default()
    }

    pub fn add(&mut self, code: ParseWarningCode, message: impl Into<String>, line: Option<usize>) {
        self.list.push(ParseWarning {
            code,
            message: message.into(),
            line,
        });
    }

    /// Counts an occurrence; `finish` emits one warning per code with `message(total)`.
    pub fn count(&mut self, code: ParseWarningCode, message: Message, by: usize) {
        self.counts
            .entry(code)
            .and_modify(|(count, _)| *count += by)
            .or_insert((by, message));
    }

    pub fn finish(self) -> Vec<ParseWarning> {
        let mut counted: Vec<(ParseWarningCode, usize, Message)> = self
            .counts
            .into_iter()
            .map(|(code, (count, message))| (code, count, message))
            .collect();
        counted.sort_by(|a, b| compare_strings(a.0.as_str(), b.0.as_str()));
        let mut out = self.list;
        out.extend(
            counted
                .into_iter()
                .map(|(code, count, message)| ParseWarning {
                    code,
                    message: message(count),
                    line: None,
                }),
        );
        out
    }
}

/// `plural(count, word)`: `1 node`, `2 nodes`.
pub fn plural(count: usize, word: &str) -> String {
    if count == 1 {
        format!("{count} {word}")
    } else {
        format!("{count} {word}s")
    }
}

/// A `KgdiffError('invalid-input')`.
pub fn invalid_input(message: impl Into<String>) -> KgdiffError {
    KgdiffError::new(ErrorCode::InvalidInput, message)
}

/// A `KgdiffError('invalid-input')` with details.
pub fn invalid_input_with(message: impl Into<String>, details: Object) -> KgdiffError {
    invalid_input(message).with_details(details)
}

/// Details `{ line, column }`.
pub fn line_column_details(line: usize, column: usize) -> Object {
    let mut details = Object::new();
    details.insert("line", line);
    details.insert("column", column);
    details
}

/// Details `{ line }`.
pub fn line_details(line: usize) -> Object {
    let mut details = Object::new();
    details.insert("line", line);
    details
}

/// `stripBom`: one leading U+FEFF removed.
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// The byte index of UTF-16 offset `units` in `text` (clamped to its end). An offset in the
/// middle of a surrogate pair maps to the start of that character.
pub fn byte_index(text: &str, units: usize) -> usize {
    let mut count = 0;
    for (i, c) in text.char_indices() {
        if count >= units {
            return i;
        }
        count += c.len_utf16();
        if count > units {
            return i;
        }
    }
    text.len()
}

/// `text.slice(0, units)` in UTF-16 units, for messages: a cut through a surrogate pair keeps
/// the half as U+FFFD, which is what JavaScript's half pair becomes when written as UTF-8.
pub fn slice_utf16(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    for c in text.chars() {
        let len = c.len_utf16();
        if count + len > units {
            if count < units {
                out.push('\u{fffd}');
            }
            break;
        }
        out.push(c);
        count += len;
    }
    out
}

// ─── Typed literals ──────────────────────────────────────────────────────────

const XSD_INTEGERS: &[&str] = &[
    "integer",
    "int",
    "long",
    "short",
    "byte",
    "nonNegativeInteger",
    "positiveInteger",
    "negativeInteger",
    "nonPositiveInteger",
    "unsignedLong",
    "unsignedInt",
    "unsignedShort",
    "unsignedByte",
];
const XSD_DECIMALS: &[&str] = &["decimal", "double", "float"];

/// `/^[+-]?\d+$/`.
fn is_integer_lexical(text: &str) -> bool {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/`.
fn is_decimal_lexical(text: &str) -> bool {
    let b = text.strip_prefix(['+', '-']).unwrap_or(text).as_bytes();
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits(0);
    let mut i;
    if int > 0 {
        i = int;
        if b.get(i) == Some(&b'.') {
            i += 1;
            i += digits(i);
        }
    } else if b.first() == Some(&b'.') {
        let frac = digits(1);
        if frac == 0 {
            return false;
        }
        i = 1 + frac;
    } else {
        return false;
    }
    if let Some(b'e' | b'E') = b.get(i) {
        i += 1;
        if let Some(b'+' | b'-') = b.get(i) {
            i += 1;
        }
        let exp = digits(i);
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == b.len()
}

/// `Number.isSafeInteger`.
pub fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x && x.abs() <= 9_007_199_254_740_991.0
}

/// `typedValue`: the JSON value of a literal with an XSD datatype (`xsd_type` is the local name):
/// numeric types become numbers (integers only when safe), `boolean` a boolean; everything else,
/// lexical forms that do not parse included, stays the lexical string.
pub fn typed_value(lexical: &str, xsd_type: Option<&str>) -> Value {
    let Some(xsd_type) = xsd_type else {
        return Value::from(lexical);
    };
    let trimmed = js::trim(lexical);
    if XSD_INTEGERS.contains(&xsd_type) {
        if !is_integer_lexical(trimmed) {
            return Value::from(lexical);
        }
        let value = js::number_from_str(trimmed);
        return if is_safe_integer(value) {
            Value::Number(value)
        } else {
            Value::from(lexical)
        };
    }
    if XSD_DECIMALS.contains(&xsd_type) {
        if !is_decimal_lexical(trimmed) {
            return Value::from(lexical);
        }
        let value = js::number_from_str(trimmed);
        return if value.is_finite() {
            Value::Number(value)
        } else {
            Value::from(lexical)
        };
    }
    if xsd_type == "boolean" {
        if trimmed == "true" || trimmed == "1" {
            return Value::Bool(true);
        }
        if trimmed == "false" || trimmed == "0" {
            return Value::Bool(false);
        }
    }
    Value::from(lexical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_forms() {
        for ok in ["1", "+1", "-007"] {
            assert!(is_integer_lexical(ok), "{ok}");
        }
        for bad in ["", "+", "1.0", " 1", "١"] {
            assert!(!is_integer_lexical(bad), "{bad}");
        }
        for ok in ["1", "1.", "1.5", ".5", "-1e5", "+1.5E-3", "1.e2"] {
            assert!(is_decimal_lexical(ok), "{ok}");
        }
        for bad in ["", ".", "e5", "1e", "1e+", "..5", "1.5.5", "Infinity"] {
            assert!(!is_decimal_lexical(bad), "{bad}");
        }
    }

    #[test]
    fn typed_values() {
        assert_eq!(typed_value("42", Some("integer")), Value::Number(42.0));
        assert_eq!(
            typed_value("600000000000000000000", Some("integer")),
            Value::from("600000000000000000000")
        );
        assert_eq!(typed_value(" 4.50 ", Some("decimal")), Value::Number(4.5));
        assert_eq!(typed_value("1e400", Some("double")), Value::from("1e400"));
        assert_eq!(typed_value("1", Some("boolean")), Value::Bool(true));
        assert_eq!(typed_value("yes", Some("boolean")), Value::from("yes"));
        assert_eq!(typed_value("x", None), Value::from("x"));
    }

    #[test]
    fn hashes_like_typescript() {
        // hash53 of shared.ts, computed with Node.
        assert_eq!(hash53(""), "0bdcb81aee8d83");
        assert_eq!(hash53("abc"), "11f9f91ac18c8d");
        assert_eq!(hash53("😀x"), "08402aa946aaa6");
    }

    #[test]
    fn slices_in_utf16_units() {
        assert_eq!(slice_utf16("ab😀c", 3), "ab\u{fffd}");
        assert_eq!(slice_utf16("ab😀c", 4), "ab😀");
        assert_eq!(byte_index("a😀b", 2), 1);
        assert_eq!(byte_index("a😀b", 3), 5);
    }
}
