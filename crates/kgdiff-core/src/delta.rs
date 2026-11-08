//! The delta (`delta.ts`, docs/delta-format.md, docs/algorithms.md §8): emission in canonical op
//! order.

use indexmap::IndexMap;

use crate::canonical::triple_key;
use crate::graph_json::{edge_to_json, hash_graph, node_to_json};
use crate::js::{self, JsStr, Lookup, Object, Value, json};
use crate::model::{
    ChangeStatus, EdgeFacet, EdgeIdentity, Id, KGEdge, KGNode, KGraph, NodeFacet, UnionEdge,
    UnionId, UnionNode,
};
use crate::pipeline::Ctx;

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
            NodeField::Aliases => strings(&node.aliases),
            NodeField::Deprecated => Value::Bool(node.deprecated),
            NodeField::Replaces => strings(&node.replaces),
            NodeField::ReplacedBy => strings(&node.replaced_by),
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
/// `edges`) as JSON.
#[derive(Clone, Debug, PartialEq)]
pub struct Delta {
    pub edge_identity: EdgeIdentity,
    pub base: Object,
    pub target: Object,
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
        out.insert("target", self.target.clone());
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
    if let Some(name) = graph.meta.get("name").filter(|v| v.as_str().is_some()) {
        out.insert("name", name.clone());
    }
    if let Some(version) = graph.meta.get("version").filter(|v| v.as_str().is_some()) {
        out.insert("version", version.clone());
    }
    out.insert("hash", hash_graph(graph));
    out.insert("nodes", graph.nodes.len());
    out.insert("edges", graph.edges.len());
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
        let mut waiting: IndexMap<Id, (Id, Id)> = IndexMap::new();
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
    let mut preamble: IndexMap<Id, Id> = IndexMap::new();
    let mut owned: IndexMap<Id, Id> = IndexMap::new();
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
    let mut ops: Vec<Emitted> = Vec::new();
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

    let replaced = |e: &UnionEdge| e.status == ChangeStatus::Modified && !e.in_place;

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
        target: graph_ref(ctx.after),
        ops: ops.into_iter().map(|x| x.op).collect(),
    };
    (delta, op_hunks)
}
