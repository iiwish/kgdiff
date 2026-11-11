/**
 * Public, immutable union nodes and edges from pipeline records: the last step of `diff` and
 * how `diffFromJSON` rebuilds a diff.
 */
import { KgdiffError } from './errors.js';
import type { EdgeRecord, NodeRecord } from './model.js';
import type { ChangeStatus, KGraph, MatchedUnionEdge, UnionEdge, UnionNode } from './types.js';
import { degree } from './util.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const VERSIONS: Readonly<Record<ChangeStatus, string>> = {
  added: 'only an after version',
  removed: 'only a before version',
  unchanged: 'both versions',
  modified: 'both versions',
};

/**
 * Union elements whose versions contradict their status. The pipeline never builds one; a
 * hand-written or corrupted `DiffJSON` can (`diffFromJSON` rebuilds through these functions).
 */
function misfit(what: string, status: ChangeStatus, detail = ''): never {
  throw new KgdiffError(
    'invalid-input',
    `${what} is ${status}, so it must have ${VERSIONS[status]}${detail}`,
  );
}

/**
 * Public, immutable union node from a pipeline record.
 * @throws KgdiffError `invalid-input` when the record's versions do not fit its status.
 */
export function toUnionNode(n: NodeRecord, before: KGraph, after: KGraph): UnionNode {
  const { id, status, facets, beforeId, afterId, before: b, after: a } = n;
  const what = `Union node "${id}"`;
  const versions = ' (beforeId and before, afterId and after)';
  const degrees = { before: degree(before, beforeId), after: degree(after, afterId) };
  let out: Mutable<UnionNode>;
  if (status === 'added') {
    if (!a || afterId === undefined || b || beforeId !== undefined) misfit(what, status, versions);
    out = {
      id,
      status,
      facets,
      label: a.label,
      types: a.types,
      degree: degrees,
      afterId,
      after: a,
    };
  } else if (status === 'removed') {
    if (!b || beforeId === undefined || a || afterId !== undefined) misfit(what, status, versions);
    out = {
      id,
      status,
      facets,
      label: b.label,
      types: b.types,
      degree: degrees,
      beforeId,
      before: b,
    };
  } else {
    if (!a || !b || afterId === undefined || beforeId === undefined) {
      misfit(what, status, versions);
    }
    out = {
      id,
      status,
      facets,
      label: a.label,
      types: a.types,
      degree: degrees,
      beforeId,
      afterId,
      before: b,
      after: a,
    };
  }
  if (n.hunk !== undefined) out.hunk = n.hunk;
  return out;
}

/**
 * Public, immutable union edge from a pipeline record (drops the pipeline-only `inPlace`).
 * @throws KgdiffError `invalid-input` when the record's versions do not fit its status.
 */
export function toUnionEdge(e: EdgeRecord): UnionEdge {
  const { id, source, target, predicate, label, status, facets, hierarchical } = e;
  const { before: b, after: a, beforeKey, afterKey } = e;
  const what = `Union edge ${id}`;
  const moved =
    e.sourceBefore !== undefined || e.targetBefore !== undefined || e.predicateBefore !== undefined;
  let out: Mutable<UnionEdge>;
  if (status === 'added') {
    if (!a || afterKey === undefined || b || beforeKey !== undefined) misfit(what, status);
    if (moved) misfit(what, status, ' and no before-version endpoints or predicate');
    out = {
      id,
      source,
      target,
      predicate,
      label,
      status,
      facets,
      hierarchical,
      afterKey,
      after: a,
    };
  } else if (status === 'removed') {
    if (!b || beforeKey === undefined || a || afterKey !== undefined) misfit(what, status);
    if (moved) misfit(what, status, ' and no before-version endpoints or predicate');
    out = {
      id,
      source,
      target,
      predicate,
      label,
      status,
      facets,
      hierarchical,
      beforeKey,
      before: b,
    };
  } else {
    if (!a || !b || afterKey === undefined || beforeKey === undefined) misfit(what, status);
    const matched: Mutable<MatchedUnionEdge> = {
      id,
      source,
      target,
      predicate,
      label,
      status,
      facets,
      hierarchical,
      beforeKey,
      afterKey,
      before: b,
      after: a,
    };
    if (e.sourceBefore !== undefined) matched.sourceBefore = e.sourceBefore;
    if (e.targetBefore !== undefined) matched.targetBefore = e.targetBefore;
    if (e.predicateBefore !== undefined) matched.predicateBefore = e.predicateBefore;
    out = matched;
  }
  if (e.hunk !== undefined) out.hunk = e.hunk;
  return out;
}
