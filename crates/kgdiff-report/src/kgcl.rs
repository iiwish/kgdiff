//! The KGCL export (`kgdiff --kgcl`): the changes of a diff as
//! [KGCL](https://github.com/INCATools/kgcl) commands, the change language OBO tooling reads.
//! **Experimental**: the mapping may change in a minor release.
//!
//! One command per line, hunk by hunk in the diff's order and, inside a hunk, in the order of its
//! delta operations; the operations that belong to no hunk (the id changes a delta sequences
//! first) come before the hunks. The same diff gives the same bytes.
//!
//! The commands are those of the KGCL grammar `src/kgcl_schema/grammar/kgcl.lark` in the
//! [INCATools/kgcl](https://github.com/INCATools/kgcl) repository at commit
//! `1849f9cbb3ebb4a5ee0e6c62b11238841eb81d66` (2026-11-18), restricted to those the released
//! `kgcl-schema` 0.7.0 on PyPI parses as well (it has no `add label`, `delete class` or
//! `with xrefs`):
//!
//! | kgdiff                                                   | KGCL                                                |
//! | -------------------------------------------------------- | --------------------------------------------------- |
//! | `node.add`                                               | `create node X 'label'` (`create X` without a label) |
//! | `node.remove`                                            | `delete X`                                          |
//! | `edge.add` / `edge.remove`                               | `create edge S P O` / `delete edge S P O`           |
//! | a move (one parent replaced by another)                  | `move S P OLD from OLD to NEW`                      |
//! | `node.set label`                                         | `rename X from 'old' to 'new'`                      |
//! | `node.set aliases`                                       | `create [exact…] synonym 'a' for X` / `remove synonym 'a' for X` |
//! | `node.set deprecated` (with one new `replacedBy`)        | `obsolete X [with replacement Y]` / `unobsolete X`  |
//! | a definition attribute (`def`, `IAO:0000115`, …)         | `add definition` / `change definition` / `remove definition` |
//! | `node.set types`, with [`KgclOptions::rdf_types`]        | `create edge X rdf:type T` / `delete edge X rdf:type T` |
//!
//! Everything else has no KGCL command and is written as a comment, a line starting with `#`
//! that says what was not exported, with the operation as JSON: id changes, other attribute
//! changes, edge labels and attributes, `replaces` and other `replacedBy` changes, splits, merges
//! that are not an obsoletion with replacement, implicit nodes, and any change whose text or id
//! KGCL cannot write. [`Kgcl::comments`] counts them. KGCL itself has no comments: OAK
//! (`runoak apply`) skips `#` lines, while `kgcl_schema.grammar.parser.parse` does not.
//!
//! How text and ids are written, following the grammar:
//!
//! - Labels, synonyms and definitions are `SINGLE_QUOTE_LITERAL`s, which have no escapes: a text
//!   that is empty, holds a `'` or a line break (anything Python's `str.splitlines` splits on)
//!   cannot be written, and its change becomes a comment.
//! - An IRI is compacted to a CURIE with the prefixes the caller passes ([`KgclOptions::prefixes`],
//!   the files' own) and the OBO PURL rule (`http://purl.obolibrary.org/obo/GO_0008150` →
//!   `GO:0008150`), with a prefix of `[A-Za-z0-9_]+` only (the grammar's `CURIE`); an IRI that
//!   does not compact is written `<iri>` (`ID`). Any other id (a CURIE already, or a plain id) is
//!   written as it is, as an `ID`, when it has no whitespace and does not start with a quote or
//!   `<`; otherwise its change becomes a comment.

use kgdiff_core::js::{IndexMap, JsStr, Object, Value, json};
use kgdiff_core::model::{HunkKind, NodeFacet, UnionNode};
use kgdiff_core::{DeltaOp, DiffResult, KgdiffError, NodeField};

use crate::model::is_definition_key;

/// The OBO PURL namespace.
const OBO_PURL: &str = "http://purl.obolibrary.org/obo/";

/// What the KGCL export needs to know besides the diff. **Experimental.**
#[non_exhaustive]
#[derive(Clone, Copy, Debug)]
pub struct KgclOptions<'a> {
    /// `(prefix, namespace)` pairs that compact IRIs to CURIEs, for example the `prefixes` of
    /// the inputs' parse results. When several namespaces match, the longest wins.
    pub prefixes: &'a [(String, String)],
    /// The graphs are OBO: `is_a` is written `rdfs:subClassOf`, and the stanza type `Term` of a
    /// created node goes without saying.
    pub obo: bool,
    /// The graphs are RDF: node types are `rdf:type` statements, written as edges.
    pub rdf_types: bool,
}

impl<'a> KgclOptions<'a> {
    /// The options with these prefixes, for graphs that are neither OBO nor RDF.
    pub fn new(prefixes: &'a [(String, String)]) -> KgclOptions<'a> {
        KgclOptions {
            prefixes,
            obo: false,
            rdf_types: false,
        }
    }
}

/// The KGCL text of a diff. **Experimental.**
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kgcl {
    /// One line per command or comment, each ending in a newline; empty when nothing changed.
    pub text: String,
    /// The KGCL commands written.
    pub commands: usize,
    /// The changes written as comments because KGCL has no command for them.
    pub comments: usize,
}

/// The changes of a diff as KGCL, as `kgdiff --kgcl` writes them. **Experimental.**
/// Deterministic: hunk order, then the order of each hunk's operations.
///
/// ```
/// use kgdiff_core::js::json;
/// use kgdiff_core::{DiffOptions, diff};
/// use kgdiff_report::{KgclOptions, render_kgcl};
///
/// let before = json::parse(r#"{"nodes":[{"id":"GO:1","label":"nucleus"}],"edges":[]}"#)?;
/// let after = json::parse(r#"{"nodes":[{"id":"GO:1","label":"cell nucleus"}],"edges":[]}"#)?;
/// let result = diff(&before, &after, &DiffOptions::default())?;
/// let kgcl = render_kgcl(&result, &KgclOptions::new(&[]))?;
/// assert_eq!(kgcl.text, "rename GO:1 from 'nucleus' to 'cell nucleus'\n");
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
///
/// # Errors
///
/// Returns an `invalid-input` error when `diff` is inconsistent: a hunk refers to an operation
/// its delta does not have.
pub fn render_kgcl(diff: &DiffResult, options: &KgclOptions<'_>) -> Result<Kgcl, KgdiffError> {
    let ops = &diff.delta.ops;
    let mut owned = vec![false; ops.len()];
    for hunk in &diff.hunks {
        for &i in &hunk.ops {
            match owned.get_mut(i) {
                Some(slot) => *slot = true,
                None => {
                    return Err(KgdiffError::invalid_input(format!(
                        "Hunk \"{}\" refers to operation {i}, which the delta does not have.",
                        hunk.id
                    )));
                }
            }
        }
    }
    let mut out = Writer::new(options);
    // The operations of no hunk: a delta's preamble of id changes.
    let preamble: Vec<usize> = (0..ops.len()).filter(|&i| !owned[i]).collect();
    out.ops(diff, &preamble, None);
    for hunk in &diff.hunks {
        let plan = Plan::of(diff, hunk, &out);
        match hunk.kind {
            HunkKind::Split => out.split_note(diff, hunk),
            HunkKind::Merge => out.merge_notes(diff, hunk, &plan),
            _ => {}
        }
        out.ops(diff, &hunk.ops, Some(&plan));
    }
    let mut text = out.lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    Ok(Kgcl {
        text,
        commands: out.commands,
        comments: out.comments,
    })
}

// ─── Text and ids ────────────────────────────────────────────────────────────

/// Python's `str.isspace`, which `\s` in the grammar's regular expressions follows.
fn is_python_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | '\u{1c}'..='\u{1f}'
            | ' '
            | '\u{85}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// What Python's `str.splitlines` splits on: the reference parser reads one command per line.
fn is_line_break(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{1c}'..='\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

/// `text` as a `SINGLE_QUOTE_LITERAL` (`'…'`, no escapes), or `None` when it cannot be one.
fn kgcl_quote(text: &str) -> Option<String> {
    // `''` would be read as an id by the reference parser (`entity[1] != "'"`).
    if text.is_empty() || text.contains('\'') || text.chars().any(is_line_break) {
        return None;
    }
    Some(format!("'{text}'"))
}

/// `/^[a-z][a-z0-9+.-]*:\/\//i`, or a URN.
fn is_url(value: &str) -> bool {
    let b = value.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_alphabetic) {
        return false;
    }
    let end = b
        .iter()
        .position(|c| !(c.is_ascii_alphanumeric() || b"+.-".contains(c)))
        .unwrap_or(b.len());
    value[end..].starts_with("://") || value[..end].eq_ignore_ascii_case("urn") && end < b.len()
}

/// A prefix name the grammar's `CURIE` takes: `[a-zA-Z0-9_]+`.
fn is_curie_prefix(prefix: &str) -> bool {
    !prefix.is_empty()
        && prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A local part the grammar's `CURIE` takes: `((?!>>)\S)+`.
fn is_curie_local(local: &str) -> bool {
    !local.is_empty() && !local.contains(">>") && !local.chars().any(is_python_space)
}

/// Compacts IRIs with a prefix map.
struct Prefixes {
    /// `(prefix, namespace)`, longest namespace first.
    entries: Vec<(String, String)>,
    /// Name → namespace, for the OBO PURL rule.
    by_name: IndexMap<String, String>,
}

impl Prefixes {
    fn new(prefixes: &[(String, String)]) -> Prefixes {
        let mut by_name: IndexMap<String, String> = IndexMap::default();
        for (prefix, namespace) in prefixes {
            if is_curie_prefix(prefix) && !namespace.is_empty() {
                by_name.insert(prefix.clone(), namespace.clone());
            }
        }
        let mut entries: Vec<(String, String)> = by_name
            .iter()
            .map(|(p, n)| (p.clone(), n.clone()))
            .collect();
        entries.sort_by(|(pa, na), (pb, nb)| {
            nb.len()
                .cmp(&na.len())
                .then_with(|| na.cmp(nb))
                .then_with(|| pa.len().cmp(&pb.len()))
                .then_with(|| pa.cmp(pb))
        });
        Prefixes { entries, by_name }
    }

    /// The CURIE of an IRI, when a prefix (or the OBO PURL rule) applies.
    fn compact(&self, iri: &str) -> Option<String> {
        if let Some(local) = iri.strip_prefix(OBO_PURL)
            && let Some((space, id)) = obo_local_id(local)
        {
            let own = format!("{OBO_PURL}{space}_");
            if self.by_name.get(space).is_none_or(|ns| *ns == own) {
                return Some(format!("{space}:{id}"));
            }
        }
        self.entries.iter().find_map(|(prefix, namespace)| {
            iri.strip_prefix(namespace.as_str())
                .filter(|local| is_curie_local(local))
                .map(|local| format!("{prefix}:{local}"))
        })
    }
}

/// `/^([A-Za-z][A-Za-z0-9]*)_([^\s/#?]+)$/` on the local part of an OBO PURL.
fn obo_local_id(local: &str) -> Option<(&str, &str)> {
    let bytes = local.as_bytes();
    if !bytes.first()?.is_ascii_alphabetic() {
        return None;
    }
    let end = bytes
        .iter()
        .position(|b| !b.is_ascii_alphanumeric())
        .unwrap_or(bytes.len());
    if bytes.get(end) != Some(&b'_') {
        return None;
    }
    let rest = &local[end + 1..];
    if !is_curie_local(rest) || rest.contains(['/', '#', '?']) {
        return None;
    }
    Some((&local[..end], rest))
}

// ─── Plans: operations a hunk exports as one command ─────────────────────────

/// Synonym scopes (`exact`, `narrow`, …) by synonym text.
type Scopes = Vec<(String, String)>;

/// The pairings of a hunk: operations written together as one command.
#[derive(Default)]
struct Plan {
    /// `edge.remove` index → (`edge.add` index, the `move` command).
    moves: Vec<(usize, usize, String)>,
    /// `node.set deprecated` index → (`node.set replacedBy` index, the replacement's raw id).
    replacements: Vec<(usize, usize, JsStr)>,
    /// `node.set aliases` index → (`node.attr synonyms` index or `None`, scopes by text).
    synonyms: Vec<(usize, Option<usize>, Scopes)>,
}

impl Plan {
    fn of(diff: &DiffResult, hunk: &kgdiff_core::model::Hunk, out: &Writer<'_>) -> Plan {
        let ops = &diff.delta.ops;
        let in_hunk = || hunk.ops.iter().map(|&i| (i, &ops[i]));
        let mut plan = Plan::default();
        // Moves: one parent replaced by another under a hierarchy predicate.
        for node in hunk.nodes.iter().filter_map(|id| diff.node(id)) {
            let (Some(before), Some(after)) = (&node.before_id, &node.after_id) else {
                continue;
            };
            if before != after {
                continue;
            }
            for facet in &node.facets {
                let NodeFacet::Move {
                    predicate,
                    from,
                    to,
                    ..
                } = facet
                else {
                    continue;
                };
                let (Some(old), Some(new)) = (
                    single(from).and_then(|u| diff.node(u)?.before_id.clone()),
                    single(to).and_then(|u| diff.node(u)?.after_id.clone()),
                ) else {
                    continue;
                };
                let find = |remove: bool, target: &str| {
                    let found: Vec<usize> = in_hunk()
                        .filter(|(_, op)| match op {
                            DeltaOp::EdgeRemove { edge } if remove => {
                                plain_edge(edge, before, predicate, target, true)
                            }
                            DeltaOp::EdgeAdd { edge } if !remove => {
                                plain_edge(edge, before, predicate, target, false)
                            }
                            _ => false,
                        })
                        .map(|(i, _)| i)
                        .collect();
                    single(&found).copied()
                };
                if let (Some(r), Some(a)) = (find(true, &old), find(false, &new))
                    && let (Some(s), Some(p), Some(o), Some(n)) = (
                        out.id(before),
                        out.predicate(predicate),
                        out.id(&old),
                        out.id(&new),
                    )
                {
                    plan.moves
                        .push((r, a, format!("move {s} {p} {o} from {o} to {n}")));
                }
            }
        }
        // Obsoletion with replacement: `deprecated` false → true and one new `replacedBy`.
        for (d, op) in in_hunk() {
            let DeltaOp::NodeSet {
                id,
                field: NodeField::Deprecated,
                to: Value::Bool(true),
                ..
            } = op
            else {
                continue;
            };
            let found = in_hunk().find_map(|(r, op)| match op {
                DeltaOp::NodeSet {
                    id: other,
                    field: NodeField::ReplacedBy,
                    from,
                    to,
                } if other == id && strings(from).is_some_and(|f| f.is_empty()) => {
                    let to = strings(to)?;
                    let only = single(&to)?;
                    out.id(only).is_some().then(|| (r, JsStr::from(*only)))
                }
                _ => None,
            });
            if let Some((r, replacement)) = found {
                plan.replacements.push((d, r, replacement));
            }
        }
        // Synonym scopes: OBO keeps them in the `synonyms` attribute (`text (SCOPE)`).
        for (s, op) in in_hunk() {
            let DeltaOp::NodeSet {
                id,
                field: NodeField::Aliases,
                from,
                to,
            } = op
            else {
                continue;
            };
            let attr = if out.options.obo {
                in_hunk().find_map(|(a, op)| match op {
                    DeltaOp::NodeAttr {
                        id: other,
                        key,
                        from,
                        to,
                    } if other == id && key.as_str() == "synonyms" => Some((a, from, to)),
                    _ => None,
                })
            } else {
                None
            };
            let Some((a, attr_from, attr_to)) = attr else {
                plan.synonyms.push((s, None, Vec::new()));
                continue;
            };
            let before = scopes(attr_from.as_ref());
            let after = scopes(attr_to.as_ref());
            let scopes_of_added = after.clone().unwrap_or_default();
            // The attribute is accounted for when it changes exactly as the aliases do and no
            // kept synonym changes its scope.
            let consistent = match (&before, &after, strings(from), strings(to)) {
                (Some(old), Some(new), Some(from), Some(to)) => {
                    let texts = |list: &[(String, String)]| -> Vec<String> {
                        let mut t: Vec<String> = list.iter().map(|(t, _)| t.clone()).collect();
                        t.sort();
                        t
                    };
                    let mut from: Vec<String> = from.iter().map(|s| (*s).to_owned()).collect();
                    let mut to: Vec<String> = to.iter().map(|s| (*s).to_owned()).collect();
                    from.sort();
                    to.sort();
                    let kept_same = old
                        .iter()
                        .all(|(t, scope)| new.iter().all(|(t2, s2)| t2 != t || s2 == scope));
                    texts(old) == from && texts(new) == to && kept_same
                }
                _ => false,
            };
            plan.synonyms
                .push((s, consistent.then_some(a), scopes_of_added));
        }
        plan
    }

    fn move_at(&self, i: usize) -> Option<&(usize, usize, String)> {
        self.moves.iter().find(|(r, _, _)| *r == i)
    }

    fn consumed(&self, i: usize) -> bool {
        self.moves.iter().any(|(_, a, _)| *a == i)
            || self.replacements.iter().any(|(_, r, _)| *r == i)
            || self.synonyms.iter().any(|(_, a, _)| *a == Some(i))
    }

    fn replacement_of(&self, i: usize) -> Option<&JsStr> {
        self.replacements
            .iter()
            .find(|(d, _, _)| *d == i)
            .map(|(_, _, r)| r)
    }

    fn scopes_at(&self, i: usize) -> &[(String, String)] {
        self.synonyms
            .iter()
            .find(|(s, _, _)| *s == i)
            .map_or(&[], |(_, _, scopes)| scopes.as_slice())
    }
}

fn single<T>(list: &[T]) -> Option<&T> {
    match list {
        [only] => Some(only),
        _ => None,
    }
}

/// The strings of a JSON array of strings.
fn strings(value: &Value) -> Option<Vec<&str>> {
    value.as_array()?.iter().map(Value::as_str).collect()
}

fn member<'a>(object: &'a Object, key: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or("")
}

/// An edge snapshot `source predicate target` with nothing a `move` would drop.
fn plain_edge(edge: &Object, source: &str, predicate: &str, target: &str, removed: bool) -> bool {
    member(edge, "source") == source
        && member(edge, "predicate") == predicate
        && member(edge, "target") == target
        && !edge.contains_key("attrs")
        && (removed || !edge.contains_key("label"))
}

/// `["T1DM (EXACT)", …]` as `(text, scope)` pairs, or `None` when an entry is not of that form.
fn scopes(value: Option<&Value>) -> Option<Scopes> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let mut out = Vec::new();
    for entry in value.as_array()? {
        let entry = entry.as_str()?;
        let (text, scope) = entry.strip_suffix(')')?.rsplit_once(" (")?;
        let scope = match scope {
            "EXACT" => "exact",
            "BROAD" => "broad",
            "NARROW" => "narrow",
            "RELATED" => "related",
            _ => return None,
        };
        if out.iter().any(|(t, _): &(String, String)| t == text) {
            return None;
        }
        out.push((text.to_owned(), scope.to_owned()));
    }
    Some(out)
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/// Why a change is a comment.
const NO_REKEY: &str = "no KGCL command for an id change";
const NO_ATTR: &str = "no KGCL command for an attribute change";
const NO_EDGE_LABEL: &str = "no KGCL command for an edge label change";
const NO_EDGE_ATTR: &str = "no KGCL command for an edge attribute change";
const NO_TYPES: &str = "no KGCL command for a type change";
const NO_REPLACES: &str = "no KGCL command for a replaces change";
const NO_REPLACED_BY: &str = "no KGCL command for a replacedBy change without obsoletion";
const NO_ADD_LABEL: &str = "no KGCL command for giving a node without a label one";
const NO_REMOVE_LABEL: &str = "no KGCL command for removing a label";
const NO_SPLIT: &str = "no KGCL command for a split; its changes follow";
const NO_MERGE: &str = "no KGCL command for a merge that is not an obsoletion with replacement";
const NO_IMPLICIT: &str =
    "no KGCL command for a node the file does not declare (an edge endpoint only)";
const NO_NODE_REST: &str = "no KGCL command for these fields of a created node";
const NO_EDGE_REST: &str = "no KGCL command for the label or attributes of a created edge";
const NO_TEXT: &str = "KGCL cannot quote this text (empty, or with a ' or a line break)";
const NO_ID: &str = "KGCL cannot write this id or predicate";
const NO_VALUE: &str = "no KGCL command for a definition that is not a single text";

struct Writer<'a> {
    options: &'a KgclOptions<'a>,
    prefixes: Prefixes,
    lines: Vec<String>,
    commands: usize,
    comments: usize,
}

impl<'a> Writer<'a> {
    fn new(options: &'a KgclOptions<'a>) -> Writer<'a> {
        Writer {
            options,
            prefixes: Prefixes::new(options.prefixes),
            lines: Vec::new(),
            commands: 0,
            comments: 0,
        }
    }

    /// An id as KGCL writes it, or `None` when it cannot.
    fn id(&self, raw: &str) -> Option<String> {
        if raw.is_empty() || raw.chars().any(is_python_space) {
            return None;
        }
        if is_url(raw) {
            if let Some(curie) = self.prefixes.compact(raw) {
                return Some(curie);
            }
            return (!raw.contains(['<', '>'])).then(|| format!("<{raw}>"));
        }
        match raw.chars().next() {
            Some('\'' | '"' | '<') => None,
            _ => Some(raw.to_owned()),
        }
    }

    /// A predicate: an id, with OBO's `is_a` as `rdfs:subClassOf`.
    fn predicate(&self, raw: &str) -> Option<String> {
        if self.options.obo && raw == "is_a" {
            return Some("rdfs:subClassOf".to_owned());
        }
        self.id(raw)
    }

    fn triple(&self, edge: &Object) -> Option<String> {
        Some(format!(
            "{} {} {}",
            self.id(member(edge, "source"))?,
            self.predicate(member(edge, "predicate"))?,
            self.id(member(edge, "target"))?
        ))
    }

    fn command(&mut self, line: String) {
        self.lines.push(line);
        self.commands += 1;
    }

    /// `# reason: {json}` on one line.
    fn comment(&mut self, reason: &str, detail: Value) {
        let mut text = json::to_string(&detail);
        // JSON leaves these unescaped; Python's `splitlines` would end the line at them.
        for (c, escape) in [
            ('\u{85}', "\\u0085"),
            ('\u{2028}', "\\u2028"),
            ('\u{2029}', "\\u2029"),
        ] {
            if text.contains(c) {
                text = text.replace(c, escape);
            }
        }
        self.lines.push(format!("# {reason}: {text}"));
        self.comments += 1;
    }

    fn split_note(&mut self, diff: &DiffResult, hunk: &kgdiff_core::model::Hunk) {
        let Some(anchor) = diff.node(&hunk.anchor) else {
            return;
        };
        let targets = anchor.facets.iter().find_map(|f| match f {
            NodeFacet::SplitInto { targets, .. } => Some(targets),
            _ => None,
        });
        let mut detail = Object::new();
        detail.insert("hunk", &hunk.id);
        detail.insert("node", raw_id(anchor, true));
        if let Some(targets) = targets {
            let into: Vec<Value> = targets
                .iter()
                .filter_map(|t| diff.node(t))
                .map(|n| Value::from(raw_id(n, false)))
                .collect();
            detail.insert("into", Value::Array(into));
        }
        self.comment(NO_SPLIT, Value::Object(detail));
    }

    fn merge_notes(&mut self, diff: &DiffResult, hunk: &kgdiff_core::model::Hunk, plan: &Plan) {
        let ops = &diff.delta.ops;
        for node in hunk.nodes.iter().filter_map(|id| diff.node(id)) {
            for facet in &node.facets {
                let NodeFacet::MergedInto { target, .. } = facet else {
                    continue;
                };
                let into = diff.node(target).map(|t| raw_id(t, false));
                let expressed = plan.replacements.iter().any(|(d, _, replacement)| {
                    matches!(&ops[*d], DeltaOp::NodeSet { id, .. }
                        if Some(id.as_str()) == node.after_id.as_deref())
                        && Some(replacement.as_str()) == into.as_deref()
                });
                if !expressed {
                    let mut detail = Object::new();
                    detail.insert("hunk", &hunk.id);
                    detail.insert("node", raw_id(node, true));
                    if let Some(into) = into {
                        detail.insert("into", into);
                    }
                    self.comment(NO_MERGE, Value::Object(detail));
                }
            }
        }
    }

    fn ops(&mut self, diff: &DiffResult, indices: &[usize], plan: Option<&Plan>) {
        let empty = Plan::default();
        let plan = plan.unwrap_or(&empty);
        for &i in indices {
            if plan.consumed(i) {
                continue;
            }
            if let Some((_, _, line)) = plan.move_at(i) {
                self.command(line.clone());
                continue;
            }
            self.op(&diff.delta.ops[i], i, plan);
        }
    }

    fn op(&mut self, op: &DeltaOp, i: usize, plan: &Plan) {
        let whole = || op.to_value();
        match op {
            DeltaOp::NodeRekey { .. } => self.comment(NO_REKEY, whole()),
            DeltaOp::EdgeRemove { edge } => match self.triple(edge) {
                Some(triple) => self.command(format!("delete edge {triple}")),
                None => self.comment(NO_ID, whole()),
            },
            DeltaOp::EdgeAdd { edge } => match self.triple(edge) {
                Some(triple) => {
                    self.command(format!("create edge {triple}"));
                    if edge.contains_key("label") || edge.contains_key("attrs") {
                        let mut rest = Object::new();
                        for key in ["source", "predicate", "target", "label", "attrs"] {
                            if let Some(value) = edge.get(key) {
                                rest.insert(key, value.clone());
                            }
                        }
                        self.comment(NO_EDGE_REST, Value::Object(rest));
                    }
                }
                None => self.comment(NO_ID, whole()),
            },
            DeltaOp::NodeRemove { node } => {
                if node.get("implicit") == Some(&Value::Bool(true)) {
                    self.comment(NO_IMPLICIT, whole());
                } else {
                    match self.id(member(node, "id")) {
                        Some(id) => self.command(format!("delete {id}")),
                        None => self.comment(NO_ID, whole()),
                    }
                }
            }
            DeltaOp::NodeAdd { node } => self.node_add(node, whole),
            DeltaOp::NodeSet {
                id,
                field,
                from,
                to,
            } => {
                let Some(x) = self.id(id) else {
                    self.comment(NO_ID, whole());
                    return;
                };
                match field {
                    NodeField::Label => {
                        let (from, to) = (from.as_str().unwrap_or(""), to.as_str().unwrap_or(""));
                        if from == id.as_str() {
                            self.comment(NO_ADD_LABEL, whole());
                        } else if to == id.as_str() {
                            self.comment(NO_REMOVE_LABEL, whole());
                        } else if let (Some(a), Some(b)) = (kgcl_quote(from), kgcl_quote(to)) {
                            self.command(format!("rename {x} from {a} to {b}"));
                        } else {
                            self.comment(NO_TEXT, whole());
                        }
                    }
                    NodeField::Aliases => {
                        let (Some(from), Some(to)) = (strings(from), strings(to)) else {
                            self.comment(NO_TEXT, whole());
                            return;
                        };
                        for alias in from.iter().filter(|a| !to.contains(a)) {
                            self.synonym(&x, id, alias, false, None);
                        }
                        for alias in to.iter().filter(|a| !from.contains(a)) {
                            let scope = scope_of(plan.scopes_at(i), alias);
                            self.synonym(&x, id, alias, true, scope);
                        }
                    }
                    NodeField::Types => {
                        if !self.options.rdf_types {
                            self.comment(NO_TYPES, whole());
                            return;
                        }
                        let (Some(from), Some(to)) = (strings(from), strings(to)) else {
                            self.comment(NO_TYPES, whole());
                            return;
                        };
                        for t in from.iter().filter(|t| !to.contains(t)) {
                            self.type_edge(&x, id, t, false);
                        }
                        for t in to.iter().filter(|t| !from.contains(t)) {
                            self.type_edge(&x, id, t, true);
                        }
                    }
                    NodeField::Deprecated => {
                        if to.as_bool() == Some(true) {
                            match plan.replacement_of(i).and_then(|r| self.id(r)) {
                                Some(r) => {
                                    self.command(format!("obsolete {x} with replacement {r}"));
                                }
                                None => self.command(format!("obsolete {x}")),
                            }
                        } else {
                            self.command(format!("unobsolete {x}"));
                        }
                    }
                    NodeField::Replaces => self.comment(NO_REPLACES, whole()),
                    NodeField::ReplacedBy => self.comment(NO_REPLACED_BY, whole()),
                    _ => self.comment(NO_ATTR, whole()),
                }
            }
            DeltaOp::NodeAttr { id, key, from, to } => {
                if !is_definition_key(key) {
                    self.comment(NO_ATTR, whole());
                    return;
                }
                let Some(x) = self.id(id) else {
                    self.comment(NO_ID, whole());
                    return;
                };
                let text = |v: &Option<Value>| -> Result<Option<String>, &'static str> {
                    match v {
                        None => Ok(None),
                        Some(Value::String(s)) => kgcl_quote(s).map(Some).ok_or(NO_TEXT),
                        Some(_) => Err(NO_VALUE),
                    }
                };
                match (text(from), text(to)) {
                    (Err(reason), _) | (_, Err(reason)) => self.comment(reason, whole()),
                    (Ok(None), Ok(Some(new))) => {
                        self.command(format!("add definition {new} to {x}"));
                    }
                    (Ok(Some(old)), Ok(Some(new))) => {
                        self.command(format!("change definition of {x} from {old} to {new}"));
                    }
                    (Ok(Some(_)), Ok(None)) => {
                        self.command(format!("remove definition for {x}"));
                    }
                    (Ok(None), Ok(None)) => {}
                }
            }
            DeltaOp::EdgeSet { .. } => self.comment(NO_EDGE_LABEL, whole()),
            DeltaOp::EdgeAttr { .. } => self.comment(NO_EDGE_ATTR, whole()),
            _ => self.comment(NO_ATTR, whole()),
        }
    }

    fn synonym(&mut self, x: &str, id: &str, text: &str, added: bool, scope: Option<&str>) {
        match kgcl_quote(text) {
            Some(quoted) if added => {
                let qualifier = scope.map_or(String::new(), |s| format!("{s} "));
                self.command(format!("create {qualifier}synonym {quoted} for {x}"));
            }
            Some(quoted) => self.command(format!("remove synonym {quoted} for {x}")),
            None => {
                let mut detail = Object::new();
                detail.insert("op", "node.set");
                detail.insert("id", id);
                detail.insert("field", "aliases");
                detail.insert(if added { "added" } else { "removed" }, text);
                if let Some(scope) = scope {
                    detail.insert("scope", scope);
                }
                self.comment(NO_TEXT, Value::Object(detail));
            }
        }
    }

    fn type_edge(&mut self, x: &str, id: &str, raw: &str, added: bool) {
        match self.id(raw) {
            Some(t) if added => self.command(format!("create edge {x} rdf:type {t}")),
            Some(t) => self.command(format!("delete edge {x} rdf:type {t}")),
            None => {
                let mut detail = Object::new();
                detail.insert("op", "node.set");
                detail.insert("id", id);
                detail.insert("field", "types");
                detail.insert(if added { "added" } else { "removed" }, raw);
                self.comment(NO_ID, Value::Object(detail));
            }
        }
    }

    /// `create node` and what else KGCL can say about a new node; the rest as one comment.
    fn node_add(&mut self, node: &Object, whole: impl Fn() -> Value) {
        if node.get("implicit") == Some(&Value::Bool(true)) {
            self.comment(NO_IMPLICIT, whole());
            return;
        }
        let raw = member(node, "id");
        let Some(x) = self.id(raw) else {
            self.comment(NO_ID, whole());
            return;
        };
        let mut rest = Object::new();
        rest.insert("id", raw);
        let label = node.get("label").and_then(Value::as_str);
        match label.map(kgcl_quote) {
            Some(Some(quoted)) => self.command(format!("create node {x} {quoted}")),
            Some(None) => {
                self.command(format!("create {x}"));
                rest.insert("label", label.unwrap_or(""));
            }
            None => self.command(format!("create {x}")),
        }
        let empty = Object::new();
        let attrs = node
            .get("attrs")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let mut attrs_rest = attrs.clone();
        // Types.
        if let Some(types) = node.get("types").and_then(strings) {
            let mut kept: Vec<Value> = Vec::new();
            for t in types {
                if self.options.obo && t == "Term" {
                    continue;
                }
                match self.id(t) {
                    Some(id) if self.options.rdf_types => {
                        self.command(format!("create edge {x} rdf:type {id}"));
                    }
                    _ => kept.push(Value::from(t)),
                }
            }
            if !kept.is_empty() {
                rest.insert("types", Value::Array(kept));
            }
        }
        // Synonyms, with OBO scopes when the `synonyms` attribute names one for each.
        if let Some(aliases) = node.get("aliases").and_then(strings) {
            let scoped = if self.options.obo {
                scopes(attrs.get("synonyms")).filter(|s| {
                    let mut texts: Vec<&str> = s.iter().map(|(t, _)| t.as_str()).collect();
                    let mut sorted = aliases.clone();
                    texts.sort();
                    sorted.sort();
                    texts == sorted
                })
            } else {
                None
            };
            let mut kept: Vec<Value> = Vec::new();
            for alias in &aliases {
                match kgcl_quote(alias) {
                    Some(quoted) => {
                        let scope = scoped.as_deref().and_then(|s| scope_of(s, alias));
                        let qualifier = scope.map_or(String::new(), |s| format!("{s} "));
                        self.command(format!("create {qualifier}synonym {quoted} for {x}"));
                    }
                    None => kept.push(Value::from(*alias)),
                }
            }
            if scoped.is_some() && kept.is_empty() {
                attrs_rest.remove("synonyms");
            }
            if !kept.is_empty() {
                rest.insert("aliases", Value::Array(kept));
            }
        }
        // Definitions.
        for (key, value) in attrs.iter() {
            if is_definition_key(key)
                && let Some(quoted) = value.as_str().and_then(kgcl_quote)
            {
                self.command(format!("add definition {quoted} to {x}"));
                attrs_rest.remove(key);
            }
        }
        // Obsoletion.
        let replaced_by = node.get("replacedBy").and_then(strings).unwrap_or_default();
        if node.get("deprecated") == Some(&Value::Bool(true)) {
            match single(&replaced_by).and_then(|r| self.id(r)) {
                Some(r) => self.command(format!("obsolete {x} with replacement {r}")),
                None => {
                    self.command(format!("obsolete {x}"));
                    if let Some(value) = node.get("replacedBy") {
                        rest.insert("replacedBy", value.clone());
                    }
                }
            }
        } else if let Some(value) = node.get("replacedBy") {
            rest.insert("replacedBy", value.clone());
        }
        if let Some(value) = node.get("replaces") {
            rest.insert("replaces", value.clone());
        }
        if !attrs_rest.is_empty() {
            rest.insert("attrs", Value::Object(attrs_rest));
        }
        if rest.len() > 1 {
            self.comment(NO_NODE_REST, Value::Object(rest));
        }
    }
}

fn scope_of<'s>(scopes: &'s [(String, String)], text: &str) -> Option<&'s str> {
    scopes
        .iter()
        .find(|(t, _)| t == text)
        .map(|(_, s)| s.as_str())
}

/// A union node's id in the before (or after) graph, else its union id.
fn raw_id(node: &UnionNode, before: bool) -> JsStr {
    let side = if before {
        node.before_id.as_ref().or(node.after_id.as_ref())
    } else {
        node.after_id.as_ref().or(node.before_id.as_ref())
    };
    side.cloned().unwrap_or_else(|| node.id.clone())
}
