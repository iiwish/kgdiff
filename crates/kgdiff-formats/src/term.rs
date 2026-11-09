//! RDF terms as kgdiff's TypeScript readers hold them: n3's `NamedNode`, `BlankNode`, `Literal`
//! and RDF 1.2 triple terms. A literal is n3's id string (`"value"`, `"value"@lang`,
//! `"value"@lang--dir`, `"value"^^datatype`) and its parts are read back the way n3's getters
//! read them, so equality, de-duplication and the parts the mapping sees are n3's.

use std::rc::Rc;

use kgdiff_core::text::to_lowercase;

use crate::prefixes::XSD_NS;

pub const XSD_STRING: &str = "http://www.w3.org/2001/XMLSchema#string";
pub const RDF_LANG_STRING: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";
pub const RDF_DIR_LANG_STRING: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString";

/// An RDF term.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Term {
    /// An IRI (or, from a parser that keeps them, a relative IRI reference).
    Named(Rc<str>),
    /// A blank node, by label (without `_:`).
    Blank(Rc<str>),
    Literal(Literal),
    /// An RDF 1.2 triple term (`<<( s p o )>>`).
    Triple(Rc<Triple>),
    /// The default graph (graph position only).
    DefaultGraph,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Triple {
    pub subject: Term,
    pub predicate: Term,
    pub object: Term,
}

/// One statement in a graph.
#[derive(Clone, Debug)]
pub struct Quad {
    pub subject: Term,
    pub predicate: Term,
    pub object: Term,
    pub graph: Term,
}

impl Term {
    pub fn named(iri: impl Into<Rc<str>>) -> Term {
        Term::Named(iri.into())
    }

    pub fn blank(label: impl Into<Rc<str>>) -> Term {
        Term::Blank(label.into())
    }

    /// `term.value` of n3: the IRI, the blank label, the literal's lexical form.
    pub fn value(&self) -> &str {
        match self {
            Term::Named(v) | Term::Blank(v) => v,
            Term::Literal(l) => l.value(),
            Term::Triple(_) | Term::DefaultGraph => "",
        }
    }

    pub fn is_named(&self) -> bool {
        matches!(self, Term::Named(_))
    }

    pub fn is_blank(&self) -> bool {
        matches!(self, Term::Blank(_))
    }

    pub fn is_literal(&self) -> bool {
        matches!(self, Term::Literal(_))
    }

    pub fn as_literal(&self) -> Option<&Literal> {
        match self {
            Term::Literal(l) => Some(l),
            _ => None,
        }
    }

    /// `${termType}\u0000${term.id}` (the key of a value index).
    pub fn key(&self) -> String {
        match self {
            Term::Named(v) => format!("NamedNode\u{0}{v}"),
            Term::Blank(v) => format!("BlankNode\u{0}_:{v}"),
            Term::Literal(l) => format!("Literal\u{0}{}", l.id),
            Term::Triple(t) => format!(
                "Quad\u{0}{}|{}|{}",
                t.subject.key(),
                t.predicate.key(),
                t.object.key()
            ),
            Term::DefaultGraph => "DefaultGraph\u{0}".to_owned(),
        }
    }
}

/// The language (and base direction) or the datatype of a new literal.
pub enum LiteralKind<'a> {
    Language(&'a str, Option<&'a str>),
    Datatype(&'a str),
}

/// An n3 literal: its id string.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Literal {
    id: Rc<str>,
}

impl Literal {
    /// `DataFactory.literal(value, languageOrDatatype)` of n3: a language is lower-cased, a
    /// datatype of `xsd:string` (or none) is left out of the id.
    pub fn new(value: &str, kind: LiteralKind<'_>) -> Literal {
        let id = match kind {
            LiteralKind::Language(language, direction) => {
                let mut id = format!("\"{value}\"@{}", to_lowercase(language));
                if let Some(direction) = direction.filter(|d| !d.is_empty()) {
                    id.push_str("--");
                    id.push_str(&to_lowercase(direction));
                }
                id
            }
            LiteralKind::Datatype(datatype) => {
                if datatype.is_empty() || datatype == XSD_STRING {
                    format!("\"{value}\"")
                } else {
                    format!("\"{value}\"^^{datatype}")
                }
            }
        };
        Literal { id: id.into() }
    }

    /// A plain string literal.
    pub fn string(value: &str) -> Literal {
        Literal::new(value, LiteralKind::Datatype(""))
    }

    #[cfg(test)]
    fn id(&self) -> &str {
        &self.id
    }

    fn last_quote(&self) -> usize {
        self.id.rfind('"').unwrap_or(0)
    }

    /// `value`: between the first character and the last quote.
    pub fn value(&self) -> &str {
        let end = self.last_quote();
        if end == 0 { "" } else { &self.id[1..end] }
    }

    /// `language`: after `@` following the last quote, up to a base direction, lower-cased.
    pub fn language(&self) -> String {
        let id = &*self.id;
        let mut at = self.last_quote() + 1;
        if at < id.len() && id.as_bytes()[at] == b'@' {
            at += 1;
            let dir = id.rfind("--");
            let text = match dir {
                Some(dir) if dir > at => &id[at..dir],
                _ => &id[at..],
            };
            to_lowercase(text).into_owned()
        } else {
            String::new()
        }
    }

    /// `direction`: after the last `--` of a language-tagged literal, lower-cased.
    #[cfg(test)]
    fn direction(&self) -> String {
        let id = &*self.id;
        let end = self.last_quote();
        if id.as_bytes().get(end + 1) != Some(&b'@') {
            return String::new();
        }
        match id.rfind("--") {
            Some(dir) if dir > end && dir + 2 < id.len() => {
                to_lowercase(&id[dir + 2..]).into_owned()
            }
            _ => String::new(),
        }
    }

    /// `datatypeString`.
    pub fn datatype(&self) -> &str {
        let id = &*self.id;
        let at = self.last_quote() + 1;
        match id.as_bytes().get(at) {
            Some(b'^') => &id[(at + 2).min(id.len())..],
            Some(b'@') => {
                if id[at..].contains("--") {
                    RDF_DIR_LANG_STRING
                } else {
                    RDF_LANG_STRING
                }
            }
            _ => XSD_STRING,
        }
    }
}

/// Whether a datatype IRI is in the XSD namespace, and its local name.
pub fn xsd_local(datatype: &str) -> Option<&str> {
    datatype.strip_prefix(XSD_NS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_parts_as_n3() {
        let l = Literal::new("x", LiteralKind::Language("EN-gb", None));
        assert_eq!(
            (l.id(), l.value(), l.language()),
            ("\"x\"@en-gb", "x", "en-gb".to_owned())
        );
        assert_eq!(l.datatype(), RDF_LANG_STRING);
        let d = Literal::new("a--b", LiteralKind::Language("ar", Some("RTL")));
        assert_eq!(
            (d.value(), d.language(), d.direction()),
            ("a--b", "ar".to_owned(), "rtl".to_owned())
        );
        assert_eq!(d.datatype(), RDF_DIR_LANG_STRING);
        let s = Literal::new("q\"", LiteralKind::Datatype(XSD_STRING));
        assert_eq!(
            (s.id(), s.value(), s.datatype()),
            ("\"q\"\"", "q\"", XSD_STRING)
        );
        let t = Literal::new(
            "4",
            LiteralKind::Datatype("http://www.w3.org/2001/XMLSchema#integer"),
        );
        assert_eq!(t.datatype(), "http://www.w3.org/2001/XMLSchema#integer");
        assert_eq!(t.language(), "");
    }
}
