/**
 * Hunks (docs/algorithms.md §7): a partition of the changed union elements into review units.
 *
 * Seeding order, first claim wins: merge → split → add → remove → modify → relations.
 */

import { hunkSummary } from './hunk-summary.js';
import type { EdgeRecord, NodeRecord } from './model.js';
import type { PipelineContext } from './pipeline.js';
import type { Hunk, HunkKind, HunkSummary, Id, KGraph, ReplayPhase, UnionId } from './types.js';
import { compareStrings, degree, pushTo } from './util.js';

interface Draft {
  id: string;
  readonly kind: HunkKind;
  readonly anchor: UnionId;
  readonly nodes: UnionId[];
  readonly edges: UnionId[];
}

/** A hunk before the delta exists: no ops, no dependencies, no order yet. */
export type HunkWithoutOps = Omit<Hunk, 'ops' | 'requires' | 'order'>;

function endpoints(e: EdgeRecord): UnionId[] {
  const ids = [e.source];
  if (e.target !== e.source) ids.push(e.target);
  if (e.sourceBefore !== undefined && !ids.includes(e.sourceBefore)) ids.push(e.sourceBefore);
  if (e.targetBefore !== undefined && !ids.includes(e.targetBefore)) ids.push(e.targetBefore);
  return ids;
}

/** Neighbours of a union node in either version, as union ids. */
function neighbors(ctx: PipelineContext, node: NodeRecord): UnionId[] {
  const out: UnionId[] = [];
  const visit = (graph: KGraph, id: Id, toUnion: (id: Id) => UnionId): void => {
    for (const key of graph.outgoing.get(id) ?? []) {
      const e = graph.edges.get(key);
      if (e) out.push(toUnion(e.target));
    }
    for (const key of graph.incoming.get(id) ?? []) {
      const e = graph.edges.get(key);
      if (e) out.push(toUnion(e.source));
    }
  };
  if (node.beforeId !== undefined) visit(ctx.before, node.beforeId, ctx.unionOfBefore);
  if (node.afterId !== undefined) visit(ctx.after, node.afterId, (id) => id);
  return out;
}

class UnionFind {
  private readonly parent = new Map<UnionId, UnionId>();

  find(x: UnionId): UnionId {
    let root = x;
    for (let p = this.parent.get(root); p !== undefined && p !== root; p = this.parent.get(root)) {
      root = p;
    }
    // Path compression.
    for (let cur = x; cur !== root; ) {
      const next = this.parent.get(cur) as UnionId;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: UnionId, b: UnionId): void {
    const ra = this.find(a);
    const rb = this.find(b);
    // The smaller id becomes the root, so roots are deterministic.
    if (ra < rb) this.parent.set(rb, ra);
    else if (rb < ra) this.parent.set(ra, rb);
  }
}

/**
 * Partitions the changed elements into hunks, assigns `hunk` on every changed record and
 * computes context, phase and summary. Dependencies and order come later (`orderHunks`),
 * once the delta exists.
 */
export function buildHunks(
  ctx: PipelineContext,
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
): HunkWithoutOps[] {
  const nodeById = new Map<UnionId, NodeRecord>();
  for (const n of nodes) nodeById.set(n.id, n);
  const edgeById = new Map<UnionId, EdgeRecord>();
  const changedEdgesOf = new Map<UnionId, EdgeRecord[]>();
  for (const e of edges) {
    if (e.status === 'unchanged') continue;
    edgeById.set(e.id, e);
    for (const u of endpoints(e)) pushTo(changedEdgesOf, u, e);
  }

  const drafts: Draft[] = [];
  const nodeOwner = new Map<UnionId, Draft>();
  const edgeOwner = new Map<UnionId, Draft>();
  const open = (kind: HunkKind, anchor: UnionId): Draft => {
    const draft: Draft = { id: '', kind, anchor, nodes: [], edges: [] };
    drafts.push(draft);
    return draft;
  };
  const claimNode = (d: Draft, id: UnionId): void => {
    const node = nodeById.get(id);
    if (!node || node.status === 'unchanged' || nodeOwner.has(id)) return;
    nodeOwner.set(id, d);
    d.nodes.push(id);
  };
  const claimEdge = (d: Draft, e: EdgeRecord): void => {
    if (edgeOwner.has(e.id)) return;
    edgeOwner.set(e.id, d);
    d.edges.push(e.id);
  };
  const claimIncident = (d: Draft, id: UnionId, accept?: (e: EdgeRecord) => boolean): void => {
    for (const e of changedEdgesOf.get(id) ?? []) if (!accept || accept(e)) claimEdge(d, e);
  };

  // 1. Merges: sources, target, carried / collapsed edges, every changed edge of a source.
  for (const group of ctx.restructuring.merges) {
    const d = open('merge', group.target);
    const sources = group.sources.map((s) => ctx.unionOfBefore(s.id));
    claimNode(d, group.target);
    for (const s of sources) claimNode(d, s);
    for (const s of sources) claimIncident(d, s);
    if (nodeById.get(group.target)?.status === 'added') claimIncident(d, group.target);
  }
  // 2. Splits: source, new targets, carried edges and every other changed edge of either.
  for (const group of ctx.restructuring.splits) {
    const source = ctx.unionOfBefore(group.source);
    // A merge target that also splits is one restructuring: it extends the merge hunk.
    const d = nodeOwner.get(source) ?? open('split', source);
    claimNode(d, source);
    for (const t of group.targets) claimNode(d, t.id);
    for (const t of group.targets) claimIncident(d, t.id);
    claimIncident(d, source);
  }
  // 3–4. Connected groups of added / removed nodes and their added / removed edges.
  for (const status of ['added', 'removed'] as const) {
    const free = nodes.filter((n) => n.status === status && !nodeOwner.has(n.id));
    if (free.length === 0) continue;
    const inGroup = new Set(free.map((n) => n.id));
    const uf = new UnionFind();
    for (const e of edgeById.values()) {
      if (e.status === status && inGroup.has(e.source) && inGroup.has(e.target))
        uf.union(e.source, e.target);
    }
    const components = new Map<UnionId, NodeRecord[]>();
    for (const n of free) pushTo(components, uf.find(n.id), n);
    const graph = status === 'added' ? ctx.after : ctx.before;
    for (const root of [...components.keys()].sort()) {
      const members = components.get(root) as NodeRecord[];
      let anchor = members[0] as NodeRecord;
      let best = -1;
      for (const n of members) {
        const deg = degree(graph, status === 'added' ? n.afterId : n.beforeId);
        if (deg > best || (deg === best && n.id < anchor.id)) {
          best = deg;
          anchor = n;
        }
      }
      const d = open(status === 'added' ? 'add' : 'remove', anchor.id);
      for (const n of members) claimNode(d, n.id);
      for (const n of members) claimIncident(d, n.id, (e) => e.status === status);
    }
  }
  // 5. Modified nodes with their outgoing edge changes (subject-centric).
  for (const n of nodes) {
    if (n.status !== 'modified' || nodeOwner.has(n.id)) continue;
    const d = open('modify', n.id);
    claimNode(d, n.id);
    claimIncident(d, n.id, (e) => e.source === n.id);
  }
  // 6. Remaining edge changes, grouped by source node.
  const bySource = new Map<UnionId, EdgeRecord[]>();
  for (const e of edgeById.values()) if (!edgeOwner.has(e.id)) pushTo(bySource, e.source, e);
  for (const source of [...bySource.keys()].sort()) {
    const d = open('relations', source);
    for (const e of bySource.get(source) as EdgeRecord[]) claimEdge(d, e);
  }

  // Ids in seeding order; collisions (never expected) get #2, #3…
  const used = new Map<string, number>();
  const live = drafts.filter((d) => d.nodes.length + d.edges.length > 0);
  for (const d of live) {
    const base = `${d.kind}:${d.anchor}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    d.id = n === 1 ? base : `${base}#${n}`;
  }
  for (const d of live) {
    for (const id of d.nodes) (nodeById.get(id) as NodeRecord).hunk = d.id;
    for (const id of d.edges) (edgeById.get(id) as EdgeRecord).hunk = d.id;
  }

  const hunks = live.map((d): HunkWithoutOps => {
    const ownNodes = d.nodes.slice().sort(compareStrings);
    const at = ownNodes.indexOf(d.anchor);
    if (at > 0) ownNodes.unshift(...ownNodes.splice(at, 1));
    const ownEdges = d.edges.slice().sort(compareStrings);
    return {
      id: d.id,
      kind: d.kind,
      phase: phaseOf(d, nodeById),
      anchor: d.anchor,
      nodes: ownNodes,
      edges: ownEdges,
      context: contextOf(ctx, d, nodeById, edgeById),
      summary: summarize(d, nodeById, edgeById),
    };
  });
  return hunks;
}

function phaseOf(d: Draft, nodeById: ReadonlyMap<UnionId, NodeRecord>): ReplayPhase {
  switch (d.kind) {
    case 'remove':
      return 'remove';
    case 'add':
      return 'add';
    case 'merge':
    case 'split':
    case 'relations':
      return 'restructure';
    case 'modify': {
      const facets = d.nodes.flatMap((id) => nodeById.get(id)?.facets ?? []);
      return facets.length > 0 && facets.every((f) => f.kind === 'move') ? 'restructure' : 'modify';
    }
    default: {
      const exhaustive: never = d.kind;
      return exhaustive;
    }
  }
}

/** Nodes outside the hunk needed to read it: edge endpoints, move parents, merge / split neighbours. */
function contextOf(
  ctx: PipelineContext,
  d: Draft,
  nodeById: ReadonlyMap<UnionId, NodeRecord>,
  edgeById: ReadonlyMap<UnionId, EdgeRecord>,
): UnionId[] {
  const context = new Set<UnionId>();
  for (const id of d.edges) {
    for (const u of endpoints(edgeById.get(id) as EdgeRecord)) context.add(u);
  }
  for (const id of d.nodes) {
    for (const f of nodeById.get(id)?.facets ?? []) {
      if (f.kind !== 'move') continue;
      for (const u of f.from) context.add(u);
      for (const u of f.to) context.add(u);
    }
  }
  if (d.kind === 'merge' || d.kind === 'split') {
    const pivot = nodeById.get(d.anchor);
    if (pivot) for (const u of neighbors(ctx, pivot)) context.add(u);
  }
  for (const id of d.nodes) context.delete(id);
  return [...context].sort();
}

function summarize(
  d: Draft,
  nodeById: ReadonlyMap<UnionId, NodeRecord>,
  edgeById: ReadonlyMap<UnionId, EdgeRecord>,
): HunkSummary {
  return hunkSummary(
    d.nodes.map((id) => nodeById.get(id) as NodeRecord),
    d.edges.map((id) => edgeById.get(id) as EdgeRecord),
  );
}
