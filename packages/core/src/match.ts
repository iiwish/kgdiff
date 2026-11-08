/**
 * Node matching (docs/algorithms.md §2): exact ids, then 1:1 replacement hints, then blocked
 * similarity matching with weighted evidence, an unambiguity margin and neighbour propagation
 * (pairs whose label is the only support against conflicting types wait for the neighbours).
 *
 * Complexity: O(N) for id matching; similarity matching is ~O((|R| + |A|) · k · d) per round
 * (k candidates per node, d average degree) thanks to blocking. No step compares all pairs.
 */
import { attrKeys, attrValueEquals, isEmptyAttrs, ownAttr } from './canonical.js';
import { log2 } from './math.js';
import { resolveMatchOptions } from './options.js';
import { blockKeys, ProfileCache, profileSimilarity } from './text.js';
import type {
  Id,
  KGNode,
  KGraph,
  MatchEvidence,
  MatchOptions,
  MatchResult,
  MatchSuggestion,
  NodeMatch,
} from './types.js';
import { compareStrings, getOrCreate, pushTo, round6 } from './util.js';

/** Evidence weights (docs/algorithms.md §2, step 5). */
const WEIGHTS = { label: 0.55, neighbors: 0.25, types: 0.1, attrs: 0.1 } as const;
/** Below this label similarity the score is capped at the same value. */
const LABEL_FLOOR = 0.5;
/** Required lead over the second-best alternative on both sides. */
const MARGIN = 0.05;
const EPSILON = 1e-9;
const MAX_ROUNDS = 5;

export interface Alignment {
  readonly beforeToAfter: ReadonlyMap<Id, Id>;
  readonly afterToBefore: ReadonlyMap<Id, Id>;
  /** Matches not implied by equal ids (methods `hint` and `similarity`), by before id. */
  readonly inferred: ReadonlyMap<Id, NodeMatch>;
  readonly suggestions: readonly MatchSuggestion[];
}

/** The texts a node is known by: its label, then its aliases. */
function nodeTexts(node: KGNode): readonly string[] {
  return node.aliases.length ? [node.label, ...node.aliases] : [node.label];
}

/** `label` evidence: max similarity of each label against the other node's label ∪ aliases. */
function labelEvidence(a: KGNode, b: KGNode, profiles: ProfileCache): number {
  const la = profiles.get(a.label);
  const lb = profiles.get(b.label);
  let best = profileSimilarity(la, lb);
  for (const alias of b.aliases) {
    if (best === 1) return 1;
    best = Math.max(best, profileSimilarity(la, profiles.get(alias)));
  }
  for (const alias of a.aliases) {
    if (best === 1) return 1;
    best = Math.max(best, profileSimilarity(lb, profiles.get(alias)));
  }
  return best;
}

/** Jaccard of two sorted, unique string arrays; `undefined` when both are empty (missing). */
export function typeEvidence(a: readonly string[], b: readonly string[]): number | undefined {
  if (a.length === 0 && b.length === 0) return undefined;
  const inB = new Set(b);
  let shared = 0;
  for (const t of a) if (inB.has(t)) shared++;
  return shared / (a.length + b.length - shared);
}

/** |equal key-value pairs| / |union of keys|; `undefined` when both are empty (missing). */
export function attrEvidence(
  a: KGNode,
  b: KGNode,
  ignore: ReadonlySet<string>,
): number | undefined {
  if (a.attrs === b.attrs && ignore.size === 0) return isEmptyAttrs(a.attrs) ? undefined : 1;
  let union = 0;
  let equal = 0;
  for (const key of attrKeys(a.attrs)) {
    if (ignore.has(key)) continue;
    union++;
    if (attrValueEquals(a.attrs[key], ownAttr(b.attrs, key))) equal++;
  }
  for (const key of attrKeys(b.attrs)) {
    if (!ignore.has(key) && ownAttr(a.attrs, key) === undefined) union++;
  }
  return union === 0 ? undefined : equal / union;
}

/** Weighted average of the present signals, capped when the names are unrelated. */
export function combineEvidence(
  label: number,
  neighbors: number | undefined,
  types: number | undefined,
  attrs: number | undefined,
): number {
  let sum = WEIGHTS.label * label;
  let weight = WEIGHTS.label;
  if (neighbors !== undefined) {
    sum += WEIGHTS.neighbors * neighbors;
    weight += WEIGHTS.neighbors;
  }
  if (types !== undefined) {
    sum += WEIGHTS.types * types;
    weight += WEIGHTS.types;
  }
  if (attrs !== undefined) {
    sum += WEIGHTS.attrs * attrs;
    weight += WEIGHTS.attrs;
  }
  const score = sum / weight;
  return round6(label < LABEL_FLOOR ? Math.min(score, LABEL_FLOOR) : score);
}

export function evidenceOf(
  label: number,
  neighbors: number | undefined,
  types: number | undefined,
  attrs: number | undefined,
): MatchEvidence {
  return {
    label: round6(label),
    neighbors: round6(neighbors ?? 0),
    types: round6(types ?? 0),
    attrs: round6(attrs ?? 0),
  };
}

// ─── Neighbour signatures ────────────────────────────────────────────────────

/** Sorted `(key, weight)` pairs: `(direction, predicate, matched counterpart)` multiset. */
type Signature = { readonly keys: readonly string[]; readonly weights: readonly number[] };

const EMPTY_SIGNATURE: Signature = { keys: [], weights: [] };

/**
 * Hubs say little about identity, so each neighbour is weighted by 1 / log₂(2 + degree) of
 * its after-version counterpart (an IDF-like discount). `log2` is the exact one (math.ts), so the
 * weights, and the order of candidates they decide, are the same in every engine.
 */
function counterpartWeight(after: KGraph, id: Id): number {
  const degree = (after.outgoing.get(id)?.length ?? 0) + (after.incoming.get(id)?.length ?? 0);
  return 1 / log2(2 + degree);
}

function buildSignature(
  graph: KGraph,
  id: Id,
  counterpart: (neighbor: Id) => Id | undefined,
  after: KGraph,
): Signature {
  const acc = new Map<string, number>();
  const visit = (keys: readonly string[] | undefined, outgoing: boolean): void => {
    if (!keys) return;
    for (const key of keys) {
      const edge = graph.edges.get(key);
      if (!edge) continue;
      const other = counterpart(outgoing ? edge.target : edge.source);
      if (other === undefined) continue;
      const sig = `${outgoing ? '>' : '<'}${edge.predicate}\u0000${other}`;
      acc.set(sig, (acc.get(sig) ?? 0) + counterpartWeight(after, other));
    }
  };
  visit(graph.outgoing.get(id), true);
  visit(graph.incoming.get(id), false);
  if (acc.size === 0) return EMPTY_SIGNATURE;
  const keys = [...acc.keys()].sort();
  return { keys, weights: keys.map((k) => acc.get(k) as number) };
}

/** Weighted Jaccard Σmin / Σmax; `undefined` when neither side has matched neighbours. */
function neighborEvidence(a: Signature, b: Signature): number | undefined {
  if (a.keys.length === 0 && b.keys.length === 0) return undefined;
  let min = 0;
  let max = 0;
  let i = 0;
  let j = 0;
  while (i < a.keys.length || j < b.keys.length) {
    const ka = a.keys[i];
    const kb = b.keys[j];
    if (kb === undefined || (ka !== undefined && ka < kb)) {
      max += a.weights[i] as number;
      i++;
    } else if (ka === undefined || kb < ka) {
      max += b.weights[j] as number;
      j++;
    } else {
      const wa = a.weights[i] as number;
      const wb = b.weights[j] as number;
      min += Math.min(wa, wb);
      max += Math.max(wa, wb);
      i++;
      j++;
    }
  }
  return max === 0 ? undefined : min / max;
}

/** Whether `id` has an edge to another node (self-loops say nothing before `id` is matched). */
function hasNeighbour(graph: KGraph, id: Id): boolean {
  for (const key of graph.outgoing.get(id) ?? []) {
    const edge = graph.edges.get(key);
    if (edge && edge.target !== id) return true;
  }
  for (const key of graph.incoming.get(id) ?? []) {
    const edge = graph.edges.get(key);
    if (edge && edge.source !== id) return true;
  }
  return false;
}

// ─── Candidate generation ────────────────────────────────────────────────────

interface Pair {
  readonly r: number;
  readonly a: number;
  /** Both nodes carry the same id (only possible with strategy `similarity`). */
  readonly sameId: boolean;
  readonly label: number;
  score: number;
  neighbors: number | undefined;
  types: number | undefined;
  attrs: number | undefined;
}

function keysOf(node: KGNode, profiles: ProfileCache): Set<string> {
  const keys = new Set<string>();
  for (const text of nodeTexts(node)) blockKeys(profiles.get(text), keys);
  return keys;
}

/**
 * Blocking from one side (docs/algorithms.md §2, step 4): an inverted index over `targets`; each
 * query collects the targets sharing a key, ranked by IDF-weighted key overlap (shared types
 * break ties only), then keeps the `maxCandidates` with the best label similarity. Keys with
 * very long posting lists are skipped once enough candidates are known, which bounds the work
 * per node. Calls `emit(query, target, label)` per kept candidate.
 */
function blockedCandidates(
  queries: readonly KGNode[],
  targets: readonly KGNode[],
  maxCandidates: number,
  pruneBelowFloor: boolean,
  profiles: ProfileCache,
  emit: (query: number, target: number, label: number) => void,
): void {
  const index = new Map<string, number[]>();
  const byId = new Map<Id, number>();
  targets.forEach((node, i) => {
    byId.set(node.id, i);
    for (const key of keysOf(node, profiles)) pushTo(index, key, i);
  });
  const maxPostings = Math.max(64, maxCandidates * 8);
  const preselect = maxCandidates * 3;
  queries.forEach((node, q) => {
    const lists: { key: string; postings: number[] }[] = [];
    for (const key of keysOf(node, profiles)) {
      const postings = index.get(key);
      if (postings) lists.push({ key, postings });
    }
    // The node with the same id (only possible with strategy `similarity`) is always a
    // candidate, even when it sits beyond the truncation of a very common key — otherwise
    // many identically named nodes would make diff(A, A) report changes.
    const same = byId.get(node.id);
    if (lists.length === 0 && same === undefined) return;
    lists.sort((x, y) => x.postings.length - y.postings.length || compareStrings(x.key, y.key));
    const overlap = new Map<number, number>();
    if (same !== undefined) overlap.set(same, 0);
    for (const { postings } of lists) {
      if (postings.length > maxPostings && overlap.size >= preselect) continue;
      const weight = 1 / log2(1 + postings.length);
      const limit = Math.min(postings.length, maxPostings);
      for (let j = 0; j < limit; j++) {
        const t = postings[j] as number;
        overlap.set(t, (overlap.get(t) ?? 0) + weight);
      }
    }
    const types = new Set(node.types);
    const ranked = [...overlap].map(([t, weight]) => {
      const other = targets[t] as KGNode;
      const sharesType = types.size > 0 && other.types.some((type) => types.has(type));
      return { t, weight: weight + (sharesType ? 1e-3 : 0) };
    });
    const own = (t: number): number => ((targets[t] as KGNode).id === node.id ? 0 : 1);
    ranked.sort((x, y) => own(x.t) - own(y.t) || y.weight - x.weight || x.t - y.t);
    const scored = ranked
      .slice(0, preselect)
      .map(({ t }) => ({ t, label: labelEvidence(node, targets[t] as KGNode, profiles) }))
      .filter(({ label }) => !pruneBelowFloor || label >= LABEL_FLOOR);
    scored.sort((x, y) => y.label - x.label || own(x.t) - own(y.t) || x.t - y.t);
    for (const { t, label } of scored.slice(0, maxCandidates)) emit(q, t, label);
  });
}

/**
 * Candidate pairs from both sides: the best candidates of every `r` and of every `a` (label
 * evidence is symmetric), so neither version is favoured. Sorted by `(r, a)`.
 */
export function generateCandidates(
  R: readonly KGNode[],
  A: readonly KGNode[],
  maxCandidates: number,
  pruneBelowFloor: boolean,
  profiles: ProfileCache,
): Pair[] {
  const pairs = new Map<number, Pair>();
  const add = (r: number, a: number, label: number): void => {
    const key = r * A.length + a;
    if (pairs.has(key)) return;
    const sameId = (R[r] as KGNode).id === (A[a] as KGNode).id;
    pairs.set(key, {
      r,
      a,
      sameId,
      label,
      score: 0,
      neighbors: undefined,
      types: undefined,
      attrs: undefined,
    });
  };
  blockedCandidates(R, A, maxCandidates, pruneBelowFloor, profiles, (r, a, label) =>
    add(r, a, label),
  );
  blockedCandidates(A, R, maxCandidates, pruneBelowFloor, profiles, (a, r, label) =>
    add(r, a, label),
  );
  return [...pairs.values()].sort((x, y) => x.r - y.r || x.a - y.a);
}

/**
 * Whether the free rival `q` makes `p` ambiguous (docs/algorithms.md §2, step 6): `p` must lead by
 * the margin. Two refinements keep exact matches exact: a perfect pair (every present signal
 * is 1) is never blocked by an imperfect one, and an exact tie is resolved in favour of the
 * pair whose ids are equal — which only arises with strategy `similarity`, where otherwise
 * indistinguishable nodes would turn `diff(A, A)` into removals and additions.
 */
function blocks(q: Pair, p: Pair): boolean {
  if (p.score - q.score >= MARGIN - EPSILON) return false;
  if (p.score === 1 && q.score < 1) return false;
  if (q.score === p.score && p.sameId && !q.sameId) return false;
  return true;
}

function isAmbiguous(p: Pair, rivals: readonly Pair[], free: (q: Pair) => boolean): boolean {
  for (const q of rivals) {
    if (q === p || !free(q)) continue;
    if (p.score - q.score >= MARGIN - EPSILON) return false; // rivals are sorted by score
    if (blocks(q, p)) return true;
  }
  return false;
}

// ─── Alignment ───────────────────────────────────────────────────────────────

/**
 * 1:1 replacement hints (docs/algorithms.md §2, step 2): a before node `x` whose id is gone and an
 * after node `y` whose id is new, linked by `x.replacedBy ∋ y` or `y.replaces ∋ x`, match with
 * method `hint` and score 1 — provided `x` hints at no other after node and no other before
 * node hints at `y` (several sources are a merge, several targets a split). This is how an OBO
 * term that changes its id (keeping the old one as `alt_id`) is recognised.
 */
function matchReplacements(
  before: KGraph,
  after: KGraph,
  beforeToAfter: Map<Id, Id>,
  afterToBefore: Map<Id, Id>,
  inferred: Map<Id, NodeMatch>,
): void {
  const targetsOf = new Map<Id, Set<Id>>();
  const sourcesOf = new Map<Id, Set<Id>>();
  const link = (x: Id, y: Id): void => {
    if (x === y) return;
    getOrCreate(targetsOf, x, () => new Set<Id>()).add(y);
    getOrCreate(sourcesOf, y, () => new Set<Id>()).add(x);
  };
  for (const x of before.nodes.values()) {
    for (const y of x.replacedBy) if (after.nodes.has(y)) link(x.id, y);
  }
  for (const y of after.nodes.values()) {
    for (const x of y.replaces) if (before.nodes.has(x)) link(x, y.id);
  }
  for (const x of [...targetsOf.keys()].sort()) {
    const targets = targetsOf.get(x) as Set<Id>;
    if (targets.size !== 1 || after.nodes.has(x) || beforeToAfter.has(x)) continue;
    const y = targets.values().next().value as Id;
    if (sourcesOf.get(y)?.size !== 1 || before.nodes.has(y) || afterToBefore.has(y)) continue;
    beforeToAfter.set(x, y);
    afterToBefore.set(y, x);
    inferred.set(x, { before: x, after: y, method: 'hint', score: 1 });
  }
}

/**
 * Aligns the nodes of two versions (docs/algorithms.md §2). Deterministic: every iteration
 * that affects the result runs over id-sorted data, and every score is rounded to 1e-6.
 */
export function alignNodes(
  before: KGraph,
  after: KGraph,
  options: Required<MatchOptions>,
  ignoreAttrs: ReadonlySet<string>,
  profiles: ProfileCache = new ProfileCache(),
): Alignment {
  const beforeToAfter = new Map<Id, Id>();
  const afterToBefore = new Map<Id, Id>();
  const inferred = new Map<Id, NodeMatch>();
  if (options.strategy !== 'similarity') {
    for (const id of before.nodes.keys()) {
      if (after.nodes.has(id)) {
        beforeToAfter.set(id, id);
        afterToBefore.set(id, id);
      }
    }
  }
  matchReplacements(before, after, beforeToAfter, afterToBefore, inferred);
  const alignment = { beforeToAfter, afterToBefore, inferred, suggestions: [] };
  if (options.strategy === 'id') return alignment;

  const R = [...before.nodes.values()]
    .filter((n) => !beforeToAfter.has(n.id))
    .sort((x, y) => compareStrings(x.id, y.id));
  const A = [...after.nodes.values()]
    .filter((n) => !afterToBefore.has(n.id))
    .sort((x, y) => compareStrings(x.id, y.id));
  if (R.length === 0 || A.length === 0) return alignment;

  const pruneBelowFloor = Math.min(options.threshold, options.suggestThreshold) > LABEL_FLOOR;
  const pairs = generateCandidates(R, A, options.maxCandidates, pruneBelowFloor, profiles);
  if (pairs.length === 0) return alignment;

  const matchedR = new Array<boolean>(R.length).fill(false);
  const matchedA = new Array<boolean>(A.length).fill(false);
  const isLive = (p: Pair): boolean => !matchedR[p.r] && !matchedA[p.a];

  const score = (live: readonly Pair[]): void => {
    // Neighbour signatures depend on the current matching, so they are rebuilt per round.
    const toAfter = (id: Id): Id | undefined => beforeToAfter.get(id);
    const known = (id: Id): Id | undefined => (afterToBefore.has(id) ? id : undefined);
    const sigR = new Map<number, Signature>();
    const sigA = new Map<number, Signature>();
    const hasMatches = beforeToAfter.size > 0;
    for (const p of live) {
      const r = R[p.r] as KGNode;
      const a = A[p.a] as KGNode;
      let neighbors: number | undefined;
      if (hasMatches) {
        const sr = getOrCreate(sigR, p.r, () => buildSignature(before, r.id, toAfter, after));
        const sa = getOrCreate(sigA, p.a, () => buildSignature(after, a.id, known, after));
        neighbors = neighborEvidence(sr, sa);
      }
      p.neighbors = neighbors;
      p.types = typeEvidence(r.types, a.types);
      p.attrs = attrEvidence(r, a, ignoreAttrs);
      p.score = combineEvidence(p.label, neighbors, p.types, p.attrs);
    }
  };

  // R and A are sorted by id, so index order is id order.
  const byScore = (x: Pair, y: Pair): number =>
    y.score - x.score || Number(y.sameId) - Number(x.sameId) || x.r - y.r || x.a - y.a;

  /**
   * Whether accepting `p` now would decide against its types on the label alone
   * (docs/algorithms.md §2, step 6): both nodes are typed and share no type, no attribute agrees,
   * and the neighbour signal is missing only because none of their neighbours is matched yet —
   * it can still arrive through propagation, and it is what tells two same-named things apart.
   */
  const awaitsNeighbours = (p: Pair): boolean => {
    if (p.neighbors !== undefined || p.types !== 0 || (p.attrs ?? 0) > 0) return false;
    const r = R[p.r] as KGNode;
    const a = A[p.a] as KGNode;
    if (r.types.length === 0 || a.types.length === 0) return false; // a type was only added
    return hasNeighbour(before, r.id) || hasNeighbour(after, a.id);
  };

  /** One pass of greedy assignment over the sorted live pairs; returns how many were accepted. */
  const assign = (
    sorted: readonly Pair[],
    byR: ReadonlyMap<number, Pair[]>,
    byA: ReadonlyMap<number, Pair[]>,
    defer: (p: Pair) => boolean,
  ): number => {
    let accepted = 0;
    for (const p of sorted) {
      if (p.score < options.threshold) break;
      if (!isLive(p)) continue;
      if (
        isAmbiguous(p, byR.get(p.r) ?? [], (q) => !matchedA[q.a]) ||
        isAmbiguous(p, byA.get(p.a) ?? [], (q) => !matchedR[q.r])
      ) {
        continue;
      }
      // A deferred pair stays free, so it still blocks its weaker rivals in this round.
      if (defer(p)) continue;
      const r = R[p.r] as KGNode;
      const a = A[p.a] as KGNode;
      matchedR[p.r] = true;
      matchedA[p.a] = true;
      beforeToAfter.set(r.id, a.id);
      afterToBefore.set(a.id, r.id);
      inferred.set(r.id, {
        before: r.id,
        after: a.id,
        method: 'similarity',
        score: p.score,
        evidence: evidenceOf(p.label, p.neighbors, p.types, p.attrs),
      });
      accepted++;
    }
    return accepted;
  };

  let live = pairs;
  let acceptedInLastRound = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    live = live.filter(isLive);
    if (live.length === 0) break;
    score(live);
    live.sort(byScore);
    const byR = new Map<number, Pair[]>();
    const byA = new Map<number, Pair[]>();
    for (const p of live) {
      pushTo(byR, p.r, p);
      pushTo(byA, p.a, p);
    }
    // Pairs awaiting neighbour evidence wait while other matches still propagate; once a round
    // (or the last round) has nothing else to accept, they are decided on what is known.
    let deferred = 0;
    const defer = (p: Pair): boolean => {
      if (round === MAX_ROUNDS - 1 || !awaitsNeighbours(p)) return false;
      deferred++;
      return true;
    };
    acceptedInLastRound = assign(live, byR, byA, defer);
    if (acceptedInLastRound === 0 && deferred > 0) {
      acceptedInLastRound = assign(live, byR, byA, () => false);
    }
    if (acceptedInLastRound === 0) break;
  }

  // Suggestions from the pairs that are still free, scored against the final matching.
  live = live.filter(isLive);
  if (acceptedInLastRound > 0) score(live);
  live.sort(byScore);
  return { ...alignment, suggestions: collectSuggestions(live, R, A, options) };
}

/**
 * Free pairs above `threshold` were rejected as ambiguous; pairs between `suggestThreshold`
 * and `threshold` are kept when they are the best remaining option for either endpoint.
 */
function collectSuggestions(
  sorted: readonly Pair[],
  R: readonly KGNode[],
  A: readonly KGNode[],
  options: Required<MatchOptions>,
): MatchSuggestion[] {
  const suggestions: MatchSuggestion[] = [];
  const seenR = new Set<number>();
  const seenA = new Set<number>();
  for (const p of sorted) {
    if (p.score < options.suggestThreshold) break;
    const firstForR = !seenR.has(p.r);
    const firstForA = !seenA.has(p.a);
    seenR.add(p.r);
    seenA.add(p.a);
    const ambiguous = p.score >= options.threshold;
    if (!ambiguous && !firstForR && !firstForA) continue;
    suggestions.push({
      before: (R[p.r] as KGNode).id,
      after: (A[p.a] as KGNode).id,
      score: p.score,
      evidence: evidenceOf(p.label, p.neighbors, p.types, p.attrs),
      reason: ambiguous ? 'ambiguous' : 'below-threshold',
    });
  }
  return sortSuggestions(suggestions);
}

export function sortSuggestions(suggestions: MatchSuggestion[]): MatchSuggestion[] {
  return suggestions.sort(
    (x, y) => compareStrings(x.after, y.after) || compareStrings(x.before, y.before),
  );
}

/**
 * Aligns the nodes of two versions: exact ids first (strategies `id`, `auto`), then
 * 1:1 replacement hints (all strategies), then similarity matching of the leftovers (`auto`)
 * or of everything (`similarity`).
 * Matches are sorted by `after`; suggestions by `after`, then `before`.
 *
 * Defaults: strategy `auto`, threshold 0.82, suggestThreshold 0.6, maxCandidates 8.
 */
export function matchNodes(before: KGraph, after: KGraph, options?: MatchOptions): MatchResult {
  const alignment = alignNodes(before, after, resolveMatchOptions(options), new Set());
  const matches: NodeMatch[] = [];
  for (const [b, a] of alignment.beforeToAfter) {
    matches.push(alignment.inferred.get(b) ?? { before: b, after: a, method: 'id', score: 1 });
  }
  matches.sort((x, y) => compareStrings(x.after, y.after));
  return { matches, suggestions: alignment.suggestions };
}
