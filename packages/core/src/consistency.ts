/**
 * Consistency of a diff read from JSON (`diffFromJSON`): everything `diff` guarantees between the
 * union elements, the hunks, the delta and the stats. A hand-written, truncated or corrupted
 * document fails here with its first contradiction, instead of misleading a viewer (wrong counts,
 * edges to nowhere) or exporting a delta for other graphs. Linear in the size of the diff.
 *
 * Checked elsewhere: the envelope (`checkEnvelope` in json.ts) and the versions each element must
 * have for its status (`toUnionNode` / `toUnionEdge`). Not checked: whether each delta op is right
 * (applying the delta does that, strictly), and the content of facets beyond their kinds.
 */
import { canonicalJSON } from './canonical.js';
import { checkDelta } from './delta.js';
import { KgdiffError } from './errors.js';
import { hashGraph } from './graph-json.js';
import { hunkSummary } from './hunk-summary.js';
import { computeStats } from './stats.js';
import type {
  AttrValue,
  ChangeStatus,
  Delta,
  DiffStats,
  EdgeFacetKind,
  GraphRef,
  Hunk,
  HunkKind,
  Id,
  KGraph,
  NodeFacetKind,
  ReplayPhase,
  ResolvedDiffOptions,
  UnionEdge,
  UnionId,
  UnionNode,
} from './types.js';
import { isRecord } from './util.js';

export interface RebuiltDiff {
  readonly before: KGraph;
  readonly after: KGraph;
  readonly options: ResolvedDiffOptions;
  readonly nodes: readonly UnionNode[];
  readonly edges: readonly UnionEdge[];
  readonly hunks: readonly Hunk[];
  readonly delta: Delta;
  readonly stats: DiffStats;
}

/**
 * Known kinds, as keys of records typed by their unions: adding a facet, hunk kind or phase to
 * types.ts fails to compile until it is listed here too.
 */
const kinds = <K extends string>(record: Record<K, true>): ReadonlySet<string> =>
  new Set(Object.keys(record));
const NODE_FACETS = kinds<NodeFacetKind>({
  rekey: true,
  rename: true,
  mergedInto: true,
  mergeTarget: true,
  splitFrom: true,
  splitInto: true,
  move: true,
  deprecate: true,
  replacement: true,
  types: true,
  aliases: true,
  attrs: true,
});
const EDGE_FACETS = kinds<EdgeFacetKind>({
  retarget: true,
  predicate: true,
  label: true,
  attrs: true,
  collapsed: true,
});
const HUNK_KINDS = kinds<HunkKind>({
  add: true,
  remove: true,
  merge: true,
  split: true,
  modify: true,
  relations: true,
});
const PHASES = kinds<ReplayPhase>({ remove: true, restructure: true, modify: true, add: true });

function fail(message: string): never {
  throw new KgdiffError('invalid-input', message);
}

const isStringList = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Elements by id; a repeated id is an error. */
function byId<T extends { readonly id: string }>(
  items: readonly T[],
  what: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) fail(`The ${what} id "${item.id}" is used more than once`);
    map.set(item.id, item);
  }
  return map;
}

function checkHunkShape(h: unknown, i: number): asserts h is Hunk {
  const valid =
    isRecord(h) &&
    typeof h.id === 'string' &&
    HUNK_KINDS.has(h.kind as string) &&
    PHASES.has(h.phase as string) &&
    typeof h.anchor === 'string' &&
    isStringList(h.nodes) &&
    isStringList(h.edges) &&
    isStringList(h.context) &&
    isStringList(h.requires) &&
    Array.isArray(h.ops) &&
    isRecord(h.summary);
  if (!valid) {
    fail(
      `diff.hunks[${i}] needs a string id and anchor, a known kind and phase, ` +
        'nodes / edges / context / requires lists of ids, ops and a summary',
    );
  }
}

/** Facets, status and hunk of one union element agree. */
function checkChange(
  what: string,
  status: ChangeStatus,
  facets: unknown,
  kinds: ReadonlySet<string>,
  hunk: unknown,
  hunks: ReadonlyMap<string, Hunk>,
): void {
  if (!Array.isArray(facets) || facets.some((f) => !isRecord(f) || !kinds.has(f.kind as string))) {
    fail(`${what}: facets must be a list of known facets`);
  }
  if (status === 'unchanged') {
    if (facets.length > 0) fail(`${what} is unchanged but has facets`);
    if (hunk !== undefined) fail(`${what} is unchanged but belongs to a hunk`);
    return;
  }
  if (status === 'modified' && facets.length === 0) fail(`${what} is modified but has no facets`);
  if (hunk === undefined) fail(`${what} is ${status} but belongs to no hunk`);
  if (typeof hunk !== 'string' || !hunks.has(hunk)) {
    fail(`${what} belongs to the hunk ${JSON.stringify(hunk)}, which the diff does not have`);
  }
}

/** Endpoints of union edges are union nodes, and agree with the edge's versions. */
function checkEndpoints(
  e: UnionEdge,
  nodes: ReadonlyMap<UnionId, UnionNode>,
  unionOfBefore: ReadonlyMap<Id, UnionId>,
): void {
  const what = `Union edge ${e.id}`;
  for (const end of [e.source, e.target, e.sourceBefore, e.targetBefore]) {
    if (end !== undefined && !nodes.has(end)) {
      fail(`${what} points to "${end}", which is not a union node`);
    }
  }
  if (e.after && (e.after.source !== e.source || e.after.target !== e.target)) {
    fail(`${what}: source and target must be the endpoints of its after version`);
  }
  // A changed endpoint or predicate is a change: it differs, and a facet says so.
  const has = (kind: string, end?: string): boolean =>
    e.facets.some(
      (f) => f.kind === kind && (end === undefined || (f as { end?: string }).end === end),
    );
  if (e.sourceBefore !== undefined && (e.sourceBefore === e.source || !has('retarget', 'source'))) {
    fail(`${what}: sourceBefore needs another source and a source retarget facet`);
  }
  if (e.targetBefore !== undefined && (e.targetBefore === e.target || !has('retarget', 'target'))) {
    fail(`${what}: targetBefore needs another target and a target retarget facet`);
  }
  if (e.predicateBefore !== undefined && (e.predicateBefore === e.predicate || !has('predicate'))) {
    fail(`${what}: predicateBefore needs another predicate and a predicate facet`);
  }
  if (e.before) {
    const source = unionOfBefore.get(e.before.source);
    const target = unionOfBefore.get(e.before.target);
    if (source !== (e.sourceBefore ?? e.source) || target !== (e.targetBefore ?? e.target)) {
      fail(
        `${what}: its before version's endpoints must be sourceBefore ?? source, targetBefore ?? target`,
      );
    }
    if ((e.predicateBefore ?? e.predicate) !== e.before.predicate) {
      fail(`${what}: its before version's predicate must be predicateBefore ?? predicate`);
    }
  }
}

/** Hunks list exactly the elements that name them, own disjoint ops and require known hunks. */
function checkHunks(
  d: RebuiltDiff,
  nodes: ReadonlyMap<UnionId, UnionNode>,
  edges: ReadonlyMap<UnionId, UnionEdge>,
  hunks: ReadonlyMap<string, Hunk>,
): void {
  const listed = new Set<UnionId>();
  const listedEdges = new Set<UnionId>();
  const owned = new Uint8Array(d.delta.ops.length);
  d.hunks.forEach((h, i) => {
    const what = `Hunk "${h.id}"`;
    if (h.order !== i) fail(`${what} has order ${String(h.order)} but is listed at ${i}`);
    if (!nodes.has(h.anchor))
      fail(`${what} is anchored on "${h.anchor}", which is not a union node`);
    const members = h.nodes.map((id) => {
      const n = nodes.get(id);
      if (!n || n.hunk !== h.id || listed.has(id)) {
        fail(`${what} lists the node "${id}", which is not one of its own`);
      }
      listed.add(id);
      return n;
    });
    const memberEdges = h.edges.map((id) => {
      const e = edges.get(id);
      if (!e || e.hunk !== h.id || listedEdges.has(id)) {
        fail(`${what} lists the edge ${id}, which is not one of its own`);
      }
      listedEdges.add(id);
      return e;
    });
    for (const id of h.context) {
      if (!nodes.has(id)) fail(`${what} has "${id}" as context, which is not a union node`);
    }
    let last = -1;
    for (const op of h.ops as readonly unknown[]) {
      if (typeof op !== 'number' || !Number.isInteger(op) || op <= last || op >= owned.length) {
        fail(`${what}: ops must be ascending indices into delta.ops`);
      }
      if (owned[op]) fail(`delta.ops[${op}] belongs to more than one hunk`);
      owned[op] = 1;
      last = op;
    }
    for (const r of h.requires) {
      if (r === h.id || !hunks.has(r)) fail(`${what} requires "${r}", which is not another hunk`);
    }
    const summary = hunkSummary(members, memberEdges);
    if (
      canonicalJSON(summary as unknown as AttrValue) !==
      canonicalJSON(h.summary as unknown as AttrValue)
    ) {
      fail(`${what}: its summary does not match its nodes and edges`);
    }
  });
  // Every element naming a hunk was listed by it (the lists hold no strangers or repeats).
  const named = (list: readonly { readonly hunk?: string }[]): number =>
    list.reduce((k, x) => k + (x.hunk === undefined ? 0 : 1), 0);
  if (listed.size !== named(d.nodes)) fail('A union node names a hunk that does not list it');
  if (listedEdges.size !== named(d.edges)) fail('A union edge names a hunk that does not list it');
}

/** The delta describes this diff's graphs (each op is checked when the delta is applied). */
function checkDeltaRefs(d: RebuiltDiff): void {
  checkDelta(d.delta);
  if (d.delta.edgeIdentity !== d.options.edgeIdentity) {
    fail('The delta uses another edge identity than the diff');
  }
  const check = (ref: GraphRef, graph: KGraph, side: 'base' | 'target'): void => {
    const version = side === 'base' ? 'before' : 'after';
    if (ref.nodes !== graph.nodes.size || ref.edges !== graph.edges.size) {
      fail(`delta.${side} counts other nodes / edges than the ${version} graph of the diff`);
    }
    if (ref.hash !== hashGraph(graph)) {
      fail(
        `delta.${side} is another graph (hash ${ref.hash}) than the ${version} graph of the diff`,
      );
    }
  };
  check(d.delta.base, d.before, 'base');
  check(d.delta.target, d.after, 'target');
}

/** @throws KgdiffError `invalid-input` at the first contradiction (see the module comment). */
export function checkConsistency(d: RebuiltDiff): void {
  const nodes = byId(d.nodes, 'union node');
  const edges = byId(d.edges, 'union edge');
  d.hunks.forEach((h, i) => {
    checkHunkShape(h, i);
  });
  const hunks = byId(d.hunks, 'hunk');
  const unionOfBefore = new Map<Id, UnionId>();
  for (const n of d.nodes) {
    checkChange(`Union node "${n.id}"`, n.status, n.facets, NODE_FACETS, n.hunk, hunks);
    if (n.beforeId !== undefined) unionOfBefore.set(n.beforeId, n.id);
  }
  for (const e of d.edges) {
    checkChange(`Union edge ${e.id}`, e.status, e.facets, EDGE_FACETS, e.hunk, hunks);
    checkEndpoints(e, nodes, unionOfBefore);
  }
  checkHunks(d, nodes, edges, hunks);
  checkDeltaRefs(d);
  const stats = computeStats(d.before, d.after, d.nodes, d.edges, d.hunks);
  if (
    canonicalJSON(stats as unknown as AttrValue) !== canonicalJSON(d.stats as unknown as AttrValue)
  ) {
    fail('diff.stats do not match the union elements and hunks');
  }
}
