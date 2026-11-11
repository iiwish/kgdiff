/**
 * Edge pairing and classification (docs/algorithms.md §5) and union edge ids (§6).
 *
 * Every before edge is mapped into union-id space (endpoints through the node mapping), then
 * paired with after edges in five passes: exact, carried by merge / split, predicate change,
 * retarget, leftovers. Passes 2–5 only see the (usually few) edges left over by pass 1.
 */
import { canonicalJSON, hasParallelSuffix, splitStructuralKey, tripleKey } from './canonical.js';
import { attrChanges } from './classify.js';
import type { EdgeRecord } from './model.js';
import type { PipelineContext, RestructureIndex } from './pipeline.js';
import { movedKey } from './pipeline.js';
import { predicateLabel } from './text.js';
import type { EdgeFacet, EdgeKey, KGEdge, UnionId } from './types.js';
import { compareStrings, getOrCreate, pushTo } from './util.js';

type Cause = 'edit' | 'merge' | 'split' | 'move';

/** What distinguishes parallel copies of one triple. */
function parallelContent(edge: KGEdge): string {
  return canonicalJSON([edge.label, edge.attrs]);
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Mapped {
  readonly edge: KGEdge;
  /** Union ids of the before endpoints. */
  readonly source: UnionId;
  readonly target: UnionId;
  /** Union-space identity: the edge id (id-keyed) or the structural key with its suffix. */
  readonly key: string;
}

export function classifyEdges(ctx: PipelineContext, index: RestructureIndex): EdgeRecord[] {
  const { before, after } = ctx;
  const mode = ctx.options.edgeIdentity;
  const ub = ctx.unionOfBefore;
  const structural = (e: KGEdge): boolean => mode === 'structure' || e.id === undefined;
  const records: EdgeRecord[] = [];
  const remainingAfter = new Set<EdgeKey>(after.edges.keys());

  // Parallel copies of a triple exist only when a graph reported them (structure identity), or
  // when an edge id pushed a structural key aside (id identity); otherwise skip the search.
  const mayHaveParallel = (g: typeof before): boolean =>
    mode === 'id' || g.issues.some((issue) => issue.code === 'duplicate-edge');
  const parallel = new Set<string>();
  if (mayHaveParallel(before) || mayHaveParallel(after)) {
    for (const edge of before.edges.values()) {
      if (structural(edge) && hasParallelSuffix(edge.key)) {
        const base = splitStructuralKey(edge.key).base;
        const source = ub(edge.source);
        const target = ub(edge.target);
        parallel.add(
          source === edge.source && target === edge.target
            ? base
            : tripleKey(source, edge.predicate, target),
        );
      }
    }
    for (const e of after.edges.values()) {
      if (structural(e) && hasParallelSuffix(e.key)) parallel.add(splitStructuralKey(e.key).base);
    }
  }

  const causeOf = (end: 'source' | 'target', from: UnionId, to: UnionId, e: KGEdge): Cause => {
    if (index.mergeTargetOf.get(from) === to) return 'merge';
    if (index.splitTargetsOf.get(from)?.includes(to)) return 'split';
    if (ctx.hierarchy.has(e.predicate)) {
      const child = end === 'target' ? e.source : to;
      if (
        index.moved.has(movedKey(child, e.predicate)) ||
        index.moved.has(movedKey(from, e.predicate))
      ) {
        return 'move';
      }
    }
    return 'edit';
  };

  const pair = (m: Mapped, a: KGEdge, inPlace: boolean, forced?: Cause): void => {
    remainingAfter.delete(a.key);
    const b = m.edge;
    const sourceChanged = m.source !== a.source;
    const targetChanged = m.target !== a.target;
    const predicateChanged = b.predicate !== a.predicate;
    const facets: EdgeFacet[] = [];
    if (sourceChanged) {
      const cause = forced ?? causeOf('source', m.source, a.source, a);
      facets.push({ kind: 'retarget', end: 'source', from: m.source, to: a.source, cause });
    }
    if (targetChanged) {
      const cause = forced ?? causeOf('target', m.target, a.target, a);
      facets.push({ kind: 'retarget', end: 'target', from: m.target, to: a.target, cause });
    }
    if (predicateChanged) facets.push({ kind: 'predicate', from: b.predicate, to: a.predicate });
    const derivedLabels =
      predicateChanged &&
      b.label === predicateLabel(b.predicate) &&
      a.label === predicateLabel(a.predicate);
    if (b.label !== a.label && !derivedLabels)
      facets.push({ kind: 'label', from: b.label, to: a.label });
    const changes = attrChanges(b.attrs, a.attrs, ctx.ignoreAttrs);
    if (changes.length) facets.push({ kind: 'attrs', changes });
    const record: Mutable<EdgeRecord> = {
      id: a.key,
      source: a.source,
      target: a.target,
      predicate: a.predicate,
      label: a.label,
      beforeKey: b.key,
      afterKey: a.key,
      before: b,
      after: a,
      status: facets.length ? 'modified' : 'unchanged',
      facets,
      hierarchical: ctx.hierarchy.has(a.predicate),
      inPlace: inPlace && !sourceChanged && !targetChanged && !predicateChanged,
    };
    if (sourceChanged) record.sourceBefore = m.source;
    if (targetChanged) record.targetBefore = m.target;
    if (predicateChanged) record.predicateBefore = b.predicate;
    records.push(record);
  };

  // ── 1. Exact ── (before edges are mapped into union space on the way)
  let remaining: Mapped[] = [];
  const groups = new Map<string, { before: Mapped[]; after: KGEdge[] }>();
  const groupOf = (base: string): { before: Mapped[]; after: KGEdge[] } =>
    getOrCreate(groups, base, () => ({ before: [], after: [] }));
  for (const edge of before.edges.values()) {
    const source = ub(edge.source);
    const target = ub(edge.target);
    const isStructural = structural(edge);
    let key = edge.key;
    if (isStructural && (source !== edge.source || target !== edge.target)) {
      key = tripleKey(source, edge.predicate, target) + splitStructuralKey(edge.key).suffix;
    }
    if (!isStructural) {
      const a = after.edges.get(key);
      const m = { edge, source, target, key };
      if (a && a.id === edge.id && !structural(a)) pair(m, a, true);
      else remaining.push(m);
      continue;
    }
    if (parallel.size) {
      const { base } = splitStructuralKey(key);
      if (parallel.has(base)) {
        groupOf(base).before.push({ edge, source, target, key });
        continue;
      }
    }
    const a = after.edges.get(key);
    if (
      a &&
      structural(a) &&
      a.source === source &&
      a.target === target &&
      a.predicate === edge.predicate
    ) {
      pair({ edge, source, target, key }, a, true);
    } else {
      remaining.push({ edge, source, target, key });
    }
  }
  if (groups.size > 0) {
    for (const e of after.edges.values()) {
      if (!structural(e)) continue;
      const { base } = splitStructuralKey(e.key);
      if (parallel.has(base) && groups.has(base)) groupOf(base).after.push(e);
    }
    for (const base of [...groups.keys()].sort()) {
      const group = groups.get(base) as { before: Mapped[]; after: KGEdge[] };
      const afterCopies = group.after.sort((x, y) => compareStrings(x.key, y.key));
      // Identical content first, so an unchanged copy is never reported as modified; then the
      // rest in key order. Linear in the group size (content → copies, plus a cursor).
      const byContent = new Map<string, KGEdge[]>();
      for (const a of afterCopies) pushTo(byContent, parallelContent(a), a);
      const used = new Set<KGEdge>();
      const left: Mapped[] = [];
      for (const m of group.before.sort((x, y) => compareStrings(x.key, y.key))) {
        const same = byContent.get(parallelContent(m.edge));
        const a = same?.pop();
        if (!a) {
          left.push(m);
          continue;
        }
        used.add(a);
        pair(m, a, false);
      }
      let cursor = 0;
      for (const m of left) {
        while (cursor < afterCopies.length && used.has(afterCopies[cursor] as KGEdge)) cursor++;
        const a = afterCopies[cursor++];
        if (a) pair(m, a, false);
        else remaining.push(m);
      }
    }
  }

  // Remaining after edges indexed by triple (union space), in key order.
  const afterKeysByTriple = (): Map<string, KGEdge[]> => {
    const byTriple = new Map<string, KGEdge[]>();
    for (const e of after.edges.values()) {
      pushTo(byTriple, tripleKey(e.source, e.predicate, e.target), e);
    }
    for (const list of byTriple.values()) list.sort((x, y) => compareStrings(x.key, y.key));
    return byTriple;
  };
  remaining.sort((x, y) => compareStrings(x.key, y.key));

  // ── 2. Carried by merge / split ──
  const collapsed = new Map<Mapped, UnionId>();
  if (remaining.length && (index.mergeTargetOf.size || index.splitTargetsOf.size)) {
    const byTriple = afterKeysByTriple();
    const next: Mapped[] = [];
    for (const m of remaining) {
      const p = m.edge.predicate;
      const fs = index.mergeTargetOf.get(m.source) ?? m.source;
      const ft = index.mergeTargetOf.get(m.target) ?? m.target;
      if (fs !== m.source || ft !== m.target) {
        const candidates = byTriple.get(tripleKey(fs, p, ft)) ?? [];
        const free = candidates.find((a) => remainingAfter.has(a.key));
        if (free) pair(m, free, false, 'merge');
        else if (candidates[0]) collapsed.set(m, candidates[0].key);
        else next.push(m);
        continue;
      }
      const sources = [m.source, ...(index.splitTargetsOf.get(m.source) ?? [])];
      const targets = [m.target, ...(index.splitTargetsOf.get(m.target) ?? [])];
      let carried: KGEdge | undefined;
      for (const s of sources) {
        for (const t of targets) {
          if (carried || (s === m.source && t === m.target)) continue;
          carried = byTriple.get(tripleKey(s, p, t))?.find((a) => remainingAfter.has(a.key));
        }
      }
      if (carried) pair(m, carried, false, 'split');
      else next.push(m);
    }
    remaining = next;
  }

  // ── 3. Predicate change, 4. retarget: unique one-to-one leftovers per group ──
  const pairUnique = (
    beforeKey: (m: Mapped) => string,
    afterKey: (a: KGEdge) => string,
    accept: (m: Mapped, a: KGEdge) => boolean,
  ): void => {
    if (remaining.length === 0 || remainingAfter.size === 0) return;
    const bGroups = new Map<string, Mapped[]>();
    for (const m of remaining) pushTo(bGroups, beforeKey(m), m);
    const aGroups = new Map<string, KGEdge[]>();
    for (const key of remainingAfter) {
      const a = after.edges.get(key) as KGEdge;
      const k = afterKey(a);
      if (bGroups.has(k)) pushTo(aGroups, k, a);
    }
    const used = new Set<Mapped>();
    for (const k of [...bGroups.keys()].sort()) {
      const bs = bGroups.get(k) as Mapped[];
      const as = aGroups.get(k);
      if (bs.length !== 1 || as?.length !== 1) continue; // never guess
      const m = bs[0] as Mapped;
      const a = as[0] as KGEdge;
      if (!accept(m, a)) continue;
      pair(m, a, false);
      used.add(m);
    }
    if (used.size) remaining = remaining.filter((m) => !used.has(m));
  };
  const pairKey = (s: string, t: string): string => `${s.length}:${s}${t}`;
  pairUnique(
    (m) => pairKey(m.source, m.target),
    (a) => pairKey(a.source, a.target),
    (m, a) => m.edge.predicate !== a.predicate,
  );
  pairUnique(
    (m) => pairKey(m.source, m.edge.predicate),
    (a) => pairKey(a.source, a.predicate),
    (m, a) => m.target !== a.target,
  );
  // A statement belongs to its subject: moving it to another subject is a retarget only when
  // both subjects exist in both versions — a new subject's statement is an addition, a
  // removed subject's statement a removal (they stay in the add / remove hunks).
  const persists = (u: UnionId): boolean => ctx.afterToBefore.has(u);
  pairUnique(
    (m) => pairKey(m.target, m.edge.predicate),
    (a) => pairKey(a.target, a.predicate),
    (m, a) => m.source !== a.source && persists(m.source) && persists(a.source),
  );

  // ── 5. Leftovers ──
  for (const key of remainingAfter) {
    const a = after.edges.get(key) as KGEdge;
    records.push(
      edgeRecord(a.key, a.source, a.target, a, 'after', [], ctx.hierarchy.has(a.predicate)),
    );
  }
  const removed = [...remaining, ...collapsed.keys()].sort((x, y) => compareStrings(x.key, y.key));
  const taken = new Set<string>();
  for (const m of removed) {
    const id = uniqueBeforeId(m, structural(m.edge), (k) => after.edges.has(k) || taken.has(k));
    taken.add(id);
    const into = collapsed.get(m);
    const facets: EdgeFacet[] = into === undefined ? [] : [{ kind: 'collapsed', into }];
    records.push(
      edgeRecord(
        id,
        m.source,
        m.target,
        m.edge,
        'before',
        facets,
        ctx.hierarchy.has(m.edge.predicate),
      ),
    );
  }
  return records.sort((x, y) => compareStrings(x.id, y.id));
}

/**
 * Union id of a before-only edge: its union-space key; on collision the next free `#n`
 * (structural keys) or `@before` (edge ids).
 */
function uniqueBeforeId(m: Mapped, structural: boolean, taken: (key: string) => boolean): UnionId {
  if (!taken(m.key)) return m.key;
  if (!structural) {
    let id = `${m.key}@before`;
    while (taken(id)) id += '@before';
    return id;
  }
  const { base } = splitStructuralKey(m.key);
  let n = 2;
  while (taken(`${base}#${n}`)) n++;
  return `${base}#${n}`;
}

function edgeRecord(
  id: UnionId,
  source: UnionId,
  target: UnionId,
  edge: KGEdge,
  side: 'before' | 'after',
  facets: EdgeFacet[],
  hierarchical: boolean,
): EdgeRecord {
  return side === 'after'
    ? {
        id,
        source,
        target,
        predicate: edge.predicate,
        label: edge.label,
        afterKey: edge.key,
        after: edge,
        status: 'added',
        facets,
        hierarchical,
        inPlace: false,
      }
    : {
        id,
        source,
        target,
        predicate: edge.predicate,
        label: edge.label,
        beforeKey: edge.key,
        before: edge,
        status: 'removed',
        facets,
        hierarchical,
        inPlace: false,
      };
}
