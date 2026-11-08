//! O(1) lookups over a diff result (`DiffIndex`, `diff-index.ts`).

use indexmap::IndexSet;

use crate::js::{JsStr, Lookup};
use crate::model::{Hunk, UnionEdge, UnionId, UnionNode};

/// Positions of union nodes, edges and hunks by id, and the edges incident to each node.
#[derive(Clone, Debug, Default)]
pub struct DiffIndex {
    node: Lookup<UnionId, usize>,
    by_before: Lookup<JsStr, usize>,
    by_after: Lookup<JsStr, usize>,
    edge: Lookup<UnionId, usize>,
    hunk: Lookup<JsStr, usize>,
    incident: Lookup<UnionId, Vec<usize>>,
}

impl DiffIndex {
    pub(crate) fn new(nodes: &[UnionNode], edges: &[UnionEdge], hunks: &[Hunk]) -> DiffIndex {
        let mut index = DiffIndex::default();
        for (i, n) in nodes.iter().enumerate() {
            index.node.insert(n.id.clone(), i);
            if let Some(id) = &n.before_id {
                index.by_before.insert(id.clone(), i);
            }
            if let Some(id) = &n.after_id {
                index.by_after.insert(id.clone(), i);
            }
        }
        for (i, e) in edges.iter().enumerate() {
            index.edge.insert(e.id.clone(), i);
            let mut ends: IndexSet<&UnionId> = IndexSet::new();
            ends.insert(&e.source);
            ends.insert(&e.target);
            ends.extend(e.source_before.iter());
            ends.extend(e.target_before.iter());
            // Edges are sorted by id, so every list comes out sorted too.
            for u in ends {
                index
                    .incident
                    .get_or_insert_with(u.clone(), Vec::new)
                    .push(i);
            }
        }
        for (i, h) in hunks.iter().enumerate() {
            index.hunk.insert(h.id.clone(), i);
        }
        index
    }

    pub fn node(&self, id: &str) -> Option<usize> {
        self.node.get(id).copied()
    }
    pub fn node_by_before(&self, id: &str) -> Option<usize> {
        self.by_before.get(id).copied()
    }
    pub fn node_by_after(&self, id: &str) -> Option<usize> {
        self.by_after.get(id).copied()
    }
    pub fn edge(&self, id: &str) -> Option<usize> {
        self.edge.get(id).copied()
    }
    pub fn hunk(&self, id: &str) -> Option<usize> {
        self.hunk.get(id).copied()
    }
    /// Incident union edges (both directions, before-version ends included), sorted by id.
    pub fn edges_of(&self, id: &str) -> &[usize] {
        self.incident.get(id).map_or(&[], Vec::as_slice)
    }
}
