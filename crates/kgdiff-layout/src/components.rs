//! Connected components over links and merge / split partners (`components.ts`): a merge
//! source with no edges of its own still belongs next to its target.

use crate::graph::LayoutGraph;

fn find(parent: &mut [usize], i: usize) -> usize {
    let mut root = i;
    while parent[root] != root {
        root = parent[root];
    }
    let mut cur = i;
    while parent[cur] != root {
        let next = parent[cur];
        parent[cur] = root;
        cur = next;
    }
    root
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let ra = find(parent, a);
    let rb = find(parent, b);
    // The smaller index becomes the root: the result does not depend on edge order.
    if ra < rb {
        parent[rb] = ra;
    } else if rb < ra {
        parent[ra] = rb;
    }
}

/// Components as ascending index lists, largest first (ties: smallest first index, i.e. id
/// order). `members` restricts the computation to a subset (the others are ignored).
pub(crate) fn connected_components(
    graph: &LayoutGraph<'_>,
    members: Option<&[bool]>,
) -> Vec<Vec<usize>> {
    let n = graph.n;
    let mut parent: Vec<usize> = (0..n).collect();
    let in_set = |i: usize| members.is_none_or(|m| m[i]);
    for &(a, b) in &graph.pairs {
        if in_set(a) && in_set(b) {
            union(&mut parent, a, b);
        }
    }
    for p in &graph.partners {
        if in_set(p.mover) && in_set(p.anchor) {
            union(&mut parent, p.mover, p.anchor);
        }
    }
    // Lists by root; a root is the smallest index of its component, so it comes first.
    let mut slot = vec![usize::MAX; n];
    let mut lists: Vec<Vec<usize>> = Vec::new();
    for i in 0..n {
        if !in_set(i) {
            continue;
        }
        let root = find(&mut parent, i);
        if slot[root] == usize::MAX {
            slot[root] = lists.len();
            lists.push(Vec::new());
        }
        lists[slot[root]].push(i);
    }
    lists.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].cmp(&b[0])));
    lists
}
