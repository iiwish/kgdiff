//! `normalize`: validate, canonicalize and index one graph version (`normalize.ts`,
//! docs/algorithms.md §1). The input is JSON as `JSON.parse` gives it, read with the same
//! leniency as the TypeScript implementation.

use std::cmp::Ordering;
use std::sync::{Arc, OnceLock};

use crate::js::IndexMap;

use crate::canonical::{canonical_json, triple_key, triple_key_in};
use crate::error::{ErrorCode, KgdiffError, Result};
use crate::js::{self, JsStr, Lookup, Object, Value};
use crate::model::{
    Attrs, EdgeIdentity, EdgeKey, GraphIssue, GraphIssueCode, Id, KGEdge, KGNode, KGraph, Point,
};
use crate::options::{DanglingEdges, NormalizeOptions};
use crate::text::{nfc_str, predicate_label, raw_predicate_label};
use crate::util::sorted_unique;

/// How display text is read (`TextForm`): API input is composed to NFC; a kgdiff JSON snapshot
/// is taken as written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextForm {
    /// `INPUT_TEXT`: NFC, and `predicateLabel` for edges without a label.
    Input,
    /// `SNAPSHOT_TEXT`: as written, and `rawPredicateLabel`.
    Snapshot,
}

impl TextForm {
    fn text(self, text: &JsStr) -> JsStr {
        match self {
            TextForm::Input => nfc_str(text),
            TextForm::Snapshot => text.clone(),
        }
    }

    fn edge_label(self, predicate: &str) -> JsStr {
        match self {
            TextForm::Input => predicate_label(predicate),
            TextForm::Snapshot => raw_predicate_label(predicate),
        }
    }
}

fn fail(message: impl Into<String>) -> KgdiffError {
    KgdiffError::invalid_input(message)
}

fn details(entries: &[(&str, Value)]) -> Object {
    entries.iter().map(|(k, v)| (*k, v.clone())).collect()
}

/// Checks the optional kgdiff JSON marker: a `kgdiff.*` format other than `kgdiff.graph`, or a
/// version other than 1, is rejected; other formats belong to someone else and are ignored.
fn check_format(input: &Object) -> Result<()> {
    let Some(format) = input.get("format").and_then(Value::as_str) else {
        return Ok(());
    };
    if !format.starts_with("kgdiff.") {
        return Ok(());
    }
    if format != "kgdiff.graph" {
        return Err(KgdiffError::new(
            ErrorCode::UnsupportedVersion,
            format!("Expected a kgdiff graph (format \"kgdiff.graph\"), got format \"{format}\""),
        )
        .with_details(details(&[("format", Value::from(format))])));
    }
    let version = input.get("version");
    if version != Some(&Value::Number(1.0)) {
        let shown = version.map_or_else(|| "undefined".to_owned(), Value::to_js_string);
        return Err(KgdiffError::new(
            ErrorCode::UnsupportedVersion,
            format!("Unsupported graph version {shown}; this reader supports version 1"),
        )
        .with_details(details(&[(
            "version",
            version.cloned().unwrap_or(Value::Null),
        )])));
    }
    Ok(())
}

/// Ids are strings; finite numbers are accepted and stringified. Empty → `None` (`coerceId`).
pub(crate) fn coerce_id(value: Option<&Value>) -> Option<Id> {
    match value? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(x) if x.is_finite() => Some(JsStr::from(js::number_to_string(*x))),
        _ => None,
    }
}

/// `Node "id"` or `Edge source → target`, and the issue reference.
fn describe(owner: &str, target: Option<&str>) -> (String, String) {
    match target {
        None => (format!("Node \"{owner}\""), owner.to_owned()),
        Some(target) => (
            format!("Edge {owner} → {target}"),
            format!("{owner} → {target}"),
        ),
    }
}

fn invalid_field(owner: &str, target: Option<&str>, field: &str, expected: &str) -> KgdiffError {
    let (what, reference) = describe(owner, target);
    fail(format!("{what}: {field} must be {expected}"))
        .with_details(details(&[("ref", Value::from(reference))]))
}

fn optional_string(
    value: Option<&Value>,
    owner: &str,
    target: Option<&str>,
    field: &str,
) -> Result<Option<JsStr>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(invalid_field(owner, target, field, "a string")),
    }
}

fn string_array(value: Option<&Value>, owner: &str, field: &str) -> Result<Vec<JsStr>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(s)) => Ok(vec![s.clone()]),
        Some(Value::Array(items)) if items.iter().all(|item| item.as_str().is_some()) => {
            Ok(items.iter().filter_map(Value::as_js_str).cloned().collect())
        }
        Some(_) => Err(invalid_field(owner, None, field, "an array of strings")),
    }
}

/// Attribute values nested deeper than this are rejected.
const MAX_DEPTH: usize = 1000;

/// An attribute value as JSON (`sanitize`): NaN and ±∞ become `"NaN"`, `"Infinity"`,
/// `"-Infinity"`; every key, `__proto__` included, is data.
fn sanitize(value: &Value, depth: usize) -> Result<Value> {
    match value {
        Value::Number(x) if !x.is_finite() => Ok(Value::from(js::number_to_string(*x))),
        Value::Array(_) | Value::Object(_) if depth >= MAX_DEPTH => Err(fail(format!(
            "Attribute values may be nested at most {MAX_DEPTH} levels deep (or the value is cyclic)"
        ))),
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| sanitize(item, depth + 1))
                .collect::<Result<_>>()?,
        )),
        Value::Object(object) => {
            let mut out = Object::with_capacity(object.len());
            for (key, item) in object {
                out.insert(key.clone(), sanitize(item, depth + 1)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// A validated attribute map, or `None` when absent (`attrsOf`).
fn attrs_of(value: Option<&Value>, owner: &str, target: Option<&str>) -> Result<Option<Attrs>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => match sanitize(value, 0)? {
            Value::Object(attrs) => Ok(Some(attrs)),
            _ => Ok(None),
        },
        Some(_) => Err(invalid_field(owner, target, "attrs", "an object")),
    }
}

fn position_of(value: Option<&Value>) -> Option<Point> {
    let object = value?.as_object()?;
    match (object.get("x"), object.get("y")) {
        (Some(Value::Number(x)), Some(Value::Number(y))) if x.is_finite() && y.is_finite() => {
            Some(Point { x: *x, y: *y })
        }
        _ => None,
    }
}

/// A node declaration before duplicates are merged (`NodeDraft`).
#[derive(Clone, Debug)]
pub(crate) struct NodeDraft {
    id: Id,
    label: Option<JsStr>,
    types: Vec<JsStr>,
    aliases: Vec<JsStr>,
    attrs: Option<Attrs>,
    deprecated: Option<bool>,
    replaces: Vec<JsStr>,
    replaced_by: Vec<JsStr>,
    implicit: bool,
    position: Option<Point>,
}

fn draft_node(raw: &Object, id: Id, form: TextForm) -> Result<NodeDraft> {
    let types = string_array(raw.get("type"), &id, "type")?;
    let extra_types = string_array(raw.get("types"), &id, "types")?;
    let aliases = string_array(raw.get("aliases"), &id, "aliases")?;
    let all_types: Vec<JsStr> = types.into_iter().chain(extra_types).collect();
    let replaces = string_array(raw.get("replaces"), &id, "replaces")?;
    let replaced_by = string_array(raw.get("replacedBy"), &id, "replacedBy")?;
    let mut draft = NodeDraft {
        types: all_types.iter().map(|t| form.text(t)).collect(),
        aliases: aliases.iter().map(|a| form.text(a)).collect(),
        replaces,
        replaced_by,
        implicit: raw.get("implicit") == Some(&Value::Bool(true)),
        label: None,
        attrs: None,
        deprecated: None,
        position: None,
        id,
    };
    if let Some(label) = optional_string(raw.get("label"), &draft.id, None, "label")?
        && !label.is_empty()
    {
        draft.label = Some(form.text(&label));
    }
    draft.attrs = attrs_of(raw.get("attrs"), &draft.id, None)?;
    match raw.get("deprecated") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(b)) => draft.deprecated = Some(*b),
        Some(_) => return Err(invalid_field(&draft.id, None, "deprecated", "a boolean")),
    }
    draft.position = position_of(raw.get("position"));
    Ok(draft)
}

/// The larger of two values by canonical JSON (`maxByJSON`).
fn max_by_json<T>(a: Option<T>, b: Option<T>, json: impl Fn(&T) -> String) -> Option<T> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => {
            if js::cmp_utf16(&json(&b), &json(&a)) == Ordering::Greater {
                Some(b)
            } else {
                Some(a)
            }
        }
    }
}

fn string_json(s: &JsStr) -> String {
    canonical_json(&Value::from(s))
}

fn position_json(p: &Point) -> String {
    let mut object = Object::new();
    object.insert("x", p.x);
    object.insert("y", p.y);
    canonical_json(&Value::Object(object))
}

/// Per key, the larger value by canonical JSON (`mergeAttrs`).
fn merge_attrs(a: Option<Attrs>, b: Option<&Attrs>) -> Option<Attrs> {
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        (a, b) => return a.or_else(|| b.cloned()),
    };
    let mut out = Object::with_capacity(a.len().max(b.len()));
    let keys: Vec<JsStr> = a
        .keys()
        .chain(b.keys().filter(|k| !a.contains_key(k)))
        .cloned()
        .collect();
    for key in keys {
        if let Some(value) = max_by_json(a.get(&key), b.get(&key), |v| canonical_json(v)) {
            out.insert(key, value.clone());
        }
    }
    Some(out)
}

/// Merges a duplicate declaration independently of declaration order (`mergeDraft`).
fn merge_draft(into: &mut NodeDraft, next: NodeDraft) {
    into.label = max_by_json(into.label.take(), next.label, string_json);
    into.deprecated = max_by_json(into.deprecated.take(), next.deprecated, |b| b.to_string());
    if let Some(position) = max_by_json(into.position.take(), next.position, position_json) {
        into.position = Some(position);
    }
    into.attrs = merge_attrs(into.attrs.take(), next.attrs.as_ref());
    into.types.extend(next.types);
    into.aliases.extend(next.aliases);
    into.replaces.extend(next.replaces);
    into.replaced_by.extend(next.replaced_by);
    into.implicit = into.implicit && next.implicit;
}

pub(crate) fn finish_node(draft: NodeDraft) -> KGNode {
    let label = draft.label.unwrap_or_else(|| draft.id.clone());
    let mut aliases = sorted_unique(&draft.aliases);
    if let Some(at) = aliases.iter().position(|a| *a == label) {
        aliases.remove(at);
    }
    KGNode {
        label,
        types: sorted_unique(&draft.types),
        aliases,
        attrs: draft.attrs.unwrap_or_default(),
        deprecated: draft.deprecated.unwrap_or(false),
        replaces: sorted_unique(&draft.replaces),
        replaced_by: sorted_unique(&draft.replaced_by),
        implicit: draft.implicit,
        position: draft.position,
        id: draft.id,
    }
}

/// An edge before its key is known (`EdgeDraft`).
#[derive(Clone, Debug)]
struct EdgeDraft {
    id: Option<Id>,
    source: Id,
    target: Id,
    predicate: JsStr,
    label: JsStr,
    attrs: Attrs,
}

impl EdgeDraft {
    fn into_edge(self, key: EdgeKey) -> KGEdge {
        KGEdge {
            key,
            id: self.id,
            source: self.source,
            target: self.target,
            predicate: self.predicate,
            label: self.label,
            attrs: self.attrs,
        }
    }
}

/// Content that distinguishes parallel copies of one triple (`parallelContent`).
fn parallel_content(edge: &EdgeDraft) -> String {
    canonical_json(&Value::Array(vec![
        Value::from(&edge.label),
        Value::Object(edge.attrs.clone()),
    ]))
}

/// All declarations of one edge identity (`EdgeGroup`).
struct EdgeGroup {
    base: JsStr,
    id_keyed: bool,
    /// The declarations; most identities occur once, so repeats are kept aside.
    first: Option<EdgeDraft>,
    more: Vec<EdgeDraft>,
    /// The edges the group becomes: one, or several for parallel copies.
    edge: Option<KGEdge>,
    edges: Vec<KGEdge>,
}

fn is_record(value: &Value) -> Option<&Object> {
    value.as_object()
}

/// Validates and indexes a graph (`normalize`): labels default to the id; types, aliases,
/// `replaces` and `replacedBy` are sorted and de-duplicated; aliases equal to the label are
/// dropped; empty ids are dropped (`empty-id`); duplicate ids are merged field-wise
/// (`duplicate-node`); edges are keyed by `edge_identity`, parallel copies of a triple get `#2`,
/// `#3`… in canonical content order and identical copies collapse (`duplicate-edge`); dangling
/// endpoints follow `dangling_edges`.
///
/// # Errors
///
/// `invalid-input` for malformed input, `dangling-edge` (policy `Error`), `unsupported-version`
/// for another kgdiff format or graph version.
pub fn normalize(input: &Value, options: NormalizeOptions) -> Result<KGraph> {
    normalize_as(input, options, TextForm::Input)
}

pub(crate) fn normalize_as(
    input: &Value,
    options: NormalizeOptions,
    form: TextForm,
) -> Result<KGraph> {
    if let Some(record) = is_record(input) {
        check_format(record)?;
    }
    let shape = || fail("normalize expects a graph of the form { nodes: [...], edges: [...] }");
    let record = is_record(input).ok_or_else(shape)?;
    let raw_nodes = record
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(shape)?;
    let raw_edges: &[Value] = match record.get("edges") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(items)) => items,
        Some(_) => return Err(fail("graph.edges must be an array")),
    };
    let edge_identity = options.edge_identity;
    let dangling = options.dangling_edges;
    let mut issues: Vec<GraphIssue> = Vec::new();

    // ── Nodes ──
    let mut drafts: IndexMap<Id, NodeDraft> =
        IndexMap::with_capacity_and_hasher(raw_nodes.len(), Default::default());
    for raw in raw_nodes {
        let raw = is_record(raw).ok_or_else(|| fail("graph.nodes must contain objects"))?;
        let Some(id) = coerce_id(raw.get("id")) else {
            issues.push(GraphIssue {
                code: GraphIssueCode::EmptyId,
                message: "Dropped a node without an id".to_owned(),
                reference: None,
            });
            continue;
        };
        let draft = draft_node(raw, id.clone(), form)?;
        if let Some(existing) = drafts.get_mut(&id) {
            merge_draft(existing, draft);
            issues.push(GraphIssue {
                code: GraphIssueCode::DuplicateNode,
                message: format!(
                    "Node \"{id}\" is declared more than once; the declarations were merged"
                ),
                reference: Some(id),
            });
        } else {
            drafts.insert(id, draft);
        }
    }

    // ── Edges: endpoints, defaults ──
    let mut label_cache: Lookup<JsStr, JsStr> = Lookup::new();
    let mut edge_drafts: Vec<EdgeDraft> = Vec::with_capacity(raw_edges.len());
    for raw in raw_edges {
        let edge = is_record(raw).ok_or_else(|| fail("graph.edges must contain objects"))?;
        let (Some(source), Some(target)) =
            (coerce_id(edge.get("source")), coerce_id(edge.get("target")))
        else {
            issues.push(GraphIssue {
                code: GraphIssueCode::EmptyId,
                message: "Dropped an edge with an empty endpoint".to_owned(),
                reference: None,
            });
            continue;
        };
        let predicate =
            optional_string(edge.get("predicate"), &source, Some(&target), "predicate")?
                .unwrap_or_default();
        let explicit = optional_string(edge.get("label"), &source, Some(&target), "label")?;
        let label = match explicit {
            Some(label) => form.text(&label),
            None => match label_cache.get(&predicate) {
                Some(label) => label.clone(),
                None => {
                    let label = form.edge_label(&predicate);
                    label_cache.insert(predicate.clone(), label.clone());
                    label
                }
            },
        };
        if !drafts.contains_key(&source) || !drafts.contains_key(&target) {
            handle_dangling(
                &source,
                &predicate,
                &target,
                dangling,
                &mut drafts,
                &mut issues,
            )?;
            if dangling == DanglingEdges::Drop {
                continue;
            }
        }
        let id = coerce_id(edge.get("id"));
        let attrs = attrs_of(edge.get("attrs"), &source, Some(&target))?.unwrap_or_default();
        edge_drafts.push(EdgeDraft {
            id,
            source,
            target,
            predicate,
            label,
            attrs,
        });
    }

    let nodes: IndexMap<Id, Arc<KGNode>> = drafts
        .into_iter()
        .map(|(id, draft)| (id, Arc::new(finish_node(draft))))
        .collect();

    // ── Edges: identity keys ──
    // Ids and structural keys are grouped apart, and id-keyed groups are keyed first, so an id
    // that looks like a structural key can only push the structural key aside (to `#2`).
    let mut groups: Vec<EdgeGroup> = Vec::with_capacity(edge_drafts.len());
    let mut by_id: Lookup<JsStr, usize> = Lookup::new();
    let mut by_triple: Lookup<JsStr, usize> = Lookup::with_capacity(edge_drafts.len());
    let mut buffer = String::new();
    let edge_count = edge_drafts.len();
    for draft in edge_drafts {
        let id_keyed = edge_identity == EdgeIdentity::Id && draft.id.is_some();
        let base = match (&draft.id, id_keyed) {
            (Some(id), true) => id.clone(),
            _ => triple_key_in(&mut buffer, &draft.source, &draft.predicate, &draft.target),
        };
        let index = if id_keyed { &mut by_id } else { &mut by_triple };
        match index.get(&base) {
            Some(&at) => groups[at].more.push(draft),
            None => {
                index.insert(base.clone(), groups.len());
                groups.push(EdgeGroup {
                    base,
                    id_keyed,
                    first: Some(draft),
                    more: Vec::new(),
                    edge: None,
                    edges: Vec::new(),
                });
            }
        }
    }
    // Collisions between keys are only possible when ids and structural keys mix.
    let mut taken: Option<Lookup<EdgeKey, ()>> =
        (edge_identity == EdgeIdentity::Id).then(Lookup::new);
    let mut unique = |key: JsStr| -> JsStr {
        let Some(taken) = taken.as_mut() else {
            return key;
        };
        let mut candidate = key.clone();
        let mut n = 2;
        while taken.contains_key(&candidate) {
            candidate = JsStr::from(format!("{key}#{n}"));
            n += 1;
        }
        taken.insert(candidate.clone(), ());
        candidate
    };
    for pass in [true, false] {
        for group in groups.iter_mut().filter(|g| g.id_keyed == pass) {
            let Some(first) = group.first.take() else {
                continue;
            };
            if group.more.is_empty() {
                group.edge = Some(first.into_edge(unique(group.base.clone())));
                continue;
            }
            let mut drafts = vec![first];
            drafts.append(&mut group.more);
            let count = drafts.len();
            if pass {
                let merged = merge_edge_drafts(drafts);
                group
                    .edges
                    .push(merged.into_edge(unique(group.base.clone())));
                issues.push(GraphIssue {
                    code: GraphIssueCode::DuplicateEdge,
                    message: format!(
                        "Edge id \"{}\" is used {count} times; the declarations were merged",
                        group.base
                    ),
                    reference: Some(group.base.clone()),
                });
            } else {
                let base = group.base.clone();
                for (key, draft) in insert_parallel(&base, drafts, &mut issues) {
                    group.edges.push(draft.into_edge(unique(key)));
                }
            }
        }
    }
    // Edges keep the order in which their identity first appeared.
    let mut edges: IndexMap<EdgeKey, Arc<KGEdge>> =
        IndexMap::with_capacity_and_hasher(edge_count, Default::default());
    for group in groups {
        for edge in group.edge.into_iter().chain(group.edges) {
            edges.insert(edge.key.clone(), Arc::new(edge));
        }
    }

    issues.sort_by(|a, b| {
        a.code
            .as_str()
            .cmp(b.code.as_str())
            .then_with(|| {
                js::cmp_utf16(
                    a.reference.as_deref().unwrap_or(""),
                    b.reference.as_deref().unwrap_or(""),
                )
            })
            .then_with(|| js::cmp_utf16(&a.message, &b.message))
    });
    Ok(index_graph(
        record.get("meta"),
        nodes,
        edges,
        edge_identity,
        issues,
    ))
}

/// Edge keys by source and by target node id, in edge order; nodes without edges get empty lists
/// after those with edges (`indexGraph`).
pub(crate) fn index_graph(
    meta: Option<&Value>,
    nodes: IndexMap<Id, Arc<KGNode>>,
    edges: IndexMap<EdgeKey, Arc<KGEdge>>,
    edge_identity: EdgeIdentity,
    issues: Vec<GraphIssue>,
) -> KGraph {
    let mut outgoing: IndexMap<Id, Vec<EdgeKey>> =
        IndexMap::with_capacity_and_hasher(nodes.len(), Default::default());
    let mut incoming: IndexMap<Id, Vec<EdgeKey>> =
        IndexMap::with_capacity_and_hasher(nodes.len(), Default::default());
    let push = |map: &mut IndexMap<Id, Vec<EdgeKey>>, id: &Id, key: &EdgeKey| match map.get_mut(id)
    {
        Some(list) => list.push(key.clone()),
        None => {
            map.insert(id.clone(), vec![key.clone()]);
        }
    };
    for edge in edges.values() {
        push(&mut outgoing, &edge.source, &edge.key);
        push(&mut incoming, &edge.target, &edge.key);
    }
    for id in nodes.keys() {
        if !outgoing.contains_key(id) {
            outgoing.insert(id.clone(), Vec::new());
        }
        if !incoming.contains_key(id) {
            incoming.insert(id.clone(), Vec::new());
        }
    }
    KGraph {
        meta: meta.and_then(Value::as_object).cloned().unwrap_or_default(),
        nodes,
        edges,
        outgoing,
        incoming,
        edge_identity,
        issues,
        hash: OnceLock::new(),
    }
}

/// Applies the dangling-endpoint policy to an edge with an undeclared endpoint (`handleDangling`).
fn handle_dangling(
    source: &Id,
    predicate: &JsStr,
    target: &Id,
    policy: DanglingEdges,
    drafts: &mut IndexMap<Id, NodeDraft>,
    issues: &mut Vec<GraphIssue>,
) -> Result<()> {
    let endpoints: &[&Id] = if source == target {
        &[source]
    } else {
        &[source, target]
    };
    for &endpoint in endpoints {
        if drafts.contains_key(endpoint) {
            continue;
        }
        match policy {
            DanglingEdges::Error => {
                return Err(KgdiffError::new(
                    ErrorCode::DanglingEdge,
                    format!(
                        "Edge {} points to the missing node \"{endpoint}\"",
                        triple_key(source, predicate, target)
                    ),
                )
                .with_details(details(&[
                    ("source", Value::from(source)),
                    ("predicate", Value::from(predicate)),
                    ("target", Value::from(target)),
                    ("missing", Value::from(endpoint)),
                ])));
            }
            DanglingEdges::Create => {
                drafts.insert(
                    endpoint.clone(),
                    NodeDraft {
                        id: endpoint.clone(),
                        label: None,
                        types: Vec::new(),
                        aliases: Vec::new(),
                        attrs: None,
                        deprecated: None,
                        replaces: Vec::new(),
                        replaced_by: Vec::new(),
                        implicit: true,
                        position: None,
                    },
                );
            }
            DanglingEdges::Drop => {}
        }
        let message = if policy == DanglingEdges::Create {
            format!("Edge endpoint \"{endpoint}\" is not declared; an implicit node was created")
        } else {
            format!("Dropped an edge whose endpoint \"{endpoint}\" is not declared")
        };
        issues.push(GraphIssue {
            code: GraphIssueCode::DanglingEdge,
            message,
            reference: Some(endpoint.clone()),
        });
    }
    Ok(())
}

/// Repeated edge ids, merged independently of declaration order (`mergeEdgeDrafts`): the
/// structure of the declaration largest by canonical JSON, attributes merged per key.
fn merge_edge_drafts(group: Vec<EdgeDraft>) -> EdgeDraft {
    let structure = |d: &EdgeDraft| {
        canonical_json(&Value::Array(vec![
            Value::from(&d.source),
            Value::from(&d.predicate),
            Value::from(&d.target),
            Value::from(&d.label),
        ]))
    };
    let mut group = group.into_iter();
    let Some(mut chosen) = group.next() else {
        unreachable!("a group has a declaration")
    };
    let mut attrs = Some(chosen.attrs.clone());
    for next in group {
        attrs = merge_attrs(attrs, Some(&next.attrs));
        if js::cmp_utf16(&structure(&next), &structure(&chosen)) == Ordering::Greater {
            chosen = next;
        }
    }
    chosen.attrs = attrs.unwrap_or_default();
    chosen
}

/// Parallel copies of one triple (`insertParallel`): copies identical in content collapse into
/// one (keeping the smallest edge id); distinct copies get `#2`, `#3`… in content order.
fn insert_parallel(
    base: &JsStr,
    group: Vec<EdgeDraft>,
    issues: &mut Vec<GraphIssue>,
) -> Vec<(JsStr, EdgeDraft)> {
    let mut by_content: IndexMap<String, EdgeDraft> = IndexMap::default();
    let mut collapsed = 0;
    for draft in group {
        let content = parallel_content(&draft);
        match by_content.get_mut(&content) {
            None => {
                by_content.insert(content, draft);
            }
            Some(kept) => {
                collapsed += 1;
                let smaller = match (&draft.id, &kept.id) {
                    (Some(_), None) => true,
                    (Some(id), Some(kept_id)) => id < kept_id,
                    (None, _) => false,
                };
                if smaller {
                    *kept = draft;
                }
            }
        }
    }
    let mut ordered: Vec<(String, EdgeDraft)> = by_content.into_iter().collect();
    ordered.sort_by(|a, b| js::cmp_utf16(&a.0, &b.0));
    let count = ordered.len();
    if collapsed > 0 {
        issues.push(GraphIssue {
            code: GraphIssueCode::DuplicateEdge,
            message: format!("Edge {base} is declared {} times with identical content; the copies were collapsed", collapsed + 1),
            reference: Some(base.clone()),
        });
    }
    if count > 1 {
        issues.push(GraphIssue {
            code: GraphIssueCode::DuplicateEdge,
            message: format!("Edge {base} has {count} parallel copies; they are keyed #2, #3…"),
            reference: Some(base.clone()),
        });
    }
    ordered
        .into_iter()
        .enumerate()
        .map(|(i, (_, draft))| {
            let key = if i == 0 {
                base.clone()
            } else {
                JsStr::from(format!("{base}#{}", i + 1))
            };
            (key, draft)
        })
        .collect()
}

// ─── Single declarations ─────────────────────────────────────────────────────
// `diff_from_json` reads graphs in which every node and edge is declared once. These make one of
// a snapshot the way `normalize` does with the snapshot text form.

/// The node `normalize` makes of the snapshot `raw` declared once, under `raw_id` (`nodeOf`).
pub(crate) fn node_of(
    raw: &Object,
    _issues: &mut Vec<GraphIssue>,
    raw_id: Option<&Value>,
) -> Result<Option<KGNode>> {
    let Some(id) = coerce_id(raw_id) else {
        return Ok(None);
    };
    Ok(Some(finish_node(draft_node(raw, id, TextForm::Snapshot)?)))
}

/// The edge `normalize` makes of the snapshot `raw` when no other edge has its identity
/// (`edgeOf`); `None` for an empty end. `key`: known already.
pub(crate) fn edge_of(
    raw: &Object,
    edge_identity: EdgeIdentity,
    _issues: &mut Vec<GraphIssue>,
    key: Option<EdgeKey>,
) -> Result<Option<KGEdge>> {
    let (Some(source), Some(target)) = (coerce_id(raw.get("source")), coerce_id(raw.get("target")))
    else {
        return Ok(None);
    };
    let predicate = optional_string(raw.get("predicate"), &source, Some(&target), "predicate")?
        .unwrap_or_default();
    let label = match optional_string(raw.get("label"), &source, Some(&target), "label")? {
        Some(label) => label,
        None => raw_predicate_label(&predicate),
    };
    let id = coerce_id(raw.get("id"));
    let attrs = attrs_of(raw.get("attrs"), &source, Some(&target))?.unwrap_or_default();
    let key = key.unwrap_or_else(|| match (&id, edge_identity) {
        (Some(id), EdgeIdentity::Id) => id.clone(),
        _ => triple_key(&source, &predicate, &target),
    });
    Ok(Some(KGEdge {
        key,
        id,
        source,
        target,
        predicate,
        label,
        attrs,
    }))
}
