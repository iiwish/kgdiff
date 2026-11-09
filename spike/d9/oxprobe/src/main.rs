use std::collections::HashMap;
use oxrdf::{GraphName, NamedOrBlankNode, Quad, Term};

struct Labels(HashMap<String, String>);
impl Labels {
    fn blank(&mut self, id: &str) -> String {
        let n = self.0.len();
        format!("_:{}", self.0.entry(id.to_owned()).or_insert_with(|| format!("b{n}")))
    }
    fn subject(&mut self, s: &NamedOrBlankNode) -> String {
        match s {
            NamedOrBlankNode::NamedNode(n) => format!("<{}>", n.as_str()),
            NamedOrBlankNode::BlankNode(b) => self.blank(b.as_str()),
        }
    }
    fn term(&mut self, t: &Term) -> String {
        match t {
            Term::NamedNode(n) => format!("<{}>", n.as_str()),
            Term::BlankNode(b) => self.blank(b.as_str()),
            Term::Literal(l) => {
                let mut s = serde_like(l.value());
                if let Some(lang) = l.language() { s.push('@'); s.push_str(lang); }
                s.push_str(&format!("^^<{}>", l.datatype().as_str()));
                if let Some(d) = l.direction() { s.push_str(&format!("--{d}")); }
                s
            }
            Term::Triple(t) => {
                let s = self.subject(&t.subject);
                let o = self.term(&t.object);
                format!("<<( {} <{}> {} )>>", s, t.predicate.as_str(), o)
            }
        }
    }
}

fn serde_like(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn dump(quads: Vec<Quad>, prefixes: Vec<(String, String)>) -> String {
    let mut l = Labels(HashMap::new());
    let mut lines = Vec::new();
    for q in &quads {
        let s = l.subject(&q.subject);
        let o = l.term(&q.object);
        let g = match &q.graph_name {
            GraphName::DefaultGraph => String::new(),
            GraphName::NamedNode(n) => format!(" <{}>", n.as_str()),
            GraphName::BlankNode(b) => format!(" {}", l.blank(b.as_str())),
        };
        lines.push(format!("{} <{}> {}{}", s, q.predicate.as_str(), o, g));
    }
    let mut p: Vec<String> = prefixes.iter().map(|(k, v)| format!("{k:?}:{v:?}")).collect();
    p.sort();
    format!("{}\nprefixes {{{}}}", lines.join("\n"), p.join(","))
}

fn main() {
    let lenient = std::env::var("LENIENT").is_ok();
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).unwrap();
        let name = std::path::Path::new(&path).file_name().unwrap().to_string_lossy().into_owned();
        let ext = name.rsplit('.').next().unwrap().to_owned();
        let out = match ext.as_str() {
            "ttl" | "trig" => {
                let mut quads = Vec::new();
                let mut err = None;
                let prefixes;
                if ext == "ttl" {
                    let mut p = oxttl::TurtleParser::new();
                    if lenient { p = p.lenient(); }
                    let mut it = p.for_slice(&bytes);
                    for t in &mut it { match t { Ok(t) => quads.push(t.in_graph(GraphName::DefaultGraph)), Err(e) => { err = Some(e.to_string()); break; } } }
                    prefixes = it.prefixes().map(|(a, b)| (a.to_owned(), b.to_owned())).collect();
                } else {
                    let mut p = oxttl::TriGParser::new();
                    if lenient { p = p.lenient(); }
                    let mut it = p.for_slice(&bytes);
                    for t in &mut it { match t { Ok(t) => quads.push(t), Err(e) => { err = Some(e.to_string()); break; } } }
                    prefixes = it.prefixes().map(|(a, b)| (a.to_owned(), b.to_owned())).collect();
                }
                match err { Some(e) => format!("ERROR {e}"), None => dump(quads, prefixes) }
            }
            "nt" | "nq" => {
                let mut quads = Vec::new();
                let mut err = None;
                if ext == "nt" {
                    let mut p = oxttl::NTriplesParser::new(); if lenient { p = p.lenient(); }
                    for t in p.for_slice(&bytes) { match t { Ok(t) => quads.push(t.in_graph(GraphName::DefaultGraph)), Err(e) => { err = Some(e.to_string()); break; } } }
                } else {
                    let mut p = oxttl::NQuadsParser::new(); if lenient { p = p.lenient(); }
                    for t in p.for_slice(&bytes) { match t { Ok(t) => quads.push(t), Err(e) => { err = Some(e.to_string()); break; } } }
                }
                match err { Some(e) => format!("ERROR {e}"), None => dump(quads, vec![]) }
            }
            "rdf" | "owl" => {
                let mut quads = Vec::new();
                let mut err = None;
                let mut p = oxrdfxml::RdfXmlParser::new(); if lenient { p = p.lenient(); }
                let mut it = p.for_slice(&bytes);
                for t in &mut it { match t { Ok(t) => quads.push(t.in_graph(GraphName::DefaultGraph)), Err(e) => { err = Some(e.to_string()); break; } } }
                let prefixes: Vec<(String,String)> = it.prefixes().map(|(a, b)| (a.to_owned(), b.to_owned())).collect();
                match err { Some(e) => format!("ERROR {e}"), None => dump(quads, prefixes) }
            }
            "jsonld" | "json" => {
                let mut quads = Vec::new();
                let mut err = None;
                let mut p = oxjsonld::JsonLdParser::new(); if lenient { p = p.lenient(); }
                let mut it = p.for_slice(&bytes);
                for t in &mut it { match t { Ok(t) => quads.push(t), Err(e) => { err = Some(e.to_string()); break; } } }
                let prefixes: Vec<(String,String)> = it.prefixes().map(|(a, b)| (a.to_owned(), b.to_owned())).collect();
                match err { Some(e) => format!("ERROR {e}"), None => dump(quads, prefixes) }
            }
            _ => "?".into(),
        };
        println!("=== {name}\n{out}");
    }
}
