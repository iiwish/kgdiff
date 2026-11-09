//! Reading a diff document (`diffFromJSON` of `json.ts`, with the checks of `consistency.ts`):
//! rebuilds both graphs from the union snapshots, the union elements and the index, and fails
//! at the first contradiction of a hand-written, truncated or corrupted document.
//!
//! The checks run in TypeScript's order with TypeScript's messages. Where TypeScript passes data
//! through without looking at it (the content of facets beyond their kinds, matches,
//! suggestions, members kgdiff does not define), this reader needs it typed: such content must
//! have the shape `diff_to_json` writes, and members kgdiff does not define are not kept. Both
//! only concern documents `diff_to_json` does not write.

use std::sync::Arc;

use crate::js::IndexMap;

use crate::canonical::{attrs_equal, canonical_json, has_parallel_suffix};
use crate::delta::{Delta, node_input};
use crate::error::{ErrorCode, KgdiffError, Result};
use crate::graph_json::hash_graph;
use crate::hunks::hunk_summary;
use crate::index::DiffIndex;
use crate::js::{JsStr, Lookup, Object, Value, json};
use crate::model::{
    AttrChange, Cause, ChangeStatus, Degree, EdgeFacet, EdgeIdentity, EdgeKey, End, FacetKind,
    Hunk, HunkKind, Id, KGEdge, KGNode, KGraph, MatchEvidence, MatchMethod, MatchSuggestion,
    NodeFacet, NodeMatch, ReplayPhase, SetChange, SuggestionReason, UnionEdge, UnionId, UnionNode,
    Via,
};
use crate::normalize::{TextForm, edge_of, index_graph, node_of, normalize_as};
use crate::options::{NormalizeOptions, resolve_options};
use crate::pipeline::DiffResult;
use crate::stats::compute_stats;
use crate::text::raw_predicate_label;

fn invalid(message: impl Into<String>) -> KgdiffError {
    KgdiffError::invalid_input(message)
}

const STATUSES: [&str; 4] = ["unchanged", "added", "removed", "modified"];

fn has_before(status: ChangeStatus) -> bool {
    status != ChangeStatus::Added
}

fn has_after(status: ChangeStatus) -> bool {
    status != ChangeStatus::Removed
}

fn string_of(o: &Object, key: &str) -> Option<JsStr> {
    o.get(key).and_then(Value::as_js_str).cloned()
}

/// `JSON.stringify([a, b, c])` of values that may be absent (`undefined` items become `null`).
fn stringify_list(items: &[Option<&Value>]) -> String {
    json::to_string(&Value::Array(
        items
            .iter()
            .map(|v| v.cloned().unwrap_or(Value::Null))
            .collect(),
    ))
}

/// `${value}` of a JSON value, as a template literal writes it.
fn template(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), Value::to_js_string)
}

/// Validates the shape of a diff document before anything is rebuilt from it (`checkEnvelope`).
fn check_envelope(j: &Object) -> Result<()> {
    let meta = j.get("meta").and_then(Value::as_object);
    if !meta.is_some_and(|m| {
        m.get("before").and_then(Value::as_object).is_some()
            && m.get("after").and_then(Value::as_object).is_some()
    }) {
        return Err(invalid(
            "A kgdiff diff needs meta.before and meta.after objects",
        ));
    }
    if j.get("options").and_then(Value::as_object).is_none() {
        return Err(invalid("A kgdiff diff needs an options object"));
    }
    for field in ["nodes", "edges", "hunks"] {
        if j.get(field).and_then(Value::as_array).is_none() {
            return Err(invalid(format!("A kgdiff diff needs a {field} array")));
        }
    }
    for field in ["matches", "suggestions"] {
        if j.get(field).is_some_and(|v| v.as_array().is_none()) {
            return Err(invalid(format!("diff.{field} must be an array")));
        }
    }
    if j.get("delta").and_then(Value::as_object).is_none() {
        return Err(invalid("A kgdiff diff needs a delta"));
    }
    if j.get("stats").and_then(Value::as_object).is_none() {
        return Err(invalid("A kgdiff diff needs stats"));
    }
    let stray = |x: &Object| -> Option<&'static str> {
        match x.get("status").and_then(Value::as_str) {
            Some("added") if x.contains_key("before") => Some("before"),
            Some("removed") if x.contains_key("after") => Some("after"),
            _ => None,
        }
    };
    let status_ok = |o: &Object| {
        o.get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| STATUSES.contains(&s))
    };
    for (i, n) in j
        .get("nodes")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .enumerate()
    {
        let valid = n
            .as_object()
            .filter(|o| o.get("id").and_then(Value::as_str).is_some() && status_ok(o));
        let Some(o) = valid else {
            return Err(invalid(format!(
                "diff.nodes[{i}] needs a string id and a valid status"
            )));
        };
        if let Some(side) = stray(o) {
            return Err(invalid(format!(
                "diff.nodes[{i}] (\"{}\") is {}, so it has no {side} snapshot",
                template(o.get("id")),
                template(o.get("status"))
            )));
        }
    }
    for (i, e) in j
        .get("edges")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .enumerate()
    {
        let valid = e.as_object().filter(|o| {
            ["id", "source", "target"]
                .iter()
                .all(|k| o.get(k).and_then(Value::as_str).is_some())
                && status_ok(o)
        });
        let Some(o) = valid else {
            return Err(invalid(format!(
                "diff.edges[{i}] needs string id / source / target and a valid status"
            )));
        };
        if let Some(side) = stray(o) {
            return Err(invalid(format!(
                "diff.edges[{i}] ({}) is {}, so it has no {side} snapshot",
                template(o.get("id")),
                template(o.get("status"))
            )));
        }
    }
    Ok(())
}

/// What makes an edge survive re-normalization (`fingerprint`).
fn fingerprint(
    id: Option<&Value>,
    source: Option<&Value>,
    predicate: Option<&Value>,
    target: Option<&Value>,
    label: Option<&Value>,
    attrs: Option<&Value>,
    mode: EdgeIdentity,
) -> String {
    if mode == EdgeIdentity::Id
        && let Some(id) = id
    {
        return format!("i{}", id.to_js_string());
    }
    let predicate = predicate
        .filter(|p| !p.is_null())
        .cloned()
        .unwrap_or_else(|| Value::from(""));
    let label = match label.filter(|l| !l.is_null()) {
        Some(label) => label.clone(),
        None => Value::from(raw_predicate_label(predicate.as_str().unwrap_or(""))),
    };
    let attrs = attrs
        .filter(|a| !a.is_null())
        .cloned()
        .unwrap_or_else(|| Value::Object(Object::new()));
    format!(
        "t{}\u{0}{}",
        stringify_list(&[source, Some(&predicate), target]),
        canonical_json(&Value::Array(vec![label, attrs]))
    )
}

fn edge_fingerprint(edge: &KGEdge, mode: EdgeIdentity) -> String {
    let (id, source, predicate, target, label) = (
        edge.id.as_ref().map(Value::from),
        Value::from(&edge.source),
        Value::from(&edge.predicate),
        Value::from(&edge.target),
        Value::from(&edge.label),
    );
    fingerprint(
        id.as_ref(),
        Some(&source),
        Some(&predicate),
        Some(&target),
        Some(&label),
        Some(&Value::Object(edge.attrs.clone())),
        mode,
    )
}

fn json_fingerprint(json: &Object, mode: EdgeIdentity) -> String {
    fingerprint(
        json.get("id"),
        json.get("source"),
        json.get("predicate"),
        json.get("target"),
        json.get("label"),
        json.get("attrs"),
        mode,
    )
}

/// `fingerprint(edge) === fingerprint(json)`, without building either (`sameFingerprint`).
fn same_fingerprint(edge: &KGEdge, json: &Object, mode: EdgeIdentity) -> bool {
    if mode == EdgeIdentity::Id && (edge.id.is_some() || json.contains_key("id")) {
        return match (&edge.id, json.get("id")) {
            (Some(a), Some(Value::String(b))) => a == b,
            (None, None) => true,
            _ => false,
        };
    }
    let predicate = match json.get("predicate") {
        None | Some(Value::Null) => JsStr::default(),
        Some(Value::String(p)) => p.clone(),
        Some(_) => return false,
    };
    let label_ok = match json.get("label") {
        None | Some(Value::Null) => edge.label == raw_predicate_label(&predicate),
        Some(Value::String(l)) => edge.label == *l,
        Some(_) => false,
    };
    let attrs_ok = match json.get("attrs") {
        None | Some(Value::Null) => edge.attrs.is_empty(),
        Some(Value::Object(a)) => attrs_equal(&edge.attrs, a, None),
        Some(_) => false,
    };
    json.get("source") == Some(&Value::from(&edge.source))
        && json.get("target") == Some(&Value::from(&edge.target))
        && edge.predicate == predicate
        && label_ok
        && attrs_ok
}

/// Finds the edge of a re-normalized graph a snapshot became (`edgeFinder`).
struct EdgeFinder<'a> {
    graph: &'a KGraph,
    index: Option<Lookup<String, Arc<KGEdge>>>,
}

impl<'a> EdgeFinder<'a> {
    fn new(graph: &'a KGraph) -> Self {
        EdgeFinder { graph, index: None }
    }

    fn find(&mut self, json: &Object) -> Option<Arc<KGEdge>> {
        let mode = self.graph.edge_identity;
        let key = match json.get("id") {
            Some(id) if mode == EdgeIdentity::Id => id.to_js_string(),
            _ => stringify_list(&[
                json.get("source"),
                Some(
                    json.get("predicate")
                        .filter(|p| !p.is_null())
                        .unwrap_or(&Value::from("")),
                ),
                json.get("target"),
            ]),
        };
        if let Some(direct) = self.graph.edges.get(key.as_str())
            && same_fingerprint(direct, json, mode)
        {
            return Some(direct.clone());
        }
        let graph = self.graph;
        let index = self.index.get_or_insert_with(|| {
            let mut index = Lookup::new();
            for edge in graph.edges.values() {
                index.insert(edge_fingerprint(edge, mode), edge.clone());
            }
            index
        });
        index.get(&json_fingerprint(json, mode)).cloned()
    }
}

/// Both graphs of a diff document, and the version of each union edge in them (`RebuiltGraphs`).
struct Rebuilt {
    before: KGraph,
    after: KGraph,
    before_of: Vec<Option<Arc<KGEdge>>>,
    after_of: Vec<Option<Arc<KGEdge>>>,
}

fn status_of(o: &Object) -> ChangeStatus {
    o.get("status")
        .and_then(Value::as_str)
        .and_then(ChangeStatus::from_name)
        .unwrap_or(ChangeStatus::Unchanged)
}

/// The graphs as `normalize` rebuilds them from the snapshots, their text taken as written
/// (`normalizedGraphs`).
fn normalized_graphs(
    doc: &Object,
    nodes: &[&Object],
    edges: &[&Object],
    mode: EdgeIdentity,
) -> Result<Rebuilt> {
    let meta = doc
        .get("meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let options = NormalizeOptions {
        edge_identity: mode,
        ..NormalizeOptions::default()
    };
    let graph_of = |side: &str, nodes: Vec<Value>, edges: Vec<Value>| -> Result<KGraph> {
        let mut input = Object::new();
        if let Some(m) = meta.get(side) {
            input.insert("meta", m.clone());
        }
        input.insert("nodes", Value::Array(nodes));
        input.insert("edges", Value::Array(edges));
        normalize_as(&Value::Object(input), options, TextForm::Snapshot)
    };
    let mut after_nodes = Vec::new();
    for n in nodes {
        if !has_after(status_of(n)) {
            continue;
        }
        let Some(after) = n.get("after") else {
            return Err(invalid(format!(
                "Union node \"{}\" ({}) has no after snapshot",
                template(n.get("id")),
                template(n.get("status"))
            )));
        };
        after_nodes.push(after.clone());
    }
    let mut after_edges = Vec::new();
    for e in edges {
        if !has_after(status_of(e)) {
            continue;
        }
        let Some(after) = e.get("after") else {
            return Err(invalid(format!(
                "Union edge {} ({}) has no after snapshot",
                template(e.get("id")),
                template(e.get("status"))
            )));
        };
        after_edges.push(after.clone());
    }
    let after = graph_of("after", after_nodes, after_edges)?;

    let truthy = |v: Option<&Value>| {
        v.is_some_and(|v| {
            !matches!(v, Value::Null | Value::Bool(false))
                && v.as_str() != Some("")
                && v.as_f64().is_none_or(|x| x != 0.0 && !x.is_nan())
        })
    };
    let mut before_nodes = Vec::new();
    for n in nodes {
        if !has_before(status_of(n)) {
            continue;
        }
        if truthy(n.get("before")) {
            before_nodes.push(n.get("before").cloned().unwrap_or_default());
            continue;
        }
        let twin = string_of(n, "afterId").and_then(|id| after.nodes.get(&id).cloned());
        let (Some(twin), Some(before_id)) = (twin, n.get("beforeId")) else {
            return Err(invalid(format!(
                "Union node \"{}\" has no before snapshot",
                template(n.get("id"))
            )));
        };
        let Value::Object(mut input) = node_input(&twin) else {
            unreachable!()
        };
        input.insert("id", before_id.clone());
        before_nodes.push(Value::Object(input));
    }
    let mut before_edges = Vec::new();
    for e in edges {
        if !has_before(status_of(e)) {
            continue;
        }
        let snapshot = e
            .get("before")
            .filter(|v| !v.is_null())
            .or_else(|| e.get("after"));
        let Some(snapshot) = snapshot.filter(|v| truthy(Some(v))) else {
            return Err(invalid(format!(
                "Union edge {} has no before snapshot",
                template(e.get("id"))
            )));
        };
        before_edges.push(snapshot.clone());
    }
    let before = graph_of("before", before_nodes, before_edges)?;

    let mut find_before = EdgeFinder::new(&before);
    let mut find_after = EdgeFinder::new(&after);
    let mut before_of = Vec::with_capacity(edges.len());
    let mut after_of = Vec::with_capacity(edges.len());
    for e in edges {
        let status = status_of(e);
        let snapshot = e
            .get("before")
            .filter(|v| !v.is_null())
            .or_else(|| e.get("after"))
            .and_then(Value::as_object);
        before_of.push(if has_before(status) {
            snapshot.and_then(|s| find_before.find(s))
        } else {
            None
        });
        after_of.push(if has_after(status) {
            e.get("after")
                .and_then(Value::as_object)
                .and_then(|s| find_after.find(s))
        } else {
            None
        });
    }
    drop((find_before, find_after));
    Ok(Rebuilt {
        before,
        after,
        before_of,
        after_of,
    })
}

/// The fast path (`canonicalGraphs`): the graphs read straight from the snapshots, when each node
/// and edge is declared once, canonical, and nothing would make `normalize` do more.
fn canonical_graphs(
    doc: &Object,
    nodes: &[&Object],
    edges: &[&Object],
    mode: EdgeIdentity,
) -> Option<Rebuilt> {
    if mode == EdgeIdentity::Structure
        && edges.iter().any(|e| {
            e.get("id")
                .and_then(Value::as_str)
                .is_some_and(has_parallel_suffix)
        })
    {
        return None;
    }
    let mut issues = Vec::new();
    let mut after_nodes: IndexMap<Id, Arc<KGNode>> = IndexMap::default();
    for n in nodes {
        if !has_after(status_of(n)) {
            continue;
        }
        let node = match n.get("after") {
            Some(Value::Object(after)) => node_of(after, &mut issues, after.get("id")).ok()??,
            _ => return None,
        };
        if after_nodes
            .insert(node.id.clone(), Arc::new(node))
            .is_some()
        {
            return None;
        }
    }
    let mut before_nodes: IndexMap<Id, Arc<KGNode>> = IndexMap::default();
    for n in nodes {
        if !has_before(status_of(n)) {
            continue;
        }
        let node = match n.get("before") {
            Some(Value::Object(before)) => {
                node_of(before, &mut issues, before.get("id")).ok()??
            }
            Some(v) if !v.is_null() && v != &Value::Bool(false) => return None,
            _ => {
                let twin = string_of(n, "afterId").and_then(|id| after_nodes.get(&id).cloned())?;
                let before_id = n.get("beforeId")?;
                let Value::Object(input) = node_input(&twin) else {
                    return None;
                };
                node_of(&input, &mut issues, Some(before_id)).ok()??
            }
        };
        if before_nodes
            .insert(node.id.clone(), Arc::new(node))
            .is_some()
        {
            return None;
        }
    }
    let mut after_edges: IndexMap<EdgeKey, Arc<KGEdge>> = IndexMap::default();
    let mut before_edges: IndexMap<EdgeKey, Arc<KGEdge>> = IndexMap::default();
    let read = |snapshot: Option<&Value>,
                edges: &mut IndexMap<EdgeKey, Arc<KGEdge>>,
                key: Option<EdgeKey>,
                issues: &mut Vec<crate::model::GraphIssue>|
     -> Option<Arc<KGEdge>> {
        let Some(Value::Object(snapshot)) = snapshot else {
            return None;
        };
        let edge = edge_of(snapshot, mode, issues, key).ok()??;
        if !same_fingerprint(&edge, snapshot, mode) || edges.contains_key(&edge.key) {
            return None;
        }
        let edge = Arc::new(edge);
        edges.insert(edge.key.clone(), edge.clone());
        Some(edge)
    };
    let mut after_of = Vec::with_capacity(edges.len());
    let mut before_of = Vec::with_capacity(edges.len());
    for e in edges {
        let status = status_of(e);
        let mut a = None;
        if has_after(status) {
            a = Some(read(e.get("after"), &mut after_edges, None, &mut issues)?);
        }
        let mut b = None;
        if has_before(status) {
            let stored_once = e.get("before").is_none_or(Value::is_null);
            let snapshot = if stored_once {
                e.get("after")
            } else {
                e.get("before")
            };
            let key = if stored_once {
                a.as_ref().map(|a| a.key.clone())
            } else {
                None
            };
            b = Some(read(snapshot, &mut before_edges, key, &mut issues)?);
        }
        after_of.push(a);
        before_of.push(b);
    }
    let ends_known = |edges: &IndexMap<EdgeKey, Arc<KGEdge>>, nodes: &IndexMap<Id, Arc<KGNode>>| {
        edges
            .values()
            .all(|e| nodes.contains_key(&e.source) && nodes.contains_key(&e.target))
    };
    if !issues.is_empty()
        || !ends_known(&after_edges, &after_nodes)
        || !ends_known(&before_edges, &before_nodes)
    {
        return None;
    }
    let meta = doc.get("meta").and_then(Value::as_object);
    Some(Rebuilt {
        before: index_graph(
            meta.and_then(|m| m.get("before")),
            before_nodes,
            before_edges,
            mode,
            Vec::new(),
        ),
        after: index_graph(
            meta.and_then(|m| m.get("after")),
            after_nodes,
            after_edges,
            mode,
            Vec::new(),
        ),
        before_of,
        after_of,
    })
}

const VERSIONS: [(ChangeStatus, &str); 4] = [
    (ChangeStatus::Added, "only an after version"),
    (ChangeStatus::Removed, "only a before version"),
    (ChangeStatus::Unchanged, "both versions"),
    (ChangeStatus::Modified, "both versions"),
];

/// Elements whose versions contradict their status (`misfit`).
fn misfit(what: &str, status: ChangeStatus, detail: &str) -> KgdiffError {
    let versions = VERSIONS
        .iter()
        .find(|(s, _)| *s == status)
        .map_or("", |(_, v)| *v);
    invalid(format!(
        "{what} is {}, so it must have {versions}{detail}",
        status.as_str()
    ))
}

/// A union node with the raw parts the consistency checks read.
struct RawNode<'a> {
    node: UnionNode,
    facets: Option<&'a Value>,
    hunk: Option<&'a Value>,
}

struct RawEdge<'a> {
    edge: UnionEdge,
    facets: Option<&'a Value>,
    hunk: Option<&'a Value>,
}

fn facet_kinds(facets: Option<&Value>) -> Vec<FacetKind> {
    facets
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            f.get("kind")
                .and_then(Value::as_str)
                .and_then(FacetKind::from_name)
        })
        .collect()
}

const NODE_FACETS: [&str; 12] = [
    "rekey",
    "rename",
    "mergedInto",
    "mergeTarget",
    "splitFrom",
    "splitInto",
    "move",
    "deprecate",
    "replacement",
    "types",
    "aliases",
    "attrs",
];
const EDGE_FACETS: [&str; 5] = ["retarget", "predicate", "label", "attrs", "collapsed"];

/// Facets, status and hunk of one union element agree (`checkChange`).
fn check_change(
    what: &str,
    status: ChangeStatus,
    facets: Option<&Value>,
    kinds: &[&str],
    hunk: Option<&Value>,
    hunks: &Lookup<JsStr, usize>,
) -> Result<()> {
    let empty = Vec::new();
    let list = match facets {
        None => &empty,
        Some(Value::Array(list))
            if list.iter().all(|f| {
                f.as_object()
                    .and_then(|o| o.get("kind"))
                    .and_then(Value::as_str)
                    .is_some_and(|k| kinds.contains(&k))
            }) =>
        {
            list
        }
        Some(_) => {
            return Err(invalid(format!(
                "{what}: facets must be a list of known facets"
            )));
        }
    };
    if status == ChangeStatus::Unchanged {
        if !list.is_empty() {
            return Err(invalid(format!("{what} is unchanged but has facets")));
        }
        if hunk.is_some() {
            return Err(invalid(format!(
                "{what} is unchanged but belongs to a hunk"
            )));
        }
        return Ok(());
    }
    if status == ChangeStatus::Modified && list.is_empty() {
        return Err(invalid(format!("{what} is modified but has no facets")));
    }
    let Some(hunk) = hunk else {
        return Err(invalid(format!(
            "{what} is {} but belongs to no hunk",
            status.as_str()
        )));
    };
    if !hunk.as_str().is_some_and(|h| hunks.contains_key(h)) {
        return Err(invalid(format!(
            "{what} belongs to the hunk {}, which the diff does not have",
            json::to_string(hunk)
        )));
    }
    Ok(())
}

/// Endpoints of union edges are union nodes and agree with the edge's versions (`checkEndpoints`).
fn check_endpoints(
    e: &UnionEdge,
    facets: Option<&Value>,
    nodes: &Lookup<UnionId, usize>,
    union_of_before: &Lookup<Id, UnionId>,
) -> Result<()> {
    let what = format!("Union edge {}", e.id);
    for end in [
        Some(&e.source),
        Some(&e.target),
        e.source_before.as_ref(),
        e.target_before.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if !nodes.contains_key(end) {
            return Err(invalid(format!(
                "{what} points to \"{end}\", which is not a union node"
            )));
        }
    }
    if let Some(after) = &e.after
        && (after.source != e.source || after.target != e.target)
    {
        return Err(invalid(format!(
            "{what}: source and target must be the endpoints of its after version"
        )));
    }
    let has = |kind: &str, end: Option<&str>| {
        facets
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|f| {
                f.get("kind").and_then(Value::as_str) == Some(kind)
                    && end.is_none_or(|end| f.get("end").and_then(Value::as_str) == Some(end))
            })
    };
    if let Some(sb) = &e.source_before
        && (*sb == e.source || !has("retarget", Some("source")))
    {
        return Err(invalid(format!(
            "{what}: sourceBefore needs another source and a source retarget facet"
        )));
    }
    if let Some(tb) = &e.target_before
        && (*tb == e.target || !has("retarget", Some("target")))
    {
        return Err(invalid(format!(
            "{what}: targetBefore needs another target and a target retarget facet"
        )));
    }
    if let Some(pb) = &e.predicate_before
        && (*pb == e.predicate || !has("predicate", None))
    {
        return Err(invalid(format!(
            "{what}: predicateBefore needs another predicate and a predicate facet"
        )));
    }
    if let Some(before) = &e.before {
        let source = union_of_before.get(&before.source);
        let target = union_of_before.get(&before.target);
        if source != Some(e.source_before.as_ref().unwrap_or(&e.source))
            || target != Some(e.target_before.as_ref().unwrap_or(&e.target))
        {
            return Err(invalid(format!(
                "{what}: its before version's endpoints must be sourceBefore ?? source, targetBefore ?? target"
            )));
        }
        if *e.predicate_before.as_ref().unwrap_or(&e.predicate) != before.predicate {
            return Err(invalid(format!(
                "{what}: its before version's predicate must be predicateBefore ?? predicate"
            )));
        }
    }
    Ok(())
}

const HUNK_KINDS: [&str; 6] = ["add", "remove", "merge", "split", "modify", "relations"];
const PHASES: [&str; 4] = ["remove", "restructure", "modify", "add"];

fn string_list(v: Option<&Value>) -> Option<Vec<JsStr>> {
    match v {
        Some(Value::Array(items)) => items.iter().map(|i| i.as_js_str().cloned()).collect(),
        _ => None,
    }
}

/// `checkHunkShape`.
fn check_hunk_shape(h: &Value, i: usize) -> Result<()> {
    let valid = h.as_object().is_some_and(|o| {
        o.get("id").and_then(Value::as_str).is_some()
            && o.get("kind")
                .and_then(Value::as_str)
                .is_some_and(|k| HUNK_KINDS.contains(&k))
            && o.get("phase")
                .and_then(Value::as_str)
                .is_some_and(|p| PHASES.contains(&p))
            && o.get("anchor").and_then(Value::as_str).is_some()
            && ["nodes", "edges", "context", "requires"]
                .iter()
                .all(|k| string_list(o.get(k)).is_some())
            && o.get("ops").and_then(Value::as_array).is_some()
            && o.get("summary").and_then(Value::as_object).is_some()
    });
    if valid {
        Ok(())
    } else {
        Err(invalid(format!(
            "diff.hunks[{i}] needs a string id and anchor, a known kind and phase, nodes / edges / context / requires lists of ids, ops and a summary"
        )))
    }
}

/// Inverse of `diff_to_json` (`diffFromJSON`): rebuilds both graphs from the union snapshots, the
/// union elements and the index, and checks everything `diff` guarantees between them.
/// `diff_to_json(diff_from_json(j))` equals `j` for what `diff_to_json` writes.
///
/// # Errors
///
/// `unsupported-version` for another format or version, `invalid-input` for a malformed or
/// inconsistent document.
pub fn diff_from_json(json: &Value) -> Result<DiffResult> {
    let doc = json
        .as_object()
        .filter(|o| o.get("format").and_then(Value::as_str) == Some("kgdiff.diff"));
    let Some(doc) = doc else {
        return Err(KgdiffError::new(
            ErrorCode::UnsupportedVersion,
            "Not a kgdiff diff (expected format \"kgdiff.diff\")",
        ));
    };
    let version = doc.get("version");
    if version != Some(&Value::Number(1.0)) {
        let mut details = Object::new();
        if let Some(v) = version {
            details.insert("version", v.clone());
        }
        return Err(KgdiffError::new(
            ErrorCode::UnsupportedVersion,
            format!(
                "Unsupported diff version {}; this reader supports version 1",
                template(version)
            ),
        )
        .with_details(details));
    }
    check_envelope(doc)?;
    let options = resolve_options(doc.get("options"))?;
    let mode = options.edge_identity;
    let objects = |key: &str| -> Vec<&Object> {
        doc.get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .collect()
    };
    let (json_nodes, json_edges) = (objects("nodes"), objects("edges"));
    let graphs = match canonical_graphs(doc, &json_nodes, &json_edges, mode) {
        Some(graphs) => graphs,
        None => normalized_graphs(doc, &json_nodes, &json_edges, mode)?,
    };
    let Rebuilt {
        before,
        after,
        before_of,
        after_of,
    } = graphs;

    // A version a node or edge must not have is left out here, so the misfit checks report it.
    let mut nodes: Vec<RawNode<'_>> = Vec::with_capacity(json_nodes.len());
    for n in &json_nodes {
        let id = string_of(n, "id").unwrap_or_default();
        let status = status_of(n);
        let before_id = string_of(n, "beforeId")
            .or_else(|| n.get("beforeId").map(|v| JsStr::from(v.to_js_string())));
        let after_id = string_of(n, "afterId")
            .or_else(|| n.get("afterId").map(|v| JsStr::from(v.to_js_string())));
        let b = before_id
            .as_ref()
            .filter(|_| has_before(status))
            .and_then(|id| before.nodes.get(id).cloned());
        let a = after_id
            .as_ref()
            .filter(|_| has_after(status))
            .and_then(|id| after.nodes.get(id).cloned());
        let what = format!("Union node \"{id}\"");
        let versions = " (beforeId and before, afterId and after)";
        let fits = match status {
            ChangeStatus::Added => {
                a.is_some() && after_id.is_some() && b.is_none() && before_id.is_none()
            }
            ChangeStatus::Removed => {
                b.is_some() && before_id.is_some() && a.is_none() && after_id.is_none()
            }
            _ => a.is_some() && b.is_some() && after_id.is_some() && before_id.is_some(),
        };
        if !fits {
            return Err(misfit(&what, status, versions));
        }
        let shown = a.as_ref().or(b.as_ref()).unwrap_or_else(|| unreachable!());
        let node = UnionNode {
            label: shown.label.clone(),
            degree: Degree {
                before: before.degree(before_id.as_deref()),
                after: after.degree(after_id.as_deref()),
            },
            id,
            status,
            before_id,
            after_id,
            before: b,
            after: a,
            facets: Vec::new(),
            hunk: string_of(n, "hunk"),
        };
        nodes.push(RawNode {
            node,
            facets: n.get("facets"),
            hunk: n.get("hunk"),
        });
    }

    let hierarchy: Lookup<JsStr, ()> =
        options
            .hierarchy_predicates
            .iter()
            .fold(Lookup::new(), |mut set, p| {
                set.insert(p.clone(), ());
                set
            });
    let mut edges: Vec<RawEdge<'_>> = Vec::with_capacity(json_edges.len());
    for (i, e) in json_edges.iter().enumerate() {
        let id = string_of(e, "id").unwrap_or_default();
        let (b, a) = (before_of[i].clone(), after_of[i].clone());
        let Some(shown) = a.as_ref().or(b.as_ref()).cloned() else {
            return Err(invalid(format!("Union edge {id} could not be rebuilt")));
        };
        let status = status_of(e);
        let edge = UnionEdge {
            source: string_of(e, "source").unwrap_or_default(),
            target: string_of(e, "target").unwrap_or_default(),
            predicate: shown.predicate.clone(),
            label: shown.label.clone(),
            status,
            facets: Vec::new(),
            hunk: string_of(e, "hunk"),
            hierarchical: hierarchy.contains_key(&shown.predicate),
            before_key: b.as_ref().map(|b| b.key.clone()),
            after_key: a.as_ref().map(|a| a.key.clone()),
            source_before: e.get("sourceBefore").map(|v| JsStr::from(v.to_js_string())),
            target_before: e.get("targetBefore").map(|v| JsStr::from(v.to_js_string())),
            predicate_before: e
                .get("predicateBefore")
                .map(|v| JsStr::from(v.to_js_string())),
            before: b,
            after: a,
            in_place: false,
            id,
        };
        let what = format!("Union edge {}", edge.id);
        let moved = edge.source_before.is_some()
            || edge.target_before.is_some()
            || edge.predicate_before.is_some();
        match status {
            ChangeStatus::Added => {
                if edge.after.is_none() || edge.before.is_some() {
                    return Err(misfit(&what, status, ""));
                }
                if moved {
                    return Err(misfit(
                        &what,
                        status,
                        " and no before-version endpoints or predicate",
                    ));
                }
            }
            ChangeStatus::Removed => {
                if edge.before.is_none() || edge.after.is_some() {
                    return Err(misfit(&what, status, ""));
                }
                if moved {
                    return Err(misfit(
                        &what,
                        status,
                        " and no before-version endpoints or predicate",
                    ));
                }
            }
            _ => {
                if edge.after.is_none() || edge.before.is_none() {
                    return Err(misfit(&what, status, ""));
                }
            }
        }
        edges.push(RawEdge {
            edge,
            facets: e.get("facets"),
            hunk: e.get("hunk"),
        });
    }

    let raw_hunks: &[Value] = doc.get("hunks").and_then(Value::as_array).unwrap_or(&[]);
    let raw_delta = doc.get("delta").unwrap_or(&Value::Null);
    let raw_stats = doc.get("stats").unwrap_or(&Value::Null);
    let delta = check_consistency(
        &before, &after, &options, &nodes, &edges, raw_hunks, raw_delta, raw_stats,
    )?;

    // Everything TypeScript checks holds: read what it passes through, typed.
    let mut union_nodes = Vec::with_capacity(nodes.len());
    for raw in nodes {
        let mut node = raw.node;
        node.facets = parse_list(raw.facets, |f, i| {
            node_facet(f).ok_or_else(|| malformed(&format!("Union node \"{}\"", node.id), i))
        })?;
        union_nodes.push(node);
    }
    let mut union_edges = Vec::with_capacity(edges.len());
    for raw in edges {
        let mut edge = raw.edge;
        edge.facets = parse_list(raw.facets, |f, i| {
            edge_facet(f).ok_or_else(|| malformed(&format!("Union edge {}", edge.id), i))
        })?;
        union_edges.push(edge);
    }
    let hunks = raw_hunks
        .iter()
        .enumerate()
        .map(|(i, h)| hunk_of(h, i, &union_nodes, &union_edges))
        .collect::<Result<Vec<_>>>()?;
    let matches = parse_list(doc.get("matches"), |m, i| {
        node_match(m).ok_or_else(|| invalid(format!("diff.matches[{i}] is not a match")))
    })?;
    let suggestions = parse_list(doc.get("suggestions"), |s, i| {
        suggestion(s).ok_or_else(|| invalid(format!("diff.suggestions[{i}] is not a suggestion")))
    })?;
    let stats = compute_stats(
        &before,
        &after,
        &union_nodes,
        &crate::stats::edge_kinds(&union_edges),
        &hunks,
    );
    Ok(DiffResult {
        before,
        after,
        options,
        nodes: union_nodes,
        edges: union_edges,
        hunks,
        matches,
        suggestions,
        delta,
        stats,
        index: DiffIndex::default(),
    })
}

fn malformed(what: &str, i: usize) -> KgdiffError {
    invalid(format!(
        "{what}: facets[{i}] does not have the shape of its kind"
    ))
}

fn parse_list<T>(
    list: Option<&Value>,
    parse: impl Fn(&Value, usize) -> Result<T>,
) -> Result<Vec<T>> {
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, v)| parse(v, i))
        .collect()
}

/// The consistency of a diff read from JSON (`checkConsistency`); the delta, read, when it holds.
#[allow(
    clippy::too_many_arguments,
    reason = "the parts of a rebuilt diff, as RebuiltDiff in TypeScript"
)]
fn check_consistency(
    before: &KGraph,
    after: &KGraph,
    options: &crate::options::DiffOptions,
    nodes: &[RawNode<'_>],
    edges: &[RawEdge<'_>],
    hunks: &[Value],
    raw_delta: &Value,
    raw_stats: &Value,
) -> Result<Delta> {
    let by_id =
        |ids: &mut dyn Iterator<Item = JsStr>, what: &str| -> Result<Lookup<JsStr, usize>> {
            let mut map = Lookup::new();
            for (i, id) in ids.enumerate() {
                if map.insert(id.clone(), i).is_some() {
                    return Err(invalid(format!(
                        "The {what} id \"{id}\" is used more than once"
                    )));
                }
            }
            Ok(map)
        };
    let node_at = by_id(&mut nodes.iter().map(|n| n.node.id.clone()), "union node")?;
    let edge_at = by_id(&mut edges.iter().map(|e| e.edge.id.clone()), "union edge")?;
    for (i, h) in hunks.iter().enumerate() {
        check_hunk_shape(h, i)?;
    }
    let hunk_at = by_id(
        &mut hunks.iter().map(|h| {
            h.get("id")
                .and_then(Value::as_js_str)
                .cloned()
                .unwrap_or_default()
        }),
        "hunk",
    )?;
    let mut union_of_before: Lookup<Id, UnionId> = Lookup::new();
    for n in nodes {
        check_change(
            &format!("Union node \"{}\"", n.node.id),
            n.node.status,
            n.facets,
            &NODE_FACETS,
            n.hunk,
            &hunk_at,
        )?;
        if let Some(b) = &n.node.before_id {
            union_of_before.insert(b.clone(), n.node.id.clone());
        }
    }
    for e in edges {
        check_change(
            &format!("Union edge {}", e.edge.id),
            e.edge.status,
            e.facets,
            &EDGE_FACETS,
            e.hunk,
            &hunk_at,
        )?;
        check_endpoints(&e.edge, e.facets, &node_at, &union_of_before)?;
    }

    // Hunks list exactly the elements that name them, own disjoint ops and require known hunks.
    let op_count = raw_delta
        .get("ops")
        .and_then(Value::as_array)
        .map_or(0, <[Value]>::len);
    let mut owned = vec![false; op_count];
    let mut listed: Lookup<UnionId, ()> = Lookup::new();
    let mut listed_edges: Lookup<UnionId, ()> = Lookup::new();
    for (i, h) in hunks.iter().enumerate() {
        let h = h
            .as_object()
            .unwrap_or_else(|| unreachable!("checked above"));
        let id = string_of(h, "id").unwrap_or_default();
        let what = format!("Hunk \"{id}\"");
        if h.get("order") != Some(&Value::from(i)) {
            return Err(invalid(format!(
                "{what} has order {} but is listed at {i}",
                template(h.get("order"))
            )));
        }
        let anchor = string_of(h, "anchor").unwrap_or_default();
        if !node_at.contains_key(&anchor) {
            return Err(invalid(format!(
                "{what} is anchored on \"{anchor}\", which is not a union node"
            )));
        }
        let mut members = Vec::new();
        for n in string_list(h.get("nodes")).unwrap_or_default() {
            let node = node_at.get(&n).map(|&k| &nodes[k]);
            match node {
                Some(raw)
                    if raw.hunk.and_then(Value::as_str) == Some(&id)
                        && !listed.contains_key(&n) =>
                {
                    listed.insert(n.clone(), ());
                    members.push((raw.node.status, facet_kinds(raw.facets)));
                }
                _ => {
                    return Err(invalid(format!(
                        "{what} lists the node \"{n}\", which is not one of its own"
                    )));
                }
            }
        }
        let mut member_edges = Vec::new();
        for e in string_list(h.get("edges")).unwrap_or_default() {
            let edge = edge_at.get(&e).map(|&k| &edges[k]);
            match edge {
                Some(raw)
                    if raw.hunk.and_then(Value::as_str) == Some(&id)
                        && !listed_edges.contains_key(&e) =>
                {
                    listed_edges.insert(e.clone(), ());
                    member_edges.push((raw.edge.status, facet_kinds(raw.facets)));
                }
                _ => {
                    return Err(invalid(format!(
                        "{what} lists the edge {e}, which is not one of its own"
                    )));
                }
            }
        }
        for c in string_list(h.get("context")).unwrap_or_default() {
            if !node_at.contains_key(&c) {
                return Err(invalid(format!(
                    "{what} has \"{c}\" as context, which is not a union node"
                )));
            }
        }
        let mut last: Option<usize> = None;
        for op in h.get("ops").and_then(Value::as_array).unwrap_or(&[]) {
            let index = match op {
                Value::Number(x)
                    if x.fract() == 0.0
                        && *x >= 0.0
                        && *x < crate::util::count_to_f64(op_count) =>
                {
                    crate::util::f64_to_count(*x)
                }
                _ => {
                    return Err(invalid(format!(
                        "{what}: ops must be ascending indices into delta.ops"
                    )));
                }
            };
            if last.is_some_and(|l| index <= l) {
                return Err(invalid(format!(
                    "{what}: ops must be ascending indices into delta.ops"
                )));
            }
            if owned[index] {
                return Err(invalid(format!(
                    "delta.ops[{index}] belongs to more than one hunk"
                )));
            }
            owned[index] = true;
            last = Some(index);
        }
        for r in string_list(h.get("requires")).unwrap_or_default() {
            if r == id || !hunk_at.contains_key(&r) {
                return Err(invalid(format!(
                    "{what} requires \"{r}\", which is not another hunk"
                )));
            }
        }
        let summary = hunk_summary(members.into_iter(), member_edges.into_iter());
        if canonical_json(&summary.to_value())
            != canonical_json(h.get("summary").unwrap_or(&Value::Null))
        {
            return Err(invalid(format!(
                "{what}: its summary does not match its nodes and edges"
            )));
        }
    }
    if listed.len() != nodes.iter().filter(|n| n.hunk.is_some()).count() {
        return Err(invalid("A union node names a hunk that does not list it"));
    }
    if listed_edges.len() != edges.iter().filter(|e| e.hunk.is_some()).count() {
        return Err(invalid("A union edge names a hunk that does not list it"));
    }

    // The delta describes this diff's graphs.
    let delta = Delta::from_value(raw_delta)?;
    if raw_delta.get("edgeIdentity").and_then(Value::as_str) != Some(options.edge_identity.as_str())
    {
        return Err(invalid(
            "The delta uses another edge identity than the diff",
        ));
    }
    let check = |reference: Option<&Value>, graph: &KGraph, side: &str| -> Result<()> {
        let version = if side == "base" { "before" } else { "after" };
        let field = |k: &str| reference.and_then(|r| r.get(k));
        if field("nodes") != Some(&Value::from(graph.nodes.len()))
            || field("edges") != Some(&Value::from(graph.edges.len()))
        {
            return Err(invalid(format!(
                "delta.{side} counts other nodes / edges than the {version} graph of the diff"
            )));
        }
        if field("hash").and_then(Value::as_str) != Some(hash_graph(graph)) {
            return Err(invalid(format!(
                "delta.{side} is another graph (hash {}) than the {version} graph of the diff",
                template(field("hash"))
            )));
        }
        Ok(())
    };
    check(raw_delta.get("base"), before, "base")?;
    check(raw_delta.get("target"), after, "target")?;

    // Stats from the union elements and the hunks' kinds.
    let union_nodes: Vec<UnionNode> = nodes.iter().map(|n| n.node.clone()).collect();
    let node_kinds: Vec<Vec<FacetKind>> = nodes.iter().map(|n| facet_kinds(n.facets)).collect();
    let edge_kinds: Vec<(ChangeStatus, Vec<FacetKind>)> = edges
        .iter()
        .map(|e| (e.edge.status, facet_kinds(e.facets)))
        .collect();
    let hunk_kinds: Vec<Hunk> = hunks
        .iter()
        .map(|h| Hunk {
            id: JsStr::default(),
            kind: h
                .get("kind")
                .and_then(Value::as_str)
                .and_then(HunkKind::from_name)
                .unwrap_or(HunkKind::Modify),
            phase: ReplayPhase::Modify,
            anchor: JsStr::default(),
            nodes: Vec::new(),
            edges: Vec::new(),
            context: Vec::new(),
            ops: Vec::new(),
            requires: Vec::new(),
            summary: crate::model::HunkSummary::default(),
            order: 0,
        })
        .collect();
    let stats = crate::stats::compute_stats_with(
        before,
        after,
        &union_nodes,
        &node_kinds,
        &edge_kinds,
        &hunk_kinds,
    );
    if canonical_json(&stats.to_value()) != canonical_json(raw_stats) {
        return Err(invalid(
            "diff.stats do not match the union elements and hunks",
        ));
    }
    Ok(delta)
}

// ─── Typed parts ─────────────────────────────────────────────────────────────

fn text(o: &Object, key: &str) -> Option<JsStr> {
    o.get(key).and_then(Value::as_js_str).cloned()
}

fn number(o: &Object, key: &str) -> Option<f64> {
    o.get(key).and_then(Value::as_f64)
}

fn set_change(v: Option<&Value>) -> Option<SetChange> {
    let o = v?.as_object()?;
    Some(SetChange {
        added: string_list(o.get("added"))?,
        removed: string_list(o.get("removed"))?,
    })
}

fn via(v: Option<&Value>) -> Option<Via> {
    match v?.as_str()? {
        "hint" => Some(Via::Hint),
        "heuristic" => Some(Via::Heuristic),
        _ => None,
    }
}

fn changes(v: Option<&Value>) -> Option<Vec<AttrChange>> {
    v?.as_array()?
        .iter()
        .map(|c| {
            let o = c.as_object()?;
            Some(AttrChange {
                key: text(o, "key")?,
                before: o.get("before").cloned(),
                after: o.get("after").cloned(),
            })
        })
        .collect()
}

fn node_facet(f: &Value) -> Option<NodeFacet> {
    let o = f.as_object()?;
    Some(match o.get("kind")?.as_str()? {
        "rekey" => NodeFacet::Rekey {
            from: text(o, "from")?,
            to: text(o, "to")?,
            score: number(o, "score")?,
        },
        "rename" => NodeFacet::Rename {
            from: text(o, "from")?,
            to: text(o, "to")?,
        },
        "mergedInto" => NodeFacet::MergedInto {
            target: text(o, "target")?,
            confidence: number(o, "confidence")?,
            via: via(o.get("via"))?,
        },
        "mergeTarget" => NodeFacet::MergeTarget {
            sources: string_list(o.get("sources"))?,
        },
        "splitFrom" => NodeFacet::SplitFrom {
            source: text(o, "source")?,
            confidence: number(o, "confidence")?,
            via: via(o.get("via"))?,
        },
        "splitInto" => NodeFacet::SplitInto {
            targets: string_list(o.get("targets"))?,
        },
        "move" => NodeFacet::Move {
            predicate: text(o, "predicate")?,
            from: string_list(o.get("from"))?,
            to: string_list(o.get("to"))?,
        },
        "deprecate" => NodeFacet::Deprecate {
            deprecated: o.get("deprecated")?.as_bool()?,
        },
        "replacement" => NodeFacet::Replacement {
            replaces: set_change(o.get("replaces"))?,
            replaced_by: set_change(o.get("replacedBy"))?,
        },
        "types" => NodeFacet::Types(SetChange {
            added: string_list(o.get("added"))?,
            removed: string_list(o.get("removed"))?,
        }),
        "aliases" => NodeFacet::Aliases(SetChange {
            added: string_list(o.get("added"))?,
            removed: string_list(o.get("removed"))?,
        }),
        "attrs" => NodeFacet::Attrs {
            changes: changes(o.get("changes"))?,
        },
        _ => return None,
    })
}

fn edge_facet(f: &Value) -> Option<EdgeFacet> {
    let o = f.as_object()?;
    Some(match o.get("kind")?.as_str()? {
        "retarget" => EdgeFacet::Retarget {
            end: match o.get("end")?.as_str()? {
                "source" => End::Source,
                "target" => End::Target,
                _ => return None,
            },
            from: text(o, "from")?,
            to: text(o, "to")?,
            cause: match o.get("cause")?.as_str()? {
                "edit" => Cause::Edit,
                "merge" => Cause::Merge,
                "split" => Cause::Split,
                "move" => Cause::Move,
                _ => return None,
            },
        },
        "predicate" => EdgeFacet::Predicate {
            from: text(o, "from")?,
            to: text(o, "to")?,
        },
        "label" => EdgeFacet::Label {
            from: text(o, "from")?,
            to: text(o, "to")?,
        },
        "attrs" => EdgeFacet::Attrs {
            changes: changes(o.get("changes"))?,
        },
        "collapsed" => EdgeFacet::Collapsed {
            into: text(o, "into")?,
        },
        _ => return None,
    })
}

fn evidence(v: Option<&Value>) -> Option<MatchEvidence> {
    let o = v?.as_object()?;
    Some(MatchEvidence {
        label: number(o, "label")?,
        neighbors: number(o, "neighbors")?,
        types: number(o, "types")?,
        attrs: number(o, "attrs")?,
    })
}

fn node_match(m: &Value) -> Option<NodeMatch> {
    let o = m.as_object()?;
    let method = match o.get("method")?.as_str()? {
        "id" => MatchMethod::Id,
        "hint" => MatchMethod::Hint,
        "similarity" => MatchMethod::Similarity,
        _ => return None,
    };
    let evidence = match o.get("evidence") {
        None => None,
        Some(e) => Some(evidence(Some(e))?),
    };
    Some(NodeMatch {
        before: text(o, "before")?,
        after: text(o, "after")?,
        method,
        score: number(o, "score")?,
        evidence,
    })
}

fn suggestion(s: &Value) -> Option<MatchSuggestion> {
    let o = s.as_object()?;
    let reason = match o.get("reason")?.as_str()? {
        "below-threshold" => SuggestionReason::BelowThreshold,
        "ambiguous" => SuggestionReason::Ambiguous,
        _ => return None,
    };
    Some(MatchSuggestion {
        before: text(o, "before")?,
        after: text(o, "after")?,
        score: number(o, "score")?,
        evidence: evidence(o.get("evidence"))?,
        reason,
    })
}

/// A hunk that passed the consistency checks, typed; its summary is the one it was checked
/// against.
fn hunk_of(h: &Value, i: usize, nodes: &[UnionNode], edges: &[UnionEdge]) -> Result<Hunk> {
    let o = h.as_object().unwrap_or_else(|| unreachable!("checked"));
    let strings = |k: &str| string_list(o.get(k)).unwrap_or_default();
    let member_nodes = strings("nodes");
    let member_edges = strings("edges");
    let node = |id: &JsStr| nodes.iter().find(|n| n.id == *id);
    let edge = |id: &JsStr| edges.iter().find(|e| e.id == *id);
    let summary = hunk_summary(
        member_nodes
            .iter()
            .filter_map(node)
            .map(|n| (n.status, n.facets.iter().map(NodeFacet::kind).collect())),
        member_edges
            .iter()
            .filter_map(edge)
            .map(|e| (e.status, e.facets.iter().map(EdgeFacet::kind).collect())),
    );
    Ok(Hunk {
        id: text(o, "id").unwrap_or_default(),
        kind: o
            .get("kind")
            .and_then(Value::as_str)
            .and_then(HunkKind::from_name)
            .unwrap_or(HunkKind::Modify),
        phase: o
            .get("phase")
            .and_then(Value::as_str)
            .and_then(ReplayPhase::from_name)
            .unwrap_or(ReplayPhase::Modify),
        anchor: text(o, "anchor").unwrap_or_default(),
        nodes: member_nodes,
        edges: member_edges,
        context: strings("context"),
        ops: o
            .get("ops")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_f64)
            .map(crate::util::f64_to_count)
            .collect(),
        requires: strings("requires"),
        summary,
        order: i,
    })
}
