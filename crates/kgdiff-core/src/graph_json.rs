//! Compact JSON forms of nodes, edges and graphs, and the graph content hash (`graph-json.ts`).

use crate::canonical::{Cyrb53, attrs_equal, canonical_attrs};
use crate::js::{JsStr, Object, Value};
use crate::model::{EdgeIdentity, EdgeRef, KGEdge, KGNode, KGraph};
use crate::text::raw_predicate_label;

fn strings(list: &[JsStr]) -> Value {
    Value::Array(list.iter().map(Value::from).collect())
}

/// Compact, canonical JSON of a node (`nodeToJSON`): defaults omitted, attribute keys sorted;
/// `id` replaces the node's own id when given.
pub fn node_to_json(node: &KGNode, id: Option<&JsStr>) -> Object {
    let id = id.unwrap_or(&node.id);
    let mut out = Object::new();
    out.insert("id", id);
    if node.label != *id {
        out.insert("label", &node.label);
    }
    if !node.types.is_empty() {
        out.insert("types", strings(&node.types));
    }
    if !node.aliases().is_empty() {
        out.insert("aliases", strings(node.aliases()));
    }
    if !node.attrs.is_empty() {
        out.insert("attrs", canonical_attrs(&node.attrs));
    }
    if node.deprecated {
        out.insert("deprecated", true);
    }
    if !node.replaces().is_empty() {
        out.insert("replaces", strings(node.replaces()));
    }
    if !node.replaced_by().is_empty() {
        out.insert("replacedBy", strings(node.replaced_by()));
    }
    if node.implicit {
        out.insert("implicit", true);
    }
    out
}

/// Compact, canonical JSON of an edge, endpoints optionally mapped to other ids (`edgeToJSON`).
/// The label is left out when it is `rawPredicateLabel(predicate)`.
pub fn edge_to_json(edge: &KGEdge, source: Option<&JsStr>, target: Option<&JsStr>) -> Object {
    let mut out = Object::new();
    if let Some(id) = &edge.id {
        out.insert("id", id);
    }
    out.insert("source", source.unwrap_or(&edge.source));
    out.insert("target", target.unwrap_or(&edge.target));
    if !edge.predicate.is_empty() {
        out.insert("predicate", &edge.predicate);
    }
    if edge.label != raw_predicate_label(&edge.predicate) {
        out.insert("label", &edge.label);
    }
    if !edge.attrs.is_empty() {
        out.insert("attrs", canonical_attrs(&edge.attrs));
    }
    out
}

/// Canonical JSON form of a graph (`graphToJSON`): the `kgdiff.graph` version 1 marker, `meta`
/// when it has members, nodes sorted by id, edges by key.
pub fn graph_to_json(graph: &KGraph) -> Value {
    let mut nodes: Vec<&KGNode> = graph.nodes.values().map(AsRef::as_ref).collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut edges: Vec<KGEdge> = graph.edges().map(|e| e.to_edge()).collect();
    edges.sort_by(|a, b| a.key.cmp(&b.key));
    let mut out = Object::new();
    out.insert("format", "kgdiff.graph");
    out.insert("version", 1.0);
    if !graph.meta().is_empty() {
        out.insert("meta", graph.meta().clone());
    }
    out.insert(
        "nodes",
        Value::Array(
            nodes
                .into_iter()
                .map(|n| Value::Object(node_to_json(n, None)))
                .collect(),
        ),
    );
    out.insert(
        "edges",
        Value::Array(
            edges
                .iter()
                .map(|e| Value::Object(edge_to_json(e, None, None)))
                .collect(),
        ),
    );
    Value::Object(out)
}

/// Equality of node content: everything but id, position and `implicit` (`nodeContentEquals`).
pub fn node_content_equals(a: &KGNode, b: &KGNode) -> bool {
    a.label == b.label
        && a.deprecated == b.deprecated
        && a.types == b.types
        && a.aliases() == b.aliases()
        && a.replaces() == b.replaces()
        && a.replaced_by() == b.replaced_by()
        && attrs_equal(&a.attrs, &b.attrs, None)
}

fn feed_strings(h: &mut Cyrb53, list: &[JsStr]) {
    h.code(u32::try_from(list.len()).unwrap_or(u32::MAX));
    for item in list {
        h.string(item);
    }
}

fn feed_node(h: &mut Cyrb53, node: &KGNode) {
    h.code(0x4e).string(&node.id).string(&node.label); // N
    feed_strings(h, &node.types);
    feed_strings(h, node.aliases());
    h.attrs(&node.attrs).code(u32::from(node.deprecated));
    feed_strings(h, node.replaces());
    feed_strings(h, node.replaced_by());
}

fn feed_edge(h: &mut Cyrb53, edge: EdgeRef<'_>, with_id: bool) {
    h.code(0x45); // E
    match (edge.id(), with_id) {
        (Some(id), true) => h.code(1).string(id),
        _ => h.code(0),
    };
    h.string(edge.source())
        .string(edge.predicate())
        .string(edge.target())
        .string(edge.label());
    h.attrs(edge.attrs());
}

/// Stable content hash of a normalized graph, `c53:` + 14 hex digits (`hashGraph`): node and
/// edge content (the edge id under `id` identity), not positions, meta, `implicit` or any order.
/// Per-element cyrb53 digests are summed (an order-independent multiset hash) and the sums
/// hashed once more. Computed once per graph.
pub fn hash_graph(graph: &KGraph) -> &str {
    graph.hash.get_or_init(|| {
        let mut h = Cyrb53::default();
        let (mut n1, mut n2) = (0u32, 0u32);
        for node in graph.nodes.values() {
            feed_node(h.reset(), node);
            let (a, b) = h.digest_pair();
            n1 = n1.wrapping_add(a);
            n2 = n2.wrapping_add(b);
        }
        let with_ids = graph.edge_identity() == EdgeIdentity::Id;
        let (mut e1, mut e2) = (0u32, 0u32);
        for edge in graph.edges() {
            feed_edge(h.reset(), edge, with_ids);
            let (a, b) = h.digest_pair();
            e1 = e1.wrapping_add(a);
            e2 = e2.wrapping_add(b);
        }
        let summary = format!(
            "kgdiff.graph.v1|{}|{n1}|{n2}|{}|{e1}|{e2}",
            graph.node_count(),
            graph.edge_count()
        );
        let digest = Cyrb53::default().update(&summary).digest();
        format!("c53:{digest:014x}")
    })
}
