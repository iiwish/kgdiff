//! Hunk dependencies and the default review order (`order.ts`, docs/algorithms.md §7): every op
//! reads and writes node ids (`n`), a node's incident edges (`i`) and edge identities (`e`);
//! walking the ops in delta order gives op dependencies, lifted to hunks as `requires`.
//! Dependency cycles between hunks are merged into one hunk.

use std::cmp::Ordering;

use crate::js::{IndexMap, IndexSet};

use crate::canonical::triple_key;
use crate::delta::DeltaOp;
use crate::hunks::HunkDraft;
use crate::js::{JsStr, Lookup, Object};
use crate::model::{
    CountTriplet, EdgeIdentity, FacetKind, Hunk, HunkSummary, UnionEdge, UnionId, UnionNode,
};

fn edge_resource(edge: &Object, mode: EdgeIdentity) -> String {
    let field = |name: &str| edge.get(name).and_then(|v| v.as_str()).unwrap_or("");
    match edge.get("id").and_then(|v| v.as_str()) {
        Some(id) if mode == EdgeIdentity::Id => format!("ei{id}"),
        _ => format!(
            "et{}",
            triple_key(field("source"), field("predicate"), field("target"))
        ),
    }
}

/// Resources an op reads and writes.
fn access(op: &DeltaOp, mode: EdgeIdentity) -> (Vec<String>, Vec<String>) {
    let n = |id: &str| format!("n{id}");
    let i = |id: &str| format!("i{id}");
    let ends = |edge: &Object| {
        let field = |name: &str| {
            edge.get(name)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        };
        (field("source"), field("target"))
    };
    match op {
        DeltaOp::NodeRekey { from, to } => (vec![n(from), n(to)], vec![n(from), n(to)]),
        DeltaOp::NodeRemove { node } => {
            let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
            (vec![n(id), i(id)], vec![n(id)])
        }
        DeltaOp::NodeAdd { node } => {
            let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
            (vec![n(id)], vec![n(id)])
        }
        DeltaOp::NodeSet { id, .. } | DeltaOp::NodeAttr { id, .. } => (vec![n(id)], Vec::new()),
        DeltaOp::EdgeRemove { edge } => {
            let e = edge_resource(edge, mode);
            let (s, t) = ends(edge);
            (vec![n(&s), n(&t), e.clone()], vec![e, i(&s), i(&t)])
        }
        DeltaOp::EdgeAdd { edge } => {
            let e = edge_resource(edge, mode);
            let (s, t) = ends(edge);
            (vec![n(&s), n(&t), e.clone()], vec![e])
        }
        DeltaOp::EdgeSet { edge, .. } | DeltaOp::EdgeAttr { edge, .. } => {
            let (s, t) = ends(edge);
            (vec![n(&s), n(&t), edge_resource(edge, mode)], Vec::new())
        }
    }
}

type Requires = IndexMap<JsStr, IndexSet<JsStr>>;

/// `hunk → hunks it requires`, from the op-level dependencies (`dependencies`).
fn dependencies(ops: &[DeltaOp], op_hunks: &[Option<JsStr>], mode: EdgeIdentity) -> Requires {
    let mut requires: Requires = IndexMap::default();
    let mut last_writer: Lookup<String, Option<JsStr>> = Lookup::new();
    let mut readers: Lookup<String, IndexSet<JsStr>> = Lookup::new();
    // Edge removals at a node commute; only removing the node waits for them.
    let mut removals: Lookup<String, IndexSet<JsStr>> = Lookup::new();
    let need = |requires: &mut Requires, hunk: &Option<JsStr>, on: Option<&JsStr>| {
        if let (Some(hunk), Some(on)) = (hunk, on)
            && on != hunk
        {
            requires.entry(hunk.clone()).or_default().insert(on.clone());
        }
    };
    for (op, hunk) in ops.iter().zip(op_hunks) {
        let (reads, writes) = access(op, mode);
        for r in reads {
            if r.starts_with('i') {
                // The node must have lost all its edges.
                for h in removals.get(&r).into_iter().flatten() {
                    need(&mut requires, hunk, Some(h));
                }
                continue;
            }
            need(
                &mut requires,
                hunk,
                last_writer.get(&r).and_then(Option::as_ref),
            );
            if let Some(h) = hunk {
                readers
                    .get_or_insert_with(r, IndexSet::default)
                    .insert(h.clone());
            }
        }
        for w in writes {
            if w.starts_with('i') {
                if let Some(h) = hunk {
                    removals
                        .get_or_insert_with(w, IndexSet::default)
                        .insert(h.clone());
                }
                continue;
            }
            need(
                &mut requires,
                hunk,
                last_writer.get(&w).and_then(Option::as_ref),
            );
            for reader in readers.get(&w).into_iter().flatten() {
                need(&mut requires, hunk, Some(reader));
            }
            readers.remove(&w);
            last_writer.insert(w, hunk.clone());
        }
    }
    requires
}

/// Strongly connected components (Tarjan, iterative), visiting ids in sorted order.
fn components(ids: &[JsStr], edges: &Requires) -> Vec<Vec<JsStr>> {
    let mut index: Lookup<JsStr, usize> = Lookup::new();
    let mut low: Lookup<JsStr, usize> = Lookup::new();
    let mut on_stack: Lookup<JsStr, ()> = Lookup::new();
    let mut stack: Vec<JsStr> = Vec::new();
    let mut result = Vec::new();
    let mut counter = 0;
    struct Frame {
        id: JsStr,
        next: Vec<JsStr>,
        at: usize,
    }
    for root in ids {
        if index.contains_key(root) {
            continue;
        }
        let mut work: Vec<Frame> = Vec::new();
        let mut enter = |id: &JsStr,
                         work: &mut Vec<Frame>,
                         index: &mut Lookup<JsStr, usize>,
                         low: &mut Lookup<JsStr, usize>,
                         stack: &mut Vec<JsStr>,
                         on_stack: &mut Lookup<JsStr, ()>| {
            index.insert(id.clone(), counter);
            low.insert(id.clone(), counter);
            counter += 1;
            stack.push(id.clone());
            on_stack.insert(id.clone(), ());
            let mut next: Vec<JsStr> = edges
                .get(id)
                .map(|s| s.iter().cloned().collect())
                .unwrap_or_default();
            next.sort();
            work.push(Frame {
                id: id.clone(),
                next,
                at: 0,
            });
        };
        enter(
            root,
            &mut work,
            &mut index,
            &mut low,
            &mut stack,
            &mut on_stack,
        );
        while let Some(frame) = work.last_mut() {
            if frame.at < frame.next.len() {
                let w = frame.next[frame.at].clone();
                frame.at += 1;
                let id = frame.id.clone();
                if !index.contains_key(&w) {
                    enter(
                        &w,
                        &mut work,
                        &mut index,
                        &mut low,
                        &mut stack,
                        &mut on_stack,
                    );
                } else if on_stack.contains_key(&w) {
                    let v = low[&id].min(index[&w]);
                    low.insert(id, v);
                }
                continue;
            }
            let frame = work.pop().unwrap_or_else(|| unreachable!());
            if let Some(parent) = work.last() {
                let v = low[&parent.id].min(low[&frame.id]);
                low.insert(parent.id.clone(), v);
            }
            if low[&frame.id] == index[&frame.id] {
                let mut component = Vec::new();
                loop {
                    let w = stack.pop().unwrap_or_else(|| unreachable!());
                    on_stack.remove(&w);
                    let done = w == frame.id;
                    component.push(w);
                    if done {
                        break;
                    }
                }
                result.push(component);
            }
        }
    }
    result
}

/// The ordered hunks and the hunk of each op (`Ordering`).
pub(crate) struct Ordered {
    pub hunks: Vec<Hunk>,
    #[allow(
        dead_code,
        reason = "kept for parity with orderHunks; the pipeline reads the hunks only"
    )]
    pub op_hunks: Vec<Option<JsStr>>,
}

/// Computes `requires`, merges dependency cycles and assigns `order` (`orderHunks`): a
/// topological order of `requires` that, among the ready hunks, prefers the earlier phase, then
/// the larger hunk, then the anchor label, then the id. Updates `hunk` on merged elements.
pub(crate) fn order_hunks(
    drafts: Vec<HunkDraft>,
    ops: &[DeltaOp],
    op_hunks: &[Option<JsStr>],
    mode: EdgeIdentity,
    nodes: &mut [UnionNode],
    edges: &mut [UnionEdge],
) -> Ordered {
    let mut label_of: Lookup<UnionId, JsStr> = Lookup::new();
    for n in nodes.iter() {
        let label = n
            .after
            .as_ref()
            .map(|a| a.label.clone())
            .or_else(|| n.before.as_ref().map(|b| b.label.clone()))
            .unwrap_or_else(|| n.id.clone());
        label_of.insert(n.id.clone(), label);
    }
    let size = |h: &HunkDraft| h.nodes.len() + h.edges.len();
    let rank = |x: &HunkDraft, y: &HunkDraft| -> Ordering {
        x.phase
            .cmp(&y.phase)
            .then_with(|| size(y).cmp(&size(x)))
            .then_with(|| {
                label_of
                    .get(&x.anchor)
                    .unwrap_or(&x.anchor)
                    .cmp(label_of.get(&y.anchor).unwrap_or(&y.anchor))
            })
            .then_with(|| x.id.cmp(&y.id))
    };

    // Merge dependency cycles into their best-ranked member.
    let mut requires = dependencies(ops, op_hunks, mode);
    let by_id: Lookup<JsStr, usize> =
        drafts
            .iter()
            .enumerate()
            .fold(Lookup::new(), |mut m, (i, h)| {
                m.insert(h.id.clone(), i);
                m
            });
    let mut ids: Vec<JsStr> = drafts.iter().map(|h| h.id.clone()).collect();
    ids.sort();
    let mut into: Lookup<JsStr, JsStr> = Lookup::new();
    let mut merging = false;
    for component in components(&ids, &requires) {
        if component.len() < 2 {
            continue;
        }
        let mut members: Vec<&HunkDraft> = component
            .iter()
            .filter_map(|id| by_id.get(id))
            .map(|&i| &drafts[i])
            .collect();
        members.sort_by(|x, y| rank(x, y));
        let keep = members[0].id.clone();
        for m in members {
            into.insert(m.id.clone(), keep.clone());
            merging = true;
        }
    }
    let mut hunks: Vec<HunkDraft> = drafts.clone();
    let mut final_op_hunks: Vec<Option<JsStr>> = op_hunks.to_vec();
    if merging {
        hunks = merge_hunks(&drafts, &into, nodes, edges);
        for h in final_op_hunks.iter_mut().flatten() {
            if let Some(kept) = into.get(h) {
                *h = kept.clone();
            }
        }
        let mut merged: Requires = IndexMap::default();
        for (h, deps) in &requires {
            let from = into.get(h).unwrap_or(h).clone();
            for d in deps {
                let to = into.get(d).unwrap_or(d).clone();
                if to != from {
                    merged.entry(from.clone()).or_default().insert(to);
                }
            }
        }
        requires = merged;
    }

    // Kahn's algorithm, ready hunks taken by rank.
    let mut blockers: Lookup<JsStr, usize> = Lookup::new();
    let mut dependents: Lookup<JsStr, Vec<usize>> = Lookup::new();
    let position: Lookup<JsStr, usize> =
        hunks
            .iter()
            .enumerate()
            .fold(Lookup::new(), |mut m, (i, h)| {
                m.insert(h.id.clone(), i);
                m
            });
    for (i, h) in hunks.iter().enumerate() {
        let deps = requires.get(&h.id);
        blockers.insert(h.id.clone(), deps.map_or(0, IndexSet::len));
        for d in deps.into_iter().flatten() {
            dependents.get_or_insert_with(d.clone(), Vec::new).push(i);
        }
    }
    let less = |x: usize, y: usize| rank(&hunks[x], &hunks[y]) == Ordering::Less;
    let mut ready = Heap::default();
    for (i, h) in hunks.iter().enumerate() {
        if blockers.get(&h.id) == Some(&0) {
            ready.push(i, &less);
        }
    }
    let mut ops_by_hunk: Lookup<JsStr, Vec<usize>> = Lookup::new();
    for (i, h) in final_op_hunks.iter().enumerate() {
        if let Some(h) = h {
            ops_by_hunk.get_or_insert_with(h.clone(), Vec::new).push(i);
        }
    }
    let mut ordered: Vec<Hunk> = Vec::with_capacity(hunks.len());
    while let Some(i) = ready.pop(&less) {
        let h = &hunks[i];
        let mut deps: Vec<JsStr> = requires
            .get(&h.id)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        deps.sort();
        ordered.push(Hunk {
            id: h.id.clone(),
            kind: h.kind,
            phase: h.phase,
            anchor: h.anchor.clone(),
            nodes: h.nodes.clone(),
            edges: h.edges.clone(),
            context: h.context.clone(),
            ops: ops_by_hunk.get(&h.id).cloned().unwrap_or_default(),
            requires: deps,
            summary: h.summary.clone(),
            order: ordered.len(),
        });
        for &next in dependents.get(&h.id).into_iter().flatten() {
            let id = &hunks[next].id;
            let left = blockers.get(id).copied().unwrap_or(1) - 1;
            blockers.insert(id.clone(), left);
            if left == 0 && position.contains_key(id) {
                ready.push(next, &less);
            }
        }
    }
    Ordered {
        hunks: ordered,
        op_hunks: final_op_hunks,
    }
}

/// Merges hunks per `into` (member → kept hunk), keeping the kept hunk's identity (`mergeHunks`).
fn merge_hunks(
    drafts: &[HunkDraft],
    into: &Lookup<JsStr, JsStr>,
    nodes: &mut [UnionNode],
    edges: &mut [UnionEdge],
) -> Vec<HunkDraft> {
    let mut groups: IndexMap<JsStr, Vec<&HunkDraft>> = IndexMap::default();
    for h in drafts {
        groups
            .entry(into.get(&h.id).unwrap_or(&h.id).clone())
            .or_default()
            .push(h);
    }
    for n in nodes.iter_mut() {
        if let Some(kept) = n.hunk.as_ref().and_then(|h| into.get(h)) {
            n.hunk = Some(kept.clone());
        }
    }
    for e in edges.iter_mut() {
        if let Some(kept) = e.hunk.as_ref().and_then(|h| into.get(h)) {
            e.hunk = Some(kept.clone());
        }
    }
    let mut result = Vec::new();
    for (keep, members) in groups {
        let Some(head) = members.iter().find(|m| m.id == keep) else {
            continue;
        };
        if members.len() == 1 {
            result.push((*head).clone());
            continue;
        }
        let owned: IndexSet<UnionId> = members
            .iter()
            .flat_map(|m| m.nodes.iter().cloned())
            .collect();
        let mut rest: Vec<UnionId> = owned
            .iter()
            .filter(|id| **id != head.anchor)
            .cloned()
            .collect();
        rest.sort();
        let member_nodes = if owned.contains(&head.anchor) {
            std::iter::once(head.anchor.clone()).chain(rest).collect()
        } else {
            rest
        };
        let mut member_edges: Vec<UnionId> = members
            .iter()
            .flat_map(|m| m.edges.iter().cloned())
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect();
        member_edges.sort();
        let mut context: Vec<UnionId> = members
            .iter()
            .flat_map(|m| m.context.iter().cloned())
            .collect::<IndexSet<_>>()
            .into_iter()
            .filter(|id| !owned.contains(id))
            .collect();
        context.sort();
        let mut kinds = [false; 16];
        for m in &members {
            for k in &m.summary.facets {
                kinds[k.index()] = true;
            }
        }
        let sum = |pick: &dyn Fn(&HunkSummary) -> CountTriplet| {
            members.iter().fold(CountTriplet::default(), |total, m| {
                let c = pick(&m.summary);
                CountTriplet {
                    added: total.added + c.added,
                    removed: total.removed + c.removed,
                    modified: total.modified + c.modified,
                }
            })
        };
        let mut merged = (*head).clone();
        merged.nodes = member_nodes;
        merged.edges = member_edges;
        merged.context = context;
        merged.summary = HunkSummary {
            nodes: sum(&|s| s.nodes),
            edges: sum(&|s| s.edges),
            facets: FacetKind::ALL
                .into_iter()
                .filter(|k| kinds[k.index()])
                .collect(),
        };
        result.push(merged);
    }
    result
}

/// A binary min-heap of indices under a `less` order (`Heap`). The ranking it is used with is a
/// total order, so it pops the hunks in the same order as the TypeScript heap.
#[derive(Default)]
struct Heap {
    items: Vec<usize>,
}

impl Heap {
    fn push(&mut self, item: usize, less: &dyn Fn(usize, usize) -> bool) {
        self.items.push(item);
        let mut i = self.items.len() - 1;
        while i > 0 {
            let parent = (i - 1) / 2;
            if !less(self.items[i], self.items[parent]) {
                break;
            }
            self.items.swap(i, parent);
            i = parent;
        }
    }

    fn pop(&mut self, less: &dyn Fn(usize, usize) -> bool) -> Option<usize> {
        if self.items.is_empty() {
            return None;
        }
        let top = self.items.swap_remove(0);
        let mut i = 0;
        loop {
            let (l, r) = (2 * i + 1, 2 * i + 2);
            let mut m = i;
            if l < self.items.len() && less(self.items[l], self.items[m]) {
                m = l;
            }
            if r < self.items.len() && less(self.items[r], self.items[m]) {
                m = r;
            }
            if m == i {
                break;
            }
            self.items.swap(i, m);
            i = m;
        }
        Some(top)
    }
}
