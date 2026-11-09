//! OBO 1.4 flat files → `GraphInput` (`obo.ts`): kgdiff's own lenient parser (RFC 0002, §5).
//!
//! `[Term]` and `[Instance]` stanzas become nodes typed `Term` / `Instance`; `[Typedef]` stanzas
//! are not nodes, their `name` labels the relation. Trailing `! comments` and `{qualifier}`
//! blocks are stripped; OBO escapes are decoded.

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{self, IndexMap, JsStr, Object, Value, json};

use crate::ParseWarningCode;
use crate::prefixes::{PrefixSource, PrefixTable, readable_name, well_known};
use crate::shared::{
    EdgeFields, NodeBuilder, Warnings, compare_strings, invalid_input_with, line_details,
    make_edge, make_meta, slice_utf16, sort_edges, sort_nodes, strip_bom, typed_value,
};

/// What `parse_obo` gives.
pub struct OboParseOutput {
    pub graph: Object,
    pub prefixes: Object,
    /// `[Typedef]` names by relation id, sorted.
    pub predicate_labels: Vec<(String, String)>,
}

struct Clause {
    tag: String,
    value: String,
    line: usize,
}

struct Stanza {
    kind: String,
    line: usize,
    clauses: Vec<Clause>,
}

/// Attributes that are lists by nature: always arrays, even with one value.
const LIST_ATTRS: &[&str] = &[
    "alt_id",
    "consider",
    "def_xrefs",
    "subset",
    "synonyms",
    "xref",
];

/// Tags whose single value is the target of an edge with the tag as predicate.
const EDGE_TAGS: &[&str] = &[
    "is_a",
    "union_of",
    "disjoint_from",
    "equivalent_to",
    "instance_of",
];

const SYNONYM_SCOPES: &[&str] = &["EXACT", "BROAD", "NARROW", "RELATED"];

/// OBO 1.2 scoped synonym tags.
fn legacy_synonym(tag: &str) -> Option<&'static str> {
    match tag {
        "exact_synonym" => Some("EXACT"),
        "broad_synonym" => Some("BROAD"),
        "narrow_synonym" => Some("NARROW"),
        "related_synonym" => Some("RELATED"),
        _ => None,
    }
}

/// Tags whose values contain quoted strings; elsewhere a `"` is an ordinary character.
const QUOTED_TAGS: &[&str] = &[
    "def",
    "synonym",
    "exact_synonym",
    "broad_synonym",
    "narrow_synonym",
    "related_synonym",
    "property_value",
    "xref",
    "idspace",
    "subsetdef",
    "synonymtypedef",
];

fn obo_error(message: String, line: usize) -> KgdiffError {
    invalid_input_with(message, line_details(line))
}

/// Parses OBO text (`parseObo`).
pub fn parse_obo(text: &str, warnings: &mut Warnings) -> Result<OboParseOutput, KgdiffError> {
    let (header, stanzas) = read_frames(text)?;

    let mut meta: Vec<(JsStr, Option<Value>)> = Vec::new();
    let mut id_spaces: Vec<(String, String)> = Vec::new();
    let mut default_namespace: Option<String> = None;
    for clause in &header {
        let value = split_value(&clause.value, &clause.tag).0;
        match clause.tag.as_str() {
            "data-version" => meta.push((
                JsStr::from("version"),
                Some(Value::from(decode_escapes(&value))),
            )),
            "ontology" => meta.push((
                JsStr::from("name"),
                Some(Value::from(decode_escapes(&value))),
            )),
            "default-namespace" => default_namespace = Some(decode_escapes(&value)),
            "idspace" => {
                let parts = tokens(&value);
                match (parts.first(), parts.get(1)) {
                    (Some(prefix), Some(iri)) => id_spaces.push((prefix.clone(), iri.clone())),
                    _ => warnings.add(
                        ParseWarningCode::OboInvalidIdspace,
                        "`idspace` needs a prefix and an IRI.",
                        Some(clause.line),
                    ),
                }
            }
            _ => {}
        }
    }

    // Typedef names are reported for display; edge labels derive from the relation id alone.
    let mut relation_names: IndexMap<String, String> = IndexMap::default();
    for stanza in &stanzas {
        if stanza.kind != "Typedef" {
            continue;
        }
        let id = stanza_id(stanza)?;
        if let Some(name) = stanza.clauses.iter().find(|c| c.tag == "name")
            && !relation_names.contains_key(&id)
        {
            relation_names.insert(id, decode_escapes(&split_value(&name.value, &name.tag).0));
        }
    }

    let mut builder = OboGraphBuilder {
        warnings,
        builders: IndexMap::default(),
        edges: IndexMap::default(),
    };
    for stanza in &stanzas {
        match stanza.kind.as_str() {
            "Term" | "Instance" => builder.add_stanza(stanza)?,
            "Typedef" => {}
            other => builder.warnings.add(
                ParseWarningCode::OboUnknownStanza,
                format!("Skipped unsupported [{other}] stanza."),
                Some(stanza.line),
            ),
        }
    }

    let well_known = well_known();
    let prefixes = PrefixTable::new(&[
        (PrefixSource::WellKnown, &well_known),
        (PrefixSource::Declared, &id_spaces),
    ])
    .record_object();
    let graph_meta = make_meta(meta);
    let mut graph = Object::new();
    graph.insert(
        "nodes",
        Value::Array(
            builder
                .nodes(default_namespace.as_deref())
                .into_iter()
                .map(Value::Object)
                .collect(),
        ),
    );
    graph.insert(
        "edges",
        Value::Array(builder.edges().into_iter().map(Value::Object).collect()),
    );
    if let Some(meta) = graph_meta {
        graph.insert("meta", Value::Object(meta));
    }
    let mut ids: Vec<&String> = relation_names.keys().collect();
    ids.sort_by(|a, b| compare_strings(a, b));
    let predicate_labels = ids
        .into_iter()
        .map(|id| (id.clone(), relation_names[id].clone()))
        .collect();
    Ok(OboParseOutput {
        graph,
        prefixes,
        predicate_labels,
    })
}

// ─── Frames ──────────────────────────────────────────────────────────────────

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `text.split(/\r\n|\r|\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let b = text.as_bytes();
    let (mut start, mut i) = (0, 0);
    while i < b.len() {
        match b[i] {
            b'\r' => {
                lines.push(&text[start..i]);
                i += if b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
                start = i;
            }
            b'\n' => {
                lines.push(&text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    lines.push(&text[start..]);
    lines
}

/// `/^\[([^\]]*)\]\s*(?:!.*)?$/`: the stanza kind of a header line.
fn stanza_header(line: &str) -> Option<&str> {
    let inner = line.strip_prefix('[')?;
    let close = inner.find(']')?;
    let rest = js::trim_start(&inner[close + 1..]);
    if rest.is_empty() || (rest.starts_with('!') && !rest.contains(is_line_terminator)) {
        Some(&inner[..close])
    } else {
        None
    }
}

/// `/^([^\s:]+):[ \t]*(.*)$/`: a tag and its value.
fn tag_value(line: &str) -> Option<(&str, &str)> {
    let end = line
        .char_indices()
        .find(|&(_, c)| js::is_whitespace(c) || c == ':')
        .map_or(line.len(), |(i, _)| i);
    if end == 0 || line.as_bytes().get(end) != Some(&b':') {
        return None;
    }
    let value = line[end + 1..].trim_start_matches([' ', '\t']);
    if value.contains(is_line_terminator) {
        return None;
    }
    Some((&line[..end], value))
}

/// `clip`: at most 60 UTF-16 units, cut to 57 and an ellipsis.
fn clip(text: &str) -> String {
    if js::utf16_len(text) > 60 {
        format!("{}…", slice_utf16(text, 57))
    } else {
        text.to_owned()
    }
}

fn read_frames(text: &str) -> Result<(Vec<Clause>, Vec<Stanza>), KgdiffError> {
    let mut header = Vec::new();
    let mut stanzas: Vec<Stanza> = Vec::new();
    for (index, raw) in split_lines(strip_bom(text)).into_iter().enumerate() {
        let line = js::trim(raw);
        let number = index + 1;
        if line.is_empty() || line.starts_with('!') {
            continue;
        }
        if line.starts_with('[') {
            let Some(kind) = stanza_header(line) else {
                return Err(obo_error(
                    format!(
                        "Invalid OBO on line {number}: malformed stanza header \"{}\".",
                        clip(line)
                    ),
                    number,
                ));
            };
            stanzas.push(Stanza {
                kind: js::trim(kind).to_owned(),
                line: number,
                clauses: Vec::new(),
            });
            continue;
        }
        let Some((tag, value)) = tag_value(line) else {
            return Err(obo_error(
                format!(
                    "Invalid OBO on line {number}: expected \"tag: value\", got \"{}\".",
                    clip(line)
                ),
                number,
            ));
        };
        let clause = Clause {
            tag: tag.to_owned(),
            value: value.to_owned(),
            line: number,
        };
        match stanzas.last_mut() {
            Some(stanza) => stanza.clauses.push(clause),
            None => header.push(clause),
        }
    }
    Ok((header, stanzas))
}

fn stanza_id(stanza: &Stanza) -> Result<String, KgdiffError> {
    let id = stanza
        .clauses
        .iter()
        .find(|c| c.tag == "id")
        .and_then(|c| tokens(&split_value(&c.value, &c.tag).0).into_iter().next());
    id.ok_or_else(|| {
        obo_error(
            format!(
                "Invalid OBO: [{}] stanza on line {} has no id.",
                stanza.kind, stanza.line
            ),
            stanza.line,
        )
    })
}

// ─── Values ──────────────────────────────────────────────────────────────────

/// Decodes OBO escapes: `\n`, `\t`, `\W` (space); any other `\x` is `x`.
fn decode_escapes(text: &str) -> String {
    if !text.contains('\\') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('W') => out.push(' '),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Splits a raw tag value into its text and `{qualifiers}`, dropping a trailing `! comment`
/// (`splitValue`).
fn split_value(raw: &str, tag: &str) -> (String, Option<String>) {
    let quoted_tag = QUOTED_TAGS.contains(&tag);
    let mut quoted = false;
    let mut in_qualifier = false;
    let mut end = raw.len();
    let mut last_brace: Option<usize> = None;
    let mut chars = raw.char_indices();
    while let Some((i, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == '"' && (quoted_tag || in_qualifier) {
            quoted = !quoted;
        } else if quoted {
            continue;
        } else if c == '!' {
            end = i;
            break;
        } else if c == '{' {
            last_brace = Some(i);
            in_qualifier = true;
        } else if c == '}' {
            in_qualifier = false;
        }
    }
    let mut text = js::trim_end(&raw[..end]).to_owned();
    let mut qualifiers = None;
    if let Some(brace) = last_brace
        && brace < end
        && text.ends_with('}')
        && !text.ends_with("\\}")
    {
        qualifiers = Some(text[brace + 1..text.len() - 1].to_owned());
        text = js::trim_end(&text[..brace]).to_owned();
    }
    (text, qualifiers)
}

/// Whitespace-separated tokens (escapes respected and decoded).
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some() {
            current.push(c);
            if let Some(next) = chars.next() {
                current.push(next);
            }
            started = true;
        } else if c == ' ' || c == '\t' {
            if started {
                out.push(decode_escapes(&current));
            }
            current.clear();
            started = false;
        } else {
            current.push(c);
            started = true;
        }
    }
    if started {
        out.push(decode_escapes(&current));
    }
    out
}

/// A leading quoted string and the rest; `None` when `text` does not start with a quote.
fn read_quoted(text: &str, clause: &Clause) -> Result<Option<(String, String)>, KgdiffError> {
    if !text.starts_with('"') {
        return Ok(None);
    }
    let mut chars = text.char_indices().skip(1);
    while let Some((i, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == '"' {
            return Ok(Some((
                decode_escapes(&text[1..i]),
                js::trim(&text[i + 1..]).to_owned(),
            )));
        }
    }
    Err(obo_error(
        format!(
            "Invalid OBO on line {}: unterminated quoted string in `{}`.",
            clause.line, clause.tag
        ),
        clause.line,
    ))
}

/// A leading `[xref, xref "description" {qualifiers}, …]` list.
fn read_xrefs(text: &str, clause: &Clause) -> Result<Vec<String>, KgdiffError> {
    let trimmed = js::trim_start(text);
    if !trimmed.starts_with('[') {
        return Ok(Vec::new());
    }
    let mut items: Vec<&str> = Vec::new();
    let mut quoted = false;
    let mut start = 1;
    let mut chars = trimmed.char_indices().skip(1);
    while let Some((i, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == '"' {
            quoted = !quoted;
        } else if !quoted && (c == ',' || c == ']') {
            items.push(&trimmed[start..i]);
            start = i + 1;
            if c == ']' {
                return Ok(items
                    .into_iter()
                    .map(xref_id)
                    .filter(|id| !id.is_empty())
                    .collect());
            }
        }
    }
    Err(obo_error(
        format!(
            "Invalid OBO on line {}: unterminated xref list in `{}`.",
            clause.line, clause.tag
        ),
        clause.line,
    ))
}

/// The id of one xref, without its quoted description or qualifiers.
fn xref_id(item: &str) -> String {
    let text = js::trim(item);
    let mut end = text.len();
    let mut chars = text.char_indices();
    while let Some((i, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if matches!(c, ' ' | '\t' | '"' | '{') {
            end = i;
            break;
        }
    }
    decode_escapes(&text[..end])
}

fn xsd_local_name(datatype: Option<&str>) -> Option<&str> {
    let datatype = datatype?;
    if let Some(local) = datatype.strip_prefix("xsd:") {
        return Some(local);
    }
    if datatype.starts_with("http://www.w3.org/2001/XMLSchema#") {
        return datatype.rfind('#').map(|hash| &datatype[hash + 1..]);
    }
    None
}

// ─── Graph building ──────────────────────────────────────────────────────────

struct OboGraphBuilder<'w> {
    warnings: &'w mut Warnings,
    builders: IndexMap<String, NodeBuilder>,
    edges: IndexMap<String, EdgeFields>,
}

impl OboGraphBuilder<'_> {
    fn add_stanza(&mut self, stanza: &Stanza) -> Result<(), KgdiffError> {
        let id = stanza_id(stanza)?;
        if self.builders.contains_key(&id) {
            self.warnings.add(
                ParseWarningCode::OboDuplicateId,
                format!(
                    "[{}] {id} is defined more than once; the stanzas were merged.",
                    stanza.kind
                ),
                Some(stanza.line),
            );
        } else {
            self.builders
                .insert(id.clone(), NodeBuilder::new(id.clone()));
        }
        if let Some(node) = self.builders.get_mut(&id) {
            node.types.insert(stanza.kind.clone());
        }
        for clause in &stanza.clauses {
            self.add_clause(&id, clause)?;
        }
        Ok(())
    }

    fn nodes(&mut self, default_namespace: Option<&str>) -> Vec<Object> {
        let mut nodes: Vec<Object> = self
            .builders
            .values_mut()
            .map(|node| {
                if let Some(namespace) = default_namespace
                    && !node.attrs.has("namespace")
                {
                    node.attrs.add("namespace", Value::from(namespace));
                }
                node.build(Some(LIST_ATTRS))
            })
            .collect();
        sort_nodes(&mut nodes);
        nodes
    }

    fn edges(&self) -> Vec<Object> {
        let mut edges: Vec<Object> = self.edges.values().map(make_edge).collect();
        sort_edges(&mut edges);
        edges
    }

    fn add_edge(&mut self, source: &str, predicate: &str, target: &str, relation: Option<&str>) {
        let key = json::to_string(&Value::Array(vec![
            Value::from(source),
            Value::from(predicate),
            Value::from(target),
            relation.map_or(Value::Null, Value::from),
        ]));
        if self.edges.contains_key(&key) {
            return;
        }
        let label = match relation {
            None => readable_name(predicate),
            Some(relation) => format!("{} ({})", readable_name(predicate), readable_name(relation)),
        };
        let attrs = relation.map(|relation| {
            let mut attrs = Object::new();
            attrs.insert("relation", relation);
            attrs
        });
        self.edges.insert(
            key,
            EdgeFields {
                id: None,
                source: source.to_owned(),
                target: target.to_owned(),
                predicate: Some(predicate.to_owned()),
                label: Some(label),
                attrs,
            },
        );
    }

    fn node(&mut self, id: &str) -> &mut NodeBuilder {
        self.builders
            .entry(id.to_owned())
            .or_insert_with(|| NodeBuilder::new(id))
    }

    fn add_clause(&mut self, id: &str, clause: &Clause) -> Result<(), KgdiffError> {
        let tag = clause.tag.as_str();
        let text = split_value(&clause.value, tag).0;
        let parts = tokens(&text);
        let (first, second) = (parts.first().cloned(), parts.get(1).cloned());
        match tag {
            "id" => {}
            "name" => {
                let name = decode_escapes(&text);
                let node = self.node(id);
                match &node.label {
                    None => node.label = Some(name),
                    Some(label) if *label != name => {
                        node.aliases.insert(name);
                        self.warnings.add(
                            ParseWarningCode::OboMultipleNames,
                            format!("{id} has more than one name."),
                            Some(clause.line),
                        );
                    }
                    Some(_) => {}
                }
            }
            "def" => match read_quoted(&text, clause)? {
                None => {
                    self.node(id)
                        .attrs
                        .add("def", Value::from(decode_escapes(&text)));
                    self.warnings.add(
                        ParseWarningCode::OboUnquotedDef,
                        format!("Definition of {id} is not quoted."),
                        Some(clause.line),
                    );
                }
                Some((value, rest)) => {
                    self.node(id).attrs.add("def", Value::from(value));
                    for xref in read_xrefs(&rest, clause)? {
                        self.node(id).attrs.add("def_xrefs", Value::from(xref));
                    }
                }
            },
            "synonym" | "exact_synonym" | "broad_synonym" | "narrow_synonym"
            | "related_synonym" => {
                let quoted = read_quoted(&text, clause)?;
                let (synonym, scope_token) = match &quoted {
                    Some((value, rest)) => {
                        let before_xrefs = match rest.find('[') {
                            Some(i) => &rest[..i],
                            None => rest.as_str(),
                        };
                        (value.clone(), tokens(before_xrefs).into_iter().next())
                    }
                    None => (decode_escapes(&text), None),
                };
                let scope = legacy_synonym(tag).map(str::to_owned).unwrap_or_else(|| {
                    scope_token
                        .filter(|t| SYNONYM_SCOPES.contains(&t.as_str()))
                        .unwrap_or_else(|| "RELATED".to_owned())
                });
                if synonym.is_empty() {
                    return Ok(());
                }
                let node = self.node(id);
                node.aliases.insert(synonym.clone());
                node.attrs
                    .add("synonyms", Value::from(format!("{synonym} ({scope})")));
            }
            "relationship" => match (first, second) {
                (Some(first), Some(second)) => self.add_edge(id, &first, &second, None),
                _ => self.warnings.add(
                    ParseWarningCode::OboInvalidRelationship,
                    "relationship needs a relation and a target.",
                    Some(clause.line),
                ),
            },
            "intersection_of" => match (first, second) {
                (None, _) => self.missing_value(clause),
                (Some(first), None) => self.add_edge(id, tag, &first, None),
                (Some(first), Some(second)) => self.add_edge(id, tag, &second, Some(&first)),
            },
            "is_obsolete" => {
                if first.as_deref() == Some("true") {
                    self.node(id).deprecated = true;
                }
            }
            "replaced_by" => match first {
                None => self.missing_value(clause),
                Some(first) => {
                    self.node(id).replaced_by.insert(first);
                }
            },
            "alt_id" => match first {
                None => self.missing_value(clause),
                Some(first) => {
                    let node = self.node(id);
                    node.replaces.insert(first.clone());
                    node.attrs.add("alt_id", Value::from(first));
                }
            },
            "consider" | "subset" => match first {
                None => self.missing_value(clause),
                Some(first) => self.node(id).attrs.add(tag, Value::from(first)),
            },
            "xref" => {
                let xref = xref_id(&text);
                if xref.is_empty() {
                    self.missing_value(clause);
                } else {
                    self.node(id).attrs.add("xref", Value::from(xref));
                }
            }
            "property_value" => self.add_property_value(id, &text, clause)?,
            _ if EDGE_TAGS.contains(&tag) => match first {
                None => self.missing_value(clause),
                Some(first) => self.add_edge(id, tag, &first, None),
            },
            // namespace, comment, created_by, creation_date and any other tag: kept verbatim.
            _ => self
                .node(id)
                .attrs
                .add(tag, Value::from(decode_escapes(&text))),
        }
        Ok(())
    }

    /// `property_value: prop "text" xsd:type` or `property_value: prop target-id`.
    fn add_property_value(
        &mut self,
        id: &str,
        text: &str,
        clause: &Clause,
    ) -> Result<(), KgdiffError> {
        let space = text.find([' ', '\t']);
        let property = space.map(|s| decode_escapes(&text[..s]));
        let rest = space.map_or("", |s| js::trim(&text[s..]));
        let value = match read_quoted(rest, clause)? {
            Some((value, after)) => Some(typed_value(
                &value,
                xsd_local_name(tokens(&after).first().map(String::as_str)),
            )),
            None => tokens(rest).into_iter().next().map(Value::from),
        };
        match (property, value) {
            (Some(property), Some(value)) => self.node(id).attrs.add(property, value),
            _ => self.missing_value(clause),
        }
        Ok(())
    }

    fn missing_value(&mut self, clause: &Clause) {
        self.warnings.add(
            ParseWarningCode::OboMissingValue,
            format!("`{}` has no value.", clause.tag),
            Some(clause.line),
        );
    }
}
