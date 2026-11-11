import type { DiffResult, UnionNode } from '@kgdiff/core';
import { KgdiffError } from '@kgdiff/core';
import { describe, expect, it, vi } from 'vitest';
import {
  buildScene,
  createViewState,
  createVisualResolver,
  evenShapeDash,
  type FrameVisuals,
  isNodeShape,
  NODE_SHAPES,
  type NodeShape,
  type Scene,
  type SceneOptions,
  shapeApothem,
  shapeDistance,
  shapeGauge,
  shapeVertexRadius,
  shapeVertices,
  type ViewState,
} from '../src/index.js';
import { kitchenSink, makeDiff, makeLayout, POSITIONS, synthetic } from './fixtures.js';

vi.mock('@kgdiff/core', async (orig) => ({
  ...(await orig<object>()),
  formatHunk: (await import('./mock-core.js')).fakeFormatHunk,
}));

const POLYGONS: readonly NodeShape[] = ['square', 'diamond', 'hexagon'];
const R = 10;

/** Every node typed by the order of its id, so the frames hold all four shapes. */
function typed(diff: DiffResult): DiffResult {
  return {
    ...diff,
    nodes: diff.nodes.map((n, i) => ({ ...n, types: [`T${i % 4}`] }) as UnionNode),
  };
}
const SHAPES: Readonly<Record<string, NodeShape>> = {
  T0: 'circle',
  T1: 'square',
  T2: 'diamond',
  T3: 'hexagon',
};

function sceneOf(options: SceneOptions = {}): Scene {
  const diff = typed(kitchenSink());
  return buildScene(diff, makeLayout(diff, POSITIONS), options);
}

function views(scene: Scene): Partial<ViewState>[] {
  return [
    { layer: 'union' },
    { layer: 'union', selectedHunk: 0 },
    { layer: 'before' },
    { layer: 'after' },
    ...Array.from({ length: 16 }, (_, k) => ({
      layer: 'replay' as const,
      t: (k / 15) * scene.timeline.duration,
    })),
  ];
}

describe('outline geometry', () => {
  it('knows its shapes', () => {
    expect(NODE_SHAPES).toEqual(['circle', 'square', 'diamond', 'hexagon']);
    for (const s of NODE_SHAPES) expect(isNodeShape(s)).toBe(true);
    for (const s of ['triangle', 'Circle', '', 1, null, undefined]) {
      expect(isNodeShape(s)).toBe(false);
    }
  });

  it.each(POLYGONS)('%s: fits the box of half side r the layout reserves', (shape) => {
    const v = shapeVertices(shape);
    const radius = shapeVertexRadius(shape, R, 0);
    for (let i = 0; i < v.length; i += 2) {
      expect(Math.abs((v[i] as number) * radius)).toBeLessThanOrEqual(R + 1e-9);
      expect(Math.abs((v[i + 1] as number) * radius)).toBeLessThanOrEqual(R + 1e-9);
    }
  });

  it('has the documented sizes', () => {
    expect(shapeApothem('circle', R)).toBe(R);
    expect(shapeApothem('square', R)).toBeCloseTo((R * Math.sqrt(Math.PI)) / 2, 9);
    expect(shapeVertexRadius('diamond', R, 0)).toBeCloseTo(R, 9);
    expect(shapeVertexRadius('hexagon', R, 0)).toBeCloseTo(R, 9);
    // The square has the disc's area.
    expect((2 * shapeApothem('square', R)) ** 2).toBeCloseTo(Math.PI * R * R, 6);
  });

  it.each(POLYGONS)('%s: vertices lie on the outline; growing moves every side by g', (shape) => {
    const v = shapeVertices(shape);
    const g = 3.5;
    const a = shapeApothem(shape, R);
    const grown = shapeVertexRadius(shape, R, g);
    for (let i = 0; i < v.length; i += 2) {
      const x = v[i] as number;
      const y = v[i + 1] as number;
      expect(shapeGauge(shape, x * grown, y * grown)).toBeCloseTo(a + g, 9);
      expect(shapeDistance(shape, R, g, x, y)).toBeCloseTo(grown, 9);
      // The middle of a side is `g` further out than on the ungrown outline.
      const nx = (x + (v[(i + 2) % v.length] as number)) / 2;
      const ny = (y + (v[(i + 3) % v.length] as number)) / 2;
      const norm = Math.hypot(nx, ny);
      expect(shapeDistance(shape, R, g, nx / norm, ny / norm)).toBeCloseTo(a + g, 9);
    }
  });

  it.each(POLYGONS)(
    '%s: a point is inside exactly when its gauge is within the apothem',
    (shape) => {
      const a = shapeApothem(shape, R);
      for (let t = 0; t < 360; t += 7) {
        const ux = Math.cos((t * Math.PI) / 180);
        const uy = Math.sin((t * Math.PI) / 180);
        const d = shapeDistance(shape, R, 0, ux, uy);
        expect(shapeGauge(shape, ux * d * 0.99, uy * d * 0.99)).toBeLessThan(a);
        expect(shapeGauge(shape, ux * d * 1.01, uy * d * 1.01)).toBeGreaterThan(a);
      }
    },
  );

  it('is a circle for no shape or an unknown one', () => {
    expect(shapeVertices(undefined)).toEqual([]);
    expect(shapeVertices('circle')).toEqual([]);
    expect(shapeVertices('blob' as NodeShape)).toEqual([]);
    expect(shapeDistance('circle', R, 2, 0.6, 0.8)).toBe(R + 2);
    expect(shapeGauge(undefined, 3, 4)).toBe(5);
  });

  it.each(POLYGONS)('%s: dashes tile each side and center on the vertices', (shape) => {
    const sides = shapeVertices(shape).length / 2;
    for (const r of [3, 6, 10, 14, 37.5]) {
      const out: number[] = [];
      const offset = evenShapeDash(shape, [3, 2.5], r, out);
      const period = (out[0] as number) + (out[1] as number);
      const side = 2 * shapeApothem(shape, r) * Math.tan(Math.PI / sides);
      expect(side / period).toBeCloseTo(Math.round(side / period), 9);
      expect(side / period).toBeGreaterThanOrEqual(1 - 1e-9);
      expect((out[0] as number) / (out[1] as number)).toBeCloseTo(3 / 2.5, 9);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(period);
      // Half a side along the path, the first vertex is half a dash into the pattern.
      const phase = (offset + side / 2) % period;
      expect(phase).toBeCloseTo((out[0] as number) / 2, 6);
    }
  });
});

describe('buildScene with shapes', () => {
  const node = (id: string, status: 'added' | 'removed' | 'unchanged', types: string[]) => ({
    id,
    status,
    types,
  });

  function small(nodes: ReturnType<typeof node>[], shapes: Record<string, NodeShape>): Scene {
    const diff = makeDiff({
      nodes: nodes.map((n) => ({ id: n.id, status: n.status })),
      edges: [],
      hunks: [],
    });
    const withTypes = {
      ...diff,
      nodes: diff.nodes.map((n, i) => ({ ...n, types: nodes[i]?.types ?? [] }) as UnionNode),
    };
    const positions = Object.fromEntries(nodes.map((n, i) => [n.id, [i * 50, 0] as const]));
    return buildScene(withTypes, makeLayout(withTypes, positions), { shapes });
  }

  it('takes the first entry, in the order of the map, among the types', () => {
    const scene = small(
      [node('a', 'unchanged', ['Rule', 'Metric']), node('b', 'unchanged', ['Metric', 'Rule'])],
      { Metric: 'diamond', Rule: 'square' },
    );
    expect(scene.nodes.map((n) => n.shape)).toEqual(['diamond', 'diamond']);
  });

  it('leaves out the shape of a node with no entry, and of a circle', () => {
    const scene = small([node('a', 'unchanged', ['Other']), node('b', 'unchanged', ['C'])], {
      C: 'circle',
    });
    for (const n of scene.nodes) expect('shape' in n).toBe(false);
    expect(scene.shapes).toEqual([{ type: 'C', shape: 'circle' }]);
  });

  it('reads the union types: the after version, the before version of a removed node', () => {
    const scene = small([node('a', 'added', ['New']), node('b', 'removed', ['Old'])], {
      New: 'hexagon',
      Old: 'square',
    });
    expect(scene.nodes.map((n) => n.shape)).toEqual(['hexagon', 'square']);
  });

  it('lists the entries in use, in their order', () => {
    const scene = small([node('a', 'unchanged', ['B']), node('b', 'unchanged', ['A'])], {
      A: 'square',
      Unused: 'hexagon',
      B: 'diamond',
    });
    expect(scene.shapes).toEqual([
      { type: 'A', shape: 'square' },
      { type: 'B', shape: 'diamond' },
    ]);
  });

  it('rejects an unknown shape', () => {
    const diff = kitchenSink();
    const layout = makeLayout(diff, POSITIONS);
    const bad = { shapes: { A: 'triangle' as NodeShape } };
    expect(() => buildScene(diff, layout, bad)).toThrow(KgdiffError);
    expect(() => buildScene(diff, layout, bad)).toThrow(/shapes\["A"\]/);
  });
});

describe('frames with shapes', () => {
  const plain = sceneOf();
  const shaped = sceneOf({ shapes: SHAPES });
  const SHAPE_KEYS = new Set(['shape', 'shape1', 'shape2']);
  const noShapeKeys = (f: FrameVisuals): unknown =>
    JSON.parse(JSON.stringify(f, (k, v) => (SHAPE_KEYS.has(k) ? undefined : v)));

  it('are untouched without shapes: no key at all, and the same with an empty map', () => {
    const empty = sceneOf({ shapes: {} });
    const none = sceneOf({ shapes: { Nothing: 'square' } });
    expect('shapes' in plain).toBe(false);
    expect('shapes' in empty).toBe(false);
    for (const view of views(plain)) {
      const f = createVisualResolver(plain).resolve(createViewState(view));
      for (const n of f.nodes) expect('shape' in n).toBe(false);
      for (const e of f.edges) expect('shape1' in e || 'shape2' in e).toBe(false);
      for (const g of f.glyphs) expect('shape1' in g || 'shape2' in g).toBe(false);
      expect(createVisualResolver(empty).resolve(createViewState(view))).toStrictEqual(f);
      expect(createVisualResolver(none).resolve(createViewState(view))).toStrictEqual(f);
    }
  });

  it('differ only in the shape keys and the pivots, which sit on the outline', () => {
    for (const view of views(plain)) {
      const a = createVisualResolver(plain).resolve(createViewState(view));
      const b = createVisualResolver(shaped).resolve(createViewState(view));
      const strip = (f: FrameVisuals): unknown => {
        const out = noShapeKeys(f) as { glyphs: { kind: string; x1: number; y1: number }[] };
        for (const g of out.glyphs) {
          if (g.kind === 'pivot') Object.assign(g, { x1: 0, y1: 0, x2: 0, y2: 0 });
        }
        return out;
      };
      expect(strip(b)).toEqual(strip(a));
    }
  });

  it('carry each node its shape in every layer: a type change does not animate', () => {
    const resolver = createVisualResolver(shaped);
    const out = resolver.resolve(createViewState());
    for (const view of views(shaped)) {
      resolver.resolve(createViewState(view), out);
      expect(out.nodes.map((n) => n.shape)).toEqual(shaped.nodes.map((n) => n.shape));
    }
  });

  it('give each drawn edge and glyph the shapes of its ends', () => {
    const f = createVisualResolver(shaped).resolve(createViewState({ layer: 'after' }));
    let checked = 0;
    for (const [j, e] of f.edges.entries()) {
      if (!e.visible) continue;
      const se = shaped.edges[j] as Scene['edges'][number];
      expect(e.shape1).toBe(shaped.nodes[se.s]?.shape);
      expect(e.shape2).toBe(shaped.nodes[se.t]?.shape);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    const union = createVisualResolver(shaped).resolve(createViewState());
    const arcs = union.glyphs.filter((g) => g.kind !== 'pivot');
    expect(arcs.length).toBeGreaterThan(0);
    const at = (x: number, y: number) => shaped.nodes.find((n) => n.x === x && n.y === y);
    for (const g of arcs) {
      expect(g.shape1).toBe(at(g.x1, g.y1)?.shape);
      expect(g.shape2).toBe(at(g.x2, g.y2)?.shape);
    }
  });

  it('put a pivot on the outline of its node', () => {
    const squares = sceneOf({
      shapes: { T0: 'square', T1: 'square', T2: 'square', T3: 'square' },
    });
    const f = createVisualResolver(squares).resolve(createViewState());
    const pivots = f.glyphs.filter((g) => g.kind === 'pivot');
    expect(pivots.length).toBeGreaterThan(0);
    for (const p of pivots) {
      const hit = squares.nodes.find((n) => {
        const a = shapeApothem('square', n.r);
        return Math.abs(shapeGauge('square', p.x1 - n.x, p.y1 - n.y) - a) < 1e-6;
      });
      expect(hit).toBeDefined();
    }
  });

  it('clears a frame that served a shaped scene', () => {
    const out = createVisualResolver(shaped).resolve(createViewState());
    const f = createVisualResolver(plain).resolve(createViewState(), out);
    for (const n of f.nodes) expect(n.shape).toBeUndefined();
    for (const e of f.edges) expect(e.shape1 ?? e.shape2).toBeUndefined();
  });

  it('reuse the frame: no new elements in steady state', () => {
    const { diff, layout } = synthetic(400, 800);
    const mixed = typed(diff);
    const scene = buildScene(mixed, layout, { shapes: SHAPES });
    const resolver = createVisualResolver(scene);
    const out = resolver.resolve(createViewState());
    const first = out.nodes[1];
    const edge = out.edges[1];
    resolver.resolve(createViewState({ layer: 'after' }), out);
    expect(out.nodes[1]).toBe(first);
    expect(out.edges[1]).toBe(edge);
  });
});
