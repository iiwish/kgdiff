//! Turtle, N-Triples, N-Quads and TriG through `oxttl` (`readN3` of `rdf.ts`, which uses n3;
//! RFC 0002, D-9).
//!
//! oxttl and n3 read the same quads from every corpus input, but oxttl validates IRIs and n3
//! does not: n3 resolves a relative IRI without a base against an empty base (`<../c>` is
//! `</c>`), and keeps IRIs with malformed percent-encodings or ports as written. So a Turtle or
//! TriG text whose strict parse fails on an IRI is read again leniently, with every IRI that has
//! no scheme resolved the way n3 resolves it and checked against n3's IRI characters. N-Triples
//! and N-Quads need no second reading: n3 rejects relative IRIs there too.

use std::rc::Rc;

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{IndexMap, Lookup, Object};
use oxrdf::{GraphName, NamedOrBlankNode, Term as OxTerm};
use oxttl::{NQuadsParser, NTriplesParser, TriGParser, TurtleParser, TurtleSyntaxError};

use crate::iri::is_absolute_iri;
use crate::rdf::RdfDocument;
use crate::shared::invalid_input_with;
use crate::term::{Literal, LiteralKind, Quad, Term, Triple};

/// The RDF syntaxes of this module.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum N3Format {
    Turtle,
    NTriples,
    NQuads,
    TriG,
}

impl N3Format {
    pub fn id(self) -> &'static str {
        match self {
            N3Format::Turtle => "turtle",
            N3Format::NTriples => "ntriples",
            N3Format::NQuads => "nquads",
            N3Format::TriG => "trig",
        }
    }

    fn name(self) -> &'static str {
        match self {
            N3Format::Turtle => "Turtle",
            N3Format::NTriples => "N-Triples",
            N3Format::NQuads => "N-Quads",
            N3Format::TriG => "TriG",
        }
    }
}

/// Reads Turtle-family text; `invalid-input` with the line on syntax errors.
pub fn read_n3(
    text: &str,
    format: N3Format,
    base: Option<&str>,
) -> Result<RdfDocument, KgdiffError> {
    match parse(text, format, base, false) {
        Ok(document) => Ok(document),
        Err(error)
            if matches!(format, N3Format::Turtle | N3Format::TriG)
                && is_iri_error(error.message()) =>
        {
            let mut document =
                parse(text, format, base, true).map_err(|e| syntax_error(&e, format))?;
            resolve_as_n3(&mut document, base)
                .map_err(|line| n3_iri_error(format, line, &error))?;
            Ok(document)
        }
        Err(error) => Err(syntax_error(&error, format)),
    }
}

/// The messages of oxiri's `IriParseError`: an IRI oxttl's strict mode refuses.
fn is_iri_error(message: &str) -> bool {
    [
        "No scheme found in an absolute IRI",
        "Invalid character '",
        "Invalid host IP",
        "Invalid IRI code point",
        "Invalid IRI percent encoding",
        "An IRI path is not allowed to start with //",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
}

fn parse(
    text: &str,
    format: N3Format,
    base: Option<&str>,
    lenient: bool,
) -> Result<RdfDocument, TurtleSyntaxError> {
    let mut labels = BlankLabels::default();
    let mut quads = Vec::new();
    let mut prefixes = Vec::new();
    let base = base.filter(|b| !b.is_empty());
    macro_rules! with_base {
        ($parser:expr) => {{
            let parser = $parser;
            match base {
                Some(base) => parser.clone().with_base_iri(base).unwrap_or(parser),
                None => parser,
            }
        }};
    }
    match format {
        N3Format::Turtle => {
            let mut parser = with_base!(TurtleParser::new());
            if lenient {
                parser = parser.lenient();
            }
            let mut reader = parser.for_slice(text);
            for triple in &mut reader {
                let triple = triple?;
                quads.push(labels.quad(
                    triple.subject,
                    triple.predicate,
                    triple.object,
                    GraphName::DefaultGraph,
                ));
            }
            prefixes.extend(reader.prefixes().map(|(p, i)| (p.to_owned(), i.to_owned())));
        }
        N3Format::TriG => {
            let mut parser = with_base!(TriGParser::new());
            if lenient {
                parser = parser.lenient();
            }
            let mut reader = parser.for_slice(text);
            for quad in &mut reader {
                let quad = quad?;
                quads.push(labels.quad(quad.subject, quad.predicate, quad.object, quad.graph_name));
            }
            prefixes.extend(reader.prefixes().map(|(p, i)| (p.to_owned(), i.to_owned())));
        }
        N3Format::NTriples => {
            for triple in NTriplesParser::new().for_slice(text) {
                let triple = triple?;
                quads.push(labels.quad(
                    triple.subject,
                    triple.predicate,
                    triple.object,
                    GraphName::DefaultGraph,
                ));
            }
        }
        N3Format::NQuads => {
            for quad in NQuadsParser::new().for_slice(text) {
                let quad = quad?;
                quads.push(labels.quad(quad.subject, quad.predicate, quad.object, quad.graph_name));
            }
        }
    }
    Ok(RdfDocument { quads, prefixes })
}

/// Blank node labels by first appearance (`b0`, `b1`, …): oxttl names anonymous blank nodes
/// randomly, and no output may depend on that.
#[derive(Default)]
struct BlankLabels {
    labels: Lookup<String, Rc<str>>,
    count: usize,
    iris: Lookup<String, Rc<str>>,
}

impl BlankLabels {
    fn blank(&mut self, id: &str) -> Term {
        if let Some(label) = self.labels.get(id) {
            return Term::Blank(label.clone());
        }
        let label: Rc<str> = format!("b{}", self.count).into();
        self.count += 1;
        self.labels.insert(id.to_owned(), label.clone());
        Term::Blank(label)
    }

    fn named(&mut self, iri: &str) -> Term {
        if let Some(shared) = self.iris.get(iri) {
            return Term::Named(shared.clone());
        }
        let shared: Rc<str> = iri.into();
        self.iris.insert(iri.to_owned(), shared.clone());
        Term::Named(shared)
    }

    fn subject(&mut self, subject: NamedOrBlankNode) -> Term {
        match subject {
            NamedOrBlankNode::NamedNode(n) => self.named(n.as_str()),
            NamedOrBlankNode::BlankNode(b) => self.blank(b.as_str()),
        }
    }

    fn term(&mut self, term: OxTerm) -> Term {
        match term {
            OxTerm::NamedNode(n) => self.named(n.as_str()),
            OxTerm::BlankNode(b) => self.blank(b.as_str()),
            OxTerm::Literal(l) => {
                let literal = match l.language() {
                    Some(language) => {
                        let direction = l.direction().map(|d| d.to_string());
                        Literal::new(
                            l.value(),
                            LiteralKind::Language(language, direction.as_deref()),
                        )
                    }
                    None => Literal::new(l.value(), LiteralKind::Datatype(l.datatype().as_str())),
                };
                Term::Literal(literal)
            }
            OxTerm::Triple(t) => {
                let t = *t;
                let subject = self.subject(t.subject);
                let predicate = self.named(t.predicate.as_str());
                let object = self.term(t.object);
                Term::Triple(Rc::new(Triple {
                    subject,
                    predicate,
                    object,
                }))
            }
        }
    }

    fn quad(
        &mut self,
        subject: NamedOrBlankNode,
        predicate: oxrdf::NamedNode,
        object: OxTerm,
        graph: GraphName,
    ) -> Quad {
        let subject = self.subject(subject);
        let predicate = self.named(predicate.as_str());
        let object = self.term(object);
        let graph = match graph {
            GraphName::DefaultGraph => Term::DefaultGraph,
            GraphName::NamedNode(n) => self.named(n.as_str()),
            GraphName::BlankNode(b) => self.blank(b.as_str()),
        };
        Quad {
            subject,
            predicate,
            object,
            graph,
        }
    }
}

/// `invalid-input` for a syntax error: `Invalid Turtle: <message> on line N.`, with n3's hint
/// for named graphs in Turtle.
fn syntax_error(error: &TurtleSyntaxError, format: N3Format) -> KgdiffError {
    let line = line_number(error);
    let message = error.message();
    let hint = if format == N3Format::Turtle && mentions_graph(message) {
        " Named graphs need TriG: use a .trig file or format \"trig\"."
    } else {
        ""
    };
    let mut details = Object::new();
    details.insert("format", format.id());
    details.insert("line", line);
    invalid_input_with(
        format!("Invalid {}: {message} on line {line}.{hint}", format.name()),
        details,
    )
}

/// The 1-based line of a syntax error.
fn line_number(error: &TurtleSyntaxError) -> usize {
    usize::try_from(error.location().start.line + 1).unwrap_or(usize::MAX)
}

/// `/\bgraph\b|\{/i`.
fn mentions_graph(message: &str) -> bool {
    if message.contains('{') {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    lower
        .match_indices("graph")
        .any(|(i, _)| (i == 0 || !word(bytes[i - 1])) && bytes.get(i + 5).is_none_or(|&b| !word(b)))
}

fn n3_iri_error(format: N3Format, line: Option<usize>, strict: &TurtleSyntaxError) -> KgdiffError {
    let line = line.unwrap_or_else(|| line_number(strict));
    let mut details = Object::new();
    details.insert("format", format.id());
    details.insert("line", line);
    invalid_input_with(
        format!("Invalid {}: Invalid IRI on line {line}.", format.name()),
        details,
    )
}

// ─── n3's IRI resolution ─────────────────────────────────────────────────────

/// `illegalIriChars` of n3's lexer: what an IRI may not contain once unescaped.
fn has_illegal_iri_char(iri: &str) -> bool {
    iri.chars().any(|c| c <= ' ' || "<>\\\"{}|^`".contains(c))
}

/// Resolves one IRI as n3 does; `Err` when n3 rejects it.
type Resolve<'a> = dyn FnMut(&Rc<str>) -> Result<Rc<str>, Option<usize>> + 'a;

/// Resolves the relative IRIs of a leniently read document as n3 resolves them, and rejects
/// IRIs n3 rejects. `Err` carries no line: the strict error's line is reported.
fn resolve_as_n3(document: &mut RdfDocument, base: Option<&str>) -> Result<(), Option<usize>> {
    let base = N3Base::new(base);
    let mut cache: IndexMap<Rc<str>, Rc<str>> = IndexMap::default();
    let mut resolve = |iri: &Rc<str>| -> Result<Rc<str>, Option<usize>> {
        if let Some(done) = cache.get(iri) {
            return Ok(done.clone());
        }
        if has_illegal_iri_char(iri) {
            return Err(None);
        }
        let resolved: Rc<str> = if is_absolute_iri(iri) {
            iri.clone()
        } else {
            base.resolve_relative(iri).ok_or(None)?.into()
        };
        cache.insert(iri.clone(), resolved.clone());
        Ok(resolved)
    };
    fn term(t: &mut Term, resolve: &mut Resolve<'_>) -> Result<(), Option<usize>> {
        match t {
            Term::Named(iri) => *iri = resolve(iri)?,
            Term::Literal(literal) => {
                let datatype = literal.datatype();
                if literal.language().is_empty() && !is_absolute_iri(datatype) {
                    let resolved = resolve(&Rc::from(datatype))?;
                    *literal = Literal::new(literal.value(), LiteralKind::Datatype(&resolved));
                }
            }
            Term::Triple(triple) => {
                let mut inner = (**triple).clone();
                term(&mut inner.subject, resolve)?;
                term(&mut inner.predicate, resolve)?;
                term(&mut inner.object, resolve)?;
                *triple = Rc::new(inner);
            }
            Term::Blank(_) | Term::DefaultGraph => {}
        }
        Ok(())
    }
    for quad in &mut document.quads {
        term(&mut quad.subject, &mut resolve)?;
        term(&mut quad.predicate, &mut resolve)?;
        term(&mut quad.object, &mut resolve)?;
        term(&mut quad.graph, &mut resolve)?;
    }
    for (_, namespace) in &mut document.prefixes {
        let resolved = resolve(&Rc::from(namespace.as_str()))?;
        *namespace = resolved.to_string();
    }
    Ok(())
}

/// n3's base (`_setBase`): without one, `_baseRoot` and `_baseScheme` are `undefined`, and n3
/// writes that word where they are used (a root-relative `</x>` becomes `undefined/x`); that is
/// reproduced here.
struct N3Base {
    base: String,
    path: String,
    path_has_dot_segments: bool,
    root: Option<String>,
    scheme: Option<String>,
}

impl N3Base {
    fn new(base: Option<&str>) -> N3Base {
        let Some(base) = base.filter(|b| !b.is_empty()) else {
            return N3Base {
                base: String::new(),
                path: String::new(),
                path_has_dot_segments: false,
                root: None,
                scheme: None,
            };
        };
        let base = match base.find('#') {
            Some(i) => &base[..i],
            None => base,
        };
        let path_part = match base.find('?') {
            Some(i) => &base[..i],
            None => base,
        };
        let mut path = if base.contains('/') {
            path_part[..path_part.rfind('/').map_or(0, |i| i + 1)].to_owned()
        } else {
            base.to_owned()
        };
        // `/^(?:([a-z][a-z0-9+.-]*:))?(\/\/[^\/?#]*)?/i`
        let b = base.as_bytes();
        let mut end = 0;
        let mut scheme = None;
        if b.first().is_some_and(u8::is_ascii_alphabetic) {
            let n = b
                .iter()
                .position(|c| !(c.is_ascii_alphanumeric() || b"+.-".contains(c)))
                .unwrap_or(b.len());
            if b.get(n) == Some(&b':') {
                scheme = Some(base[..=n].to_owned());
                end = n + 1;
            }
        }
        let mut authority = false;
        if base[end..].starts_with("//") {
            authority = true;
            let rest = &base[end + 2..];
            end += 2 + rest.find(['/', '?', '#']).unwrap_or(rest.len());
        }
        let root = base[..end].to_owned();
        if authority && (base.len() == root.len() || b.get(root.len()) == Some(&b'?')) {
            path = format!("{root}/");
        }
        N3Base {
            base: base.to_owned(),
            path_has_dot_segments: dot_segments(&path),
            path,
            root: Some(root),
            scheme,
        }
    }

    /// `_resolveRelativeIRI`; `None` where n3 gives `null` (an error).
    fn resolve_relative(&self, iri: &str) -> Option<String> {
        if iri.is_empty() {
            return Some(self.base.clone());
        }
        let undefined =
            |part: &Option<String>| part.clone().unwrap_or_else(|| "undefined".to_owned());
        Some(match iri.as_bytes()[0] {
            b'#' => format!("{}{iri}", self.base),
            b'?' => {
                let base = match self.base.find('?') {
                    Some(i) => &self.base[..i],
                    None => &self.base,
                };
                format!("{base}{iri}")
            }
            b'/' => {
                if iri.as_bytes().get(1) != Some(&b'/') {
                    format!("{}{}", undefined(&self.root), remove_dot_segments(iri))
                } else {
                    match &self.scheme {
                        Some(scheme) => remove_dot_segments(&format!("{scheme}{iri}")),
                        None => remove_dot_segments(&format!(":{iri}"))[1..].to_owned(),
                    }
                }
            }
            _ => {
                // Relative IRIs cannot contain a colon in the first path segment.
                let first = iri.find('/').unwrap_or(iri.len());
                if iri[..first].contains(':') {
                    return None;
                }
                let joined = format!("{}{iri}", self.path);
                if self.path_has_dot_segments || path_dot_segments(iri) {
                    remove_dot_segments(&joined)
                } else {
                    joined
                }
            }
        })
    }
}

/// `/(^|\/)\.\.?($|[/#?])/`.
fn dot_segments(iri: &str) -> bool {
    let b = iri.as_bytes();
    (0..b.len()).any(|i| {
        (i == 0 || b[i - 1] == b'/') && b[i] == b'.' && {
            let j = if b.get(i + 1) == Some(&b'.') {
                i + 2
            } else {
                i + 1
            };
            b.get(j).is_none_or(|c| b"/#?".contains(c))
        }
    })
}

/// `/^[^?#]*(?:^|\/)\.\.?(?:$|[/#?])/`: a dot segment before any query or fragment.
fn path_dot_segments(iri: &str) -> bool {
    let end = iri.find(['?', '#']).map_or(iri.len(), |i| i + 1);
    dot_segments(&iri[..end.min(iri.len())])
}

/// JavaScript's `s.substring(start, end)`: clamped to the string, swapped when reversed.
fn substring(s: &str, start: isize, end: isize) -> &str {
    let len = isize::try_from(s.len()).unwrap_or(isize::MAX);
    let (mut a, mut b) = (start.clamp(0, len), end.clamp(0, len));
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    &s[a.unsigned_abs()..b.unsigned_abs()]
}

/// n3's `_removeDotSegments`, operation for operation (indices as n3 keeps them: `i` starts at
/// -1, before an imaginary slash). Every index it cuts at is next to an ASCII character, so byte
/// indices give the same cuts as JavaScript's UTF-16 ones.
fn remove_dot_segments(iri: &str) -> String {
    if !dot_segments(iri) {
        return iri.to_owned();
    }
    let b = iri.as_bytes();
    let length = isize::try_from(b.len()).unwrap_or(isize::MAX);
    let ch = |i: isize| usize::try_from(i).ok().and_then(|i| b.get(i).copied());
    let mut result = String::new();
    let (mut i, mut path_start, mut segment_start): (isize, isize, isize) = (-1, -1, 0);
    let mut next = Some(b'/');
    while i < length {
        match next {
            // The path starts with the first slash after the authority.
            Some(b':') if path_start < 0 => {
                i += 1;
                if ch(i) == Some(b'/') {
                    i += 1;
                    if ch(i) == Some(b'/') {
                        loop {
                            path_start = i + 1;
                            if path_start < length
                                && !matches!(ch(path_start), Some(b'/' | b'?' | b'#'))
                            {
                                i = path_start;
                            } else {
                                break;
                            }
                        }
                    }
                }
            }
            // A query string or fragment is left as it is.
            Some(b'?' | b'#') => i = length,
            Some(b'/') if ch(i + 1) == Some(b'.') => {
                {
                    i += 1;
                    next = ch(i + 1);
                    match next {
                        Some(b'/') => {
                            result.push_str(substring(iri, segment_start, i - 1));
                            segment_start = i + 1;
                        }
                        None | Some(b'?' | b'#') => {
                            return format!(
                                "{result}{}{}",
                                substring(iri, segment_start, i),
                                substring(iri, i + 1, length)
                            );
                        }
                        Some(b'.') => {
                            i += 1;
                            next = ch(i + 1);
                            if matches!(next, None | Some(b'/' | b'?' | b'#')) {
                                result.push_str(substring(iri, segment_start, i - 2));
                                segment_start = result
                                    .rfind('/')
                                    .and_then(|l| isize::try_from(l).ok())
                                    .unwrap_or(-1);
                                if segment_start >= path_start {
                                    // `result.substr(0, segmentStart)`: nothing for a negative
                                    // length.
                                    let keep = usize::try_from(segment_start).unwrap_or(0);
                                    result.truncate(keep.min(result.len()));
                                }
                                if next != Some(b'/') {
                                    return format!("{result}/{}", substring(iri, i + 1, length));
                                }
                                segment_start = i + 1;
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        i += 1;
        next = ch(i);
    }
    format!("{result}{}", substring(iri, segment_start, length))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_dot_segments_as_n3() {
        // n3 2.13's _removeDotSegments, recorded with Node.
        for (iri, expected) in [
            ("../c", "/c"),
            ("a/./b/../c?x/../y#z/../w", "a/c?x/../y#z/../w"),
            ("http://e/a/b/../../../x", "http://e/x"),
            ("http://e/./a", "http://e/a"),
            ("/a/b/..", "/a/"),
            ("/a/.", "/a/"),
            ("x", "x"),
            ("a/b/../../../c", "/c"),
            ("http://é/a/../b", "http://é/b"),
            ("..", "/"),
            (".", ""),
            ("a/..", "/"),
            ("http://e/a/./", "http://e/a/"),
            ("/./a", "/a"),
            ("/../a", "/a"),
            (":///a/../b", ":///b"),
        ] {
            assert_eq!(remove_dot_segments(iri), expected, "{iri}");
        }
    }

    #[test]
    fn resolves_relative_iris_as_n3() {
        // n3 2.13's _resolveIRI for each base, recorded with Node.
        let references = ["../c", "#x", "/x", "//h/p", "?q", "x", "", "a/../b"];
        for (base, expected) in [
            (
                None,
                ["/c", "#x", "undefined/x", "//h/p", "?q", "x", "", "/b"],
            ),
            (
                Some("urn:a:b"),
                [
                    "urn:a:b../c",
                    "urn:a:b#x",
                    "urn:/x",
                    "urn://h/p",
                    "urn:a:b?q",
                    "urn:a:bx",
                    "urn:a:b",
                    "/b",
                ],
            ),
            (
                Some("http://e"),
                [
                    "http://e/c",
                    "http://e#x",
                    "http://e/x",
                    "http://h/p",
                    "http://e?q",
                    "http://e/x",
                    "http://e",
                    "http://e/b",
                ],
            ),
            (
                Some("http://e/a/b?q#f"),
                [
                    "http://e/c",
                    "http://e/a/b?q#x",
                    "http://e/x",
                    "http://h/p",
                    "http://e/a/b?q",
                    "http://e/a/x",
                    "http://e/a/b?q",
                    "http://e/a/b",
                ],
            ),
            (
                Some("rel/"),
                [
                    "/c", "rel/#x", "/x", "//h/p", "rel/?q", "rel/x", "rel/", "rel/b",
                ],
            ),
        ] {
            let n3 = N3Base::new(base);
            for (reference, expected) in references.iter().zip(expected) {
                assert_eq!(
                    n3.resolve_relative(reference).as_deref(),
                    Some(expected),
                    "{reference} against {base:?}"
                );
            }
        }
        assert_eq!(N3Base::new(None).resolve_relative("1a:b"), None);
    }

    #[test]
    fn hints_at_named_graphs() {
        assert!(mentions_graph("{ is not a valid predicate"));
        assert!(mentions_graph("The prefix GRAPH: has not been declared"));
        assert!(!mentions_graph("paragraphs"));
    }
}
