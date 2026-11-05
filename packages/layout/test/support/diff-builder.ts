/**
 * Builds minimal but type-correct `DiffResult`s for layout tests, independent of `diff()`.
 * Only the fields the layout reads are meaningful (nodes with status / facets / versions /
 * positions / degree, edges with endpoints / status / hierarchical, `index.edgesOf`, `stats`);
 * the rest is filled with consistent empty values.
 */
import type {
  ChangeStatus,
  DiffResult,
  EdgeFacet,
  KGEdge,
  KGNode,
  KGraph,
  NodeFacet,
  Point,
  UnionEdge,
  UnionNode,
} from '@kgdiff/core';

export interface NodeSpec {
  readonly id: string;
  readonly label?: string;
  readonly status?: ChangeStatus;
  readonly facets?: readonly NodeFacet[];
  readonly beforePosition?: Point;
  readonly afterPosition?: Point;
}

export interface EdgeSpec {
  readonly source: string;
  readonly target: string;
  readonly predicate?: string;
  readonly status?: ChangeStatus;
  readonly sourceBefore?: string;
  readonly targetBefore?: string;
  readonly facets?: readonly EdgeFacet[];
  readonly hierarchical?: boolean;
}

export interface GraphSpec {
  readonly nodes: readonly NodeSpec[];
  readonly edges: readonly EdgeSpec[];
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function kgNode(id: string, label: string, position: Point | undefined): KGNode {
  return {
    id,
    label,
    types: [],
    aliases: [],
    attrs: {},
    deprecated: false,
    replaces: [],
    replacedBy: [],
    implicit: false,
    ...(position ? { position } : {}),
  };
}

function kgraph(nodes: readonly KGNode[], edges: readonly KGEdge[]): KGraph {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.key]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.key]);
  }
  return {
    meta: {},
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e) => [e.key, e])),
    outgoing,
    incoming,
    edgeIdentity: 'structure',
    issues: [],
  };
}

const zeroCounts = () => ({ added: 0, removed: 0, modified: 0, unchanged: 0 });

/**
 * Build a diff. Nodes / edges are sorted by id like core does, so the result does not depend on
 * the order of `spec`.
 */
export function makeDiff(spec: GraphSpec): DiffResult {
  const status = new Map(spec.nodes.map((n) => [n.id, n.status ?? 'unchanged'] as const));
  const presentBefore = (id: string) => status.get(id) !== 'added';
  const presentAfter = (id: string) => status.get(id) !== 'removed';

  const edgeCount = new Map<string, number>();
  const edges: UnionEdge[] = spec.edges.map((e) => {
    const predicate = e.predicate ?? 'related';
    let id = JSON.stringify([e.source, predicate, e.target]);
    const seen = (edgeCount.get(id) ?? 0) + 1;
    edgeCount.set(id, seen);
    if (seen > 1) id = `${id}#${seen}`;
    const s = e.status ?? 'unchanged';
    const before: KGEdge | undefined =
      s === 'added'
        ? undefined
        : {
            key: id,
            source: e.sourceBefore ?? e.source,
            target: e.targetBefore ?? e.target,
            predicate,
            label: predicate,
            attrs: {},
          };
    const after: KGEdge | undefined =
      s === 'removed'
        ? undefined
        : { key: id, source: e.source, target: e.target, predicate, label: predicate, attrs: {} };
    const common = {
      id,
      source: e.source,
      target: e.target,
      predicate,
      label: predicate,
      facets: e.facets ?? [],
      hierarchical: e.hierarchical ?? false,
    };
    if (s === 'added') return { ...common, status: s, afterKey: id, after: after! };
    if (s === 'removed') return { ...common, status: s, beforeKey: id, before: before! };
    return {
      ...common,
      ...(e.sourceBefore !== undefined ? { sourceBefore: e.sourceBefore } : {}),
      ...(e.targetBefore !== undefined ? { targetBefore: e.targetBefore } : {}),
      status: s,
      beforeKey: id,
      afterKey: id,
      before: before!,
      after: after!,
    };
  });
  edges.sort(byId);

  const degBefore = new Map<string, number>();
  const degAfter = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const e of edges) {
    if (e.before) {
      bump(degBefore, e.before.source);
      bump(degBefore, e.before.target);
    }
    if (e.after) {
      bump(degAfter, e.after.source);
      bump(degAfter, e.after.target);
    }
  }

  const nodes: UnionNode[] = spec.nodes.map((n) => {
    const label = n.label ?? n.id;
    const rename = n.facets?.find((f) => f.kind === 'rename');
    const beforeLabel = rename?.kind === 'rename' ? rename.from : label;
    const s = n.status ?? 'unchanged';
    const before = presentBefore(n.id) ? kgNode(n.id, beforeLabel, n.beforePosition) : undefined;
    const after = presentAfter(n.id) ? kgNode(n.id, label, n.afterPosition) : undefined;
    const common = {
      id: n.id,
      facets: n.facets ?? [],
      label,
      types: [],
      degree: { before: degBefore.get(n.id) ?? 0, after: degAfter.get(n.id) ?? 0 },
    };
    if (s === 'added') return { ...common, status: s, afterId: n.id, after: after! };
    if (s === 'removed') return { ...common, status: s, beforeId: n.id, before: before! };
    return { ...common, status: s, beforeId: n.id, afterId: n.id, before: before!, after: after! };
  });
  nodes.sort(byId);

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const incident = new Map<string, UnionEdge[]>();
  for (const e of edges) {
    const ends = new Set([e.source, e.target, e.sourceBefore, e.targetBefore]);
    for (const end of ends) {
      if (end !== undefined) incident.set(end, [...(incident.get(end) ?? []), e]);
    }
  }

  const before = kgraph(
    nodes.flatMap((n) => (n.before ? [n.before] : [])),
    edges.flatMap((e) => (e.before ? [e.before] : [])),
  );
  const after = kgraph(
    nodes.flatMap((n) => (n.after ? [n.after] : [])),
    edges.flatMap((e) => (e.after ? [e.after] : [])),
  );

  const nodeStats = zeroCounts();
  for (const n of nodes) nodeStats[n.status]++;
  const edgeStats = zeroCounts();
  for (const e of edges) edgeStats[e.status]++;

  const ref = (g: KGraph) => ({
    hash: 'c53:00000000000000',
    nodes: g.nodes.size,
    edges: g.edges.size,
  });

  return {
    before,
    after,
    options: {
      match: { strategy: 'auto', threshold: 0.82, suggestThreshold: 0.6, maxCandidates: 8 },
      edgeIdentity: 'structure',
      hierarchyPredicates: [],
      detectMerges: true,
      detectSplits: true,
      ignoreAttrs: [],
    },
    nodes,
    edges,
    hunks: [],
    matches: [],
    suggestions: [],
    delta: {
      format: 'kgdiff.delta',
      version: 1,
      edgeIdentity: 'structure',
      base: ref(before),
      target: ref(after),
      ops: [],
    },
    stats: {
      nodes: nodeStats,
      edges: edgeStats,
      before: { nodes: before.nodes.size, edges: before.edges.size },
      after: { nodes: after.nodes.size, edges: after.edges.size },
      facets: {
        rename: 0,
        rekey: 0,
        types: 0,
        aliases: 0,
        attrs: 0,
        move: 0,
        deprecate: 0,
        replacement: 0,
        mergedInto: 0,
        mergeTarget: 0,
        splitFrom: 0,
        splitInto: 0,
        retarget: 0,
        predicate: 0,
        label: 0,
        collapsed: 0,
      },
      hunks: { add: 0, remove: 0, merge: 0, split: 0, modify: 0, relations: 0 },
      byType: [],
      identical: nodeStats.unchanged === nodes.length && edgeStats.unchanged === edges.length,
    },
    index: {
      node: (id) => nodeById.get(id),
      edge: (id) => edgeById.get(id),
      hunk: () => undefined,
      nodeByBefore: (id) => nodes.find((n) => n.beforeId === id),
      nodeByAfter: (id) => nodes.find((n) => n.afterId === id),
      edgesOf: (id) => incident.get(id) ?? [],
    },
  };
}

/** Recursively freeze a value (Maps / Sets are frozen as objects; their entries are frozen too). */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value) {
      deepFreeze(k, seen);
      deepFreeze(v, seen);
    }
  } else {
    for (const v of Object.values(value)) deepFreeze(v, seen);
  }
  return Object.freeze(value);
}
