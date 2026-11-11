//! The union graph as the layout sees it (`union.ts`): nodes in id order, undirected neighbour
//! pairs drawn from both versions of every edge (so that neither version is favoured), and the
//! merge / split partner pairs. Built once per call in O(N + E).

use kgdiff_core::js::{JsStr, Lookup};

use crate::table::{LayoutTable, TableNode};

/// A merge / split pair: the node that should travel little during replay and its partner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Partner {
    /// The merge source / split target.
    pub mover: usize,
    /// The merge target / split source it travels to / from.
    pub anchor: usize,
}

pub(crate) struct UnionGraph<'a> {
    /// Union nodes sorted by id (UTF-16 code unit order).
    pub nodes: &'a [TableNode],
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

pub(crate) fn build_union_graph(table: &LayoutTable) -> UnionGraph<'_> {
    let nodes = &table.nodes[..];
    let n = nodes.len();
    let mut index_of = Lookup::with_capacity(n);
    for (i, node) in nodes.iter().enumerate() {
        index_of.insert(node.id.clone(), i);
    }

    let mut changed: Vec<bool> = nodes.iter().map(|node| node.changed).collect();

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

    for edge in &table.edges {
        let (s, t) = (edge.source, edge.target);
        add_pair(s, t);
        let (sb, tb) = (edge.source_before, edge.target_before);
        if sb != s || tb != t {
            add_pair(sb, tb);
        }
        if edge.changed {
            for end in [s, t, sb, tb].into_iter().flatten() {
                changed[end] = true;
            }
        }
    }

    let (offsets, adjacency) = build_adjacency(n, &pairs);

    let mut partners = Vec::new();
    let mut partner_keys: Lookup<u64, ()> = Lookup::new();
    for &(mover, anchor) in &table.partners {
        if mover == anchor {
            continue;
        }
        let key = mover as u64 * n64 + anchor as u64;
        if partner_keys.contains_key(&key) {
            continue;
        }
        partner_keys.insert(key, ());
        partners.push(Partner { mover, anchor });
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
