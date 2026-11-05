/**
 * Type-correct DiffResult / LayoutResult fixtures, built without the (concurrently developed)
 * core and layout implementations.
 */
import type {
  ChangeStatus,
  DiffIndex,
  DiffResult,
  DiffStats,
  EdgeFacet,
  FacetKind,
  GraphMeta,
  GraphRef,
  Hunk,
  HunkKind,
  KGEdge,
  KGNode,
  KGraph,
  MatchSuggestion,
  NodeFacet,
  Point,
  ReplayPhase,
  UnionEdge,
  UnionNode,
} from '@kgdiff/core';
import type { LayoutResult } from '@kgdiff/layout';
import { nodeRadius } from '@kgdiff/layout';

export interface NodeSpec {
  readonly id: string;
  readonly status: ChangeStatus;
  readonly facets?: readonly NodeFacet[];
  /** Current label (after, or before for removed nodes). Defaults to the id. */
  readonly label?: string;
  /** Before label when it differs (renames). */
  readonly labelBefore?: string;
  readonly beforeId?: string;
  readonly deprecatedAfter?: boolean;
  readonly replacedBy?: readonly string[];
  readonly hunk?: string;
  readonly implicit?: boolean;
}

export interface EdgeSpec {
  readonly source: string;
  readonly target: string;
  readonly predicate?: string;
  readonly label?: string;
  readonly labelBefore?: string;
  readonly predicateBefore?: string;
  readonly sourceBefore?: string;
  readonly targetBefore?: string;
  readonly status: ChangeStatus;
  readonly facets?: readonly EdgeFacet[];
  readonly hunk?: string;
  readonly hierarchical?: boolean;
  readonly id?: string;
}

export interface HunkSpec {
  readonly kind: HunkKind;
  readonly phase: ReplayPhase;
  readonly anchor: string;
  readonly nodes?: readonly string[];
  readonly edges?: readonly string[];
  readonly context?: readonly string[];
  readonly id?: string;
  /** Ids of hunks that must play first. */
  readonly requires?: readonly string[];
}

export const edgeId = (source: string, predicate: string, target: string): string =>
  JSON.stringify([source, predicate, target]);

const FACET_KINDS: readonly FacetKind[] = [
  'rename',
  'rekey',
  'types',
  'aliases',
  'attrs',
  'move',
  'deprecate',
  'mergedInto',
  'mergeTarget',
  'splitFrom',
  'splitInto',
  'retarget',
  'predicate',
  'label',
  'collapsed',
];
const HUNK_KINDS: readonly HunkKind[] = ['add', 'remove', 'merge', 'split', 'modify', 'relations'];

function kgNode(id: string, label: string, opts: Partial<KGNode> = {}): KGNode {
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
    ...opts,
  };
}

function graph(nodes: KGNode[], edges: KGEdge[], name: string, meta: GraphMeta = {}): KGraph {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.key]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.key]);
  }
  return {
    meta: { name, ...meta },
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e) => [e.key, e])),
    outgoing,
    incoming,
    edgeIdentity: 'structure',
    issues: [],
  };
}

const ref = (g: KGraph): GraphRef => ({
  name: String(g.meta.name),
  hash: 'c53:00000000000000',
  nodes: g.nodes.size,
  edges: g.edges.size,
});

/** Build a complete, type-correct DiffResult from compact specs. */
export function makeDiff(spec: {
  readonly nodes: readonly NodeSpec[];
  readonly edges: readonly EdgeSpec[];
  readonly hunks: readonly HunkSpec[];
  readonly suggestions?: readonly { before: string; after: string; score: number }[];
  readonly meta?: { readonly before?: GraphMeta; readonly after?: GraphMeta };
}): DiffResult {
  const unionEdges: UnionEdge[] = spec.edges.map((e) => {
    const predicate = e.predicate ?? 'rel';
    const label = e.label ?? predicate;
    const id = e.id ?? edgeId(e.source, predicate, e.target);
    const presentBefore = e.status !== 'added';
    const presentAfter = e.status !== 'removed';
    const bs = e.sourceBefore ?? e.source;
    const bt = e.targetBefore ?? e.target;
    const bp = e.predicateBefore ?? predicate;
    const before: KGEdge | undefined = presentBefore
      ? {
          key: edgeId(bs, bp, bt),
          source: bs,
          target: bt,
          predicate: bp,
          label: e.labelBefore ?? e.predicateBefore ?? label,
          attrs: {},
        }
      : undefined;
    const after: KGEdge | undefined = presentAfter
      ? {
          key: edgeId(e.source, predicate, e.target),
          source: e.source,
          target: e.target,
          predicate,
          label,
          attrs: {},
        }
      : undefined;
    const common = {
      id,
      source: e.source,
      target: e.target,
      predicate,
      label,
      facets: e.facets ?? [],
      ...(e.hunk !== undefined ? { hunk: e.hunk } : {}),
      hierarchical: e.hierarchical ?? false,
    };
    if (e.status === 'added') {
      return { ...common, status: e.status, afterKey: after!.key, after: after! };
    }
    if (e.status === 'removed') {
      return { ...common, status: e.status, beforeKey: before!.key, before: before! };
    }
    return {
      ...common,
      ...(e.sourceBefore !== undefined ? { sourceBefore: e.sourceBefore } : {}),
      ...(e.targetBefore !== undefined ? { targetBefore: e.targetBefore } : {}),
      ...(e.predicateBefore !== undefined ? { predicateBefore: e.predicateBefore } : {}),
      status: e.status,
      beforeKey: before!.key,
      afterKey: after!.key,
      before: before!,
      after: after!,
    };
  });

  const degree = new Map<string, { before: number; after: number }>();
  const bump = (id: string, side: 'before' | 'after'): void => {
    const d = degree.get(id) ?? { before: 0, after: 0 };
    d[side]++;
    degree.set(id, d);
  };
  for (const e of unionEdges) {
    if (e.before) {
      bump(e.sourceBefore ?? e.source, 'before');
      bump(e.targetBefore ?? e.target, 'before');
    }
    if (e.after) {
      bump(e.source, 'after');
      bump(e.target, 'after');
    }
  }

  const unionNodes: UnionNode[] = spec.nodes.map((n) => {
    const label = n.label ?? n.id;
    const presentBefore = n.status !== 'added';
    const presentAfter = n.status !== 'removed';
    const beforeId = n.beforeId ?? n.id;
    const before = presentBefore
      ? kgNode(beforeId, n.labelBefore ?? label, { implicit: n.implicit ?? false })
      : undefined;
    const after = presentAfter
      ? kgNode(n.id, label, {
          deprecated: n.deprecatedAfter ?? false,
          replacedBy: n.replacedBy ?? [],
          implicit: n.implicit ?? false,
        })
      : undefined;
    const common = {
      id: n.id,
      facets: n.facets ?? [],
      ...(n.hunk !== undefined ? { hunk: n.hunk } : {}),
      label,
      types: [],
      degree: degree.get(n.id) ?? { before: 0, after: 0 },
    };
    if (n.status === 'added') return { ...common, status: n.status, afterId: n.id, after: after! };
    if (n.status === 'removed') return { ...common, status: n.status, beforeId, before: before! };
    return {
      ...common,
      status: n.status,
      beforeId,
      afterId: n.id,
      before: before!,
      after: after!,
    };
  });
  unionNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unionEdges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const statusOf = new Map<string, ChangeStatus>();
  for (const n of unionNodes) statusOf.set(n.id, n.status);
  const edgeStatus = new Map<string, ChangeStatus>();
  for (const e of unionEdges) edgeStatus.set(e.id, e.status);
  const triplet = (statuses: (ChangeStatus | undefined)[]) => ({
    added: statuses.filter((s) => s === 'added').length,
    removed: statuses.filter((s) => s === 'removed').length,
    modified: statuses.filter((s) => s === 'modified').length,
  });

  const hunks: Hunk[] = spec.hunks.map((h, order) => ({
    id: h.id ?? `${h.kind}:${h.anchor}`,
    kind: h.kind,
    phase: h.phase,
    anchor: h.anchor,
    nodes: h.nodes ?? [],
    edges: h.edges ?? [],
    context: h.context ?? [],
    ops: [],
    requires: [...(h.requires ?? [])].sort(),
    summary: {
      nodes: triplet((h.nodes ?? []).map((id) => statusOf.get(id))),
      edges: triplet((h.edges ?? []).map((id) => edgeStatus.get(id))),
      facets: [],
    },
    order,
  }));

  const beforeGraph = graph(
    unionNodes.flatMap((n) => (n.before ? [n.before] : [])),
    unionEdges.flatMap((e) => (e.before ? [e.before] : [])),
    'before',
    spec.meta?.before,
  );
  const afterGraph = graph(
    unionNodes.flatMap((n) => (n.after ? [n.after] : [])),
    unionEdges.flatMap((e) => (e.after ? [e.after] : [])),
    'after',
    spec.meta?.after,
  );

  const facets = Object.fromEntries(FACET_KINDS.map((k) => [k, 0])) as Record<FacetKind, number>;
  for (const el of [...unionNodes, ...unionEdges]) {
    for (const k of new Set(el.facets.map((f) => f.kind))) facets[k]++;
  }
  const count = (xs: readonly { status: ChangeStatus }[]) => ({
    ...triplet(xs.map((x) => x.status)),
    unchanged: xs.filter((x) => x.status === 'unchanged').length,
  });
  const stats: DiffStats = {
    nodes: count(unionNodes),
    edges: count(unionEdges),
    before: { nodes: beforeGraph.nodes.size, edges: beforeGraph.edges.size },
    after: { nodes: afterGraph.nodes.size, edges: afterGraph.edges.size },
    facets,
    hunks: Object.fromEntries(
      HUNK_KINDS.map((k) => [k, hunks.filter((h) => h.kind === k).length]),
    ) as Record<HunkKind, number>,
    byType: [],
    identical: hunks.length === 0,
  };

  const nodeById = new Map(unionNodes.map((n) => [n.id, n]));
  const edgeById = new Map(unionEdges.map((e) => [e.id, e]));
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const index: DiffIndex = {
    node: (id) => nodeById.get(id),
    edge: (id) => edgeById.get(id),
    hunk: (id) => hunkById.get(id),
    nodeByBefore: (id) => unionNodes.find((n) => n.beforeId === id),
    nodeByAfter: (id) => unionNodes.find((n) => n.afterId === id),
    edgesOf: (id) => unionEdges.filter((e) => e.source === id || e.target === id),
  };

  const suggestions: MatchSuggestion[] = (spec.suggestions ?? []).map((s) => ({
    ...s,
    evidence: { label: s.score, neighbors: 0, types: 0, attrs: 0 },
    reason: 'below-threshold',
  }));

  return {
    before: beforeGraph,
    after: afterGraph,
    options: {
      match: { strategy: 'auto', threshold: 0.82, suggestThreshold: 0.6, maxCandidates: 8 },
      edgeIdentity: 'structure',
      hierarchyPredicates: ['rdfs:subClassOf'],
      detectMerges: true,
      detectSplits: true,
      ignoreAttrs: [],
    },
    nodes: unionNodes,
    edges: unionEdges,
    hunks,
    matches: [],
    suggestions,
    delta: {
      format: 'kgdiff.delta',
      version: 1,
      edgeIdentity: 'structure',
      base: ref(beforeGraph),
      target: ref(afterGraph),
      ops: [],
    },
    stats,
    index,
  };
}

/** A LayoutResult for `diff` with explicit positions; nodes without a position are out of scope. */
export function makeLayout(
  diff: DiffResult,
  positions: Readonly<Record<string, readonly [number, number]>>,
  hidden: Readonly<Record<string, number>> = {},
): LayoutResult {
  const pos = new Map<string, Point>();
  const radii = new Map<string, number>();
  for (const n of diff.nodes) {
    const p = positions[n.id];
    if (p === undefined) continue;
    pos.set(n.id, { x: p[0], y: p[1] });
    radii.set(n.id, nodeRadius(Math.max(n.degree.before, n.degree.after)));
  }
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const min = (v: number[]): number => v.reduce((a, b) => Math.min(a, b));
  const max = (v: number[]): number => v.reduce((a, b) => Math.max(a, b));
  const scope = pos.size === diff.nodes.length ? 'all' : 'changes';
  return {
    positions: pos,
    radii,
    bounds:
      xs.length === 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : {
            x: min(xs),
            y: min(ys),
            width: max(xs) - min(xs),
            height: max(ys) - min(ys),
          },
    scope,
    hidden: new Map(Object.entries(hidden)),
    components: [],
    stats: { strategy: 'union', iterations: 0, nodes: pos.size, ms: 0 },
  };
}

// ─── The kitchen-sink scenario: every node role and edge role ───────────────

const E = edgeId;
export const IDS = {
  unchangedAB1: E('A', 'p1', 'B'),
  unchangedAB2: E('A', 'p2', 'B'),
  unchangedBA3: E('B', 'p3', 'A'),
  unchangedBC: E('B', 'rel', 'C'),
  unchangedCD: E('C', 'rel', 'D'),
  unchangedDE: E('D', 'rel', 'E'),
  unchangedTA: E('T', 'rel2', 'A'),
  unchangedXB: E('X', 'rel', 'B'),
  unchangedDPA: E('DP', 'rel', 'A'),
  addedN1A: E('N1', 'likes', 'A'),
  addedN1N2: E('N1', 'likes', 'N2'),
  removedR1B: E('R1', 'had', 'B'),
  removedR2R1: E('R2', 'had', 'R1'),
  labelM1C: E('M1', 'owns', 'C'),
  moveM2: E('M2', 'rdfs:subClassOf', 'B'),
  predicateM3D: E('M3', 'q', 'D'),
  retargetCB: E('C', 'owns', 'B'),
  addedBD: E('B', 'link', 'D'),
  carriedTD: E('T', 'rel', 'D'),
  collapsedS2A: E('S2', 'rel2', 'A'),
  removedS1B: E('S1', 'rel', 'B'),
  carriedY1C: E('Y1', 'rel', 'C'),
  addedY2D: E('Y2', 'rel', 'D'),
  moveM5: E('M5', 'rdfs:subClassOf', 'D'),
  removedQ1E: E('Q1', 'q', 'E'),
  addedQ2E: E('Q2', 'q', 'E'),
} as const;

export const POSITIONS: Readonly<Record<string, readonly [number, number]>> = {
  A: [0, 0],
  B: [120, 0],
  C: [240, 0],
  D: [240, 120],
  E: [360, 120],
  F: [900, 900],
  N1: [-120, -80],
  N2: [-200, -140],
  R1: [120, -120],
  R2: [60, -200],
  M1: [360, -60],
  M2: [60, 100],
  M3: [360, 200],
  M4: [480, 0],
  DP: [300, -140],
  M5: [180, 200],
  S1: [-100, 160],
  S2: [-60, 280],
  T: [0, 200],
  X: [480, 200],
  Y1: [560, 120],
  Y2: [560, 280],
  Q1: [420, 300],
  Q2: [500, 380],
};

export function kitchenSink(): DiffResult {
  return makeDiff({
    nodes: [
      { id: 'A', status: 'unchanged', label: 'Alpha' },
      { id: 'B', status: 'unchanged', label: 'Beta' },
      { id: 'C', status: 'unchanged', label: 'Gamma' },
      { id: 'D', status: 'unchanged', label: 'Delta' },
      { id: 'E', status: 'unchanged', label: 'Epsilon' },
      { id: 'F', status: 'unchanged', label: 'Phi' },
      { id: 'N1', status: 'added', label: 'New one', hunk: 'add:N1' },
      { id: 'N2', status: 'added', label: 'New two', hunk: 'add:N1' },
      { id: 'R1', status: 'removed', label: 'Old one', hunk: 'remove:R1' },
      { id: 'R2', status: 'removed', label: 'Old two', hunk: 'remove:R1' },
      {
        id: 'M1',
        status: 'modified',
        label: 'Mu',
        labelBefore: 'Mu old',
        hunk: 'modify:M1',
        facets: [
          { kind: 'rename', from: 'Mu old', to: 'Mu' },
          {
            kind: 'attrs',
            changes: [
              { key: 'a', after: 1 },
              { key: 'b', after: 'x' },
              { key: 'c', before: true },
              { key: 'd', before: 1, after: 2 },
            ],
          },
        ],
      },
      {
        id: 'M2',
        status: 'modified',
        label: 'Moved',
        hunk: 'modify:M2',
        facets: [{ kind: 'move', predicate: 'rdfs:subClassOf', from: ['A'], to: ['B'] }],
      },
      {
        id: 'M3',
        status: 'modified',
        label: 'Typed',
        hunk: 'modify:M3',
        facets: [
          { kind: 'types', added: ['Org'], removed: [] },
          { kind: 'aliases', added: ['T3'], removed: ['t3'] },
        ],
      },
      {
        id: 'M4',
        status: 'modified',
        label: 'Rekeyed',
        beforeId: 'm4-old',
        hunk: 'modify:M4',
        facets: [{ kind: 'rekey', from: 'm4-old', to: 'M4', score: 0.9 }],
      },
      {
        id: 'DP',
        status: 'modified',
        label: 'Deprecated',
        deprecatedAfter: true,
        replacedBy: ['C'],
        hunk: 'modify:DP',
        facets: [{ kind: 'deprecate', deprecated: true }],
      },
      {
        id: 'M5',
        status: 'modified',
        label: 'Moved and renamed',
        labelBefore: 'M5 old',
        hunk: 'modify:M5',
        facets: [
          { kind: 'rename', from: 'M5 old', to: 'Moved and renamed' },
          { kind: 'move', predicate: 'rdfs:subClassOf', from: ['C'], to: ['D'] },
        ],
      },
      {
        id: 'S1',
        status: 'removed',
        label: 'Source one',
        hunk: 'merge:T',
        facets: [{ kind: 'mergedInto', target: 'T', confidence: 1, via: 'hint' }],
      },
      {
        id: 'S2',
        status: 'removed',
        label: 'Source two',
        hunk: 'merge:T',
        facets: [{ kind: 'mergedInto', target: 'T', confidence: 0.8, via: 'heuristic' }],
      },
      {
        id: 'T',
        status: 'modified',
        label: 'Tee',
        labelBefore: 'Tee old',
        hunk: 'merge:T',
        facets: [
          { kind: 'rename', from: 'Tee old', to: 'Tee' },
          { kind: 'mergeTarget', sources: ['S1', 'S2'] },
        ],
      },
      {
        id: 'X',
        status: 'modified',
        label: 'Splitter',
        hunk: 'split:X',
        facets: [{ kind: 'splitInto', targets: ['Y1', 'Y2'] }],
      },
      {
        id: 'Y1',
        status: 'added',
        label: 'Part one',
        hunk: 'split:X',
        facets: [{ kind: 'splitFrom', source: 'X', confidence: 1, via: 'hint' }],
      },
      {
        id: 'Y2',
        status: 'added',
        label: 'Part two',
        hunk: 'split:X',
        facets: [{ kind: 'splitFrom', source: 'X', confidence: 1, via: 'hint' }],
      },
      { id: 'Q1', status: 'removed', label: 'Quokka', hunk: 'remove:Q1' },
      { id: 'Q2', status: 'added', label: 'Quokka!', hunk: 'add:Q2' },
    ],
    edges: [
      { source: 'A', target: 'B', predicate: 'p1', status: 'unchanged' },
      { source: 'A', target: 'B', predicate: 'p2', status: 'unchanged' },
      { source: 'B', target: 'A', predicate: 'p3', status: 'unchanged' },
      { source: 'B', target: 'C', status: 'unchanged' },
      { source: 'C', target: 'D', status: 'unchanged' },
      { source: 'D', target: 'E', status: 'unchanged' },
      { source: 'T', target: 'A', predicate: 'rel2', status: 'unchanged' },
      { source: 'X', target: 'B', status: 'unchanged' },
      { source: 'DP', target: 'A', status: 'unchanged' },
      { source: 'N1', target: 'A', predicate: 'likes', status: 'added', hunk: 'add:N1' },
      { source: 'N1', target: 'N2', predicate: 'likes', status: 'added', hunk: 'add:N1' },
      { source: 'R1', target: 'B', predicate: 'had', status: 'removed', hunk: 'remove:R1' },
      { source: 'R2', target: 'R1', predicate: 'had', status: 'removed', hunk: 'remove:R1' },
      {
        source: 'M1',
        target: 'C',
        predicate: 'owns',
        label: 'owns',
        labelBefore: 'held',
        status: 'modified',
        hunk: 'modify:M1',
        facets: [{ kind: 'label', from: 'held', to: 'owns' }],
      },
      {
        source: 'M2',
        target: 'B',
        targetBefore: 'A',
        predicate: 'rdfs:subClassOf',
        label: 'subClassOf',
        status: 'modified',
        hunk: 'modify:M2',
        hierarchical: true,
        facets: [{ kind: 'retarget', end: 'target', from: 'A', to: 'B', cause: 'move' }],
      },
      {
        source: 'M3',
        target: 'D',
        predicate: 'q',
        predicateBefore: 'p',
        status: 'modified',
        hunk: 'modify:M3',
        facets: [{ kind: 'predicate', from: 'p', to: 'q' }],
      },
      {
        source: 'C',
        target: 'B',
        targetBefore: 'D',
        predicate: 'owns',
        status: 'modified',
        hunk: 'relations:C',
        facets: [{ kind: 'retarget', end: 'target', from: 'D', to: 'B', cause: 'edit' }],
      },
      { source: 'B', target: 'D', predicate: 'link', status: 'added', hunk: 'relations:B' },
      {
        source: 'T',
        target: 'D',
        sourceBefore: 'S1',
        status: 'modified',
        hunk: 'merge:T',
        facets: [{ kind: 'retarget', end: 'source', from: 'S1', to: 'T', cause: 'merge' }],
      },
      {
        source: 'S2',
        target: 'A',
        predicate: 'rel2',
        status: 'removed',
        hunk: 'merge:T',
        facets: [{ kind: 'collapsed', into: E('T', 'rel2', 'A') }],
      },
      { source: 'S1', target: 'B', status: 'removed', hunk: 'merge:T' },
      {
        source: 'Y1',
        target: 'C',
        sourceBefore: 'X',
        status: 'modified',
        hunk: 'split:X',
        facets: [{ kind: 'retarget', end: 'source', from: 'X', to: 'Y1', cause: 'split' }],
      },
      { source: 'Y2', target: 'D', status: 'added', hunk: 'split:X' },
      {
        source: 'M5',
        target: 'D',
        targetBefore: 'C',
        predicate: 'rdfs:subClassOf',
        label: 'subClassOf',
        status: 'modified',
        hunk: 'modify:M5',
        hierarchical: true,
        facets: [{ kind: 'retarget', end: 'target', from: 'C', to: 'D', cause: 'move' }],
      },
      { source: 'Q1', target: 'E', predicate: 'q', status: 'removed', hunk: 'remove:Q1' },
      { source: 'Q2', target: 'E', predicate: 'q', status: 'added', hunk: 'add:Q2' },
    ],
    hunks: [
      {
        kind: 'remove',
        phase: 'remove',
        anchor: 'R1',
        nodes: ['R1', 'R2'],
        edges: [IDS.removedR1B, IDS.removedR2R1],
        context: ['B'],
      },
      {
        kind: 'remove',
        phase: 'remove',
        anchor: 'Q1',
        nodes: ['Q1'],
        edges: [IDS.removedQ1E],
        context: ['E'],
      },
      {
        kind: 'merge',
        phase: 'restructure',
        anchor: 'T',
        nodes: ['T', 'S1', 'S2'],
        edges: [IDS.carriedTD, IDS.collapsedS2A, IDS.removedS1B],
        context: ['A', 'B', 'D'],
      },
      {
        kind: 'split',
        phase: 'restructure',
        anchor: 'X',
        nodes: ['X', 'Y1', 'Y2'],
        edges: [IDS.carriedY1C, IDS.addedY2D],
        context: ['C', 'D'],
      },
      {
        kind: 'modify',
        phase: 'restructure',
        anchor: 'M2',
        nodes: ['M2'],
        edges: [IDS.moveM2],
        context: ['A', 'B'],
      },
      {
        kind: 'relations',
        phase: 'restructure',
        anchor: 'C',
        edges: [IDS.retargetCB],
        context: ['B', 'C', 'D'],
      },
      {
        kind: 'relations',
        phase: 'restructure',
        anchor: 'B',
        edges: [IDS.addedBD],
        context: ['B', 'D'],
      },
      {
        kind: 'modify',
        phase: 'modify',
        anchor: 'M5',
        nodes: ['M5'],
        edges: [IDS.moveM5],
        context: ['C', 'D'],
      },
      {
        kind: 'modify',
        phase: 'modify',
        anchor: 'M1',
        nodes: ['M1'],
        edges: [IDS.labelM1C],
        context: ['C'],
      },
      {
        kind: 'modify',
        phase: 'modify',
        anchor: 'M3',
        nodes: ['M3'],
        edges: [IDS.predicateM3D],
        context: ['D'],
      },
      { kind: 'modify', phase: 'modify', anchor: 'M4', nodes: ['M4'] },
      { kind: 'modify', phase: 'modify', anchor: 'DP', nodes: ['DP'], context: ['A'] },
      {
        kind: 'add',
        phase: 'add',
        anchor: 'N1',
        nodes: ['N1', 'N2'],
        edges: [IDS.addedN1A, IDS.addedN1N2],
        context: ['A'],
      },
      {
        kind: 'add',
        phase: 'add',
        anchor: 'Q2',
        nodes: ['Q2'],
        edges: [IDS.addedQ2E],
        context: ['E'],
      },
    ],
    suggestions: [{ before: 'Q1', after: 'Q2', score: 0.72 }],
  });
}

/** Deterministic PRNG for synthetic graphs (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic diff of `n` nodes and `m` edges with ~6% changed elements spread over every
 * hunk kind, plus a layout scattering nodes in a square. Used for performance budgets.
 */
export function synthetic(
  n: number,
  m: number,
  seed = 7,
): { diff: DiffResult; layout: LayoutResult } {
  const rand = mulberry32(seed);
  const id = (i: number): string => `n${String(i).padStart(5, '0')}`;
  const nodes: NodeSpec[] = [];
  const hunks: HunkSpec[] = [];
  const statusOf: ChangeStatus[] = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    let status: ChangeStatus = 'unchanged';
    if (r < 0.02) status = 'added';
    else if (r < 0.04) status = 'removed';
    else if (r < 0.06) status = 'modified';
    statusOf.push(status);
    if (status === 'unchanged') {
      nodes.push({ id: id(i), status, label: `Node ${i}` });
      continue;
    }
    const kind: HunkKind = status === 'added' ? 'add' : status === 'removed' ? 'remove' : 'modify';
    const hunk = `${kind}:${id(i)}`;
    hunks.push({
      kind,
      phase: kind === 'add' ? 'add' : kind === 'remove' ? 'remove' : 'modify',
      anchor: id(i),
      nodes: [id(i)],
      edges: [],
      context: [],
    });
    nodes.push({
      id: id(i),
      status,
      label: `Node ${i}`,
      hunk,
      ...(status === 'modified'
        ? {
            labelBefore: `Old ${i}`,
            facets: [
              { kind: 'rename', from: `Old ${i}`, to: `Node ${i}` },
              { kind: 'attrs', changes: [{ key: 'k', before: 1, after: 2 }] },
            ] as NodeFacet[],
          }
        : {}),
    });
  }
  const edges: EdgeSpec[] = [];
  const seen = new Set<string>();
  const hunkEdges = new Map<string, string[]>();
  for (let k = 0; edges.length < m && k < m * 4; k++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    const key = `${a}|${b}`;
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    const sa = statusOf[a] as ChangeStatus;
    const sb = statusOf[b] as ChangeStatus;
    if ((sa === 'added' && sb === 'removed') || (sa === 'removed' && sb === 'added')) continue;
    const status: ChangeStatus =
      sa === 'added' || sb === 'added'
        ? 'added'
        : sa === 'removed' || sb === 'removed'
          ? 'removed'
          : 'unchanged';
    const owner = status === 'unchanged' ? undefined : sa !== 'unchanged' ? a : b;
    const hunk = owner === undefined ? undefined : nodes[owner]?.hunk;
    const eid = edgeId(id(a), 'rel', id(b));
    if (hunk !== undefined) hunkEdges.set(hunk, [...(hunkEdges.get(hunk) ?? []), eid]);
    edges.push({ source: id(a), target: id(b), status, ...(hunk !== undefined ? { hunk } : {}) });
  }
  const fullHunks = hunks.map((h) => ({
    ...h,
    edges: hunkEdges.get(`${h.kind}:${h.anchor}`) ?? [],
  }));
  const diff = makeDiff({ nodes, edges, hunks: fullHunks });
  const side = Math.sqrt(n) * 60;
  const positions: Record<string, [number, number]> = {};
  for (let i = 0; i < n; i++) positions[id(i)] = [rand() * side, rand() * side];
  return { diff, layout: makeLayout(diff, positions) };
}
