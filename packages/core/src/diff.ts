/**
 * The diff pipeline (docs/algorithms.md):
 * normalize → match → merges / splits → classify nodes → pair edges → hunks → delta → stats.
 */
import { assignUnionIds, classifyNodes } from './classify.js';
import { withEdgeIdentity } from './delta.js';
import { buildDelta } from './delta-emit.js';
import { createDiffIndex } from './diff-index.js';
import { classifyEdges } from './edges.js';
import { buildHunks } from './hunks.js';
import { alignNodes, sortSuggestions } from './match.js';
import { detectRestructuring } from './merge-split.js';
import { isKGraph, normalize } from './normalize.js';
import { resolveOptions } from './options.js';
import { orderHunks } from './order.js';
import type { PipelineContext } from './pipeline.js';
import { ProfileCache } from './similarity.js';
import { computeStats } from './stats.js';
import type {
  DiffOptions,
  DiffResult,
  EdgeIdentity,
  GraphInput,
  KGraph,
  MatchSuggestion,
  NodeMatch,
  ResolvedDiffOptions,
} from './types.js';
import { toUnionEdge, toUnionNode } from './union.js';
import { compareStrings } from './util.js';

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
