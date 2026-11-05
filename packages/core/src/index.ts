/**
 * @kgdiff/core: semantic diff engine for knowledge graphs.
 *
 * Signatures and documented behaviour are final (docs/architecture.md); the bodies live in
 * dedicated modules that follow docs/algorithms.md:
 *
 *   options.ts       defaults and validation
 *   normalize.ts     GraphInput → KGraph (§1)
 *   text.ts          textSimilarity, predicateLabel, blocking keys (§1–2)
 *   match.ts         node matching (§2)
 *   merge-split.ts   merges and splits (§3)
 *   classify.ts      union node ids and node facets (§4, §6)
 *   edges.ts         edge pairing and facets, union edge ids (§5–6)
 *   hunks.ts         hunk partition, context, phase, order (§7)
 *   delta.ts         delta emission, application, inversion (§8)
 *   stats.ts         statistics (§9)
 *   graph-json.ts    compact JSON of graphs, content hash
 *   json.ts          DiffJSON transport
 *   consistency.ts   checks of diffs read from JSON
 *   i18n.ts          formatHunk, facetLabel
 *   diff.ts          the pipeline
 */

import { applyDelta as apply, invertDelta as invert } from './delta.js';
import { diff as runDiff } from './diff.js';
import { hashGraph as hash, graphToJSON as toGraphJSON } from './graph-json.js';
import { formatHunk as format, facetLabel as labelOfFacet } from './i18n.js';
import { diffFromJSON as fromJSON, diffToJSON as toJSON } from './json.js';
import { matchNodes as match } from './match.js';
import { isKGraph as isGraph, normalize as normalizeGraph } from './normalize.js';
import { resolveOptions as resolve } from './options.js';
import { predicateLabel as labelOfPredicate, textSimilarity as similarity } from './text.js';
import type {
  ApplyOptions,
  Delta,
  DiffJSON,
  DiffOptions,
  DiffResult,
  FacetKind,
  GraphInput,
  GraphJSON,
  Hunk,
  KGraph,
  Locale,
  MatchOptions,
  MatchResult,
  NormalizeOptions,
  ResolvedDiffOptions,
} from './types.js';

export { KgdiffError } from './errors.js';
export { DEFAULT_HIERARCHY_PREDICATES } from './options.js';
export * from './types.js';

/**
 * Fill every option with its documented default: `match` = `{ strategy: 'auto',
 * threshold: 0.82, suggestThreshold: 0.6, maxCandidates: 8 }`, `edgeIdentity` =
 * `'structure'`, `hierarchyPredicates` = `DEFAULT_HIERARCHY_PREDICATES`, `detectMerges` /
 * `detectSplits` = `true`, `ignoreAttrs` = `[]` (sorted).
 *
 * @throws KgdiffError `invalid-input` for out-of-range or ill-typed options.
 */
export function resolveOptions(options?: DiffOptions): ResolvedDiffOptions {
  return resolve(options);
}

/**
 * Validate and index a graph. Pure; never mutates `input`. O(N + E).
 *
 * Labels default to ids; sets are sorted and de-duplicated; duplicate nodes are merged;
 * parallel edges are keyed `#2`, `#3`… in content order; dangling endpoints follow
 * `danglingEdges` (default `create`). Problems are reported in `issues`. The kgdiff JSON
 * marker (`format: 'kgdiff.graph'`, `version: 1`) is optional.
 *
 * @throws KgdiffError `invalid-input` for malformed input, `dangling-edge` (policy `error`),
 *   `unsupported-version` for another kgdiff format or graph version.
 */
export function normalize(input: GraphInput, options?: NormalizeOptions): KGraph {
  return normalizeGraph(input, options);
}

/** Type guard distinguishing a normalized `KGraph` from a raw `GraphInput`. */
export function isKGraph(value: unknown): value is KGraph {
  return isGraph(value);
}

/**
 * Align the nodes of two versions (exact ids, then 1:1 replacement hints, then similarity).
 * Matches are sorted by `after`. Similarity matching uses blocking on both sides, so it never
 * compares all pairs.
 */
export function matchNodes(before: KGraph, after: KGraph, options?: MatchOptions): MatchResult {
  return match(before, after, options);
}

/**
 * Compute the semantic diff between two graph versions: union graph with statuses and
 * facets, hunks, an invertible delta and stats. Deterministic: shuffling the input nodes or
 * edges does not change `diffToJSON` output.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function diff(
  before: GraphInput | KGraph,
  after: GraphInput | KGraph,
  options?: DiffOptions,
): DiffResult {
  return runDiff(before, after, options);
}

/**
 * Apply a delta. With `strict` (default) verifies the base hash and every precondition;
 * otherwise skips the ops whose precondition fails and reports each to `onSkip`.
 *
 * @throws KgdiffError `delta-base-mismatch`, `delta-conflict` (`{ opIndex, op, reason }`),
 *   `unsupported-version`, `invalid-input`.
 */
export function applyDelta(graph: KGraph, delta: Delta, options?: ApplyOptions): KGraph {
  return apply(graph, delta, options);
}

/** The delta that undoes `delta`: `applyDelta(applyDelta(g, d), invertDelta(d)) ≅ g`. */
export function invertDelta(delta: Delta): Delta {
  return invert(delta);
}

/**
 * Stable content hash of a normalized graph, e.g. `c53:0f3a9c…`. Ignores positions, meta,
 * the `implicit` flag and element order. O(size); memoized per graph.
 */
export function hashGraph(graph: KGraph): string {
  return hash(graph);
}

/**
 * Canonical JSON form of a graph: kgdiff JSON with its `kgdiff.graph` version 1 marker, sorted,
 * defaults omitted. Accepted by `normalize`.
 */
export function graphToJSON(graph: KGraph): GraphJSON {
  return toGraphJSON(graph);
}

/** Lossless, deterministic serialization of a diff. */
export function diffToJSON(result: DiffResult): DiffJSON {
  return toJSON(result);
}

/**
 * Inverse of `diffToJSON`. Rebuilds both graphs and the index, and checks that the document is
 * consistent: every element has the versions its status implies and lies in the hunk it names,
 * edges join union nodes, hunks own disjoint delta ops, the delta goes from the before to the
 * after graph (by content hash) and the counts match. Linear in the size of the diff.
 *
 * @throws KgdiffError `unsupported-version` for another format or version, `invalid-input` for a
 *   malformed or inconsistent document (the message names the first contradiction).
 */
export function diffFromJSON(json: DiffJSON): DiffResult {
  return fromJSON(json);
}

/** Similarity of two display strings in [0, 1]; robust to case, punctuation, word order and CJK. */
export function textSimilarity(a: string, b: string): number {
  return similarity(a, b);
}

/** Human-readable form of a predicate: `rdfs:subClassOf` → `subClassOf`, `…/part_of` → `part of`. */
export function predicateLabel(predicate: string): string {
  return labelOfPredicate(predicate);
}

/** Localized one-line title and subtitle for a hunk, e.g. “Merged “A” into “B”” / “+3 relations”. */
export function formatHunk(
  hunk: Hunk,
  diff: DiffResult,
  locale?: Locale,
): { readonly title: string; readonly subtitle: string } {
  return format(hunk, diff, locale);
}

/** Localized short name of a facet kind, e.g. `rename` → “Renamed” / “改名”. */
export function facetLabel(kind: FacetKind, locale?: Locale): string {
  return labelOfFacet(kind, locale);
}
