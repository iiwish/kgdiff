/**
 * The diff pipeline's shared context and the index of merges and splits (see `model.ts` for the
 * records the read path also builds).
 */
import type { Restructuring } from './merge-split.js';
import type { Id, KGraph, NodeMatch, ResolvedDiffOptions, UnionId } from './types.js';

export interface PipelineContext {
  readonly before: KGraph;
  readonly after: KGraph;
  readonly options: ResolvedDiffOptions;
  readonly hierarchy: ReadonlySet<string>;
  readonly ignoreAttrs: ReadonlySet<string>;
  readonly beforeToAfter: ReadonlyMap<Id, Id>;
  readonly afterToBefore: ReadonlyMap<Id, Id>;
  /** Matches not implied by equal ids (methods `hint` and `similarity`), by before id. */
  readonly inferred: ReadonlyMap<Id, NodeMatch>;
  readonly restructuring: Restructuring;
  /** Before ids whose union id differs from the id (rekeys and `@before` collisions). */
  readonly renamed: ReadonlyMap<Id, UnionId>;
  /** Union id of a before-version node id. */
  readonly unionOfBefore: (id: Id) => UnionId;
}

/** Union ids of the nodes involved in merges and splits. */
export interface RestructureIndex {
  /** Union id of a merge source → union id of its target. */
  readonly mergeTargetOf: ReadonlyMap<UnionId, UnionId>;
  /** Union id of a split source → union ids of its new targets (sorted). */
  readonly splitTargetsOf: ReadonlyMap<UnionId, readonly UnionId[]>;
  /** Union id of a new split target → union id of its source. */
  readonly splitSourceOf: ReadonlyMap<UnionId, UnionId>;
  /** `${unionId}\u0000${predicate}` for every node with a `move` facet on that predicate. */
  readonly moved: ReadonlySet<string>;
}

export function movedKey(node: UnionId, predicate: string): string {
  return `${node}\u0000${predicate}`;
}
