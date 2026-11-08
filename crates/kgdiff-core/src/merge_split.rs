//! Merge (N → 1) and split (1 → N) detection (`merge-split.ts`, docs/algorithms.md §3), run
//! after matching: explicit hints (`replacedBy` / `replaces`, confidence 1) or a heuristic
//! (near-identical names plus edge carry-over).

use indexmap::{IndexMap, IndexSet};

use crate::canonical::triple_key;
use crate::js::{self, JsStr, Lookup};
use crate::matching::{Alignment, StringSet, attr_evidence, evidence_of, type_evidence};
use crate::model::{EdgeIdentity, Id, KGNode, KGraph, MatchSuggestion, SuggestionReason, Via};
use crate::text::{NameKey, ProfileCache, name_keys, profile_similarity};
use crate::util::{count_to_f64, round6};

const LABEL_EVIDENCE: f64 = 0.9;
const CARRY_OVER: f64 = 0.5;
const ACCEPT: f64 = 0.75;

/// A merge source or split target with how it was found.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Contribution {
    /// A before id (merge source) or an after id (split target).
    pub id: Id,
    pub confidence: f64,
    pub via: Via,
}

#[derive(Clone, Debug)]
pub(crate) struct MergeGroup {
    /// After id of the node the sources merge into.
    pub target: Id,
    /// Before ids, sorted.
    pub sources: Vec<Contribution>,
}

#[derive(Clone, Debug)]
pub(crate) struct SplitGroup {
    /// Before id of the node that splits.
    pub source: Id,
    /// New after ids, sorted.
    pub targets: Vec<Contribution>,
}

/// Merges and splits, with lookups by member (`Restructuring`).
#[derive(Debug, Default)]
pub(crate) struct Restructuring {
    /// Sorted by target.
    pub merges: Vec<MergeGroup>,
    /// Sorted by source.
    pub splits: Vec<SplitGroup>,
    /// Merge group (index into `merges`) by source (before id).
    pub merge_by_source: Lookup<Id, usize>,
    /// Merge group by target (after id).
    pub merge_by_target: Lookup<Id, usize>,
    /// Split group by source (before id).
    pub split_by_source: Lookup<Id, usize>,
    /// Split group by new target (after id).
    pub split_by_target: Lookup<Id, usize>,
    pub suggestions: Vec<MatchSuggestion>,
}

impl Restructuring {
    pub fn merge_of_source(&self, id: &str) -> Option<&MergeGroup> {
        self.merge_by_source.get(id).map(|&i| &self.merges[i])
    }
    pub fn merge_of_target(&self, id: &str) -> Option<&MergeGroup> {
        self.merge_by_target.get(id).map(|&i| &self.merges[i])
    }
    pub fn split_of_source(&self, id: &str) -> Option<&SplitGroup> {
        self.split_by_source.get(id).map(|&i| &self.splits[i])
    }
    pub fn split_of_target(&self, id: &str) -> Option<&SplitGroup> {
        self.split_by_target.get(id).map(|&i| &self.splits[i])
    }
}

struct Context<'a> {
    before: &'a KGraph,
    after: &'a KGraph,
    b2a: &'a IndexMap<Id, Id>,
    a2b: &'a IndexMap<Id, Id>,
    ignore_attrs: &'a StringSet,
}

/// Neighbourhoods up to this size are searched exhaustively; larger ones by name.
const SMALL_NEIGHBOURHOOD: usize = 32;
/// Name keys shared by more members than this are too common to be worth following.
const COMMON_KEY: usize = 32;

/// Name keys of node texts, memoized across the merge and the split phase.
type TextKeys = Lookup<String, std::rc::Rc<Vec<NameKey>>>;

/// Candidate generation for the heuristics, memoized (`Neighbourhoods`).
struct Neighbourhoods<'a> {
    graph: &'a KGraph,
    members: Lookup<String, Vec<Id>>,
    names: Lookup<String, Lookup<NameKey, Vec<Id>>>,
}

fn keys_of(node: &KGNode, text_keys: &mut TextKeys) -> std::rc::Rc<Vec<NameKey>> {
    let texts: Vec<&str> = std::iter::once(node.label.as_str())
        .chain(node.aliases.iter().map(JsStr::as_str))
        .collect();
    let text = texts.join("\u{0}");
    text_keys
        .get_or_insert_with(text, || std::rc::Rc::new(name_keys(&texts)))
        .clone()
}

impl<'a> Neighbourhoods<'a> {
    fn new(graph: &'a KGraph) -> Self {
        Neighbourhoods {
            graph,
            members: Lookup::new(),
            names: Lookup::new(),
        }
    }

    /// Nodes `c` with an edge `(c, predicate, anchor)` (`incoming`) or `(anchor, predicate, c)`
    /// whose names may match `query`.
    fn candidates(
        &mut self,
        incoming: bool,
        predicate: &str,
        anchor: &Id,
        query: &[NameKey],
        text_keys: &mut TextKeys,
    ) -> Vec<Id> {
        let key = format!(
            "{}{predicate}\u{0}{anchor}",
            if incoming { '<' } else { '>' }
        );
        let members = self.members_of(&key, incoming, predicate, anchor);
        if members.len() <= SMALL_NEIGHBOURHOOD {
            return members;
        }
        if !self.names.contains_key(&key) {
            let mut index: Lookup<NameKey, Vec<Id>> = Lookup::new();
            for id in &members {
                if let Some(node) = self.graph.nodes.get(id) {
                    for k in keys_of(node, text_keys).iter() {
                        index
                            .get_or_insert_with(k.clone(), Vec::new)
                            .push(id.clone());
                    }
                }
            }
            self.names.insert(key.clone(), index);
        }
        let index = &self.names.get(&key).unwrap_or_else(|| unreachable!());
        let mut found: IndexSet<Id> = IndexSet::new();
        for k in query {
            if let Some(postings) = index.get(k)
                && postings.len() <= COMMON_KEY
            {
                found.extend(postings.iter().cloned());
            }
        }
        found.into_iter().collect()
    }

    fn members_of(&mut self, key: &str, incoming: bool, predicate: &str, anchor: &Id) -> Vec<Id> {
        if let Some(found) = self.members.get(key) {
            return found.clone();
        }
        let graph = self.graph;
        let keys = if incoming {
            graph.incoming.get(anchor)
        } else {
            graph.outgoing.get(anchor)
        };
        let mut ends: IndexSet<Id> = IndexSet::new();
        for k in keys.into_iter().flatten() {
            if let Some(edge) = graph.edges.get(k)
                && edge.predicate == *predicate
            {
                ends.insert(if incoming {
                    edge.source.clone()
                } else {
                    edge.target.clone()
                });
            }
        }
        let found: Vec<Id> = ends.into_iter().collect();
        self.members.insert(key.to_owned(), found.clone());
        found
    }
}

/// Whether a graph has an edge `(source, predicate, target)`, any copy, any id (`Triples`).
struct Triples<'a> {
    graph: &'a KGraph,
    set: Option<Lookup<JsStr, ()>>,
}

impl<'a> Triples<'a> {
    fn new(graph: &'a KGraph) -> Self {
        Triples { graph, set: None }
    }

    fn has(&mut self, source: &str, predicate: &str, target: &str) -> bool {
        let key = triple_key(source, predicate, target);
        if self.graph.edge_identity == EdgeIdentity::Structure {
            return self.graph.edges.contains_key(&key);
        }
        let graph = self.graph;
        let set = self.set.get_or_insert_with(|| {
            let mut set = Lookup::new();
            for e in graph.edges.values() {
                set.insert(triple_key(&e.source, &e.predicate, &e.target), ());
            }
            set
        });
        set.contains_key(&key)
    }
}

/// Best name evidence of `text` against a node's label and aliases (`nameEvidence`).
fn name_evidence(text: &JsStr, node: &KGNode, profiles: &mut ProfileCache) -> f64 {
    let p = profiles.get(text);
    let mut best = profile_similarity(&p, &profiles.get(&node.label));
    for alias in &node.aliases {
        if best == 1.0 {
            break;
        }
        best = js::math::max(best, profile_similarity(&p, &profiles.get(alias)));
    }
    best
}

/// `text ∈ node.aliases`, comparing normalized text (`isSynonym`).
fn is_synonym(text: &JsStr, node: &KGNode, profiles: &mut ProfileCache) -> bool {
    let p = profiles.get(text);
    node.aliases
        .iter()
        .any(|alias| profile_similarity(&p, &profiles.get(alias)) == 1.0)
}

/// One edge of the subject: direction, predicate and the mapped other end.
struct SubjectEdge {
    out: bool,
    predicate: JsStr,
    other: Option<Id>,
}

/// Carry-over candidates of `subject` on the other side (`carryOver`).
struct CarryOver {
    candidates: IndexSet<Id>,
    edges: Vec<SubjectEdge>,
}

impl CarryOver {
    fn total(&self) -> usize {
        self.edges.len()
    }

    fn carried(&self, candidate: &str, triples: &mut Triples<'_>) -> usize {
        self.edges
            .iter()
            .filter(|e| match &e.other {
                None => false,
                Some(other) if e.out => triples.has(candidate, &e.predicate, other),
                Some(other) => triples.has(other, &e.predicate, candidate),
            })
            .count()
    }
}

fn carry_over(
    graph: &KGraph,
    subject: &KGNode,
    map: &IndexMap<Id, Id>,
    neighbourhoods: &mut Neighbourhoods<'_>,
    text_keys: &mut TextKeys,
) -> CarryOver {
    let query = keys_of(subject, text_keys);
    let mut edges = Vec::new();
    let mut candidates: IndexSet<Id> = IndexSet::new();
    for out in [true, false] {
        let keys = if out {
            graph.outgoing.get(&subject.id)
        } else {
            graph.incoming.get(&subject.id)
        };
        for key in keys.into_iter().flatten() {
            let Some(edge) = graph.edges.get(key) else {
                continue;
            };
            let end = if out { &edge.target } else { &edge.source };
            let other = if *end == subject.id {
                None
            } else {
                map.get(end).cloned()
            };
            if let Some(other) = &other {
                for c in neighbourhoods.candidates(out, &edge.predicate, other, &query, text_keys) {
                    candidates.insert(c);
                }
            }
            edges.push(SubjectEdge {
                out,
                predicate: edge.predicate.clone(),
                other,
            });
        }
    }
    CarryOver { candidates, edges }
}

struct Scored {
    candidate: Id,
    label: f64,
    carry: f64,
    confidence: f64,
}

/// Best heuristic counterpart of `subject` (`bestHeuristic`, docs/algorithms.md §3).
fn best_heuristic(
    subject: &KGNode,
    found: &CarryOver,
    other: &KGraph,
    triples: &mut Triples<'_>,
    profiles: &mut ProfileCache,
    accept: &dyn Fn(&Id) -> bool,
    synonyms_of_subject: bool,
) -> Option<Scored> {
    let mut best: Option<Scored> = None;
    let mut candidates: Vec<&Id> = found.candidates.iter().collect();
    candidates.sort();
    for candidate in candidates {
        if !accept(candidate) {
            continue;
        }
        let Some(node) = other.nodes.get(candidate) else {
            continue;
        };
        let mut label = name_evidence(&subject.label, node, profiles);
        if synonyms_of_subject && label < 1.0 && is_synonym(&node.label, subject, profiles) {
            label = 1.0;
        }
        if label < LABEL_EVIDENCE {
            continue;
        }
        let carry = count_to_f64(found.carried(candidate, triples)) / count_to_f64(found.total());
        if carry < CARRY_OVER {
            continue;
        }
        let confidence = round6(0.5 * label + 0.5 * carry);
        if best.as_ref().is_none_or(|b| confidence > b.confidence) {
            best = Some(Scored {
                candidate: candidate.clone(),
                label,
                carry,
                confidence,
            });
        }
    }
    best
}

fn suggestion(
    ctx: &Context<'_>,
    before_id: &Id,
    after_id: &Id,
    scored: &Scored,
) -> MatchSuggestion {
    let b = &ctx.before.nodes[before_id];
    let a = &ctx.after.nodes[after_id];
    MatchSuggestion {
        before: before_id.clone(),
        after: after_id.clone(),
        score: scored.confidence,
        evidence: evidence_of(
            scored.label,
            Some(scored.carry),
            type_evidence(&b.types, &a.types),
            attr_evidence(b, a, ctx.ignore_attrs),
        ),
        reason: SuggestionReason::BelowThreshold,
    }
}

/// Detects merges and splits (`detectRestructuring`). Deterministic: all candidates are visited
/// in id order.
pub(crate) fn detect_restructuring(
    before: &KGraph,
    after: &KGraph,
    alignment: &Alignment,
    detect_merges: bool,
    detect_splits: bool,
    profiles: &mut ProfileCache,
    ignore_attrs: &StringSet,
) -> Restructuring {
    let ctx = Context {
        before,
        after,
        b2a: &alignment.before_to_after,
        a2b: &alignment.after_to_before,
        ignore_attrs,
    };
    let mut text_keys: TextKeys = Lookup::new();
    let mut out = Restructuring::default();
    if detect_merges {
        out.merges = detect_merges_of(&ctx, profiles, &mut text_keys, &mut out.suggestions);
    }
    for (i, group) in out.merges.iter().enumerate() {
        out.merge_by_target.insert(group.target.clone(), i);
        for s in &group.sources {
            out.merge_by_source.insert(s.id.clone(), i);
        }
    }
    if detect_splits {
        let mut suggestions = std::mem::take(&mut out.suggestions);
        out.splits = detect_splits_of(&ctx, &out, profiles, &mut text_keys, &mut suggestions);
        out.suggestions = suggestions;
    }
    for (i, group) in out.splits.iter().enumerate() {
        out.split_by_source.insert(group.source.clone(), i);
        for t in &group.targets {
            out.split_by_target.insert(t.id.clone(), i);
        }
    }
    out
}

// ─── Merges ──────────────────────────────────────────────────────────────────

fn detect_merges_of(
    ctx: &Context<'_>,
    profiles: &mut ProfileCache,
    text_keys: &mut TextKeys,
    suggestions: &mut Vec<MatchSuggestion>,
) -> Vec<MergeGroup> {
    let Context {
        before,
        after,
        b2a,
        a2b,
        ..
    } = *ctx;
    let to_after = |id: &Id| {
        if after.nodes.contains_key(id) {
            Some(id.clone())
        } else {
            b2a.get(id).cloned()
        }
    };
    let to_before = |id: &Id| {
        if before.nodes.contains_key(id) {
            Some(id.clone())
        } else {
            a2b.get(id).cloned()
        }
    };

    // A before node can merge away when it disappears or becomes deprecated.
    let can_merge_away = |x: &Id| match b2a.get(x) {
        None => true,
        Some(xa) => after.nodes.get(xa).is_some_and(|n| n.deprecated),
    };
    // Hints already present (and acted upon) in the before version are not changes.
    let hinted_before = |x: &Id, target: &Id| -> bool {
        let xb = &before.nodes[x];
        if !xb.deprecated || !b2a.contains_key(x) {
            return false;
        }
        if xb
            .replaced_by
            .iter()
            .any(|r| to_after(r).as_ref() == Some(target))
        {
            return true;
        }
        a2b.get(target)
            .is_some_and(|y| before.nodes.get(y).is_some_and(|n| n.replaces.contains(x)))
    };

    let mut hints: IndexMap<Id, IndexSet<Id>> = IndexMap::new();
    let mut hint = |x: Option<Id>, target: Option<Id>| {
        let (Some(x), Some(target)) = (x, target) else {
            return;
        };
        if b2a.get(&x) == Some(&target) || !can_merge_away(&x) || hinted_before(&x, &target) {
            return;
        }
        hints.entry(x).or_default().insert(target);
    };
    for node in before.nodes.values() {
        for r in &node.replaced_by {
            hint(Some(node.id.clone()), to_after(r));
        }
    }
    for node in after.nodes.values() {
        if !node.replaced_by.is_empty() {
            let x = a2b.get(&node.id).cloned();
            for r in &node.replaced_by {
                hint(x.clone(), to_after(r));
            }
        }
        for r in &node.replaces {
            hint(to_before(r), Some(node.id.clone()));
        }
    }

    // A hinted target is valid when it absorbs into a surviving node or gathers ≥ 2 sources.
    let mut hinted_sources: IndexMap<Id, Vec<Id>> = IndexMap::new();
    for (x, targets) in &hints {
        for t in targets {
            hinted_sources.entry(t.clone()).or_default().push(x.clone());
        }
    }
    let valid = |t: &Id| a2b.contains_key(t) || hinted_sources.get(t).map_or(0, Vec::len) >= 2;

    let mut assigned: IndexMap<Id, Vec<Contribution>> = IndexMap::new();
    let mut merged: Lookup<Id, ()> = Lookup::new();
    let mut sources: Vec<&Id> = hints.keys().collect();
    sources.sort();
    for x in sources {
        let mut targets: Vec<&Id> = hints[x].iter().collect();
        targets.sort();
        let Some(target) = targets.into_iter().find(|t| valid(t)) else {
            continue;
        };
        assigned
            .entry(target.clone())
            .or_default()
            .push(Contribution {
                id: x.clone(),
                confidence: 1.0,
                via: Via::Hint,
            });
        merged.insert(x.clone(), ());
    }

    // Heuristic: an unmatched node whose name lives on in a matched node that carries its edges.
    let mut neighbourhoods = Neighbourhoods::new(after);
    let mut triples = Triples::new(after);
    let mut unmatched: Vec<&Id> = before
        .nodes
        .keys()
        .filter(|x| !b2a.contains_key(*x) && !merged.contains_key(*x))
        .collect();
    unmatched.sort();
    for x in unmatched {
        let xb = &before.nodes[x];
        let found = carry_over(before, xb, b2a, &mut neighbourhoods, text_keys);
        if found.candidates.is_empty() {
            continue;
        }
        let accept = |t: &Id| a2b.contains_key(t);
        let Some(best) = best_heuristic(xb, &found, after, &mut triples, profiles, &accept, false)
        else {
            continue;
        };
        if best.confidence >= ACCEPT {
            assigned
                .entry(best.candidate.clone())
                .or_default()
                .push(Contribution {
                    id: x.clone(),
                    confidence: best.confidence,
                    via: Via::Heuristic,
                });
        } else {
            suggestions.push(suggestion(ctx, x, &best.candidate, &best));
        }
    }

    group_merges(&assigned, a2b)
}

/// Turns per-target contributions into merge groups (`groupMerges`): a target that merges away
/// itself forwards its sources to the final target; targets that merge into each other in a
/// cycle are not merges. A group needs a surviving target or ≥ 2 sources.
fn group_merges(
    assigned: &IndexMap<Id, Vec<Contribution>>,
    a2b: &IndexMap<Id, Id>,
) -> Vec<MergeGroup> {
    let mut target_of: Lookup<Id, Id> = Lookup::new();
    for (target, sources) in assigned {
        for s in sources {
            target_of.insert(s.id.clone(), target.clone());
        }
    }
    let mut finals: Lookup<Id, Option<Id>> = Lookup::new();
    let mut resolve = |target: &Id| -> Option<Id> {
        if let Some(known) = finals.get(target) {
            return known.clone();
        }
        let mut path: Vec<Id> = Vec::new();
        let mut seen: Lookup<Id, ()> = Lookup::new();
        let mut current = Some(target.clone());
        let mut result: Option<Id> = None;
        while let Some(c) = current {
            if let Some(cached) = finals.get(&c) {
                result = cached.clone();
                break;
            }
            if seen.contains_key(&c) {
                break; // a cycle: none of its members is a merge target
            }
            seen.insert(c.clone(), ());
            path.push(c.clone());
            let next = a2b
                .get(&c)
                .and_then(|survivor| target_of.get(survivor))
                .cloned();
            match next {
                None => {
                    result = Some(c);
                    break;
                }
                Some(n) => current = Some(n),
            }
        }
        for t in path {
            finals.insert(t, result.clone());
        }
        result
    };
    let mut by_final: IndexMap<Id, Vec<Contribution>> = IndexMap::new();
    let mut targets: Vec<&Id> = assigned.keys().collect();
    targets.sort();
    for target in targets {
        let Some(end) = resolve(target) else { continue };
        for s in &assigned[target] {
            if a2b.get(&end) != Some(&s.id) {
                by_final.entry(end.clone()).or_default().push(s.clone());
            }
        }
    }
    let mut finals_sorted: Vec<&Id> = by_final.keys().collect();
    finals_sorted.sort();
    let mut groups = Vec::new();
    for target in finals_sorted {
        let mut sources = by_final[target].clone();
        sources.sort_by(|p, q| p.id.cmp(&q.id));
        if !a2b.contains_key(target) && sources.len() < 2 {
            continue;
        }
        groups.push(MergeGroup {
            target: target.clone(),
            sources,
        });
    }
    groups
}

// ─── Splits ──────────────────────────────────────────────────────────────────

fn detect_splits_of(
    ctx: &Context<'_>,
    merges: &Restructuring,
    profiles: &mut ProfileCache,
    text_keys: &mut TextKeys,
    suggestions: &mut Vec<MatchSuggestion>,
) -> Vec<SplitGroup> {
    let Context {
        before,
        after,
        b2a,
        a2b,
        ..
    } = *ctx;
    let to_before = |id: &Id| {
        if before.nodes.contains_key(id) {
            Some(id.clone())
        } else {
            a2b.get(id).cloned()
        }
    };
    // Split targets are new nodes that take no part in a merge.
    let is_new_target = |t: &Id| {
        after.nodes.contains_key(t)
            && !a2b.contains_key(t)
            && !merges.merge_by_target.contains_key(t)
    };
    let can_split =
        |x: &Id| before.nodes.contains_key(x) && !merges.merge_by_source.contains_key(x);

    let mut found: IndexMap<Id, IndexMap<Id, Contribution>> = IndexMap::new();
    let add = |found: &mut IndexMap<Id, IndexMap<Id, Contribution>>,
               x: Option<Id>,
               t: &Id,
               confidence: f64,
               via: Via| {
        let Some(x) = x else { return };
        if !can_split(&x) || !is_new_target(t) {
            return;
        }
        found
            .entry(x)
            .or_default()
            .entry(t.clone())
            .or_insert_with(|| Contribution {
                id: t.clone(),
                confidence,
                via,
            });
    };
    for node in after.nodes.values() {
        for r in &node.replaces {
            add(&mut found, to_before(r), &node.id, 1.0, Via::Hint);
        }
        if !node.replaced_by.is_empty() {
            let x = a2b.get(&node.id).cloned();
            for r in &node.replaced_by {
                add(&mut found, x.clone(), r, 1.0, Via::Hint);
            }
        }
    }
    for node in before.nodes.values() {
        for r in &node.replaced_by {
            add(&mut found, Some(node.id.clone()), r, 1.0, Via::Hint);
        }
    }

    // Heuristic: a new node named like an existing one that takes over its edges.
    let mut hinted: Lookup<Id, ()> = Lookup::new();
    for targets in found.values() {
        for t in targets.keys() {
            hinted.insert(t.clone(), ());
        }
    }
    let mut neighbourhoods = Neighbourhoods::new(before);
    let mut triples = Triples::new(before);
    let mut fresh: Vec<&Id> = after
        .nodes
        .keys()
        .filter(|t| is_new_target(t) && !hinted.contains_key(*t))
        .collect();
    fresh.sort();
    for t in fresh {
        let ta = &after.nodes[t];
        let carried = carry_over(after, ta, a2b, &mut neighbourhoods, text_keys);
        if carried.candidates.is_empty() {
            continue;
        }
        let Some(best) = best_heuristic(
            ta,
            &carried,
            before,
            &mut triples,
            profiles,
            &can_split,
            true,
        ) else {
            continue;
        };
        if best.confidence >= ACCEPT {
            add(
                &mut found,
                Some(best.candidate.clone()),
                t,
                best.confidence,
                Via::Heuristic,
            );
        } else {
            suggestions.push(suggestion(ctx, &best.candidate, t, &best));
        }
    }

    let mut sources: Vec<&Id> = found.keys().collect();
    sources.sort();
    let mut groups = Vec::new();
    for source in sources {
        let mut targets: Vec<Contribution> = found[source].values().cloned().collect();
        targets.sort_by(|p, q| p.id.cmp(&q.id));
        let survivor = b2a
            .get(source)
            .filter(|m| !after.nodes.get(*m).is_some_and(|n| n.deprecated));
        if targets.len() + usize::from(survivor.is_some()) < 2 {
            continue;
        }
        groups.push(SplitGroup {
            source: source.clone(),
            targets,
        });
    }
    groups
}
