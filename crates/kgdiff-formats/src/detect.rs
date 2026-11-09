//! Format detection (`detect.ts`): the file extension first, then content sniffing. The sticky
//! and multi-line regular expressions of TypeScript are hand-written scanners here (RFC 0002,
//! J-46); multi-line `^` and `$` see JavaScript's four line terminators.

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{self, Object, Value};
use kgdiff_core::text::to_lowercase;

use crate::FormatId;
use crate::prefixes::RDF_NS;
use crate::shared::{byte_index, invalid_input, invalid_input_with, strip_bom};

/// File extensions `detect_format` understands, per format (matched case-insensitively,
/// longest first).
pub const FORMAT_EXTENSIONS: &[(FormatId, &[&str])] = &[
    (FormatId::Json, &[".json", ".kgdiff.json"]),
    (FormatId::JsonLd, &[".jsonld"]),
    (FormatId::Turtle, &[".ttl", ".turtle"]),
    (FormatId::NTriples, &[".nt"]),
    (FormatId::NQuads, &[".nq"]),
    (FormatId::TriG, &[".trig"]),
    (FormatId::RdfXml, &[".rdf", ".owl"]),
    (FormatId::Obo, &[".obo"]),
];

/// Extensions several syntaxes share (`.owl` holds Turtle, OWL/XML or Functional Syntax too):
/// for these the content decides.
const SHARED_EXTENSIONS: &[&str] = &[".owl"];

/// How many leading UTF-16 units content sniffing looks at.
const SNIFF_WINDOW: usize = 64 * 1024;
/// How many statement lines decide between N-Triples / N-Quads and Turtle.
const SNIFF_LINES: usize = 32;

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `filename.replace(/[?#].*$/, '').toLowerCase()`.
fn clean_name(filename: &str) -> String {
    let mut cut = filename.len();
    for (i, c) in filename.char_indices() {
        if (c == '?' || c == '#') && !filename[i + 1..].contains(is_line_terminator) {
            cut = i;
            break;
        }
    }
    to_lowercase(&filename[..cut]).into_owned()
}

/// The format a file name or URL implies (`formatFromFilename`).
pub fn format_from_filename(filename: &str) -> Option<FormatId> {
    let name = clean_name(filename);
    let mut best: Option<(FormatId, usize)> = None;
    for (format, extensions) in FORMAT_EXTENSIONS {
        for extension in *extensions {
            if name.ends_with(extension) && best.is_none_or(|(_, length)| extension.len() > length)
            {
                best = Some((*format, extension.len()));
            }
        }
    }
    best.map(|(format, _)| format)
}

/// `detect` (see `detect_format`).
pub fn detect(text: &str, filename: Option<&str>) -> Result<FormatId, KgdiffError> {
    let Some(named) = filename.and_then(format_from_filename) else {
        return sniff_format(text, filename, None);
    };
    let name = clean_name(filename.unwrap_or(""));
    if SHARED_EXTENSIONS.iter().any(|e| name.ends_with(e)) {
        return sniff_format(text, filename, Some(named));
    }
    // `.json` holds every JSON dialect, JSON-LD included.
    if named == FormatId::Json && is_json_ld_head(strip_bom(window(text))) {
        return Ok(FormatId::JsonLd);
    }
    Ok(named)
}

/// `text.slice(0, SNIFF_WINDOW)`.
fn window(text: &str) -> &str {
    &text[..byte_index(text, SNIFF_WINDOW)]
}

/// The lines of `text` as JavaScript's multi-line `^` and `$` delimit them.
fn js_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_line_terminator)
}

fn starts_with_ignore_ascii_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Sniffs the format from content alone (`sniffFormat`).
pub fn sniff_format(
    text: &str,
    filename: Option<&str>,
    fallback: Option<FormatId>,
) -> Result<FormatId, KgdiffError> {
    let head = strip_bom(window(text));
    let start = skip_whitespace_and_comments(head);
    // Empty (or comment-only): an empty RDF graph.
    if start >= head.len() {
        return Ok(fallback.unwrap_or(FormatId::Turtle));
    }
    let first = head.as_bytes()[start];

    let obo = js_lines(head).any(|line| {
        line.starts_with("format-version:") || {
            let trimmed = line.trim_end_matches([' ', '\t']);
            matches!(trimmed, "[Term]" | "[Typedef]" | "[Instance]")
        }
    });
    if obo {
        return Ok(FormatId::Obo);
    }
    if first == b'{' || (first == b'[' && looks_like_json_array(head, start)) {
        return Ok(if is_json_ld_head(head) {
            FormatId::JsonLd
        } else {
            FormatId::Json
        });
    }
    if first == b'<' && looks_like_xml(head, start) {
        if let Some(root) = sniff_root(head, start) {
            let kind = classify_xml_root(&XmlRootInfo {
                local: &root.local,
                rdf_attributes: root.rdf_attributes,
                rdf_namespace: root.rdf_namespace,
            });
            return match kind {
                XmlKind::RdfXml => Ok(FormatId::RdfXml),
                XmlKind::Unsupported(kind) => {
                    Err(unsupported_format(kind, filename, Some(&root.qname)))
                }
            };
        }
        if head.contains(RDF_NS) {
            return Ok(FormatId::RdfXml);
        }
    }
    let leading = |line: &str| line.trim_start_matches([' ', '\t']).to_owned();
    if js_lines(head).any(|line| {
        let l = leading(line);
        l.starts_with("Prefix(") || l.starts_with("Ontology(")
    }) {
        return Err(unsupported_format(
            Unsupported::OwlFunctional,
            filename,
            None,
        ));
    }
    if js_lines(head).any(|line| {
        let l = leading(line);
        ["Prefix:", "Ontology:"]
            .iter()
            .any(|p| l.starts_with(p) && matches!(l.as_bytes().get(p.len()), Some(b' ' | b'\t')))
    }) {
        return Err(unsupported_format(
            Unsupported::OwlManchester,
            filename,
            None,
        ));
    }

    let has_directives = js_lines(head).any(|line| {
        let l = leading(line);
        starts_with_ignore_ascii_case(&l, "@prefix")
            || starts_with_ignore_ascii_case(&l, "@base")
            || ["prefix", "base"].iter().any(|p| {
                starts_with_ignore_ascii_case(&l, p)
                    && matches!(l.as_bytes().get(p.len()), Some(b' ' | b'\t'))
            })
    });
    if !has_directives {
        // A truncated window may end mid-line: leave that line out of the sample.
        let complete = if js::utf16_len(text) > SNIFF_WINDOW {
            &head[..head.rfind('\n').map_or(0, |i| i + 1)]
        } else {
            head
        };
        if let Some(format) = sniff_line_format(complete) {
            return Ok(format);
        }
    }
    if has_directives || looks_like_turtle(&head[start..]) {
        return Ok(if has_graph_block(strip_bom(text)) {
            FormatId::TriG
        } else {
            FormatId::Turtle
        });
    }
    if let Some(fallback) = fallback {
        return Ok(fallback);
    }
    let ids: Vec<&str> = FormatId::ALL.iter().map(|f| f.id()).collect();
    let named = filename.filter(|f| !f.is_empty());
    let message = format!(
        "Could not detect the format of {}. Pass `format` explicitly ({}).",
        named.map_or_else(|| "the input".to_owned(), |f| format!("\"{f}\"")),
        ids.join(", ")
    );
    Err(match named {
        Some(f) => invalid_input_with(message, filename_details(f)),
        None => invalid_input(message),
    })
}

fn filename_details(filename: &str) -> Object {
    let mut details = Object::new();
    details.insert("filename", filename);
    details
}

// ─── Unsupported formats ─────────────────────────────────────────────────────

/// Formats that are recognised but not read (`UnsupportedFormat`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsupported {
    OwlXml,
    OwlFunctional,
    OwlManchester,
    GraphMl,
    Gexf,
    Xml,
}

const TO_RDF: &str = "Convert it to RDF/XML or Turtle first (e.g. `robot convert --input onto.owx --output onto.owl`).";
const TO_JSON: &str =
    "Export it as JSON first (e.g. NetworkX node-link data or Cytoscape.js JSON).";

impl Unsupported {
    fn name(self) -> &'static str {
        match self {
            Unsupported::OwlXml => "OWL/XML",
            Unsupported::OwlFunctional => "OWL Functional Syntax",
            Unsupported::OwlManchester => "OWL Manchester Syntax",
            Unsupported::GraphMl => "GraphML",
            Unsupported::Gexf => "GEXF",
            Unsupported::Xml => "XML",
        }
    }

    fn hint(self) -> &'static str {
        match self {
            Unsupported::OwlXml | Unsupported::OwlFunctional | Unsupported::OwlManchester => TO_RDF,
            Unsupported::GraphMl | Unsupported::Gexf => TO_JSON,
            Unsupported::Xml => {
                "kgdiff reads RDF/XML (an rdf:RDF root element, or a node element with rdf:about); other XML vocabularies are not graph formats it knows."
            }
        }
    }
}

/// `invalid-input` naming a recognised but unsupported format and a way out
/// (`unsupportedFormat`).
pub fn unsupported_format(
    kind: Unsupported,
    filename: Option<&str>,
    root: Option<&str>,
) -> KgdiffError {
    let what = if kind == Unsupported::Xml {
        format!("XML with root element <{}>", root.unwrap_or("?"))
    } else {
        kind.name().to_owned()
    };
    let named = filename.filter(|f| !f.is_empty());
    let message = format!(
        "{what} is not supported{}. {}",
        named.map_or_else(String::new, |f| format!(" (\"{f}\")")),
        kind.hint()
    );
    match named {
        Some(f) => invalid_input_with(message, filename_details(f)),
        None => invalid_input(message),
    }
}

/// What format detection needs to know about a root element (`XmlRootInfo`).
pub struct XmlRootInfo<'a> {
    pub local: &'a str,
    /// Whether it has attributes in the RDF namespace (`rdf:about`, …).
    pub rdf_attributes: bool,
    /// Whether it declares the RDF namespace.
    pub rdf_namespace: bool,
}

/// RDF/XML, or the unsupported XML format a root element belongs to.
pub enum XmlKind {
    RdfXml,
    Unsupported(Unsupported),
}

/// `classifyXmlRoot`.
pub fn classify_xml_root(root: &XmlRootInfo<'_>) -> XmlKind {
    let local = root.local;
    if local == "RDF" {
        return XmlKind::RdfXml;
    }
    if local == "Ontology" && !root.rdf_attributes {
        return XmlKind::Unsupported(Unsupported::OwlXml);
    }
    let lower = to_lowercase(local);
    if lower == "graphml" {
        return XmlKind::Unsupported(Unsupported::GraphMl);
    }
    if lower == "gexf" {
        return XmlKind::Unsupported(Unsupported::Gexf);
    }
    if root.rdf_attributes || root.rdf_namespace {
        XmlKind::RdfXml
    } else {
        XmlKind::Unsupported(Unsupported::Xml)
    }
}

fn is_name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

/// `\w`.
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The end of `[\w.-]*` (and `extra` characters) from `at`.
fn name_chars(b: &[u8], at: usize, extra: &[u8]) -> usize {
    let mut i = at;
    while i < b.len() && (is_word(b[i]) || b[i] == b'.' || b[i] == b'-' || extra.contains(&b[i])) {
        i += 1;
    }
    i
}

/// JavaScript's `\s` at a byte index (whitespace and line terminators).
fn js_space_at(text: &str, at: usize) -> Option<usize> {
    let c = text[at..].chars().next()?;
    js::is_whitespace(c).then(|| at + c.len_utf8())
}

fn skip_js_space(text: &str, mut at: usize) -> usize {
    while let Some(next) = js_space_at(text, at) {
        at = next;
    }
    at
}

/// Markup rather than a Turtle IRI (`looksLikeXml`): a declaration, comment or DOCTYPE, or a
/// start tag with attributes, self-closing or closed later.
fn looks_like_xml(head: &str, start: usize) -> bool {
    // `^<(?:([?!])|([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(\s+[A-Za-z_][\w.:-]*\s*=|\s*\/?>))`
    let sample = &head[start..byte_index(head, js::utf16_len(&head[..start]) + 1024)];
    let b = sample.as_bytes();
    if b.first() != Some(&b'<') {
        return false;
    }
    if matches!(b.get(1), Some(b'?' | b'!')) {
        return true;
    }
    if !b.get(1).copied().is_some_and(is_name_start) {
        return false;
    }
    let mut end = name_chars(b, 2, b"");
    if b.get(end) == Some(&b':') && b.get(end + 1).copied().is_some_and(is_name_start) {
        end = name_chars(b, end + 2, b"");
    }
    let name = &sample[1..end];
    // Alternative 1: `\s+[A-Za-z_][\w.:-]*\s*=`.
    let spaced = skip_js_space(sample, end);
    let after = if spaced > end
        && sample
            .as_bytes()
            .get(spaced)
            .copied()
            .is_some_and(is_name_start)
    {
        let attr_end = name_chars(b, spaced + 1, b":");
        let eq = skip_js_space(sample, attr_end);
        (b.get(eq) == Some(&b'=')).then(|| &sample[end..=eq])
    } else {
        None
    };
    // Alternative 2: `\s*\/?>`.
    let after = after.or_else(|| {
        let mut i = spaced;
        if b.get(i) == Some(&b'/') {
            i += 1;
        }
        (b.get(i) == Some(&b'>')).then(|| &sample[end..=i])
    });
    let Some(after) = after else {
        return false;
    };
    after.contains('=') || after.ends_with("/>") || head.contains(&format!("</{name}"))
}

struct XmlRoot {
    qname: String,
    local: String,
    rdf_attributes: bool,
    rdf_namespace: bool,
}

/// The root element of an XML head: prolog skipped, its own namespace declarations read
/// (`sniffXmlRoot`).
fn sniff_root(head: &str, start: usize) -> Option<XmlRoot> {
    let mut i = start;
    loop {
        i = skip_xml_space(head, i);
        let end = if head[i..].starts_with("<?") {
            after_or_none(head, "?>", i)
        } else if head[i..].starts_with("<!--") {
            after_or_none(head, "-->", i)
        } else if head[i..].starts_with("<!DOCTYPE") {
            after_doctype(head, i)
        } else {
            break;
        };
        i = end?;
    }
    // `^<([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*)`
    let rest = &head[i..];
    if !rest.starts_with('<') {
        return None;
    }
    let mut q = 1;
    while q < rest.len() {
        let c = rest[q..].chars().next()?;
        if js::is_whitespace(c) || c == '/' || c == '>' {
            break;
        }
        q += c.len_utf8();
    }
    if q == 1 {
        return None;
    }
    let qname = &rest[1..q];
    let mut a = q;
    let bytes = rest.as_bytes();
    while a < bytes.len() {
        match bytes[a] {
            b'>' => break,
            quote @ (b'"' | b'\'') => match rest[a + 1..].find(char::from(quote)) {
                Some(close) => a = a + 1 + close + 1,
                None => break,
            },
            _ => a += rest[a..].chars().next().map_or(1, char::len_utf8),
        }
    }
    let attributes = &rest[q..a];
    let mut namespaces: Vec<(String, String)> = Vec::new();
    let mut prefixes: Vec<String> = Vec::new();
    let set = |namespaces: &mut Vec<(String, String)>, prefix: &str, value: &str| match namespaces
        .iter_mut()
        .find(|(p, _)| p == prefix)
    {
        Some(entry) => entry.1 = value.to_owned(),
        None => namespaces.push((prefix.to_owned(), value.to_owned())),
    };
    for (name, value) in attribute_matches(attributes) {
        if name == "xmlns" {
            set(&mut namespaces, "", value);
        } else if let Some(prefix) = name.strip_prefix("xmlns:") {
            set(&mut namespaces, prefix, value);
        } else if let Some(colon) = name.find(':') {
            prefixes.push(name[..colon].to_owned());
        }
    }
    let get = |prefix: &str| {
        namespaces
            .iter()
            .find(|(p, _)| p == prefix)
            .map(|(_, uri)| uri.as_str())
    };
    let local = match qname.find(':') {
        Some(colon) => &qname[colon + 1..],
        None => qname,
    };
    let rdf_attributes = prefixes
        .iter()
        .any(|prefix| get(prefix) == Some(RDF_NS) || prefix == "rdf");
    let rdf_namespace = namespaces.iter().any(|(_, uri)| uri == RDF_NS);
    Some(XmlRoot {
        qname: qname.to_owned(),
        local: local.to_owned(),
        rdf_attributes,
        rdf_namespace,
    })
}

/// The matches of `/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g` in `text`.
fn attribute_matches(text: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < text.len() {
        if let Some((name, value, end)) = attribute_at(text, at) {
            out.push((name, value));
            at = end;
        } else {
            at += text[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    out
}

fn attribute_at(text: &str, at: usize) -> Option<(&str, &str, usize)> {
    let mut i = at;
    for c in text[at..].chars() {
        if js::is_whitespace(c) || c == '=' {
            break;
        }
        i += c.len_utf8();
    }
    if i == at {
        return None;
    }
    let name = &text[at..i];
    let eq = skip_js_space(text, i);
    if text.as_bytes().get(eq) != Some(&b'=') {
        return None;
    }
    let open = skip_js_space(text, eq + 1);
    let quote = match text.as_bytes().get(open) {
        Some(q @ (b'"' | b'\'')) => char::from(*q),
        _ => return None,
    };
    let close = text[open + 1..].find(quote)? + open + 1;
    Some((name, &text[open + 1..close], close + 1))
}

fn skip_xml_space(text: &str, from: usize) -> usize {
    let b = text.as_bytes();
    let mut i = from;
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

fn after_or_none(text: &str, terminator: &str, from: usize) -> Option<usize> {
    text[from..]
        .find(terminator)
        .map(|end| from + end + terminator.len())
}

/// The end of `<!DOCTYPE … [ … ]>`, or `None` when it does not end inside `text`.
fn after_doctype(text: &str, from: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut in_subset = false;
    let mut i = from + 9;
    while i < b.len() {
        match b[i] {
            quote @ (b'"' | b'\'') => {
                i = text[i + 1..].find(char::from(quote))? + i + 1;
            }
            b'[' => in_subset = true,
            b']' => in_subset = false,
            b'>' if !in_subset => return Some(i + 1),
            _ => {}
        }
        i += 1;
    }
    None
}

// ─── JSON-LD ─────────────────────────────────────────────────────────────────

/// Top-level keys that make a JSON document JSON-LD.
const JSON_LD_KEYS: &[&str] = &[
    "@context",
    "@graph",
    "@id",
    "@type",
    "@reverse",
    "@included",
    "@set",
    "@list",
    "@value",
];

/// Whether a parsed JSON value is a JSON-LD document, by its top-level keys (`isJsonLd`).
pub fn is_json_ld(data: &Value) -> bool {
    let object = match data {
        Value::Array(items) => items.first(),
        other => Some(other),
    };
    matches!(object, Some(Value::Object(o)) if o.keys().any(|k| JSON_LD_KEYS.contains(&k.as_str())))
}

/// `isJsonLd` on the head of a document (`isJsonLdHead`).
fn is_json_ld_head(head: &str) -> bool {
    let b = head.as_bytes();
    let mut i = skip_xml_space(head, 0);
    if b.get(i) == Some(&b'[') {
        i = skip_xml_space(head, i + 1);
    }
    if b.get(i) != Some(&b'{') {
        return false;
    }
    i += 1;
    loop {
        i = skip_xml_space(head, i);
        if b.get(i) != Some(&b'"') {
            return false;
        }
        let Some(key_end) = end_of_json_string(b, i) else {
            return false;
        };
        let key = &head[i + 1..key_end - 1];
        if JSON_LD_KEYS.contains(&key) {
            return true;
        }
        i = skip_xml_space(head, key_end);
        if b.get(i) != Some(&b':') {
            return false;
        }
        let Some(end) = end_of_json_value(b, skip_xml_space(head, i + 1)) else {
            return false;
        };
        i = skip_xml_space(head, end);
        if b.get(i) != Some(&b',') {
            return false;
        }
        i += 1;
    }
}

/// The index after the JSON string starting at `start`.
fn end_of_json_string(b: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'"' => return Some(i + 1),
            _ => {}
        }
        i += 1;
    }
    None
}

/// The index after the JSON value starting at `start` (nested values skipped).
fn end_of_json_value(b: &[u8], start: usize) -> Option<usize> {
    let mut depth: i64 = 0;
    let mut i = start;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i = end_of_json_string(b, i)? - 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
                if depth < 0 {
                    return None;
                }
            }
            b',' | b' ' | b'\n' | b'\r' | b'\t' if depth == 0 => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

// ─── Text formats ────────────────────────────────────────────────────────────

fn skip_whitespace_and_comments(text: &str) -> usize {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b'#' => i = text[i..].find('\n').map_or(b.len(), |end| i + end + 1),
            _ => break,
        }
    }
    i
}

/// `[` opens JSON when followed by a JSON value; in Turtle it opens a blank node.
fn looks_like_json_array(text: &str, start: usize) -> bool {
    let rest = js::trim_start(&text[start + 1..]);
    let Some(next) = rest.chars().next() else {
        return true;
    };
    if next == ']' {
        // `rest.slice(1).trim() === '' || /^\]\s*[,\]]/.test(rest)`
        let after = &rest[1..];
        return js::trim(after).is_empty() || {
            let i = skip_js_space(after, 0);
            matches!(after.as_bytes().get(i), Some(b',' | b']'))
        };
    }
    matches!(next, '{' | '[' | '"' | '-' | '0'..='9')
}

/// A subject-like first token: an IRI, a blank node, a collection or a prefixed name.
fn looks_like_turtle(text: &str) -> bool {
    // `/^(?:<[^\s<>]*>|_:|\[|\(|[A-Za-z][\w.-]*:|:)/`
    let b = text.as_bytes();
    match b.first() {
        Some(b'<') => {
            for c in text[1..].chars() {
                if c == '>' {
                    return true;
                }
                if js::is_whitespace(c) || c == '<' {
                    return false;
                }
            }
            false
        }
        Some(b'[' | b'(' | b':') => true,
        Some(b'_') => b.get(1) == Some(&b':'),
        Some(c) if c.is_ascii_alphabetic() => b.get(name_chars(b, 1, b"")) == Some(&b':'),
        _ => false,
    }
}

/// The end of the N-Triples term at `pos` (`NT_TERM`, sticky), if one starts there.
fn nt_term(line: &str, pos: usize) -> Option<usize> {
    let b = line.as_bytes();
    let mut i = pos;
    while matches!(b.get(i), Some(b' ' | b'\t')) {
        i += 1;
    }
    // `<[^<>"\s]*>`
    let iri = |from: usize| -> Option<usize> {
        let mut j = from;
        for c in line[from..].chars() {
            if c == '>' {
                return Some(j + 1);
            }
            if c == '<' || c == '"' || js::is_whitespace(c) {
                return None;
            }
            j += c.len_utf8();
        }
        None
    };
    match b.get(i) {
        Some(b'<') => iri(i + 1),
        Some(b'_') if b.get(i + 1) == Some(&b':') => {
            // `_:[^\s.<>"]+(?:\.[^\s.<>"]+)*`
            let label = |from: usize| -> usize {
                let mut j = from;
                for c in line[from..].chars() {
                    if js::is_whitespace(c) || matches!(c, '.' | '<' | '>' | '"') {
                        break;
                    }
                    j += c.len_utf8();
                }
                j
            };
            let mut end = label(i + 2);
            if end == i + 2 {
                return None;
            }
            while b.get(end) == Some(&b'.') {
                let next = label(end + 1);
                if next == end + 1 {
                    break;
                }
                end = next;
            }
            Some(end)
        }
        Some(b'"') => {
            // `"(?:[^"\\\n]|\\.)*"`
            let mut j = i + 1;
            loop {
                let c = line[j..].chars().next()?;
                match c {
                    '"' => {
                        j += 1;
                        break;
                    }
                    '\\' => {
                        let escaped = line[j + 1..].chars().next()?;
                        if is_line_terminator(escaped) {
                            return None;
                        }
                        j += 1 + escaped.len_utf8();
                    }
                    '\n' => return None,
                    _ => j += c.len_utf8(),
                }
            }
            // `(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[a-z]+)?|\^\^<[^<>"\s]*>)?`
            if b.get(j) == Some(&b'@') && b.get(j + 1).is_some_and(u8::is_ascii_alphabetic) {
                let mut k = j + 1;
                while b.get(k).is_some_and(u8::is_ascii_alphabetic) {
                    k += 1;
                }
                while b.get(k) == Some(&b'-') && b.get(k + 1).is_some_and(u8::is_ascii_alphanumeric)
                {
                    k += 1;
                    while b.get(k).is_some_and(u8::is_ascii_alphanumeric) {
                        k += 1;
                    }
                }
                if line[k..].starts_with("--") && b.get(k + 2).is_some_and(u8::is_ascii_lowercase) {
                    k += 2;
                    while b.get(k).is_some_and(u8::is_ascii_lowercase) {
                        k += 1;
                    }
                }
                return Some(k);
            }
            if line[j..].starts_with("^^<")
                && let Some(end) = iri(j + 3)
            {
                return Some(end);
            }
            Some(j)
        }
        _ => None,
    }
}

/// The number of terms of a statement line, or `None` when it is not one (`countLineTerms`).
fn count_line_terms(line: &str) -> Option<usize> {
    let mut position = 0;
    let mut terms = 0;
    while let Some(end) = nt_term(line, position) {
        position = end;
        terms += 1;
    }
    // `/^\.\s*(?:#.*)?$/`
    let rest = js::trim(&line[position..]);
    let after_dot = rest.strip_prefix('.')?;
    let after = js::trim_start(after_dot);
    if after.is_empty() || (after.starts_with('#') && !after.contains(is_line_terminator)) {
        Some(terms)
    } else {
        None
    }
}

/// N-Triples / N-Quads are line-based (`sniffLineFormat`).
fn sniff_line_format(text: &str) -> Option<FormatId> {
    let mut sampled = 0;
    let mut quads = false;
    for raw in text.split('\n') {
        let line = js::trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match count_line_terms(line) {
            Some(3) => {}
            Some(4) => quads = true,
            _ => return None,
        }
        sampled += 1;
        if sampled >= SNIFF_LINES {
            break;
        }
    }
    if sampled == 0 {
        return None;
    }
    Some(if quads {
        FormatId::NQuads
    } else {
        FormatId::NTriples
    })
}

/// TriG: a `{` outside IRIs, strings and comments (`{|` is RDF 1.2 annotation syntax).
fn has_graph_block(text: &str) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        match b[i] {
            b'#' => i = text[i..].find('\n').map_or(n, |end| i + end + 1),
            b'<' if b.get(i + 1) != Some(&b'<') => {
                i = text[i + 1..].find('>').map_or(n, |end| i + 1 + end + 1);
            }
            quote @ (b'"' | b'\'') => i = skip_string(text, i, quote),
            b'{' => {
                if b.get(i + 1) != Some(&b'|') {
                    return true;
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    false
}

fn skip_string(text: &str, start: usize, quote: u8) -> usize {
    let b = text.as_bytes();
    let long = b.len() >= start + 3 && b[start..start + 3].iter().all(|&c| c == quote);
    let close_len = if long { 3 } else { 1 };
    let mut i = start + close_len;
    while i < b.len() {
        if b[i] == b'\\' {
            i += 2;
        } else if b.len() >= i + close_len && b[i..i + close_len].iter().all(|&c| c == quote) {
            return i + close_len;
        } else if !long && b[i] == b'\n' {
            return i + 1;
        } else {
            i += 1;
        }
    }
    b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(text: &str, filename: Option<&str>) -> &'static str {
        super::detect(text, filename).map_or("error", FormatId::id)
    }

    #[test]
    fn detects_by_extension_and_content() {
        assert_eq!(detect("", Some("a.KGDIFF.JSON?x=1")), "json");
        assert_eq!(detect("{\"@context\":{}}", Some("a.json")), "jsonld");
        assert_eq!(detect("@prefix ex: <x#> .", Some("a.owl")), "turtle");
        assert_eq!(detect("<rdf:RDF xmlns:rdf=\"x\"/>", None), "rdfxml");
        assert_eq!(detect("format-version: 1.4\n", None), "obo");
        assert_eq!(detect("\n[Term]\r\nid: X", None), "obo");
        assert_eq!(
            detect("<a> <b> <c> .\n<a> <b> \"x\"@en <g> .", None),
            "nquads"
        );
        assert_eq!(detect("<a> <b> <c> .", None), "ntriples");
        assert_eq!(
            detect("PREFIX ex: <x#>\nex:g { ex:a ex:b ex:c }", None),
            "trig"
        );
        assert_eq!(detect("ex:a ex:b ex:c {| ex:d 1 |} .", None), "turtle");
        assert_eq!(detect("[1, 2]", None), "json");
        assert_eq!(detect("[ ex:a 1 ] .", None), "turtle");
        assert_eq!(detect("hello world", None), "error");
        assert_eq!(detect("Prefix(:=<x>)", None), "error");
        assert_eq!(detect("<graphml xmlns=\"x\"></graphml>", None), "error");
    }

    #[test]
    fn counts_line_terms() {
        assert_eq!(count_line_terms("<a> <b> \"x\\\"y\"@en-GB--ltr ."), Some(3));
        assert_eq!(count_line_terms("_:a.b <p> \"1\"^^<x> <g> . # c"), Some(4));
        assert_eq!(count_line_terms("<a> <b> <c>"), None);
    }
}
