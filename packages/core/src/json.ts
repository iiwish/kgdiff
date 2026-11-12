/**
 * Lossless, deterministic JSON transport of a diff (`DiffJSON`).
 *
 * Size: a union element stores its `before` snapshot only when it differs from `after`
 * (unchanged elements are stored once). Everything else derived from the graphs — labels,
 * types, degrees, edge keys, `hierarchical`, the index — is rebuilt by `diffFromJSON`.
 */
import {
  attrsEqual,
  canonicalJSON,
  hasParallelSuffix,
  isEmptyAttrs,
  tripleKey,
} from './canonical.js';
import { checkConsistency } from './consistency.js';
import { nodeInput } from './delta.js';
import { createDiffIndex } from './diff-index.js';
import { KgdiffError } from './errors.js';
import { edgeToJSON, nodeContentEquals, nodeToJSON } from './graph-json.js';
import type { EdgeRecord, NodeRecord } from './model.js';
import { adjacencyOf, edgeOf, indexGraph, nodeOf, normalize, SNAPSHOT_TEXT } from './normalize.js';
import { resolveOptions } from './options.js';
import { rawPredicateLabel } from './text.js';
import type {
  DiffJSON,
  DiffResult,
  EdgeIdentity,
  EdgeInput,
  EdgeJSON,
  EdgeKey,
  GraphIssue,
  Hunk,
  Id,
  KGEdge,
  KGNode,
  KGraph,
  NodeInput,
  NodeJSON,
  ResolvedDiffOptions,
  UnionEdge,
  UnionEdgeJSON,
  UnionNode,
  UnionNodeJSON,
} from './types.js';
import { toUnionEdge, toUnionNode } from './union.js';
import { isRecord } from './util.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function sameEdge(a: KGEdge, b: KGEdge): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    a.predicate === b.predicate &&
    a.label === b.label &&
    a.id === b.id &&
    attrsEqual(a.attrs, b.attrs)
  );
}

function unionNodeToJSON(n: UnionNode): UnionNodeJSON {
  const out = { id: n.id } as Mutable<UnionNodeJSON>;
  if (n.beforeId !== undefined) out.beforeId = n.beforeId;
  if (n.afterId !== undefined) out.afterId = n.afterId;
  if (
    n.before &&
    !(n.after && n.before.implicit === n.after.implicit && nodeContentEquals(n.before, n.after))
  ) {
    out.before = nodeToJSON(n.before);
  }
  if (n.after) out.after = nodeToJSON(n.after);
  out.status = n.status;
  if (n.facets.length) out.facets = n.facets;
  if (n.hunk !== undefined) out.hunk = n.hunk;
  return out;
}

function unionEdgeToJSON(e: UnionEdge): UnionEdgeJSON {
  const out = { id: e.id, source: e.source, target: e.target } as Mutable<UnionEdgeJSON>;
  if (e.sourceBefore !== undefined) out.sourceBefore = e.sourceBefore;
  if (e.targetBefore !== undefined) out.targetBefore = e.targetBefore;
  if (e.predicateBefore !== undefined) out.predicateBefore = e.predicateBefore;
  if (e.before && !(e.after && sameEdge(e.before, e.after))) out.before = edgeToJSON(e.before);
  if (e.after) out.after = edgeToJSON(e.after);
  out.status = e.status;
  if (e.facets.length) out.facets = e.facets;
  if (e.hunk !== undefined) out.hunk = e.hunk;
  return out;
}

function optionsToJSON(o: ResolvedDiffOptions): ResolvedDiffOptions {
  return {
    match: {
      strategy: o.match.strategy,
      threshold: o.match.threshold,
      suggestThreshold: o.match.suggestThreshold,
      maxCandidates: o.match.maxCandidates,
    },
    edgeIdentity: o.edgeIdentity,
    hierarchyPredicates: o.hierarchyPredicates,
    detectMerges: o.detectMerges,
    detectSplits: o.detectSplits,
    ignoreAttrs: o.ignoreAttrs,
  };
}

/**
 * Lossless, deterministic serialization of a diff: the same diff always produces the same
 * bytes under `JSON.stringify`. `index` is not serialized (it is rebuilt).
 */
export function diffToJSON(result: DiffResult): DiffJSON {
  return {
    format: 'kgdiff.diff',
    version: 1,
    meta: { before: result.before.meta, after: result.after.meta },
    options: optionsToJSON(result.options),
    nodes: result.nodes.map(unionNodeToJSON),
    edges: result.edges.map(unionEdgeToJSON),
    hunks: result.hunks,
    matches: result.matches,
    suggestions: result.suggestions,
    delta: result.delta,
    stats: result.stats,
  };
}

function invalid(message: string): never {
  throw new KgdiffError('invalid-input', message);
}

const STATUSES: ReadonlySet<string> = new Set(['unchanged', 'added', 'removed', 'modified']);

/** Validates the shape of a DiffJSON document before anything is rebuilt from it. */
function checkEnvelope(json: DiffJSON): void {
  const j = json as unknown as Record<string, unknown>;
  const meta = j.meta;
  if (!isRecord(meta) || !isRecord(meta.before) || !isRecord(meta.after)) {
    invalid('A kgdiff diff needs meta.before and meta.after objects');
  }
  if (!isRecord(j.options)) invalid('A kgdiff diff needs an options object');
  for (const field of ['nodes', 'edges', 'hunks'] as const) {
    if (!Array.isArray(j[field])) invalid(`A kgdiff diff needs a ${field} array`);
  }
  for (const field of ['matches', 'suggestions'] as const) {
    if (j[field] !== undefined && !Array.isArray(j[field]))
      invalid(`diff.${field} must be an array`);
  }
  if (!isRecord(j.delta)) invalid('A kgdiff diff needs a delta');
  if (!isRecord(j.stats)) invalid('A kgdiff diff needs stats');
  /** A snapshot of the version an element is not in (an added node's `before`, …). */
  const stray = (x: { status: string; before?: unknown; after?: unknown }): string | undefined =>
    x.status === 'added' && x.before !== undefined
      ? 'before'
      : x.status === 'removed' && x.after !== undefined
        ? 'after'
        : undefined;
  json.nodes.forEach((n, i) => {
    if (!isRecord(n) || typeof n.id !== 'string' || !STATUSES.has(n.status)) {
      invalid(`diff.nodes[${i}] needs a string id and a valid status`);
    }
    const side = stray(n);
    if (side) invalid(`diff.nodes[${i}] ("${n.id}") is ${n.status}, so it has no ${side} snapshot`);
  });
  json.edges.forEach((e, i) => {
    const valid =
      isRecord(e) &&
      typeof e.id === 'string' &&
      typeof e.source === 'string' &&
      typeof e.target === 'string' &&
      STATUSES.has(e.status);
    if (!valid) invalid(`diff.edges[${i}] needs string id / source / target and a valid status`);
    const side = stray(e);
    if (side) invalid(`diff.edges[${i}] (${e.id}) is ${e.status}, so it has no ${side} snapshot`);
  });
}

function fromNodeJSON(json: NodeJSON): NodeInput {
  const input: NodeInput & { types?: readonly string[]; implicit?: boolean } = { ...json };
  return input;
}

/** Identity of an edge that survives re-normalization (keys of parallel copies included). */
function fingerprint(edge: EdgeJSON | KGEdge, mode: EdgeIdentity): string {
  if (mode === 'id' && edge.id !== undefined) return `i${edge.id}`;
  const predicate = edge.predicate ?? '';
  const label = edge.label ?? rawPredicateLabel(predicate);
  return `t${tripleKey(edge.source, predicate, edge.target)}\u0000${canonicalJSON([label, edge.attrs ?? {}])}`;
}

/** `fingerprint(edge) === fingerprint(json)`, without building either. */
function sameFingerprint(edge: KGEdge, json: EdgeJSON, mode: EdgeIdentity): boolean {
  if (mode === 'id' && (edge.id !== undefined || json.id !== undefined)) return edge.id === json.id;
  const predicate = json.predicate ?? '';
  return (
    edge.source === json.source &&
    edge.target === json.target &&
    edge.predicate === predicate &&
    edge.label === (json.label ?? rawPredicateLabel(predicate)) &&
    (json.attrs === undefined || json.attrs === null
      ? isEmptyAttrs(edge.attrs)
      : attrsEqual(edge.attrs, json.attrs))
  );
}

/**
 * Finds the edge of a re-normalized graph a snapshot became. An identity that occurs once is keyed
 * by its id or triple, so that key is tried first; only parallel copies and key collisions need
 * the fingerprint index, built on first use.
 */
function edgeFinder(graph: KGraph): (json: EdgeJSON) => KGEdge | undefined {
  const mode = graph.edgeIdentity;
  let index: Map<string, KGEdge> | undefined;
  return (json) => {
    const key =
      mode === 'id' && json.id !== undefined
        ? json.id
        : tripleKey(json.source, json.predicate ?? '', json.target);
    const direct = graph.edges.get(key);
    if (direct && sameFingerprint(direct, json, mode)) return direct;
    if (!index) {
      index = new Map();
      for (const edge of graph.edges.values()) index.set(fingerprint(edge, mode), edge);
    }
    return index.get(fingerprint(json, mode));
  };
}

const hasBefore = (status: string): boolean => status !== 'added';
const hasAfter = (status: string): boolean => status !== 'removed';

/** Both graphs of a diff document, and the version of each union edge in them. */
export interface RebuiltGraphs {
  readonly before: KGraph;
  readonly after: KGraph;
  /** The before version of `json.edges[i]` (`e`), if its status has one. */
  beforeEdge(e: UnionEdgeJSON, i: number): KGEdge | undefined;
  /** The after version of `json.edges[i]` (`e`), if its status has one. */
  afterEdge(e: UnionEdgeJSON, i: number): KGEdge | undefined;
}

/**
 * The graphs as `normalize` rebuilds them from the snapshots (any document), their text taken as
 * written (`SNAPSHOT_TEXT`): the reference that `canonicalGraphs` must match.
 */
export function normalizedGraphs(json: DiffJSON, mode: EdgeIdentity): RebuiltGraphs {
  const afterNodes: NodeInput[] = [];
  for (const n of json.nodes) {
    if (!hasAfter(n.status)) continue;
    if (!n.after) invalid(`Union node "${n.id}" (${n.status}) has no after snapshot`);
    afterNodes.push(fromNodeJSON(n.after));
  }
  const afterEdges: EdgeInput[] = [];
  for (const e of json.edges) {
    if (!hasAfter(e.status)) continue;
    if (!e.after) invalid(`Union edge ${e.id} (${e.status}) has no after snapshot`);
    afterEdges.push(e.after);
  }
  const after = normalize(
    { meta: json.meta.after, nodes: afterNodes, edges: afterEdges },
    { edgeIdentity: mode },
    SNAPSHOT_TEXT,
  );

  const beforeNodes: NodeInput[] = [];
  for (const n of json.nodes) {
    if (!hasBefore(n.status)) continue;
    if (n.before) {
      beforeNodes.push(fromNodeJSON(n.before));
      continue;
    }
    const twin = n.afterId === undefined ? undefined : after.nodes.get(n.afterId);
    if (!twin || n.beforeId === undefined) invalid(`Union node "${n.id}" has no before snapshot`);
    beforeNodes.push(nodeInput({ ...twin, id: n.beforeId }));
  }
  const beforeEdges: EdgeInput[] = [];
  for (const e of json.edges) {
    if (!hasBefore(e.status)) continue;
    const snapshot = e.before ?? e.after;
    if (!snapshot) invalid(`Union edge ${e.id} has no before snapshot`);
    beforeEdges.push(snapshot);
  }
  const before = normalize(
    { meta: json.meta.before, nodes: beforeNodes, edges: beforeEdges },
    { edgeIdentity: mode },
    SNAPSHOT_TEXT,
  );

  const findBefore = edgeFinder(before);
  const findAfter = edgeFinder(after);
  return {
    before,
    after,
    beforeEdge(e) {
      const snapshot = e.before ?? e.after;
      return hasBefore(e.status) && snapshot ? findBefore(snapshot) : undefined;
    },
    afterEdge: (e) => (hasAfter(e.status) && e.after ? findAfter(e.after) : undefined),
  };
}

/**
 * Fast path of `diffFromJSON`: the graphs read straight from the snapshots, keeping the edge each
 * union edge becomes instead of looking it up. `diffToJSON` writes each node and edge once and
 * canonical, so normalizing them only re-makes each the same way (`nodeOf`, `edgeOf`). Anything
 * more `normalize` would do — merge a repeated id or key, add a node for a dangling end, report
 * an issue — or a snapshot `edgeFinder` would not find gives up with undefined, and the caller
 * normalizes. When it succeeds, the graphs equal `normalizedGraphs` field for field, in order.
 */
export function canonicalGraphs(json: DiffJSON, mode: EdgeIdentity): RebuiltGraphs | undefined {
  try {
    return readCanonical(json, mode);
  } catch {
    // Something `normalize` rejects: it reports it, in its own order.
    return undefined;
  }
}

function readCanonical(json: DiffJSON, mode: EdgeIdentity): RebuiltGraphs | undefined {
  // Parallel copies of a triple are keyed `#2`, `#3`… by normalizing, and their union ids show
  // it: no need to read the graphs to find that out.
  if (mode === 'structure' && json.edges.some((e) => hasParallelSuffix(e.id))) return undefined;
  // A repeated id or key is caught by the size of the map not growing (the overwritten entry
  // does not matter: the whole read is given up).
  const issues: GraphIssue[] = [];
  const afterNodes = new Map<Id, KGNode>();
  for (const n of json.nodes) {
    if (!hasAfter(n.status)) continue;
    const node = isRecord(n.after) ? nodeOf(n.after, issues) : undefined;
    if (!node || afterNodes.size === afterNodes.set(node.id, node).size) return undefined;
  }
  const beforeNodes = new Map<Id, KGNode>();
  for (const n of json.nodes) {
    if (!hasBefore(n.status)) continue;
    let node: KGNode | undefined;
    if (n.before) node = isRecord(n.before) ? nodeOf(n.before, issues) : undefined;
    else {
      // Stored once: the after node under its before id.
      const twin = n.afterId === undefined ? undefined : afterNodes.get(n.afterId);
      if (twin && n.beforeId !== undefined) node = nodeOf(twin, issues, n.beforeId);
    }
    if (!node || beforeNodes.size === beforeNodes.set(node.id, node).size) return undefined;
  }

  const afterEdges = new Map<EdgeKey, KGEdge>();
  const beforeEdges = new Map<EdgeKey, KGEdge>();
  const read = (
    snapshot: unknown,
    edges: Map<EdgeKey, KGEdge>,
    key?: EdgeKey,
  ): KGEdge | undefined => {
    if (!isRecord(snapshot)) return undefined;
    const edge = edgeOf(snapshot, mode, issues, key);
    return edge &&
      sameFingerprint(edge, snapshot as unknown as EdgeJSON, mode) &&
      edges.size < edges.set(edge.key, edge).size
      ? edge
      : undefined;
  };
  const afterOf: (KGEdge | undefined)[] = [];
  const beforeOf: (KGEdge | undefined)[] = [];
  for (const e of json.edges) {
    let a: KGEdge | undefined;
    if (hasAfter(e.status)) {
      a = read(e.after, afterEdges);
      if (!a) return undefined;
    }
    let b: KGEdge | undefined;
    if (hasBefore(e.status)) {
      const snapshot = e.before ?? e.after;
      // Stored once: the same record, so the same key.
      b = read(snapshot, beforeEdges, snapshot === e.after ? a?.key : undefined);
      if (!b) return undefined;
    }
    afterOf.push(a);
    beforeOf.push(b);
  }
  const afterAdjacency = adjacencyOf(afterEdges, afterNodes);
  const beforeAdjacency = afterAdjacency && adjacencyOf(beforeEdges, beforeNodes);
  if (issues.length > 0 || !beforeAdjacency || !afterAdjacency) return undefined;
  return {
    before: indexGraph(json.meta.before, beforeNodes, beforeEdges, mode, [], beforeAdjacency),
    after: indexGraph(json.meta.after, afterNodes, afterEdges, mode, [], afterAdjacency),
    beforeEdge: (_, i) => beforeOf[i],
    afterEdge: (_, i) => afterOf[i],
  };
}

/**
 * Inverse of `diffToJSON`: rebuilds both graphs from the union snapshots, the union
 * elements and the index. `diffToJSON(diffFromJSON(j))` equals `j`.
 *
 * Snapshot text (labels, aliases, types) is read as written, never normalized again: the writer
 * normalized it, and the result must not depend on the runtime's Unicode version. A snapshot
 * whose text is not the text the delta's content hashes were computed from (edited, or not in
 * NFC) fails the check of those hashes.
 *
 * @throws KgdiffError `unsupported-version` for an unknown format or version,
 *   `invalid-input` for a malformed document.
 */
export function diffFromJSON(json: DiffJSON): DiffResult {
  return readDiff(json, false);
}

/**
 * `diffFromJSON` without the document's checks (its envelope and `checkConsistency`), for a
 * document this build's engine has just written (`readComputedDiff`). The result is the object
 * `diffFromJSON` returns for the same document: the checks only throw, they build nothing.
 * Never for a document read from elsewhere (a report, a file, a caller's JSON).
 */
export function diffFromTrustedJSON(json: DiffJSON, issues?: GraphIssues): DiffResult {
  return readDiff(json, true, issues);
}

/** The issues of a diff's two graphs, which a `kgdiff.diff` document does not carry. */
export interface GraphIssues {
  readonly before: readonly GraphIssue[];
  readonly after: readonly GraphIssue[];
}

function readDiff(json: DiffJSON, trusted: boolean, issues?: GraphIssues): DiffResult {
  if (!isRecord(json) || json.format !== 'kgdiff.diff') {
    throw new KgdiffError(
      'unsupported-version',
      'Not a kgdiff diff (expected format "kgdiff.diff")',
    );
  }
  if (json.version !== 1) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported diff version ${String(json.version)}; this reader supports version 1`,
      { version: json.version },
    );
  }
  if (!trusted) checkEnvelope(json);
  const options = resolveOptions(json.options);
  const mode = options.edgeIdentity;
  const graphs = canonicalGraphs(json, mode) ?? normalizedGraphs(json, mode);
  const before = issues ? { ...graphs.before, issues: issues.before } : graphs.before;
  const after = issues ? { ...graphs.after, issues: issues.after } : graphs.after;

  // A version a node or edge must not have is left out here, so `toUnionNode` / `toUnionEdge`
  // report it (a removed node with an afterId, …).
  const nodes = json.nodes.map((n) => {
    const record: Mutable<NodeRecord> = { id: n.id, status: n.status, facets: n.facets ?? [] };
    if (n.beforeId !== undefined) {
      record.beforeId = n.beforeId;
      const node = hasBefore(n.status) ? before.nodes.get(n.beforeId) : undefined;
      if (node) record.before = node;
    }
    if (n.afterId !== undefined) {
      record.afterId = n.afterId;
      const node = hasAfter(n.status) ? after.nodes.get(n.afterId) : undefined;
      if (node) record.after = node;
    }
    if (n.hunk !== undefined) record.hunk = n.hunk;
    return toUnionNode(record, before, after);
  });

  const hierarchy = new Set(options.hierarchyPredicates);
  const edges = json.edges.map((e, i) => {
    const b = graphs.beforeEdge(e, i);
    const a = graphs.afterEdge(e, i);
    const shown = a ?? b;
    if (!shown) invalid(`Union edge ${e.id} could not be rebuilt`);
    const record: Mutable<EdgeRecord> = {
      id: e.id,
      source: e.source,
      target: e.target,
      predicate: shown.predicate,
      label: shown.label,
      status: e.status,
      facets: e.facets ?? [],
      hierarchical: hierarchy.has(shown.predicate),
      inPlace: false,
    };
    if (e.sourceBefore !== undefined) record.sourceBefore = e.sourceBefore;
    if (e.targetBefore !== undefined) record.targetBefore = e.targetBefore;
    if (e.predicateBefore !== undefined) record.predicateBefore = e.predicateBefore;
    if (b) {
      record.beforeKey = b.key;
      record.before = b;
    }
    if (a) {
      record.afterKey = a.key;
      record.after = a;
    }
    if (e.hunk !== undefined) record.hunk = e.hunk;
    return toUnionEdge(record);
  });

  const hunks: readonly Hunk[] = json.hunks;
  const { delta, stats } = json;
  if (!trusted) checkConsistency({ before, after, options, nodes, edges, hunks, delta, stats });
  return {
    before,
    after,
    options,
    nodes,
    edges,
    hunks,
    matches: json.matches ?? [],
    suggestions: json.suggestions ?? [],
    delta,
    stats,
    index: createDiffIndex(nodes, edges, hunks),
  };
}
