/**
 * The real pipeline, no mocks: core `diff` → layout `layoutDiff` → `buildScene` → resolver.
 * Asserts scene-level invariants that hold whatever exact semantics core settles on.
 */
import { type DiffResult, diff, type GraphInput } from '@kgdiff/core';
import { layoutDiff } from '@kgdiff/layout';
import { describe, expect, it } from 'vitest';
import {
  buildScene,
  computeFocus,
  createViewState,
  createVisualResolver,
  type FrameVisuals,
  frameBounds,
} from '../src/index.js';
import { nodeFamily, nodeRole } from '../src/roles.js';

const before: GraphInput = {
  meta: { name: 'org', version: 'v1' },
  nodes: [
    { id: 'thing', label: 'Thing' },
    { id: 'agent', label: 'Agent' },
    { id: 'org', label: 'Organisation', attrs: { since: 1990, kind: 'legal' } },
    { id: 'company', label: 'Company' },
    { id: 'firm', label: 'Firm', replacedBy: ['company'] },
    { id: 'listed', label: '上市公司' },
    { id: 'person', label: 'Person' },
    { id: 'employee', label: 'Employee' },
    { id: 'legacy', label: 'Legacy record' },
    { id: 'legacy-2', label: 'Legacy archive' },
    { id: 'product', label: 'Product' },
    { id: 'service', label: 'Service' },
  ],
  edges: [
    { source: 'agent', target: 'thing', predicate: 'rdfs:subClassOf' },
    { source: 'org', target: 'agent', predicate: 'rdfs:subClassOf' },
    { source: 'company', target: 'org', predicate: 'rdfs:subClassOf' },
    { source: 'firm', target: 'org', predicate: 'rdfs:subClassOf' },
    { source: 'firm', target: 'product', predicate: 'sells' },
    { source: 'listed', target: 'company', predicate: 'rdfs:subClassOf' },
    { source: 'person', target: 'agent', predicate: 'rdfs:subClassOf' },
    { source: 'employee', target: 'thing', predicate: 'rdfs:subClassOf' },
    { source: 'employee', target: 'company', predicate: 'worksFor' },
    { source: 'legacy', target: 'thing', predicate: 'rdfs:subClassOf' },
    { source: 'legacy-2', target: 'legacy', predicate: 'partOf' },
    { source: 'company', target: 'product', predicate: 'sells' },
    { source: 'service', target: 'thing', predicate: 'rdfs:subClassOf' },
  ],
};

const after: GraphInput = {
  meta: { name: 'org', version: 'v2' },
  nodes: [
    { id: 'thing', label: 'Thing' },
    { id: 'agent', label: 'Agent' },
    { id: 'org', label: 'Organization', attrs: { since: 1991, founded: 'x' } },
    { id: 'company', label: 'Company', replaces: ['firm'] },
    { id: 'listed', label: '上市公司（主板）' },
    { id: 'person', label: 'Person', deprecated: true, replacedBy: ['human'] },
    { id: 'human', label: 'Human' },
    { id: 'employee', label: 'Employee' },
    { id: 'product', label: 'Product' },
    { id: 'service', label: 'Service' },
    { id: 'contract', label: 'Contract' },
    { id: 'clause', label: 'Clause' },
  ],
  edges: [
    { source: 'agent', target: 'thing', predicate: 'rdfs:subClassOf' },
    { source: 'org', target: 'agent', predicate: 'rdfs:subClassOf' },
    { source: 'company', target: 'org', predicate: 'rdfs:subClassOf' },
    { source: 'listed', target: 'company', predicate: 'rdfs:subClassOf' },
    { source: 'person', target: 'agent', predicate: 'rdfs:subClassOf' },
    { source: 'human', target: 'agent', predicate: 'rdfs:subClassOf' },
    { source: 'employee', target: 'person', predicate: 'rdfs:subClassOf' },
    { source: 'employee', target: 'company', predicate: 'employedBy' },
    { source: 'company', target: 'product', predicate: 'sells' },
    { source: 'service', target: 'product', predicate: 'rdfs:subClassOf' },
    { source: 'contract', target: 'company', predicate: 'binds' },
    { source: 'clause', target: 'contract', predicate: 'partOf' },
  ],
};

async function pipeline(): Promise<{ d: DiffResult; scene: ReturnType<typeof buildScene> }> {
  const d = await diff(before, after);
  return { d, scene: buildScene(d, await layoutDiff(d)) };
}

const { d, scene } = await pipeline();

describe('real pipeline: diff → layoutDiff → buildScene → resolve', () => {
  it('maps every union element and agrees with core on roles and hunks', () => {
    expect(scene.nodes).toHaveLength(d.nodes.length);
    expect(scene.edges).toHaveLength(d.edges.length);
    expect(scene.hunks).toHaveLength(d.hunks.length);
    expect(new Set(scene.hunks.map((h) => h.id))).toEqual(new Set(d.hunks.map((h) => h.id)));
    for (const n of d.nodes) {
      const s = scene.nodes[scene.nodeIndex.get(n.id) as number];
      expect(s?.role).toBe(nodeRole(n));
      expect(s?.family).toBe(nodeFamily(n, nodeRole(n)));
      if (n.hunk !== undefined) expect(scene.hunks[s?.hunk ?? -1]?.id).toBe(n.hunk);
    }
    // Something of every broad kind shows up in this example.
    const families = new Set(scene.nodes.map((n) => n.family));
    for (const f of ['added', 'removed', 'content', 'neutral'] as const)
      expect(families.has(f), f).toBe(true);
  });

  it('titles hunks with the real localized formatter', async () => {
    const zh = buildScene(d, await layoutDiff(d), { locale: 'zh-CN' });
    for (const [k, h] of scene.hunks.entries()) {
      expect(h.title.length).toBeGreaterThan(0);
      expect(zh.hunks[k]?.title.length).toBeGreaterThan(0);
    }
    expect(zh.hunks.map((h) => h.title)).not.toEqual(scene.hunks.map((h) => h.title));
  });

  it('keeps phases in replay order and windows in tour order', () => {
    const order = ['remove', 'restructure', 'modify', 'add'];
    const phases = scene.hunks.map((h) => order.indexOf(h.phase));
    expect([...phases].sort((a, b) => a - b)).toEqual(phases);
    expect(scene.timeline.windows.map((w) => w.hunk)).toEqual(scene.hunks.map((h) => h.index));
    expect(scene.timeline.duration).toBeGreaterThan(0);
  });

  it('is deterministic end to end', async () => {
    const again = (await pipeline()).scene;
    expect(again.nodes).toEqual(scene.nodes);
    expect(again.edges).toEqual(scene.edges);
    expect(again.hunks).toEqual(scene.hunks);
    expect(again.timeline).toEqual(scene.timeline);
  });

  it('resolves every layer and the whole replay without NaN, reusing one frame', () => {
    const r = createVisualResolver(scene);
    const out: FrameVisuals = r.resolve(createViewState());
    const nodes = out.nodes;
    const check = (f: FrameVisuals): void => {
      for (const n of f.nodes) {
        if (!n.visible) continue;
        expect(Number.isFinite(n.x + n.y + n.r + n.alpha)).toBe(true);
        expect(n.alpha).toBeGreaterThanOrEqual(0);
        expect(n.alpha).toBeLessThanOrEqual(1);
      }
      for (const e of f.edges) {
        if (!e.visible) continue;
        expect(Number.isFinite(e.x1 + e.y1 + e.x2 + e.y2 + e.alpha + e.progress)).toBe(true);
      }
      for (const g of f.glyphs)
        expect(Number.isFinite(g.x1 + g.y1 + g.x2 + g.y2 + g.alpha)).toBe(true);
    };
    for (const layer of ['union', 'before', 'after'] as const)
      check(r.resolve(createViewState({ layer }), out));
    for (let k = 0; k <= 200; k++) {
      const t = (k / 200) * scene.timeline.duration;
      check(r.resolve(createViewState({ layer: 'replay', t, reducedMotion: k % 2 === 1 }), out));
    }
    expect(out.nodes).toBe(nodes);
    // The ends of the replay are the two versions.
    const end = r.resolve(createViewState({ layer: 'replay', t: scene.timeline.duration }));
    expect(end).toEqual(r.resolve(createViewState({ layer: 'after' })));
  });

  it('focuses and frames', () => {
    const focus = computeFocus(scene, { hops: 0 });
    for (const n of scene.nodes) if (n.status !== 'unchanged') expect(focus.nodes[n.index]).toBe(1);
    const all = frameBounds(scene);
    expect(all.width).toBeGreaterThan(0);
    const one = frameBounds(scene, [0]);
    expect(one.width).toBeGreaterThanOrEqual(160);
  });
});
