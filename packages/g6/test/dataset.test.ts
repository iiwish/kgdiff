/**
 * The real pipeline (formats → core → layout → scene → resolver → toG6Data) on every example
 * dataset: structural invariants G6 relies on, for any view.
 */
import type { EdgeData, GraphData, NodeData } from '@antv/g6';
import {
  type ChangeFamily,
  createViewState,
  createVisualResolver,
  type FrameVisuals,
  type Scene,
  type ViewState,
} from '@kgdiff/scene';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toG6Data } from '../src/index.js';
import { kgdiffData } from '../src/map.js';
import { datasetScene } from './support/scene.js';

const DATASETS = [
  'enterprise-kg',
  'enterprise-kg-en',
  'data-lineage',
  'llm-extraction',
  'ontology-release',
  'schema-vocab',
];

/** Everything G6 needs to accept the data and the controller needs to pick from it. */
function checkInvariants(scene: Scene, frame: FrameVisuals, data: GraphData): void {
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  const ids = [...nodes, ...edges].map((d) => String(d.id));
  expect(new Set(ids).size).toBe(ids.length);
  const nodeIds = new Set(nodes.map((n) => String(n.id)));
  for (const e of edges) {
    expect(nodeIds.has(String(e.source))).toBe(true);
    expect(nodeIds.has(String(e.target))).toBe(true);
    expect(['line', 'quadratic']).toContain(e.type);
  }
  const keySets = (list: readonly (NodeData | EdgeData)[]): Set<string> =>
    new Set(
      list.map((d) =>
        Object.keys(d.style ?? {})
          .sort()
          .join(','),
      ),
    );
  if (nodes.length > 0) expect(keySets(nodes).size).toBe(1);
  if (edges.length > 0) expect(keySets(edges).size).toBe(1);
  for (const d of [...nodes, ...edges]) {
    const k = kgdiffData(d.data);
    expect(k).not.toBeNull();
    if (k === null) continue;
    expect(k.hunk).toBeGreaterThanOrEqual(-1);
    expect(k.hunk).toBeLessThan(scene.hunks.length);
    if (k.kgdiff === 'node') {
      expect(scene.nodes[k.index]?.id).toBe(d.id);
      expect(frame.nodes[k.index]?.visible).toBe(true);
    }
    if (k.kgdiff === 'edge') expect(scene.edges[k.index]?.id).toBe(d.id);
    for (const v of Object.values(d.style ?? {})) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
    const opacity = d.style?.opacity as number;
    expect(opacity).toBeGreaterThanOrEqual(0);
    expect(opacity).toBeLessThanOrEqual(1);
  }
  const visibleNodes = frame.nodes.filter((n) => n.visible).length;
  const sceneNodes = nodes.filter((n) => kgdiffData(n.data)?.kgdiff === 'node').length;
  expect(sceneNodes).toBe(visibleNodes);
}

describe.each(DATASETS)('%s', (id) => {
  const scene = datasetScene(id);
  const resolver = createVisualResolver(scene);

  it.each(['union', 'before', 'after'] as const)('maps the %s layer consistently', (layer) => {
    const frame = resolver.resolve(createViewState({ layer }));
    checkInvariants(scene, frame, toG6Data(scene, frame));
  });

  it('maps the end of the replay like the after layer, node for node', () => {
    const end = toG6Data(
      scene,
      resolver.resolve(createViewState({ layer: 'replay', t: scene.timeline.duration })),
    );
    const after = toG6Data(scene, resolver.resolve(createViewState({ layer: 'after' })));
    const sceneIds = (d: GraphData): string[] =>
      (d.nodes ?? []).filter((n) => kgdiffData(n.data)?.kgdiff === 'node').map((n) => String(n.id));
    expect(sceneIds(end)).toEqual(sceneIds(after));
  });
});

describe('any view of the enterprise scene', () => {
  const scene = datasetScene('enterprise-kg');
  const resolver = createVisualResolver(scene);
  const families: ChangeFamily[] = ['added', 'removed', 'content', 'structure', 'identity'];
  const view: fc.Arbitrary<Partial<ViewState>> = fc.record({
    layer: fc.constantFrom('union', 'before', 'after', 'replay'),
    t: fc.double({ min: 0, max: scene.timeline.duration, noNaN: true }),
    selectedHunk: fc.integer({ min: -1, max: scene.hunks.length - 1 }),
    hoveredNode: fc.integer({ min: -1, max: scene.nodes.length - 1 }),
    families: fc.subarray(families).map((f) => new Set(f)),
    showSuggestions: fc.boolean(),
    reducedMotion: fc.boolean(),
  });

  it('always yields data G6 accepts, at any zoom', () => {
    fc.assert(
      fc.property(view, fc.boolean(), (partial, keepHidden) => {
        const frame = resolver.resolve(createViewState(partial));
        const data = toG6Data(scene, frame, { keepHidden });
        if (!keepHidden) checkInvariants(scene, frame, data);
        else {
          const nodeIds = new Set((data.nodes ?? []).map((n) => n.id));
          for (const e of data.edges ?? []) expect(nodeIds.has(e.source)).toBe(true);
        }
      }),
      { numRuns: 60, seed: 7 },
    );
  });
});

describe('replay glyphs', () => {
  it('maps every visible glyph of every replay frame (ontology-release splits included)', () => {
    for (const id of ['ontology-release', 'enterprise-kg']) {
      const scene = datasetScene(id);
      const resolver = createVisualResolver(scene);
      let frame: FrameVisuals | undefined;
      let raw = 0;
      let mapped = 0;
      for (let t = 0; t <= scene.timeline.duration; t += 250) {
        frame = resolver.resolve(createViewState({ layer: 'replay', t }), frame);
        const out = toG6Data(scene, frame);
        raw += frame.glyphs.filter((g) => g.alpha > 0).length;
        mapped += [...(out.nodes ?? []), ...(out.edges ?? [])].filter(
          (d) => kgdiffData(d.data)?.kgdiff === 'glyph',
        ).length;
        const ids = new Set((out.nodes ?? []).map((n) => n.id));
        const dangling = (out.edges ?? []).filter((e) => !ids.has(e.source) || !ids.has(e.target));
        if (dangling.length > 0) expect.fail(`t=${t}: edges to missing nodes`);
      }
      expect(raw).toBeGreaterThan(0);
      expect(mapped).toBe(raw);
    }
  });
});
