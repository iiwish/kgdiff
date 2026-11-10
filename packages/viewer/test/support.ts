/**
 * Test helpers: a recording renderer backend (happy-dom has no canvas), small fixture graphs
 * and a manually driven controller environment.
 */
import type { GraphInput, Point, Rect } from '@kgdiff/core';
import type {
  Camera,
  CameraState,
  CameraTransitionOptions,
  Minimap,
  PickResult,
  Renderer,
  RendererEvents,
  RendererLayer,
  RendererOptions,
  SplitFrame,
} from '@kgdiff/renderer';
import type { FrameVisuals, Theme } from '@kgdiff/scene';
import type { ControllerDeps, ControllerHost } from '../src/controller.js';
import { frameTarget } from '../src/framing.js';
import type { RenderBackend } from '../src/renderer-port.js';
import type { StorageLike } from '../src/review-store.js';

export const VIEWPORT = { width: 800, height: 600 };

export class MockCamera implements Camera {
  state: CameraState = { x: 0, y: 0, k: 1 };
  readonly flights: Rect[] = [];
  readonly flightOptions: (CameraTransitionOptions | undefined)[] = [];
  fits = 0;
  readonly fitCalls: { bounds?: Rect; options?: CameraTransitionOptions }[] = [];
  zooms: number[] = [];
  get(): CameraState {
    return this.state;
  }
  set(state: CameraState): void {
    this.state = state;
  }
  /** Lands where the renderer would: `bounds` fitted into the viewport minus `padding`. */
  #land(bounds: Rect, options?: CameraTransitionOptions): void {
    const p = options?.padding;
    const insets = typeof p === 'object' ? p : { top: 48, right: 48, bottom: 48, left: 48 };
    const maxK = options?.maxZoom ?? 2.5;
    this.state = frameTarget(bounds, VIEWPORT.width, VIEWPORT.height, insets, 0.05, maxK);
  }
  flyTo(bounds: Rect, options?: CameraTransitionOptions): Promise<void> {
    this.flights.push(bounds);
    this.flightOptions.push(options);
    this.#land(bounds, options);
    return Promise.resolve();
  }
  fit(bounds?: Rect, options?: CameraTransitionOptions): Promise<void> {
    this.fits++;
    this.fitCalls.push({ ...(bounds ? { bounds } : {}), ...(options ? { options } : {}) });
    if (bounds) this.#land(bounds, options);
    return Promise.resolve();
  }
  zoomBy(factor: number): void {
    this.zooms.push(factor);
    this.state = { ...this.state, k: this.state.k * factor };
  }
  panBy(dx: number, dy: number): void {
    this.state = {
      ...this.state,
      x: this.state.x - dx / this.state.k,
      y: this.state.y - dy / this.state.k,
    };
  }
  worldToScreen(p: Point): Point {
    const s = this.state;
    return {
      x: (p.x - s.x) * s.k + VIEWPORT.width / 2,
      y: (p.y - s.y) * s.k + VIEWPORT.height / 2,
    };
  }
  screenToWorld(p: Point): Point {
    const s = this.state;
    return {
      x: (p.x - VIEWPORT.width / 2) / s.k + s.x,
      y: (p.y - VIEWPORT.height / 2) / s.k + s.y,
    };
  }
  viewport(): Rect {
    const s = this.state;
    const w = VIEWPORT.width / s.k;
    const h = VIEWPORT.height / s.k;
    return { x: s.x - w / 2, y: s.y - h / 2, width: w, height: h };
  }
}

type Listeners = { [K in keyof RendererEvents]: Set<(e: RendererEvents[K]) => void> };

export class MockRenderer implements Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly camera = new MockCamera();
  frame: FrameVisuals | SplitFrame | null = null;
  frameCount = 0;
  theme: Theme;
  safeArea: { top: number; right: number; bottom: number; left: number } | null = null;
  labelsInside: boolean;
  destroyed = false;
  readonly layers: RendererLayer[] = [];
  private readonly listeners: Listeners = {
    hover: new Set(),
    click: new Set(),
    dblclick: new Set(),
    camera: new Set(),
    frame: new Set(),
  };

  constructor(container: HTMLElement, options: RendererOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);
    this.theme = options.theme;
    this.labelsInside = options.labelsInside ?? false;
  }
  setFrame(frame: FrameVisuals | SplitFrame): void {
    this.frame = frame;
    this.frameCount++;
  }
  setTheme(theme: Theme): void {
    this.theme = theme;
  }
  setSafeArea(area: { top: number; right: number; bottom: number; left: number }): void {
    this.safeArea = area;
  }
  setLabelsInside(inside: boolean): void {
    this.labelsInside = inside;
  }
  pick(): PickResult | null {
    return null;
  }
  addLayer(layer: RendererLayer): () => void {
    this.layers.push(layer);
    return () => {
      const at = this.layers.indexOf(layer);
      if (at >= 0) this.layers.splice(at, 1);
    };
  }
  on<K extends keyof RendererEvents>(
    type: K,
    listener: (e: RendererEvents[K]) => void,
  ): () => void {
    const set = this.listeners[type] as Set<(e: RendererEvents[K]) => void>;
    set.add(listener);
    return () => set.delete(listener);
  }
  emit<K extends keyof RendererEvents>(type: K, event: RendererEvents[K]): void {
    for (const fn of this.listeners[type] as Set<(e: RendererEvents[K]) => void>) fn(event);
  }
  click(pick: PickResult | null): void {
    this.emit('click', { pick, world: { x: 0, y: 0 }, event: new MouseEvent('click') });
  }
  resize(): void {}
  requestRender(): void {}
  toDataURL(): string {
    return '';
  }
  destroy(): void {
    this.destroyed = true;
    this.layers.length = 0;
    this.canvas.remove();
  }
}

export class MockMinimap implements Minimap {
  readonly canvas = document.createElement('canvas');
  updates = 0;
  update(): void {
    this.updates++;
  }
  destroy(): void {}
}

export function mockBackend(): RenderBackend & {
  readonly renderers: MockRenderer[];
  readonly minimaps: MockMinimap[];
  last(): MockRenderer;
} {
  const renderers: MockRenderer[] = [];
  const minimaps: MockMinimap[] = [];
  return {
    renderers,
    minimaps,
    createRenderer(container, options) {
      const r = new MockRenderer(container, options);
      renderers.push(r);
      return r;
    },
    createMinimap() {
      const m = new MockMinimap();
      minimaps.push(m);
      return m;
    },
    last() {
      const r = renderers[renderers.length - 1];
      if (!r) throw new Error('no renderer created');
      return r;
    },
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A small taxonomy: rename (Cat → Kitty), attribute edit (Dog), removal (Eagle), addition
 * (Gecko), hierarchy move (Fish under Bird).
 */
export function zoo(): { before: GraphInput; after: GraphInput } {
  const isA = (source: string, target: string) => ({ source, target, predicate: 'is_a' });
  return {
    before: {
      meta: { name: 'Zoo', version: 'v1' },
      nodes: [
        { id: 'A', label: 'Animal' },
        { id: 'B', label: 'Bird' },
        { id: 'C', label: 'Cat' },
        { id: 'D', label: 'Dog', attrs: { legs: 4, sound: 'woof woof' } },
        { id: 'E', label: 'Eagle' },
        { id: 'F', label: 'Fish' },
      ],
      edges: [isA('B', 'A'), isA('C', 'A'), isA('D', 'A'), isA('E', 'B'), isA('F', 'A')],
    },
    after: {
      meta: { name: 'Zoo', version: 'v2' },
      nodes: [
        { id: 'A', label: 'Animal' },
        { id: 'B', label: 'Bird' },
        { id: 'C', label: 'Kitty' },
        { id: 'D', label: 'Dog', attrs: { legs: 4, sound: 'loud woof' } },
        { id: 'F', label: 'Fish' },
        { id: 'G', label: 'Gecko' },
      ],
      edges: [isA('B', 'A'), isA('C', 'A'), isA('D', 'A'), isA('F', 'B'), isA('G', 'A')],
    },
  };
}

/** A hub with `leaves` unchanged neighbours and one changed neighbour (renamed X). */
export function hub(leaves = 10): { before: GraphInput; after: GraphInput } {
  const nodes = [{ id: 'H', label: 'Hub' }];
  const edges = [];
  for (let i = 0; i < leaves; i++) {
    nodes.push({ id: `L${i}`, label: `Leaf ${i}` });
    edges.push({ source: `L${i}`, target: 'H', predicate: 'part_of' });
  }
  edges.push({ source: 'X', target: 'H', predicate: 'part_of' });
  return {
    before: { nodes: [...nodes, { id: 'X', label: 'Before' }], edges },
    after: { nodes: [...nodes, { id: 'X', label: 'After' }], edges },
  };
}

// ─── Manual environment ─────────────────────────────────────────────────────

export class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Deterministic deps: a manual clock and frame queue. */
export function manualDeps(storage: StorageLike | null = new MemoryStorage()): ControllerDeps & {
  time: number;
  frames: Map<number, (t: number) => void>;
  /** Run the pending animation frames after advancing time by `dt`. */
  frame(dt?: number): void;
  /** Advance in `step`-ms frames until nothing is scheduled or `max` ms passed. */
  run(max: number, step?: number): void;
} {
  let id = 0;
  const env = {
    time: 1000,
    frames: new Map<number, (t: number) => void>(),
    storage,
    now: () => env.time,
    requestFrame: (cb: (t: number) => void) => {
      id++;
      env.frames.set(id, cb);
      return id;
    },
    cancelFrame: (n: number) => {
      env.frames.delete(n);
    },
    yieldToPaint: () => Promise.resolve(),
    frame(dt = 16) {
      env.time += dt;
      const due = [...env.frames.values()];
      env.frames.clear();
      for (const cb of due) cb(env.time);
    },
    run(max: number, step = 16) {
      let t = 0;
      while (env.frames.size > 0 && t < max) {
        env.frame(step);
        t += step;
      }
    },
  };
  return env;
}

export interface RecordedHost extends ControllerHost {
  readonly events: { type: string; detail: unknown }[];
  readonly announcements: string[];
}

export function recordingHost(): RecordedHost {
  const events: { type: string; detail: unknown }[] = [];
  const announcements: string[] = [];
  return {
    events,
    announcements,
    ready: (stats) => events.push({ type: 'ready', detail: stats }),
    select: (hunk, node) => events.push({ type: 'select', detail: { hunk, node } }),
    mode: (mode, scope) => events.push({ type: 'mode', detail: { mode, scope } }),
    review: (hunk, reviewed, progress) =>
      events.push({ type: 'review', detail: { hunk, reviewed, progress } }),
    error: (error) => events.push({ type: 'error', detail: error }),
    announce: (text) => announcements.push(text),
    replayEnd: (loop) => events.push({ type: 'replay-end', detail: { loop } }),
  };
}

/** Resolve after pending microtasks and a macrotask. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` holds (polling every few ms), or fail after `timeout` ms. */
export async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('until(): timed out');
    await tick(5);
  }
}
