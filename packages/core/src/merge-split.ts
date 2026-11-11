/**
 * Merge (N → 1) and split (1 → N) detection (docs/algorithms.md §3), run after matching.
 *
 * Evidence comes from explicit hints (`replacedBy` / `replaces`, confidence 1) or from a
 * heuristic: near-identical names (similarity ≥ 0.9, or a synonym) plus edge carry-over
 * (≥ 50% of the edges of the node that goes away — merges — or of the node that appears —
 * splits — are found on the counterpart). Heuristic candidates
 * are generated structurally (only nodes that actually carry an edge are considered), so the
 * cost is bounded by the degrees of the unmatched nodes.
 */

import { tripleKey } from './canonical.js';
import { round6 } from './engine-util.js';
import type { Alignment } from './match.js';
import { attrEvidence, evidenceOf, typeEvidence } from './match.js';
import type { ProfileCache } from './similarity.js';
import { nameKeys, profileSimilarity } from './similarity.js';
import type { Id, KGNode, KGraph, MatchSuggestion } from './types.js';
import { compareStrings, getOrCreate, pushTo } from './util.js';

const LABEL_EVIDENCE = 0.9;
const CARRY_OVER = 0.5;
const ACCEPT = 0.75;

export type Via = 'hint' | 'heuristic';

export interface Contribution {
  /** A before id (merge source) or an after id (split target). */
  readonly id: Id;
  readonly confidence: number;
  readonly via: Via;
}

export interface MergeGroup {
  /** After id of the node the sources merge into. */
  readonly target: Id;
  /** Before id matched to `target`, when the target existed before. */
  readonly survivor?: Id;
  /** Before ids, sorted. */
  readonly sources: readonly Contribution[];
}

export interface SplitGroup {
  /** Before id of the node that splits. */
  readonly source: Id;
  /** After id matched to `source`, when it survives (and is not deprecated). */
  readonly survivor?: Id;
  /** New after ids, sorted. */
  readonly targets: readonly Contribution[];
}

export interface Restructuring {
  /** Sorted by target. */
  readonly merges: readonly MergeGroup[];
  /** Sorted by source. */
  readonly splits: readonly SplitGroup[];
  /** Merge group by source (before id). */
  readonly mergeBySource: ReadonlyMap<Id, MergeGroup>;
  /** Merge group by target (after id). */
  readonly mergeByTarget: ReadonlyMap<Id, MergeGroup>;
  /** Split group by source (before id). */
  readonly splitBySource: ReadonlyMap<Id, SplitGroup>;
  /** Split group by new target (after id). */
  readonly splitByTarget: ReadonlyMap<Id, SplitGroup>;
  readonly suggestions: readonly MatchSuggestion[];
}

interface Context {
  readonly before: KGraph;
  readonly after: KGraph;
  readonly b2a: ReadonlyMap<Id, Id>;
  readonly a2b: ReadonlyMap<Id, Id>;
  readonly profiles: ProfileCache;
  readonly ignoreAttrs: ReadonlySet<string>;
  readonly nameKeys: Map<string, readonly string[]>;
}

/** Neighbourhoods up to this size are searched exhaustively; larger ones by name. */
const SMALL_NEIGHBOURHOOD = 32;
/** Name keys shared by more members than this are too common to be worth following. */
const COMMON_KEY = 32;

/**
 * Candidate generation for the heuristics. Carry-over ≥ 0.5 implies that a counterpart shares
 * at least one edge pattern `(p, anchor)` with the node, so candidates are searched in those
 * neighbourhoods only: exhaustively when small, through a per-neighbourhood name index when
 * large (a hub), so the work never grows with hub size × number of nodes. Memoized.
 */
class Neighbourhoods {
  private readonly members = new Map<string, readonly Id[]>();
  private readonly names = new Map<string, Map<string, Id[]>>();
  constructor(
    private readonly graph: KGraph,
    /** Shared between the merge and the split phase: most labels are the same in both versions. */
    private readonly textKeys: Map<string, readonly string[]>,
  ) {}

  /** Name keys of a node (label and aliases), memoized by text across both phases. */
  keysOf(node: KGNode): readonly string[] {
    const text = node.aliases.length ? [node.label, ...node.aliases].join('\u0000') : node.label;
    let keys = this.textKeys.get(text);
    if (!keys) {
      keys = nameKeys(node.aliases.length ? [node.label, ...node.aliases] : [node.label]);
      this.textKeys.set(text, keys);
    }
    return keys;
  }

  /**
   * Nodes `c` with an edge `(c, predicate, anchor)` (`direction` '<') or
   * `(anchor, predicate, c)` ('>') whose names may match `query`.
   */
  candidates(
    direction: '<' | '>',
    predicate: string,
    anchor: Id,
    query: readonly string[],
  ): readonly Id[] {
    const key = `${direction}${predicate}\u0000${anchor}`;
    const members = this.membersOf(key, direction, predicate, anchor);
    if (members.length <= SMALL_NEIGHBOURHOOD) return members;
    let index = this.names.get(key);
    if (!index) {
      index = new Map();
      for (const id of members) {
        const node = this.graph.nodes.get(id);
        if (node) for (const k of this.keysOf(node)) pushTo(index, k, id);
      }
      this.names.set(key, index);
    }
    // Keys held by many members are not followed: a near-duplicate name always shares a rarer
    // key, and many members with the same name would make any choice a guess.
    const found = new Set<Id>();
    for (const k of query) {
      const postings = index.get(k);
      if (postings && postings.length <= COMMON_KEY) for (const id of postings) found.add(id);
    }
    return [...found];
  }

  private membersOf(
    key: string,
    direction: '<' | '>',
    predicate: string,
    anchor: Id,
  ): readonly Id[] {
    let found = this.members.get(key);
    if (!found) {
      const keys =
        (direction === '<' ? this.graph.incoming : this.graph.outgoing).get(anchor) ?? [];
      const ends = new Set<Id>();
      for (const k of keys) {
        const edge = this.graph.edges.get(k);
        if (edge?.predicate === predicate) ends.add(direction === '<' ? edge.source : edge.target);
      }
      found = [...ends];
      this.members.set(key, found);
    }
    return found;
  }
}

/** Whether `graph` has an edge `(source, predicate, target)` (any parallel copy, any id). */
class Triples {
  private set: Set<string> | undefined;

  constructor(private readonly graph: KGraph) {}

  has(source: Id, predicate: string, target: Id): boolean {
    const key = tripleKey(source, predicate, target);
    if (this.graph.edgeIdentity === 'structure') return this.graph.edges.has(key);
    if (!this.set) {
      this.set = new Set();
      for (const e of this.graph.edges.values())
        this.set.add(tripleKey(e.source, e.predicate, e.target));
    }
    return this.set.has(key);
  }
}

/** Best name evidence of `text` against a node's label and aliases. */
function nameEvidence(text: string, node: KGNode, profiles: ProfileCache): number {
  const p = profiles.get(text);
  let best = profileSimilarity(p, profiles.get(node.label));
  for (const alias of node.aliases) {
    if (best === 1) break;
    best = Math.max(best, profileSimilarity(p, profiles.get(alias)));
  }
  return best;
}

/** `text ∈ node.aliases`, comparing normalized text. */
function isSynonym(text: string, node: KGNode, profiles: ProfileCache): boolean {
  const p = profiles.get(text);
  return node.aliases.some((alias) => profileSimilarity(p, profiles.get(alias)) === 1);
}

/**
 * Carry-over candidates of `subject` (a node of `graph`) on the other side: nodes `c` of
 * `other` such that, for some edge `(subject, p, n)`, `other` has `(c, p, map(n))` (and the
 * same for incoming edges), found by `Neighbourhoods.candidates`. Returns the candidates and
 * a function counting the subject's edges carried by a candidate (O(degree) via `Triples`).
 */
function carryOver(
  graph: KGraph,
  subject: KGNode,
  map: ReadonlyMap<Id, Id>,
  neighbourhoods: Neighbourhoods,
  triples: Triples,
): { candidates: Set<Id>; total: number; carried: (candidate: Id) => number } {
  const query = neighbourhoods.keysOf(subject);
  const edges: { out: boolean; predicate: string; other: Id | undefined }[] = [];
  const candidates = new Set<Id>();
  for (const out of [true, false]) {
    for (const key of (out ? graph.outgoing : graph.incoming).get(subject.id) ?? []) {
      const edge = graph.edges.get(key);
      if (!edge) continue;
      const end = out ? edge.target : edge.source;
      const other = end === subject.id ? undefined : map.get(end);
      edges.push({ out, predicate: edge.predicate, other });
      if (other === undefined) continue;
      for (const c of neighbourhoods.candidates(out ? '<' : '>', edge.predicate, other, query))
        candidates.add(c);
    }
  }
  const carried = (c: Id): number => {
    let n = 0;
    for (const e of edges) {
      if (e.other === undefined) continue;
      if (e.out ? triples.has(c, e.predicate, e.other) : triples.has(e.other, e.predicate, c)) n++;
    }
    return n;
  };
  return { candidates, total: edges.length, carried };
}

interface Scored {
  readonly candidate: Id;
  readonly label: number;
  readonly carry: number;
  readonly confidence: number;
}

/**
 * Best heuristic counterpart of `subject` (docs/algorithms.md §3): label evidence ≥ 0.9 —
 * similarity of the subject's label to the candidate's label or aliases, or (splits, with
 * `synonymsOfSubject`) the candidate's label being one of the subject's aliases — and
 * carry-over ≥ 0.5. Confidence = 0.5·label + 0.5·carry-over.
 */
function bestHeuristic(
  subject: KGNode,
  found: ReturnType<typeof carryOver>,
  other: KGraph,
  profiles: ProfileCache,
  accept: (candidate: Id) => boolean,
  synonymsOfSubject: boolean,
): Scored | undefined {
  let best: Scored | undefined;
  for (const candidate of [...found.candidates].sort()) {
    if (!accept(candidate)) continue;
    const node = other.nodes.get(candidate);
    if (!node) continue;
    let label = nameEvidence(subject.label, node, profiles);
    if (synonymsOfSubject && label < 1 && isSynonym(node.label, subject, profiles)) label = 1;
    if (label < LABEL_EVIDENCE) continue;
    const carry = found.carried(candidate) / found.total;
    if (carry < CARRY_OVER) continue;
    const confidence = round6(0.5 * label + 0.5 * carry);
    if (!best || confidence > best.confidence) best = { candidate, label, carry, confidence };
  }
  return best;
}

function suggestion(ctx: Context, beforeId: Id, afterId: Id, scored: Scored): MatchSuggestion {
  const b = ctx.before.nodes.get(beforeId) as KGNode;
  const a = ctx.after.nodes.get(afterId) as KGNode;
  return {
    before: beforeId,
    after: afterId,
    score: scored.confidence,
    evidence: evidenceOf(
      scored.label,
      scored.carry,
      typeEvidence(b.types, a.types),
      attrEvidence(b, a, ctx.ignoreAttrs),
    ),
    reason: 'below-threshold',
  };
}

/** Detects merges and splits. Deterministic: all candidates are visited in id order. */
export function detectRestructuring(
  before: KGraph,
  after: KGraph,
  alignment: Alignment,
  options: { readonly detectMerges: boolean; readonly detectSplits: boolean },
  profiles: ProfileCache,
  ignoreAttrs: ReadonlySet<string>,
): Restructuring {
  const ctx: Context = {
    before,
    after,
    b2a: alignment.beforeToAfter,
    a2b: alignment.afterToBefore,
    profiles,
    ignoreAttrs,
    nameKeys: new Map(),
  };
  const suggestions: MatchSuggestion[] = [];
  const merges = options.detectMerges ? detectMerges(ctx, suggestions) : [];
  const mergeBySource = new Map<Id, MergeGroup>();
  const mergeByTarget = new Map<Id, MergeGroup>();
  for (const group of merges) {
    mergeByTarget.set(group.target, group);
    for (const s of group.sources) mergeBySource.set(s.id, group);
  }
  const splits = options.detectSplits
    ? detectSplits(ctx, mergeBySource, mergeByTarget, suggestions)
    : [];
  const splitBySource = new Map<Id, SplitGroup>();
  const splitByTarget = new Map<Id, SplitGroup>();
  for (const group of splits) {
    splitBySource.set(group.source, group);
    for (const t of group.targets) splitByTarget.set(t.id, group);
  }
  return {
    merges,
    splits,
    mergeBySource,
    mergeByTarget,
    splitBySource,
    splitByTarget,
    suggestions,
  };
}

// ─── Merges ──────────────────────────────────────────────────────────────────

function detectMerges(ctx: Context, suggestions: MatchSuggestion[]): MergeGroup[] {
  const { before, after, b2a, a2b } = ctx;
  const toAfter = (id: Id): Id | undefined => (after.nodes.has(id) ? id : b2a.get(id));
  const toBefore = (id: Id): Id | undefined => (before.nodes.has(id) ? id : a2b.get(id));

  /** A before node can merge away when it disappears or becomes deprecated. */
  const canMergeAway = (x: Id): boolean => {
    const xa = b2a.get(x);
    return xa === undefined || (after.nodes.get(xa)?.deprecated ?? false);
  };
  /** Hints already present (and already acted upon) in the before version are not changes. */
  const hintedBefore = (x: Id, target: Id): boolean => {
    const xb = before.nodes.get(x) as KGNode;
    if (!xb.deprecated || !b2a.has(x)) return false;
    if (xb.replacedBy.some((r) => toAfter(r) === target)) return true;
    const y = a2b.get(target);
    return y !== undefined && (before.nodes.get(y)?.replaces.includes(x) ?? false);
  };

  const hints = new Map<Id, Set<Id>>();
  const hint = (x: Id | undefined, target: Id | undefined): void => {
    if (x === undefined || target === undefined || b2a.get(x) === target) return;
    if (!canMergeAway(x) || hintedBefore(x, target)) return;
    getOrCreate(hints, x, () => new Set<Id>()).add(target);
  };
  for (const node of before.nodes.values()) {
    for (const r of node.replacedBy) hint(node.id, toAfter(r));
  }
  for (const node of after.nodes.values()) {
    if (node.replacedBy.length) {
      const x = a2b.get(node.id);
      for (const r of node.replacedBy) hint(x, toAfter(r));
    }
    for (const r of node.replaces) hint(toBefore(r), node.id);
  }

  // A hinted target is valid when it absorbs into a surviving node or gathers ≥ 2 sources.
  const hintedSources = new Map<Id, Id[]>();
  for (const [x, targets] of hints) for (const t of targets) pushTo(hintedSources, t, x);
  const valid = (t: Id): boolean => a2b.has(t) || (hintedSources.get(t)?.length ?? 0) >= 2;

  const assigned = new Map<Id, Contribution[]>();
  const merged = new Set<Id>();
  for (const x of [...hints.keys()].sort()) {
    const target = [...(hints.get(x) as Set<Id>)].sort().find(valid);
    if (target === undefined) continue;
    pushTo(assigned, target, { id: x, confidence: 1, via: 'hint' as const });
    merged.add(x);
  }

  // Heuristic: an unmatched node whose name lives on in a matched node that carries its edges.
  const neighbourhoods = new Neighbourhoods(after, ctx.nameKeys);
  const triples = new Triples(after);
  const unmatched = [...before.nodes.keys()].filter((x) => !b2a.has(x) && !merged.has(x)).sort();
  for (const x of unmatched) {
    const xb = before.nodes.get(x) as KGNode;
    const found = carryOver(before, xb, b2a, neighbourhoods, triples);
    if (found.candidates.size === 0) continue;
    const best = bestHeuristic(xb, found, after, ctx.profiles, (t) => a2b.has(t), false);
    if (!best) continue;
    if (best.confidence >= ACCEPT) {
      pushTo(assigned, best.candidate, { id: x, confidence: best.confidence, via: 'heuristic' });
    } else {
      suggestions.push(suggestion(ctx, x, best.candidate, best));
    }
  }

  return groupMerges(assigned, a2b);
}

/**
 * Turns per-target contributions into merge groups. A target that itself merges away
 * (`a → n`, `n → m`) forwards its sources to the final target, so every source lands where
 * the content ended up; targets that merge into each other in a cycle (`a ↔ b`) are not
 * merges at all. A group needs a surviving target or ≥ 2 sources.
 */
function groupMerges(
  assigned: ReadonlyMap<Id, Contribution[]>,
  a2b: ReadonlyMap<Id, Id>,
): MergeGroup[] {
  const targetOf = new Map<Id, Id>();
  for (const [target, sources] of assigned) for (const s of sources) targetOf.set(s.id, target);
  const final = new Map<Id, Id | null>();
  const resolve = (target: Id): Id | null => {
    const known = final.get(target);
    if (known !== undefined) return known;
    const path: Id[] = [];
    const seen = new Set<Id>();
    let current: Id | undefined = target;
    let result: Id | null = null;
    while (current !== undefined) {
      const cached = final.get(current);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      if (seen.has(current)) break; // a cycle: none of its members is a merge target
      seen.add(current);
      path.push(current);
      const survivor = a2b.get(current);
      const next = survivor === undefined ? undefined : targetOf.get(survivor);
      if (next === undefined) {
        result = current;
        break;
      }
      current = next;
    }
    for (const t of path) final.set(t, result);
    return result;
  };
  const byFinal = new Map<Id, Contribution[]>();
  for (const target of [...assigned.keys()].sort()) {
    const end = resolve(target);
    if (end === null) continue;
    for (const s of assigned.get(target) as Contribution[]) {
      if (a2b.get(end) !== s.id) pushTo(byFinal, end, s);
    }
  }
  const groups: MergeGroup[] = [];
  for (const target of [...byFinal.keys()].sort()) {
    const sources = (byFinal.get(target) as Contribution[]).sort((p, q) =>
      compareStrings(p.id, q.id),
    );
    const survivor = a2b.get(target);
    if (survivor === undefined && sources.length < 2) continue;
    groups.push(survivor === undefined ? { target, sources } : { target, survivor, sources });
  }
  return groups;
}

// ─── Splits ──────────────────────────────────────────────────────────────────

function detectSplits(
  ctx: Context,
  mergeBySource: ReadonlyMap<Id, MergeGroup>,
  mergeByTarget: ReadonlyMap<Id, MergeGroup>,
  suggestions: MatchSuggestion[],
): SplitGroup[] {
  const { before, after, b2a, a2b } = ctx;
  const toBefore = (id: Id): Id | undefined => (before.nodes.has(id) ? id : a2b.get(id));
  /** Split targets are new nodes that take no part in a merge. */
  const isNewTarget = (t: Id): boolean =>
    after.nodes.has(t) && !a2b.has(t) && !mergeByTarget.has(t);
  const canSplit = (x: Id): boolean => before.nodes.has(x) && !mergeBySource.has(x);

  const found = new Map<Id, Map<Id, Contribution>>();
  const add = (x: Id | undefined, t: Id, confidence: number, via: Via): void => {
    if (x === undefined || !canSplit(x) || !isNewTarget(t)) return;
    const targets = getOrCreate(found, x, () => new Map<Id, Contribution>());
    if (!targets.has(t)) targets.set(t, { id: t, confidence, via });
  };
  for (const node of after.nodes.values()) {
    for (const r of node.replaces) add(toBefore(r), node.id, 1, 'hint');
    if (node.replacedBy.length) {
      const x = a2b.get(node.id);
      for (const r of node.replacedBy) add(x, r, 1, 'hint');
    }
  }
  for (const node of before.nodes.values()) {
    for (const r of node.replacedBy) add(node.id, r, 1, 'hint');
  }

  // Heuristic: a new node named like an existing one that takes over its edges.
  const hinted = new Set<Id>();
  for (const targets of found.values()) for (const t of targets.keys()) hinted.add(t);
  const neighbourhoods = new Neighbourhoods(before, ctx.nameKeys);
  const triples = new Triples(before);
  const fresh = [...after.nodes.keys()].filter((t) => isNewTarget(t) && !hinted.has(t)).sort();
  for (const t of fresh) {
    const ta = after.nodes.get(t) as KGNode;
    const found = carryOver(after, ta, a2b, neighbourhoods, triples);
    if (found.candidates.size === 0) continue;
    const best = bestHeuristic(ta, found, before, ctx.profiles, canSplit, true);
    if (!best) continue;
    if (best.confidence >= ACCEPT) add(best.candidate, t, best.confidence, 'heuristic');
    else suggestions.push(suggestion(ctx, best.candidate, t, best));
  }

  const groups: SplitGroup[] = [];
  for (const source of [...found.keys()].sort()) {
    const targets = [...(found.get(source) as Map<Id, Contribution>).values()].sort((p, q) =>
      compareStrings(p.id, q.id),
    );
    const match = b2a.get(source);
    const survivor = match !== undefined && !after.nodes.get(match)?.deprecated ? match : undefined;
    if (targets.length + (survivor === undefined ? 0 : 1) < 2) continue;
    groups.push(survivor === undefined ? { source, targets } : { source, survivor, targets });
  }
  return groups;
}
