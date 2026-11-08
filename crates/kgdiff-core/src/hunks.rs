//! Hunks (`hunks.ts`, docs/algorithms.md §7): a partition of the changed union elements into
//! review units. Seeding order, first claim wins: merge → split → add → remove → modify →
//! relations.

use indexmap::{IndexMap, IndexSet};

use crate::js::{JsStr, Lookup};
use crate::model::{
    ChangeStatus, CountTriplet, FacetKind, HunkKind, HunkSummary, Id, KGraph, NodeFacet,
    ReplayPhase, UnionEdge, UnionId, UnionNode,
};
use crate::pipeline::Ctx;

/// A hunk before the delta exists: no ops, no dependencies, no order (`HunkWithoutOps`).
#[derive(Clone, Debug)]
pub(crate) struct HunkDraft {
    pub id: JsStr,
    pub kind: HunkKind,
    pub phase: ReplayPhase,
    pub anchor: UnionId,
    pub nodes: Vec<UnionId>,
    pub edges: Vec<UnionId>,
    pub context: Vec<UnionId>,
    pub summary: HunkSummary,
}

/// A hunk while it is being seeded.
struct Draft {
    kind: HunkKind,
    anchor: UnionId,
    nodes: Vec<UnionId>,
    edges: Vec<UnionId>,
}

fn endpoints(e: &UnionEdge) -> Vec<UnionId> {
    let mut ids = vec![e.source.clone()];
    if e.target != e.source {
        ids.push(e.target.clone());
    }
    for extra in [&e.source_before, &e.target_before].into_iter().flatten() {
        if !ids.contains(extra) {
            ids.push(extra.clone());
        }
    }
    ids
}

/// Neighbours of a union node in either version, as union ids.
fn neighbors(ctx: &Ctx<'_>, node: &UnionNode) -> Vec<UnionId> {
    let mut out = Vec::new();
    let mut visit = |graph: &KGraph, id: &Id, to_union: &dyn Fn(&Id) -> UnionId| {
        for key in graph.outgoing.get(id).into_iter().flatten() {
            if let Some(e) = graph.edges.get(key) {
                out.push(to_union(&e.target));
            }
        }
        for key in graph.incoming.get(id).into_iter().flatten() {
            if let Some(e) = graph.edges.get(key) {
                out.push(to_union(&e.source));
            }
        }
    };
    if let Some(id) = &node.before_id {
        visit(ctx.before, id, &|id| ctx.union_of_before(id));
    }
    if let Some(id) = &node.after_id {
        visit(ctx.after, id, &|id| id.clone());
    }
    out
}

/// Union-find over union ids whose roots are the smallest ids.
#[derive(Default)]
struct UnionFind {
    parent: Lookup<UnionId, UnionId>,
}

impl UnionFind {
    fn find(&mut self, x: &UnionId) -> UnionId {
        let mut root = x.clone();
        while let Some(p) = self.parent.get(&root) {
            if *p == root {
                break;
            }
            root = p.clone();
        }
        // Path compression.
        let mut cur = x.clone();
        while cur != root {
            let next = self
                .parent
                .get(&cur)
                .cloned()
                .unwrap_or_else(|| root.clone());
            self.parent.insert(cur, root.clone());
            cur = next;
        }
        root
    }

    fn union(&mut self, a: &UnionId, b: &UnionId) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra < rb {
            self.parent.insert(rb, ra);
        } else if rb < ra {
            self.parent.insert(ra, rb);
        }
    }
}

/// Partitions the changed elements into hunks, sets `hunk` on every changed node and edge, and
/// computes context, phase and summary (`buildHunks`). Dependencies and order come later.
pub(crate) fn build_hunks(
    ctx: &Ctx<'_>,
    nodes: &mut [UnionNode],
    edges: &mut [UnionEdge],
) -> Vec<HunkDraft> {
    let node_at: Lookup<UnionId, usize> =
        nodes
            .iter()
            .enumerate()
            .fold(Lookup::new(), |mut m, (i, n)| {
                m.insert(n.id.clone(), i);
                m
            });
    let mut edge_at: IndexMap<UnionId, usize> = IndexMap::new();
    let mut changed_edges_of: Lookup<UnionId, Vec<usize>> = Lookup::new();
    for (i, e) in edges.iter().enumerate() {
        if e.status == ChangeStatus::Unchanged {
            continue;
        }
        edge_at.insert(e.id.clone(), i);
        for u in endpoints(e) {
            changed_edges_of.get_or_insert_with(u, Vec::new).push(i);
        }
    }

    let mut drafts: Vec<Draft> = Vec::new();
    let mut node_owner: Lookup<UnionId, usize> = Lookup::new();
    let mut edge_owner: Lookup<UnionId, usize> = Lookup::new();
    let open = |drafts: &mut Vec<Draft>, kind: HunkKind, anchor: UnionId| {
        drafts.push(Draft {
            kind,
            anchor,
            nodes: Vec::new(),
            edges: Vec::new(),
        });
        drafts.len() - 1
    };
    let claim_node = |drafts: &mut Vec<Draft>,
                      node_owner: &mut Lookup<UnionId, usize>,
                      d: usize,
                      id: &UnionId| {
        let Some(&i) = node_at.get(id) else { return };
        if nodes[i].status == ChangeStatus::Unchanged || node_owner.contains_key(id) {
            return;
        }
        node_owner.insert(id.clone(), d);
        drafts[d].nodes.push(id.clone());
    };
    let claim_incident = |drafts: &mut Vec<Draft>,
                          edge_owner: &mut Lookup<UnionId, usize>,
                          d: usize,
                          id: &UnionId,
                          accept: &dyn Fn(&UnionEdge) -> bool| {
        for &i in changed_edges_of.get(id).into_iter().flatten() {
            let e = &edges[i];
            if !accept(e) || edge_owner.contains_key(&e.id) {
                continue;
            }
            edge_owner.insert(e.id.clone(), d);
            drafts[d].edges.push(e.id.clone());
        }
    };
    let any = |_: &UnionEdge| true;

    // 1. Merges: sources, target, carried / collapsed edges, every changed edge of a source.
    for group in &ctx.restructuring.merges {
        let d = open(&mut drafts, HunkKind::Merge, group.target.clone());
        let sources: Vec<UnionId> = group
            .sources
            .iter()
            .map(|s| ctx.union_of_before(&s.id))
            .collect();
        claim_node(&mut drafts, &mut node_owner, d, &group.target);
        for s in &sources {
            claim_node(&mut drafts, &mut node_owner, d, s);
        }
        for s in &sources {
            claim_incident(&mut drafts, &mut edge_owner, d, s, &any);
        }
        if node_at
            .get(&group.target)
            .is_some_and(|&i| nodes[i].status == ChangeStatus::Added)
        {
            claim_incident(&mut drafts, &mut edge_owner, d, &group.target, &any);
        }
    }
    // 2. Splits: source, new targets, carried edges and every other changed edge of either.
    for group in &ctx.restructuring.splits {
        let source = ctx.union_of_before(&group.source);
        // A merge target that also splits is one restructuring: it extends the merge hunk.
        let d = match node_owner.get(&source) {
            Some(&d) => d,
            None => open(&mut drafts, HunkKind::Split, source.clone()),
        };
        claim_node(&mut drafts, &mut node_owner, d, &source);
        for t in &group.targets {
            claim_node(&mut drafts, &mut node_owner, d, &t.id);
        }
        for t in &group.targets {
            claim_incident(&mut drafts, &mut edge_owner, d, &t.id, &any);
        }
        claim_incident(&mut drafts, &mut edge_owner, d, &source, &any);
    }
    // 3–4. Connected groups of added / removed nodes and their added / removed edges.
    for status in [ChangeStatus::Added, ChangeStatus::Removed] {
        let free: Vec<usize> = (0..nodes.len())
            .filter(|&i| nodes[i].status == status && !node_owner.contains_key(&nodes[i].id))
            .collect();
        if free.is_empty() {
            continue;
        }
        let in_group: Lookup<UnionId, ()> = free.iter().fold(Lookup::new(), |mut set, &i| {
            set.insert(nodes[i].id.clone(), ());
            set
        });
        let mut uf = UnionFind::default();
        for &i in edge_at.values() {
            let e = &edges[i];
            if e.status == status
                && in_group.contains_key(&e.source)
                && in_group.contains_key(&e.target)
            {
                uf.union(&e.source, &e.target);
            }
        }
        let mut components: IndexMap<UnionId, Vec<usize>> = IndexMap::new();
        for &i in &free {
            let root = uf.find(&nodes[i].id);
            components.entry(root).or_default().push(i);
        }
        let added = status == ChangeStatus::Added;
        let graph = if added { ctx.after } else { ctx.before };
        let mut roots: Vec<&UnionId> = components.keys().collect();
        roots.sort();
        for root in roots {
            let members = &components[root];
            let mut anchor = members[0];
            let mut best: Option<usize> = None;
            for &i in members {
                let n = &nodes[i];
                let deg = graph.degree(if added {
                    n.after_id.as_deref()
                } else {
                    n.before_id.as_deref()
                });
                if best.is_none_or(|b| deg > b) || (Some(deg) == best && n.id < nodes[anchor].id) {
                    best = Some(deg);
                    anchor = i;
                }
            }
            let d = open(
                &mut drafts,
                if added {
                    HunkKind::Add
                } else {
                    HunkKind::Remove
                },
                nodes[anchor].id.clone(),
            );
            for &i in members {
                claim_node(&mut drafts, &mut node_owner, d, &nodes[i].id);
            }
            for &i in members {
                let id = nodes[i].id.clone();
                claim_incident(&mut drafts, &mut edge_owner, d, &id, &|e| {
                    e.status == status
                });
            }
        }
    }
    // 5. Modified nodes with their outgoing edge changes (subject-centric).
    for n in nodes.iter() {
        if n.status != ChangeStatus::Modified || node_owner.contains_key(&n.id) {
            continue;
        }
        let id = n.id.clone();
        let d = open(&mut drafts, HunkKind::Modify, id.clone());
        claim_node(&mut drafts, &mut node_owner, d, &id);
        claim_incident(&mut drafts, &mut edge_owner, d, &id, &|e| e.source == id);
    }
    // 6. Remaining edge changes, grouped by source node.
    let mut by_source: IndexMap<UnionId, Vec<usize>> = IndexMap::new();
    for &i in edge_at.values() {
        if !edge_owner.contains_key(&edges[i].id) {
            by_source
                .entry(edges[i].source.clone())
                .or_default()
                .push(i);
        }
    }
    let mut sources: Vec<&UnionId> = by_source.keys().collect();
    sources.sort();
    for source in sources {
        let d = open(&mut drafts, HunkKind::Relations, source.clone());
        for &i in &by_source[source] {
            let e = &edges[i];
            if !edge_owner.contains_key(&e.id) {
                edge_owner.insert(e.id.clone(), d);
                drafts[d].edges.push(e.id.clone());
            }
        }
    }

    // Ids in seeding order; collisions (never expected) get #2, #3…
    let mut used: Lookup<String, usize> = Lookup::new();
    let live: Vec<(JsStr, Draft)> = drafts
        .into_iter()
        .filter(|d| !d.nodes.is_empty() || !d.edges.is_empty())
        .map(|d| {
            let base = format!("{}:{}", d.kind.as_str(), d.anchor);
            let n = used.get(&base).copied().unwrap_or(0) + 1;
            used.insert(base.clone(), n);
            let id = if n == 1 {
                JsStr::from(base)
            } else {
                JsStr::from(format!("{base}#{n}"))
            };
            (id, d)
        })
        .collect();
    for (id, d) in &live {
        for n in &d.nodes {
            if let Some(&i) = node_at.get(n) {
                nodes[i].hunk = Some(id.clone());
            }
        }
        for e in &d.edges {
            if let Some(&i) = edge_at.get(e) {
                edges[i].hunk = Some(id.clone());
            }
        }
    }

    live.into_iter()
        .map(|(id, d)| {
            let mut own_nodes = d.nodes.clone();
            own_nodes.sort();
            if let Some(at) = own_nodes.iter().position(|n| *n == d.anchor)
                && at > 0
            {
                let anchor = own_nodes.remove(at);
                own_nodes.insert(0, anchor);
            }
            let mut own_edges = d.edges.clone();
            own_edges.sort();
            let node_list: Vec<&UnionNode> = d
                .nodes
                .iter()
                .filter_map(|n| node_at.get(n))
                .map(|&i| &nodes[i])
                .collect();
            let edge_list: Vec<&UnionEdge> = d
                .edges
                .iter()
                .filter_map(|e| edge_at.get(e))
                .map(|&i| &edges[i])
                .collect();
            HunkDraft {
                phase: phase_of(&d, &node_list),
                context: context_of(ctx, &d, &node_list, &edge_list, &node_at, nodes),
                summary: hunk_summary(
                    node_list
                        .iter()
                        .map(|n| (n.status, n.facets.iter().map(NodeFacet::kind).collect())),
                    edge_list
                        .iter()
                        .map(|e| (e.status, e.facets.iter().map(|f| f.kind()).collect())),
                ),
                id,
                kind: d.kind,
                anchor: d.anchor,
                nodes: own_nodes,
                edges: own_edges,
            }
        })
        .collect()
}

fn phase_of(d: &Draft, nodes: &[&UnionNode]) -> ReplayPhase {
    match d.kind {
        HunkKind::Remove => ReplayPhase::Remove,
        HunkKind::Add => ReplayPhase::Add,
        HunkKind::Merge | HunkKind::Split | HunkKind::Relations => ReplayPhase::Restructure,
        HunkKind::Modify => {
            let facets: Vec<&NodeFacet> = nodes.iter().flat_map(|n| n.facets.iter()).collect();
            if !facets.is_empty() && facets.iter().all(|f| matches!(f, NodeFacet::Move { .. })) {
                ReplayPhase::Restructure
            } else {
                ReplayPhase::Modify
            }
        }
    }
}

/// Nodes outside the hunk needed to read it (`contextOf`).
fn context_of(
    ctx: &Ctx<'_>,
    d: &Draft,
    nodes: &[&UnionNode],
    edges: &[&UnionEdge],
    node_at: &Lookup<UnionId, usize>,
    all: &[UnionNode],
) -> Vec<UnionId> {
    let mut context: IndexSet<UnionId> = IndexSet::new();
    for e in edges {
        context.extend(endpoints(e));
    }
    for n in nodes {
        for f in &n.facets {
            if let NodeFacet::Move { from, to, .. } = f {
                context.extend(from.iter().cloned());
                context.extend(to.iter().cloned());
            }
        }
    }
    if (d.kind == HunkKind::Merge || d.kind == HunkKind::Split)
        && let Some(&i) = node_at.get(&d.anchor)
    {
        context.extend(neighbors(ctx, &all[i]));
    }
    let mut out: Vec<UnionId> = context
        .into_iter()
        .filter(|u| !d.nodes.contains(u))
        .collect();
    out.sort();
    out
}

/// The summary of a hunk owning elements with these statuses and facet kinds (`hunkSummary`).
pub(crate) fn hunk_summary(
    nodes: impl Iterator<Item = (ChangeStatus, Vec<FacetKind>)>,
    edges: impl Iterator<Item = (ChangeStatus, Vec<FacetKind>)>,
) -> HunkSummary {
    let mut kinds = [false; 16];
    let mut count = |elements: &mut dyn Iterator<Item = (ChangeStatus, Vec<FacetKind>)>| {
        let mut c = CountTriplet::default();
        for (status, facets) in elements {
            match status {
                ChangeStatus::Added => c.added += 1,
                ChangeStatus::Removed => c.removed += 1,
                ChangeStatus::Modified => c.modified += 1,
                ChangeStatus::Unchanged => {}
            }
            for kind in facets {
                kinds[kind.index()] = true;
            }
        }
        c
    };
    let (mut nodes, mut edges) = (nodes, edges);
    let node_counts = count(&mut nodes);
    let edge_counts = count(&mut edges);
    HunkSummary {
        nodes: node_counts,
        edges: edge_counts,
        facets: FacetKind::ALL
            .into_iter()
            .filter(|k| kinds[k.index()])
            .collect(),
    }
}
