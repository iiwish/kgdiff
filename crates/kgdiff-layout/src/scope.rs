//! The layout scope: which union nodes get a position (`scope.ts`).

use kgdiff_core::model::UnionId;

use crate::LayoutScope;
use crate::union::UnionGraph;

pub(crate) struct ScopeSelection {
    /// True for the nodes that get a position, by union index.
    pub visible: Vec<bool>,
    /// Visible node → number of neighbours left out (only entries > 0), in id order.
    pub hidden: Vec<(UnionId, usize)>,
}

/// - `all`: every node.
/// - `changes`: changed nodes (distance 0); the unchanged endpoints of changed edges in either
///   version (distance 1, so that a relation-only change between two unchanged nodes stays
///   readable); and the nodes within `context_hops` of a changed node, by a multi-source BFS
///   that never expands from a hub (max degree over both versions > `hub_degree`): a hub is
///   visible when reached, but neighbours that could only be reached through it stay out and are
///   counted in `hidden`.
pub(crate) fn select_scope(
    graph: &UnionGraph<'_>,
    scope: LayoutScope,
    context_hops: usize,
    hub_degree: f64,
) -> ScopeSelection {
    let n = graph.nodes.len();
    if scope == LayoutScope::All {
        return ScopeSelection {
            visible: vec![true; n],
            hidden: Vec::new(),
        };
    }

    let mut distance: Vec<Option<usize>> = vec![None; n];
    let mut frontier = Vec::new();
    for (i, node) in graph.nodes.iter().enumerate() {
        if node.changed {
            distance[i] = Some(0);
            frontier.push(i);
        }
    }
    let mut touched = Vec::new();
    for (i, d) in distance.iter_mut().enumerate() {
        if graph.changed[i] && d.is_none() {
            *d = Some(1);
            touched.push(i);
        }
    }
    for hop in 0..context_hops {
        // Nothing left to expand: the remaining hops change nothing (TypeScript runs them).
        if frontier.is_empty() && hop > 0 {
            break;
        }
        let mut next = if hop == 0 {
            touched.clone()
        } else {
            Vec::new()
        };
        for &u in &frontier {
            if graph.nodes[u].degree as f64 > hub_degree {
                continue;
            }
            for &v in graph.neighbours(u) {
                if distance[v].is_none() {
                    distance[v] = Some(hop + 1);
                    next.push(v);
                }
            }
        }
        next.sort();
        frontier = next;
    }
    let visible: Vec<bool> = distance.iter().map(Option::is_some).collect();
    let hidden = count_hidden(graph, &visible);
    ScopeSelection { visible, hidden }
}

/// For every visible node, the number of distinct neighbours that are not visible.
pub(crate) fn count_hidden(graph: &UnionGraph<'_>, visible: &[bool]) -> Vec<(UnionId, usize)> {
    let mut hidden = Vec::new();
    for (u, node) in graph.nodes.iter().enumerate() {
        if !visible[u] {
            continue;
        }
        let count = graph.neighbours(u).iter().filter(|&&v| !visible[v]).count();
        if count > 0 {
            hidden.push((node.id.clone(), count));
        }
    }
    hidden
}
