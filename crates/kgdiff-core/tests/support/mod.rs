//! Random graphs full of edge cases, random edit scripts and a seeded shuffle: a port of
//! `packages/core/test/support/arbitraries.ts` to proptest, producing graphs as the JSON
//! `normalize` reads.

#![allow(
    dead_code,
    reason = "each test binary uses a part of the support module"
)]

use kgdiff_core::js::{JsStr, Object, Value};
use proptest::prelude::*;

pub const ID_POOL: [&str; 18] = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "x|y",
    "q\"uote",
    "back\\slash",
    "http://ex.org/n#1",
    "GO:0008150",
    "企业",
    "法定代表人",
    " sp ace ",
    "emoji😀",
    "n#2",
    "[\"a\",\"p\",\"b\"]",
    "a@before",
];

pub const LABEL_POOL: [&str; 13] = [
    "Alpha",
    "alpha",
    "Alpha Beta",
    "Marie Curie",
    "Marie Skłodowska-Curie",
    "Univ. of Paris",
    "University of Paris",
    "企业",
    "上市公司",
    "法人代表",
    "法定代表人",
    "x",
    "…",
];

pub const PREDICATES: [&str; 7] = [
    "p",
    "q",
    "is_a",
    "rdfs:subClassOf",
    "kg:持股",
    "http://ex.org/rel#part_of",
    "",
];
const TYPES: [&str; 3] = ["Person", "Org", "Class"];
const ATTR_KEYS: [&str; 4] = ["k1", "k2", "名称", "a.b"];
const NEW_IDS: [&str; 5] = ["n1", "n2", "n3", "Z|z", "新节点"];

/// A node of a `GraphInput`.
#[derive(Clone, Debug, Default)]
pub struct NodeIn {
    pub id: String,
    pub label: Option<String>,
    pub r#type: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub attrs: Option<Object>,
    pub deprecated: Option<bool>,
    pub replaces: Option<Vec<String>>,
    pub replaced_by: Option<Vec<String>>,
}

/// An edge of a `GraphInput`.
#[derive(Clone, Debug, Default)]
pub struct EdgeIn {
    pub id: Option<String>,
    pub source: String,
    pub target: String,
    pub predicate: Option<String>,
    pub label: Option<String>,
    pub attrs: Option<Object>,
}

/// A `GraphInput`.
#[derive(Clone, Debug, Default)]
pub struct GraphIn {
    pub nodes: Vec<NodeIn>,
    pub edges: Vec<EdgeIn>,
}

fn strings(list: &[String]) -> Value {
    Value::Array(list.iter().map(|s| Value::from(s.as_str())).collect())
}

impl NodeIn {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("id", self.id.as_str());
        if let Some(label) = &self.label {
            out.insert("label", label.as_str());
        }
        if let Some(types) = &self.r#type {
            out.insert("type", strings(types));
        }
        if let Some(aliases) = &self.aliases {
            out.insert("aliases", strings(aliases));
        }
        if let Some(attrs) = &self.attrs {
            out.insert("attrs", attrs.clone());
        }
        if let Some(deprecated) = self.deprecated {
            out.insert("deprecated", deprecated);
        }
        if let Some(replaces) = &self.replaces {
            out.insert("replaces", strings(replaces));
        }
        if let Some(replaced_by) = &self.replaced_by {
            out.insert("replacedBy", strings(replaced_by));
        }
        Value::Object(out)
    }
}

impl EdgeIn {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        if let Some(id) = &self.id {
            out.insert("id", id.as_str());
        }
        out.insert("source", self.source.as_str());
        out.insert("target", self.target.as_str());
        if let Some(predicate) = &self.predicate {
            out.insert("predicate", predicate.as_str());
        }
        if let Some(label) = &self.label {
            out.insert("label", label.as_str());
        }
        if let Some(attrs) = &self.attrs {
            out.insert("attrs", attrs.clone());
        }
        Value::Object(out)
    }
}

impl GraphIn {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert(
            "nodes",
            Value::Array(self.nodes.iter().map(NodeIn::to_value).collect()),
        );
        out.insert(
            "edges",
            Value::Array(self.edges.iter().map(EdgeIn::to_value).collect()),
        );
        Value::Object(out)
    }
}

fn pick(pool: &'static [&'static str]) -> impl Strategy<Value = String> {
    prop::sample::select(pool.to_vec()).prop_map(str::to_owned)
}

fn subarray(pool: &'static [&'static str], max: usize) -> impl Strategy<Value = Vec<String>> {
    prop::sample::subsequence(pool, 0..=max.min(pool.len()))
        .prop_map(|items| items.into_iter().map(str::to_owned).collect())
}

pub fn attr_value() -> BoxedStrategy<Value> {
    prop_oneof![
        "[ -~]{0,4}".prop_map(Value::from),
        (-3i32..=3).prop_map(Value::from),
        any::<bool>().prop_map(Value::from),
        Just(Value::Null),
        prop::collection::vec((0i32..=2).prop_map(Value::from), 0..=2).prop_map(Value::Array),
        (0i32..=2, prop::sample::select(&["u", "v"][..])).prop_map(|(x, y)| {
            let mut o = Object::new();
            o.insert("x", x);
            o.insert("y", y);
            Value::Object(o)
        }),
    ]
    .boxed()
}

fn attrs() -> impl Strategy<Value = Object> {
    prop::collection::vec((pick(&ATTR_KEYS), attr_value()), 0..=3).prop_map(|pairs| {
        pairs
            .into_iter()
            .map(|(k, v)| (JsStr::from(k), v))
            .collect()
    })
}

/// Each field present half of the time (`fc.record` with no required keys).
fn maybe<T: std::fmt::Debug + Clone + 'static>(
    s: impl Strategy<Value = T> + 'static,
) -> BoxedStrategy<Option<T>> {
    prop::option::of(s).boxed()
}

#[derive(Clone, Debug)]
struct NodeFields {
    label: Option<String>,
    r#type: Option<Vec<String>>,
    aliases: Option<Vec<String>>,
    attrs: Option<Object>,
    deprecated: Option<bool>,
    replaced_by: Option<Vec<String>>,
}

fn node_fields() -> impl Strategy<Value = NodeFields> {
    (
        maybe(pick(&LABEL_POOL)),
        maybe(subarray(&TYPES, 2)),
        maybe(subarray(&LABEL_POOL, 2)),
        maybe(attrs()),
        maybe(any::<bool>()),
        maybe(subarray(&ID_POOL, 1)),
    )
        .prop_map(
            |(label, r#type, aliases, attrs, deprecated, replaced_by)| NodeFields {
                label,
                r#type,
                aliases,
                attrs,
                deprecated,
                replaced_by,
            },
        )
}

#[derive(Clone, Debug)]
struct EdgeFields {
    s: usize,
    t: usize,
    predicate: String,
    label: Option<String>,
    attrs: Option<Object>,
    dangling: Option<bool>,
    with_id: Option<bool>,
}

fn edge_fields() -> impl Strategy<Value = EdgeFields> {
    (
        any::<u16>(),
        any::<u16>(),
        pick(&PREDICATES),
        maybe(pick(&["holds", "持股", "x"])),
        maybe(attrs()),
        maybe(any::<bool>()),
        maybe(any::<bool>()),
    )
        .prop_map(
            |(s, t, predicate, label, attrs, dangling, with_id)| EdgeFields {
                s: usize::from(s),
                t: usize::from(t),
                predicate,
                label,
                attrs,
                dangling,
                with_id,
            },
        )
}

/// A random graph with unique node ids and unique edge ids, when present (`graphArb`).
pub fn graph(max_nodes: usize, max_edges: usize) -> impl Strategy<Value = GraphIn> {
    (
        prop::sample::subsequence(&ID_POOL[..], 0..=max_nodes.min(ID_POOL.len())).prop_shuffle(),
        prop::collection::vec(node_fields(), 0..=max_nodes),
        prop::collection::vec(edge_fields(), 0..=max_edges),
    )
        .prop_map(|(ids, fields, specs)| {
            let nodes: Vec<NodeIn> = ids
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    let f = fields.get(i).cloned();
                    NodeIn {
                        id: (*id).to_owned(),
                        label: f.as_ref().and_then(|f| f.label.clone()),
                        r#type: f.as_ref().and_then(|f| f.r#type.clone()),
                        aliases: f.as_ref().and_then(|f| f.aliases.clone()),
                        attrs: f.as_ref().and_then(|f| f.attrs.clone()),
                        deprecated: f.as_ref().and_then(|f| f.deprecated),
                        replaced_by: f.as_ref().and_then(|f| f.replaced_by.clone()),
                        replaces: None,
                    }
                })
                .collect();
            let mut edges = Vec::new();
            if !ids.is_empty() {
                for (i, spec) in specs.into_iter().enumerate() {
                    let source = ids[spec.s % ids.len()].to_owned();
                    let target = if spec.dangling == Some(true) {
                        "dangling".to_owned()
                    } else {
                        ids[spec.t % ids.len()].to_owned()
                    };
                    edges.push(EdgeIn {
                        id: (spec.with_id == Some(true)).then(|| format!("e{i}")),
                        source,
                        target,
                        predicate: Some(spec.predicate),
                        label: spec.label,
                        attrs: spec.attrs,
                    });
                }
            }
            GraphIn { nodes, edges }
        })
}

// ─── Edit scripts ────────────────────────────────────────────────────────────

/// One edit of a version (`Mutation`).
#[derive(Clone, Debug)]
pub enum Mutation {
    AddNode {
        id: String,
        label: String,
    },
    RemoveNode {
        i: usize,
    },
    Rename {
        i: usize,
        label: String,
    },
    SetAttr {
        i: usize,
        key: String,
        value: Value,
    },
    DelAttr {
        i: usize,
    },
    SetTypes {
        i: usize,
        types: Vec<String>,
    },
    SetAliases {
        i: usize,
        aliases: Vec<String>,
    },
    Deprecate {
        i: usize,
        j: usize,
    },
    AddEdge {
        s: usize,
        t: usize,
        predicate: String,
    },
    RemoveEdge {
        j: usize,
    },
    Retarget {
        j: usize,
        t: usize,
    },
    Repredicate {
        j: usize,
        predicate: String,
    },
    Move {
        i: usize,
        t: usize,
    },
    MergeInto {
        i: usize,
        j: usize,
        hint: bool,
    },
    Split {
        i: usize,
        id: String,
    },
    Rekey {
        i: usize,
        id: String,
        hint: bool,
    },
    EdgeAttr {
        j: usize,
        value: Value,
    },
    EdgeLabel {
        j: usize,
        label: String,
    },
}

fn nat() -> impl Strategy<Value = usize> {
    any::<u16>().prop_map(usize::from)
}

pub fn mutation() -> impl Strategy<Value = Mutation> {
    use Mutation::*;
    prop_oneof![
        (pick(&NEW_IDS), pick(&LABEL_POOL)).prop_map(|(id, label)| AddNode { id, label }),
        nat().prop_map(|i| RemoveNode { i }),
        (nat(), pick(&LABEL_POOL)).prop_map(|(i, label)| Rename { i, label }),
        (nat(), pick(&ATTR_KEYS), attr_value()).prop_map(|(i, key, value)| SetAttr {
            i,
            key,
            value
        }),
        nat().prop_map(|i| DelAttr { i }),
        (nat(), subarray(&TYPES, 3)).prop_map(|(i, types)| SetTypes { i, types }),
        (nat(), subarray(&LABEL_POOL, 2)).prop_map(|(i, aliases)| SetAliases { i, aliases }),
        (nat(), nat()).prop_map(|(i, j)| Deprecate { i, j }),
        (nat(), nat(), pick(&PREDICATES)).prop_map(|(s, t, predicate)| AddEdge { s, t, predicate }),
        nat().prop_map(|j| RemoveEdge { j }),
        (nat(), nat()).prop_map(|(j, t)| Retarget { j, t }),
        (nat(), pick(&PREDICATES)).prop_map(|(j, predicate)| Repredicate { j, predicate }),
        (nat(), nat()).prop_map(|(i, t)| Move { i, t }),
        (nat(), nat(), any::<bool>()).prop_map(|(i, j, hint)| MergeInto { i, j, hint }),
        (nat(), pick(&NEW_IDS)).prop_map(|(i, id)| Split { i, id }),
        (nat(), pick(&NEW_IDS), any::<bool>()).prop_map(|(i, id, hint)| Rekey { i, id, hint }),
        (nat(), attr_value()).prop_map(|(j, value)| EdgeAttr { j, value }),
        (nat(), pick(&["holds", "owns", "持股"])).prop_map(|(j, label)| EdgeLabel { j, label }),
    ]
}

/// Applies an edit script to a copy of `graph` (`mutate`): indices wrap, impossible edits are
/// skipped.
pub fn mutate(graph: &GraphIn, script: &[Mutation]) -> GraphIn {
    let mut nodes = graph.nodes.clone();
    let mut edges = graph.edges.clone();
    let has_id = |nodes: &[NodeIn], id: &str| nodes.iter().any(|n| n.id == id);
    let drop_node = |nodes: &mut Vec<NodeIn>, edges: &mut Vec<EdgeIn>, id: &str| {
        if let Some(at) = nodes.iter().position(|n| n.id == id) {
            nodes.remove(at);
        }
        edges.retain(|e| e.source != id && e.target != id);
    };
    for m in script {
        let at = |len: usize, i: usize| (len > 0).then(|| i % len);
        match m {
            Mutation::AddNode { id, label } => {
                if !has_id(&nodes, id) {
                    nodes.push(NodeIn {
                        id: id.clone(),
                        label: Some(label.clone()),
                        ..NodeIn::default()
                    });
                }
            }
            Mutation::RemoveNode { i } => {
                if let Some(k) = at(nodes.len(), *i) {
                    let id = nodes[k].id.clone();
                    drop_node(&mut nodes, &mut edges, &id);
                }
            }
            Mutation::Rename { i, label } => {
                if let Some(k) = at(nodes.len(), *i) {
                    nodes[k].label = Some(label.clone());
                }
            }
            Mutation::SetAttr { i, key, value } => {
                if let Some(k) = at(nodes.len(), *i) {
                    nodes[k]
                        .attrs
                        .get_or_insert_with(Object::new)
                        .insert(key.as_str(), value.clone());
                }
            }
            Mutation::DelAttr { i } => {
                if let Some(k) = at(nodes.len(), *i)
                    && let Some(attrs) = &mut nodes[k].attrs
                {
                    let first = attrs.keys().next().cloned();
                    if let Some(first) = first {
                        attrs.remove(&first);
                    }
                }
            }
            Mutation::SetTypes { i, types } => {
                if let Some(k) = at(nodes.len(), *i) {
                    nodes[k].r#type = Some(types.clone());
                }
            }
            Mutation::SetAliases { i, aliases } => {
                if let Some(k) = at(nodes.len(), *i) {
                    nodes[k].aliases = Some(aliases.clone());
                }
            }
            Mutation::Deprecate { i, j } => {
                if let (Some(k), Some(l)) = (at(nodes.len(), *i), at(nodes.len(), *j))
                    && k != l
                {
                    let into = nodes[l].id.clone();
                    nodes[k].deprecated = Some(true);
                    nodes[k].replaced_by = Some(vec![into]);
                }
            }
            Mutation::AddEdge { s, t, predicate } => {
                if let (Some(k), Some(l)) = (at(nodes.len(), *s), at(nodes.len(), *t)) {
                    edges.push(EdgeIn {
                        source: nodes[k].id.clone(),
                        target: nodes[l].id.clone(),
                        predicate: Some(predicate.clone()),
                        ..EdgeIn::default()
                    });
                }
            }
            Mutation::RemoveEdge { j } => {
                if let Some(k) = at(edges.len(), *j) {
                    edges.remove(k);
                }
            }
            Mutation::Retarget { j, t } => {
                if let (Some(k), Some(l)) = (at(edges.len(), *j), at(nodes.len(), *t)) {
                    edges[k].target = nodes[l].id.clone();
                }
            }
            Mutation::Repredicate { j, predicate } => {
                if let Some(k) = at(edges.len(), *j) {
                    edges[k].predicate = Some(predicate.clone());
                    edges[k].label = None;
                }
            }
            Mutation::Move { i, t } => {
                if let (Some(k), Some(l)) = (at(nodes.len(), *i), at(nodes.len(), *t)) {
                    let (child, parent) = (nodes[k].id.clone(), nodes[l].id.clone());
                    edges
                        .retain(|e| !(e.source == child && e.predicate.as_deref() == Some("is_a")));
                    edges.push(EdgeIn {
                        source: child,
                        target: parent,
                        predicate: Some("is_a".to_owned()),
                        ..EdgeIn::default()
                    });
                }
            }
            Mutation::MergeInto { i, j, hint } => {
                if let (Some(k), Some(l)) = (at(nodes.len(), *i), at(nodes.len(), *j)) {
                    if k == l {
                        continue;
                    }
                    let (source, target) = (nodes[k].id.clone(), nodes[l].id.clone());
                    for e in &mut edges {
                        if e.source == source {
                            e.source = target.clone();
                        }
                        if e.target == source {
                            e.target = target.clone();
                        }
                    }
                    let label = nodes[k].label.clone().unwrap_or_else(|| source.clone());
                    nodes[l].aliases.get_or_insert_with(Vec::new).push(label);
                    if *hint {
                        nodes[l]
                            .replaces
                            .get_or_insert_with(Vec::new)
                            .push(source.clone());
                    }
                    drop_node(&mut nodes, &mut edges, &source);
                }
            }
            Mutation::Split { i, id } => {
                if let Some(k) = at(nodes.len(), *i) {
                    if has_id(&nodes, id) {
                        continue;
                    }
                    let source = nodes[k].id.clone();
                    let label = format!(
                        "{} (part)",
                        nodes[k].label.clone().unwrap_or_else(|| source.clone())
                    );
                    nodes.push(NodeIn {
                        id: id.clone(),
                        label: Some(label),
                        replaces: Some(vec![source.clone()]),
                        ..NodeIn::default()
                    });
                    for (n, e) in edges.iter_mut().enumerate() {
                        if n % 2 == 0 && e.source == source {
                            e.source = id.clone();
                        }
                    }
                }
            }
            Mutation::Rekey { i, id, hint } => {
                if let Some(k) = at(nodes.len(), *i) {
                    if has_id(&nodes, id) {
                        continue;
                    }
                    let old = std::mem::replace(&mut nodes[k].id, id.clone());
                    if *hint {
                        nodes[k]
                            .replaces
                            .get_or_insert_with(Vec::new)
                            .push(old.clone());
                    }
                    for e in &mut edges {
                        if e.source == old {
                            e.source = id.clone();
                        }
                        if e.target == old {
                            e.target = id.clone();
                        }
                    }
                }
            }
            Mutation::EdgeAttr { j, value } => {
                if let Some(k) = at(edges.len(), *j) {
                    edges[k]
                        .attrs
                        .get_or_insert_with(Object::new)
                        .insert("w", value.clone());
                }
            }
            Mutation::EdgeLabel { j, label } => {
                if let Some(k) = at(edges.len(), *j) {
                    edges[k].label = Some(label.clone());
                }
            }
        }
    }
    // Edge ids stay unique: the shuffle-determinism property requires it under `id` identity.
    let mut seen: Vec<String> = Vec::new();
    let (edge_count, node_count) = (edges.len(), nodes.len());
    for e in &mut edges {
        let Some(id) = &e.id else { continue };
        if seen.contains(id) {
            e.id = Some(format!("m{edge_count}-{}-{node_count}", script.len()));
        }
        if let Some(id) = &e.id {
            seen.push(id.clone());
        }
    }
    GraphIn { nodes, edges }
}

/// A random pair (before, after): `after` is `before` plus a random edit script
/// (`versionPairArb`).
pub fn version_pair(
    max_nodes: usize,
    max_edges: usize,
) -> impl Strategy<Value = (GraphIn, GraphIn)> {
    (
        graph(max_nodes, max_edges),
        prop::collection::vec(mutation(), 0..=8),
    )
        .prop_map(|(before, script)| {
            let after = mutate(&before, &script);
            (before, after)
        })
}

/// Deterministic Fisher–Yates shuffle driven by a seed (`shuffle`).
pub fn shuffle<T: Clone>(items: &[T], seed: u32) -> Vec<T> {
    let mut out = items.to_vec();
    let mut state = if seed == 0 { 1 } else { seed };
    for i in (1..out.len()).rev() {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let j = usize::try_from(state).unwrap_or(0) % (i + 1);
        out.swap(i, j);
    }
    out
}

/// `shuffleGraph`.
pub fn shuffle_graph(graph: &GraphIn, seed: u32) -> GraphIn {
    GraphIn {
        nodes: shuffle(&graph.nodes, seed),
        edges: shuffle(&graph.edges, seed.wrapping_mul(31).wrapping_add(7)),
    }
}
