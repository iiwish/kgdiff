/**
 * Packed transport of a diff (`PackedDiffJSON`): the unchanged elements of a `DiffJSON` as tables
 * of indices into one string table, the rest as it is. Unchanged elements are most of a large
 * diff, and each repeats its ids several times (a node's id up to five times, an edge's triple
 * three times). Edges with a label or attributes of their own stay as they are. A large, mostly
 * unchanged diff shrinks to about a third: 28% of the bytes for 100k nodes / 300k edges, 46%
 * once gzipped.
 *
 * Lossless: `unpackDiffJSON(packDiffJSON(j))` is `j`, byte for byte, for what `diffToJSON`
 * writes. Only elements that unpack exactly are packed (exact key order included); a document
 * whose elements are not sorted by id is not packed at all, since unpacking merges by id.
 */
import { tripleKey } from './canonical.js';
import { KgdiffError } from './errors.js';
import type {
  DiffJSON,
  EdgeJSON,
  NodeJSON,
  PackedDiffJSON,
  UnionEdgeJSON,
  UnionNodeJSON,
} from './types.js';
import { isRecord } from './util.js';

const keysOf = (value: object): string => Object.keys(value).join(',');

function sortedById(list: readonly { readonly id: string }[]): boolean {
  for (let i = 1; i < list.length; i++) {
    if (!((list[i - 1] as { id: string }).id < (list[i] as { id: string }).id)) return false;
  }
  return true;
}

/** An unchanged node that unpacks from its id and its after snapshot alone. */
function packableNode(n: UnionNodeJSON): n is UnionNodeJSON & { readonly after: NodeJSON } {
  return (
    n.status === 'unchanged' &&
    n.beforeId === n.id &&
    n.afterId === n.id &&
    keysOf(n) === 'id,beforeId,afterId,after,status' &&
    isRecord(n.after) &&
    n.after.id === n.id &&
    Object.keys(n.after)[0] === 'id'
  );
}

/** An unchanged edge that unpacks from its triple alone. */
function packableEdge(e: UnionEdgeJSON): e is UnionEdgeJSON & { readonly after: EdgeJSON } {
  if (e.status !== 'unchanged' || keysOf(e) !== 'id,source,target,after,status') return false;
  const a = e.after;
  if (!isRecord(a) || a.source !== e.source || a.target !== e.target) return false;
  const keys = keysOf(a);
  if (keys !== 'source,target' && !(keys === 'source,target,predicate' && a.predicate !== '')) {
    return false;
  }
  if (a.predicate !== undefined && typeof a.predicate !== 'string') return false;
  return e.id === tripleKey(e.source, a.predicate ?? '', e.target);
}

/**
 * Packs the unchanged elements of a diff document into string-indexed tables (see
 * `PackedDiffJSON`). Deterministic: the same document always packs to the same bytes.
 */
export function packDiffJSON(json: DiffJSON): PackedDiffJSON {
  const pack = sortedById(json.nodes) && sortedById(json.edges);
  const strings: string[] = [];
  const at = new Map<string, number>();
  const ref = (s: string): number => {
    let i = at.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      at.set(s, i);
    }
    return i;
  };
  const unchangedNodes: (number | Omit<NodeJSON, 'id'>)[] = [];
  const nodes: UnionNodeJSON[] = [];
  for (const n of json.nodes) {
    if (pack && packableNode(n)) {
      const { id: _, ...snapshot } = n.after;
      unchangedNodes.push(ref(n.id), Object.keys(snapshot).length > 0 ? snapshot : 0);
    } else nodes.push(n);
  }
  const unchangedEdges: number[] = [];
  const edges: UnionEdgeJSON[] = [];
  for (const e of json.edges) {
    if (pack && packableEdge(e)) {
      unchangedEdges.push(ref(e.source), ref(e.after.predicate ?? ''), ref(e.target));
    } else edges.push(e);
  }
  return {
    format: 'kgdiff.diff.packed',
    version: 1,
    meta: json.meta,
    options: json.options,
    strings,
    unchangedNodes,
    unchangedEdges,
    nodes,
    edges,
    hunks: json.hunks,
    matches: json.matches,
    suggestions: json.suggestions,
    delta: json.delta,
    stats: json.stats,
  };
}

function invalid(message: string): never {
  throw new KgdiffError('invalid-input', `Packed diff: ${message}`);
}

/** Merges two lists sorted by id. */
function merge<T extends { readonly id: string }>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    out.push((a[i] as T).id < (b[j] as T).id ? (a[i++] as T) : (b[j++] as T));
  }
  while (i < a.length) out.push(a[i++] as T);
  while (j < b.length) out.push(b[j++] as T);
  return out;
}

/**
 * Inverse of `packDiffJSON`: the `DiffJSON` a packed diff was made from. The tables are
 * validated here; the diff itself is validated when read (`diffFromJSON`).
 *
 * @throws KgdiffError `unsupported-version` for another format or version, `invalid-input` for
 *   malformed tables.
 */
export function unpackDiffJSON(packed: PackedDiffJSON): DiffJSON {
  if (!isRecord(packed) || packed.format !== 'kgdiff.diff.packed') {
    throw new KgdiffError(
      'unsupported-version',
      'Not a packed kgdiff diff (expected format "kgdiff.diff.packed")',
    );
  }
  if (packed.version !== 1) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported packed diff version ${String(packed.version)}; this reader supports version 1`,
      { version: packed.version },
    );
  }
  const { strings, unchangedNodes, unchangedEdges } = packed;
  if (!Array.isArray(strings) || strings.some((s) => typeof s !== 'string')) {
    invalid('strings must be a list of strings');
  }
  if (!Array.isArray(unchangedNodes) || unchangedNodes.length % 2 !== 0) {
    invalid('unchangedNodes must be a list of (id, snapshot) pairs');
  }
  if (!Array.isArray(unchangedEdges) || unchangedEdges.length % 3 !== 0) {
    invalid('unchangedEdges must be a list of (source, predicate, target) triples');
  }
  if (!Array.isArray(packed.nodes) || !Array.isArray(packed.edges)) {
    invalid('nodes and edges must be lists');
  }
  const str = (i: unknown, where: string): string => {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= strings.length) {
      invalid(`${where} is not an index into strings`);
    }
    return strings[i] as string;
  };

  const nodes: UnionNodeJSON[] = [];
  for (let k = 0; k < unchangedNodes.length; k += 2) {
    const id = str(unchangedNodes[k], `unchangedNodes[${k}]`);
    const snapshot = unchangedNodes[k + 1];
    if (snapshot !== 0 && (!isRecord(snapshot) || Object.hasOwn(snapshot, 'id'))) {
      invalid(`unchangedNodes[${k + 1}] is not a snapshot without an id`);
    }
    const after: NodeJSON = snapshot === 0 ? { id } : { id, ...snapshot };
    nodes.push({ id, beforeId: id, afterId: id, after, status: 'unchanged' });
  }
  const edges: UnionEdgeJSON[] = [];
  for (let k = 0; k < unchangedEdges.length; k += 3) {
    const source = str(unchangedEdges[k], `unchangedEdges[${k}]`);
    const predicate = str(unchangedEdges[k + 1], `unchangedEdges[${k + 1}]`);
    const target = str(unchangedEdges[k + 2], `unchangedEdges[${k + 2}]`);
    const after: EdgeJSON = predicate === '' ? { source, target } : { source, target, predicate };
    edges.push({
      id: tripleKey(source, predicate, target),
      source,
      target,
      after,
      status: 'unchanged',
    });
  }
  return {
    format: 'kgdiff.diff',
    version: 1,
    meta: packed.meta,
    options: packed.options,
    nodes: merge(nodes, packed.nodes),
    edges: merge(edges, packed.edges),
    hunks: packed.hunks,
    matches: packed.matches,
    suggestions: packed.suggestions,
    delta: packed.delta,
    stats: packed.stats,
  };
}
