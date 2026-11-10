/**
 * Host layers (RFC 0003, part 4a): where they are drawn among the passes, once per side in
 * swipe, that nothing they leave on the context reaches later passes, and that the frame without
 * layers is the frame the renderer painted before they existed.
 */
import { KgdiffError } from '@kgdiff/core';
import type { FrameVisuals } from '@kgdiff/scene';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { darkTheme } from '../dev/theme.js';
import type { SurfaceFactory } from '../src/ctx.js';
import { FrameCache } from '../src/frame-cache.js';
import type { CameraState, LayerView, RendererLayer, SplitFrame } from '../src/index.js';
import { NO_LAYERS, Painter, Resources } from '../src/paint.js';
import { createRendererImpl } from '../src/renderer.js';
import {
  edge,
  frameOf,
  lbl,
  node,
  noSurfaces,
  type Op,
  RecordingContext,
  recordingFactory,
  type Style,
} from './helpers/recording-ctx.js';

/** What a layer saw when it was called. */
interface Call {
  readonly name: string;
  readonly view: LayerView;
  /** The context state on entry. */
  readonly style: Style;
  /** Index of the layer's first op in the recording. */
  readonly at: number;
}

function setup(o: { factory?: SurfaceFactory; grid?: boolean; dpr?: number; width?: number } = {}) {
  const ctx = new RecordingContext();
  const res = new Resources(o.factory ?? noSurfaces, darkTheme, ctx);
  const painter = new Painter(res);
  const caches = { main: new FrameCache(), before: new FrameCache(), after: new FrameCache() };
  const calls: Call[] = [];
  let version = 0;
  return {
    ctx,
    painter,
    calls,
    paint: (frame: FrameVisuals | SplitFrame | null, cam: CameraState = { x: 0, y: 0, k: 1 }) => {
      ctx.clear();
      calls.length = 0;
      return painter.paint(
        { ctx, width: o.width ?? 800, height: 600, dpr: o.dpr ?? 1 },
        cam,
        frame,
        caches,
        ++version,
        darkTheme,
        o.grid ?? false,
      );
    },
    /** A layer that fills one rectangle in a color named after it, and records its call. */
    layer: (order: 'under' | 'over', name: string): RendererLayer => ({
      order,
      draw: (c, view) => {
        const rec = c as unknown as RecordingContext;
        calls.push({ name, view, style: rec.style(), at: rec.ops.length });
        c.fillStyle = name;
        c.fillRect(1, 2, 3, 4);
      },
    }),
  };
}

const a = node(-100, 0, { label: lbl('a') });
const b = node(100, 0, { label: lbl('b') });
const graph = frameOf([a, b], [edge(a, b)]);

const indexOf = (ops: readonly Op[], test: (op: Op) => boolean): number => ops.findIndex(test);
const lastIndexOf = (ops: readonly Op[], test: (op: Op) => boolean): number =>
  ops.findLastIndex(test);
const filled = (name: string) => (op: Op) => op.name === 'fillRect' && op.style.fillStyle === name;

describe('layers: pass order', () => {
  it('draws under after the background and the grid, and over after the labels', () => {
    const { ctx, painter, paint, layer } = setup({
      factory: recordingFactory().factory,
      grid: true,
    });
    painter.under = [layer('under', 'U')];
    painter.over = [layer('over', 'O')];
    const stats = paint(graph);
    expect(stats.phases).toEqual([
      'background',
      'under',
      'collapsed',
      'edges',
      'glyphs',
      'halos',
      'nodes',
      'pivots',
      'badges',
      'labels',
      'over',
    ]);
    const ops = ctx.ops;
    const under = indexOf(ops, filled('U'));
    const over = indexOf(ops, filled('O'));
    // Background, then the grid's pattern fill (one level at zoom 1), then the layer.
    const before = ops.slice(0, under).filter((op) => op.name === 'fillRect');
    expect(before.map((op) => typeof op.style.fillStyle)).toEqual(['string', 'object']);
    expect(before[0]!.style.fillStyle).toBe(darkTheme.canvas.background);
    // Nothing of the graph is drawn before it…
    const drawing = (op: Op) =>
      ['stroke', 'fill', 'arc', 'drawImage', 'fillText'].includes(op.name);
    expect(indexOf(ops, drawing)).toBeGreaterThan(under);
    expect(indexOf(ops, (op) => op.name === 'stroke')).toBeGreaterThan(under);
    // …and nothing after the over layer: the labels (atlas blits) come before it.
    expect(lastIndexOf(ops, (op) => op.name === 'drawImage')).toBeGreaterThan(under);
    expect(lastIndexOf(ops, drawing)).toBeLessThan(over);
  });

  it('draws the layers of one order in the order they were added', () => {
    const { painter, paint, calls, layer } = setup();
    painter.under = [layer('under', 'u1'), layer('under', 'u2')];
    painter.over = [layer('over', 'o1'), layer('over', 'o2')];
    paint(graph);
    expect(calls.map((c) => c.name)).toEqual(['u1', 'u2', 'o1', 'o2']);
  });

  it('draws layers on a renderer that has no frame yet', () => {
    const { painter, paint, calls, layer } = setup();
    painter.under = [layer('under', 'U')];
    painter.over = [layer('over', 'O')];
    expect(paint(null).phases).toEqual(['background', 'under', 'over']);
    expect(calls.map((c) => c.name)).toEqual(['U', 'O']);
  });
});

describe('layers: what a layer is told', () => {
  it('gives the camera, the visible world, the pixel ratio and the world → screen mapping', () => {
    const { painter, paint, calls, layer } = setup({ dpr: 2 });
    painter.over = [layer('over', 'O')];
    const cam = { x: 10, y: 20, k: 2 };
    paint(graph, cam);
    const { view, style } = calls[0]!;
    expect(view.camera).toEqual(cam);
    expect(view.camera).not.toBe(cam);
    expect(view.viewport).toEqual({ x: -190, y: -130, width: 400, height: 300 });
    expect(view.pixelRatio).toBe(2);
    expect('side' in view).toBe(false);
    expect(view.worldToScreen({ x: 10, y: 20 })).toEqual({ x: 400, y: 300 });
    expect(view.worldToScreen({ x: -190, y: -130 })).toEqual({ x: 0, y: 0 });
    // CSS pixels, full alpha, no dash, whatever the label pass left behind.
    expect(style.transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(style.globalAlpha).toBe(1);
    expect(style.dash).toEqual([]);
    expect(style.clips).toBe(0);
  });

  it('starts every layer at full alpha without a dash, also after a faded dashed pass', () => {
    const { painter, paint, calls, layer } = setup();
    painter.over = [layer('over', 'O')];
    const ghost = node(0, 0, { alpha: 0.3, dash: [3, 3], stroke: '#F87171', label: lbl('x') });
    paint(frameOf([ghost]));
    expect(calls[0]!.style.globalAlpha).toBe(1);
    expect(calls[0]!.style.dash).toEqual([]);
  });
});

describe('layers: swipe', () => {
  const before = frameOf([node(-300, 0, { fill: '#F87171', label: lbl('left') })]);
  const after = frameOf([node(100, 0, { fill: '#34D399', label: lbl('right') })]);

  it('calls every layer once per side, clipped to it, with the side and its part of the world', () => {
    const { ctx, painter, paint, calls, layer } = setup();
    painter.under = [layer('under', 'U')];
    painter.over = [layer('over', 'O')];
    const stats = paint({ split: 0.25, before, after });
    expect(calls.map((c) => [c.name, c.view.side])).toEqual([
      ['U', 'before'],
      ['O', 'before'],
      ['U', 'after'],
      ['O', 'after'],
    ]);
    expect(stats.phases.filter((p) => p === 'under' || p === 'over')).toHaveLength(4);
    // The side's part of the viewport: the divider is at x = 200 px, world x = −200.
    expect(calls[0]!.view.viewport).toEqual({ x: -400, y: -300, width: 200, height: 600 });
    expect(calls[2]!.view.viewport).toEqual({ x: -200, y: -300, width: 600, height: 600 });
    // One mapping for both sides: the camera's.
    expect(calls[0]!.view.worldToScreen({ x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
    expect(calls[2]!.view.worldToScreen({ x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
    // Each call is inside the clip of its side (the last clip rectangle before it).
    for (const call of calls) {
      expect(call.style.clips).toBe(1);
      const clip = ctx.ops
        .slice(0, call.at)
        .findLast((op) => op.name === 'rect' && op.args[3] === 600)!;
      expect(clip.args).toEqual(
        call.view.side === 'before' ? [0, 0, 200, 600] : [200, 0, 600, 600],
      );
    }
    // The before side is finished (over layer included) before the after side begins.
    const overBefore = calls[1]!.at;
    expect(
      indexOf(ctx.ops, (op) => op.name === 'fill' && op.style.fillStyle === '#34D399'),
    ).toBeGreaterThan(overBefore);
    // The divider is above both sides' layers.
    const divider = ctx.calls('fillRect').at(-1)!;
    expect(divider.style.fillStyle).toBe(darkTheme.surface.borderStrong);
    expect(divider.style.clips).toBe(0);
    expect(ctx.depth).toBe(0);
  });

  it('skips the side that has no width', () => {
    const { painter, paint, calls, layer } = setup();
    painter.under = [layer('under', 'U')];
    paint({ split: 0, before, after });
    expect(calls.map((c) => c.view.side)).toEqual(['after']);
    expect(calls[0]!.view.viewport).toEqual({ x: -400, y: -300, width: 800, height: 600 });
    paint({ split: 1, before, after });
    expect(calls.map((c) => c.view.side)).toEqual(['before']);
  });
});

describe('layers: context state', () => {
  /** A layer that leaves everything it can dirty, and says which ops are its own. */
  function dirty(order: 'under' | 'over', spans: [number, number][]): RendererLayer {
    return {
      order,
      draw: (c) => {
        const rec = c as unknown as RecordingContext;
        const start = rec.ops.length;
        c.globalAlpha = 0.07;
        c.fillStyle = '#ff00ff';
        c.strokeStyle = '#00ffff';
        c.lineWidth = 40;
        c.lineCap = 'round';
        c.lineDashOffset = 13;
        c.font = '900 99px serif';
        c.setLineDash([9, 9]);
        c.setTransform(3, 0, 0, 3, 50, 50);
        c.beginPath();
        c.rect(0, 0, 5, 5);
        c.clip();
        c.save(); // and one save it never restores is the layer's own bug; this one is balanced
        c.restore();
        // The renderer's bracket: `save` and `setLineDash` before, `restore` after.
        spans.push([start - 2, rec.ops.length + 1]);
      },
    };
  }

  const without = (ops: readonly Op[], spans: readonly [number, number][]): Op[] =>
    ops.filter((_, i) => !spans.some(([from, to]) => i >= from && i < to));

  it('restores what an under and an over layer leave dirty: the other passes paint as without them', () => {
    const { ctx, painter, paint } = setup();
    const frame = frameOf(
      [a, b, node(0, 80, { alpha: 0.5, dash: [3, 3], stroke: '#F87171', label: lbl('ghost') })],
      [edge(a, b, { dash: [4, 3], alpha: 0.45 })],
    );
    // The context keeps its state from frame to frame: compare frames that follow a frame.
    paint(frame);
    paint(frame);
    const plain = [...ctx.ops];
    const spans: [number, number][] = [];
    painter.under = [dirty('under', spans), dirty('under', spans)];
    painter.over = [dirty('over', spans)];
    paint(frame);
    expect(spans).toHaveLength(3);
    // Every other op, with the style, transform and clip it was issued under, is unchanged.
    expect(without(ctx.ops, spans)).toEqual(plain);
    expect(ctx.depth).toBe(0);
    expect(ctx.style().transform).toEqual(plain.at(-1)!.style.transform);
    expect(ctx.globalAlpha).toBe(plain.at(-1)!.style.globalAlpha);
  });

  it('restores it per side in swipe, keeping each side’s clip', () => {
    const { ctx, painter, paint } = setup();
    const frame = { split: 0.4, before: frameOf([a]), after: frameOf([a, b], [edge(a, b)]) };
    paint(frame);
    paint(frame);
    const plain = [...ctx.ops];
    const spans: [number, number][] = [];
    painter.under = [dirty('under', spans)];
    painter.over = [dirty('over', spans)];
    paint(frame);
    expect(spans).toHaveLength(4);
    expect(without(ctx.ops, spans)).toEqual(plain);
    expect(ctx.depth).toBe(0);
  });

  it('reports a layer that throws and paints the rest of the frame', () => {
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    try {
      const { ctx, painter, paint, calls, layer } = setup();
      const error = new Error('host bug');
      painter.under = [
        {
          order: 'under',
          draw: (c) => {
            c.globalAlpha = 0;
            throw error;
          },
        },
        layer('under', 'U'),
      ];
      const stats = paint(graph);
      expect(report).toHaveBeenCalledExactlyOnceWith(error);
      expect(calls.map((c) => c.name)).toEqual(['U']);
      expect(stats.phases.at(-1)).toBe('labels');
      expect(stats.nodes).toBe(2);
      expect(ctx.depth).toBe(0);
      expect(ctx.calls('fill').every((op) => op.style.globalAlpha > 0)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('layers: without layers', () => {
  it('paints exactly what a painter that never had layers paints', () => {
    const one = setup({ grid: true });
    const two = setup({ grid: true });
    const frame = { split: 0.5, before: graph, after: frameOf([a]) };
    one.paint(graph);
    one.paint(graph);
    const single = [...one.ctx.ops];
    one.paint(frame);
    const split = [...one.ctx.ops];
    // Layers come and go on the second painter.
    two.painter.under = [two.layer('under', 'U')];
    two.painter.over = [two.layer('over', 'O')];
    two.paint(graph);
    expect(two.ctx.ops.length).toBeGreaterThan(single.length);
    two.painter.under = NO_LAYERS;
    two.painter.over = NO_LAYERS;
    two.paint(graph);
    expect(two.ctx.ops).toEqual(single);
    two.paint(frame);
    expect(two.ctx.ops).toEqual(split);
    expect(two.calls).toEqual([]);
  });

  it('adds only the layers’ own brackets to a frame', () => {
    const { ctx, painter, paint, layer } = setup();
    paint(graph);
    const plain = ctx.ops.length;
    painter.under = [layer('under', 'U')];
    painter.over = [layer('over', 'O')];
    paint(graph);
    // Per layer: save, setLineDash, fillRect, restore.
    expect(ctx.ops.length).toBe(plain + 8);
  });
});

// ─── Through `createRenderer` ───────────────────────────────────────────────

describe('Renderer.addLayer', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 600);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function harness() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const ctx = new RecordingContext();
    const queue = new Map<number, (t: number) => void>();
    let id = 0;
    const clock = { t: 0 };
    const renderer = createRendererImpl(
      container,
      { theme: darkTheme, pixelRatio: 2 },
      {
        context: ctx,
        surfaceFactory: noSurfaces,
        now: () => clock.t,
        requestFrame: (cb) => {
          queue.set(++id, cb);
          return id;
        },
        cancelFrame: (i) => {
          queue.delete(i);
        },
      },
    );
    const settle = (): number => {
      let n = 0;
      while (queue.size > 0 && n < 100) {
        clock.t += 16;
        const pending = [...queue.values()];
        queue.clear();
        for (const cb of pending) cb(clock.t);
        n++;
      }
      return n;
    };
    const counter = (order: 'under' | 'over'): RendererLayer & { calls: LayerView[] } => {
      const calls: LayerView[] = [];
      return { order, calls, draw: (_c, view) => void calls.push(view) };
    };
    return { renderer, ctx, queue, clock, settle, counter };
  }

  it('draws a layer from the next frame on, until its removal, scheduling a frame for both', () => {
    const h = harness();
    h.renderer.setFrame(graph);
    h.settle();
    const under = h.counter('under');
    const over = h.counter('over');
    const offUnder = h.renderer.addLayer(under);
    const offOver = h.renderer.addLayer(over);
    expect(under.calls).toHaveLength(0);
    expect(h.queue.size).toBe(1);
    expect(h.settle()).toBe(1);
    expect([under.calls.length, over.calls.length]).toEqual([1, 1]);
    expect(under.calls[0]!.pixelRatio).toBe(2);
    h.renderer.camera.panBy(10, 0);
    h.settle();
    expect([under.calls.length, over.calls.length]).toEqual([2, 2]);
    const first = under.calls[0]!.camera;
    expect(under.calls[1]!.camera.x).toBeCloseTo(first.x - 10 / first.k, 9);

    offUnder();
    expect(h.queue.size).toBe(1);
    h.settle();
    expect([under.calls.length, over.calls.length]).toEqual([2, 3]);
    offUnder(); // again: nothing happens, and no frame is scheduled
    expect(h.queue.size).toBe(0);
    offOver();
    h.settle();
    h.renderer.requestRender();
    h.settle();
    expect([under.calls.length, over.calls.length]).toEqual([2, 3]);
  });

  it('paints as before once every layer is removed', () => {
    const h = harness();
    h.renderer.setFrame(graph);
    h.settle();
    h.ctx.clear();
    h.renderer.requestRender();
    h.settle();
    const plain = [...h.ctx.ops];
    const off = [h.renderer.addLayer(h.counter('under')), h.renderer.addLayer(h.counter('over'))];
    h.settle();
    for (const fn of off) fn();
    h.ctx.clear();
    h.settle();
    expect(h.ctx.ops).toEqual(plain);
  });

  it('removes one registration of a layer added twice', () => {
    const h = harness();
    const layer = h.counter('over');
    const off = h.renderer.addLayer(layer);
    h.renderer.addLayer(layer);
    h.settle();
    expect(layer.calls).toHaveLength(2);
    off();
    off();
    h.settle();
    expect(layer.calls).toHaveLength(3);
  });

  it('lets a layer remove itself, or add another, while it draws', () => {
    const h = harness();
    const second = h.counter('under');
    const third = h.counter('under');
    let off: () => void = () => undefined;
    let drawn = 0;
    off = h.renderer.addLayer({
      order: 'under',
      draw: () => {
        drawn++;
        off();
        h.renderer.addLayer(third);
      },
    });
    h.renderer.addLayer(second);
    h.settle();
    // The frame it changed is painted with the layers it started with; the next one without it.
    expect(drawn).toBe(1);
    expect(second.calls).toHaveLength(2);
    expect(third.calls).toHaveLength(1);
  });

  it('counts the layers’ time in the frame event', () => {
    const h = harness();
    h.settle();
    const ms: number[] = [];
    h.renderer.on('frame', (e) => ms.push(e.ms));
    h.renderer.addLayer({
      order: 'over',
      draw: () => {
        h.clock.t += 7;
      },
    });
    h.renderer.addLayer({
      order: 'under',
      draw: () => {
        h.clock.t += 5;
      },
    });
    h.settle();
    expect(ms).toEqual([12]);
  });

  it('includes layers in toDataURL, at the renderer’s pixel ratio and at another scale', () => {
    const h = harness();
    h.renderer.setFrame(graph);
    h.settle();
    const under = h.counter('under');
    const seen: unknown[] = [];
    h.renderer.addLayer(under);
    h.renderer.addLayer({ order: 'over', draw: (c) => void seen.push(c) });
    h.settle();
    // Same scale: the canvas is repainted for the export, layers included.
    h.renderer.toDataURL();
    expect(under.calls).toHaveLength(2);
    expect(seen.at(-1)).toBe(h.ctx);
    // Another scale: painted into the export's own canvas, with its pixel ratio.
    const exportCtx = new RecordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => exportCtx as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      () => 'data:image/png;base64,',
    );
    expect(h.renderer.toDataURL(3)).toBe('data:image/png;base64,');
    expect(under.calls).toHaveLength(3);
    expect(under.calls[2]!.pixelRatio).toBe(3);
    expect(under.calls[2]!.viewport).toEqual(under.calls[1]!.viewport);
    expect(seen.at(-1)).toBe(exportCtx);
    expect(exportCtx.depth).toBe(0);
  });

  it('does not pick layers', () => {
    const h = harness();
    h.renderer.setFrame(graph);
    h.settle();
    const at = h.renderer.camera.worldToScreen({ x: -100, y: 0 });
    const pick = h.renderer.pick(at.x, at.y);
    expect(pick).toEqual({ type: 'node', index: 0 });
    h.renderer.addLayer({ order: 'over', draw: (c) => c.fillRect(0, 0, 800, 600) });
    h.settle();
    expect(h.renderer.pick(at.x, at.y)).toEqual(pick);
    expect(h.renderer.pick(5, 5)).toBeNull();
  });

  it('rejects what is not a layer', () => {
    const h = harness();
    const bad = [
      null,
      {},
      { order: 'under' },
      { order: 'middle', draw: () => undefined },
      { order: 'over', draw: 'no' },
    ];
    for (const layer of bad) {
      expect(() => h.renderer.addLayer(layer as unknown as RendererLayer)).toThrow(KgdiffError);
    }
  });

  it('drops its layers on destroy', () => {
    const h = harness();
    const layer = h.counter('under');
    const off = h.renderer.addLayer(layer);
    h.settle();
    h.renderer.destroy();
    off();
    const late = h.renderer.addLayer(h.counter('over'));
    late();
    expect(h.queue.size).toBe(0);
    expect(layer.calls).toHaveLength(1);
  });
});
