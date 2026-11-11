//! `normalize`: validate, canonicalize and index one graph version (`normalize.ts`,
//! docs/algorithms.md §1). The input is JSON as `JSON.parse` gives it, read with the same
//! leniency as the TypeScript implementation.

use std::cmp::Ordering;
use std::sync::Arc;

use crate::js::{IndexMap, IndexSet};

use crate::canonical::{canonical_json, triple_key, triple_key_in};
use crate::error::{ErrorCode, KgdiffError, Result};
use crate::graph::{EdgeDraft, EdgeRow, EdgeTable, KeyContext, NodeParts};
use crate::input::{EdgeInput, GraphInput, NodeInput};
use crate::js::{self, JsStr, Lookup, Object, Value, json};
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
/// `"-Infinity"`; every key, `__proto__` included, is data. A value that needs no change is
/// shared, not copied.
fn sanitize(value: &Value, depth: usize) -> Result<Value> {
    if is_clean(value, depth)? {
        Ok(value.clone())
    } else {
        rebuild(value, depth)
    }
}

/// [`sanitize`] by copying.
fn rebuild(value: &Value, depth: usize) -> Result<Value> {
    match value {
        Value::Number(x) if !x.is_finite() => Ok(Value::from(js::number_to_string(*x))),
        Value::Array(_) | Value::Object(_) if depth >= MAX_DEPTH => Err(fail(format!(
            "Attribute values may be nested at most {MAX_DEPTH} levels deep (or the value is cyclic)"
        ))),
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| rebuild(item, depth + 1))
                .collect::<Result<_>>()?,
        )),
        Value::Object(object) => {
            let mut out = Object::with_capacity(object.len());
            for (key, item) in object {
                out.insert(key.clone(), rebuild(item, depth + 1)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// Whether [`sanitize`] keeps `value` as it is (no NaN or ±∞ in it), or the error it reports.
fn is_clean(value: &Value, depth: usize) -> Result<bool> {
    let nested = |items: &mut dyn Iterator<Item = &Value>| -> Result<bool> {
        if depth >= MAX_DEPTH {
            return Err(fail(format!(
                "Attribute values may be nested at most {MAX_DEPTH} levels deep (or the value is cyclic)"
            )));
        }
        for item in items {
            if !is_clean(item, depth + 1)? {
                return Ok(false);
            }
        }
        Ok(true)
    };
    match value {
        Value::Number(x) => Ok(x.is_finite()),
        Value::Array(items) => nested(&mut items.iter()),
        Value::Object(object) => nested(&mut object.values()),
        _ => Ok(true),
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
    KGNode::from_parts(NodeParts {
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
    })
}

/// The text of the edge drafts' positions.
#[derive(Clone, Copy)]
struct Names<'a> {
    nodes: &'a IndexMap<Id, Arc<KGNode>>,
    texts: &'a [JsStr],
}

impl<'a> Names<'a> {
    fn node(self, at: u32) -> &'a Id {
        match self
            .nodes
            .get_index(usize::try_from(at).unwrap_or(usize::MAX))
        {
            Some((id, _)) => id,
            None => unreachable!("the ends of a draft are nodes"),
        }
    }

    fn text(self, at: u32) -> &'a JsStr {
        &self.texts[usize::try_from(at).unwrap_or(usize::MAX)]
    }

    fn source(self, draft: &EdgeDraft) -> &'a Id {
        self.node(draft.row.source)
    }

    fn target(self, draft: &EdgeDraft) -> &'a Id {
        self.node(draft.row.target)
    }

    fn predicate(self, draft: &EdgeDraft) -> &'a JsStr {
        self.text(draft.row.predicate)
    }

    fn label(self, draft: &EdgeDraft) -> &'a JsStr {
        self.text(draft.row.label)
    }
}

/// Content that distinguishes parallel copies of one triple (`parallelContent`).
fn parallel_content(edge: &EdgeDraft, names: Names<'_>) -> String {
    canonical_json(&Value::Array(vec![
        Value::from(names.label(edge)),
        Value::Object(edge.attrs.clone()),
    ]))
}

/// Node declarations by id, in the order ids first appear.
struct Drafts {
    ids: IndexSet<Id>,
    drafts: Vec<NodeDraft>,
}

impl Drafts {
    fn with_capacity(capacity: usize) -> Drafts {
        Drafts {
            ids: IndexSet::with_capacity_and_hasher(capacity, Default::default()),
            drafts: Vec::with_capacity(capacity),
        }
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut NodeDraft> {
        let at = self.ids.get_index_of(id)?;
        self.drafts.get_mut(at)
    }

    /// Adds the draft of a new id, or replaces the draft of a known one.
    fn insert(&mut self, id: Id, draft: NodeDraft) {
        let (at, new) = self.ids.insert_full(id);
        if new {
            self.drafts.push(draft);
        } else {
            self.drafts[at] = draft;
        }
    }
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

/// [`normalize`] of a graph built from Rust values: the graph `normalize(&input.to_value(), …)`
/// gives, with the same `graph_to_json` bytes, hash and issues, without a JSON tree in between.
///
/// # Errors
///
/// `invalid-input` for attribute values nested too deeply, `dangling-edge` (policy `Error`).
pub fn normalize_input(input: GraphInput, options: NormalizeOptions) -> Result<KGraph> {
    let mut shared = Shared::default();
    let mut builder = GraphBuilder::new(
        options,
        TextForm::Input,
        &mut shared,
        input.nodes.len(),
        input.edges.len(),
    );
    for node in input.nodes {
        builder.add_node_input(node)?;
    }
    for edge in input.edges {
        builder.add_edge_input(edge)?;
    }
    Ok(builder.finish(input.meta))
}

/// [`normalize`] of a graph given as JSON text: the graph `normalize(&json::parse(text)?, …)`
/// gives. The elements of `nodes` and then `edges` go to the graph as they are read, so that the
/// whole text never exists as a tree of values, unless the document needs one (the arrays in the
/// other order or repeated, or the text or the graph at fault, to report it).
///
/// # Errors
///
/// `invalid-input` for text that is not JSON, and what [`normalize`] rejects.
pub fn normalize_json(text: &str, options: NormalizeOptions) -> Result<KGraph> {
    if let Some(graph) = stream_graph(text, options) {
        return Ok(graph);
    }
    let input = json::parse(text).map_err(|e| fail(format!("The graph is not JSON: {e}")))?;
    normalize(&input, options)
}

/// The graph of a document read element by element, or `None` for [`normalize_json`] to read it
/// whole.
fn stream_graph(text: &str, options: NormalizeOptions) -> Option<KGraph> {
    let mut shared = Shared::default();
    let mut builder = GraphBuilder::new(options, TextForm::Input, &mut shared, 0, 0);
    let rest = json::Parser::new(text).stream_graph(&mut |section, item| match section {
        json::GraphSection::Nodes => builder.read_node(&item).is_ok(),
        json::GraphSection::Edges => builder.read_edge(&item).is_ok(),
    })?;
    check_format(&rest).ok()?;
    let meta = rest.get("meta").and_then(Value::as_object).cloned();
    Some(builder.finish(meta.unwrap_or_default()))
}

pub(crate) fn normalize_as(
    input: &Value,
    options: NormalizeOptions,
    form: TextForm,
) -> Result<KGraph> {
    normalize_shared(input, options, form, &mut Shared::default())
}

/// Text that the graphs of one diff share: the second graph's ids and predicates that the first
/// has too are the first's [`JsStr`]s, so that comparing the two graphs rarely reads text.
/// Sharing changes no result.
#[derive(Default)]
pub(crate) struct Shared<'a> {
    /// Each predicate once, with its default label.
    predicates: Lookup<JsStr, (JsStr, JsStr)>,
    /// The nodes of a graph normalized before, whose ids the next graph shares.
    nodes: Option<&'a IndexMap<Id, Arc<KGNode>>>,
}

impl Shared<'_> {
    /// The same table, sharing the ids of `nodes` from now on.
    pub(crate) fn with_nodes(self, nodes: &IndexMap<Id, Arc<KGNode>>) -> Shared<'_> {
        Shared {
            predicates: self.predicates,
            nodes: Some(nodes),
        }
    }
}

/// [`normalize_as`], sharing text with the graphs normalized with `shared` before.
pub(crate) fn normalize_shared(
    input: &Value,
    options: NormalizeOptions,
    form: TextForm,
    shared: &mut Shared<'_>,
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
    let mut builder = GraphBuilder::new(options, form, shared, raw_nodes.len(), raw_edges.len());
    for raw in raw_nodes {
        builder.read_node(raw)?;
    }
    for raw in raw_edges {
        builder.read_edge(raw)?;
    }
    let meta = record.get("meta").and_then(Value::as_object).cloned();
    Ok(builder.finish(meta.unwrap_or_default()))
}

/// A position in one of the tables of a graph, which are addressed with 32 bits.
fn table_position(at: usize) -> Result<u32> {
    u32::try_from(at)
        .ok()
        .filter(|&at| at < u32::MAX)
        .ok_or_else(|| fail("A graph may have at most 4,294,967,294 nodes, edges and texts"))
}

fn usize_of(at: u32) -> usize {
    usize::try_from(at).unwrap_or(usize::MAX)
}

/// The predicates and labels of a graph's edges, each text once.
#[derive(Default)]
struct Texts {
    positions: Lookup<JsStr, u32>,
    texts: Vec<JsStr>,
}

impl Texts {
    fn intern(&mut self, text: JsStr) -> Result<u32> {
        if let Some(&at) = self.positions.get(text.as_str()) {
            return Ok(at);
        }
        let at = table_position(self.texts.len())?;
        self.texts.push(text.clone());
        self.positions.insert(text, at);
        Ok(at)
    }
}

/// An edge whose ends, predicate and label are settled, waiting for its id and attributes.
struct EdgeSlot(EdgeRow);

/// Builds one graph from declarations, whichever way they are read: JSON values, Rust values or
/// JSON text. Nodes first, then edges.
struct GraphBuilder<'a, 'n> {
    edge_identity: EdgeIdentity,
    dangling: DanglingEdges,
    form: TextForm,
    shared: &'a mut Shared<'n>,
    issues: Vec<GraphIssue>,
    /// The declarations, until the first edge settles them into `nodes`.
    drafts: Drafts,
    nodes: IndexMap<Id, Arc<KGNode>>,
    texts: Texts,
    /// Each predicate once: its position and that of its default label.
    predicates: Lookup<JsStr, (u32, u32)>,
    /// The edges as they are declared, which is what the graph keeps unless some of them repeat.
    edges: EdgeTable,
}

impl<'a, 'n> GraphBuilder<'a, 'n> {
    fn new(
        options: NormalizeOptions,
        form: TextForm,
        shared: &'a mut Shared<'n>,
        nodes: usize,
        edges: usize,
    ) -> Self {
        GraphBuilder {
            edge_identity: options.edge_identity,
            dangling: options.dangling_edges,
            form,
            shared,
            issues: Vec::new(),
            drafts: Drafts::with_capacity(nodes),
            nodes: IndexMap::default(),
            texts: Texts::default(),
            predicates: Lookup::new(),
            edges: EdgeTable::with_capacity(edges),
        }
    }

    /// The text of `id` to keep: the first graph's, if it has the node too.
    fn shared_id(&self, id: Id) -> Id {
        match self
            .shared
            .nodes
            .and_then(|nodes| nodes.get_key_value(id.as_str()))
        {
            Some((known, _)) => known.clone(),
            None => id,
        }
    }

    fn node_without_id(&mut self) {
        self.issues.push(GraphIssue {
            code: GraphIssueCode::EmptyId,
            message: "Dropped a node without an id".to_owned(),
            reference: None,
        });
    }

    fn edge_without_end(&mut self) {
        self.issues.push(GraphIssue {
            code: GraphIssueCode::EmptyId,
            message: "Dropped an edge with an empty endpoint".to_owned(),
            reference: None,
        });
    }

    fn read_node(&mut self, raw: &Value) -> Result<()> {
        let raw = is_record(raw).ok_or_else(|| fail("graph.nodes must contain objects"))?;
        let Some(id) = coerce_id(raw.get("id")) else {
            self.node_without_id();
            return Ok(());
        };
        let id = self.shared_id(id);
        let draft = draft_node(raw, id, self.form)?;
        self.add_draft(draft)
    }

    fn add_node_input(&mut self, node: NodeInput) -> Result<()> {
        if node.id.is_empty() {
            self.node_without_id();
            return Ok(());
        }
        let id = self.shared_id(node.id);
        let form = self.form;
        let attrs = attrs_of(Some(&Value::Object(node.attrs)), &id, None)?;
        self.add_draft(NodeDraft {
            label: node
                .label
                .filter(|label| !label.is_empty())
                .map(|label| form.text(&label)),
            types: node.types.iter().map(|t| form.text(t)).collect(),
            aliases: node.aliases.iter().map(|a| form.text(a)).collect(),
            attrs,
            deprecated: Some(node.deprecated),
            replaces: node.replaces,
            replaced_by: node.replaced_by,
            implicit: node.implicit,
            position: node.position.filter(|p| p.x.is_finite() && p.y.is_finite()),
            id,
        })
    }

    fn add_draft(&mut self, draft: NodeDraft) -> Result<()> {
        table_position(self.drafts.ids.len())?;
        let id = draft.id.clone();
        if let Some(existing) = self.drafts.get_mut(&id) {
            merge_draft(existing, draft);
            self.issues.push(GraphIssue {
                code: GraphIssueCode::DuplicateNode,
                message: format!(
                    "Node \"{id}\" is declared more than once; the declarations were merged"
                ),
                reference: Some(id),
            });
        } else {
            self.drafts.insert(id, draft);
        }
        Ok(())
    }

    /// Turns the declarations into nodes, at the first edge: from then on a node can only be
    /// created for a dangling end, and is declared only once. Done before the edges take up
    /// memory, so that the drafts and the edges are never held at once.
    fn settle_nodes(&mut self) {
        if self.drafts.ids.is_empty() {
            return;
        }
        let drafts = std::mem::replace(&mut self.drafts, Drafts::with_capacity(0));
        self.nodes = drafts
            .ids
            .into_iter()
            .zip(drafts.drafts)
            .map(|(id, draft)| (id, Arc::new(finish_node(draft))))
            .collect();
    }

    fn read_edge(&mut self, raw: &Value) -> Result<()> {
        let edge = is_record(raw).ok_or_else(|| fail("graph.edges must contain objects"))?;
        let (Some(source), Some(target)) =
            (coerce_id(edge.get("source")), coerce_id(edge.get("target")))
        else {
            self.edge_without_end();
            return Ok(());
        };
        let predicate =
            optional_string(edge.get("predicate"), &source, Some(&target), "predicate")?
                .unwrap_or_default();
        let explicit = optional_string(edge.get("label"), &source, Some(&target), "label")?;
        let Some(slot) = self.settle_edge(&source, &target, predicate, explicit)? else {
            return Ok(());
        };
        let id = coerce_id(edge.get("id"));
        let attrs = attrs_of(edge.get("attrs"), &source, Some(&target))?.unwrap_or_default();
        self.push_edge(slot, id, attrs)
    }

    fn add_edge_input(&mut self, edge: EdgeInput) -> Result<()> {
        if edge.source.is_empty() || edge.target.is_empty() {
            self.edge_without_end();
            return Ok(());
        }
        let Some(slot) =
            self.settle_edge(&edge.source, &edge.target, edge.predicate, edge.label)?
        else {
            return Ok(());
        };
        let attrs = attrs_of(
            Some(&Value::Object(edge.attrs)),
            &edge.source,
            Some(&edge.target),
        )?
        .unwrap_or_default();
        self.push_edge(slot, edge.id.filter(|id| !id.is_empty()), attrs)
    }

    /// The positions of a predicate and of its default label.
    fn predicate_at(&mut self, predicate: JsStr) -> Result<(u32, u32)> {
        if let Some(&found) = self.predicates.get(predicate.as_str()) {
            return Ok(found);
        }
        let form = self.form;
        let (text, label) = self
            .shared
            .predicates
            .get_or_insert_with(predicate.clone(), || {
                let label = form.edge_label(&predicate);
                (predicate, label)
            })
            .clone();
        let found = (self.texts.intern(text.clone())?, self.texts.intern(label)?);
        self.predicates.insert(text, found);
        Ok(found)
    }

    /// Finds the ends of an edge, applying the dangling policy, and its predicate and label.
    /// `None`: the edge is dropped.
    fn settle_edge(
        &mut self,
        source: &Id,
        target: &Id,
        predicate: JsStr,
        explicit: Option<JsStr>,
    ) -> Result<Option<EdgeSlot>> {
        self.settle_nodes();
        let (predicate_at, default_label) = self.predicate_at(predicate)?;
        let label_at = match explicit {
            Some(label) => self.texts.intern(self.form.text(&label))?,
            None => default_label,
        };
        let mut ends = (
            self.nodes.get_index_of(source.as_str()),
            self.nodes.get_index_of(target.as_str()),
        );
        if ends.0.is_none() || ends.1.is_none() {
            let predicate = self.texts.texts[usize_of(predicate_at)].clone();
            handle_dangling(
                source,
                &predicate,
                target,
                self.dangling,
                &mut self.nodes,
                &mut self.issues,
            )?;
            if self.dangling == DanglingEdges::Drop {
                return Ok(None);
            }
            ends = (
                self.nodes.get_index_of(source.as_str()),
                self.nodes.get_index_of(target.as_str()),
            );
        }
        let (Some(source_at), Some(target_at)) = ends else {
            unreachable!("dangling ends were created")
        };
        Ok(Some(EdgeSlot(EdgeRow {
            source: table_position(source_at)?,
            target: table_position(target_at)?,
            predicate: predicate_at,
            label: label_at,
        })))
    }

    fn push_edge(&mut self, slot: EdgeSlot, id: Option<Id>, attrs: Attrs) -> Result<()> {
        table_position(self.edges.len())?;
        self.edges.push(slot.0, id, attrs);
        Ok(())
    }

    fn finish(mut self, meta: Object) -> KGraph {
        self.settle_nodes();
        let GraphBuilder {
            edge_identity,
            mut issues,
            nodes,
            texts,
            mut edges,
            ..
        } = self;
        edges.set_texts(texts.texts);
        let edges = key_edges(edges, &nodes, edge_identity, &mut issues);
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
        KGraph::assemble(meta, nodes, edges, edge_identity, issues)
    }
}

/// The declarations of each structural identity, as the first one and the further ones. Edges
/// are compared by the positions of their source, predicate and target (equal positions are
/// equal strings), within the edges of one source. Edges for which `keyed_by_id` holds are left
/// out.
fn repeated_triples(
    rows: &[EdgeRow],
    nodes: usize,
    keyed_by_id: impl Fn(usize) -> bool,
) -> Vec<(u32, u32)> {
    let mut starts = vec![0u32; nodes + 1];
    for row in rows {
        starts[usize_of(row.source) + 1] += 1;
    }
    for i in 0..nodes {
        starts[i + 1] += starts[i];
    }
    let mut next = starts.clone();
    let mut by_source = vec![0u32; rows.len()];
    for (at, row) in (0u32..).zip(rows) {
        let slot = &mut next[usize_of(row.source)];
        by_source[usize_of(*slot)] = at;
        *slot += 1;
    }
    drop(next);
    let mut repeated = Vec::new();
    for window in starts.windows(2) {
        let list = &mut by_source[usize_of(window[0])..usize_of(window[1])];
        if list.len() < 2 {
            continue;
        }
        let triple = |at: u32| (rows[usize_of(at)].predicate, rows[usize_of(at)].target);
        list.sort_by_key(|&at| triple(at));
        let mut first: Option<u32> = None;
        for &at in list.iter() {
            if keyed_by_id(usize_of(at)) {
                continue;
            }
            match first {
                Some(leader) if triple(leader) == triple(at) => repeated.push((leader, at)),
                _ => first = Some(at),
            }
        }
    }
    repeated
}

/// Settles the identity of every edge: repeated declarations are merged or become parallel
/// copies, and every key is unique. What needs no change stays as it was declared.
fn key_edges(
    mut edges: EdgeTable,
    nodes: &IndexMap<Id, Arc<KGNode>>,
    edge_identity: EdgeIdentity,
    issues: &mut Vec<GraphIssue>,
) -> EdgeTable {
    let id_mode = edge_identity == EdgeIdentity::Id;
    let edge_count = edges.len();
    // Ids and structural keys are grouped apart, and id-keyed groups are keyed first, so an id
    // that looks like a structural key can only push the structural key aside (to `#2`).
    let keyed_by_id: Vec<bool> = if id_mode {
        (0..edge_count).map(|at| edges.id(at).is_some()).collect()
    } else {
        Vec::new()
    };
    let is_id_keyed = |at: usize| keyed_by_id.get(at).copied().unwrap_or(false);
    // The further declarations of an identity, by its first; most identities occur once.
    let mut repeats: Lookup<u32, Vec<u32>> = Lookup::new();
    let mut repeated: Lookup<u32, ()> = Lookup::new();
    let mut triples = repeated_triples(edges.rows(), nodes.len(), is_id_keyed);
    triples.sort_by_key(|&(_, at)| at);
    for (leader, at) in triples {
        repeats.get_or_insert_with(leader, Vec::new).push(at);
        repeated.insert(at, ());
    }
    if id_mode {
        let mut by_id: Lookup<JsStr, u32> = Lookup::new();
        for (at, keyed) in (0u32..).zip(keyed_by_id.iter().copied()) {
            if !keyed {
                continue;
            }
            let Some(id) = edges.id(usize_of(at)) else {
                continue;
            };
            let leader = *by_id.get_or_insert_with(id.clone(), || at);
            if leader != at {
                repeats.get_or_insert_with(leader, Vec::new).push(at);
                repeated.insert(at, ());
            }
        }
    }
    if repeats.is_empty() && !id_mode {
        return edges;
    }

    // The edges of identities declared more than once: one merged edge, or parallel copies.
    let mut several: Lookup<u32, Vec<(EdgeKey, EdgeDraft)>> = Lookup::new();
    // Keys that had to give way, by edge.
    let mut moved: Lookup<u32, EdgeKey> = Lookup::new();
    let mut taken: Option<Lookup<EdgeKey, ()>> = id_mode.then(Lookup::new);
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
    let mut buffer = String::new();
    let texts = edges.take_texts();
    let names = Names {
        nodes,
        texts: &texts,
    };
    for pass in [true, false] {
        if pass && !id_mode {
            continue;
        }
        for at in 0..edge_count {
            let this = u32::try_from(at).unwrap_or(u32::MAX);
            if is_id_keyed(at) != pass
                || repeated.contains_key(&this)
                || (!id_mode && !repeats.contains_key(&this))
            {
                continue;
            }
            let row = edges.rows()[at];
            let base = match edges.id(at) {
                Some(id) if pass => id.clone(),
                _ => triple_key_in(
                    &mut buffer,
                    names.node(row.source),
                    names.text(row.predicate),
                    names.node(row.target),
                ),
            };
            let Some(more) = repeats.remove(&this) else {
                if id_mode {
                    let key = unique(base.clone());
                    if key != base {
                        moved.insert(this, key);
                    }
                }
                continue;
            };
            let drafts: Vec<EdgeDraft> = std::iter::once(this)
                .chain(more)
                .map(|at| edges.take_draft(usize_of(at)))
                .collect();
            let count = drafts.len();
            if pass {
                let merged = merge_edge_drafts(drafts, names);
                several.insert(this, vec![(unique(base.clone()), merged)]);
                issues.push(GraphIssue {
                    code: GraphIssueCode::DuplicateEdge,
                    message: format!(
                        "Edge id \"{base}\" is used {count} times; the declarations were merged"
                    ),
                    reference: Some(base),
                });
            } else {
                let keyed = insert_parallel(&base, drafts, names, issues)
                    .into_iter()
                    .map(|(key, draft)| (unique(key), draft))
                    .collect();
                several.insert(this, keyed);
            }
        }
    }
    if repeated.is_empty() && several.is_empty() && moved.is_empty() {
        edges.set_texts(texts);
        return edges;
    }
    // Edges keep the order in which their identity first appeared.
    let mut table = EdgeTable::with_capacity(edge_count);
    table.set_texts(texts);
    let mut keys = KeyContext {
        nodes,
        identity: edge_identity,
        buffer: String::new(),
    };
    for at in 0..edge_count {
        let this = u32::try_from(at).unwrap_or(u32::MAX);
        if repeated.contains_key(&this) {
            continue;
        }
        match several.remove(&this) {
            Some(keyed) => {
                for (key, draft) in keyed {
                    table.push_keyed(&mut keys, draft, key);
                }
            }
            None => {
                let draft = edges.take_draft(at);
                match moved.remove(&this) {
                    Some(key) => table.push_keyed(&mut keys, draft, key),
                    None => table.push(draft.row, draft.id, draft.attrs),
                }
            }
        }
    }
    table
}

/// The graph of indexed nodes and keyed edges, with its adjacency (`indexGraph`): for every node,
/// in node order, its outgoing and its incoming edges, in edge order. `None` if an end of an edge
/// is not a node.
pub(crate) fn index_graph(
    meta: Option<&Value>,
    nodes: IndexMap<Id, Arc<KGNode>>,
    edges: IndexMap<EdgeKey, Arc<KGEdge>>,
    edge_identity: EdgeIdentity,
    issues: Vec<GraphIssue>,
) -> Option<KGraph> {
    let mut texts = Texts::default();
    let mut rows = Vec::with_capacity(edges.len());
    for edge in edges.values() {
        rows.push(EdgeRow {
            source: table_position(nodes.get_index_of(&edge.source)?).ok()?,
            target: table_position(nodes.get_index_of(&edge.target)?).ok()?,
            predicate: texts.intern(edge.predicate.clone()).ok()?,
            label: texts.intern(edge.label.clone()).ok()?,
        });
    }
    let mut table = EdgeTable::with_capacity(edges.len());
    table.set_texts(texts.texts);
    let mut keys = KeyContext {
        nodes: &nodes,
        identity: edge_identity,
        buffer: String::new(),
    };
    for (row, (key, edge)) in rows.into_iter().zip(edges) {
        let draft = EdgeDraft {
            id: edge.id.clone(),
            attrs: edge.attrs.clone(),
            row,
        };
        table.push_keyed(&mut keys, draft, key);
    }
    let meta = meta.and_then(Value::as_object).cloned();
    Some(KGraph::assemble(
        meta.unwrap_or_default(),
        nodes,
        table,
        edge_identity,
        issues,
    ))
}

/// Applies the dangling-endpoint policy to an edge with an undeclared endpoint (`handleDangling`).
fn handle_dangling(
    source: &Id,
    predicate: &JsStr,
    target: &Id,
    policy: DanglingEdges,
    nodes: &mut IndexMap<Id, Arc<KGNode>>,
    issues: &mut Vec<GraphIssue>,
) -> Result<()> {
    let endpoints: &[&Id] = if source == target {
        &[source]
    } else {
        &[source, target]
    };
    for &endpoint in endpoints {
        if nodes.contains_key(endpoint.as_str()) {
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
                let node = finish_node(NodeDraft {
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
                });
                nodes.insert(endpoint.clone(), Arc::new(node));
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
fn merge_edge_drafts(group: Vec<EdgeDraft>, names: Names<'_>) -> EdgeDraft {
    let structure = |d: &EdgeDraft| {
        canonical_json(&Value::Array(vec![
            Value::from(names.source(d)),
            Value::from(names.predicate(d)),
            Value::from(names.target(d)),
            Value::from(names.label(d)),
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
    names: Names<'_>,
    issues: &mut Vec<GraphIssue>,
) -> Vec<(JsStr, EdgeDraft)> {
    let mut by_content: IndexMap<String, EdgeDraft> = IndexMap::default();
    let mut collapsed = 0;
    for draft in group {
        let content = parallel_content(&draft, names);
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
