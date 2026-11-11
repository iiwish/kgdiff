//! The delta (`delta.ts`, docs/delta-format.md, docs/algorithms.md §8): emission in canonical op
//! order, reading and checking, strict / lenient application, and inversion.

use std::sync::Arc;

use crate::js::IndexMap;

use crate::canonical::{attr_value_equals, attrs_equal, canonical_json, triple_key};
use crate::classify::ignored_attr_changes;
use crate::error::{ErrorCode, KgdiffError, Result};
use crate::graph::NodeParts;
use crate::graph_json::{edge_to_json, hash_graph, node_content_equals, node_to_json};
use crate::js::{self, JsStr, Lookup, Object, OrderedMap, Value, json};
use crate::model::{
    Attrs, ChangeStatus, EdgeFacet, EdgeIdentity, Id, KGEdge, KGNode, KGraph, NodeFacet, UnionEdge,
    UnionId, UnionNode,
};
use crate::normalize::normalize;
use crate::options::{NormalizeOptions, resolve_edge_identity};
use crate::pipeline::Ctx;
use crate::text::predicate_label;
use crate::util::sorted_unique;

/// A node field `node.set` changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeField {
    Label,
    Types,
    Aliases,
    Deprecated,
    Replaces,
    ReplacedBy,
}

impl NodeField {
    /// `NODE_FIELDS`, in op order.
    pub const ALL: [NodeField; 6] = [
        NodeField::Label,
        NodeField::Types,
        NodeField::Aliases,
        NodeField::Deprecated,
        NodeField::Replaces,
        NodeField::ReplacedBy,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            NodeField::Label => "label",
            NodeField::Types => "types",
            NodeField::Aliases => "aliases",
            NodeField::Deprecated => "deprecated",
            NodeField::Replaces => "replaces",
            NodeField::ReplacedBy => "replacedBy",
        }
    }

    pub fn from_name(name: &str) -> Option<NodeField> {
        NodeField::ALL.into_iter().find(|f| f.as_str() == name)
    }

    /// The field's value in a node, as JSON.
    pub fn value_of(self, node: &KGNode) -> Value {
        let strings = |list: &[JsStr]| Value::Array(list.iter().map(Value::from).collect());
        match self {
            NodeField::Label => Value::from(&node.label),
            NodeField::Types => strings(&node.types),
            NodeField::Aliases => strings(node.aliases()),
            NodeField::Deprecated => Value::Bool(node.deprecated),
            NodeField::Replaces => strings(node.replaces()),
            NodeField::ReplacedBy => strings(node.replaced_by()),
        }
    }
}

/// A primitive delta operation (`DeltaOp`). Node and edge snapshots are their JSON forms
/// (`nodeToJSON`, `edgeToJSON`, or an edge locator).
#[derive(Clone, Debug, PartialEq)]
pub enum DeltaOp {
    NodeRekey {
        from: Id,
        to: Id,
    },
    EdgeRemove {
        edge: Object,
    },
    NodeRemove {
        node: Object,
    },
    NodeSet {
        id: Id,
        field: NodeField,
        from: Value,
        to: Value,
    },
    NodeAttr {
        id: Id,
        key: JsStr,
        from: Option<Value>,
        to: Option<Value>,
    },
    NodeAdd {
        node: Object,
    },
    EdgeAdd {
        edge: Object,
    },
    /// `edge.set` of the field `label`.
    EdgeSet {
        edge: Object,
        from: JsStr,
        to: JsStr,
    },
    EdgeAttr {
        edge: Object,
        key: JsStr,
        from: Option<Value>,
        to: Option<Value>,
    },
}

impl DeltaOp {
    /// The op's name (`node.rekey`, …).
    pub fn name(&self) -> &'static str {
        match self {
            DeltaOp::NodeRekey { .. } => "node.rekey",
            DeltaOp::EdgeRemove { .. } => "edge.remove",
            DeltaOp::NodeRemove { .. } => "node.remove",
            DeltaOp::NodeSet { .. } => "node.set",
            DeltaOp::NodeAttr { .. } => "node.attr",
            DeltaOp::NodeAdd { .. } => "node.add",
            DeltaOp::EdgeAdd { .. } => "edge.add",
            DeltaOp::EdgeSet { .. } => "edge.set",
            DeltaOp::EdgeAttr { .. } => "edge.attr",
        }
    }

    /// The op as JSON, with the members in the order TypeScript writes them.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("op", self.name());
        let optional = |out: &mut Object, key: &str, value: &Option<Value>| {
            if let Some(value) = value {
                out.insert(key, value.clone());
            }
        };
        match self {
            DeltaOp::NodeRekey { from, to } => {
                out.insert("from", from);
                out.insert("to", to);
            }
            DeltaOp::EdgeRemove { edge } | DeltaOp::EdgeAdd { edge } => {
                out.insert("edge", edge.clone());
            }
            DeltaOp::NodeRemove { node } | DeltaOp::NodeAdd { node } => {
                out.insert("node", node.clone());
            }
            DeltaOp::NodeSet {
                id,
                field,
                from,
                to,
            } => {
                out.insert("id", id);
                out.insert("field", field.as_str());
                out.insert("from", from.clone());
                out.insert("to", to.clone());
            }
            DeltaOp::NodeAttr { id, key, from, to } => {
                out.insert("id", id);
                out.insert("key", key);
                optional(&mut out, "from", from);
                optional(&mut out, "to", to);
            }
            DeltaOp::EdgeSet { edge, from, to } => {
                out.insert("edge", edge.clone());
                out.insert("field", "label");
                out.insert("from", from);
                out.insert("to", to);
            }
            DeltaOp::EdgeAttr {
                edge,
                key,
                from,
                to,
            } => {
                out.insert("edge", edge.clone());
                out.insert("key", key);
                optional(&mut out, "from", from);
                optional(&mut out, "to", to);
            }
        }
        Value::Object(out)
    }
}

/// A low-level, invertible patch from one graph to another (`Delta`, `kgdiff.delta` version 1).
/// `base` and `target` are graph references (`GraphRef`: `name?`, `version?`, `hash`, `nodes`,
/// `edges`) as JSON; a delta read from JSON keeps them as written (`target` may even be absent,
/// which `checkDelta` allows).
#[derive(Clone, Debug, PartialEq)]
pub struct Delta {
    pub edge_identity: EdgeIdentity,
    pub base: Object,
    pub target: Option<Value>,
    /// In canonical op order (docs/delta-format.md §Canonical order).
    pub ops: Vec<DeltaOp>,
}

impl Delta {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("format", "kgdiff.delta");
        out.insert("version", 1.0);
        out.insert("edgeIdentity", self.edge_identity.as_str());
        out.insert("base", self.base.clone());
        if let Some(target) = &self.target {
            out.insert("target", target.clone());
        }
        out.insert(
            "ops",
            Value::Array(self.ops.iter().map(DeltaOp::to_value).collect()),
        );
        Value::Object(out)
    }

    /// The `base.hash` of the delta, if it has one.
    pub fn base_hash(&self) -> Option<&str> {
        self.base.get("hash").and_then(Value::as_str)
    }
}

/// The reference of a graph: `name` and `version` from its meta when they are strings, the
/// content hash and the sizes (`graphRef`).
pub(crate) fn graph_ref(graph: &KGraph) -> Object {
    let mut out = Object::new();
    if let Some(name) = graph.meta().get("name").filter(|v| v.as_str().is_some()) {
        out.insert("name", name.clone());
    }
    if let Some(version) = graph.meta().get("version").filter(|v| v.as_str().is_some()) {
        out.insert("version", version.clone());
    }
    out.insert("hash", hash_graph(graph));
    out.insert("nodes", graph.node_count());
    out.insert("edges", graph.edge_count());
    out
}

/// Identity of an edge snapshot: its id (`id` identity) or its structural key (`identityKey`).
pub(crate) fn identity_key(edge: &Object, mode: EdgeIdentity) -> String {
    let field = |name: &str| edge.get(name).and_then(Value::as_str);
    match field("id") {
        Some(id) if mode == EdgeIdentity::Id => id.to_owned(),
        _ => triple_key(
            field("source").unwrap_or(""),
            field("predicate").unwrap_or(""),
            field("target").unwrap_or(""),
        )
        .as_str()
        .to_owned(),
    }
}

/// Minimal locator of an edge for in-place updates: identity fields only (`edgeLocator`).
fn edge_locator(edge: &KGEdge, mode: EdgeIdentity) -> Object {
    let mut out = Object::new();
    if mode == EdgeIdentity::Id
        && let Some(id) = &edge.id
    {
        out.insert("id", id);
    }
    out.insert("source", &edge.source);
    out.insert("target", &edge.target);
    if !edge.predicate.is_empty() {
        out.insert("predicate", &edge.predicate);
    }
    out
}

/// Sequences renames so that every `to` is free when its rekey runs (`RenamePlanner`): chains
/// run back to front, cycles are broken through a temporary id.
pub(crate) struct RenamePlanner<'a> {
    pub plan: Vec<(Id, Id)>,
    vacated: Lookup<Id, ()>,
    filled: Lookup<Id, ()>,
    occupied_at_start: &'a dyn Fn(&str) -> bool,
    reserved: &'a dyn Fn(&str) -> bool,
}

impl<'a> RenamePlanner<'a> {
    pub fn new(
        occupied_at_start: &'a dyn Fn(&str) -> bool,
        reserved: &'a dyn Fn(&str) -> bool,
    ) -> Self {
        RenamePlanner {
            plan: Vec::new(),
            vacated: Lookup::new(),
            filled: Lookup::new(),
            occupied_at_start,
            reserved,
        }
    }

    pub fn occupied(&self, id: &str) -> bool {
        self.filled.contains_key(id)
            || ((self.occupied_at_start)(id) && !self.vacated.contains_key(id))
    }

    /// A fresh temporary id derived from `id`.
    pub fn temporary(&self, id: &str) -> Id {
        let mut temp = format!("{id}@tmp");
        while self.occupied(&temp) || (self.reserved)(&temp) {
            temp.push_str("@tmp");
        }
        JsStr::from(temp)
    }

    pub fn move_id(&mut self, from: &Id, to: &Id) {
        self.plan.push((from.clone(), to.clone()));
        self.vacated.insert(from.clone(), ());
        self.filled.remove(from);
        self.filled.insert(to.clone(), ());
    }

    /// Plans a set of renames `from → to`.
    pub fn run(&mut self, renames: &IndexMap<Id, Id>) {
        // Renames blocked on the node currently holding their target, keyed by that holder.
        let mut waiting: IndexMap<Id, (Id, Id)> = IndexMap::default();
        let mut queue: std::collections::VecDeque<(Id, Id)> = std::collections::VecDeque::new();
        let mut froms: Vec<&Id> = renames.keys().collect();
        froms.sort();
        for from in froms {
            let to = &renames[from];
            if self.occupied(to) {
                waiting.insert(to.clone(), (from.clone(), to.clone()));
            } else {
                queue.push_back((from.clone(), to.clone()));
            }
        }
        let release = |holder: &Id,
                       waiting: &mut IndexMap<Id, (Id, Id)>,
                       queue: &mut std::collections::VecDeque<(Id, Id)>| {
            if let Some(next) = waiting.shift_remove(holder) {
                queue.push_back(next);
            }
        };
        loop {
            while let Some((from, to)) = queue.pop_front() {
                self.move_id(&from, &to);
                release(&from, &mut waiting, &mut queue);
            }
            if waiting.is_empty() {
                return;
            }
            // Only cycles remain: park the smallest member on a temporary id to free its slot.
            let pick = waiting
                .values()
                .min_by(|a, b| a.0.cmp(&b.0))
                .cloned()
                .unwrap_or_else(|| unreachable!());
            let (from, to) = pick;
            let temp = self.temporary(&from);
            self.move_id(&from, &temp);
            waiting.insert(to.clone(), (temp, to));
            release(&from, &mut waiting, &mut queue);
        }
    }
}

/// One emitted op and the hunk of the union element it implements.
struct Emitted {
    op: DeltaOp,
    hunk: Option<JsStr>,
}

fn sort_edges(list: Vec<(DeltaOp, Object, Option<JsStr>)>, mode: EdgeIdentity) -> Vec<Emitted> {
    let mut keyed: Vec<(String, Emitted)> = list
        .into_iter()
        .map(|(op, edge, hunk)| {
            (
                format!(
                    "{}\u{0}{}",
                    identity_key(&edge, mode),
                    json::to_string(&Value::Object(edge))
                ),
                Emitted { op, hunk },
            )
        })
        .collect();
    keyed.sort_by(|a, b| js::cmp_utf16(&a.0, &b.0));
    keyed.into_iter().map(|(_, e)| e).collect()
}

fn attr_ops<'a>(
    facets: impl Iterator<Item = &'a [crate::model::AttrChange]>,
) -> Vec<(JsStr, Option<Value>, Option<Value>)> {
    facets
        .flat_map(|changes| {
            changes
                .iter()
                .map(|c| (c.key.clone(), c.before.clone(), c.after.clone()))
        })
        .collect()
}

/// A matched edge the delta removes and adds again, instead of updating it (`replaced`).
fn replaced(e: &UnionEdge) -> bool {
    e.status == ChangeStatus::Modified && !e.in_place
}

/// The changes of ignored attributes, which head the delta and belong to no hunk
/// (`ignoredAttrOps`): they are not changes the diff shows, yet applying the delta must reach the
/// after graph. They address the before graph, ahead of every rename, so they never depend on a
/// hunk (an unchanged edge can have an endpoint a hunk renames) and no hunk depends on them.
/// Snapshots already carry the attributes of what is added, removed or replaced. A parallel copy
/// has no locator of its own, so it is replaced.
fn ignored_attr_ops(ctx: &Ctx<'_>, nodes: &[UnionNode], edges: &[UnionEdge]) -> Vec<Emitted> {
    let ignored = &ctx.options.ignore_attrs;
    if ignored.is_empty() {
        return Vec::new();
    }
    let mode = ctx.options.edge_identity;
    let mut ops: Vec<Emitted> = Vec::new();
    for n in nodes {
        let (Some(before), Some(after)) = (&n.before, &n.after) else {
            continue;
        };
        let changes = ignored_attr_changes(&before.attrs, &after.attrs, ignored);
        for (key, from, to) in attr_ops(std::iter::once(changes.as_slice())) {
            ops.push(Emitted {
                op: DeltaOp::NodeAttr {
                    id: before.id.clone(),
                    key,
                    from,
                    to,
                },
                hunk: None,
            });
        }
    }
    let mut removals = Vec::new();
    let mut additions = Vec::new();
    let mut updates = Vec::new();
    for e in edges {
        let (Some(before), Some(after)) = (&e.before, &e.after) else {
            continue;
        };
        if replaced(e) {
            continue;
        }
        let changes = ignored_attr_changes(&before.attrs, &after.attrs, ignored);
        if changes.is_empty() {
            continue;
        }
        if e.in_place {
            let locator = edge_locator(before, mode);
            let key = identity_key(&locator, mode);
            updates.push((locator, changes, key));
            continue;
        }
        let old = edge_to_json(before, None, None);
        let next = edge_to_json(after, Some(&before.source), Some(&before.target));
        removals.push((DeltaOp::EdgeRemove { edge: old.clone() }, old, None));
        additions.push((DeltaOp::EdgeAdd { edge: next.clone() }, next, None));
    }
    ops.extend(sort_edges(removals, mode));
    ops.extend(sort_edges(additions, mode));
    updates.sort_by(|a, b| js::cmp_utf16(&a.2, &b.2));
    for (locator, changes, _) in updates {
        for (key, from, to) in attr_ops(std::iter::once(changes.as_slice())) {
            ops.push(Emitted {
                op: DeltaOp::EdgeAttr {
                    edge: locator.clone(),
                    key,
                    from,
                    to,
                },
                hunk: None,
            });
        }
    }
    ops
}

/// Builds the canonical delta of a classified union, with the hunk of each op (`buildDelta`).
pub(crate) fn build_delta(
    ctx: &Ctx<'_>,
    nodes: &[UnionNode],
    edges: &[UnionEdge],
) -> (Delta, Vec<Option<JsStr>>) {
    let mode = ctx.options.edge_identity;
    let node_by_union: Lookup<UnionId, usize> =
        nodes
            .iter()
            .enumerate()
            .fold(Lookup::new(), |mut m, (i, n)| {
                m.insert(n.id.clone(), i);
                m
            });
    let hunk_of = |id: &UnionId| node_by_union.get(id).and_then(|&i| nodes[i].hunk.clone());

    // 1. node.rekey — renames of nodes that belong to no hunk first, as a preamble; a hunk-owned
    // node in their way is parked on a temporary id, and its hunk renames it from there later.
    let renamed_to: Lookup<UnionId, ()> =
        ctx.renamed.values().fold(Lookup::new(), |mut set, to| {
            set.insert(to.clone(), ());
            set
        });
    let occupied = |id: &str| ctx.before.nodes.contains_key(id);
    let reserved = |id: &str| {
        ctx.after.nodes.contains_key(id)
            || renamed_to.contains_key(id)
            || ctx.before.nodes.contains_key(id)
    };
    let mut planner = RenamePlanner::new(&occupied, &reserved);
    let mut preamble: IndexMap<Id, Id> = IndexMap::default();
    let mut owned: IndexMap<Id, Id> = IndexMap::default();
    for (from, to) in &ctx.renamed {
        if hunk_of(to).is_none() {
            preamble.insert(from.clone(), to.clone());
        } else {
            owned.insert(from.clone(), to.clone());
        }
    }
    let mut targets: Vec<Id> = preamble.values().cloned().collect();
    targets.sort();
    for to in targets {
        let Some(final_to) = owned.get(&to).cloned() else {
            continue;
        }; // the hunk-owned node holding `to`
        let temp = planner.temporary(&to);
        planner.move_id(&to, &temp);
        owned.shift_remove(&to);
        owned.insert(temp, final_to);
    }
    planner.run(&preamble);
    let preamble_length = planner.plan.len();
    planner.run(&owned);
    let mut ops = ignored_attr_ops(ctx, nodes, edges);
    let mut union_of_renamed: Lookup<Id, UnionId> = Lookup::new();
    for (i, (from, to)) in planner.plan.iter().enumerate() {
        let origin = union_of_renamed
            .get(from)
            .cloned()
            .unwrap_or_else(|| ctx.union_of_before(from));
        union_of_renamed.insert(to.clone(), origin.clone());
        let hunk = if i < preamble_length {
            None
        } else {
            hunk_of(&origin)
        };
        ops.push(Emitted {
            op: DeltaOp::NodeRekey {
                from: from.clone(),
                to: to.clone(),
            },
            hunk,
        });
    }

    // 2. edge.remove
    let mut removals = Vec::new();
    for e in edges {
        let Some(before) = &e.before else { continue };
        if !(e.status == ChangeStatus::Removed || replaced(e)) {
            continue;
        }
        let edge = edge_to_json(
            before,
            Some(&ctx.union_of_before(&before.source)),
            Some(&ctx.union_of_before(&before.target)),
        );
        removals.push((
            DeltaOp::EdgeRemove { edge: edge.clone() },
            edge,
            e.hunk.clone(),
        ));
    }
    ops.extend(sort_edges(removals, mode));

    // 3. node.remove (union nodes are sorted by union id)
    for n in nodes {
        if let (ChangeStatus::Removed, Some(before)) = (n.status, &n.before) {
            ops.push(Emitted {
                op: DeltaOp::NodeRemove {
                    node: node_to_json(before, Some(&n.id)),
                },
                hunk: n.hunk.clone(),
            });
        }
    }
    // 4. node.set, 5. node.attr
    let mut attr_emitted: Vec<Emitted> = Vec::new();
    for n in nodes {
        let (ChangeStatus::Modified, Some(before), Some(after)) = (n.status, &n.before, &n.after)
        else {
            continue;
        };
        for field in NodeField::ALL {
            let (from, to) = (field.value_of(before), field.value_of(after));
            if from != to {
                ops.push(Emitted {
                    op: DeltaOp::NodeSet {
                        id: n.id.clone(),
                        field,
                        from,
                        to,
                    },
                    hunk: n.hunk.clone(),
                });
            }
        }
        let changes = n.facets.iter().filter_map(|f| {
            if let NodeFacet::Attrs { changes } = f {
                Some(changes.as_slice())
            } else {
                None
            }
        });
        for (key, from, to) in attr_ops(changes) {
            attr_emitted.push(Emitted {
                op: DeltaOp::NodeAttr {
                    id: n.id.clone(),
                    key,
                    from,
                    to,
                },
                hunk: n.hunk.clone(),
            });
        }
    }
    ops.extend(attr_emitted);
    // 6. node.add
    for n in nodes {
        if let (ChangeStatus::Added, Some(after)) = (n.status, &n.after) {
            ops.push(Emitted {
                op: DeltaOp::NodeAdd {
                    node: node_to_json(after, None),
                },
                hunk: n.hunk.clone(),
            });
        }
    }
    // 7. edge.add
    let mut additions = Vec::new();
    for e in edges {
        let Some(after) = &e.after else { continue };
        if !(e.status == ChangeStatus::Added || replaced(e)) {
            continue;
        }
        let edge = edge_to_json(after, None, None);
        additions.push((
            DeltaOp::EdgeAdd { edge: edge.clone() },
            edge,
            e.hunk.clone(),
        ));
    }
    ops.extend(sort_edges(additions, mode));
    // 8. edge.set, then edge.attr
    let mut in_place: Vec<(&UnionEdge, Object, String)> = edges
        .iter()
        .filter(|e| {
            e.status == ChangeStatus::Modified
                && e.in_place
                && e.before.is_some()
                && e.after.is_some()
        })
        .map(|e| {
            let locator = edge_locator(e.after.as_ref().unwrap_or_else(|| unreachable!()), mode);
            let key = identity_key(&locator, mode);
            (e, locator, key)
        })
        .collect();
    in_place.sort_by(|a, b| js::cmp_utf16(&a.2, &b.2));
    for (e, locator, _) in &in_place {
        let (Some(b), Some(a)) = (&e.before, &e.after) else {
            continue;
        };
        if b.label != a.label {
            ops.push(Emitted {
                op: DeltaOp::EdgeSet {
                    edge: locator.clone(),
                    from: b.label.clone(),
                    to: a.label.clone(),
                },
                hunk: e.hunk.clone(),
            });
        }
    }
    for (e, locator, _) in &in_place {
        let changes = e.facets.iter().filter_map(|f| {
            if let EdgeFacet::Attrs { changes } = f {
                Some(changes.as_slice())
            } else {
                None
            }
        });
        for (key, from, to) in attr_ops(changes) {
            ops.push(Emitted {
                op: DeltaOp::EdgeAttr {
                    edge: locator.clone(),
                    key,
                    from,
                    to,
                },
                hunk: e.hunk.clone(),
            });
        }
    }

    let op_hunks = ops.iter().map(|x| x.hunk.clone()).collect();
    let delta = Delta {
        edge_identity: mode,
        base: graph_ref(ctx.before),
        target: Some(Value::Object(graph_ref(ctx.after))),
        ops: ops.into_iter().map(|x| x.op).collect(),
    };
    (delta, op_hunks)
}

// ─── Validation ──────────────────────────────────────────────────────────────

fn is_string(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(_)))
}

fn is_string_list(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Array(items)) if items.iter().all(|i| i.as_str().is_some()))
}

/// `v === undefined || test(v)`.
fn optional(v: Option<&Value>, test: impl Fn(Option<&Value>) -> bool) -> bool {
    v.is_none() || test(v)
}

fn is_record(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}

/// Shape of a node snapshot (`validNode`).
fn valid_node(v: Option<&Value>) -> bool {
    let Some(Value::Object(o)) = v else {
        return false;
    };
    is_string(o.get("id"))
        && optional(o.get("label"), is_string)
        && optional(o.get("types"), is_string_list)
        && optional(o.get("aliases"), is_string_list)
        && optional(o.get("attrs"), is_record)
        && optional(o.get("deprecated"), |d| matches!(d, Some(Value::Bool(_))))
        && optional(o.get("replaces"), is_string_list)
        && optional(o.get("replacedBy"), is_string_list)
}

/// Shape of an edge snapshot (`validEdge`).
fn valid_edge(v: Option<&Value>) -> bool {
    let Some(Value::Object(o)) = v else {
        return false;
    };
    is_string(o.get("source"))
        && is_string(o.get("target"))
        && optional(o.get("id"), is_string)
        && optional(o.get("predicate"), is_string)
        && optional(o.get("label"), is_string)
        && optional(o.get("attrs"), is_record)
}

/// `validFieldValue`.
fn valid_field_value(field: Option<&Value>, value: Option<&Value>) -> bool {
    match field.and_then(Value::as_str) {
        Some("label") => is_string(value),
        Some("deprecated") => matches!(value, Some(Value::Bool(_))),
        Some(f) => NodeField::from_name(f).is_some() && is_string_list(value),
        None => false,
    }
}

/// `JSON.stringify(value)` of a possibly absent value (`undefined` when absent).
fn stringify(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), json::to_string)
}

fn object_of(value: Option<&Value>) -> Object {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn text_of(value: Option<&Value>) -> JsStr {
    value
        .and_then(Value::as_js_str)
        .cloned()
        .unwrap_or_default()
}

impl DeltaOp {
    /// Reads one op, rejecting a malformed one as `checkOp` does: malformed ops are input errors,
    /// not conflicts.
    ///
    /// # Errors
    ///
    /// `invalid-input` naming `delta.ops[index]`.
    pub fn from_value(op: &Value, index: usize) -> Result<DeltaOp> {
        let fail = |what: String| {
            let mut details = Object::new();
            details.insert("opIndex", index);
            details.insert("op", op.clone());
            KgdiffError::invalid_input(format!("delta.ops[{index}] {what}")).with_details(details)
        };
        let Value::Object(o) = op else {
            return Err(fail("is not an op".to_owned()));
        };
        let get = |k: &str| o.get(k);
        match get("op").and_then(Value::as_str) {
            Some("node.rekey") => {
                if !is_string(get("from")) || !is_string(get("to")) {
                    return Err(fail("needs string \"from\" and \"to\"".to_owned()));
                }
                Ok(DeltaOp::NodeRekey {
                    from: text_of(get("from")),
                    to: text_of(get("to")),
                })
            }
            Some(name @ ("node.remove" | "node.add")) => {
                if !valid_node(get("node")) {
                    return Err(fail("needs a valid \"node\" snapshot".to_owned()));
                }
                let node = object_of(get("node"));
                Ok(if name == "node.add" {
                    DeltaOp::NodeAdd { node }
                } else {
                    DeltaOp::NodeRemove { node }
                })
            }
            Some("node.set") => {
                if !is_string(get("id")) {
                    return Err(fail("needs a string \"id\"".to_owned()));
                }
                if !valid_field_value(get("field"), get("from"))
                    || !valid_field_value(get("field"), get("to"))
                {
                    return Err(fail(format!(
                        "has values that do not fit the field {}",
                        stringify(get("field"))
                    )));
                }
                let field = get("field")
                    .and_then(Value::as_str)
                    .and_then(NodeField::from_name)
                    .unwrap_or(NodeField::Label);
                Ok(DeltaOp::NodeSet {
                    id: text_of(get("id")),
                    field,
                    from: get("from").cloned().unwrap_or_default(),
                    to: get("to").cloned().unwrap_or_default(),
                })
            }
            Some("node.attr") => {
                if !is_string(get("id")) || !is_string(get("key")) {
                    return Err(fail("needs a string \"id\" and \"key\"".to_owned()));
                }
                Ok(DeltaOp::NodeAttr {
                    id: text_of(get("id")),
                    key: text_of(get("key")),
                    from: get("from").cloned(),
                    to: get("to").cloned(),
                })
            }
            Some(name @ ("edge.remove" | "edge.add")) => {
                if !valid_edge(get("edge")) {
                    return Err(fail("needs a valid \"edge\" snapshot".to_owned()));
                }
                let edge = object_of(get("edge"));
                Ok(if name == "edge.add" {
                    DeltaOp::EdgeAdd { edge }
                } else {
                    DeltaOp::EdgeRemove { edge }
                })
            }
            Some("edge.set") => {
                if !valid_edge(get("edge"))
                    || get("field").and_then(Value::as_str) != Some("label")
                    || !is_string(get("from"))
                    || !is_string(get("to"))
                {
                    return Err(fail(
                        "needs an \"edge\", field \"label\" and string \"from\" / \"to\""
                            .to_owned(),
                    ));
                }
                Ok(DeltaOp::EdgeSet {
                    edge: object_of(get("edge")),
                    from: text_of(get("from")),
                    to: text_of(get("to")),
                })
            }
            Some("edge.attr") => {
                if !valid_edge(get("edge")) || !is_string(get("key")) {
                    return Err(fail("needs an \"edge\" and a string \"key\"".to_owned()));
                }
                Ok(DeltaOp::EdgeAttr {
                    edge: object_of(get("edge")),
                    key: text_of(get("key")),
                    from: get("from").cloned(),
                    to: get("to").cloned(),
                })
            }
            _ => Err(fail(format!("has an unknown op {}", stringify(get("op"))))),
        }
    }

    /// The inverse op (`invertOp`).
    pub fn inverse(&self) -> DeltaOp {
        match self {
            DeltaOp::NodeRekey { from, to } => DeltaOp::NodeRekey {
                from: to.clone(),
                to: from.clone(),
            },
            DeltaOp::EdgeRemove { edge } => DeltaOp::EdgeAdd { edge: edge.clone() },
            DeltaOp::EdgeAdd { edge } => DeltaOp::EdgeRemove { edge: edge.clone() },
            DeltaOp::NodeRemove { node } => DeltaOp::NodeAdd { node: node.clone() },
            DeltaOp::NodeAdd { node } => DeltaOp::NodeRemove { node: node.clone() },
            DeltaOp::NodeSet {
                id,
                field,
                from,
                to,
            } => DeltaOp::NodeSet {
                id: id.clone(),
                field: *field,
                from: to.clone(),
                to: from.clone(),
            },
            DeltaOp::NodeAttr { id, key, from, to } => DeltaOp::NodeAttr {
                id: id.clone(),
                key: key.clone(),
                from: to.clone(),
                to: from.clone(),
            },
            DeltaOp::EdgeSet { edge, from, to } => DeltaOp::EdgeSet {
                edge: edge.clone(),
                from: to.clone(),
                to: from.clone(),
            },
            DeltaOp::EdgeAttr {
                edge,
                key,
                from,
                to,
            } => DeltaOp::EdgeAttr {
                edge: edge.clone(),
                key: key.clone(),
                from: to.clone(),
                to: from.clone(),
            },
        }
    }
}

impl Delta {
    /// Reads a delta document, validating its envelope and the shape of every op (`checkDelta`;
    /// values are checked when the delta is applied).
    ///
    /// # Errors
    ///
    /// `unsupported-version` for another format or version, `invalid-input` for a malformed
    /// envelope or op.
    pub fn from_value(delta: &Value) -> Result<Delta> {
        let record = delta.as_object();
        if record.and_then(|r| r.get("format")).and_then(Value::as_str) != Some("kgdiff.delta") {
            let mut details = Object::new();
            if let Some(format) = record.and_then(|r| r.get("format")) {
                details.insert("format", format.clone());
            }
            return Err(KgdiffError::new(
                ErrorCode::UnsupportedVersion,
                "Not a kgdiff delta (expected format \"kgdiff.delta\")",
            )
            .with_details(details));
        }
        let record = record.unwrap_or_else(|| unreachable!());
        let version = record.get("version");
        if version != Some(&Value::Number(1.0)) {
            let mut details = Object::new();
            if let Some(v) = version {
                details.insert("version", v.clone());
            }
            let shown = version.map_or_else(|| "undefined".to_owned(), Value::to_js_string);
            return Err(KgdiffError::new(
                ErrorCode::UnsupportedVersion,
                format!("Unsupported delta version {shown}; this reader supports version 1"),
            )
            .with_details(details));
        }
        let edge_identity =
            resolve_edge_identity(record.get("edgeIdentity"), EdgeIdentity::Structure)?;
        let base = match record.get("base") {
            Some(Value::Object(base)) if is_string(base.get("hash")) => base.clone(),
            _ => {
                return Err(KgdiffError::invalid_input(
                    "delta.base must describe the base graph (with a hash)",
                ));
            }
        };
        let Some(Value::Array(ops)) = record.get("ops") else {
            return Err(KgdiffError::invalid_input("delta.ops must be an array"));
        };
        let ops = ops
            .iter()
            .enumerate()
            .map(|(i, op)| DeltaOp::from_value(op, i))
            .collect::<Result<Vec<_>>>()?;
        Ok(Delta {
            edge_identity,
            base,
            target: record.get("target").cloned(),
            ops,
        })
    }
}

/// The delta that undoes `delta` (`invertDelta`): ops reversed and inverted, base and target
/// swapped. Valid, but not in canonical op order.
pub fn invert_delta(delta: &Delta) -> Delta {
    Delta {
        edge_identity: delta.edge_identity,
        base: delta
            .target
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        target: Some(Value::Object(delta.base.clone())),
        ops: delta.ops.iter().rev().map(DeltaOp::inverse).collect(),
    }
}

// ─── Application ─────────────────────────────────────────────────────────────

fn strings_of(value: Option<&Value>) -> Vec<JsStr> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_js_str).cloned().collect())
        .unwrap_or_default()
}

/// A node snapshot as a node, arrays normalized and defaults applied (`nodeFromJSON`).
fn node_from_json(json: &Object) -> KGNode {
    let id = text_of(json.get("id"));
    let label = match json.get("label").and_then(Value::as_js_str) {
        Some(label) if !label.is_empty() => label.clone(),
        _ => id.clone(),
    };
    let aliases = sorted_unique(&strings_of(json.get("aliases")))
        .into_iter()
        .filter(|a| *a != label)
        .collect();
    KGNode::from_parts(NodeParts {
        types: sorted_unique(&strings_of(json.get("types"))),
        aliases,
        attrs: object_of(json.get("attrs")),
        deprecated: json
            .get("deprecated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        replaces: sorted_unique(&strings_of(json.get("replaces"))),
        replaced_by: sorted_unique(&strings_of(json.get("replacedBy"))),
        implicit: json
            .get("implicit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        position: None,
        label,
        id,
    })
}

/// An edge snapshot as an edge, defaults applied; its key is not meaningful (`edgeFromJSON`).
fn edge_from_json(json: &Object) -> KGEdge {
    let predicate = text_of(json.get("predicate"));
    let label = json
        .get("label")
        .and_then(Value::as_js_str)
        .cloned()
        .unwrap_or_else(|| predicate_label(&predicate));
    KGEdge {
        key: JsStr::default(),
        id: json.get("id").and_then(Value::as_js_str).cloned(),
        source: text_of(json.get("source")),
        target: text_of(json.get("target")),
        predicate,
        label,
        attrs: object_of(json.get("attrs")),
    }
}

/// A copy of `attrs` with `key` set, or removed when `value` is `None` (`withAttr`).
fn with_attr(attrs: &Attrs, key: &JsStr, value: Option<&Value>) -> Attrs {
    let mut next = Object::with_capacity(attrs.len() + 1);
    for (k, v) in attrs {
        if k != key {
            next.insert(k.clone(), v.clone());
        }
    }
    if let Some(value) = value {
        next.insert(key.clone(), value.clone());
    }
    next
}

/// The copies of one edge identity, by content (`EdgeGroup`).
#[derive(Default)]
struct EdgeGroup {
    by_content: OrderedMap<String, Vec<Arc<KGEdge>>>,
    size: usize,
}

/// The mutable working copy of a graph while a delta is applied (`WorkingGraph`).
struct WorkingGraph {
    mode: EdgeIdentity,
    nodes: OrderedMap<Id, Arc<KGNode>>,
    groups: OrderedMap<String, EdgeGroup>,
    incident: OrderedMap<Id, OrderedMap<String, ()>>,
}

impl WorkingGraph {
    fn new(graph: &KGraph, mode: EdgeIdentity) -> WorkingGraph {
        let mut working = WorkingGraph {
            mode,
            nodes: OrderedMap::new(),
            groups: OrderedMap::new(),
            incident: OrderedMap::new(),
        };
        for node in graph.nodes.values() {
            working.nodes.insert(node.id.clone(), node.clone());
        }
        for edge in graph.shared_edges() {
            working.attach(edge);
        }
        working
    }

    fn identity(&self, id: Option<&str>, source: &str, predicate: &str, target: &str) -> String {
        match id {
            Some(id) if self.mode == EdgeIdentity::Id => format!("i{id}"),
            _ => format!("t{}", triple_key(source, predicate, target)),
        }
    }

    fn identity_of_edge(&self, edge: &KGEdge) -> String {
        self.identity(
            edge.id.as_deref(),
            &edge.source,
            &edge.predicate,
            &edge.target,
        )
    }

    fn identity_of_json(&self, json: &Object) -> String {
        let field = |k: &str| json.get(k).and_then(Value::as_str);
        self.identity(
            field("id"),
            field("source").unwrap_or(""),
            field("predicate").unwrap_or(""),
            field("target").unwrap_or(""),
        )
    }

    /// Everything an edge snapshot is compared on (the id only under `id` identity).
    fn content(&self, edge: &KGEdge) -> String {
        let id = match (&edge.id, self.mode) {
            (Some(id), EdgeIdentity::Id) => Value::from(id),
            _ => Value::Null,
        };
        canonical_json(&Value::Array(vec![
            Value::from(&edge.source),
            Value::from(&edge.predicate),
            Value::from(&edge.target),
            Value::from(&edge.label),
            Value::Object(edge.attrs.clone()),
            id,
        ]))
    }

    fn attach(&mut self, edge: Arc<KGEdge>) {
        let id = self.identity_of_edge(&edge);
        let content = self.content(&edge);
        let (source, target) = (edge.source.clone(), edge.target.clone());
        let group = self
            .groups
            .get_or_insert_with(id.clone(), EdgeGroup::default);
        group
            .by_content
            .get_or_insert_with(content, Vec::new)
            .push(edge);
        group.size += 1;
        self.incident
            .get_or_insert_with(source, OrderedMap::new)
            .insert(id.clone(), ());
        self.incident
            .get_or_insert_with(target, OrderedMap::new)
            .insert(id, ());
    }

    /// Removes one copy with the given content.
    fn detach_one(&mut self, id: &str, content: &str) -> Option<Arc<KGEdge>> {
        let group = self.groups.get_mut(id)?;
        let copies = group.by_content.get_mut(content)?;
        let edge = copies.pop()?;
        if copies.is_empty() {
            group.by_content.remove(content);
        }
        group.size -= 1;
        if group.size == 0 {
            self.groups.remove(id);
            if let Some(set) = self.incident.get_mut(&edge.source) {
                set.remove(id);
            }
            if let Some(set) = self.incident.get_mut(&edge.target) {
                set.remove(id);
            }
        }
        Some(edge)
    }

    /// Removes a whole identity group, returning its edges.
    fn detach_all(&mut self, id: &str) -> Vec<Arc<KGEdge>> {
        let Some(group) = self.groups.remove(id) else {
            return Vec::new();
        };
        let edges: Vec<Arc<KGEdge>> = group.by_content.values().flatten().cloned().collect();
        for edge in &edges {
            if let Some(set) = self.incident.get_mut(&edge.source) {
                set.remove(id);
            }
            if let Some(set) = self.incident.get_mut(&edge.target) {
                set.remove(id);
            }
        }
        edges
    }

    /// The edge a locator refers to; `label` / `attrs` disambiguate parallel copies (`locate`).
    fn locate(&self, json: &Object) -> std::result::Result<Arc<KGEdge>, String> {
        let Some(group) = self.groups.get(&self.identity_of_json(json)) else {
            return Err("edge not found".to_owned());
        };
        let copies: Vec<&Arc<KGEdge>> = group.by_content.values().flatten().collect();
        if copies.len() == 1 {
            return Ok(copies[0].clone());
        }
        let label = json.get("label").and_then(Value::as_str);
        let attrs = json.get("attrs").and_then(Value::as_object);
        let fits: Vec<&&Arc<KGEdge>> = copies
            .iter()
            .filter(|e| {
                label.is_none_or(|l| e.label == *l)
                    && attrs.is_none_or(|a| attrs_equal(&e.attrs, a, None))
            })
            .collect();
        match fits.len() {
            1 => Ok((*fits[0]).clone()),
            0 => Err("edge not found".to_owned()),
            _ => Err("edge is ambiguous (parallel copies)".to_owned()),
        }
    }

    /// Replaces `edge` by `next` (same identity, new content).
    fn replace(&mut self, edge: &KGEdge, next: KGEdge) {
        let (id, content) = (self.identity_of_edge(edge), self.content(edge));
        self.detach_one(&id, &content);
        self.attach(Arc::new(next));
    }

    /// Applies one op; the reason it cannot be applied, or `None` on success.
    fn apply(&mut self, op: &DeltaOp) -> Option<String> {
        match op {
            DeltaOp::NodeRekey { from, to } => {
                let Some(node) = self.nodes.get(from).cloned() else {
                    return Some(format!("node \"{from}\" does not exist"));
                };
                if self.nodes.contains_key(to) {
                    return Some(format!("node \"{to}\" already exists"));
                }
                self.nodes.remove(from);
                self.nodes.insert(
                    to.clone(),
                    Arc::new(KGNode {
                        id: to.clone(),
                        ..(*node).clone()
                    }),
                );
                let ids: Vec<String> = self
                    .incident
                    .get(from)
                    .map(|s| s.keys().cloned().collect())
                    .unwrap_or_default();
                let moved: Vec<Arc<KGEdge>> =
                    ids.iter().flat_map(|id| self.detach_all(id)).collect();
                self.incident.remove(from);
                for edge in moved {
                    let mut next = (*edge).clone();
                    if next.source == *from {
                        next.source = to.clone();
                    }
                    if next.target == *from {
                        next.target = to.clone();
                    }
                    self.attach(Arc::new(next));
                }
                None
            }
            DeltaOp::NodeRemove { node: json } => {
                let id = text_of(json.get("id"));
                let Some(node) = self.nodes.get(&id) else {
                    return Some(format!("node \"{id}\" does not exist"));
                };
                if !node_content_equals(node, &node_from_json(json)) {
                    return Some(format!("node \"{id}\" differs from the snapshot"));
                }
                if self.incident.get(&id).is_some_and(|s| !s.is_empty()) {
                    return Some(format!("node \"{id}\" still has edges"));
                }
                self.nodes.remove(&id);
                self.incident.remove(&id);
                None
            }
            DeltaOp::NodeAdd { node: json } => {
                let id = text_of(json.get("id"));
                if self.nodes.contains_key(&id) {
                    return Some(format!("node \"{id}\" already exists"));
                }
                self.nodes.insert(id, Arc::new(node_from_json(json)));
                None
            }
            DeltaOp::NodeSet {
                id,
                field,
                from,
                to,
            } => {
                let Some(node) = self.nodes.get(id) else {
                    return Some(format!("node \"{id}\" does not exist"));
                };
                if field.value_of(node) != *from {
                    return Some(format!(
                        "node \"{id}\" {} differs from \"from\"",
                        field.as_str()
                    ));
                }
                let mut next = node.to_parts();
                match field {
                    NodeField::Label => next.label = to.as_js_str().cloned().unwrap_or_default(),
                    NodeField::Deprecated => next.deprecated = to.as_bool().unwrap_or(false),
                    NodeField::Types => next.types = strings_of(Some(to)),
                    NodeField::Aliases => next.aliases = strings_of(Some(to)),
                    NodeField::Replaces => next.replaces = strings_of(Some(to)),
                    NodeField::ReplacedBy => next.replaced_by = strings_of(Some(to)),
                }
                self.nodes
                    .insert(id.clone(), Arc::new(KGNode::from_parts(next)));
                None
            }
            DeltaOp::NodeAttr { id, key, from, to } => {
                let Some(node) = self.nodes.get(id) else {
                    return Some(format!("node \"{id}\" does not exist"));
                };
                if !attr_value_equals(node.attrs.get(key), from.as_ref()) {
                    return Some(format!(
                        "node \"{id}\" attribute \"{key}\" differs from \"from\""
                    ));
                }
                let next = KGNode {
                    attrs: with_attr(&node.attrs, key, to.as_ref()),
                    ..(**node).clone()
                };
                self.nodes.insert(id.clone(), Arc::new(next));
                None
            }
            DeltaOp::EdgeRemove { edge: json } => {
                let id = self.identity_of_json(json);
                if !self.groups.contains_key(&id) {
                    return Some("edge not found".to_owned());
                }
                let content = self.content(&edge_from_json(json));
                if self.detach_one(&id, &content).is_some() {
                    None
                } else {
                    Some("edge differs from the snapshot".to_owned())
                }
            }
            DeltaOp::EdgeAdd { edge: json } => {
                let edge = edge_from_json(json);
                if !self.nodes.contains_key(&edge.source) {
                    return Some(format!("source node \"{}\" does not exist", edge.source));
                }
                if !self.nodes.contains_key(&edge.target) {
                    return Some(format!("target node \"{}\" does not exist", edge.target));
                }
                let group = self.groups.get(&self.identity_of_edge(&edge));
                let clash = if self.mode == EdgeIdentity::Id && edge.id.is_some() {
                    group.is_some()
                } else {
                    group.is_some_and(|g| g.by_content.contains_key(&self.content(&edge)))
                };
                if clash {
                    return Some("edge already exists".to_owned());
                }
                self.attach(Arc::new(edge));
                None
            }
            DeltaOp::EdgeSet {
                edge: json,
                from,
                to,
            } => {
                let edge = match self.locate(json) {
                    Ok(edge) => edge,
                    Err(reason) => return Some(reason),
                };
                if edge.label != *from {
                    return Some("edge label differs from \"from\"".to_owned());
                }
                let next = KGEdge {
                    label: to.clone(),
                    ..(*edge).clone()
                };
                self.replace(&edge, next);
                None
            }
            DeltaOp::EdgeAttr {
                edge: json,
                key,
                from,
                to,
            } => {
                let edge = match self.locate(json) {
                    Ok(edge) => edge,
                    Err(reason) => return Some(reason),
                };
                if !attr_value_equals(edge.attrs.get(key), from.as_ref()) {
                    return Some(format!("edge attribute \"{key}\" differs from \"from\""));
                }
                let next = KGEdge {
                    attrs: with_attr(&edge.attrs, key, to.as_ref()),
                    ..(*edge).clone()
                };
                self.replace(&edge, next);
                None
            }
        }
    }

    fn into_graph(self, meta: Object) -> Result<KGraph> {
        let nodes: Vec<Value> = self.nodes.values().map(|n| node_input(n)).collect();
        let mut edges: Vec<Value> = Vec::new();
        for group in self.groups.values() {
            for copies in group.by_content.values() {
                edges.extend(copies.iter().map(|e| edge_input(e)));
            }
        }
        let mut input = Object::new();
        input.insert("meta", meta);
        input.insert("nodes", Value::Array(nodes));
        input.insert("edges", Value::Array(edges));
        normalize(
            &Value::Object(input),
            NormalizeOptions {
                edge_identity: self.mode,
                ..NormalizeOptions::default()
            },
        )
    }
}

fn strings(list: &[JsStr]) -> Value {
    Value::Array(list.iter().map(Value::from).collect())
}

/// A node as normalize input, preserving `implicit` and `position` (`nodeInput`).
pub(crate) fn node_input(node: &KGNode) -> Value {
    let mut out = Object::new();
    out.insert("id", &node.id);
    out.insert("label", &node.label);
    out.insert("types", strings(&node.types));
    out.insert("aliases", strings(node.aliases()));
    out.insert("attrs", node.attrs.clone());
    out.insert("deprecated", node.deprecated);
    out.insert("replaces", strings(node.replaces()));
    out.insert("replacedBy", strings(node.replaced_by()));
    out.insert("implicit", node.implicit);
    if let Some(p) = node.position() {
        let mut position = Object::new();
        position.insert("x", p.x);
        position.insert("y", p.y);
        out.insert("position", position);
    }
    Value::Object(out)
}

/// An edge as normalize input.
fn edge_input(edge: &KGEdge) -> Value {
    let mut out = Object::new();
    if let Some(id) = &edge.id {
        out.insert("id", id);
    }
    out.insert("source", &edge.source);
    out.insert("target", &edge.target);
    out.insert("predicate", &edge.predicate);
    out.insert("label", &edge.label);
    out.insert("attrs", edge.attrs.clone());
    Value::Object(out)
}

/// The graph re-normalized under another edge identity, positions kept (`withEdgeIdentity`).
///
/// # Errors
///
/// None in practice: the graph is normalized already.
pub fn with_edge_identity(graph: &KGraph, edge_identity: EdgeIdentity) -> Result<KGraph> {
    if graph.edge_identity() == edge_identity {
        return Ok(graph.clone());
    }
    let mut input = Object::new();
    input.insert("meta", graph.meta().clone());
    input.insert(
        "nodes",
        Value::Array(graph.nodes.values().map(|n| node_input(n)).collect()),
    );
    input.insert(
        "edges",
        Value::Array(graph.edges().map(|e| edge_input(&e.to_edge())).collect()),
    );
    normalize(
        &Value::Object(input),
        NormalizeOptions {
            edge_identity,
            ..NormalizeOptions::default()
        },
    )
}

/// An op skipped in lenient mode: its index, the op and why (the text strict mode would put in
/// its `delta-conflict` error).
#[derive(Clone, Debug, PartialEq)]
pub struct SkippedOp {
    pub index: usize,
    pub op: DeltaOp,
    pub reason: String,
}

/// How `apply_delta` treats conflicts (`ApplyOptions`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApplyOptions {
    /// Verify `base.hash` and every op's precondition (the default); otherwise skip the ops whose
    /// precondition fails.
    pub strict: bool,
}

impl Default for ApplyOptions {
    fn default() -> ApplyOptions {
        ApplyOptions { strict: true }
    }
}

/// Applies a delta (`applyDelta`, docs/delta-format.md): the graph is re-keyed to the delta's
/// edge identity; strictly, the base hash and every op's precondition are verified and the first
/// violation fails; leniently, ops whose precondition fails are skipped and returned.
///
/// # Errors
///
/// `delta-base-mismatch` (`details: { expected, actual }`), `delta-conflict`
/// (`details: { opIndex, op, reason }`).
pub fn apply_delta(
    graph: &KGraph,
    delta: &Delta,
    options: ApplyOptions,
) -> Result<(KGraph, Vec<SkippedOp>)> {
    let base = with_edge_identity(graph, delta.edge_identity)?;
    let expected = delta.base_hash().unwrap_or_default();
    if options.strict {
        let actual = hash_graph(&base);
        if actual != expected {
            let mut details = Object::new();
            details.insert("expected", expected);
            details.insert("actual", actual);
            return Err(KgdiffError::new(
                ErrorCode::DeltaBaseMismatch,
                format!("The graph ({actual}) is not the base of this delta ({expected})"),
            )
            .with_details(details));
        }
    }
    let mut working = WorkingGraph::new(&base, delta.edge_identity);
    let mut skipped = Vec::new();
    for (index, op) in delta.ops.iter().enumerate() {
        let Some(reason) = working.apply(op) else {
            continue;
        };
        if !options.strict {
            skipped.push(SkippedOp {
                index,
                op: op.clone(),
                reason,
            });
            continue;
        }
        let mut details = Object::new();
        details.insert("opIndex", index);
        details.insert("op", op.to_value());
        details.insert("reason", reason.as_str());
        return Err(KgdiffError::new(
            ErrorCode::DeltaConflict,
            format!("Cannot apply op #{index} ({}): {reason}", op.name()),
        )
        .with_details(details));
    }
    let mut meta = base.meta().clone();
    if let Some(target) = &delta.target {
        if let Some(name) = target.get("name") {
            meta.insert("name", name.clone());
        }
        if let Some(version) = target.get("version") {
            meta.insert("version", version.clone());
        }
    }
    Ok((working.into_graph(meta)?, skipped))
}
