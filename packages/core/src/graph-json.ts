/**
 * Compact JSON forms of nodes, edges and graphs, and the graph content hash.
 */
import { attrsEqual, Cyrb53, canonicalAttrs, isEmptyAttrs } from './canonical.js';
import { rawPredicateLabel } from './text.js';
import type { EdgeJSON, GraphJSON, Id, KGEdge, KGNode, KGraph, NodeJSON } from './types.js';
import { compareStrings, stringArraysEqual } from './util.js';

/** Compact, canonical JSON of a node (defaults omitted, attrs keys sorted). */
export function nodeToJSON(node: KGNode, id: Id = node.id): NodeJSON {
  const out: { -readonly [K in keyof NodeJSON]: NodeJSON[K] } = { id };
  if (node.label !== id) out.label = node.label;
  if (node.types.length) out.types = node.types;
  if (node.aliases.length) out.aliases = node.aliases;
  if (!isEmptyAttrs(node.attrs)) out.attrs = canonicalAttrs(node.attrs);
  if (node.deprecated) out.deprecated = true;
  if (node.replaces.length) out.replaces = node.replaces;
  if (node.replacedBy.length) out.replacedBy = node.replacedBy;
  if (node.implicit) out.implicit = true;
  return out;
}

/**
 * Compact, canonical JSON of an edge, optionally with endpoints mapped to other ids. The label is
 * left out when it is `rawPredicateLabel(predicate)`, which a reader restores without normalizing
 * (a predicate whose readable part is not in NFC keeps its label).
 */
export function edgeToJSON(
  edge: KGEdge,
  source: Id = edge.source,
  target: Id = edge.target,
): EdgeJSON {
  const out: { -readonly [K in keyof EdgeJSON]: EdgeJSON[K] } =
    edge.id === undefined ? { source, target } : { id: edge.id, source, target };
  if (edge.predicate !== '') out.predicate = edge.predicate;
  if (edge.label !== rawPredicateLabel(edge.predicate)) out.label = edge.label;
  if (!isEmptyAttrs(edge.attrs)) out.attrs = canonicalAttrs(edge.attrs);
  return out;
}

/**
 * Canonical JSON form of a graph: the `kgdiff.graph` version 1 marker, nodes sorted by id,
 * edges by key, defaults omitted, attribute keys sorted. `normalize(graphToJSON(g))` rebuilds
 * `g` (positions excepted).
 */
export function graphToJSON(graph: KGraph): GraphJSON {
  const nodes = [...graph.nodes.values()]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((node) => nodeToJSON(node));
  const edges = [...graph.edges.values()]
    .sort((a, b) => compareStrings(a.key, b.key))
    .map((edge) => edgeToJSON(edge));
  const marker = { format: 'kgdiff.graph', version: 1 } as const;
  return Object.keys(graph.meta).length
    ? { ...marker, meta: graph.meta, nodes, edges }
    : { ...marker, nodes, edges };
}

/**
 * Equality of node content: everything except id, position and the `implicit` flag
 * (which records provenance, not content).
 */
export function nodeContentEquals(a: KGNode, b: KGNode): boolean {
  return (
    a.label === b.label &&
    a.deprecated === b.deprecated &&
    stringArraysEqual(a.types, b.types) &&
    stringArraysEqual(a.aliases, b.aliases) &&
    stringArraysEqual(a.replaces, b.replaces) &&
    stringArraysEqual(a.replacedBy, b.replacedBy) &&
    attrsEqual(a.attrs, b.attrs)
  );
}

// ─── Content hash ────────────────────────────────────────────────────────────

const hashes = new WeakMap<KGraph, string>();

function feedNode(h: Cyrb53, node: KGNode): void {
  h.code(0x4e).string(node.id).string(node.label); // N
  h.code(node.types.length);
  for (const t of node.types) h.string(t);
  h.code(node.aliases.length);
  for (const a of node.aliases) h.string(a);
  h.value(node.attrs).code(node.deprecated ? 1 : 0);
  h.code(node.replaces.length);
  for (const r of node.replaces) h.string(r);
  h.code(node.replacedBy.length);
  for (const r of node.replacedBy) h.string(r);
}

function feedEdge(h: Cyrb53, edge: KGEdge, withId: boolean): void {
  h.code(0x45); // E
  if (withId && edge.id !== undefined) h.code(1).string(edge.id);
  else h.code(0);
  h.string(edge.source).string(edge.predicate).string(edge.target).string(edge.label);
  h.value(edge.attrs);
}

/**
 * Stable content hash of a normalized graph, `c53:` + 14 hex digits (53 bits).
 *
 * Covers node content (id, label, types, aliases, attrs, deprecated, replaces, replacedBy)
 * and edge content (endpoints, predicate, label, attrs, and the edge id under `id` identity).
 * Ignores positions, meta, the `implicit` flag and the order of nodes, edges and attribute
 * keys. Each element is encoded unambiguously (tagged, length-prefixed, keys sorted) and
 * hashed with cyrb53; the per-element 64-bit digests are summed (an order-independent
 * multiset hash, so no sorting is needed) and the sums hashed once more. O(size of graph);
 * memoized per graph object.
 */
export function hashGraph(graph: KGraph): string {
  const cached = hashes.get(graph);
  if (cached) return cached;
  const h = new Cyrb53();
  let n1 = 0;
  let n2 = 0;
  for (const node of graph.nodes.values()) {
    feedNode(h.reset(), node);
    const [a, b] = h.digestPair();
    n1 = (n1 + a) >>> 0;
    n2 = (n2 + b) >>> 0;
  }
  const withIds = graph.edgeIdentity === 'id';
  let e1 = 0;
  let e2 = 0;
  for (const edge of graph.edges.values()) {
    feedEdge(h.reset(), edge, withIds);
    const [a, b] = h.digestPair();
    e1 = (e1 + a) >>> 0;
    e2 = (e2 + b) >>> 0;
  }
  const digest = new Cyrb53()
    .update(`kgdiff.graph.v1|${graph.nodes.size}|${n1}|${n2}|${graph.edges.size}|${e1}|${e2}`)
    .digest();
  const hash = `c53:${digest.toString(16).padStart(14, '0')}`;
  hashes.set(graph, hash);
  return hash;
}
