/**
 * Internal model shared by the diff pipeline stages. Records are mutable drafts that are
 * turned into the immutable public `UnionNode` / `UnionEdge` objects at the very end.
 */
import type {
  ChangeStatus,
  EdgeFacet,
  EdgeKey,
  Id,
  KGEdge,
  KGNode,
  NodeFacet,
  UnionId,
} from './types.js';

export interface NodeRecord {
  readonly id: UnionId;
  readonly beforeId?: Id;
  readonly afterId?: Id;
  readonly before?: KGNode;
  readonly after?: KGNode;
  readonly status: ChangeStatus;
  readonly facets: readonly NodeFacet[];
  hunk?: string;
}

export interface EdgeRecord {
  readonly id: UnionId;
  readonly source: UnionId;
  readonly target: UnionId;
  readonly sourceBefore?: UnionId;
  readonly targetBefore?: UnionId;
  readonly predicate: string;
  readonly predicateBefore?: string;
  readonly label: string;
  readonly beforeKey?: EdgeKey;
  readonly afterKey?: EdgeKey;
  readonly before?: KGEdge;
  readonly after?: KGEdge;
  readonly status: ChangeStatus;
  readonly facets: readonly EdgeFacet[];
  readonly hierarchical: boolean;
  /**
   * True when the delta can update the paired edge in place (`edge.set` / `edge.attr`);
   * otherwise a modified edge is replaced (`edge.remove` + `edge.add`).
   */
  readonly inPlace: boolean;
  hunk?: string;
}

/** Canonical facet order (docs/algorithms.md §4), then edge facets. */
export const FACET_ORDER = [
  'rekey',
  'rename',
  'mergedInto',
  'mergeTarget',
  'splitFrom',
  'splitInto',
  'move',
  'deprecate',
  'replacement',
  'types',
  'aliases',
  'attrs',
  'retarget',
  'predicate',
  'label',
  'collapsed',
] as const;
