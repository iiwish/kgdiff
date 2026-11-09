//! A small, non-validating XML 1.0 parser with namespaces and SAX-style callbacks, for RDF/XML
//! (`xml.ts`, ported as it is; RFC 0002, D-9).
//!
//! The XML declaration, comments, processing instructions, CDATA sections, character references,
//! the predefined entities and general entities of the internal DTD subset are supported.
//! External entities are never loaded, and entity expansion is capped. Error positions are
//! UTF-16 offsets, as in TypeScript, so that the reported lines are the same.

use std::rc::Rc;

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{IndexMap, Lookup, utf16_len};

pub const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";

/// Entity expansion budget: generous for real files, fatal for exponential blow-ups.
const MIN_EXPANSION_BUDGET: usize = 4 * 1024 * 1024;
const EXPANSION_FACTOR: usize = 16;

/// An attribute: a qualified name and its normalized value.
#[derive(Clone, Debug)]
pub struct XmlAttribute {
    pub prefix: String,
    pub local: String,
    pub uri: String,
    pub value: String,
}

/// A start tag.
#[derive(Clone, Debug)]
pub struct XmlElement {
    pub prefix: String,
    pub local: String,
    pub uri: String,
    /// Attributes other than namespace declarations, in document order.
    pub attributes: Vec<XmlAttribute>,
    /// Namespace declarations made on this element (`""` is the default namespace).
    pub namespaces: Vec<(String, String)>,
    /// UTF-16 offset of the element's `<`, for error positions.
    pub offset: usize,
}

/// Why parsing stopped: a well-formedness (or, from a handler, grammar) error at a UTF-16
/// offset, or another error a handler raised.
#[derive(Debug)]
pub enum XmlError {
    Syntax { message: String, offset: usize },
    Other(Box<KgdiffError>),
}

/// The events of [`parse_xml`].
pub trait XmlHandler {
    fn start_element(&mut self, element: XmlElement) -> Result<(), XmlError>;
    fn end_element(&mut self, offset: usize) -> Result<(), XmlError>;
    /// Character data inside the root element; consecutive chunks may arrive separately.
    fn text(&mut self, value: &str, offset: usize) -> Result<(), XmlError>;
    fn processing_instruction(&mut self, target: &str, data: &str) -> Result<(), XmlError>;
    fn comment(&mut self, value: &str) -> Result<(), XmlError>;
}

pub fn syntax<T>(message: impl Into<String>, offset: usize) -> Result<T, XmlError> {
    Err(XmlError::Syntax {
        message: message.into(),
        offset,
    })
}

// ─── Names ───────────────────────────────────────────────────────────────────

fn is_name_start_char(c: char) -> bool {
    matches!(c,
        'A'..='Z' | '_' | 'a'..='z'
        | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{2FF}'
        | '\u{370}'..='\u{37D}' | '\u{37F}'..='\u{1FFF}' | '\u{200C}' | '\u{200D}'
        | '\u{2070}'..='\u{218F}' | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}'
        | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}' | '\u{10000}'..='\u{EFFFF}')
}

fn is_name_char(c: char) -> bool {
    is_name_start_char(c)
        || matches!(c, '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}' | '\u{2040}')
}

/// The end of an `NCName` starting at byte `at`, if one does.
fn nc_name_end(text: &str, at: usize) -> Option<usize> {
    let mut chars = text[at..].char_indices();
    let (_, first) = chars.next()?;
    if !is_name_start_char(first) {
        return None;
    }
    let mut end = at + first.len_utf8();
    for (i, c) in chars {
        if !is_name_char(c) {
            return Some(at + i);
        }
        end = at + i + c.len_utf8();
    }
    Some(end)
}

/// Whether `value` is an `NCName` (rdf:ID and rdf:nodeID values).
pub fn is_nc_name(value: &str) -> bool {
    !value.is_empty() && nc_name_end(value, 0) == Some(value.len())
}

/// An XML `Name` (colons allowed): its end from `at`.
fn name_end(text: &str, at: usize) -> Option<usize> {
    let mut chars = text[at..].char_indices();
    let (_, first) = chars.next()?;
    if !(first == ':' || is_name_start_char(first)) {
        return None;
    }
    let mut end = at + first.len_utf8();
    for (i, c) in chars {
        if !(c == ':' || is_name_char(c)) {
            return Some(at + i);
        }
        end = at + i + c.len_utf8();
    }
    Some(end)
}

fn is_entity_name(name: &str) -> bool {
    !name.is_empty() && name_end(name, 0) == Some(name.len())
}

/// `local` or `prefix:local` at `at`.
fn qname_end(text: &str, at: usize) -> Option<usize> {
    let first = nc_name_end(text, at)?;
    if text.as_bytes().get(first) == Some(&b':')
        && let Some(second) = nc_name_end(text, first + 1)
    {
        return Some(second);
    }
    Some(first)
}

/// `!/[^ \t\n\r]/.test(value)`.
pub fn is_xml_space(value: &str) -> bool {
    value
        .bytes()
        .all(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/// Parses an XML document, reporting events to `handler`. Line breaks are normalized to `\n`
/// first (XML 1.0 §2.11). The error's offset is turned into a 1-based line by the caller with
/// [`line_of`] on the returned source.
pub fn parse_xml(text: &str, handler: &mut dyn XmlHandler) -> Result<(), (XmlError, String)> {
    let source = if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_owned()
    };
    let mut parser = XmlParser::new(&source, handler);
    match parser.parse() {
        Ok(()) => Ok(()),
        Err(error) => Err((error, source)),
    }
}

/// The 1-based line of a UTF-16 offset (`lineAndColumn(...).line`).
pub fn line_of(source: &str, offset: usize) -> usize {
    let mut line = 1;
    let mut units = 0;
    for c in source.chars() {
        if units >= offset {
            break;
        }
        units += c.len_utf16();
        if c == '\n' {
            line += 1;
        }
    }
    line
}

struct Entity {
    /// Replacement text with character references already resolved (XML 1.0 §4.5).
    value: String,
    external: bool,
    expanded: Option<String>,
    expanding: bool,
}

struct OpenElement {
    qname: String,
    offset: usize,
    /// Namespace bindings to restore when the element closes.
    outer: Rc<IndexMap<String, String>>,
}

struct XmlParser<'a> {
    text: &'a str,
    handler: &'a mut dyn XmlHandler,
    i: usize,
    stack: Vec<OpenElement>,
    namespaces: Rc<IndexMap<String, String>>,
    entities: Lookup<String, Entity>,
    expansion: usize,
    expansion_budget: usize,
    saw_root: bool,
    saw_doctype: bool,
    /// The last byte → UTF-16 conversion, to convert positions incrementally.
    cursor: (usize, usize),
}

fn skip_space(text: &str, from: usize) -> usize {
    let b = text.as_bytes();
    let mut i = from;
    while i < b.len() && matches!(b[i], b' ' | b'\n' | b'\t' | b'\r') {
        i += 1;
    }
    i
}

fn predefined(name: &str) -> Option<&'static str> {
    match name {
        "lt" => Some("<"),
        "gt" => Some(">"),
        "amp" => Some("&"),
        "apos" => Some("'"),
        "quot" => Some("\""),
        _ => None,
    }
}

fn is_xml_char(c: u64) -> bool {
    c == 0x9
        || c == 0xa
        || c == 0xd
        || (0x20..=0xd7ff).contains(&c)
        || (0xe000..=0xfffd).contains(&c)
        || (0x10000..=0x10ffff).contains(&c)
}

/// `#65` / `#x41` → `A`.
fn character_reference(name: &str, offset: usize) -> Result<char, XmlError> {
    let hex = name.as_bytes().get(1) == Some(&b'x');
    let digits = &name[if hex { 2 } else { 1 }.min(name.len())..];
    let valid = !digits.is_empty()
        && digits.bytes().all(|b| {
            if hex {
                b.is_ascii_hexdigit()
            } else {
                b.is_ascii_digit()
            }
        });
    let code = if valid {
        u64::from_str_radix(digits, if hex { 16 } else { 10 }).unwrap_or(u64::MAX)
    } else {
        u64::MAX
    };
    if !is_xml_char(code) {
        return syntax(format!("Invalid character reference \"&{name};\""), offset);
    }
    u32::try_from(code)
        .ok()
        .and_then(char::from_u32)
        .map_or_else(
            || syntax(format!("Invalid character reference \"&{name};\""), offset),
            Ok,
        )
}

fn check_namespace_declaration(prefix: &str, uri: &str, offset: usize) -> Result<(), XmlError> {
    if prefix == "xmlns" {
        return syntax("The xmlns prefix cannot be declared", offset);
    }
    if prefix == "xml" && uri != XML_NS {
        return syntax("The xml prefix cannot be rebound", offset);
    }
    if prefix != "xml" && uri == XML_NS {
        return syntax(
            format!("Prefix \"{prefix}\" cannot be bound to the XML namespace"),
            offset,
        );
    }
    if uri == XMLNS_NS {
        return syntax("The xmlns namespace cannot be bound", offset);
    }
    if !prefix.is_empty() && uri.is_empty() {
        return syntax(format!("Prefix \"{prefix}\" cannot be undeclared"), offset);
    }
    Ok(())
}

/// A qualified name resolved against the in-scope namespaces; unprefixed attributes are in
/// no namespace.
fn split_name(
    qname: &str,
    scope: &IndexMap<String, String>,
    offset: usize,
    is_element: bool,
) -> Result<(String, String, String), XmlError> {
    match qname.find(':') {
        None => Ok((
            String::new(),
            qname.to_owned(),
            if is_element {
                scope.get("").cloned().unwrap_or_default()
            } else {
                String::new()
            },
        )),
        Some(colon) => {
            let prefix = &qname[..colon];
            match scope.get(prefix) {
                None => syntax(format!("Undeclared namespace prefix \"{prefix}\""), offset),
                Some(uri) => Ok((
                    prefix.to_owned(),
                    qname[colon + 1..].to_owned(),
                    uri.clone(),
                )),
            }
        }
    }
}

impl<'a> XmlParser<'a> {
    fn new(text: &'a str, handler: &'a mut dyn XmlHandler) -> XmlParser<'a> {
        let mut namespaces = IndexMap::default();
        namespaces.insert("xml".to_owned(), XML_NS.to_owned());
        XmlParser {
            text,
            handler,
            i: 0,
            stack: Vec::new(),
            namespaces: Rc::new(namespaces),
            entities: Lookup::new(),
            expansion: 0,
            expansion_budget: MIN_EXPANSION_BUDGET.max(EXPANSION_FACTOR * utf16_len(text)),
            saw_root: false,
            saw_doctype: false,
            cursor: (0, 0),
        }
    }

    /// The UTF-16 offset of byte `at`.
    fn u16(&mut self, at: usize) -> usize {
        let (byte, units) = self.cursor;
        let units = if at >= byte {
            units + utf16_len(&self.text[byte..at])
        } else {
            utf16_len(&self.text[..at])
        };
        self.cursor = (at, units);
        units
    }

    fn fail<T>(&mut self, message: impl Into<String>, at: usize) -> Result<T, XmlError> {
        let offset = self.u16(at);
        syntax(message, offset)
    }

    fn parse(&mut self) -> Result<(), XmlError> {
        let text = self.text;
        // Leading whitespace before the declaration is tolerated (strictly, it is an error).
        let start = skip_space(text, 0);
        if text[start..].starts_with("<?xml")
            && matches!(text.as_bytes().get(start + 5), Some(b' ' | b'\t' | b'\n'))
        {
            self.i = self.skip_past("?>", start, "XML declaration")?;
        }
        while self.i < text.len() {
            let lt = text[self.i..].find('<').map(|p| p + self.i);
            let end = lt.unwrap_or(text.len());
            if end > self.i {
                self.characters(self.i, end)?;
            }
            let Some(lt) = lt else {
                break;
            };
            self.i = lt;
            match text.as_bytes().get(lt + 1) {
                Some(b'/') => self.end_tag()?,
                Some(b'!') => self.markup_declaration()?,
                Some(b'?') => self.processing_instruction()?,
                _ => self.start_tag()?,
            }
        }
        if let Some(open) = self.stack.last() {
            let (qname, offset) = (open.qname.clone(), open.offset);
            return syntax(format!("Element <{qname}> is never closed"), offset);
        }
        if !self.saw_root {
            return self.fail("The document has no root element", text.len());
        }
        Ok(())
    }

    // ─── Markup ─────────────────────────────────────────────────────────────

    fn start_tag(&mut self) -> Result<(), XmlError> {
        let text = self.text;
        let offset = self.i;
        if self.saw_root && self.stack.is_empty() {
            return self.fail("Only one root element is allowed", offset);
        }
        let qname = self.qname_at(offset + 1, "an element name")?;
        let mut i = offset + 1 + qname.len();
        let mut raw: Vec<(String, String, usize)> = Vec::new();
        let self_closing;
        loop {
            let at = skip_space(text, i);
            let b = text.as_bytes();
            if b.get(at) == Some(&b'>') {
                i = at + 1;
                self_closing = false;
                break;
            }
            if b.get(at) == Some(&b'/') && b.get(at + 1) == Some(&b'>') {
                i = at + 2;
                self_closing = true;
                break;
            }
            if at >= text.len() {
                return self.fail(format!("Unclosed tag <{qname}>"), offset);
            }
            if at == i {
                return self.fail(
                    format!("Expected whitespace, \">\" or \"/>\" in <{qname}>"),
                    at,
                );
            }
            let name = self.qname_at(at, "an attribute name")?;
            let mut j = skip_space(text, at + name.len());
            if b.get(j) != Some(&b'=') {
                return self.fail(format!("Expected \"=\" after attribute {name}"), j);
            }
            j = skip_space(text, j + 1);
            let quote = match b.get(j) {
                Some(&q @ (b'"' | b'\'')) => char::from(q),
                _ => return self.fail(format!("Expected a quoted value for attribute {name}"), j),
            };
            let Some(close) = text[j + 1..].find(quote).map(|p| p + j + 1) else {
                return self.fail(format!("Unterminated value of attribute {name}"), j);
            };
            let value = &text[j + 1..close];
            if value.contains('<') {
                return self.fail(
                    format!("\"<\" is not allowed in the value of attribute {name}"),
                    j,
                );
            }
            raw.push((name, value.to_owned(), at));
            i = close + 1;
        }
        self.i = i;
        self.open_element(&qname, &raw, offset, self_closing)
    }

    fn open_element(
        &mut self,
        qname: &str,
        raw: &[(String, String, usize)],
        offset: usize,
        self_closing: bool,
    ) -> Result<(), XmlError> {
        let element_offset = self.u16(offset);
        let outer = Rc::clone(&self.namespaces);
        let mut scope: Option<IndexMap<String, String>> = None;
        let mut declared: Vec<(String, String)> = Vec::new();
        for (name, value, at) in raw {
            let prefix = if name == "xmlns" {
                ""
            } else if let Some(prefix) = name.strip_prefix("xmlns:") {
                prefix
            } else {
                continue;
            };
            let at = self.u16(*at);
            let uri = self.attribute_value(value, at)?;
            check_namespace_declaration(prefix, &uri, at)?;
            scope
                .get_or_insert_with(|| (*outer).clone())
                .insert(prefix.to_owned(), uri.clone());
            declared.push((prefix.to_owned(), uri));
        }
        let scope = scope.map_or_else(|| Rc::clone(&outer), Rc::new);
        let (prefix, local, uri) = split_name(qname, &scope, element_offset, true)?;
        let mut attributes = Vec::new();
        let mut seen: Option<Lookup<String, ()>> = (raw.len() > 1).then(Lookup::new);
        for (name, value, at) in raw {
            let at = self.u16(*at);
            if let Some(seen) = seen.as_mut() {
                if seen.contains_key(name) {
                    return syntax(format!("Duplicate attribute {name}"), at);
                }
                seen.insert(name.clone(), ());
            }
            if name == "xmlns" || name.starts_with("xmlns:") {
                continue;
            }
            let (a_prefix, a_local, a_uri) = split_name(name, &scope, at, false)?;
            let value = self.attribute_value(value, at)?;
            // Two prefixes for one namespace still name the same attribute.
            let key = format!("{{{a_uri}}}{a_local}");
            if let Some(seen) = seen.as_mut()
                && !a_prefix.is_empty()
            {
                if seen.contains_key(&key) {
                    return syntax(format!("Duplicate attribute {key}"), at);
                }
                seen.insert(key, ());
            }
            attributes.push(XmlAttribute {
                prefix: a_prefix,
                local: a_local,
                uri: a_uri,
                value,
            });
        }
        self.saw_root = true;
        self.handler.start_element(XmlElement {
            prefix,
            local,
            uri,
            attributes,
            namespaces: declared,
            offset: element_offset,
        })?;
        if self_closing {
            self.handler.end_element(element_offset)?;
        } else {
            self.stack.push(OpenElement {
                qname: qname.to_owned(),
                offset: element_offset,
                outer,
            });
            self.namespaces = scope;
        }
        Ok(())
    }

    fn end_tag(&mut self) -> Result<(), XmlError> {
        let text = self.text;
        let offset = self.i;
        let qname = self.qname_at(offset + 2, "an element name")?;
        let close = skip_space(text, offset + 2 + qname.len());
        if text.as_bytes().get(close) != Some(&b'>') {
            return self.fail(format!("Expected \">\" after </{qname}"), close);
        }
        let Some(open) = self.stack.pop() else {
            return self.fail(format!("Unexpected end tag </{qname}>"), offset);
        };
        if open.qname != qname {
            return self.fail(
                format!("Expected </{}>, found </{qname}>", open.qname),
                offset,
            );
        }
        self.namespaces = open.outer;
        self.i = close + 1;
        let offset = self.u16(offset);
        self.handler.end_element(offset)
    }

    fn markup_declaration(&mut self) -> Result<(), XmlError> {
        let text = self.text;
        let offset = self.i;
        if text[offset..].starts_with("<!--") {
            self.i = self.skip_past("-->", offset + 4, "comment")?;
            if !self.stack.is_empty() {
                self.handler.comment(&text[offset + 4..self.i - 3])?;
            }
        } else if text[offset..].starts_with("<![CDATA[") {
            if self.stack.is_empty() {
                return self.fail(
                    "CDATA sections are only allowed inside the root element",
                    offset,
                );
            }
            let Some(end) = text[offset + 9..].find("]]>").map(|p| p + offset + 9) else {
                return self.fail("Unterminated CDATA section", offset);
            };
            if end > offset + 9 {
                let at = self.u16(offset);
                self.handler.text(&text[offset + 9..end], at)?;
            }
            self.i = end + 3;
        } else if text[offset..].starts_with("<!DOCTYPE") {
            if self.saw_root || self.saw_doctype {
                return self.fail(
                    "A DOCTYPE is only allowed once, before the root element",
                    offset,
                );
            }
            self.saw_doctype = true;
            self.i = self.doctype(offset + 9)?;
        } else {
            return self.fail("Unexpected \"<!\"", offset);
        }
        Ok(())
    }

    fn processing_instruction(&mut self) -> Result<(), XmlError> {
        let text = self.text;
        let offset = self.i;
        let target = self.name_at(offset + 2, "a processing instruction target")?;
        if target.eq_ignore_ascii_case("xml") {
            return self.fail(
                "The XML declaration is only allowed at the very start",
                offset,
            );
        }
        let from = offset + 2 + target.len();
        let Some(end) = text[from..].find("?>").map(|p| p + from) else {
            return self.fail("Unterminated processing instruction", offset);
        };
        if !self.stack.is_empty() {
            let data = text[from..end].trim_start_matches([' ', '\t', '\n']);
            self.handler.processing_instruction(&target, data)?;
        }
        self.i = end + 2;
        Ok(())
    }

    fn characters(&mut self, start: usize, end: usize) -> Result<(), XmlError> {
        let raw = &self.text[start..end];
        if self.stack.is_empty() {
            if !is_xml_space(raw) {
                let first = raw
                    .bytes()
                    .position(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
                    .unwrap_or(0);
                let message = if self.saw_root {
                    "Text after the root element"
                } else {
                    "Text before the root element"
                };
                return self.fail(message, start + first);
            }
            return Ok(());
        }
        let at = self.u16(start);
        if raw.contains('&') {
            let resolved = self.resolve(raw, at, false)?;
            self.handler.text(&resolved, at)
        } else {
            self.handler.text(raw, at)
        }
    }

    // ─── DTD ────────────────────────────────────────────────────────────────

    /// Skips `<!DOCTYPE …>`, reading entity declarations from the internal subset.
    fn doctype(&mut self, start: usize) -> Result<usize, XmlError> {
        let text = self.text;
        let mut i = start;
        loop {
            match text.as_bytes().get(i) {
                None => return self.fail("Unterminated DOCTYPE", start),
                Some(&q @ (b'"' | b'\'')) => {
                    i = self.skip_past(
                        if q == b'"' { "\"" } else { "'" },
                        i + 1,
                        "DOCTYPE literal",
                    )?;
                }
                Some(b'[') => i = self.internal_subset(i + 1)?,
                Some(b'>') => return Ok(i + 1),
                Some(_) => i += 1,
            }
        }
    }

    fn internal_subset(&mut self, start: usize) -> Result<usize, XmlError> {
        let text = self.text;
        let mut i = start;
        loop {
            i = skip_space(text, i);
            if i >= text.len() {
                return self.fail("Unterminated DTD internal subset", start);
            }
            let rest = &text[i..];
            if rest.starts_with(']') {
                return Ok(i + 1);
            }
            i = if rest.starts_with("<!--") {
                self.skip_past("-->", i + 4, "comment")?
            } else if rest.starts_with("<?") {
                self.skip_past("?>", i + 2, "processing instruction")?
            } else if rest.starts_with("<!ENTITY") {
                self.entity_declaration(i)?
            } else if rest.starts_with("<!") {
                self.skip_declaration(i)?
            } else if rest.starts_with('%') {
                self.skip_past(";", i + 1, "parameter entity reference")?
            } else {
                return self.fail("Unexpected content in the DTD internal subset", i);
            };
        }
    }

    /// `<!ENTITY name "value">`, `<!ENTITY name SYSTEM "uri">`, `<!ENTITY % name …>`.
    fn entity_declaration(&mut self, start: usize) -> Result<usize, XmlError> {
        let text = self.text;
        let mut i = skip_space(text, start + 8);
        let parameter = text.as_bytes().get(i) == Some(&b'%');
        if parameter {
            i = skip_space(text, i + 1);
        }
        let name = self.name_at(i, "an entity name")?;
        i = skip_space(text, i + name.len());
        // Without a quoted value it is SYSTEM / PUBLIC: an external entity, never fetched.
        let mut entity = Entity {
            value: String::new(),
            external: true,
            expanded: None,
            expanding: false,
        };
        if let Some(&q @ (b'"' | b'\'')) = text.as_bytes().get(i) {
            let Some(close) = text[i + 1..].find(char::from(q)).map(|p| p + i + 1) else {
                return self.fail(format!("Unterminated value of entity {name}"), i);
            };
            let at = self.u16(i);
            entity = Entity {
                value: character_references(&text[i + 1..close], at)?,
                external: false,
                expanded: None,
                expanding: false,
            };
        }
        // The first declaration of an entity is binding (XML 1.0 §4.2).
        if !parameter && !self.entities.contains_key(&name) {
            self.entities.insert(name, entity);
        }
        self.skip_declaration(start)
    }

    /// Skips a markup declaration up to its closing `>`, honouring quoted literals.
    fn skip_declaration(&mut self, start: usize) -> Result<usize, XmlError> {
        let text = self.text;
        let mut i = start + 2;
        loop {
            match text.as_bytes().get(i) {
                None => return self.fail("Unterminated DTD declaration", start),
                Some(&q @ (b'"' | b'\'')) => {
                    i = self.skip_past(if q == b'"' { "\"" } else { "'" }, i + 1, "DTD literal")?;
                }
                Some(b'>') => return Ok(i + 1),
                Some(_) => i += 1,
            }
        }
    }

    // ─── References ─────────────────────────────────────────────────────────

    /// Attribute value normalization (XML 1.0 §3.3.3, CDATA attributes); `offset` is UTF-16.
    fn attribute_value(&mut self, raw: &str, offset: usize) -> Result<String, XmlError> {
        let spaced = if raw.contains(['\t', '\n']) {
            raw.replace(['\t', '\n'], " ")
        } else {
            raw.to_owned()
        };
        if spaced.contains('&') {
            self.resolve(&spaced, offset, true)
        } else {
            Ok(spaced)
        }
    }

    /// Resolves character and entity references; `offset` (UTF-16) is where `raw` counts from.
    fn resolve(
        &mut self,
        raw: &str,
        offset: usize,
        in_attribute: bool,
    ) -> Result<String, XmlError> {
        let mut out = String::new();
        let mut last = 0;
        while let Some(amp) = raw[last..].find('&').map(|p| p + last) {
            let at = offset + utf16_len(&raw[..amp]);
            let Some(semicolon) = raw[amp + 1..].find(';').map(|p| p + amp + 1) else {
                return syntax("Unterminated \"&\" reference", at);
            };
            let name = &raw[amp + 1..semicolon];
            out.push_str(&raw[last..amp]);
            if name.starts_with('#') {
                out.push(character_reference(name, at)?);
            } else if let Some(value) = predefined(name) {
                out.push_str(value);
            } else {
                out.push_str(&self.entity(name, at, in_attribute)?);
            }
            last = semicolon + 1;
        }
        out.push_str(&raw[last..]);
        Ok(out)
    }

    fn entity(
        &mut self,
        name: &str,
        offset: usize,
        in_attribute: bool,
    ) -> Result<String, XmlError> {
        if !is_entity_name(name) {
            return syntax(format!("Invalid reference \"&{name};\""), offset);
        }
        let Some(entity) = self.entities.get(name) else {
            return syntax(format!("Undeclared entity \"&{name};\""), offset);
        };
        if entity.external {
            return syntax(
                format!(
                    "External entity \"&{name};\" is not loaded (external resources are never fetched)"
                ),
                offset,
            );
        }
        let value = match &entity.expanded {
            Some(expanded) => expanded.clone(),
            None => {
                if entity.expanding {
                    return syntax(format!("Entity \"&{name};\" refers to itself"), offset);
                }
                let raw = entity.value.clone();
                if let Some(e) = self.entities.get_mut(name) {
                    e.expanding = true;
                }
                // Memoized without attribute normalization, which applies per use.
                let expanded = if raw.contains('&') {
                    self.resolve(&raw, offset, false)?
                } else {
                    raw
                };
                if let Some(e) = self.entities.get_mut(name) {
                    e.expanding = false;
                    e.expanded = Some(expanded.clone());
                }
                expanded
            }
        };
        if value.contains('<') {
            return syntax(
                format!("Entity \"&{name};\" contains markup, which is not supported"),
                offset,
            );
        }
        self.expansion += utf16_len(&value);
        if self.expansion > self.expansion_budget {
            return syntax("Entity expansion exceeds the size limit", offset);
        }
        Ok(if in_attribute && value.contains(['\t', '\n']) {
            value.replace(['\t', '\n'], " ")
        } else {
            value
        })
    }

    // ─── Scanning helpers ───────────────────────────────────────────────────

    fn qname_at(&mut self, at: usize, what: &str) -> Result<String, XmlError> {
        match qname_end(self.text, at) {
            Some(end) => Ok(self.text[at..end].to_owned()),
            None => self.fail(format!("Expected {what}"), at),
        }
    }

    fn name_at(&mut self, at: usize, what: &str) -> Result<String, XmlError> {
        match name_end(self.text, at) {
            Some(end) => Ok(self.text[at..end].to_owned()),
            None => self.fail(format!("Expected {what}"), at),
        }
    }

    /// The index just past the next `terminator` at or after `from`.
    fn skip_past(&mut self, terminator: &str, from: usize, what: &str) -> Result<usize, XmlError> {
        let from = from.min(self.text.len());
        match self.text[from..].find(terminator) {
            Some(end) => Ok(from + end + terminator.len()),
            None => self.fail(format!("Unterminated {what}"), from),
        }
    }
}

/// Character references in an entity value are resolved when it is declared (§4.5):
/// `value.replace(/&(#[^;]*);/g, …)`.
fn character_references(value: &str, offset: usize) -> Result<String, XmlError> {
    if !value.contains("&#") {
        return Ok(value.to_owned());
    }
    let mut out = String::new();
    let mut last = 0;
    let mut search = 0;
    while let Some(amp) = value[search..].find("&#").map(|p| p + search) {
        let Some(semicolon) = value[amp + 2..].find(';').map(|p| p + amp + 2) else {
            break;
        };
        out.push_str(&value[last..amp]);
        out.push(character_reference(&value[amp + 1..semicolon], offset)?);
        last = semicolon + 1;
        search = last;
    }
    out.push_str(&value[last..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Log(Vec<String>);

    impl XmlHandler for Log {
        fn start_element(&mut self, e: XmlElement) -> Result<(), XmlError> {
            let attrs: Vec<String> = e
                .attributes
                .iter()
                .map(|a| format!("{}{{{}}}={}", a.local, a.uri, a.value))
                .collect();
            self.0
                .push(format!("<{}{{{}}} {}", e.local, e.uri, attrs.join(" ")));
            Ok(())
        }
        fn end_element(&mut self, _: usize) -> Result<(), XmlError> {
            self.0.push(">".into());
            Ok(())
        }
        fn text(&mut self, v: &str, _: usize) -> Result<(), XmlError> {
            self.0.push(format!("t:{v}"));
            Ok(())
        }
        fn processing_instruction(&mut self, t: &str, d: &str) -> Result<(), XmlError> {
            self.0.push(format!("pi:{t}:{d}"));
            Ok(())
        }
        fn comment(&mut self, v: &str) -> Result<(), XmlError> {
            self.0.push(format!("c:{v}"));
            Ok(())
        }
    }

    fn run(text: &str) -> Result<Vec<String>, (String, usize)> {
        let mut log = Log::default();
        match parse_xml(text, &mut log) {
            Ok(()) => Ok(log.0),
            Err((XmlError::Syntax { message, offset }, source)) => {
                Err((message, line_of(&source, offset)))
            }
            Err((XmlError::Other(e), _)) => Err((e.message.clone(), 0)),
        }
    }

    #[test]
    fn reads_entities_and_namespaces() {
        let doc = "<?xml version=\"1.0\"?>\r\n<!DOCTYPE r [ <!ENTITY e \"&#x41;b\"> ]>\n<r xmlns=\"u\" xmlns:p=\"v\" p:a=\"&e;\t1\"><![CDATA[<x>]]>&lt;<?pi  data?><!--c--></r>";
        assert_eq!(
            run(doc).unwrap(),
            ["<r{u} a{v}=Ab 1", "t:<x>", "t:<", "pi:pi:data", "c:c", ">"]
        );
    }

    #[test]
    fn reports_lines() {
        assert_eq!(
            run("<r>\n\n</s>").unwrap_err(),
            ("Expected </r>, found </s>".to_owned(), 3)
        );
        let bomb = "<!DOCTYPE r [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;\"><!ENTITY c \"&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;\"><!ENTITY d \"&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;\"><!ENTITY e \"&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;\"><!ENTITY f \"&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;\"><!ENTITY g \"&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;\">]>\n<r>&g;</r>";
        assert_eq!(
            run(bomb).unwrap_err().0,
            "Entity expansion exceeds the size limit"
        );
        assert!(is_nc_name("a.b") && !is_nc_name("a:b") && !is_nc_name("1a"));
    }
}
