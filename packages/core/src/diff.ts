/**
 * The diff pipeline (docs/algorithms.md):
 * normalize → match → merges / splits → classify nodes → pair edges → hunks → delta → stats.
 */
import { assignUnionIds, classifyNodes } from './classify.js';
import { buildDelta, withEdgeIdentity } from './delta.js';
import { createDiffIndex } from './diff-index.js';
import { classifyEdges } from './edges.js';
import { KgdiffError } from './errors.js';
import { buildHunks } from './hunks.js';
import { alignNodes, sortSuggestions } from './match.js';
import { detectRestructuring } from './merge-split.js';
import type { EdgeRecord, NodeRecord, PipelineContext } from './model.js';
import { isKGraph, normalize } from './normalize.js';
import { resolveOptions } from './options.js';
import { orderHunks } from './order.js';
import { computeStats } from './stats.js';
import { ProfileCache } from './text.js';
import type {
  ChangeStatus,
  DiffOptions,
  DiffResult,
  EdgeIdentity,
  GraphInput,
  KGraph,
  MatchedUnionEdge,
  MatchSuggestion,
  NodeMatch,
  ResolvedDiffOptions,
  UnionEdge,
  UnionNode,
} from './types.js';
import { compareStrings, degree } from './util.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const VERSIONS: Readonly<Record<ChangeStatus, string>> = {
  added: 'only an after version',
  removed: 'only a before version',
  unchanged: 'both versions',
  modified: 'both versions',
};

/**
 * Union elements whose versions contradict their status. The pipeline never builds one; a
 * hand-written or corrupted `DiffJSON` can (`diffFromJSON` rebuilds through these functions).
 */
function misfit(what: string, status: ChangeStatus, detail = ''): never {
  throw new KgdiffError(
    'invalid-input',
    `${what} is ${status}, so it must have ${VERSIONS[status]}${detail}`,
  );
}

/**
 * Public, immutable union node from a pipeline record.
 * @throws KgdiffError `invalid-input` when the record's versions do not fit its status.
 */
export function toUnionNode(n: NodeRecord, before: KGraph, after: KGraph): UnionNode {
  const { id, status, facets, beforeId, afterId, before: b, after: a } = n;
  const what = `Union node "${id}"`;
  const versions = ' (beforeId and before, afterId and after)';
  const degrees = { before: degree(before, beforeId), after: degree(after, afterId) };
  let out: Mutable<UnionNode>;
  if (status === 'added') {
    if (!a || afterId === undefined || b || beforeId !== undefined) misfit(what, status, versions);
    out = {
      id,
      status,
      facets,
      label: a.label,
      types: a.types,
      degree: degrees,
      afterId,
      after: a,
    };
  } else if (status === 'removed') {
    if (!b || beforeId === undefined || a || afterId !== undefined) misfit(what, status, versions);
    out = {
      id,
      status,
      facets,
      label: b.label,
      types: b.types,
      degree: degrees,
      beforeId,
      before: b,
    };
  } else {
    if (!a || !b || afterId === undefined || beforeId === undefined) {
      misfit(what, status, versions);
    }
    out = {
      id,
      status,
      facets,
      label: a.label,
      types: a.types,
      degree: degrees,
      beforeId,
      afterId,
      before: b,
      after: a,
    };
  }
  if (n.hunk !== undefined) out.hunk = n.hunk;
  return out;
}

/**
 * Public, immutable union edge from a pipeline record (drops the pipeline-only `inPlace`).
 * @throws KgdiffError `invalid-input` when the record's versions do not fit its status.
 */
export function toUnionEdge(e: EdgeRecord): UnionEdge {
  const { id, source, target, predicate, label, status, facets, hierarchical } = e;
  const { before: b, after: a, beforeKey, afterKey } = e;
  const what = `Union edge ${id}`;
  const moved =
    e.sourceBefore !== undefined || e.targetBefore !== undefined || e.predicateBefore !== undefined;
  let out: Mutable<UnionEdge>;
  if (status === 'added') {
    if (!a || afterKey === undefined || b || beforeKey !== undefined) misfit(what, status);
    if (moved) misfit(what, status, ' and no before-version endpoints or predicate');
    out = {
      id,
      source,
      target,
      predicate,
      label,
      status,
      facets,
      hierarchical,
      afterKey,
      after: a,
    };
  } else if (status === 'removed') {
    if (!b || beforeKey === undefined || a || afterKey !== undefined) misfit(what, status);
    if (moved) misfit(what, status, ' and no before-version endpoints or predicate');
    out = {
      id,
      source,
      target,
      predicate,
      label,
      status,
      facets,
      hierarchical,
      beforeKey,
      before: b,
    };
  } else {
    if (!a || !b || afterKey === undefined || beforeKey === undefined) misfit(what, status);
    const matched: Mutable<MatchedUnionEdge> = {
      id,
      source,
      target,
      predicate,
      label,
      status,
      facets,
      hierarchical,
      beforeKey,
      afterKey,
      before: b,
      after: a,
    };
    if (e.sourceBefore !== undefined) matched.sourceBefore = e.sourceBefore;
    if (e.targetBefore !== undefined) matched.targetBefore = e.targetBefore;
    if (e.predicateBefore !== undefined) matched.predicateBefore = e.predicateBefore;
    out = matched;
  }
  if (e.hunk !== undefined) out.hunk = e.hunk;
  return out;
}

/** Suggestions from matching and from merge / split heuristics, one per pair (best score). */
function mergeSuggestions(...lists: readonly (readonly MatchSuggestion[])[]): MatchSuggestion[] {
  const best = new Map<string, MatchSuggestion>();
  for (const list of lists) {
    for (const s of list) {
      const key = `${s.before}\u0000${s.after}`;
      const seen = best.get(key);
      if (!seen || s.score > seen.score) best.set(key, s);
    }
  }
  return sortSuggestions([...best.values()]);
}

function toGraph(input: GraphInput | KGraph, edgeIdentity: EdgeIdentity): KGraph {
  return isKGraph(input)
    ? withEdgeIdentity(input, edgeIdentity)
    : normalize(input, { edgeIdentity });
}

/** Runs the pipeline on two normalized graphs. */
function diffGraphs(before: KGraph, after: KGraph, options: ResolvedDiffOptions): DiffResult {
  const ignoreAttrs = new Set(options.ignoreAttrs);
  const profiles = new ProfileCache();
  const alignment = alignNodes(before, after, options.match, ignoreAttrs, profiles);
  const restructuring = detectRestructuring(
    before,
    after,
    alignment,
    options,
    profiles,
    ignoreAttrs,
  );
  const renamed = assignUnionIds(before, after, alignment.beforeToAfter);
  const ctx: PipelineContext = {
    before,
    after,
    options,
    hierarchy: new Set(options.hierarchyPredicates),
    ignoreAttrs,
    beforeToAfter: alignment.beforeToAfter,
    afterToBefore: alignment.afterToBefore,
    inferred: alignment.inferred,
    restructuring,
    renamed,
    unionOfBefore: renamed.size ? (id) => renamed.get(id) ?? id : (id) => id,
  };
  const { nodes, index } = classifyNodes(ctx);
  const edges = classifyEdges(ctx, index);
  const drafts = buildHunks(ctx, nodes, edges);
  const { delta, opHunks } = buildDelta(ctx, nodes, edges);
  const { hunks } = orderHunks(drafts, delta.ops, opHunks, options.edgeIdentity, nodes, edges);
  const unionNodes = nodes.map((n) => toUnionNode(n, before, after));
  const unionEdges = edges.map(toUnionEdge);
  const matches: NodeMatch[] = [...alignment.inferred.values()].sort((x, y) =>
    compareStrings(x.after, y.after),
  );
  return {
    before,
    after,
    options,
    nodes: unionNodes,
    edges: unionEdges,
    hunks,
    matches,
    suggestions: mergeSuggestions(alignment.suggestions, restructuring.suggestions),
    delta,
    stats: computeStats(before, after, nodes, edges, hunks),
    index: createDiffIndex(unionNodes, unionEdges, hunks),
  };
}

/**
 * Computes the semantic diff between two graph versions. Inputs may be raw `GraphInput`s or
 * normalized `KGraph`s; when both are `KGraph`s with the same edge identity and no
 * `edgeIdentity` option is given, theirs is used.
 */
export function diff(
  before: GraphInput | KGraph,
  after: GraphInput | KGraph,
  options?: DiffOptions,
): DiffResult {
  let effective = options;
  if (
    options?.edgeIdentity === undefined &&
    isKGraph(before) &&
    isKGraph(after) &&
    before.edgeIdentity === after.edgeIdentity
  ) {
    effective = { ...options, edgeIdentity: before.edgeIdentity };
  }
  const resolved = resolveOptions(effective);
  return diffGraphs(
    toGraph(before, resolved.edgeIdentity),
    toGraph(after, resolved.edgeIdentity),
    resolved,
  );
}
