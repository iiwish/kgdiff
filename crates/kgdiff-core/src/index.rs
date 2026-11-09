//! O(1) lookups over a diff result (`DiffIndex`, `diff-index.ts`). Each table is built on first
//! use, so a diff whose consumer never looks anything up pays nothing for it.

use std::sync::OnceLock;

use crate::js::{IndexSet, JsStr, Lookup};
use crate::model::{Hunk, UnionEdge, UnionId, UnionNode};

#[derive(Clone, Debug, Default)]
struct NodeTables {
    by_id: Lookup<UnionId, usize>,
    by_before: Lookup<JsStr, usize>,
    by_after: Lookup<JsStr, usize>,
}

#[derive(Clone, Debug, Default)]
struct EdgeTables {
    by_id: Lookup<UnionId, usize>,
    incident: Lookup<UnionId, Vec<usize>>,
}

/// Positions of union nodes, edges and hunks by id, and the edges incident to each node, built
/// lazily from the slices of a [`DiffResult`](crate::DiffResult).
#[derive(Clone, Debug, Default)]
pub(crate) struct DiffIndex {
    nodes: OnceLock<NodeTables>,
    edges: OnceLock<EdgeTables>,
    hunks: OnceLock<Lookup<JsStr, usize>>,
}

impl DiffIndex {
    fn nodes(&self, nodes: &[UnionNode]) -> &NodeTables {
        self.nodes.get_or_init(|| {
            let mut tables = NodeTables::default();
            for (i, n) in nodes.iter().enumerate() {
                tables.by_id.insert(n.id.clone(), i);
                if let Some(id) = &n.before_id {
                    tables.by_before.insert(id.clone(), i);
                }
                if let Some(id) = &n.after_id {
                    tables.by_after.insert(id.clone(), i);
                }
            }
            tables
        })
    }

    fn edges(&self, edges: &[UnionEdge]) -> &EdgeTables {
        self.edges.get_or_init(|| {
            let mut tables = EdgeTables::default();
            for (i, e) in edges.iter().enumerate() {
                tables.by_id.insert(e.id.clone(), i);
                let mut ends: IndexSet<&UnionId> = IndexSet::default();
                ends.insert(&e.source);
                ends.insert(&e.target);
                ends.extend(e.source_before.iter());
                ends.extend(e.target_before.iter());
                // Edges are sorted by id, so every list comes out sorted too.
                for u in ends {
                    tables
                        .incident
                        .get_or_insert_with(u.clone(), Vec::new)
                        .push(i);
                }
            }
            tables
        })
    }

    pub(crate) fn node(&self, nodes: &[UnionNode], id: &str) -> Option<usize> {
        self.nodes(nodes).by_id.get(id).copied()
    }

    pub(crate) fn node_by_before(&self, nodes: &[UnionNode], id: &str) -> Option<usize> {
        self.nodes(nodes).by_before.get(id).copied()
    }

    pub(crate) fn node_by_after(&self, nodes: &[UnionNode], id: &str) -> Option<usize> {
        self.nodes(nodes).by_after.get(id).copied()
    }

    pub(crate) fn edge(&self, edges: &[UnionEdge], id: &str) -> Option<usize> {
        self.edges(edges).by_id.get(id).copied()
    }

    pub(crate) fn hunk(&self, hunks: &[Hunk], id: &str) -> Option<usize> {
        self.hunks
            .get_or_init(|| {
                let mut table = Lookup::new();
                for (i, h) in hunks.iter().enumerate() {
                    table.insert(h.id.clone(), i);
                }
                table
            })
            .get(id)
            .copied()
    }

    /// Incident union edges (both directions, before-version ends included), sorted by id.
    pub(crate) fn edges_of<'a>(&'a self, edges: &[UnionEdge], id: &str) -> &'a [usize] {
        self.edges(edges)
            .incident
            .get(id)
            .map_or(&[], Vec::as_slice)
    }
}
