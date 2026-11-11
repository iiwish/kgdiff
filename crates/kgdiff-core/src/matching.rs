//! Node matching (`match.ts`, docs/algorithms.md §2): exact ids, then 1:1 replacement hints, then
//! blocked similarity matching with weighted evidence, an unambiguity margin and neighbour
//! propagation.

use std::cmp::Ordering;

use crate::js::{IndexMap, IndexSet};

use crate::canonical::{attr_keys, attr_value_equals};
use crate::js::{self, JsStr, Lookup};
use crate::model::{
    Id, KGNode, KGraph, MatchEvidence, MatchMethod, MatchSuggestion, NodeMatch, SuggestionReason,
};
use crate::options::{MatchOptions, MatchStrategy};
use crate::text::{ProfileCache, block_keys, profile_similarity};
use crate::util::{count_to_f64, f64_to_count, round6};

/// Evidence weights (docs/algorithms.md §2, step 5).
const W_LABEL: f64 = 0.55;
const W_NEIGHBORS: f64 = 0.25;
const W_TYPES: f64 = 0.1;
const W_ATTRS: f64 = 0.1;
/// Below this label similarity the score is capped at the same value.
const LABEL_FLOOR: f64 = 0.5;
/// Required lead over the second-best alternative on both sides.
const MARGIN: f64 = 0.05;
const EPSILON: f64 = 1e-9;
const MAX_ROUNDS: usize = 5;

/// The result of aligning two versions (`Alignment`).
#[derive(Debug, Default)]
pub(crate) struct Alignment {
    pub before_to_after: IndexMap<Id, Id>,
    pub after_to_before: IndexMap<Id, Id>,
    /// Matches not implied by equal ids (methods `hint` and `similarity`), by before id.
    pub inferred: IndexMap<Id, NodeMatch>,
    pub suggestions: Vec<MatchSuggestion>,
}

/// A set of strings for membership tests.
pub(crate) type StringSet = Lookup<JsStr, ()>;

fn node_texts(node: &KGNode) -> impl Iterator<Item = &JsStr> {
    std::iter::once(&node.label).chain(node.aliases().iter())
}

/// `label` evidence: max similarity of each label against the other node's label ∪ aliases.
fn label_evidence(a: &KGNode, b: &KGNode, profiles: &mut ProfileCache) -> f64 {
    let la = profiles.get(&a.label);
    let lb = profiles.get(&b.label);
    let mut best = profile_similarity(&la, &lb);
    for alias in b.aliases() {
        if best == 1.0 {
            return 1.0;
        }
        best = js::math::max(best, profile_similarity(&la, &profiles.get(alias)));
    }
    for alias in a.aliases() {
        if best == 1.0 {
            return 1.0;
        }
        best = js::math::max(best, profile_similarity(&lb, &profiles.get(alias)));
    }
    best
}

/// Jaccard of two sorted, unique lists; `None` when both are empty (`typeEvidence`).
pub(crate) fn type_evidence(a: &[JsStr], b: &[JsStr]) -> Option<f64> {
    if a.is_empty() && b.is_empty() {
        return None;
    }
    let shared = a.iter().filter(|t| b.contains(t)).count();
    Some(count_to_f64(shared) / count_to_f64(a.len() + b.len() - shared))
}

/// |equal key-value pairs| / |union of keys|; `None` when there is no key (`attrEvidence`).
pub(crate) fn attr_evidence(a: &KGNode, b: &KGNode, ignore: &StringSet) -> Option<f64> {
    let (mut union, mut equal) = (0usize, 0usize);
    for key in attr_keys(&a.attrs) {
        if ignore.contains_key(&key) {
            continue;
        }
        union += 1;
        if attr_value_equals(a.attrs.get(&key), b.attrs.get(&key)) {
            equal += 1;
        }
    }
    for key in attr_keys(&b.attrs) {
        if !ignore.contains_key(&key) && a.attrs.get(&key).is_none() {
            union += 1;
        }
    }
    (union > 0).then(|| count_to_f64(equal) / count_to_f64(union))
}

/// Weighted average of the present signals, capped when the names are unrelated
/// (`combineEvidence`).
fn combine_evidence(
    label: f64,
    neighbors: Option<f64>,
    types: Option<f64>,
    attrs: Option<f64>,
) -> f64 {
    let mut sum = W_LABEL * label;
    let mut weight = W_LABEL;
    if let Some(n) = neighbors {
        sum += W_NEIGHBORS * n;
        weight += W_NEIGHBORS;
    }
    if let Some(t) = types {
        sum += W_TYPES * t;
        weight += W_TYPES;
    }
    if let Some(a) = attrs {
        sum += W_ATTRS * a;
        weight += W_ATTRS;
    }
    let score = sum / weight;
    round6(if label < LABEL_FLOOR {
        js::math::min(score, LABEL_FLOOR)
    } else {
        score
    })
}

/// `evidenceOf`.
pub(crate) fn evidence_of(
    label: f64,
    neighbors: Option<f64>,
    types: Option<f64>,
    attrs: Option<f64>,
) -> MatchEvidence {
    MatchEvidence {
        label: round6(label),
        neighbors: round6(neighbors.unwrap_or(0.0)),
        types: round6(types.unwrap_or(0.0)),
        attrs: round6(attrs.unwrap_or(0.0)),
    }
}

// ─── Neighbour signatures ────────────────────────────────────────────────────

/// Sorted `(direction, predicate, matched counterpart)` keys with their weights.
#[derive(Debug, Default)]
struct Signature {
    keys: Vec<JsStr>,
    weights: Vec<f64>,
}

/// `1 / log₂(2 + degree)` of the after-version counterpart (`counterpartWeight`).
fn counterpart_weight(after: &KGraph, id: &str) -> f64 {
    1.0 / js::math::log2(2.0 + count_to_f64(after.degree(Some(id))))
}

fn build_signature(
    graph: &KGraph,
    id: &str,
    counterpart: &dyn Fn(&Id) -> Option<Id>,
    after: &KGraph,
) -> Signature {
    let mut acc: IndexMap<JsStr, f64> = IndexMap::default();
    let mut visit = |outgoing: bool| {
        for edge in graph.adjacent(id, outgoing) {
            let Some(other) = counterpart(if outgoing {
                edge.target()
            } else {
                edge.source()
            }) else {
                continue;
            };
            let sig = JsStr::from(format!(
                "{}{}\u{0}{}",
                if outgoing { '>' } else { '<' },
                edge.predicate(),
                other
            ));
            let weight = counterpart_weight(after, &other);
            *acc.entry(sig).or_insert(0.0) += weight;
        }
    };
    visit(true);
    visit(false);
    if acc.is_empty() {
        return Signature::default();
    }
    let mut keys: Vec<JsStr> = acc.keys().cloned().collect();
    keys.sort();
    let weights = keys.iter().map(|k| acc[k]).collect();
    Signature { keys, weights }
}

/// Weighted Jaccard Σmin / Σmax; `None` when neither side has matched neighbours.
fn neighbor_evidence(a: &Signature, b: &Signature) -> Option<f64> {
    if a.keys.is_empty() && b.keys.is_empty() {
        return None;
    }
    let (mut min, mut max) = (0.0, 0.0);
    let (mut i, mut j) = (0, 0);
    while i < a.keys.len() || j < b.keys.len() {
        match (a.keys.get(i), b.keys.get(j)) {
            (Some(ka), Some(kb)) if ka < kb => {
                max += a.weights[i];
                i += 1;
            }
            (Some(_), None) => {
                max += a.weights[i];
                i += 1;
            }
            (Some(ka), Some(kb)) if kb < ka => {
                max += b.weights[j];
                j += 1;
            }
            (None, Some(_)) => {
                max += b.weights[j];
                j += 1;
            }
            _ => {
                let (wa, wb) = (a.weights[i], b.weights[j]);
                min += js::math::min(wa, wb);
                max += js::math::max(wa, wb);
                i += 1;
                j += 1;
            }
        }
    }
    if max == 0.0 { None } else { Some(min / max) }
}

/// Whether `id` has an edge to another node (`hasNeighbour`).
fn has_neighbour(graph: &KGraph, id: &str) -> bool {
    graph.outgoing(id).any(|e| e.target() != id) || graph.incoming(id).any(|e| e.source() != id)
}

// ─── Candidate generation ────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Pair {
    r: usize,
    a: usize,
    /// Both nodes carry the same id (only possible with strategy `similarity`).
    same_id: bool,
    label: f64,
    score: f64,
    neighbors: Option<f64>,
    types: Option<f64>,
    attrs: Option<f64>,
}

fn keys_of(node: &KGNode, profiles: &mut ProfileCache) -> IndexSet<String> {
    let mut keys = IndexSet::default();
    for text in node_texts(node) {
        block_keys(&profiles.get(text), &mut keys);
    }
    keys
}

/// Blocking from one side (`blockedCandidates`): an inverted index over `targets`; each query
/// collects the targets sharing a key, ranked by IDF-weighted key overlap, then keeps the
/// `max_candidates` with the best label similarity.
fn blocked_candidates(
    queries: &[&KGNode],
    targets: &[&KGNode],
    max_candidates: f64,
    prune_below_floor: bool,
    profiles: &mut ProfileCache,
    emit: &mut dyn FnMut(usize, usize, f64),
) {
    let mut index: Lookup<String, Vec<usize>> = Lookup::new();
    let mut by_id: Lookup<Id, usize> = Lookup::new();
    for (i, node) in targets.iter().enumerate() {
        by_id.insert(node.id.clone(), i);
        for key in keys_of(node, profiles) {
            index.get_or_insert_with(key, Vec::new).push(i);
        }
    }
    let max_postings = f64_to_count(js::math::max(64.0, max_candidates * 8.0));
    let preselect = f64_to_count(max_candidates * 3.0);
    let keep = f64_to_count(max_candidates);
    for (q, node) in queries.iter().enumerate() {
        let mut lists: Vec<(String, &Vec<usize>)> = Vec::new();
        for key in keys_of(node, profiles) {
            if let Some(postings) = index.get(&key) {
                lists.push((key, postings));
            }
        }
        let same = by_id.get(&node.id).copied();
        if lists.is_empty() && same.is_none() {
            continue;
        }
        lists.sort_by(|x, y| {
            x.1.len()
                .cmp(&y.1.len())
                .then_with(|| js::cmp_utf16(&x.0, &y.0))
        });
        let mut overlap: IndexMap<usize, f64> = IndexMap::default();
        if let Some(same) = same {
            overlap.insert(same, 0.0);
        }
        for (_, postings) in &lists {
            if postings.len() > max_postings && overlap.len() >= preselect {
                continue;
            }
            let weight = 1.0 / js::math::log2(1.0 + count_to_f64(postings.len()));
            let limit = postings.len().min(max_postings);
            for &t in &postings[..limit] {
                *overlap.entry(t).or_insert(0.0) += weight;
            }
        }
        let own = |t: usize| usize::from(targets[t].id != node.id);
        let mut ranked: Vec<(usize, f64)> = overlap
            .iter()
            .map(|(&t, &weight)| {
                let shares_type = !node.types.is_empty()
                    && targets[t].types.iter().any(|ty| node.types.contains(ty));
                (t, weight + if shares_type { 1e-3 } else { 0.0 })
            })
            .collect();
        ranked.sort_by(|x, y| {
            own(x.0)
                .cmp(&own(y.0))
                .then_with(|| desc(x.1, y.1))
                .then_with(|| x.0.cmp(&y.0))
        });
        let mut scored: Vec<(usize, f64)> = Vec::new();
        for &(t, _) in ranked.iter().take(preselect) {
            let label = label_evidence(node, targets[t], profiles);
            if !prune_below_floor || label >= LABEL_FLOOR {
                scored.push((t, label));
            }
        }
        scored.sort_by(|x, y| {
            desc(x.1, y.1)
                .then_with(|| own(x.0).cmp(&own(y.0)))
                .then_with(|| x.0.cmp(&y.0))
        });
        for &(t, label) in scored.iter().take(keep) {
            emit(q, t, label);
        }
    }
}

/// `y - x` as a comparator: larger first.
fn desc(x: f64, y: f64) -> Ordering {
    y.partial_cmp(&x).unwrap_or(Ordering::Equal)
}

/// Candidate pairs from both sides, sorted by `(r, a)` (`generateCandidates`).
fn generate_candidates(
    r_nodes: &[&KGNode],
    a_nodes: &[&KGNode],
    max_candidates: f64,
    prune_below_floor: bool,
    profiles: &mut ProfileCache,
) -> Vec<Pair> {
    let mut pairs: IndexMap<usize, Pair> = IndexMap::default();
    let width = a_nodes.len();
    let mut add = |r: usize, a: usize, label: f64| {
        pairs.entry(r * width + a).or_insert_with(|| Pair {
            r,
            a,
            same_id: r_nodes[r].id == a_nodes[a].id,
            label,
            score: 0.0,
            neighbors: None,
            types: None,
            attrs: None,
        });
    };
    blocked_candidates(
        r_nodes,
        a_nodes,
        max_candidates,
        prune_below_floor,
        profiles,
        &mut |r, a, label| add(r, a, label),
    );
    blocked_candidates(
        a_nodes,
        r_nodes,
        max_candidates,
        prune_below_floor,
        profiles,
        &mut |a, r, label| add(r, a, label),
    );
    let mut out: Vec<Pair> = pairs.into_values().collect();
    out.sort_by(|x, y| x.r.cmp(&y.r).then_with(|| x.a.cmp(&y.a)));
    out
}

/// Whether the free rival `q` makes `p` ambiguous (`blocks`).
fn blocks(q: &Pair, p: &Pair) -> bool {
    if p.score - q.score >= MARGIN - EPSILON {
        return false;
    }
    if p.score == 1.0 && q.score < 1.0 {
        return false;
    }
    if q.score == p.score && p.same_id && !q.same_id {
        return false;
    }
    true
}

fn is_ambiguous(p: usize, rivals: &[usize], pairs: &[Pair], free: &dyn Fn(&Pair) -> bool) -> bool {
    let pp = &pairs[p];
    for &q in rivals {
        let qq = &pairs[q];
        if q == p || !free(qq) {
            continue;
        }
        if pp.score - qq.score >= MARGIN - EPSILON {
            return false; // rivals are sorted by score
        }
        if blocks(qq, pp) {
            return true;
        }
    }
    false
}

// ─── Alignment ───────────────────────────────────────────────────────────────

/// 1:1 replacement hints (`matchReplacements`, docs/algorithms.md §2, step 2).
fn match_replacements(before: &KGraph, after: &KGraph, alignment: &mut Alignment) {
    let mut targets_of: IndexMap<Id, IndexSet<Id>> = IndexMap::default();
    let mut sources_of: IndexMap<Id, IndexSet<Id>> = IndexMap::default();
    let mut link = |x: &Id, y: &Id| {
        if x == y {
            return;
        }
        targets_of.entry(x.clone()).or_default().insert(y.clone());
        sources_of.entry(y.clone()).or_default().insert(x.clone());
    };
    for x in before.nodes.values() {
        for y in x.replaced_by() {
            if after.nodes.contains_key(y) {
                link(&x.id, y);
            }
        }
    }
    for y in after.nodes.values() {
        for x in y.replaces() {
            if before.nodes.contains_key(x) {
                link(x, &y.id);
            }
        }
    }
    let mut sources: Vec<&Id> = targets_of.keys().collect();
    sources.sort();
    for x in sources {
        let targets = &targets_of[x];
        if targets.len() != 1
            || after.nodes.contains_key(x)
            || alignment.before_to_after.contains_key(x)
        {
            continue;
        }
        let y = &targets[0];
        if sources_of.get(y).map(IndexSet::len) != Some(1)
            || before.nodes.contains_key(y)
            || alignment.after_to_before.contains_key(y)
        {
            continue;
        }
        alignment.before_to_after.insert(x.clone(), y.clone());
        alignment.after_to_before.insert(y.clone(), x.clone());
        alignment.inferred.insert(
            x.clone(),
            NodeMatch {
                before: x.clone(),
                after: y.clone(),
                method: MatchMethod::Hint,
                score: 1.0,
                evidence: None,
            },
        );
    }
}

/// Aligns the nodes of two versions (`alignNodes`, docs/algorithms.md §2).
pub(crate) fn align_nodes(
    before: &KGraph,
    after: &KGraph,
    options: &MatchOptions,
    ignore_attrs: &StringSet,
    profiles: &mut ProfileCache,
) -> Alignment {
    let mut alignment = Alignment::default();
    if options.strategy != MatchStrategy::Similarity {
        for id in before.nodes.keys() {
            if after.nodes.contains_key(id) {
                alignment.before_to_after.insert(id.clone(), id.clone());
                alignment.after_to_before.insert(id.clone(), id.clone());
            }
        }
    }
    match_replacements(before, after, &mut alignment);
    if options.strategy == MatchStrategy::Id {
        return alignment;
    }

    let mut r_nodes: Vec<&KGNode> = before
        .nodes
        .values()
        .map(AsRef::as_ref)
        .filter(|n| !alignment.before_to_after.contains_key(&n.id))
        .collect();
    r_nodes.sort_by(|x, y| x.id.cmp(&y.id));
    let mut a_nodes: Vec<&KGNode> = after
        .nodes
        .values()
        .map(AsRef::as_ref)
        .filter(|n| !alignment.after_to_before.contains_key(&n.id))
        .collect();
    a_nodes.sort_by(|x, y| x.id.cmp(&y.id));
    if r_nodes.is_empty() || a_nodes.is_empty() {
        return alignment;
    }

    let prune_below_floor =
        js::math::min(options.threshold, options.suggest_threshold) > LABEL_FLOOR;
    let mut pairs = generate_candidates(
        &r_nodes,
        &a_nodes,
        options.max_candidates,
        prune_below_floor,
        profiles,
    );
    if pairs.is_empty() {
        return alignment;
    }

    let mut matched_r = vec![false; r_nodes.len()];
    let mut matched_a = vec![false; a_nodes.len()];

    // Neighbour signatures depend on the current matching, so they are rebuilt per round.
    let score = |live: &[usize], pairs: &mut [Pair], alignment: &Alignment| {
        let to_after = |id: &Id| alignment.before_to_after.get(id).cloned();
        let known = |id: &Id| {
            alignment
                .after_to_before
                .contains_key(id)
                .then(|| id.clone())
        };
        let mut sig_r: Lookup<usize, Signature> = Lookup::new();
        let mut sig_a: Lookup<usize, Signature> = Lookup::new();
        let has_matches = !alignment.before_to_after.is_empty();
        for &i in live {
            let p = &mut pairs[i];
            let (r, a) = (r_nodes[p.r], a_nodes[p.a]);
            let mut neighbors = None;
            if has_matches {
                let sr = sig_r
                    .get_or_insert_with(p.r, || build_signature(before, &r.id, &to_after, after));
                let sr = std::mem::take(sr);
                let sa =
                    sig_a.get_or_insert_with(p.a, || build_signature(after, &a.id, &known, after));
                neighbors = neighbor_evidence(&sr, sa);
                sig_r.insert(p.r, sr);
            }
            p.neighbors = neighbors;
            p.types = type_evidence(&r.types, &a.types);
            p.attrs = attr_evidence(r, a, ignore_attrs);
            p.score = combine_evidence(p.label, neighbors, p.types, p.attrs);
        }
    };

    // R and A are sorted by id, so index order is id order.
    let by_score = |pairs: &[Pair], x: usize, y: usize| {
        let (x, y) = (&pairs[x], &pairs[y]);
        desc(x.score, y.score)
            .then_with(|| y.same_id.cmp(&x.same_id))
            .then_with(|| x.r.cmp(&y.r))
            .then_with(|| x.a.cmp(&y.a))
    };

    let awaits_neighbours = |p: &Pair| -> bool {
        if p.neighbors.is_some() || p.types != Some(0.0) || p.attrs.unwrap_or(0.0) > 0.0 {
            return false;
        }
        let (r, a) = (r_nodes[p.r], a_nodes[p.a]);
        if r.types.is_empty() || a.types.is_empty() {
            return false; // a type was only added
        }
        has_neighbour(before, &r.id) || has_neighbour(after, &a.id)
    };

    let mut live: Vec<usize> = (0..pairs.len()).collect();
    let mut accepted_in_last_round = 0;
    for round in 0..MAX_ROUNDS {
        live.retain(|&i| !matched_r[pairs[i].r] && !matched_a[pairs[i].a]);
        if live.is_empty() {
            break;
        }
        score(&live, &mut pairs, &alignment);
        live.sort_by(|&x, &y| by_score(&pairs, x, y));
        let mut by_r: IndexMap<usize, Vec<usize>> = IndexMap::default();
        let mut by_a: IndexMap<usize, Vec<usize>> = IndexMap::default();
        for &i in &live {
            by_r.entry(pairs[i].r).or_default().push(i);
            by_a.entry(pairs[i].a).or_default().push(i);
        }
        // One pass of greedy assignment over the sorted live pairs.
        let assign = |deferring: bool,
                      matched_r: &mut Vec<bool>,
                      matched_a: &mut Vec<bool>,
                      alignment: &mut Alignment,
                      deferred: &mut usize|
         -> usize {
            let mut accepted = 0;
            for &i in &live {
                let p = &pairs[i];
                if p.score < options.threshold {
                    break;
                }
                if matched_r[p.r] || matched_a[p.a] {
                    continue;
                }
                let free_a = |q: &Pair| !matched_a[q.a];
                let free_r = |q: &Pair| !matched_r[q.r];
                if is_ambiguous(
                    i,
                    by_r.get(&p.r).map_or(&[][..], Vec::as_slice),
                    &pairs,
                    &free_a,
                ) || is_ambiguous(
                    i,
                    by_a.get(&p.a).map_or(&[][..], Vec::as_slice),
                    &pairs,
                    &free_r,
                ) {
                    continue;
                }
                // A deferred pair stays free, so it still blocks its weaker rivals this round.
                if deferring && round != MAX_ROUNDS - 1 && awaits_neighbours(p) {
                    *deferred += 1;
                    continue;
                }
                let (r, a) = (r_nodes[p.r], a_nodes[p.a]);
                matched_r[p.r] = true;
                matched_a[p.a] = true;
                alignment.before_to_after.insert(r.id.clone(), a.id.clone());
                alignment.after_to_before.insert(a.id.clone(), r.id.clone());
                alignment.inferred.insert(
                    r.id.clone(),
                    NodeMatch {
                        before: r.id.clone(),
                        after: a.id.clone(),
                        method: MatchMethod::Similarity,
                        score: p.score,
                        evidence: Some(evidence_of(p.label, p.neighbors, p.types, p.attrs)),
                    },
                );
                accepted += 1;
            }
            accepted
        };
        let mut deferred = 0;
        accepted_in_last_round = assign(
            true,
            &mut matched_r,
            &mut matched_a,
            &mut alignment,
            &mut deferred,
        );
        if accepted_in_last_round == 0 && deferred > 0 {
            let mut unused = 0;
            accepted_in_last_round = assign(
                false,
                &mut matched_r,
                &mut matched_a,
                &mut alignment,
                &mut unused,
            );
        }
        if accepted_in_last_round == 0 {
            break;
        }
    }

    // Suggestions from the pairs that are still free, scored against the final matching.
    live.retain(|&i| !matched_r[pairs[i].r] && !matched_a[pairs[i].a]);
    if accepted_in_last_round > 0 {
        score(&live, &mut pairs, &alignment);
    }
    live.sort_by(|&x, &y| by_score(&pairs, x, y));
    alignment.suggestions = collect_suggestions(&live, &pairs, &r_nodes, &a_nodes, options);
    alignment
}

/// Free pairs above `threshold` were ambiguous; pairs between `suggest_threshold` and
/// `threshold` are kept when they are the best remaining option for an endpoint
/// (`collectSuggestions`).
fn collect_suggestions(
    sorted: &[usize],
    pairs: &[Pair],
    r_nodes: &[&KGNode],
    a_nodes: &[&KGNode],
    options: &MatchOptions,
) -> Vec<MatchSuggestion> {
    let mut suggestions = Vec::new();
    let mut seen_r: Lookup<usize, ()> = Lookup::new();
    let mut seen_a: Lookup<usize, ()> = Lookup::new();
    for &i in sorted {
        let p = &pairs[i];
        if p.score < options.suggest_threshold {
            break;
        }
        let first_for_r = seen_r.insert(p.r, ()).is_none();
        let first_for_a = seen_a.insert(p.a, ()).is_none();
        let ambiguous = p.score >= options.threshold;
        if !ambiguous && !first_for_r && !first_for_a {
            continue;
        }
        suggestions.push(MatchSuggestion {
            before: r_nodes[p.r].id.clone(),
            after: a_nodes[p.a].id.clone(),
            score: p.score,
            evidence: evidence_of(p.label, p.neighbors, p.types, p.attrs),
            reason: if ambiguous {
                SuggestionReason::Ambiguous
            } else {
                SuggestionReason::BelowThreshold
            },
        });
    }
    sort_suggestions(&mut suggestions);
    suggestions
}

/// By `after`, then `before` (`sortSuggestions`).
pub(crate) fn sort_suggestions(suggestions: &mut [MatchSuggestion]) {
    suggestions.sort_by(|x, y| x.after.cmp(&y.after).then_with(|| x.before.cmp(&y.before)));
}

/// The matches and suggestions of two versions (`matchNodes`): exact ids first (strategies `id`,
/// `auto`), then 1:1 replacement hints, then similarity matching of the leftovers (`auto`) or of
/// everything (`similarity`). Matches are sorted by `after`; suggestions by `after`, then
/// `before`.
pub fn match_nodes(
    before: &KGraph,
    after: &KGraph,
    options: &MatchOptions,
) -> (Vec<NodeMatch>, Vec<MatchSuggestion>) {
    let alignment = align_nodes(
        before,
        after,
        options,
        &StringSet::new(),
        &mut ProfileCache::new(),
    );
    let mut matches: Vec<NodeMatch> = alignment
        .before_to_after
        .iter()
        .map(|(b, a)| {
            alignment
                .inferred
                .get(b)
                .cloned()
                .unwrap_or_else(|| NodeMatch {
                    before: b.clone(),
                    after: a.clone(),
                    method: MatchMethod::Id,
                    score: 1.0,
                    evidence: None,
                })
        })
        .collect();
    matches.sort_by(|x, y| x.after.cmp(&y.after));
    (matches, alignment.suggestions)
}
