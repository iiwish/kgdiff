/**
 * `createDiffGraph` with the real G6 5.1.1 runtime (happy-dom + a stand-in 2D context):
 * kgdiff-node draws its extra shapes, interaction and every controller path run in G6.
 */
import type { Graph, IEvent } from '@antv/g6';
import { getTheme, type Scene, shapeApothem, shapeGauge } from '@kgdiff/scene';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOVER_STATE } from '../src/constants.js';
import { outlinePoints } from '../src/geometry.js';
import { createDiffGraph, type DiffGraphController } from '../src/index.js';
import { type CanvasMock, installCanvasMock } from './support/canvas.js';
import { datasetScene } from './support/scene.js';

/** The slice of a G6 element / G shape these tests inspect. */
interface Shape {
  readonly attributes: Record<string, unknown>;
  getShape(name: string): Shape | undefined;
}

let mock: CanvasMock;
let live: DiffGraphController[] = [];

beforeAll(() => {
  mock = installCanvasMock();
});
afterAll(() => mock.restore());
afterEach(() => {
  for (const c of live) c.destroy();
  live = [];
  document.body.replaceChildren();
});

async function create(
  scene: Scene = datasetScene(),
  g6: Record<string, unknown> = { animation: false },
): Promise<{ c: DiffGraphController; graph: Graph; container: HTMLElement }> {
  const container = document.createElement('div');
  document.body.append(container);
  const c = await createDiffGraph(container, scene, { g6: { width: 800, height: 600, ...g6 } });
  live.push(c);
  return { c, graph: c.graph, container };
}

/** G6 keeps rendered elements behind a private context; tests read it to check shapes. */
function element(graph: Graph, id: string): Shape {
  const ctx = (graph as unknown as { context: { element: { getElement(id: string): unknown } } })
    .context;
  const el = ctx.element.getElement(id);
  if (el === undefined) throw new Error(`element ${id} is not rendered`);
  return el as Shape;
}

function shape(graph: Graph, id: string, name: string): Shape | undefined {
  return element(graph, id).getShape(name);
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('createDiffGraph with G6', () => {
  it('renders every scene node and fits the view', async () => {
    const scene = datasetScene();
    const { graph } = await create(scene);
    for (const n of scene.nodes) expect(graph.hasNode(n.id)).toBe(true);
    expect(graph.getZoom()).not.toBe(1);
    expect(graph.getElementRenderStyle(String(scene.nodes[0]?.id)).size).toBeGreaterThan(0);
  });

  it('draws rings, glows and struck labels with kgdiff-node shapes', async () => {
    const scene = datasetScene();
    const { graph } = await create(scene);
    const ringed = graph.getNodeData().find((n) => n.style?.ring === true);
    const haloed = graph.getNodeData().find((n) => n.style?.halo === true);
    const struck = graph
      .getNodeData()
      .find((n) => n.style?.labelTextDecorationLine === 'line-through');
    const renamed = graph.getNodeData().find((n) => n.style?.sublabel === true);
    if (!ringed || !haloed || !struck || !renamed) throw new Error('fixture lacks a primitive');
    const id = (d: { id: unknown }): string => String(d.id);

    const r = (ringed.style?.size as number) / 2;
    expect(shape(graph, id(ringed), 'ring')?.attributes).toMatchObject({
      r: r + (ringed.style?.ringGap as number),
      lineWidth: ringed.style?.ringLineWidth,
      stroke: ringed.style?.ringStroke,
    });
    const glow = shape(graph, id(haloed), 'halo')?.attributes;
    expect(String(glow?.fill)).toMatch(/^radial-gradient\(circle closest-side/);
    expect(glow?.r as number).toBeGreaterThanOrEqual((1.6 * (haloed.style?.size as number)) / 2);

    // G's own decoration is off; a line strikes through the middle of the text instead.
    const text = shape(graph, id(struck), 'label')?.getShape('text')?.attributes;
    expect(text?.textDecorationLine).toBe('none');
    const strike = shape(graph, id(struck), 'strike')?.attributes;
    expect(strike?.stroke).toBe(struck.style?.labelFill);
    expect(strike?.x2 as number).toBeGreaterThan(strike?.x1 as number);

    expect(shape(graph, id(renamed), 'sublabel')).toBeDefined();
    expect(shape(graph, id(renamed), 'substrike')).toBeDefined();
    // Our keys never reach the key circle.
    expect(Object.keys(shape(graph, id(ringed), 'key')?.attributes ?? {})).not.toContain(
      'ringStroke',
    );

    await tick(40);
    expect(mock.gradients.some((g) => g.stops.length === 6)).toBe(true);
  });

  it('draws light-theme halos as offset rings', async () => {
    const scene = datasetScene('enterprise-kg', { theme: 'light' });
    const { graph } = await create(scene);
    const haloed = graph.getNodeData().find((n) => n.style?.halo === true);
    if (!haloed) throw new Error('fixture');
    const ring = shape(graph, String(haloed.id), 'halo')?.attributes;
    expect(ring).toMatchObject({ fill: 'none', lineWidth: 2 });
    expect(ring?.r as number).toBeGreaterThanOrEqual((haloed.style?.size as number) / 2 + 5);
  });

  describe.each(['square', 'diamond', 'hexagon'] as const)('%s nodes', (kind) => {
    const shaped = (theme: 'dark' | 'light'): Scene => {
      const scene = datasetScene('enterprise-kg', { theme });
      return { ...scene, nodes: scene.nodes.map((n) => ({ ...n, shape: kind })) };
    };
    const frameShapes = async (
      theme: 'dark' | 'light',
    ): Promise<{ graph: Graph; c: DiffGraphController }> => {
      const scene = shaped(theme);
      const { graph, c } = await create(scene);
      return { graph, c };
    };

    it('draw the key and the ring as the outline, grown by the gap', async () => {
      const { graph } = await frameShapes('dark');
      const ringed = graph.getNodeData().find((n) => n.style?.ring === true);
      if (!ringed) throw new Error('fixture');
      const id = String(ringed.id);
      expect(ringed.style?.shape).toBe(kind);
      const r = (ringed.style?.size as number) / 2;
      const gap = ringed.style?.ringGap as number;
      const key = shape(graph, id, 'key')?.attributes;
      const ring = shape(graph, id, 'ring')?.attributes;
      expect(key?.points).toEqual(outlinePoints(kind, r, 0));
      expect(key?.r).toBeUndefined();
      expect(key?.shape).toBeUndefined();
      expect(ring?.points).toEqual(outlinePoints(kind, r, gap));
    });

    it('keep the dark glow a disc and follow the outline with the light halo', async () => {
      const dark = await frameShapes('dark');
      const glowing = dark.graph.getNodeData().find((n) => n.style?.halo === true);
      if (!glowing) throw new Error('fixture');
      const glow = shape(dark.graph, String(glowing.id), 'halo')?.attributes;
      expect(glow?.points).toBeUndefined();
      expect(String(glow?.fill)).toMatch(/^radial-gradient/);

      const light = await frameShapes('light');
      const ringed = light.graph.getNodeData().find((n) => n.style?.halo === true);
      if (!ringed) throw new Error('fixture');
      const halo = shape(light.graph, String(ringed.id), 'halo')?.attributes;
      expect(halo).toMatchObject({ fill: 'none', lineWidth: 2 });
      expect(Array.isArray(halo?.points)).toBe(true);
    });

    it('stop edges at the outline', async () => {
      const { graph } = await frameShapes('dark');
      const data = graph.getNodeData()[0];
      if (!data) throw new Error('fixture');
      const el = element(graph, String(data.id)) as Shape & {
        getCenter(): number[];
        getIntersectPoint(p: number[], extended?: boolean): number[];
      };
      const r = (data.style?.size as number) / 2;
      const [cx = 0, cy = 0] = el.getCenter();
      const [x = 0, y = 0] = el.getIntersectPoint([cx + 300, cy + 130]);
      expect(shapeGauge(kind, x - cx, y - cy)).toBeCloseTo(shapeApothem(kind, r), 6);
      const [ex = 0] = el.getIntersectPoint([cx + 300, cy + 130], true);
      expect(ex).toBeLessThan(cx);
    });
  });

  it('draws a built-in circle for a shaped node of G6 own type', async () => {
    const scene = datasetScene();
    const shaped = {
      ...scene,
      nodes: scene.nodes.map((n) => ({ ...n, shape: 'square' as const })),
    };
    const { graph } = await create(shaped, { animation: false, node: { type: 'circle' } });
    const first = graph.getNodeData()[0];
    if (!first) throw new Error('fixture');
    const key = shape(graph, String(first.id), 'key')?.attributes;
    expect(key?.points).toBeUndefined();
    expect(key?.r).toBe((first.style?.size as number) / 2);
  });

  it('adds pivot dots that never take the pointer', async () => {
    const { graph } = await create();
    const pivots = graph.getNodeData().filter((n) => String(n.id).startsWith('kgdiff-glyph-pivot'));
    expect(pivots.length).toBeGreaterThan(0);
    for (const p of pivots) expect(p.style?.pointerEvents).toBe('none');
  });

  it('hovers with its private state and selects on click', async () => {
    const scene = datasetScene();
    const { graph } = await create(scene);
    const changed = scene.nodes.find((n) => n.family === 'added');
    if (!changed) throw new Error('fixture');
    const target = element(graph, changed.id);
    graph.emit('node:pointerenter', {
      type: 'pointerenter',
      target,
      targetType: 'node',
    } as unknown as IEvent);
    await tick();
    expect(graph.getElementState(changed.id)).toContain(HOVER_STATE);
    expect(graph.getElementRenderStyle(changed.id).lineWidth).toBe(2);
    graph.emit('node:pointerleave', {
      type: 'pointerleave',
      target,
      targetType: 'node',
    } as unknown as IEvent);
    await tick();
    expect(graph.getElementState(changed.id)).not.toContain(HOVER_STATE);

    graph.emit('node:click', { target, targetType: 'node' } as unknown as IEvent);
    await tick(60);
    const others = graph
      .getNodeData()
      .filter(
        (n) => !scene.hunks[changed.hunk]?.nodes.includes(scene.nodeIndex.get(String(n.id)) ?? -2),
      );
    expect(others.some((n) => (n.style?.opacity as number) < 0.5)).toBe(true);
  });

  it('runs layers, selection, theme and replay through G6 with animations', async () => {
    const scene = datasetScene();
    const { c, graph } = await create(scene, {});
    await c.setLayer('before');
    expect(graph.getNodeData().filter((n) => !String(n.id).startsWith('kgdiff-'))).toHaveLength(
      scene.nodes.filter((n) => n.presentBefore).length,
    );
    await c.selectHunk(0);
    await c.selectHunk(-1);
    await c.setTheme(getTheme('light', 'colorblind'));
    await c.playReplay({ speed: 200 });
    const ids = graph
      .getNodeData()
      .map((n) => String(n.id))
      .filter((id) => !id.startsWith('kgdiff-'));
    expect(ids.sort()).toEqual(
      scene.nodes
        .filter((n) => n.presentAfter)
        .map((n) => n.id)
        .sort(),
    );
  }, 20_000);

  it('leaves no canvas behind when destroyed', async () => {
    const { c, graph, container } = await create();
    c.destroy();
    expect(graph.destroyed).toBe(true);
    expect(container.querySelector('canvas')).toBeNull();
  });
});

describe('createDiffGraph edge cases', () => {
  it('renders an empty diff', async () => {
    const { diff } = await import('@kgdiff/core');
    const { layoutDiff } = await import('@kgdiff/layout');
    const { buildScene } = await import('@kgdiff/scene');
    const empty = { nodes: [], edges: [] };
    const result = await diff(empty, empty);
    const scene = buildScene(result, await layoutDiff(result));
    const { c, graph } = await create(scene);
    expect(graph.getNodeData()).toEqual([]);
    await c.setLayer('after');
    await c.playReplay();
  });
});
