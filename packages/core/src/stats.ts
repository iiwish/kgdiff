/**
 * Diff statistics (docs/algorithms.md §9).
 */
import type { EdgeRecord, NodeRecord } from './model.js';
import { FACET_ORDER } from './model.js';
import type {
  CountDelta,
  DiffStats,
  FacetKind,
  Hunk,
  HunkKind,
  KGraph,
  TypeStat,
} from './types.js';
import { compareStrings, getOrCreate } from './util.js';

const HUNK_KINDS: readonly HunkKind[] = ['add', 'remove', 'merge', 'split', 'modify', 'relations'];

type MutableCounts = { added: number; removed: number; modified: number; unchanged: number };

const zero = (): MutableCounts => ({ added: 0, removed: 0, modified: 0, unchanged: 0 });

export function computeStats(
  before: KGraph,
  after: KGraph,
  nodes: readonly NodeRecord[],
  edges: readonly Pick<EdgeRecord, 'status' | 'facets'>[],
  hunks: readonly Pick<Hunk, 'kind'>[],
): DiffStats {
  const nodeCounts = zero();
  const edgeCounts = zero();
  const facets = Object.fromEntries(FACET_ORDER.map((k) => [k, 0])) as Record<FacetKind, number>;
  const byType = new Map<string, MutableCounts>();
  const countFacets = (list: readonly { readonly kind: FacetKind }[]): void => {
    if (list.length === 0) return;
    for (const kind of new Set(list.map((f) => f.kind))) facets[kind]++;
  };
  for (const n of nodes) {
    nodeCounts[n.status]++;
    countFacets(n.facets);
    const type = (n.after ?? n.before)?.types[0] ?? '';
    getOrCreate(byType, type, zero)[n.status]++;
  }
  for (const e of edges) {
    edgeCounts[e.status]++;
    countFacets(e.facets);
  }
  const hunkCounts = Object.fromEntries(HUNK_KINDS.map((k) => [k, 0])) as Record<HunkKind, number>;
  for (const h of hunks) hunkCounts[h.kind]++;
  const changes = (c: CountDelta): number => c.added + c.removed + c.modified;
  const types: TypeStat[] = [...byType]
    .map(([type, c]) => ({ type, ...c }))
    .sort((a, b) => changes(b) - changes(a) || compareStrings(a.type, b.type));
  return {
    nodes: nodeCounts,
    edges: edgeCounts,
    before: { nodes: before.nodes.size, edges: before.edges.size },
    after: { nodes: after.nodes.size, edges: after.edges.size },
    facets,
    hunks: hunkCounts,
    byType: types,
    identical: changes(nodeCounts) + changes(edgeCounts) === 0,
  };
}
