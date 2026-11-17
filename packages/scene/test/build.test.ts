import { type DiffResult, KgdiffError } from '@kgdiff/core';
import { nodeRadius } from '@kgdiff/layout';
import { describe, expect, it, vi } from 'vitest';
import { buildScene, getTheme, type Scene } from '../src/index.js';
import { IDS, kitchenSink, makeDiff, makeLayout, POSITIONS } from './fixtures.js';

vi.mock('@kgdiff/core', async (orig) => ({
  ...(await orig<object>()),
  formatHunk: (await import('./mock-core.js')).fakeFormatHunk,
}));

const diff = kitchenSink();
const scene = buildScene(diff, makeLayout(diff, POSITIONS));
const node = (s: Scene, id: string) => {
  const i = s.nodeIndex.get(id);
  if (i === undefined) throw new Error(`no node ${id}`);
  return s.nodes[i] as Scene['nodes'][number];
};
const edge = (s: Scene, id: string) => {
  const j = s.edgeIndex.get(id);
  if (j === undefined) throw new Error(`no edge ${id}`);
  return s.edges[j] as Scene['edges'][number];
};

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !(v instanceof Map) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

describe('buildScene: elements', () => {
  it('indexes nodes and edges densely in union-id order', () => {
    expect(scene.nodes.map((n) => n.index)).toEqual(scene.nodes.map((_, i) => i));
    expect(scene.edges.map((e) => e.index)).toEqual(scene.edges.map((_, j) => j));
    expect(scene.nodes.map((n) => n.id)).toEqual(diff.nodes.map((n) => n.id));
    for (const n of scene.nodes) expect(scene.nodeIndex.get(n.id)).toBe(n.index);
    for (const e of scene.edges) expect(scene.edgeIndex.get(e.id)).toBe(e.index);
    for (const h of scene.hunks) expect(scene.hunkIndex.get(h.id)).toBe(h.index);
  });

  it('covers every node role and edge role', () => {
    expect(new Set(scene.nodes.map((n) => n.role))).toEqual(
      new Set([
        'unchanged',
        'added',
        'removed',
        'modified',
        'deprecated',
        'merge-source',
        'merge-target',
        'split-source',
        'split-target',
      ]),
    );
    expect(new Set(scene.edges.map((e) => e.role))).toEqual(
      new Set(['unchanged', 'added', 'removed', 'modified', 'retarget', 'carried', 'collapsed']),
    );
  });

  it('assigns roles and families by the primary facet', () => {
    const expected: Record<string, [string, string]> = {
      A: ['unchanged', 'neutral'],
      N1: ['added', 'added'],
      R1: ['removed', 'removed'],
      M1: ['modified', 'content'],
      M2: ['modified', 'structure'],
      M3: ['modified', 'content'],
      M4: ['modified', 'identity'],
      M5: ['modified', 'structure'],
      DP: ['deprecated', 'content'],
      S1: ['merge-source', 'identity'],
      T: ['merge-target', 'identity'],
      X: ['split-source', 'identity'],
      Y1: ['split-target', 'identity'],
    };
    for (const [id, [role, family]] of Object.entries(expected)) {
      expect([node(scene, id).role, node(scene, id).family], id).toEqual([role, family]);
    }
    expect(edge(scene, IDS.predicateM3D).family).toBe('structure');
    expect(edge(scene, IDS.labelM1C).family).toBe('content');
    expect(edge(scene, IDS.moveM2).role).toBe('retarget');
    expect(edge(scene, IDS.carriedTD).role).toBe('carried');
    expect(edge(scene, IDS.collapsedS2A).role).toBe('collapsed');
  });

  it('records the family each node is drawn in before', () => {
    expect(node(scene, 'T').familyBefore).toBe('content'); // renamed merge target
    expect(node(scene, 'S1').familyBefore).toBe('identity');
    expect(node(scene, 'M2').familyBefore).toBe('structure');
    expect(node(scene, 'N1').familyBefore).toBe('added');
    expect(node(scene, 'A').familyBefore).toBe('neutral');
    for (const n of scene.nodes) {
      if (n.role !== 'merge-target' && n.role !== 'split-target')
        expect(n.familyBefore).toBe(n.family);
    }
  });

  it('builds badges, old labels and replay flows', () => {
    expect(node(scene, 'M1').badge).toBe('+2 −1 ~1');
    expect(node(scene, 'T').badge).toBe('⊕ 2');
    expect(node(scene, 'A').badge).toBeUndefined();
    expect(node(scene, 'M1').labelBefore).toBe('Mu old');
    expect(node(scene, 'T').labelBefore).toBe('Tee old');
    expect(node(scene, 'M2').labelBefore).toBeUndefined();
    expect(edge(scene, IDS.labelM1C).labelBefore).toBe('held');
    expect(edge(scene, IDS.predicateM3D).labelBefore).toBe('p');
    expect(edge(scene, IDS.unchangedBC).labelBefore).toBeUndefined();
    const flowTo = (id: string) => {
      const f = node(scene, id).flow;
      return f === undefined ? undefined : scene.nodes[f]?.id;
    };
    expect(flowTo('S1')).toBe('T');
    expect(flowTo('S2')).toBe('T');
    expect(flowTo('Y1')).toBe('X');
    expect(flowTo('Y2')).toBe('X');
    expect(flowTo('DP')).toBe('C');
    expect(flowTo('T')).toBeUndefined();
  });

  it('records presence, degree, radius and endpoints', () => {
    expect(node(scene, 'N1')).toMatchObject({
      presentBefore: false,
      presentAfter: true,
      status: 'added',
    });
    expect(node(scene, 'R1')).toMatchObject({
      presentBefore: true,
      presentAfter: false,
      status: 'removed',
    });
    expect(node(scene, 'A')).toMatchObject({
      presentBefore: true,
      presentAfter: true,
      implicit: false,
    });
    const a = node(scene, 'A');
    expect(a.r).toBe(nodeRadius(a.degree));
    expect([a.x, a.y]).toEqual([0, 0]);
    const retarget = edge(scene, IDS.retargetCB);
    expect(scene.nodes[retarget.t]?.id).toBe('B');
    expect(scene.nodes[retarget.tb]?.id).toBe('D');
    expect(retarget.s).toBe(retarget.sb);
    const carried = edge(scene, IDS.carriedTD);
    expect(scene.nodes[carried.sb]?.id).toBe('S1');
    expect(edge(scene, IDS.removedR1B)).toMatchObject({ presentBefore: true, presentAfter: false });
    expect(edge(scene, IDS.moveM2).hierarchical).toBe(true);
  });

  it('curves parallel edges ±0.18·k and keeps lone edges straight', () => {
    expect(edge(scene, IDS.unchangedAB1).curvature).toBe(0);
    expect(edge(scene, IDS.unchangedAB2).curvature).toBe(0.18);
    // B → A takes the other side: −0.18 in A → B terms is +0.18 in its own direction.
    expect(edge(scene, IDS.unchangedBA3).curvature).toBe(0.18);
    expect(edge(scene, IDS.unchangedBC).curvature).toBe(0.18);
    expect(edge(scene, IDS.retargetCB).curvature).toBe(0.18);
    // C → D also hosts the retarget's ghost form, which must not bend the real edge.
    expect(edge(scene, IDS.unchangedCD).curvature).toBe(0);
    expect(edge(scene, IDS.labelM1C).curvature).toBe(0);
  });

  it('ranks importance: every changed node above every unchanged one, then by degree', () => {
    const changed = scene.nodes.filter((n) => n.status !== 'unchanged').map((n) => n.importance);
    const unchanged = scene.nodes.filter((n) => n.status === 'unchanged');
    expect(Math.min(...changed)).toBeGreaterThan(Math.max(...unchanged.map((n) => n.importance)));
    for (const n of scene.nodes) {
      expect(n.importance).toBeGreaterThanOrEqual(0);
      expect(n.importance).toBeLessThanOrEqual(1);
    }
    const byDegree = [...unchanged].sort((a, b) => a.degree - b.degree);
    for (let k = 1; k < byDegree.length; k++) {
      expect(byDegree[k]?.importance).toBeGreaterThanOrEqual(byDegree[k - 1]?.importance ?? 0);
    }
    expect(node(scene, 'F').importance).toBe(0);
  });

  it('labels predicates with the files’ own property labels (meta.predicateLabels)', () => {
    const d = makeDiff({
      nodes: [
        { id: 'a', status: 'unchanged' },
        { id: 'b', status: 'unchanged' },
        { id: 'c', status: 'unchanged' },
        { id: 'd', status: 'unchanged' },
      ],
      edges: [
        {
          source: 'a',
          target: 'b',
          predicate: 'BFO:0000050',
          label: 'BFO:0000050',
          status: 'unchanged',
        },
        { source: 'b', target: 'c', predicate: 'RO:0002', label: 'RO:0002', status: 'unchanged' },
        {
          source: 'c',
          target: 'd',
          predicate: 'ex:new',
          predicateBefore: 'ex:old',
          status: 'modified',
          hunk: 'r',
          facets: [{ kind: 'predicate', from: 'ex:old', to: 'ex:new' }],
        },
        { source: 'a', target: 'c', predicate: 'constructor', status: 'unchanged' },
        {
          source: 'a',
          target: 'd',
          predicate: 'ex:p',
          label: 'owns',
          labelBefore: 'held',
          status: 'modified',
          hunk: 'r',
          facets: [{ kind: 'label', from: 'held', to: 'owns' }],
        },
        { source: 'b', target: 'd', predicate: 'ex:bad', status: 'unchanged' },
      ],
      hunks: [{ id: 'r', kind: 'relations', phase: 'restructure', anchor: 'c', edges: [] }],
      meta: {
        after: {
          predicateLabels: {
            'BFO:0000050': 'part of',
            'ex:new': 'replaces',
            'ex:p': 'possesses',
            'ex:bad': 42,
          },
        },
        before: {
          predicateLabels: {
            'BFO:0000050': 'is part of',
            'RO:0002': 'regulates',
            'ex:old': 'supersedes',
          },
        },
      },
    });
    const s = buildScene(d, makeLayout(d, { a: [0, 0], b: [10, 0], c: [20, 0], d: [30, 0] }));
    const label = (src: string, p: string, t: string) => edge(s, JSON.stringify([src, p, t]));
    expect(label('a', 'BFO:0000050', 'b').label).toBe('part of'); // after wins
    expect(label('b', 'RO:0002', 'c').label).toBe('regulates'); // before as fallback
    expect(label('c', 'ex:new', 'd')).toMatchObject({
      label: 'replaces',
      labelBefore: 'supersedes',
    });
    expect(label('a', 'constructor', 'c').label).toBe('constructor'); // own keys only
    expect(label('b', 'ex:bad', 'd').label).toBe('ex:bad'); // non-string ignored
    // Explicit labels that changed stay visible as they are.
    expect(label('a', 'ex:p', 'd')).toMatchObject({ label: 'owns', labelBefore: 'held' });
  });

  it('maps suggestions to node indices', () => {
    expect(scene.suggestions).toEqual([
      { before: scene.nodeIndex.get('Q1'), after: scene.nodeIndex.get('Q2'), score: 0.72 },
    ]);
  });
});

describe('buildScene: hunks', () => {
  it('orders hunks as a spatial tour within replay phases', () => {
    expect(scene.hunks.map((h) => h.id)).toEqual([
      'remove:R1',
      'remove:Q1',
      'split:X',
      'relations:C',
      'relations:B',
      'modify:M2',
      'merge:T',
      'modify:M5',
      'modify:M3',
      'modify:M4',
      'modify:M1',
      'modify:DP',
      'add:N1',
      'add:Q2',
    ]);
    expect(scene.hunks.map((h) => h.index)).toEqual(scene.hunks.map((_, k) => k));
  });

  it('links elements to their hunk index', () => {
    for (const h of scene.hunks) {
      for (const i of h.nodes) expect(scene.nodes[i]?.hunk).toBe(h.index);
      for (const j of h.edges) expect(scene.edges[j]?.hunk).toBe(h.index);
    }
    expect(node(scene, 'A').hunk).toBe(-1);
    expect(edge(scene, IDS.unchangedAB1).hunk).toBe(-1);
  });

  it('titles hunks with core formatHunk in the requested locale', () => {
    const zh = buildScene(diff, makeLayout(diff, POSITIONS), { locale: 'zh-CN' });
    expect(zh.locale).toBe('zh-CN');
    expect(zh.hunks[0]?.title).toBe('zh-CN|remove|R1');
    expect(zh.hunks[0]?.subtitle).toBe('2n 2e');
    expect(scene.locale).toBe('en');
    expect(scene.hunks.find((h) => h.id === 'merge:T')?.title).toBe('en|merge|T');
  });

  it('refines families: pure moves are structure, rekeys identity', () => {
    const fam = (id: string) => scene.hunks.find((h) => h.id === id)?.family;
    expect(fam('modify:M2')).toBe('structure');
    expect(fam('modify:M4')).toBe('identity');
    expect(fam('modify:M1')).toBe('content');
    expect(fam('modify:DP')).toBe('content');
    expect(fam('merge:T')).toBe('identity');
    expect(fam('relations:C')).toBe('structure');
    expect(fam('add:N1')).toBe('added');
    expect(fam('remove:R1')).toBe('removed');
  });

  it('bounds every hunk around its nodes and context, padded for labels', () => {
    for (const h of scene.hunks) {
      for (const i of [...h.nodes, ...h.context]) {
        const n = scene.nodes[i];
        if (n === undefined) continue;
        expect(n.x - n.r).toBeGreaterThanOrEqual(h.bounds.x - 1e-9);
        expect(n.x + n.r).toBeLessThanOrEqual(h.bounds.x + h.bounds.width + 1e-9);
        expect(n.y - n.r).toBeGreaterThanOrEqual(h.bounds.y - 1e-9);
        // The label sits below the node.
        expect(h.bounds.y + h.bounds.height).toBeGreaterThan(n.y + n.r + 5);
      }
    }
    const merge = scene.hunks.find((h) => h.id === 'merge:T');
    expect(merge?.anchor).toBe(scene.nodeIndex.get('T'));
    expect(merge?.nodes.map((i) => scene.nodes[i]?.id)).toEqual(['T', 'S1', 'S2']);
    expect(merge?.context.map((i) => scene.nodes[i]?.id)).toEqual(['A', 'B', 'D']);
  });

  it('bounds the whole scene', () => {
    for (const n of scene.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(scene.bounds.x);
      expect(n.x).toBeLessThanOrEqual(scene.bounds.x + scene.bounds.width);
      expect(n.y).toBeGreaterThanOrEqual(scene.bounds.y);
      expect(n.y).toBeLessThanOrEqual(scene.bounds.y + scene.bounds.height);
    }
  });
});

describe('buildScene: scope, options and robustness', () => {
  it("builds the same scene from a host's own positions and radii as from a layout result", () => {
    const positions = new Map<string, { x: number; y: number }>();
    const radii = new Map<string, number>();
    for (const n of diff.nodes) {
      const p = POSITIONS[n.id];
      if (p === undefined) continue;
      positions.set(n.id, { x: p[0], y: p[1] });
      radii.set(n.id, nodeRadius(Math.max(n.degree.before, n.degree.after)));
    }
    expect(buildScene(diff, { positions, radii })).toEqual(scene);
    const hidden = { D: 1, Q1: 2 };
    expect(buildScene(diff, { positions, radii, hidden: new Map(Object.entries(hidden)) })).toEqual(
      buildScene(diff, makeLayout(diff, POSITIONS, hidden)),
    );
  });

  it('leaves out nodes absent from the layout and edges missing an endpoint', () => {
    const positions = { ...POSITIONS };
    delete (positions as Record<string, unknown>).E;
    delete (positions as Record<string, unknown>).F;
    const layout = makeLayout(diff, positions, { D: 1, Q1: 1, Q2: 1 });
    const s = buildScene(diff, layout);
    expect(s.nodes).toHaveLength(scene.nodes.length - 2);
    expect(s.nodeIndex.has('E')).toBe(false);
    expect(s.edgeIndex.has(IDS.unchangedDE)).toBe(false);
    expect(s.edgeIndex.has(IDS.removedQ1E)).toBe(false);
    expect(node(s, 'D').hidden).toBe(1);
    expect(node(s, 'A').hidden).toBe(0);
    const q1 = s.hunks.find((h) => h.id === 'remove:Q1');
    expect(q1?.context).toEqual([]);
    expect(q1?.edges).toEqual([]);
    expect(s.hunks).toHaveLength(scene.hunks.length);
  });

  it('falls back to the after endpoint when a before endpoint is out of scope', () => {
    const positions = { ...POSITIONS };
    delete (positions as Record<string, unknown>).S1;
    const s = buildScene(diff, makeLayout(diff, positions));
    const carried = edge(s, IDS.carriedTD);
    expect(carried.sb).toBe(carried.s);
    expect(node(s, 'T').badge).toBe('⊕ 2');
  });

  it('excludes nodes with non-finite positions and derives missing radii', () => {
    const layout = makeLayout(diff, POSITIONS);
    const positions = new Map(layout.positions);
    positions.set('F', { x: Number.NaN, y: 0 });
    const radii = new Map(layout.radii);
    radii.delete('A');
    const s = buildScene(diff, { ...layout, positions, radii });
    expect(s.nodeIndex.has('F')).toBe(false);
    expect(node(s, 'A').r).toBe(nodeRadius(node(s, 'A').degree));
  });

  it('passes stats and meta through and resolves themes', () => {
    expect(scene.stats).toBe(diff.stats);
    expect(scene.meta).toEqual({ before: { name: 'before' }, after: { name: 'after' } });
    expect(scene.theme).toBe(getTheme('dark'));
    const layout = makeLayout(diff, POSITIONS);
    expect(buildScene(diff, layout, { theme: 'light', palette: 'colorblind' }).theme).toBe(
      getTheme('light', 'colorblind'),
    );
    const custom = getTheme('light');
    expect(buildScene(diff, layout, { theme: custom, palette: 'colorblind' }).theme).toBe(custom);
  });

  it('validates replay options', () => {
    const layout = makeLayout(diff, POSITIONS);
    expect(() => buildScene(diff, layout, { replay: { pace: 0 } })).toThrow(KgdiffError);
    expect(() => buildScene(diff, layout, { replay: { pace: Number.NaN } })).toThrow(/pace/);
    expect(() => buildScene(diff, layout, { replay: { chapterThreshold: -1 } })).toThrow(
      /chapterThreshold/,
    );
  });

  it('is deterministic and independent of hunk array order and layout map order', () => {
    const layout = makeLayout(diff, POSITIONS);
    const again = buildScene(diff, layout);
    expect(again).toEqual(scene);
    const shuffled: DiffResult = { ...diff, hunks: [...diff.hunks].reverse() };
    const reversedLayout = { ...layout, positions: new Map([...layout.positions].reverse()) };
    const s = buildScene(shuffled, reversedLayout);
    expect(s.hunks.map((h) => h.id)).toEqual(scene.hunks.map((h) => h.id));
    expect(s.nodes).toEqual(scene.nodes);
    expect(s.timeline).toEqual(scene.timeline);
  });

  it('does not mutate its inputs', () => {
    const frozen = deepFreeze(kitchenSink());
    const layout = deepFreeze(makeLayout(frozen, POSITIONS));
    expect(() => buildScene(frozen, layout)).not.toThrow();
  });

  it('handles an empty diff', () => {
    const empty = makeDiff({ nodes: [], edges: [], hunks: [] });
    const s = buildScene(empty, makeLayout(empty, {}));
    expect(s.nodes).toEqual([]);
    expect(s.hunks).toEqual([]);
    expect(s.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(s.timeline).toEqual({ duration: 0, windows: [], chapters: [], mode: 'hunks' });
  });

  it('handles self-loops, special-character ids and CJK labels', () => {
    const d = makeDiff({
      nodes: [
        {
          id: 'http://x.org/a|"b" c',
          status: 'modified',
          label: '上市公司',
          labelBefore: '企业',
          hunk: 'h',
          facets: [{ kind: 'rename', from: '企业', to: '上市公司' }],
        },
      ],
      edges: [
        {
          source: 'http://x.org/a|"b" c',
          target: 'http://x.org/a|"b" c',
          predicate: 'self',
          status: 'added',
          hunk: 'h',
        },
        {
          source: 'http://x.org/a|"b" c',
          target: 'http://x.org/a|"b" c',
          predicate: 'self2',
          status: 'unchanged',
        },
      ],
      hunks: [
        {
          id: 'h',
          kind: 'modify',
          phase: 'modify',
          anchor: 'http://x.org/a|"b" c',
          nodes: ['http://x.org/a|"b" c'],
          edges: [JSON.stringify(['http://x.org/a|"b" c', 'self', 'http://x.org/a|"b" c'])],
        },
      ],
    });
    const s = buildScene(d, makeLayout(d, { 'http://x.org/a|"b" c': [5, 5] }));
    expect(s.nodes[0]?.labelBefore).toBe('企业');
    expect(s.edges.map((e) => e.curvature)).toEqual([0.18, -0.18]);
    expect(s.hunks[0]?.bounds.width).toBeGreaterThanOrEqual(48);
  });
});
