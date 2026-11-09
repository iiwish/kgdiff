//! The union graph as the layout sees it (`union.ts`): nodes in id order, undirected neighbour
//! pairs drawn from both versions of every edge (so that neither version is favoured), and the
//! merge / split partner pairs. Built once per call in O(N + E).

use kgdiff_core::js::{JsStr, Lookup};
use kgdiff_core::model::{ChangeStatus, NodeFacet, UnionEdge, UnionNode};

/// A merge / split pair: the node that should travel little during replay and its partner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Partner {
    /// The merge source / split target.
    pub mover: usize,
    /// The merge target / split source it travels to / from.
    pub anchor: usize,
}

#[allow(
    dead_code,
    reason = "extend_layout (the next pull request) reads `index_of`"
)]
pub(crate) struct UnionGraph<'a> {
    /// Union nodes sorted by id (UTF-16 code unit order).
    pub nodes: Vec<&'a UnionNode>,
    pub index_of: Lookup<JsStr, usize>,
    /// Distinct undirected neighbour pairs (a, b) with a < b, in first-seen edge order.
    pub pairs: Vec<(usize, usize)>,
    /// CSR adjacency over `pairs`: the neighbours of i are
    /// `adjacency[offsets[i]..offsets[i + 1]]`, ascending.
    pub offsets: Vec<usize>,
    pub adjacency: Vec<usize>,
    pub partners: Vec<Partner>,
    /// True for changed nodes and for the endpoints (either version) of changed edges.
    pub changed: Vec<bool>,
}

impl UnionGraph<'_> {
    pub(crate) fn neighbours(&self, i: usize) -> &[usize] {
        &self.adjacency[self.offsets[i]..self.offsets[i + 1]]
    }
}

/// CSR adjacency with ascending neighbour lists from undirected pairs.
pub(crate) fn build_adjacency(n: usize, pairs: &[(usize, usize)]) -> (Vec<usize>, Vec<usize>) {
    let mut offsets = vec![0; n + 1];
    for &(a, b) in pairs {
        offsets[a + 1] += 1;
        offsets[b + 1] += 1;
    }
    for i in 0..n {
        offsets[i + 1] += offsets[i];
    }
    let mut fill = offsets[..n].to_vec();
    let mut adjacency = vec![0; 2 * pairs.len()];
    for &(a, b) in pairs {
        adjacency[fill[a]] = b;
        fill[a] += 1;
        adjacency[fill[b]] = a;
        fill[b] += 1;
    }
    for i in 0..n {
        adjacency[offsets[i]..offsets[i + 1]].sort();
    }
    (offsets, adjacency)
}

/// `items` in id order: as given when already sorted (union nodes and edges of a diff are), else
/// sorted by id.
fn sorted_by_id<T>(items: &[T], id: impl Fn(&T) -> &JsStr) -> Vec<&T> {
    let mut out: Vec<&T> = items.iter().collect();
    if out.windows(2).any(|w| id(w[0]) > id(w[1])) {
        out.sort_by(|a, b| id(a).cmp(id(b)));
    }
    out
}

pub(crate) fn build_union_graph<'a>(nodes: &'a [UnionNode], edges: &[UnionEdge]) -> UnionGraph<'a> {
    let nodes = sorted_by_id(nodes, |n| &n.id);
    let n = nodes.len();
    let mut index_of = Lookup::with_capacity(n);
    for (i, node) in nodes.iter().enumerate() {
        index_of.insert(node.id.clone(), i);
    }
    let lookup = |id: &JsStr| index_of.get(id.as_str()).copied();

    let mut changed: Vec<bool> = nodes
        .iter()
        .map(|node| node.status != ChangeStatus::Unchanged)
        .collect();

    let mut seen: Lookup<u64, ()> = Lookup::new();
    let mut pairs = Vec::new();
    let n64 = n as u64;
    let mut add_pair = |a: Option<usize>, b: Option<usize>| {
        let (Some(a), Some(b)) = (a, b) else { return };
        if a == b {
            return;
        }
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let key = lo as u64 * n64 + hi as u64;
        if seen.contains_key(&key) {
            return;
        }
        seen.insert(key, ());
        pairs.push((lo, hi));
    };

    for edge in sorted_by_id(edges, |e| &e.id) {
        let s = lookup(&edge.source);
        let t = lookup(&edge.target);
        add_pair(s, t);
        let sb = edge.source_before.as_ref().map_or(s, lookup);
        let tb = edge.target_before.as_ref().map_or(t, lookup);
        if sb != s || tb != t {
            add_pair(sb, tb);
        }
        if edge.status != ChangeStatus::Unchanged {
            for end in [s, t, sb, tb].into_iter().flatten() {
                changed[end] = true;
            }
        }
    }

    let (offsets, adjacency) = build_adjacency(n, &pairs);

    let mut partners = Vec::new();
    let mut partner_keys: Lookup<u64, ()> = Lookup::new();
    let mut add_partner = |mover: Option<usize>, anchor: Option<usize>| {
        let (Some(mover), Some(anchor)) = (mover, anchor) else {
            return;
        };
        if mover == anchor {
            return;
        }
        let key = mover as u64 * n64 + anchor as u64;
        if partner_keys.contains_key(&key) {
            return;
        }
        partner_keys.insert(key, ());
        partners.push(Partner { mover, anchor });
    };
    for (i, node) in nodes.iter().enumerate() {
        for facet in &node.facets {
            match facet {
                NodeFacet::MergedInto { target, .. } => add_partner(Some(i), lookup(target)),
                NodeFacet::SplitFrom { source, .. } => add_partner(Some(i), lookup(source)),
                NodeFacet::MergeTarget { sources } => {
                    for source in sources {
                        add_partner(lookup(source), Some(i));
                    }
                }
                NodeFacet::SplitInto { targets } => {
                    for target in targets {
                        add_partner(lookup(target), Some(i));
                    }
                }
                _ => {}
            }
        }
    }
    partners.sort_by(|a, b| a.mover.cmp(&b.mover).then(a.anchor.cmp(&b.anchor)));

    UnionGraph {
        nodes,
        index_of,
        pairs,
        offsets,
        adjacency,
        partners,
        changed,
    }
}
