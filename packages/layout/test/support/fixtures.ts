/**
 * Seeded graph fixtures for layout tests.
 */
import type { NodeFacet } from '@kgdiff/core';
import type { EdgeSpec, GraphSpec, NodeSpec } from './diff-builder.js';

type Random = () => number;

/** mulberry32: uniform floats in [0, 1) from a 32-bit seed. */
function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'cell',
  'membrane',
  'protein',
  'binding',
  'transport',
  'regulation',
  'process',
  'activity',
  'complex',
  'signal',
  'pathway',
  'receptor',
  'kinase',
  'metabolic',
  'response',
  'development',
  'organ',
  'tissue',
  'neuron',
  'synapse',
  'immune',
  'lipid',
  'ion',
  'channel',
  'vesicle',
  'nuclear',
  'mitochondrial',
  'DNA',
  'RNA',
  'repair',
];

const CJK = [
  '公司',
  '投资',
  '股东',
  '子公司',
  '控股',
  '集团',
  '科技',
  '有限',
  '银行',
  '基金',
  '管理',
  '北京',
  '上海',
  '深圳',
  '研究院',
  '数据',
  '智能',
  '网络',
  '云计算',
  '医药',
  '能源',
];

const pick = <T>(random: Random, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)]!;

export function englishLabel(random: Random): string {
  const words = 1 + Math.floor(random() * 3);
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(pick(random, WORDS));
  const text = parts.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function cjkLabel(random: Random): string {
  const words = 2 + Math.floor(random() * 2);
  let text = '';
  for (let i = 0; i < words; i++) text += pick(random, CJK);
  return text;
}

const id = (prefix: string, i: number): string => `${prefix}${String(i).padStart(4, '0')}`;

/** Random recursive tree: node i attaches to a uniformly random earlier node. */
export function tree(n: number, seed = 7, label = englishLabel): GraphSpec {
  const random = mulberry32(seed);
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: id('t', i), label: label(random) });
    if (i > 0) {
      const parent = Math.floor(random() * i);
      edges.push({
        source: id('t', i),
        target: id('t', parent),
        predicate: 'is_a',
        hierarchical: true,
      });
    }
  }
  return { nodes, edges };
}

/**
 * Barabási–Albert preferential attachment with `m` edges per new node on average (a fractional
 * part adds one more edge with that probability: m = 1.3 gives a sparse, KG-like graph).
 */
export function scaleFree(n: number, m = 2, seed = 11, label = englishLabel): GraphSpec {
  const random = mulberry32(seed);
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];
  const ends: number[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: id('s', i), label: label(random) });
    if (i === 0) continue;
    const targets = new Set<number>();
    const want = Math.min(Math.floor(m) + (random() < m - Math.floor(m) ? 1 : 0), i);
    while (targets.size < want) {
      const t = ends.length === 0 ? 0 : ends[Math.floor(random() * ends.length)]!;
      targets.add(t);
    }
    for (const t of targets) {
      edges.push({ source: id('s', i), target: id('s', t) });
      ends.push(i, t);
    }
  }
  return { nodes, edges };
}

export function star(leaves: number): GraphSpec {
  const random = mulberry32(5);
  const nodes: NodeSpec[] = [{ id: 'hub', label: 'Central hub' }];
  const edges: EdgeSpec[] = [];
  for (let i = 0; i < leaves; i++) {
    nodes.push({ id: id('l', i), label: englishLabel(random) });
    edges.push({ source: id('l', i), target: 'hub' });
  }
  return { nodes, edges };
}

/** Many small components (trees and rings) plus isolated nodes. */
export function components(count = 30, isolated = 40, seed = 3): GraphSpec {
  const random = mulberry32(seed);
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];
  let next = 0;
  for (let c = 0; c < count; c++) {
    const size = 2 + Math.floor(random() * random() * 24);
    const first = next;
    for (let i = 0; i < size; i++) {
      const me = next++;
      nodes.push({ id: id('c', me), label: englishLabel(random) });
      if (i > 0)
        edges.push({ source: id('c', me), target: id('c', first + Math.floor(random() * i)) });
    }
    if (size > 4 && random() < 0.4)
      edges.push({ source: id('c', first + size - 1), target: id('c', first) });
  }
  for (let i = 0; i < isolated; i++) nodes.push({ id: id('i', i), label: englishLabel(random) });
  return { nodes, edges };
}

/** Tree with extra cross links and CJK labels. */
export function cjk(n = 90, seed = 13): GraphSpec {
  const base = tree(n, seed, cjkLabel);
  const random = mulberry32(seed + 1);
  const extra: EdgeSpec[] = [];
  for (let k = 0; k < n / 6; k++) {
    const a = Math.floor(random() * n);
    const b = Math.floor(random() * n);
    if (a !== b) extra.push({ source: id('t', a), target: id('t', b), predicate: '投资' });
  }
  return { nodes: base.nodes, edges: [...base.edges, ...extra] };
}

/**
 * A realistic review: a 120-node hierarchy with additions, removals, renames, two merges, a
 * split and retargeted relations.
 */
export function changes(seed = 17): GraphSpec {
  const base = tree(120, seed);
  const nodes = new Map<string, NodeSpec>(base.nodes.map((n) => [n.id, n]));
  const edges: EdgeSpec[] = [...base.edges];
  const random = mulberry32(seed + 1);
  const set = (nodeId: string, patch: Partial<NodeSpec>): void => {
    const cur = nodes.get(nodeId)!;
    nodes.set(nodeId, { ...cur, ...patch });
  };
  const addFacet = (nodeId: string, facet: NodeFacet, status: NodeSpec['status']): void => {
    const cur = nodes.get(nodeId)!;
    nodes.set(nodeId, { ...cur, status, facets: [...(cur.facets ?? []), facet] });
  };
  const edgeIndex = (s: string) => edges.findIndex((e) => e.source === s);

  // Additions: leaves hanging off existing nodes.
  for (let k = 0; k < 8; k++) {
    const nodeId = `new${k}`;
    nodes.set(nodeId, { id: nodeId, label: englishLabel(random), status: 'added' });
    edges.push({
      source: nodeId,
      target: id('t', Math.floor(random() * 120)),
      status: 'added',
      predicate: 'is_a',
    });
  }
  // Removals: leaves.
  for (const victim of [110, 111, 112, 113, 114]) {
    set(id('t', victim), { status: 'removed' });
    const i = edgeIndex(id('t', victim));
    if (i >= 0) edges[i] = { ...edges[i]!, status: 'removed' };
  }
  // Renames.
  for (const r of [3, 30, 60]) {
    const cur = nodes.get(id('t', r))!;
    const to = `${cur.label} (revised)`;
    nodes.set(id('t', r), {
      ...cur,
      label: to,
      status: 'modified',
      facets: [{ kind: 'rename', from: cur.label ?? '', to }],
    });
  }
  // Merges: t100 → t20, t101 → t21 (sources removed, their edge carried to the target).
  for (const [source, target] of [
    [100, 20],
    [101, 21],
  ] as const) {
    const s = id('t', source);
    const t = id('t', target);
    addFacet(s, { kind: 'mergedInto', target: t, confidence: 1, via: 'hint' }, 'removed');
    addFacet(t, { kind: 'mergeTarget', sources: [s] }, 'modified');
    const i = edgeIndex(s);
    if (i >= 0) {
      const e = edges[i]!;
      edges[i] = {
        source: t,
        target: e.target,
        sourceBefore: s,
        predicate: e.predicate,
        status: 'modified',
        hierarchical: true,
        facets: [{ kind: 'retarget', end: 'source', from: s, to: t, cause: 'merge' }],
      };
    }
  }
  // Split: t40 → t40 + split0 + split1.
  addFacet(id('t', 40), { kind: 'splitInto', targets: ['split0', 'split1'] }, 'modified');
  for (const target of ['split0', 'split1']) {
    nodes.set(target, {
      id: target,
      label: `${nodes.get(id('t', 40))!.label} part`,
      status: 'added',
      facets: [{ kind: 'splitFrom', source: id('t', 40), confidence: 1, via: 'hint' }],
    });
    edges.push({ source: target, target: id('t', 5), status: 'added', predicate: 'is_a' });
  }
  // Retargets (moves): t70, t80 get a new parent.
  for (const [child, parent] of [
    [70, 2],
    [80, 9],
  ] as const) {
    const i = edgeIndex(id('t', child));
    if (i >= 0) {
      const e = edges[i]!;
      edges[i] = {
        ...e,
        target: id('t', parent),
        targetBefore: e.target,
        status: 'modified',
        facets: [
          { kind: 'retarget', end: 'target', from: e.target, to: id('t', parent), cause: 'move' },
        ],
      };
    }
  }
  return { nodes: [...nodes.values()], edges };
}

/** Same graph, nodes and edges in a different (seeded) order. */
export function shuffled(spec: GraphSpec, seed = 99): GraphSpec {
  const random = mulberry32(seed);
  const shuffle = <T>(list: readonly T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { nodes: shuffle(spec.nodes), edges: shuffle(spec.edges) };
}

export const FIXTURES = {
  tree: () => tree(150),
  scaleFree: () => scaleFree(500, 1.3),
  components: () => components(),
  star: () => star(60),
  cjk: () => cjk(),
  changes: () => changes(),
} as const;
