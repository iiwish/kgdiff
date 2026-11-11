//! Diff statistics (`stats.ts`, docs/algorithms.md §9).

use crate::js::IndexMap;

use crate::js::JsStr;
use crate::model::{
    ChangeStatus, CountDelta, DiffStats, FacetKind, Hunk, KGraph, TypeStat, UnionEdge, UnionNode,
};

fn count_facets(kinds: &mut dyn Iterator<Item = FacetKind>, facets: &mut [usize; 16]) {
    let mut seen = [false; 16];
    for kind in kinds {
        if !seen[kind.index()] {
            seen[kind.index()] = true;
            facets[kind.index()] += 1;
        }
    }
}

/// `computeStats`: counts by status, facet kind, hunk kind and node type.
pub(crate) fn compute_stats(
    before: &KGraph,
    after: &KGraph,
    nodes: &[UnionNode],
    edges: &[(ChangeStatus, Vec<FacetKind>)],
    hunks: &[Hunk],
) -> DiffStats {
    let node_kinds: Vec<Vec<FacetKind>> = nodes
        .iter()
        .map(|n| n.facets.iter().map(|f| f.kind()).collect())
        .collect();
    compute_stats_with(before, after, nodes, &node_kinds, edges, hunks)
}

/// [`compute_stats`] with the facet kinds of the nodes given apart (`node_kinds[i]` for
/// `nodes[i]`), for diffs read from JSON before their facets are typed.
pub(crate) fn compute_stats_with(
    before: &KGraph,
    after: &KGraph,
    nodes: &[UnionNode],
    node_kinds: &[Vec<FacetKind>],
    edges: &[(ChangeStatus, Vec<FacetKind>)],
    hunks: &[Hunk],
) -> DiffStats {
    let mut node_counts = CountDelta::default();
    let mut edge_counts = CountDelta::default();
    let mut facets = [0usize; 16];
    let mut by_type: IndexMap<JsStr, CountDelta> = IndexMap::default();
    for (n, kinds) in nodes.iter().zip(node_kinds) {
        node_counts.add(n.status);
        count_facets(&mut kinds.iter().copied(), &mut facets);
        let ty = n
            .after
            .as_ref()
            .or(n.before.as_ref())
            .and_then(|v| v.types.first())
            .cloned()
            .unwrap_or_default();
        by_type.entry(ty).or_default().add(n.status);
    }
    for (status, kinds) in edges {
        edge_counts.add(*status);
        count_facets(&mut kinds.iter().copied(), &mut facets);
    }
    let mut hunk_counts = [0usize; 6];
    for h in hunks {
        hunk_counts[h.kind.index()] += 1;
    }
    let mut types: Vec<TypeStat> = by_type
        .into_iter()
        .map(|(r#type, counts)| TypeStat { r#type, counts })
        .collect();
    types.sort_by(|a, b| {
        b.counts
            .changes()
            .cmp(&a.counts.changes())
            .then_with(|| a.r#type.cmp(&b.r#type))
    });
    DiffStats {
        identical: node_counts.changes() + edge_counts.changes() == 0,
        nodes: node_counts,
        edges: edge_counts,
        before: (before.node_count(), before.edge_count()),
        after: (after.node_count(), after.edge_count()),
        facets,
        hunks: hunk_counts,
        by_type: types,
    }
}

/// The edge statuses and facet kinds `compute_stats` counts.
pub(crate) fn edge_kinds(edges: &[UnionEdge]) -> Vec<(ChangeStatus, Vec<FacetKind>)> {
    edges
        .iter()
        .map(|e| (e.status, e.facets.iter().map(|f| f.kind()).collect()))
        .collect()
}
