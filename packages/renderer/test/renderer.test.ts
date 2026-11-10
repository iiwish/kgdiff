import { KgdiffError } from '@kgdiff/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { darkTheme, lightTheme } from '../dev/theme.js';
import type { PickResult, Renderer, RendererOptions } from '../src/index.js';
import { createRendererImpl, type RendererDeps } from '../src/renderer.js';
import {
  edge,
  frameOf,
  node,
  RecordingContext,
  recordingFactory,
} from './helpers/recording-ctx.js';

interface Harness {
  renderer: Renderer;
  ctx: RecordingContext;
  container: HTMLElement;
  /** Pending animation-frame callbacks. */
  queue: Map<number, (t: number) => void>;
  /** Run the pending callbacks once at time `t` (advances the clock). */
  frame: (dt?: number) => void;
  /** Run frames until the loop sleeps (max 500). Returns how many ran. */
  settle: () => number;
  clock: { t: number };
}

let sizeSpy: { w: number; h: number };

beforeEach(() => {
  sizeSpy = { w: 800, h: 600 };
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => sizeSpy.w);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => sizeSpy.h);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function harness(
  options: Partial<RendererOptions> = {},
  deps: Partial<RendererDeps> = {},
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = new RecordingContext();
  const queue = new Map<number, (t: number) => void>();
  let id = 0;
  const clock = { t: 0 };
  const renderer = createRendererImpl(
    container,
    { theme: darkTheme, pixelRatio: 2, ...options },
    {
      context: ctx,
      surfaceFactory: recordingFactory().factory,
      now: () => clock.t,
      requestFrame: (cb) => {
        queue.set(++id, cb);
        return id;
      },
      cancelFrame: (i) => {
        queue.delete(i);
      },
      ...deps,
    },
  );
  const frame = (dt = 16) => {
    clock.t += dt;
    const pending = [...queue.values()];
    queue.clear();
    for (const cb of pending) cb(clock.t);
  };
  const settle = () => {
    let n = 0;
    while (queue.size > 0 && n < 500) {
      frame();
      n++;
    }
    return n;
  };
  return { renderer, ctx, container, queue, frame, settle, clock };
}

/** happy-dom's WheelEvent ignores MouseEvent fields (ctrlKey, clientX…): define them. */
function wheel(init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, ...init });
  for (const key of ['ctrlKey', 'metaKey', 'clientX', 'clientY'] as const) {
    Object.defineProperty(e, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) });
  }
  return e;
}

const pointer = (type: string, x: number, y: number, o: PointerEventInit = {}) =>
  new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId: 1,
    button: 0,
    pointerType: 'mouse',
    bubbles: true,
    cancelable: true,
    ...o,
  });

describe('createRenderer', () => {
  it('appends a device-pixel canvas to the container', () => {
    const { renderer, container } = harness();
    expect(renderer.canvas.parentElement).toBe(container);
    expect(renderer.canvas.width).toBe(1600);
    expect(renderer.canvas.height).toBe(1200);
    expect(renderer.canvas.style.touchAction).toBe('none');
  });

  it('caps the pixel ratio at 3', () => {
    const { renderer } = harness({ pixelRatio: 5 });
    expect(renderer.canvas.width).toBe(2400);
  });

  it('rejects invalid options and containers with KgdiffError', () => {
    const container = document.createElement('div');
    expect(() =>
      createRendererImpl(container, { theme: darkTheme, minZoom: 2, maxZoom: 1 }),
    ).toThrow(KgdiffError);
    expect(() => createRendererImpl(container, { theme: darkTheme, pixelRatio: 0 })).toThrow(
      KgdiffError,
    );
    expect(() => createRendererImpl(null as unknown as HTMLElement, { theme: darkTheme })).toThrow(
      KgdiffError,
    );
  });
});

describe('frame loop', () => {
  it('paints synchronously on creation and then sleeps', () => {
    const h = harness();
    expect(h.ctx.count('fillRect')).toBeGreaterThan(0);
    h.settle();
    expect(h.queue.size).toBe(0);
  });

  it('setFrame is cheap: it schedules one frame and paints on it', () => {
    const h = harness();
    h.settle();
    const frames: number[] = [];
    h.renderer.on('frame', (e) => frames.push(e.ms));
    h.ctx.clear();
    h.renderer.setFrame(frameOf([node(0, 0)]));
    h.renderer.setFrame(frameOf([node(0, 0)]));
    h.renderer.requestRender();
    expect(h.ctx.ops).toHaveLength(0);
    expect(h.queue.size).toBe(1);
    h.frame();
    expect(frames).toHaveLength(1);
    expect(h.queue.size).toBe(0);
  });

  it('fits the first frame automatically, but not after the camera was used', () => {
    const h = harness();
    h.renderer.setFrame(frameOf([node(0, 0), node(1000, 500)]));
    h.settle();
    const fitted = h.renderer.camera.get();
    expect(fitted.x).toBeCloseTo(500, 6);
    expect(fitted.y).toBeCloseTo(250, 6);
    const h2 = harness();
    h2.renderer.camera.set({ x: 1, y: 2, k: 3 });
    h2.renderer.setFrame(frameOf([node(0, 0), node(1000, 500)]));
    h2.settle();
    expect(h2.renderer.camera.get()).toEqual({ x: 1, y: 2, k: 3 });
  });

  it('runs every frame of a flight, emits one camera event per frame, then sleeps', async () => {
    const h = harness();
    h.renderer.setFrame(frameOf([node(0, 0)]));
    h.settle();
    const cams: number[] = [];
    h.renderer.on('camera', (c) => cams.push(c.k));
    const done = h.renderer.camera.flyTo({ x: 3000, y: 3000, width: 100, height: 100 });
    const frames = h.settle();
    await done;
    expect(frames).toBeGreaterThan(15);
    expect(frames).toBeLessThan(80);
    expect(cams.length).toBeGreaterThanOrEqual(frames - 2);
    expect(h.queue.size).toBe(0);
  });

  it('keeps painting until every label is rasterized, then sleeps', () => {
    const h = harness();
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    const nodes = Array.from({ length: 400 }, (_, i) =>
      node((i % 20) * 40 - 400, Math.floor(i / 20) * 30 - 300, {
        r: 0.5,
        label: {
          text: `n${i}`,
          color: '#fff',
          alpha: 1,
          size: 12,
          weight: 400,
          strike: false,
          priority: 0.5,
          minZoom: 0,
          offset: 5,
        },
      }),
    );
    h.renderer.setFrame(frameOf(nodes));
    let frames = 0;
    h.renderer.on('frame', () => frames++);
    h.settle();
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThan(6);
    expect(h.queue.size).toBe(0);
  });

  it('emits hover once per frame however many moves arrive', () => {
    const h = harness();
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    h.renderer.setFrame(frameOf([node(0, 0), node(100, 0)]));
    h.settle();
    const hovers: (PickResult | null)[] = [];
    h.renderer.on('hover', (p) => hovers.push(p));
    for (let i = 0; i < 10; i++)
      h.renderer.canvas.dispatchEvent(pointer('pointermove', 395 + i, 300));
    h.frame();
    expect(hovers).toEqual([{ type: 'node', index: 0 }]);
    h.renderer.canvas.dispatchEvent(pointer('pointermove', 500, 300));
    h.frame();
    expect(hovers.at(-1)).toEqual({ type: 'node', index: 1 });
    h.renderer.canvas.dispatchEvent(pointer('pointermove', 450, 450));
    h.frame();
    expect(hovers.at(-1)).toBeNull();
    expect(h.renderer.canvas.style.cursor).toBe('');
  });
});

describe('input', () => {
  function ready() {
    const h = harness();
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    const a = node(0, 0);
    const b = node(200, 0);
    h.renderer.setFrame(frameOf([a, b], [edge(a, b)]));
    h.settle();
    return h;
  }

  it('turns a short press into a click with a pick and world point', () => {
    const h = ready();
    const clicks: unknown[] = [];
    h.renderer.on('click', (e) => clicks.push({ pick: e.pick, world: e.world }));
    h.renderer.canvas.dispatchEvent(pointer('pointerdown', 401, 300));
    h.renderer.canvas.dispatchEvent(pointer('pointermove', 403, 301));
    h.renderer.canvas.dispatchEvent(pointer('pointerup', 403, 301));
    expect(clicks).toEqual([{ pick: { type: 'node', index: 0 }, world: { x: 3, y: 1 } }]);
  });

  it('drags to pan (content follows the pointer) without clicking, then glides', () => {
    const h = ready();
    const clicks: unknown[] = [];
    h.renderer.on('click', (e) => clicks.push(e));
    h.renderer.canvas.dispatchEvent(pointer('pointerdown', 300, 300));
    for (let i = 1; i <= 10; i++) {
      h.clock.t += 10;
      h.renderer.canvas.dispatchEvent(pointer('pointermove', 300 + i * 10, 300));
    }
    h.renderer.canvas.dispatchEvent(pointer('pointerup', 400, 300));
    expect(clicks).toHaveLength(0);
    expect(h.renderer.camera.get().x).toBeCloseTo(-100, 9);
    const frames = h.settle();
    expect(frames).toBeGreaterThan(10); // inertia keeps the loop running
    expect(h.renderer.camera.get().x).toBeLessThan(-150);
  });

  it('ctrl + wheel (pinch) zooms keeping the point under the cursor fixed', () => {
    const h = ready();
    const before = h.renderer.camera.screenToWorld({ x: 600, y: 200 });
    h.renderer.canvas.dispatchEvent(
      wheel({ deltaY: -20, ctrlKey: true, clientX: 600, clientY: 200 }),
    );
    expect(h.renderer.camera.get().k).toBeCloseTo(Math.exp(0.2), 9);
    const after = h.renderer.camera.screenToWorld({ x: 600, y: 200 });
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('mouse-wheel notches zoom smoothly at the cursor', () => {
    const h = ready();
    h.renderer.canvas.dispatchEvent(wheel({ deltaY: -100, clientX: 200, clientY: 100 }));
    expect(h.renderer.camera.get().k).toBe(1); // animated, not applied yet
    h.settle();
    expect(h.renderer.camera.get().k).toBeCloseTo(2 ** (100 / 240), 6);
  });

  it('two-finger trackpad scroll pans', () => {
    const h = ready();
    h.renderer.canvas.dispatchEvent(wheel({ deltaX: 30, deltaY: 10, clientX: 200, clientY: 100 }));
    expect(h.renderer.camera.get()).toEqual({ x: 30, y: 10, k: 1 });
  });

  it('pinches with two touch pointers', () => {
    const h = ready();
    const t = (type: string, id: number, x: number) =>
      pointer(type, x, 300, { pointerId: id, pointerType: 'touch' });
    h.renderer.canvas.dispatchEvent(t('pointerdown', 1, 300));
    h.renderer.canvas.dispatchEvent(t('pointerdown', 2, 500));
    h.renderer.canvas.dispatchEvent(t('pointermove', 2, 700));
    expect(h.renderer.camera.get().k).toBeCloseTo(2, 9);
    const clicks: unknown[] = [];
    h.renderer.on('click', (e) => clicks.push(e));
    h.renderer.canvas.dispatchEvent(t('pointerup', 2, 700));
    h.renderer.canvas.dispatchEvent(t('pointerup', 1, 300));
    expect(clicks).toHaveLength(0);
  });

  it('emits dblclick with a pick', () => {
    const h = ready();
    const picks: (PickResult | null)[] = [];
    h.renderer.on('dblclick', (e) => picks.push(e.pick));
    h.renderer.canvas.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 500, clientY: 300, bubbles: true }),
    );
    expect(picks).toEqual([{ type: 'edge', index: 0 }]);
  });

  it('does not listen when not interactive', () => {
    const h = harness({ interactive: false });
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    h.renderer.canvas.dispatchEvent(wheel({ deltaX: 30 }));
    expect(h.renderer.camera.get().x).toBe(0);
  });
});

describe('picking through the renderer', () => {
  it('picks on the matching side of a split frame', () => {
    const h = harness();
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    const before = frameOf([node(-300, 0)]);
    const after = frameOf([node(-300, 0, { visible: false }), node(300, 0)]);
    h.renderer.setFrame({ split: 0.5, before, after });
    expect(h.renderer.pick(100, 300)).toEqual({ type: 'node', index: 0 });
    expect(h.renderer.pick(700, 300)).toEqual({ type: 'node', index: 1 });
    expect(h.renderer.pick(Number.NaN, 0)).toBeNull();
  });
});

describe('collapsed pills and picking', () => {
  it('does not pick a pill hidden by collision, but does once it is shown', () => {
    const h = harness();
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    h.renderer.setFrame(
      frameOf([], [], {
        collapsed: [
          { id: 'a', x: 0, y: 0, count: 38, nodes: [], label: '' },
          { id: 'b', x: 20, y: 0, count: 38, nodes: [], label: '' },
        ],
      }),
    );
    h.settle();
    // x = 435 is inside pill b only (a spans 382…418, b spans 402…438): b is hidden.
    expect(h.renderer.pick(435, 300)).toBeNull();
    expect(h.renderer.pick(400, 300)).toEqual({ type: 'collapsed', index: 0 });
    h.renderer.camera.set({ x: 0, y: 0, k: 4 });
    h.settle();
    // b is now at x = 480 and shown.
    expect(h.renderer.pick(480, 300)).toEqual({ type: 'collapsed', index: 1 });
  });
});

describe('camera event source', () => {
  function track(h: Harness): string[] {
    const sources: string[] = [];
    h.renderer.on('camera', (c) => sources.push(c.source));
    return sources;
  }

  it('reports API calls as program', async () => {
    const h = harness();
    h.renderer.setFrame(frameOf([node(0, 0), node(500, 300)]));
    h.settle();
    const sources = track(h);
    h.renderer.camera.set({ x: 10, y: 10, k: 1 });
    h.frame();
    h.renderer.camera.panBy(30, 0);
    h.frame();
    h.renderer.camera.zoomBy(2);
    h.settle();
    const flight = h.renderer.camera.flyTo({ x: 2000, y: 0, width: 100, height: 100 });
    h.settle();
    await flight;
    await h.renderer.camera.fit(undefined, { animate: false });
    h.frame();
    expect(sources.length).toBeGreaterThan(5);
    expect(new Set(sources)).toEqual(new Set(['program']));
  });

  it('reports drags, wheel zoom and inertia as user', () => {
    const h = harness();
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    h.settle();
    const sources = track(h);
    h.renderer.canvas.dispatchEvent(pointer('pointerdown', 300, 300));
    for (let i = 1; i <= 10; i++) {
      h.clock.t += 10;
      h.renderer.canvas.dispatchEvent(pointer('pointermove', 300 + i * 10, 300));
    }
    h.renderer.canvas.dispatchEvent(pointer('pointerup', 400, 300));
    const frames = h.settle(); // inertia
    expect(frames).toBeGreaterThan(5);
    h.renderer.canvas.dispatchEvent(wheel({ deltaY: -100, clientX: 200, clientY: 100 }));
    h.settle();
    h.renderer.canvas.dispatchEvent(
      wheel({ deltaY: -10, ctrlKey: true, clientX: 200, clientY: 100 }),
    );
    h.frame();
    expect(sources.length).toBeGreaterThan(frames);
    expect(new Set(sources)).toEqual(new Set(['user']));
  });

  it('reports user when input and an API call land in the same frame', () => {
    const h = harness();
    h.renderer.camera.set({ x: 0, y: 0, k: 1 });
    h.settle();
    const sources = track(h);
    h.renderer.camera.panBy(5, 0);
    h.renderer.canvas.dispatchEvent(wheel({ deltaX: 30, deltaY: 0, clientX: 200, clientY: 100 }));
    h.frame();
    expect(sources).toEqual(['user']);
  });

  it('reports resizes as program', () => {
    const h = harness();
    h.settle();
    const sources = track(h);
    sizeSpy.w = 500;
    h.renderer.resize();
    expect(sources).toEqual(['program']);
  });
});

describe('theme, export and teardown', () => {
  it('repaints on theme change', () => {
    const h = harness();
    h.settle();
    h.ctx.clear();
    h.renderer.setTheme(lightTheme);
    h.settle();
    expect(h.ctx.calls('fillRect')[0]!.style.fillStyle).toBe(lightTheme.canvas.background);
  });

  it('exports a PNG data URL', () => {
    const h = harness();
    expect(typeof h.renderer.toDataURL()).toBe('string');
  });

  it('destroy removes the canvas, cancels the loop and silences everything', () => {
    const h = harness();
    const hovers: unknown[] = [];
    h.renderer.on('hover', (p) => hovers.push(p));
    h.renderer.setFrame(frameOf([node(0, 0)]));
    expect(h.queue.size).toBe(1);
    h.renderer.destroy();
    expect(h.queue.size).toBe(0);
    expect(h.container.contains(h.renderer.canvas)).toBe(false);
    h.renderer.setFrame(frameOf([node(0, 0)]));
    h.renderer.requestRender();
    expect(h.queue.size).toBe(0);
    h.renderer.canvas.dispatchEvent(pointer('pointermove', 400, 300));
    h.settle();
    expect(hovers).toHaveLength(0);
    h.renderer.destroy(); // idempotent
  });

  it('resolves a running flight on destroy', async () => {
    const h = harness();
    const p = h.renderer.camera.flyTo({ x: 5000, y: 0, width: 10, height: 10 });
    h.frame();
    h.renderer.destroy();
    await expect(p).resolves.toBeUndefined();
  });

  it('re-measures on resize()', () => {
    const h = harness();
    sizeSpy.w = 400;
    h.renderer.resize();
    expect(h.renderer.canvas.width).toBe(800);
    expect(h.renderer.camera.viewport().width).toBeCloseTo(400 / h.renderer.camera.get().k, 9);
  });
});

describe('backing store and the device-pixel box', () => {
  type Box = readonly [number, number];
  let observed: ((entries: ResizeObserverEntry[]) => void) | null;

  beforeEach(() => {
    observed = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (entries: ResizeObserverEntry[]) => void) {
          observed = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A renderer at the window's pixel ratio, told its size by the ResizeObserver. */
  function observedAt(ratio: number, css: Box, device: Box | null): Harness {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(ratio);
    [sizeSpy.w, sizeSpy.h] = css;
    const h = harness({ pixelRatio: undefined });
    h.renderer.setFrame(frameOf([node(0, 0), node(1000, 500)]));
    h.settle();
    h.ctx.clear();
    const size = (box: Box) => [{ inlineSize: box[0], blockSize: box[1] }];
    observed?.([
      {
        contentBoxSize: size(css),
        ...(device ? { devicePixelContentBoxSize: size(device) } : {}),
      } as unknown as ResizeObserverEntry,
    ]);
    return h;
  }

  /** The scale of the frame's first transform: what the painter multiplies CSS pixels by. */
  const paintScale = (h: Harness): unknown => h.ctx.calls('setTransform')[0]?.args[0];

  // Chromium leaves the box in CSS pixels under an emulated device scale factor (Playwright's
  // `deviceScaleFactor`): a backing store of that size held only the top-left corner of a frame
  // painted at the window's ratio (RFC 0002, section 11).
  it.each([2, 3])('holds the whole frame under an emulated scale factor of %d', (ratio) => {
    const h = observedAt(ratio, [800, 600], [800, 600]);
    expect(paintScale(h)).toBe(ratio);
    expect(h.renderer.canvas.width).toBe(800 * ratio);
    expect(h.renderer.canvas.height).toBe(600 * ratio);
    // The canvas centre is the camera's centre, on screen and in the backing store.
    const { x, y } = h.renderer.camera.get();
    const centre = h.renderer.camera.worldToScreen({ x, y });
    expect(centre.x * ratio).toBeCloseTo(h.renderer.canvas.width / 2, 9);
    expect(centre.y * ratio).toBeCloseTo(h.renderer.canvas.height / 2, 9);
  });

  it('holds the whole frame under a CSS zoom, which the box includes', () => {
    const h = observedAt(1, [800, 600], [1600, 1200]);
    expect(paintScale(h)).toBe(1);
    expect(h.renderer.canvas.width).toBe(800);
    expect(h.renderer.canvas.height).toBe(600);
  });

  it('takes the box when it is the CSS size snapped to device pixels', () => {
    // 800.4 × 2 = 1600.8 rounds to 1601; the browser snapped the box to 1600.
    const h = observedAt(2, [800.4, 600], [1600, 1200]);
    expect(paintScale(h)).toBe(2);
    expect(h.renderer.canvas.width).toBe(1600);
    expect(h.renderer.canvas.height).toBe(1200);
  });

  it('sizes by the pixel ratio where the box is not reported', () => {
    const h = observedAt(2, [800.4, 600], null);
    expect(h.renderer.canvas.width).toBe(1601);
    expect(h.renderer.canvas.height).toBe(1200);
  });
});
