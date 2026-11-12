//! kgdiff's own JSON reader and writer (RFC 0002, §4.1 and D-12): `JSON.parse` and
//! `JSON.stringify` as JavaScript runs them, without serde_json.
//!
//! - **Numbers** are doubles, read with a correctly rounded conversion (`9007199254740993` is
//!   `9007199254740992`, `1e400` is `Infinity`, J-02) and written as `Number::toString` writes
//!   them (`1`, `1e+21`, `0.000001`; NaN and ±∞ as `null`, J-01).
//! - **Objects** are [`Object`]s: array-index keys first (J-21), a duplicate key's last value at
//!   the position of its first (J-23), `__proto__` an ordinary key (J-24).
//! - **Strings** are escaped as `JSON.stringify` escapes them (J-05).
//! - **Errors** carry the position in UTF-16 code units and what was expected there, in the words
//!   of the JSON reader of `@kgdiff/formats` (J-54), so that the messages built from them match.
//! - **Lone surrogates** (`"\ud800"`: half of a surrogate pair, escaped without its other half),
//!   which `JSON.parse` accepts, are rejected, as kgdiff's TypeScript readers reject them
//!   (RFC 0002, D-2; `json-roundtrip.json` and the `cli-errors` case pin it).
//! - **Repeated text** is shared: a property name or a short string read again shortly after is
//!   the same [`JsStr`], as JavaScript engines share property names, so that the records of a
//!   large graph do not each hold their own copy of `"source"` or `"knows"`.
//! - **Nesting** is limited ([`Parser::max_depth`], 1,000 levels by default as in kgdiff's JSON
//!   reader), where `JSON.parse` has none.

use std::fmt;

use super::JsStr;
use super::number::push_number;
use super::object::Object;
use super::value::Value;

/// Which array of a graph document an element comes from ([`Parser::stream_graph`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GraphSection {
    Nodes,
    Edges,
}

/// How deeply arrays and objects may nest by default.
pub const DEFAULT_MAX_DEPTH: usize = 1000;

/// Why a text is not JSON that kgdiff reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// A syntax error: what was expected at the position (`a value`, `',' or ']'`, …).
    Expected(&'static str),
    /// Arrays and objects nested deeper than the limit.
    TooDeep(usize),
    /// A `\uD800`–`\uDFFF` escape that is not half of an escaped surrogate pair (RFC 0002,
    /// D-2), as written in the text (`\ud83d`); the error's position is its backslash.
    LoneSurrogate(String),
}

/// A JSON syntax error and where it is.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Error {
    pub kind: ErrorKind,
    /// Offset of the error in UTF-16 code units (JavaScript string indices).
    pub offset: usize,
    /// 1-based line (lines end at `\n`) and column in UTF-16 code units of `offset`.
    pub line: usize,
    pub column: usize,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Error { line, column, .. } = self;
        match &self.kind {
            ErrorKind::Expected(what) => {
                write!(
                    f,
                    "Invalid JSON on line {line}, column {column}: expected {what}"
                )
            }
            ErrorKind::TooDeep(max) => write!(
                f,
                "Invalid JSON on line {line}, column {column}: nested deeper than {max} levels"
            ),
            ErrorKind::LoneSurrogate(escape) => write!(
                f,
                "Invalid JSON on line {line}, column {column}: the escape {escape} is a lone \
                 surrogate (half of a UTF-16 pair), which kgdiff does not accept"
            ),
        }
    }
}

impl std::error::Error for Error {}

/// `JSON.parse(text)` (see the module documentation for where it differs).
pub fn parse(text: &str) -> Result<Value, Error> {
    Parser::new(text).parse()
}

/// A JSON reader with options.
pub struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
    max_depth: usize,
    /// Recently read short strings without escapes, by a hash of their text.
    recent: Vec<Option<JsStr>>,
}

/// Slots of [`Parser::recent`] (a power of two).
const RECENT: usize = 256;
/// Strings up to this many bytes are shared.
const SHORT: usize = 32;

/// The slot of a short string's text in [`Parser::recent`].
fn slot(text: &[u8]) -> usize {
    let mut hash: u32 = 0x811c_9dc5;
    for &b in text {
        hash = (hash ^ u32::from(b)).wrapping_mul(0x0100_0193);
    }
    usize::try_from(hash).unwrap_or(0) & (RECENT - 1)
}

type Fail<T> = Result<T, (usize, ErrorKind)>;

impl<'a> Parser<'a> {
    pub fn new(text: &'a str) -> Parser<'a> {
        Parser {
            text,
            bytes: text.as_bytes(),
            at: 0,
            max_depth: DEFAULT_MAX_DEPTH,
            recent: vec![None; RECENT],
        }
    }

    /// Arrays and objects may nest `max_depth` levels deep (the top-level value is level 0).
    #[must_use]
    pub fn max_depth(mut self, max_depth: usize) -> Parser<'a> {
        self.max_depth = max_depth;
        self
    }

    pub fn parse(mut self) -> Result<Value, Error> {
        let result = self.value(0).and_then(|value| {
            self.space();
            if self.at < self.bytes.len() {
                Err((self.at, ErrorKind::Expected("end of input")))
            } else {
                Ok(value)
            }
        });
        result.map_err(|(at, kind)| {
            let offset = super::utf16_len(&self.text[..at]);
            let (line, column) = line_and_column(self.text, offset);
            Error {
                kind,
                offset,
                line,
                column,
            }
        })
    }

    /// Reads a graph document member by member: each element of its `nodes` array and then of
    /// its `edges` array goes to `each` as soon as it is read, and is not kept; the other members
    /// are returned. `None` for a document that has to be read whole to know what it means: not
    /// an object, either array missing, repeated or out of order, `each` returning false, or a
    /// syntax error.
    pub(crate) fn stream_graph(
        mut self,
        each: &mut dyn FnMut(GraphSection, Value) -> bool,
    ) -> Option<Object> {
        self.space();
        if self.peek() != Some(b'{') {
            return None;
        }
        self.at += 1;
        let mut rest = Object::new();
        let (mut nodes_seen, mut edges_seen) = (false, false);
        self.space();
        if self.peek() == Some(b'}') {
            return None;
        }
        loop {
            self.space();
            if self.peek() != Some(b'"') {
                return None;
            }
            let key = self.shared_string().ok()?;
            self.space();
            if self.peek() != Some(b':') {
                return None;
            }
            self.at += 1;
            match key.as_str() {
                "nodes" if !nodes_seen && !edges_seen => {
                    nodes_seen = true;
                    self.stream_array(GraphSection::Nodes, each)?;
                }
                "edges" if nodes_seen && !edges_seen => {
                    edges_seen = true;
                    self.stream_array(GraphSection::Edges, each)?;
                }
                "nodes" | "edges" => return None,
                _ => {
                    let value = self.value(1).ok()?;
                    rest.insert(key, value);
                }
            }
            self.space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    break;
                }
                _ => return None,
            }
        }
        self.space();
        (nodes_seen && self.at == self.bytes.len()).then_some(rest)
    }

    /// The elements of an array at the top of a graph document, or `None`.
    fn stream_array(
        &mut self,
        section: GraphSection,
        each: &mut dyn FnMut(GraphSection, Value) -> bool,
    ) -> Option<()> {
        self.space();
        if self.peek() != Some(b'[') {
            return None;
        }
        self.at += 1;
        self.space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Some(());
        }
        loop {
            let item = self.value(2).ok()?;
            if !each(section, item) {
                return None;
            }
            self.space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Some(());
                }
                _ => return None,
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn expected<T>(&self, what: &'static str) -> Fail<T> {
        Err((self.at, ErrorKind::Expected(what)))
    }

    fn space(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.at += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Fail<Value> {
        self.space();
        match self.peek() {
            Some(b'{' | b'[') if depth >= self.max_depth => {
                Err((self.at, ErrorKind::TooDeep(self.max_depth)))
            }
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.shared_string().map(Value::String),
            Some(b't') if self.bytes[self.at..].starts_with(b"true") => {
                self.at += 4;
                Ok(Value::Bool(true))
            }
            Some(b'f') if self.bytes[self.at..].starts_with(b"false") => {
                self.at += 5;
                Ok(Value::Bool(false))
            }
            Some(b'n') if self.bytes[self.at..].starts_with(b"null") => {
                self.at += 4;
                Ok(Value::Null)
            }
            _ => self.number(),
        }
    }

    fn object(&mut self, depth: usize) -> Fail<Value> {
        self.at += 1;
        let mut object = Object::new();
        self.space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Value::Object(object));
        }
        loop {
            self.space();
            if self.peek() != Some(b'"') {
                return self.expected("a property name in double quotes");
            }
            let key = self.shared_string()?;
            self.space();
            if self.peek() != Some(b':') {
                return self.expected("':'");
            }
            self.at += 1;
            let value = self.value(depth + 1)?;
            object.insert(key, value);
            self.space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Value::Object(object));
                }
                _ => return self.expected("',' or '}'"),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Fail<Value> {
        self.at += 1;
        let mut items = Vec::new();
        self.space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Value::Array(items));
                }
                _ => return self.expected("',' or ']'"),
            }
        }
    }

    /// A string starting at the opening quote, the same `JsStr` as a recent one with its text if
    /// it is short and has no escapes.
    fn shared_string(&mut self) -> Fail<JsStr> {
        let from = self.at + 1;
        let end = self.bytes[from..]
            .iter()
            .take(SHORT + 1)
            .position(|&b| b == b'"' || b == b'\\' || b < 0x20)
            .map(|n| from + n);
        let Some(end) = end.filter(|&end| self.bytes[end] == b'"') else {
            return self.string();
        };
        let text = &self.bytes[from..end];
        let at = slot(text);
        if let Some(seen) = &self.recent[at]
            && seen.as_bytes() == text
        {
            self.at = end + 1;
            return Ok(seen.clone());
        }
        let s = self.string()?;
        self.recent[at] = Some(s.clone());
        Ok(s)
    }

    /// A string starting at the opening quote.
    fn string(&mut self) -> Fail<JsStr> {
        self.at += 1;
        let mut out: Option<String> = None;
        let mut start = self.at;
        loop {
            let Some(b) = self.peek() else {
                return self.expected("a closing quote");
            };
            match b {
                b'"' => {
                    let text = &self.text[start..self.at];
                    self.at += 1;
                    return Ok(match out {
                        None => JsStr::from(text),
                        Some(mut s) => {
                            s.push_str(text);
                            JsStr::from(s)
                        }
                    });
                }
                b'\\' => {
                    let s = out.get_or_insert_with(String::new);
                    s.push_str(&self.text[start..self.at]);
                    self.at += 1;
                    let c = self.escape()?;
                    out.get_or_insert_with(String::new).push(c);
                    start = self.at;
                }
                0x00..=0x1F => return self.expected("an escaped control character"),
                _ => self.at += 1,
            }
        }
    }

    /// The character of an escape sequence, after its backslash.
    fn escape(&mut self) -> Fail<char> {
        let c = match self.peek() {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'/') => '/',
            Some(b'b') => '\u{8}',
            Some(b'f') => '\u{C}',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                let escape = self.at - 1;
                let high = self
                    .hex4(self.at + 1)
                    .ok_or((self.at, ErrorKind::Expected("an escape sequence")))?;
                self.at += 5;
                if !(0xD800..=0xDFFF).contains(&high) {
                    return Ok(char::from_u32(high).unwrap_or('\u{FFFD}'));
                }
                // A high surrogate followed by an escaped low surrogate is one character.
                let low = (high < 0xDC00 && self.bytes[self.at..].starts_with(b"\\u"))
                    .then(|| self.hex4(self.at + 2))
                    .flatten()
                    .filter(|low| (0xDC00..=0xDFFF).contains(low));
                let Some(low) = low else {
                    let written = self.text[escape..escape + 6].to_owned();
                    return Err((escape, ErrorKind::LoneSurrogate(written)));
                };
                self.at += 6;
                let code = 0x1_0000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                return Ok(char::from_u32(code).unwrap_or('\u{FFFD}'));
            }
            _ => return self.expected("an escape sequence"),
        };
        self.at += 1;
        Ok(c)
    }

    fn hex4(&self, at: usize) -> Option<u32> {
        let digits = self.bytes.get(at..at + 4)?;
        digits
            .iter()
            .try_fold(0, |acc, &d| Some(acc << 4 | char::from(d).to_digit(16)?))
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, converted with correct rounding.
    fn number(&mut self) -> Fail<Value> {
        let start = self.at;
        let digits = |p: &Self, at: usize| {
            p.bytes[at..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count()
        };
        let mut at = start;
        if self.bytes.get(at) == Some(&b'-') {
            at += 1;
        }
        match self.bytes.get(at) {
            Some(b'0') => at += 1,
            Some(b'1'..=b'9') => at += digits(self, at),
            _ => return self.expected("a value"),
        }
        if self.bytes.get(at) == Some(&b'.') && digits(self, at + 1) > 0 {
            at += 1 + digits(self, at + 1);
        }
        if let Some(b'e' | b'E') = self.bytes.get(at) {
            let sign = usize::from(matches!(self.bytes.get(at + 1), Some(b'+' | b'-')));
            let exp = digits(self, at + 1 + sign);
            if exp > 0 {
                at += 1 + sign + exp;
            }
        }
        self.at = at;
        // A JSON number is a decimal literal Rust's correctly rounded conversion reads (overflow
        // gives ±∞, as JSON.parse).
        let x = self.text[start..at].parse::<f64>().unwrap_or(f64::NAN);
        Ok(Value::Number(x))
    }
}

/// 1-based line and column (in UTF-16 code units) of a UTF-16 offset; lines end at `\n`
/// (`lineAndColumn` of `@kgdiff/formats`).
pub fn line_and_column(text: &str, offset: usize) -> (usize, usize) {
    let (mut line, mut line_start, mut i) = (1, 0, 0);
    for c in text.chars() {
        if i >= offset {
            break;
        }
        i += c.len_utf16();
        if c == '\n' {
            line += 1;
            line_start = i;
        }
    }
    (line, i.min(offset) - line_start + 1)
}

/// `JSON.stringify(value)`.
pub fn to_string(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn to_string_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(2), 0);
    out
}

/// Appends `JSON.stringify(text)` to `out` (J-05): `"` and `\` escaped, `\b \f \n \r \t`, other
/// control characters as lowercase `\u00xx`, everything else (DEL, U+2028, U+2029) as it is.
pub fn push_string(out: &mut String, text: &str) {
    out.push('"');
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        let escape = match b {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            0x08 => "\\b",
            0x0C => "\\f",
            b'\n' => "\\n",
            b'\r' => "\\r",
            b'\t' => "\\t",
            0x00..=0x1F => "",
            _ => continue,
        };
        out.push_str(&text[start..i]);
        if escape.is_empty() {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            out.push_str("\\u00");
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 0xF)]));
        } else {
            out.push_str(escape);
        }
        start = i + 1;
    }
    out.push_str(&text[start..]);
    out.push('"');
}

/// Appends a number as `JSON.stringify` writes it: `Number::toString`, `null` when not finite.
pub fn push_json_number(out: &mut String, x: f64) {
    if x.is_finite() {
        push_number(out, x);
    } else {
        out.push_str("null");
    }
}

fn newline(out: &mut String, indent: Option<usize>, level: usize) {
    if let Some(width) = indent {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', width * level));
    }
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, level: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(x) => push_json_number(out, *x),
        Value::String(s) => push_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push(']');
        }
        Value::Object(object) => {
            if object.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in object.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                push_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(text: &str) -> Result<String, ErrorKind> {
        parse(text).map(|v| to_string(&v)).map_err(|e| e.kind)
    }

    #[test]
    fn reads_and_writes_as_javascript() {
        assert_eq!(
            roundtrip(r#"{"b":1,"10":2,"2":3,"a":4,"b":5}"#).unwrap(),
            r#"{"2":3,"10":2,"b":5,"a":4}"#
        );
        assert_eq!(
            roundtrip("[1.0,-0,1e21,1e-7,1e400,9007199254740993]").unwrap(),
            "[1,0,1e+21,1e-7,null,9007199254740992]"
        );
        assert_eq!(
            roundtrip(r#""\u0000\u001f\u007f 😀\/""#).unwrap(),
            "\"\\u0000\\u001f\u{7f}\u{2028}😀/\""
        );
        assert_eq!(
            to_string_pretty(&parse(r#"[{},[],{"a":[1]}]"#).unwrap()),
            "[\n  {},\n  [],\n  {\n    \"a\": [\n      1\n    ]\n  }\n]"
        );
    }

    #[test]
    fn locates_errors_in_utf16_units() {
        let e = parse("[\n  \"😀\", x]").unwrap_err();
        assert_eq!(
            (e.kind, e.offset, e.line, e.column),
            (ErrorKind::Expected("a value"), 10, 2, 9)
        );
        assert_eq!(roundtrip("[01]"), Err(ErrorKind::Expected("',' or ']'")));
        assert_eq!(roundtrip("[1e]"), Err(ErrorKind::Expected("',' or ']'")));
        assert_eq!(
            roundtrip(r#"{"a":1,}"#),
            Err(ErrorKind::Expected("a property name in double quotes"))
        );
        assert_eq!(
            roundtrip("\"\u{1}\""),
            Err(ErrorKind::Expected("an escaped control character"))
        );
        assert_eq!(
            roundtrip(r#""\x""#),
            Err(ErrorKind::Expected("an escape sequence"))
        );
        assert_eq!(
            roundtrip("\"abc"),
            Err(ErrorKind::Expected("a closing quote"))
        );
        assert_eq!(roundtrip("1 2"), Err(ErrorKind::Expected("end of input")));
        let lone = |escape: &str| Err(ErrorKind::LoneSurrogate(escape.to_owned()));
        assert_eq!(roundtrip(r#""\ud800""#), lone(r"\ud800"));
        assert_eq!(roundtrip(r#""\udc00\ud800""#), lone(r"\udc00"));
        assert_eq!(roundtrip(r#""\uD83D\uDE00\uD83D""#), lone(r"\uD83D"));
        assert_eq!(roundtrip(r#""\ud83d\\ude00""#), lone(r"\ud83d"));
        assert_eq!(roundtrip(r#""\ud83d\u0041""#), lone(r"\ud83d"));
        let e = parse("{\n  \"a\": \"😀 \\ud83d\"}").unwrap_err();
        assert_eq!((e.offset, e.line, e.column), (13, 2, 12));
        assert_eq!(
            e.to_string(),
            "Invalid JSON on line 2, column 12: the escape \\ud83d is a lone surrogate (half of \
             a UTF-16 pair), which kgdiff does not accept"
        );
        assert_eq!(
            Parser::new("[[[]]]").max_depth(2).parse().unwrap_err().kind,
            ErrorKind::TooDeep(2)
        );
        assert!(Parser::new("[[]]").max_depth(2).parse().is_ok());
    }
}
