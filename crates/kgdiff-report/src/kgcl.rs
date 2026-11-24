//! The KGCL export (`kgdiff --kgcl`): the changes of a diff as
//! [KGCL](https://github.com/INCATools/kgcl) commands, the change language OBO tooling reads.
//! **Experimental**: the mapping may change in a minor release.
//!
//! The commands are a change list to apply to the **before** file (OAK's `runoak apply` is the
//! consumer in mind): one command per line, hunk by hunk in the diff's order and, inside a hunk,
//! in the order of its delta operations, except that a created node a command names as a
//! replacement is created before that command, even when its hunk comes later. The operations that belong to no hunk (the changes of
//! ignored attributes and the id changes a delta sequences first) come before the hunks. The
//! same diff gives the same bytes.
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
//! | `node.set label`                                         | `rename X from 'old' to 'new'`                      |
//! | `node.set aliases`                                       | `create [exact…] synonym 'a' for X` / `remove synonym 'a' for X` |
//! | `node.set deprecated` (with one new `replacedBy`)        | `obsolete X [with replacement Y]` / `unobsolete X`  |
//! | a definition attribute (`def`, `IAO:0000115`, …)         | `add definition` / `change definition` / `remove definition` |
//! | `node.set types`, with [`KgclOptions::rdf_types`]        | `create edge X rdf:type T` / `delete edge X rdf:type T` |
//!
//! A move (one parent replaced by another) is its `delete edge` and its `create edge`, not KGCL's
//! `move`: OAK's simpleobo implementation only logs a warning for a `NodeMove`, and its sqldb
//! implementation does not implement it.
//!
//! KGCL cannot change an id, so the id changes are not exported (each is a comment), and every
//! command names a node by its id in the before file, the file the commands apply to: after
//! `A:1` became `A:2`, `rename A:1 …`. A node that takes the old id of a renamed node cannot be
//! named so, and its changes are comments.
//!
//! An edge whose triple stays (another edge with the same source, predicate and target remains,
//! or was there already) is a comment: `delete edge` would remove the triple, and `create edge`
//! would add nothing. With OBO inputs only `is_a` and `relationship` clauses are edges KGCL can
//! write; `intersection_of`, `union_of`, `equivalent_to`, `disjoint_from` and `instance_of` are
//! comments.
//!
//! Everything else has no KGCL command and is written as a comment, a line starting with `#`
//! that says what was not exported, with the operation as JSON, as it is in the delta: id
//! changes, other attribute changes, edge labels and attributes, `replaces` and other
//! `replacedBy` changes, implicit nodes, and any change whose text or id KGCL cannot write. A
//! split, and a merge that is not an obsoletion with replacement, get a note before their
//! changes. [`Kgcl`] counts the comments of each kind. KGCL itself has no comments: OAK
//! (`runoak apply`) skips `#` lines, while `kgcl_schema.grammar.parser.parse` does not.
//!
//! How text and ids are written, following the grammar:
//!
//! - Labels, synonyms and definitions are `SINGLE_QUOTE_LITERAL`s, which have no escapes: a text
//!   that is empty, holds a `'` or a line break (anything Python's `str.splitlines` splits on)
//!   cannot be written, and its change becomes a comment. A removed definition needs no text
//!   (`remove definition for X`), and a changed one whose old text cannot be written is
//!   `change definition of X to 'new'`; `rename` and the synonym commands have no such form.
//! - An IRI is compacted to a CURIE with the prefixes the caller passes ([`KgclOptions::prefixes`],
//!   the files' own) and the OBO PURL rule (`http://purl.obolibrary.org/obo/GO_0008150` →
//!   `GO:0008150`), with a prefix of `[A-Za-z0-9_]+` only (the grammar's `CURIE`); an IRI that
//!   does not compact is written `<iri>` (`ID`). Any other id (a CURIE already, or a plain id) is
//!   written as it is, as an `ID`, when it has no whitespace and does not start with a quote or
//!   `<`; otherwise its change becomes a comment.

use kgdiff_core::js::{IndexMap, JsStr, Lookup, Object, Value, json};
use kgdiff_core::model::{Hunk, HunkKind, NodeFacet, UnionNode};
use kgdiff_core::{DeltaOp, DiffResult, KgdiffError, NodeField};

use crate::model::is_definition_key;

/// The OBO PURL namespace.
const OBO_PURL: &str = "http://purl.obolibrary.org/obo/";

/// The OBO tags kgdiff reads as edges that are not relations between two terms: KGCL's
/// `create edge` / `delete edge` would say something else.
const OBO_NOT_RELATIONS: [&str; 5] = [
    "disjoint_from",
    "equivalent_to",
    "instance_of",
    "intersection_of",
    "union_of",
];

/// What the KGCL export needs to know besides the diff. **Experimental.**
#[non_exhaustive]
#[derive(Clone, Copy, Debug)]
pub struct KgclOptions<'a> {
    /// `(prefix, namespace)` pairs that compact IRIs to CURIEs, for example the `prefixes` of
    /// the inputs' parse results. When several namespaces match, the longest wins.
    pub prefixes: &'a [(String, String)],
    /// The graphs are OBO: `is_a` is written `rdfs:subClassOf`, the stanza type `Term` of a
    /// created node goes without saying, and the edges of `intersection_of`, `union_of`,
    /// `equivalent_to`, `disjoint_from` and `instance_of` clauses are comments.
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
    /// The comment lines written: `unexported` + `partial` + the notes before a split or a merge
    /// that is not an obsoletion with replacement (their changes follow them).
    pub comments: usize,
    /// The changes written as comments instead of commands, which applying the commands leaves
    /// out: an operation KGCL has no command for, or one synonym or type of an operation.
    pub unexported: usize,
    /// The created nodes and edges with fields their command cannot carry, written as a comment
    /// after it.
    pub partial: usize,
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
    let mut out = Writer::new(options, diff);
    // The operations of no hunk: a delta's preamble of ignored attributes and id changes.
    let preamble: Vec<usize> = (0..ops.len()).filter(|&i| !owned[i]).collect();
    out.ops(diff, &preamble, &Plan::default());
    for hunk in &diff.hunks {
        let plan = Plan::of(diff, hunk, &out);
        match hunk.kind {
            HunkKind::Split => out.split_note(diff, hunk),
            HunkKind::Merge => out.merge_notes(diff, hunk, &plan),
            _ => {}
        }
        out.ops(diff, &hunk.ops, &plan);
    }
    let mut text = out.lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    Ok(Kgcl {
        text,
        commands: out.commands,
        comments: out.unexported + out.partial + out.notes,
        unexported: out.unexported,
        partial: out.partial,
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

// ─── Id changes ──────────────────────────────────────────────────────────────

/// The id changes of a delta, which KGCL cannot write: the commands name each node by its id in
/// the before file.
#[derive(Default)]
struct Rekeys<'d> {
    /// The operations from this index on come after every `node.rekey` and name nodes by their
    /// new ids; the ones before (the changes of ignored attributes) by their ids in the before
    /// file.
    renamed_from: usize,
    /// A renamed node's id after the delta's renames → its id in the before file.
    to_before: Lookup<&'d str, &'d str>,
    /// A renamed node's id in the before file → its id after the renames.
    to_after: Lookup<&'d str, &'d str>,
}

impl<'d> Rekeys<'d> {
    fn of(ops: &'d [DeltaOp]) -> Rekeys<'d> {
        // The renames run in order and may go through temporary ids: follow each node.
        let mut current: IndexMap<&'d str, &'d str> = IndexMap::default();
        let mut renamed_from = 0;
        for (i, op) in ops.iter().enumerate() {
            if let DeltaOp::NodeRekey { from, to } = op {
                let origin = current.shift_remove(from.as_str()).unwrap_or(from.as_str());
                current.insert(to.as_str(), origin);
                renamed_from = i + 1;
            }
        }
        let mut rekeys = Rekeys {
            renamed_from,
            ..Rekeys::default()
        };
        for (&now, &origin) in &current {
            rekeys.to_before.insert(now, origin);
            rekeys.to_after.insert(origin, now);
        }
        rekeys
    }
}

/// The `(source, predicate, target)` triples of a graph's edges.
type Triples<'d> = Lookup<(&'d str, &'d str, &'d str), ()>;

fn triples(graph: &kgdiff_core::KGraph) -> Triples<'_> {
    let mut set = Lookup::with_capacity(graph.edge_count());
    for edge in graph.edges() {
        set.insert(
            (
                edge.source().as_str(),
                edge.predicate().as_str(),
                edge.target().as_str(),
            ),
            (),
        );
    }
    set
}

// ─── Plans: operations a hunk exports together ───────────────────────────────

/// Synonym scopes (`exact`, `narrow`, …) by synonym text.
type Scopes<'d> = Lookup<&'d str, &'static str>;

/// How a hunk's operations are written together, by operation index.
#[derive(Default)]
struct Plan<'d> {
    /// Operations another one writes: a `replacedBy` an obsoletion names, a `synonyms`
    /// attribute the aliases account for.
    consumed: Lookup<usize, ()>,
    /// `node.set deprecated` → the replacement's id (as the delta writes it).
    replacement: Lookup<usize, &'d str>,
    /// The node a `node.set deprecated` obsoletes → its replacement, for the merge notes.
    obsoleted: Lookup<&'d str, &'d str>,
    /// `node.set aliases` → the scopes of the added synonyms.
    scopes: Lookup<usize, Scopes<'d>>,
    /// A `node.set deprecated` → the `node.add` of its replacement, written before it (even
    /// when that `node.add` belongs to a later hunk).
    first: Lookup<usize, usize>,
}

impl<'d> Plan<'d> {
    fn of(diff: &'d DiffResult, hunk: &Hunk, out: &Writer<'_>) -> Plan<'d> {
        let ops = &diff.delta.ops;
        // The hunk's operations by node id.
        let mut replaced_by: Lookup<&str, usize> = Lookup::new();
        let mut synonyms: Lookup<&str, usize> = Lookup::new();
        for &i in &hunk.ops {
            match &ops[i] {
                DeltaOp::NodeSet {
                    id,
                    field: NodeField::ReplacedBy,
                    ..
                } => {
                    replaced_by.get_or_insert_with(id.as_str(), || i);
                }
                DeltaOp::NodeAttr { id, key, .. }
                    if out.options.obo && key.as_str() == "synonyms" =>
                {
                    synonyms.get_or_insert_with(id.as_str(), || i);
                }
                _ => {}
            }
        }
        let mut plan = Plan::default();
        for &i in &hunk.ops {
            match &ops[i] {
                // Obsoletion with replacement: `deprecated` false → true and one new `replacedBy`.
                DeltaOp::NodeSet {
                    id,
                    field: NodeField::Deprecated,
                    to: Value::Bool(true),
                    ..
                } => {
                    let Some(&r) = replaced_by.get(id.as_str()) else {
                        continue;
                    };
                    let DeltaOp::NodeSet { from, to, .. } = &ops[r] else {
                        continue;
                    };
                    if !strings(from).is_some_and(|f| f.is_empty()) {
                        continue;
                    }
                    let Some(&only) = strings(to).as_deref().and_then(single) else {
                        continue;
                    };
                    if out.node(only, true).is_err() {
                        continue;
                    }
                    plan.consumed.insert(r, ());
                    plan.replacement.insert(i, only);
                    plan.obsoleted.insert(id.as_str(), only);
                    if let Some(&a) = out.created.get(only) {
                        plan.first.insert(i, a);
                    }
                }
                // Synonym scopes: OBO keeps them in the `synonyms` attribute (`text (SCOPE)`).
                DeltaOp::NodeSet {
                    id,
                    field: NodeField::Aliases,
                    from,
                    to,
                } => {
                    let Some(&a) = synonyms.get(id.as_str()) else {
                        continue;
                    };
                    let DeltaOp::NodeAttr {
                        from: attr_from,
                        to: attr_to,
                        ..
                    } = &ops[a]
                    else {
                        continue;
                    };
                    let before = scopes(attr_from.as_ref());
                    let after = scopes(attr_to.as_ref());
                    // The attribute is accounted for when it changes exactly as the aliases do
                    // and no kept synonym changes its scope.
                    if let (Some(old), Some(new), Some(from), Some(to)) =
                        (&before, &after, strings(from), strings(to))
                    {
                        let by_text = scope_lookup(new);
                        let kept_same = old
                            .iter()
                            .all(|(t, scope)| by_text.get(t).is_none_or(|s| s == scope));
                        if same_texts(old, from) && same_texts(new, to) && kept_same {
                            plan.consumed.insert(a, ());
                        }
                    }
                    if let Some(new) = &after {
                        plan.scopes.insert(i, scope_lookup(new));
                    }
                }
                _ => {}
            }
        }
        plan
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

/// `["T1DM (EXACT)", …]` as `(text, scope)` pairs, or `None` when an entry is not of that form
/// or a text comes twice.
fn scopes(value: Option<&Value>) -> Option<Vec<(&str, &'static str)>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let list = value.as_array()?;
    let mut out = Vec::with_capacity(list.len());
    let mut seen: Lookup<&str, ()> = Lookup::with_capacity(list.len());
    for entry in list {
        let entry = entry.as_str()?;
        let (text, scope) = entry.strip_suffix(')')?.rsplit_once(" (")?;
        let scope = match scope {
            "EXACT" => "exact",
            "BROAD" => "broad",
            "NARROW" => "narrow",
            "RELATED" => "related",
            _ => return None,
        };
        if seen.insert(text, ()).is_some() {
            return None;
        }
        out.push((text, scope));
    }
    Some(out)
}

fn scope_lookup<'d>(list: &[(&'d str, &'static str)]) -> Scopes<'d> {
    let mut by_text = Lookup::with_capacity(list.len());
    for &(text, scope) in list {
        by_text.insert(text, scope);
    }
    by_text
}

/// The scoped synonyms have exactly these texts.
fn same_texts(scoped: &[(&str, &str)], texts: Vec<&str>) -> bool {
    let mut a: Vec<&str> = scoped.iter().map(|(t, _)| *t).collect();
    let mut b = texts;
    a.sort();
    b.sort();
    a == b
}

/// The values of `list` that `other` does not have, in `list`'s order.
fn missing_from<'v>(list: &[&'v str], other: &[&str]) -> Vec<&'v str> {
    let mut has: Lookup<&str, ()> = Lookup::with_capacity(other.len());
    for v in other {
        has.insert(v, ());
    }
    list.iter()
        .copied()
        .filter(|v| !has.contains_key(v))
        .collect()
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/// Why a change is a comment.
const NO_REKEY: &str =
    "no KGCL command for an id change, so it is not exported and the commands below use the old id";
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
const NO_OBO_CLAUSE: &str = "no KGCL command for an OBO clause that is not is_a or relationship";
const NO_NODE_REST: &str = "no KGCL command for these fields of a created node";
const NO_EDGE_REST: &str = "no KGCL command for the label or attributes of a created edge";
const NO_TEXT: &str = "KGCL cannot quote this text (empty, or with a ' or a line break)";
const NO_ID: &str = "KGCL cannot write this id or predicate";
const NO_OLD_ID: &str =
    "KGCL cannot write this id: in the before file it is the old id of a renamed node";
const NO_VALUE: &str = "no KGCL command for a definition that is not a single text";
const EDGE_KEPT: &str = "KGCL cannot remove this edge alone: an edge with the same source, predicate and target remains";
const EDGE_THERE: &str = "KGCL cannot add this edge: an edge with the same source, predicate and target is there already";
const EDGE_REMOVED_ABOVE: &str = "KGCL cannot remove this edge alone: another edge with the same source, predicate and target is removed above";
const EDGE_ADDED_ABOVE: &str = "KGCL cannot add this edge: another edge with the same source, predicate and target is added above";

/// What a comment line stands for.
#[derive(Clone, Copy)]
enum Kind {
    /// A change, or a synonym or type of one, left out.
    Unexported,
    /// The fields of a created node or edge its command cannot carry.
    Partial,
    /// A note before a split or a merge, whose changes follow.
    Note,
}

struct Writer<'a> {
    options: &'a KgclOptions<'a>,
    prefixes: Prefixes,
    rekeys: Rekeys<'a>,
    /// The edge triples of the before and the after graph, when the delta adds or removes edges.
    triples: Option<(Triples<'a>, Triples<'a>)>,
    /// The operation being written names nodes by their ids after the renames.
    after_ids: bool,
    /// The `delete edge` and `create edge` lines written.
    edge_lines: Lookup<String, ()>,
    /// The `node.add` of each created node, by id.
    created: Lookup<&'a str, usize>,
    /// A `node.add` of a node created obsolete → the `node.add` of its replacement.
    first: Lookup<usize, usize>,
    /// The operations written (or written by another one).
    written: Lookup<usize, ()>,
    lines: Vec<String>,
    commands: usize,
    unexported: usize,
    partial: usize,
    notes: usize,
}

impl<'a> Writer<'a> {
    fn new(options: &'a KgclOptions<'a>, diff: &'a DiffResult) -> Writer<'a> {
        let ops = &diff.delta.ops;
        let has_edges = ops
            .iter()
            .any(|op| matches!(op, DeltaOp::EdgeAdd { .. } | DeltaOp::EdgeRemove { .. }));
        let mut created: Lookup<&'a str, usize> = Lookup::new();
        for (i, op) in ops.iter().enumerate() {
            if let DeltaOp::NodeAdd { node } = op {
                created.get_or_insert_with(member(node, "id"), || i);
            }
        }
        let mut first: Lookup<usize, usize> = Lookup::new();
        for (i, op) in ops.iter().enumerate() {
            if let DeltaOp::NodeAdd { node } = op
                && node.get("deprecated") == Some(&Value::Bool(true))
                && let Some(replaced_by) = node.get("replacedBy").and_then(strings)
                && let Some(&only) = single(&replaced_by)
                && let Some(&a) = created.get(only)
                && a != i
            {
                first.insert(i, a);
            }
        }
        Writer {
            options,
            prefixes: Prefixes::new(options.prefixes),
            rekeys: Rekeys::of(ops),
            triples: has_edges.then(|| (triples(&diff.before), triples(&diff.after))),
            after_ids: true,
            edge_lines: Lookup::new(),
            created,
            first,
            written: Lookup::with_capacity(ops.len()),
            lines: Vec::new(),
            commands: 0,
            unexported: 0,
            partial: 0,
            notes: 0,
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

    /// The id a node has in the before file, the one the commands name it by.
    fn before_id<'r>(&'r self, raw: &'r str, after_ids: bool) -> Result<&'r str, &'static str> {
        if !after_ids {
            return Ok(raw);
        }
        match self.rekeys.to_before.get(raw) {
            Some(&before) => Ok(before),
            None if self.rekeys.to_after.contains_key(raw) => Err(NO_OLD_ID),
            None => Ok(raw),
        }
    }

    /// The id a node has after the renames.
    fn after_id<'r>(&'r self, raw: &'r str, after_ids: bool) -> &'r str {
        if after_ids {
            return raw;
        }
        self.rekeys.to_after.get(raw).copied().unwrap_or(raw)
    }

    /// A node as KGCL writes it: its id in the before file.
    fn node(&self, raw: &str, after_ids: bool) -> Result<String, &'static str> {
        self.id(self.before_id(raw, after_ids)?).ok_or(NO_ID)
    }

    /// A predicate: an id, with OBO's `is_a` as `rdfs:subClassOf`.
    fn predicate(&self, raw: &str) -> Option<String> {
        if self.options.obo && raw == "is_a" {
            return Some("rdfs:subClassOf".to_owned());
        }
        self.id(raw)
    }

    fn command(&mut self, line: String) {
        self.lines.push(line);
        self.commands += 1;
    }

    /// `# reason: {json}` on one line.
    fn comment(&mut self, kind: Kind, reason: &str, detail: Value) {
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
        match kind {
            Kind::Unexported => self.unexported += 1,
            Kind::Partial => self.partial += 1,
            Kind::Note => self.notes += 1,
        }
    }

    fn split_note(&mut self, diff: &DiffResult, hunk: &Hunk) {
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
        self.comment(Kind::Note, NO_SPLIT, Value::Object(detail));
    }

    fn merge_notes(&mut self, diff: &DiffResult, hunk: &Hunk, plan: &Plan<'_>) {
        for node in hunk.nodes.iter().filter_map(|id| diff.node(id)) {
            for facet in &node.facets {
                let NodeFacet::MergedInto { target, .. } = facet else {
                    continue;
                };
                let into = diff.node(target).map(|t| raw_id(t, false));
                let expressed = node
                    .after_id
                    .as_deref()
                    .and_then(|id| plan.obsoleted.get(id))
                    .is_some_and(|r| Some(*r) == into.as_deref());
                if !expressed {
                    let mut detail = Object::new();
                    detail.insert("hunk", &hunk.id);
                    detail.insert("node", raw_id(node, true));
                    if let Some(into) = into {
                        detail.insert("into", into);
                    }
                    self.comment(Kind::Note, NO_MERGE, Value::Object(detail));
                }
            }
        }
    }

    /// Writes these operations in order, each after the created node it names as a replacement.
    fn ops(&mut self, diff: &DiffResult, indices: &[usize], plan: &Plan<'_>) {
        let mut chain: Vec<usize> = Vec::new();
        for &i in indices {
            chain.clear();
            let mut at = i;
            while !plan.consumed.contains_key(&at) && self.written.insert(at, ()).is_none() {
                chain.push(at);
                match plan.first.get(&at).or_else(|| self.first.get(&at)) {
                    Some(&first) => at = first,
                    None => break,
                }
            }
            for &j in chain.iter().rev() {
                self.after_ids = j >= self.rekeys.renamed_from;
                self.op(&diff.delta.ops[j], j, plan);
            }
        }
    }

    fn op(&mut self, op: &DeltaOp, i: usize, plan: &Plan<'_>) {
        let whole = || op.to_value();
        let after_ids = self.after_ids;
        match op {
            DeltaOp::NodeRekey { .. } => self.comment(Kind::Unexported, NO_REKEY, whole()),
            DeltaOp::EdgeRemove { edge } => self.edge(edge, false, whole),
            DeltaOp::EdgeAdd { edge } => self.edge(edge, true, whole),
            DeltaOp::NodeRemove { node } => {
                if node.get("implicit") == Some(&Value::Bool(true)) {
                    self.comment(Kind::Unexported, NO_IMPLICIT, whole());
                } else {
                    match self.node(member(node, "id"), after_ids) {
                        Ok(id) => self.command(format!("delete {id}")),
                        Err(reason) => self.comment(Kind::Unexported, reason, whole()),
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
                let x = match self.node(id, after_ids) {
                    Ok(x) => x,
                    Err(reason) => return self.comment(Kind::Unexported, reason, whole()),
                };
                match field {
                    NodeField::Label => {
                        let (from, to) = (from.as_str().unwrap_or(""), to.as_str().unwrap_or(""));
                        if from == id.as_str() {
                            self.comment(Kind::Unexported, NO_ADD_LABEL, whole());
                        } else if to == id.as_str() {
                            self.comment(Kind::Unexported, NO_REMOVE_LABEL, whole());
                        } else if let (Some(a), Some(b)) = (kgcl_quote(from), kgcl_quote(to)) {
                            self.command(format!("rename {x} from {a} to {b}"));
                        } else {
                            // `rename` cannot leave out the old label.
                            self.comment(Kind::Unexported, NO_TEXT, whole());
                        }
                    }
                    NodeField::Aliases => {
                        let (Some(from), Some(to)) = (strings(from), strings(to)) else {
                            return self.comment(Kind::Unexported, NO_TEXT, whole());
                        };
                        for alias in missing_from(&from, &to) {
                            self.synonym(&x, id, alias, false, None);
                        }
                        let scopes = plan.scopes.get(&i);
                        for alias in missing_from(&to, &from) {
                            let scope = scopes.and_then(|s| s.get(alias)).copied();
                            self.synonym(&x, id, alias, true, scope);
                        }
                    }
                    NodeField::Types => {
                        let (true, Some(from), Some(to)) =
                            (self.options.rdf_types, strings(from), strings(to))
                        else {
                            return self.comment(Kind::Unexported, NO_TYPES, whole());
                        };
                        for t in missing_from(&from, &to) {
                            self.type_edge(&x, id, t, false);
                        }
                        for t in missing_from(&to, &from) {
                            self.type_edge(&x, id, t, true);
                        }
                    }
                    NodeField::Deprecated => {
                        if to.as_bool() == Some(true) {
                            let replacement = plan
                                .replacement
                                .get(&i)
                                .and_then(|r| self.node(r, after_ids).ok());
                            match replacement {
                                Some(r) => {
                                    self.command(format!("obsolete {x} with replacement {r}"));
                                }
                                None => self.command(format!("obsolete {x}")),
                            }
                        } else {
                            self.command(format!("unobsolete {x}"));
                        }
                    }
                    NodeField::Replaces => self.comment(Kind::Unexported, NO_REPLACES, whole()),
                    NodeField::ReplacedBy => {
                        self.comment(Kind::Unexported, NO_REPLACED_BY, whole());
                    }
                    _ => self.comment(Kind::Unexported, NO_ATTR, whole()),
                }
            }
            DeltaOp::NodeAttr { id, key, from, to } => {
                if !is_definition_key(key) {
                    return self.comment(Kind::Unexported, NO_ATTR, whole());
                }
                let x = match self.node(id, after_ids) {
                    Ok(x) => x,
                    Err(reason) => return self.comment(Kind::Unexported, reason, whole()),
                };
                match (definition(from), definition(to)) {
                    (Err(reason), _) | (_, Err(reason)) => {
                        self.comment(Kind::Unexported, reason, whole());
                    }
                    (Ok(None), Ok(Some(new))) => match kgcl_quote(new) {
                        Some(new) => self.command(format!("add definition {new} to {x}")),
                        None => self.comment(Kind::Unexported, NO_TEXT, whole()),
                    },
                    // The old text is only a check: KGCL can leave it out when it cannot quote it.
                    (Ok(Some(old)), Ok(Some(new))) => match (kgcl_quote(old), kgcl_quote(new)) {
                        (_, None) => self.comment(Kind::Unexported, NO_TEXT, whole()),
                        (Some(old), Some(new)) => {
                            self.command(format!("change definition of {x} from {old} to {new}"));
                        }
                        (None, Some(new)) => {
                            self.command(format!("change definition of {x} to {new}"));
                        }
                    },
                    (Ok(Some(_)), Ok(None)) => {
                        self.command(format!("remove definition for {x}"));
                    }
                    (Ok(None), Ok(None)) => {}
                }
            }
            DeltaOp::EdgeSet { .. } => self.comment(Kind::Unexported, NO_EDGE_LABEL, whole()),
            DeltaOp::EdgeAttr { .. } => self.comment(Kind::Unexported, NO_EDGE_ATTR, whole()),
            _ => self.comment(Kind::Unexported, NO_ATTR, whole()),
        }
    }

    /// `delete edge` / `create edge`, unless the edge's triple stays or KGCL cannot write it.
    fn edge(&mut self, edge: &Object, added: bool, whole: impl Fn() -> Value) {
        let after_ids = self.after_ids;
        let (s, p, o) = (
            member(edge, "source"),
            member(edge, "predicate"),
            member(edge, "target"),
        );
        if self.options.obo && OBO_NOT_RELATIONS.contains(&p) {
            return self.comment(Kind::Unexported, NO_OBO_CLAUSE, whole());
        }
        let triple = (|| -> Result<String, &'static str> {
            Ok(format!(
                "{} {} {}",
                self.node(s, after_ids)?,
                self.predicate(p).ok_or(NO_ID)?,
                self.node(o, after_ids)?
            ))
        })();
        let triple = match triple {
            Ok(triple) => triple,
            Err(reason) => return self.comment(Kind::Unexported, reason, whole()),
        };
        // KGCL edges are triples: one that stays in the other graph is not added or removed.
        let stays = self.triples.as_ref().is_some_and(|(before, after)| {
            if added {
                let (Ok(bs), Ok(bo)) = (self.before_id(s, after_ids), self.before_id(o, after_ids))
                else {
                    return false;
                };
                before.contains_key(&(bs, p, bo))
            } else {
                after.contains_key(&(self.after_id(s, after_ids), p, self.after_id(o, after_ids)))
            }
        });
        if stays {
            let reason = if added { EDGE_THERE } else { EDGE_KEPT };
            return self.comment(Kind::Unexported, reason, whole());
        }
        let line = format!("{} edge {triple}", if added { "create" } else { "delete" });
        if self.edge_lines.insert(line.clone(), ()).is_some() {
            let reason = if added {
                EDGE_ADDED_ABOVE
            } else {
                EDGE_REMOVED_ABOVE
            };
            return self.comment(Kind::Unexported, reason, whole());
        }
        self.command(line);
        if added && (edge.contains_key("label") || edge.contains_key("attrs")) {
            let mut rest = Object::new();
            for key in ["source", "predicate", "target", "label", "attrs"] {
                if let Some(value) = edge.get(key) {
                    rest.insert(key, value.clone());
                }
            }
            self.comment(Kind::Partial, NO_EDGE_REST, Value::Object(rest));
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
                self.comment(Kind::Unexported, NO_TEXT, Value::Object(detail));
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
                self.comment(Kind::Unexported, NO_ID, Value::Object(detail));
            }
        }
    }

    /// `create node` and what else KGCL can say about a new node; the rest as one comment.
    fn node_add(&mut self, node: &Object, whole: impl Fn() -> Value) {
        let after_ids = self.after_ids;
        if node.get("implicit") == Some(&Value::Bool(true)) {
            return self.comment(Kind::Unexported, NO_IMPLICIT, whole());
        }
        let raw = member(node, "id");
        let x = match self.node(raw, after_ids) {
            Ok(x) => x,
            Err(reason) => return self.comment(Kind::Unexported, reason, whole()),
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
                scopes(attrs.get("synonyms")).filter(|s| same_texts(s, aliases.clone()))
            } else {
                None
            };
            let by_text = scoped.as_deref().map(scope_lookup);
            let mut kept: Vec<Value> = Vec::new();
            for alias in &aliases {
                match kgcl_quote(alias) {
                    Some(quoted) => {
                        let scope = by_text.as_ref().and_then(|s| s.get(alias));
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
            match single(&replaced_by).and_then(|r| self.node(r, after_ids).ok()) {
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
            self.comment(Kind::Partial, NO_NODE_REST, Value::Object(rest));
        }
    }
}

/// A definition attribute's text, when it has one.
fn definition(value: &Option<Value>) -> Result<Option<&str>, &'static str> {
    match value {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(NO_VALUE),
    }
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
