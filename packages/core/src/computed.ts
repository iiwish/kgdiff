/**
 * `@kgdiff/core/computed`: reading back a diff that kgdiff's engine (`@kgdiff/compute`) has just
 * computed. Not part of the public API: `@kgdiff/compute` of the same version is its only caller,
 * and it may change in any release.
 *
 * Two things differ from `diffFromJSON`:
 *
 * - The checks are skipped (RFC 0002 §10, the trusted path): the engine of this build wrote the
 *   document a moment ago, from the graphs it was given, so its consistency is the engine's own
 *   (the corpus checks it). The result is the object `diffFromJSON` returns for the same document.
 * - Node positions come back. A `kgdiff.diff` document carries no `position` (positions are not
 *   part of a diff), so a diff read from one would lose the coordinates its graphs had, and
 *   `layoutDiff` would lay it out from scratch instead of anchoring it. They are taken from the
 *   graphs the diff was computed from, as `normalize` reads them, so that the result is the
 *   `DiffResult` the diff of those graphs is.
 */
import { diffFromTrustedJSON } from './json.js';
import { isKGraph, normalize } from './normalize.js';
import type {
  DiffJSON,
  DiffResult,
  GraphInput,
  Id,
  KGraph,
  NodeJSON,
  Point,
  UnionNodeJSON,
} from './types.js';
import { isRecord } from './util.js';

/** A graph as the engine was given it: normalized, as input, or as JSON text. */
export type ComputedGraph = GraphInput | KGraph | string;

/**
 * The `DiffResult` of a `kgdiff.diff` document the engine computed from `before` and `after`
 * (its text, or the value just parsed from it), read without `diffFromJSON`'s checks and with
 * the graphs' node positions.
 *
 * @internal For `@kgdiff/compute` of the same version. Never call it on a document from
 *   anywhere else: a report payload or a caller's JSON goes through `diffFromJSON`.
 */
export function readComputedDiff(
  document: string | DiffJSON,
  before: ComputedGraph,
  after: ComputedGraph,
): DiffResult {
  // A parsed document is the engine's, freshly parsed: positions are put on it in place.
  const json = typeof document === 'string' ? (JSON.parse(document) as DiffJSON) : document;
  const positions = { before: positionsOf(before), after: positionsOf(after) };
  if (positions.before || positions.after) withPositions(json, positions);
  return diffFromTrustedJSON(json);
}

/** The positions of a graph's nodes by normalized id, or undefined when it has none. */
function positionsOf(graph: ComputedGraph): ReadonlyMap<Id, Point> | undefined {
  if (typeof graph === 'string') {
    // Parsed only when it can hold a position; the engine has read the text already.
    if (!graph.includes('"position"')) return undefined;
    return positionsOf(JSON.parse(graph) as GraphInput);
  }
  if (isKGraph(graph)) return collect(graph);
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) return undefined;
  if (!graph.nodes.some((n) => isRecord(n) && n.position !== undefined)) return undefined;
  // `normalize` makes the ids and keeps the positions exactly as the engine's diff does.
  return collect(normalize(graph));
}

function collect(graph: KGraph): ReadonlyMap<Id, Point> | undefined {
  let positions: Map<Id, Point> | undefined;
  for (const node of graph.nodes.values()) {
    if (!node.position) continue;
    positions ??= new Map();
    positions.set(node.id, node.position);
  }
  return positions;
}

type Snapshot = NodeJSON & { position?: Point };
type Writable = { -readonly [K in keyof UnionNodeJSON]: UnionNodeJSON[K] };

/**
 * Puts each version's position on the node snapshots of a freshly parsed document. A node stored
 * once (no `before` snapshot: its before version is its after version under its before id) gets
 * a `before` snapshot of its own, so that each version keeps its own position.
 */
function withPositions(
  json: DiffJSON,
  positions: {
    readonly before: ReadonlyMap<Id, Point> | undefined;
    readonly after: ReadonlyMap<Id, Point> | undefined;
  },
): void {
  for (const node of json.nodes as Writable[]) {
    const pb = node.beforeId === undefined ? undefined : positions.before?.get(node.beforeId);
    const pa = node.afterId === undefined ? undefined : positions.after?.get(node.afterId);
    if (pb === undefined && pa === undefined) continue;
    if (node.status !== 'added' && node.before === undefined && node.after !== undefined) {
      node.before = { ...node.after, id: node.beforeId as Id };
    }
    if (node.before) node.before = place(node.before, pb);
    if (node.after && node.status !== 'removed') node.after = place(node.after, pa);
  }
}

function place(snapshot: NodeJSON, position: Point | undefined): NodeJSON {
  const { position: _, ...rest } = snapshot as Snapshot;
  return (position ? { ...rest, position } : rest) as NodeJSON;
}
