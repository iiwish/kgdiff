/**
 * Union node ids (docs/algorithms.md §6) and node classification (§4).
 */
import { attrKeys, attrsEqual, attrValueEquals, canonicalize, ownAttr } from './canonical.js';
import { sortedSetDiff } from './engine-util.js';
import type { Restructuring } from './merge-split.js';
import type { NodeRecord } from './model.js';
import type { PipelineContext, RestructureIndex } from './pipeline.js';
import { movedKey } from './pipeline.js';
import type { AttrChange, Attrs, Id, KGNode, KGraph, NodeFacet, UnionId } from './types.js';
import { compareStrings, getOrCreate, stringArraysEqual } from './util.js';

/**
 * Union ids of before-version nodes that differ from their own id: matched nodes take the
 * after id; unmatched nodes keep their id unless an after node already uses it, in which case
 * `@before` is appended (repeatedly, in the pathological case that the result is taken too).
 */
export function assignUnionIds(
  before: KGraph,
  after: KGraph,
  beforeToAfter: ReadonlyMap<Id, Id>,
): Map<Id, UnionId> {
  const renamed = new Map<Id, UnionId>();
  const colliding: Id[] = [];
  const taken = new Set<string>();
  for (const id of before.nodes.keys()) {
    const match = beforeToAfter.get(id);
    if (match !== undefined) {
      if (match !== id) renamed.set(id, match);
    } else if (after.nodes.has(id)) {
      colliding.push(id);
    } else {
      taken.add(id);
    }
  }
  colliding.sort();
  for (const id of colliding) {
    let union = `${id}@before`;
    while (after.nodes.has(union) || taken.has(union)) union += '@before';
    taken.add(union);
    renamed.set(id, union);
  }
  return renamed;
}

/** Attribute changes sorted by key, `ignore`d keys skipped, values canonicalized. */
export function attrChanges(
  before: Attrs,
  after: Attrs,
  ignore: ReadonlySet<string>,
): AttrChange[] {
  if (before === after || attrsEqual(before, after, ignore)) return [];
  const keys = new Set([...attrKeys(before), ...attrKeys(after)]);
  const changes: AttrChange[] = [];
  for (const key of [...keys].sort()) {
    if (ignore.has(key)) continue;
    const change = attrChange(key, before, after);
    if (change) changes.push(change);
  }
  return changes;
}

/** The changes `attrChanges` leaves out: those of the `ignored` keys (sorted), for the delta. */
export function ignoredAttrChanges(
  before: Attrs,
  after: Attrs,
  ignored: readonly string[],
): AttrChange[] {
  if (before === after) return [];
  return ignored.flatMap((key) => attrChange(key, before, after) ?? []);
}

/** The change of one attribute, its values canonicalized; undefined when it did not change. */
function attrChange(key: string, before: Attrs, after: Attrs): AttrChange | undefined {
  const b = ownAttr(before, key);
  const a = ownAttr(after, key);
  if (attrValueEquals(b, a)) return undefined;
  if (b === undefined) return { key, after: canonicalize(a as NonNullable<typeof a>) };
  if (a === undefined) return { key, before: canonicalize(b) };
  return { key, before: canonicalize(b), after: canonicalize(a) };
}

/** Union-id views of merges and splits (moves are added by `classifyNodes`). */
function restructureIndex(
  r: Restructuring,
  ub: (id: Id) => UnionId,
): Omit<RestructureIndex, 'moved'> {
  const mergeTargetOf = new Map<UnionId, UnionId>();
  for (const group of r.merges)
    for (const s of group.sources) mergeTargetOf.set(ub(s.id), group.target);
  const splitTargetsOf = new Map<UnionId, readonly UnionId[]>();
  const splitSourceOf = new Map<UnionId, UnionId>();
  for (const group of r.splits) {
    const source = ub(group.source);
    splitTargetsOf.set(
      source,
      group.targets.map((t) => t.id),
    );
    for (const t of group.targets) splitSourceOf.set(t.id, source);
  }
  return { mergeTargetOf, splitTargetsOf, splitSourceOf };
}

type Parents = Map<string, Set<UnionId>>;
type MoveFacet = Extract<NodeFacet, { kind: 'move' }>;

/** Parents per child and hierarchy predicate (`child → predicate → union ids`), in one pass. */
function hierarchyParents(
  graph: KGraph,
  hierarchy: ReadonlySet<string>,
  toUnion: (id: Id) => UnionId,
): Map<Id, Parents> {
  const parents = new Map<Id, Parents>();
  if (hierarchy.size === 0) return parents;
  for (const edge of graph.edges.values()) {
    if (!hierarchy.has(edge.predicate)) continue;
    const byPredicate = getOrCreate(parents, edge.source, (): Parents => new Map());
    getOrCreate(byPredicate, edge.predicate, () => new Set<UnionId>()).add(toUnion(edge.target));
  }
  return parents;
}

/**
 * `move` facets, one per hierarchy predicate whose parent set changed. Parents that merged
 * into (or split out of) a node count as that node, so restructurings do not look like moves.
 */
function moveFacets(
  before: Parents | undefined,
  after: Parents | undefined,
  index: Omit<RestructureIndex, 'moved'>,
): MoveFacet[] {
  if (!before && !after) return [];
  const predicates = new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])]);
  const facets: MoveFacet[] = [];
  for (const predicate of [...predicates].sort()) {
    const from = before?.get(predicate) ?? new Set<UnionId>();
    const to = after?.get(predicate) ?? new Set<UnionId>();
    const canonicalFrom = new Set([...from].map((u) => index.mergeTargetOf.get(u) ?? u));
    const canonicalTo = new Set([...to].map((u) => index.splitSourceOf.get(u) ?? u));
    const removed = [...from].filter((u) => !canonicalTo.has(index.mergeTargetOf.get(u) ?? u));
    const added = [...to].filter((u) => !canonicalFrom.has(index.splitSourceOf.get(u) ?? u));
    if (removed.length || added.length) {
      facets.push({ kind: 'move', predicate, from: removed.sort(), to: added.sort() });
    }
  }
  return facets;
}

function setFacet(
  kind: 'types' | 'aliases',
  b: readonly string[],
  a: readonly string[],
): NodeFacet[] {
  if (stringArraysEqual(b, a)) return [];
  const { added, removed } = sortedSetDiff(b, a);
  return [{ kind, added, removed }];
}

/** Facets of a matched pair in canonical order (docs/algorithms.md §4). */
function matchedFacets(
  ctx: PipelineContext,
  b: KGNode,
  a: KGNode,
  index: Omit<RestructureIndex, 'moved'>,
  parents: { readonly before: Map<Id, Parents>; readonly after: Map<Id, Parents> },
): NodeFacet[] {
  const r = ctx.restructuring;
  const facets: NodeFacet[] = [];
  // With strategy `similarity` ids are declared meaningless: an id difference is no change.
  if (b.id !== a.id && ctx.options.match.strategy !== 'similarity') {
    facets.push({
      kind: 'rekey',
      from: b.id,
      to: a.id,
      score: ctx.inferred.get(b.id)?.score ?? 1,
    });
  }
  if (b.label !== a.label) facets.push({ kind: 'rename', from: b.label, to: a.label });
  const mergedInto = r.mergeBySource.get(b.id);
  if (mergedInto) facets.push(mergedIntoFacet(b.id, mergedInto));
  const mergeTarget = r.mergeByTarget.get(a.id);
  if (mergeTarget) {
    facets.push({
      kind: 'mergeTarget',
      sources: mergeTarget.sources.map((s) => ctx.unionOfBefore(s.id)).sort(),
    });
  }
  const splitInto = r.splitBySource.get(b.id);
  if (splitInto) facets.push({ kind: 'splitInto', targets: splitInto.targets.map((t) => t.id) });
  const moves = moveFacets(parents.before.get(b.id), parents.after.get(a.id), index);
  // A node that is being obsoleted (deprecated, merged or split away) drops its parents as part
  // of the obsoletion; only gaining a parent still counts as a move.
  const obsoleted = (!b.deprecated && a.deprecated) || Boolean(mergedInto) || Boolean(splitInto);
  facets.push(...(obsoleted ? moves.filter((m) => m.to.length > 0) : moves));
  if (b.deprecated !== a.deprecated) facets.push({ kind: 'deprecate', deprecated: a.deprecated });
  if (
    !stringArraysEqual(b.replaces, a.replaces) ||
    !stringArraysEqual(b.replacedBy, a.replacedBy)
  ) {
    facets.push({
      kind: 'replacement',
      replaces: sortedSetDiff(b.replaces, a.replaces),
      replacedBy: sortedSetDiff(b.replacedBy, a.replacedBy),
    });
  }
  facets.push(...setFacet('types', b.types, a.types));
  facets.push(...setFacet('aliases', b.aliases, a.aliases));
  const changes = attrChanges(b.attrs, a.attrs, ctx.ignoreAttrs);
  if (changes.length) facets.push({ kind: 'attrs', changes });
  return facets;
}

function mergedIntoFacet(source: Id, group: Restructuring['merges'][number]): NodeFacet {
  const contribution = group.sources.find((s) => s.id === source);
  return {
    kind: 'mergedInto',
    target: group.target,
    confidence: contribution?.confidence ?? 1,
    via: contribution?.via ?? 'hint',
  };
}

/**
 * Builds one record per union node, sorted by union id, plus the restructure index the
 * edge stage needs. A matched node is `modified` exactly when it has a facet.
 */
export function classifyNodes(ctx: PipelineContext): {
  readonly nodes: NodeRecord[];
  readonly index: RestructureIndex;
} {
  const r = ctx.restructuring;
  const base = restructureIndex(r, ctx.unionOfBefore);
  const moved = new Set<string>();
  const nodes: NodeRecord[] = [];
  const parents = {
    before: hierarchyParents(ctx.before, ctx.hierarchy, ctx.unionOfBefore),
    after: hierarchyParents(ctx.after, ctx.hierarchy, (id) => id),
  };

  for (const a of ctx.after.nodes.values()) {
    const beforeId = ctx.afterToBefore.get(a.id);
    if (beforeId === undefined) {
      const facets: NodeFacet[] = [];
      const mergeTarget = r.mergeByTarget.get(a.id);
      if (mergeTarget) {
        facets.push({
          kind: 'mergeTarget',
          sources: mergeTarget.sources.map((s) => ctx.unionOfBefore(s.id)).sort(),
        });
      }
      const split = r.splitByTarget.get(a.id);
      if (split) {
        const t = split.targets.find((c) => c.id === a.id);
        facets.push({
          kind: 'splitFrom',
          source: ctx.unionOfBefore(split.source),
          confidence: t?.confidence ?? 1,
          via: t?.via ?? 'hint',
        });
      }
      nodes.push({ id: a.id, afterId: a.id, after: a, status: 'added', facets });
      continue;
    }
    const b = ctx.before.nodes.get(beforeId) as KGNode;
    const facets = matchedFacets(ctx, b, a, base, parents);
    for (const f of facets) if (f.kind === 'move') moved.add(movedKey(a.id, f.predicate));
    nodes.push({
      id: a.id,
      beforeId,
      afterId: a.id,
      before: b,
      after: a,
      status: facets.length ? 'modified' : 'unchanged',
      facets,
    });
  }

  for (const b of ctx.before.nodes.values()) {
    if (ctx.beforeToAfter.has(b.id)) continue;
    const facets: NodeFacet[] = [];
    const mergedInto = r.mergeBySource.get(b.id);
    if (mergedInto) facets.push(mergedIntoFacet(b.id, mergedInto));
    const splitInto = r.splitBySource.get(b.id);
    if (splitInto) facets.push({ kind: 'splitInto', targets: splitInto.targets.map((t) => t.id) });
    nodes.push({
      id: ctx.unionOfBefore(b.id),
      beforeId: b.id,
      before: b,
      status: 'removed',
      facets,
    });
  }

  nodes.sort((x, y) => compareStrings(x.id, y.id));
  return { nodes, index: { ...base, moved } };
}
