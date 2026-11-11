//! Edge pairing and classification (docs/algorithms.md §5) and union edge ids (§6)
//! (`edges.ts`): before edges are mapped into union-id space and paired with after edges in five
//! passes — exact, carried by merge / split, predicate change, retarget, leftovers.

use std::sync::Arc;

use crate::js::IndexMap;

use crate::canonical::{canonical_json, has_parallel_suffix, split_structural_key, triple_key};
use crate::classify::{RestructureIndex, attr_changes, moved_key};
use crate::js::{self, JsStr, KeySorted, Lookup, Value};
use crate::model::{
    Cause, ChangeStatus, EdgeFacet, EdgeIdentity, End, GraphIssueCode, KGEdge, KGraph, UnionEdge,
    UnionId,
};
use crate::pipeline::Ctx;
use crate::text::predicate_label;

/// What distinguishes parallel copies of one triple.
fn parallel_content(edge: &KGEdge) -> String {
    canonical_json(&Value::Array(vec![
        Value::from(&edge.label),
        Value::Object(edge.attrs.clone()),
    ]))
}

/// A before edge in union space.
struct Mapped {
    edge: Arc<KGEdge>,
    /// Union ids of the before endpoints.
    source: UnionId,
    target: UnionId,
    /// The edge id (id-keyed) or the structural key with its suffix, in union space.
    key: JsStr,
}

struct Pairing<'a, 'c> {
    ctx: &'a Ctx<'c>,
    index: &'a RestructureIndex,
    /// The union edges, to be sorted by id.
    records: KeySorted<UnionEdge>,
    /// Positions of the after edges, by key.
    after_at: &'a Lookup<JsStr, usize>,
    /// Per after edge (by index): paired already.
    paired: Vec<bool>,
    remaining_after: usize,
}

impl Pairing<'_, '_> {
    fn is_free(&self, key: &str) -> bool {
        self.after_at.get(key).is_some_and(|&i| !self.paired[i])
    }

    fn cause_of(&self, end: End, from: &UnionId, to: &UnionId, e: &KGEdge) -> Cause {
        if self.index.merge_target_of.get(from) == Some(to) {
            return Cause::Merge;
        }
        if self
            .index
            .split_targets_of
            .get(from)
            .is_some_and(|targets| targets.contains(to))
        {
            return Cause::Split;
        }
        if self.ctx.hierarchy.contains_key(&e.predicate) {
            let child = if end == End::Target { &e.source } else { to };
            if self
                .index
                .moved
                .contains_key(&moved_key(child, &e.predicate))
                || self
                    .index
                    .moved
                    .contains_key(&moved_key(from, &e.predicate))
            {
                return Cause::Move;
            }
        }
        Cause::Edit
    }

    fn pair(&mut self, m: &Mapped, a: &Arc<KGEdge>, in_place: bool, forced: Option<Cause>) {
        let at = self.after_at.get(&a.key).copied();
        self.pair_at(m, a, at, in_place, forced);
    }

    /// [`Pairing::pair`] with the position of `a` among the after edges known already.
    fn pair_at(
        &mut self,
        m: &Mapped,
        a: &Arc<KGEdge>,
        at: Option<usize>,
        in_place: bool,
        forced: Option<Cause>,
    ) {
        if let Some(i) = at
            && !self.paired[i]
        {
            self.paired[i] = true;
            self.remaining_after -= 1;
        }
        let b = &m.edge;
        let source_changed = m.source != a.source;
        let target_changed = m.target != a.target;
        let predicate_changed = b.predicate != a.predicate;
        let mut facets = Vec::new();
        if source_changed {
            let cause =
                forced.unwrap_or_else(|| self.cause_of(End::Source, &m.source, &a.source, a));
            facets.push(EdgeFacet::Retarget {
                end: End::Source,
                from: m.source.clone(),
                to: a.source.clone(),
                cause,
            });
        }
        if target_changed {
            let cause =
                forced.unwrap_or_else(|| self.cause_of(End::Target, &m.target, &a.target, a));
            facets.push(EdgeFacet::Retarget {
                end: End::Target,
                from: m.target.clone(),
                to: a.target.clone(),
                cause,
            });
        }
        if predicate_changed {
            facets.push(EdgeFacet::Predicate {
                from: b.predicate.clone(),
                to: a.predicate.clone(),
            });
        }
        let derived_labels = predicate_changed
            && b.label == predicate_label(&b.predicate)
            && a.label == predicate_label(&a.predicate);
        if b.label != a.label && !derived_labels {
            facets.push(EdgeFacet::Label {
                from: b.label.clone(),
                to: a.label.clone(),
            });
        }
        let changes = attr_changes(&b.attrs, &a.attrs, &self.ctx.ignore_attrs);
        if !changes.is_empty() {
            facets.push(EdgeFacet::Attrs { changes });
        }
        let status = if facets.is_empty() {
            ChangeStatus::Unchanged
        } else {
            ChangeStatus::Modified
        };
        let record = UnionEdge {
            id: a.key.clone(),
            source: a.source.clone(),
            target: a.target.clone(),
            predicate: a.predicate.clone(),
            label: a.label.clone(),
            status,
            facets,
            hunk: None,
            hierarchical: self.ctx.hierarchy.contains_key(&a.predicate),
            before_key: Some(b.key.clone()),
            after_key: Some(a.key.clone()),
            before: Some(b.clone()),
            after: Some(a.clone()),
            source_before: source_changed.then(|| m.source.clone()),
            target_before: target_changed.then(|| m.target.clone()),
            predicate_before: predicate_changed.then(|| b.predicate.clone()),
            in_place: in_place && !source_changed && !target_changed && !predicate_changed,
        };
        self.records.push(record, |e| &e.id);
    }
}

/// `${s.length}:${s}${t}` (UTF-16 length).
fn pair_key(s: &str, t: &str) -> String {
    format!("{}:{s}{t}", js::utf16_len(s))
}

/// Pairs, classifies and keys every edge of the union (`classifyEdges`), sorted by union id.
pub(crate) fn classify_edges(ctx: &Ctx<'_>, index: &RestructureIndex) -> Vec<UnionEdge> {
    let (before, after) = (ctx.before, ctx.after);
    let mode = ctx.options.edge_identity;
    let structural = |e: &KGEdge| mode == EdgeIdentity::Structure || e.id.is_none();
    // The edges on their own, which the union edges keep.
    let before_edges = before.shared_edges();
    let after_edges = after.shared_edges();
    let mut after_at: Lookup<JsStr, usize> = Lookup::with_capacity(after_edges.len());
    for (at, edge) in after_edges.iter().enumerate() {
        after_at.insert(edge.key.clone(), at);
    }
    let after_full = |key: &str| after_at.get(key).map(|&at| (at, &after_edges[at]));
    let mut p = Pairing {
        ctx,
        index,
        after_at: &after_at,
        records: KeySorted::with_capacity(before_edges.len().max(after_edges.len())),
        paired: vec![false; after_edges.len()],
        remaining_after: after_edges.len(),
    };

    // Parallel copies of a triple exist only when a graph reported them (structure identity), or
    // when an edge id pushed a structural key aside (id identity).
    let may_have_parallel = |g: &KGraph| {
        mode == EdgeIdentity::Id
            || g.issues()
                .iter()
                .any(|i| i.code == GraphIssueCode::DuplicateEdge)
    };
    let mut parallel: Lookup<String, ()> = Lookup::new();
    if may_have_parallel(before) || may_have_parallel(after) {
        for edge in &before_edges {
            if structural(edge) && has_parallel_suffix(&edge.key) {
                let base = split_structural_key(&edge.key).0;
                let (source, target) = (
                    ctx.union_of_before(&edge.source),
                    ctx.union_of_before(&edge.target),
                );
                let key = if source == edge.source && target == edge.target {
                    base.to_owned()
                } else {
                    triple_key(&source, &edge.predicate, &target)
                        .as_str()
                        .to_owned()
                };
                parallel.insert(key, ());
            }
        }
        for e in &after_edges {
            if structural(e) && has_parallel_suffix(&e.key) {
                parallel.insert(split_structural_key(&e.key).0.to_owned(), ());
            }
        }
    }

    // ── 1. Exact ── (before edges are mapped into union space on the way)
    let mut remaining: Vec<Mapped> = Vec::new();
    let mut groups: IndexMap<String, (Vec<Mapped>, Vec<Arc<KGEdge>>)> = IndexMap::default();
    for edge in &before_edges {
        let source = ctx.union_of_before(&edge.source);
        let target = ctx.union_of_before(&edge.target);
        let is_structural = structural(edge);
        let mut key = edge.key.clone();
        if is_structural && (source != edge.source || target != edge.target) {
            key = JsStr::from(format!(
                "{}{}",
                triple_key(&source, &edge.predicate, &target),
                split_structural_key(&edge.key).1
            ));
        }
        let m = Mapped {
            edge: edge.clone(),
            source,
            target,
            key,
        };
        if !is_structural {
            match after_full(&m.key) {
                Some((at, a)) if a.id == edge.id && !structural(a) => {
                    let a = a.clone();
                    p.pair_at(&m, &a, Some(at), true, None);
                }
                _ => remaining.push(m),
            }
            continue;
        }
        if !parallel.is_empty() {
            let base = split_structural_key(&m.key).0.to_owned();
            if parallel.contains_key(&base) {
                groups.entry(base).or_default().0.push(m);
                continue;
            }
        }
        match after_full(&m.key) {
            Some((at, a))
                if structural(a)
                    && a.source == m.source
                    && a.target == m.target
                    && a.predicate == edge.predicate =>
            {
                let a = a.clone();
                p.pair_at(&m, &a, Some(at), true, None);
            }
            _ => remaining.push(m),
        }
    }
    if !groups.is_empty() {
        for e in &after_edges {
            if !structural(e) {
                continue;
            }
            let base = split_structural_key(&e.key).0;
            if parallel.contains_key(base)
                && let Some(group) = groups.get_mut(base)
            {
                group.1.push(e.clone());
            }
        }
        let mut bases: Vec<String> = groups.keys().cloned().collect();
        bases.sort_by(|a, b| js::cmp_utf16(a, b));
        for base in bases {
            let Some((mut before_copies, mut after_copies)) = groups.swap_remove(&base) else {
                continue;
            };
            after_copies.sort_by(|x, y| x.key.cmp(&y.key));
            // Identical content first, so an unchanged copy is never reported as modified; then
            // the rest in key order.
            let mut by_content: IndexMap<String, Vec<usize>> = IndexMap::default();
            for (i, a) in after_copies.iter().enumerate() {
                by_content.entry(parallel_content(a)).or_default().push(i);
            }
            let mut used = vec![false; after_copies.len()];
            let mut left: Vec<Mapped> = Vec::new();
            before_copies.sort_by(|x, y| x.key.cmp(&y.key));
            for m in before_copies {
                let same = by_content
                    .get_mut(&parallel_content(&m.edge))
                    .and_then(Vec::pop);
                match same {
                    None => left.push(m),
                    Some(i) => {
                        used[i] = true;
                        let a = after_copies[i].clone();
                        p.pair(&m, &a, false, None);
                    }
                }
            }
            let mut cursor = 0;
            for m in left {
                while cursor < after_copies.len() && used[cursor] {
                    cursor += 1;
                }
                let a = after_copies.get(cursor).cloned();
                cursor += 1;
                match a {
                    Some(a) => p.pair(&m, &a, false, None),
                    None => remaining.push(m),
                }
            }
        }
    }

    // Remaining after edges indexed by triple (union space), in key order.
    let after_keys_by_triple = || {
        let mut by_triple: Lookup<JsStr, Vec<Arc<KGEdge>>> = Lookup::new();
        let mut keys: Vec<JsStr> = Vec::new();
        for e in &after_edges {
            let triple = triple_key(&e.source, &e.predicate, &e.target);
            let list = by_triple.get_or_insert_with(triple.clone(), Vec::new);
            if list.is_empty() {
                keys.push(triple);
            }
            list.push(e.clone());
        }
        for key in &keys {
            if let Some(list) = by_triple.get_mut(key) {
                list.sort_by(|x, y| x.key.cmp(&y.key));
            }
        }
        by_triple
    };
    js::sort_by_js_key(&mut remaining, |m| &m.key);

    // ── 2. Carried by merge / split ──
    let mut collapsed: Vec<(Mapped, UnionId)> = Vec::new();
    if !remaining.is_empty()
        && (!index.merge_target_of.is_empty() || !index.split_targets_of.is_empty())
    {
        let by_triple = after_keys_by_triple();
        let mut next: Vec<Mapped> = Vec::new();
        for m in std::mem::take(&mut remaining) {
            let predicate = &m.edge.predicate;
            let fs = index
                .merge_target_of
                .get(&m.source)
                .cloned()
                .unwrap_or_else(|| m.source.clone());
            let ft = index
                .merge_target_of
                .get(&m.target)
                .cloned()
                .unwrap_or_else(|| m.target.clone());
            if fs != m.source || ft != m.target {
                let candidates = by_triple.get(&triple_key(&fs, predicate, &ft));
                let free = candidates
                    .and_then(|c| c.iter().find(|a| p.is_free(&a.key)))
                    .cloned();
                if let Some(free) = free {
                    p.pair(&m, &free, false, Some(Cause::Merge));
                } else if let Some(first) = candidates.and_then(|c| c.first()) {
                    let into = first.key.clone();
                    collapsed.push((m, into));
                } else {
                    next.push(m);
                }
                continue;
            }
            let none: Vec<UnionId> = Vec::new();
            let sources: Vec<&UnionId> = std::iter::once(&m.source)
                .chain(index.split_targets_of.get(&m.source).unwrap_or(&none))
                .collect();
            let targets: Vec<&UnionId> = std::iter::once(&m.target)
                .chain(index.split_targets_of.get(&m.target).unwrap_or(&none))
                .collect();
            let mut carried: Option<Arc<KGEdge>> = None;
            for s in &sources {
                for t in &targets {
                    if carried.is_some() || (**s == m.source && **t == m.target) {
                        continue;
                    }
                    carried = by_triple
                        .get(&triple_key(s, predicate, t))
                        .and_then(|c| c.iter().find(|a| p.is_free(&a.key)))
                        .cloned();
                }
            }
            match carried {
                Some(a) => p.pair(&m, &a, false, Some(Cause::Split)),
                None => next.push(m),
            }
        }
        remaining = next;
    }

    // ── 3. Predicate change, 4. retarget: unique one-to-one leftovers per group ──
    let pair_unique = |p: &mut Pairing<'_, '_>,
                       remaining: &mut Vec<Mapped>,
                       before_key: &dyn Fn(&Mapped) -> String,
                       after_key: &dyn Fn(&KGEdge) -> String,
                       accept: &dyn Fn(&Mapped, &KGEdge) -> bool| {
        if remaining.is_empty() || p.remaining_after == 0 {
            return;
        }
        let mut b_groups: IndexMap<String, Vec<usize>> = IndexMap::default();
        for (i, m) in remaining.iter().enumerate() {
            b_groups.entry(before_key(m)).or_default().push(i);
        }
        let mut a_groups: Lookup<String, Vec<Arc<KGEdge>>> = Lookup::new();
        for (i, a) in after_edges.iter().enumerate() {
            if p.paired[i] {
                continue;
            }
            let k = after_key(a);
            if b_groups.contains_key(&k) {
                a_groups.get_or_insert_with(k, Vec::new).push(a.clone());
            }
        }
        let mut used = vec![false; remaining.len()];
        let mut keys: Vec<&String> = b_groups.keys().collect();
        keys.sort_by(|a, b| js::cmp_utf16(a, b));
        for k in keys {
            let bs = &b_groups[k];
            let Some(r#as) = a_groups.get(k) else {
                continue;
            };
            if bs.len() != 1 || r#as.len() != 1 {
                continue; // never guess
            }
            let (m, a) = (&remaining[bs[0]], r#as[0].clone());
            if !accept(m, &a) {
                continue;
            }
            p.pair(m, &a, false, None);
            used[bs[0]] = true;
        }
        if used.iter().any(|&u| u) {
            let mut i = 0;
            remaining.retain(|_| {
                i += 1;
                !used[i - 1]
            });
        }
    };
    pair_unique(
        &mut p,
        &mut remaining,
        &|m| pair_key(&m.source, &m.target),
        &|a| pair_key(&a.source, &a.target),
        &|m, a| m.edge.predicate != a.predicate,
    );
    pair_unique(
        &mut p,
        &mut remaining,
        &|m| pair_key(&m.source, &m.edge.predicate),
        &|a| pair_key(&a.source, &a.predicate),
        &|m, a| m.target != a.target,
    );
    // A statement belongs to its subject: moving it to another subject is a retarget only when
    // both subjects exist in both versions.
    let persists = |u: &UnionId| ctx.after_to_before.contains_key(u);
    pair_unique(
        &mut p,
        &mut remaining,
        &|m| pair_key(&m.target, &m.edge.predicate),
        &|a| pair_key(&a.target, &a.predicate),
        &|m, a| m.source != a.source && persists(&m.source) && persists(&a.source),
    );

    // ── 5. Leftovers ──
    for (i, a) in after_edges.iter().enumerate() {
        if p.paired[i] {
            continue;
        }
        p.records.push(
            edge_record(
                a.key.clone(),
                a.source.clone(),
                a.target.clone(),
                a,
                ChangeStatus::Added,
                Vec::new(),
                ctx.hierarchy.contains_key(&a.predicate),
            ),
            |e| &e.id,
        );
    }
    let mut removed: Vec<(Mapped, Option<UnionId>)> = remaining
        .into_iter()
        .map(|m| (m, None))
        .chain(collapsed.into_iter().map(|(m, into)| (m, Some(into))))
        .collect();
    js::sort_by_js_key(&mut removed, |x| &x.0.key);
    let mut taken: Lookup<JsStr, ()> = Lookup::new();
    for (m, into) in removed {
        let id = unique_before_id(&m, structural(&m.edge), &|k| {
            after_at.contains_key(k) || taken.contains_key(k)
        });
        taken.insert(id.clone(), ());
        let facets = into
            .map(|into| vec![EdgeFacet::Collapsed { into }])
            .unwrap_or_default();
        let hierarchical = ctx.hierarchy.contains_key(&m.edge.predicate);
        p.records.push(
            edge_record(
                id,
                m.source,
                m.target,
                &m.edge,
                ChangeStatus::Removed,
                facets,
                hierarchical,
            ),
            |e| &e.id,
        );
    }
    p.records.into_sorted(|e| &e.id)
}

/// Union id of a before-only edge (`uniqueBeforeId`): its union-space key; on collision the next
/// free `#n` (structural keys) or `@before` (edge ids).
fn unique_before_id(m: &Mapped, structural: bool, taken: &dyn Fn(&str) -> bool) -> UnionId {
    if !taken(&m.key) {
        return m.key.clone();
    }
    if !structural {
        let mut id = format!("{}@before", m.key);
        while taken(&id) {
            id.push_str("@before");
        }
        return JsStr::from(id);
    }
    let base = split_structural_key(&m.key).0;
    let mut n = 2;
    while taken(&format!("{base}#{n}")) {
        n += 1;
    }
    JsStr::from(format!("{base}#{n}"))
}

fn edge_record(
    id: UnionId,
    source: UnionId,
    target: UnionId,
    edge: &Arc<KGEdge>,
    status: ChangeStatus,
    facets: Vec<EdgeFacet>,
    hierarchical: bool,
) -> UnionEdge {
    let after = status == ChangeStatus::Added;
    UnionEdge {
        id,
        source,
        target,
        predicate: edge.predicate.clone(),
        label: edge.label.clone(),
        status,
        facets,
        hunk: None,
        hierarchical,
        before_key: (!after).then(|| edge.key.clone()),
        after_key: after.then(|| edge.key.clone()),
        before: (!after).then(|| edge.clone()),
        after: after.then(|| edge.clone()),
        source_before: None,
        target_before: None,
        predicate_before: None,
        in_place: false,
    }
}
