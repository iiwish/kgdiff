/**
 * Controller logic against a recording fake of G6's Graph (the `GraphLike` subset).
 */
import type {
  AnimationEffectTiming,
  EdgeData,
  FitViewOptions,
  GraphData,
  GraphOptions,
  ID,
  IEvent,
  NodeData,
  Point,
  ViewportAnimationEffectTiming,
} from '@antv/g6';
import { KgdiffError } from '@kgdiff/core';
import { getTheme, type Scene } from '@kgdiff/scene';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_PLUGIN_KEY, HOVER_BEHAVIOR_KEY, HOVER_STATE } from '../src/constants.js';
import {
  type ControllerOptions,
  DiffGraphControllerImpl,
  type GraphLike,
} from '../src/controller.js';
import { kgdiffData } from '../src/map.js';
import { datasetScene } from './support/scene.js';

type Handler = (event: IEvent) => void;

class FakeGraph implements GraphLike {
  destroyed = false;
  readonly log: string[] = [];
  /** Current data, merged like G6 does (`updateData` merges styles into stored ones). */
  readonly nodes = new Map<ID, NodeData>();
  readonly edges = new Map<ID, EdgeData>();
  /** Every update datum received, in order (partial styles). */
  readonly updates: (NodeData | EdgeData)[] = [];
  draws = 0;
  readonly animations: (boolean | AnimationEffectTiming | undefined)[] = [];
  readonly focused: { ids: ID[]; animation: ViewportAnimationEffectTiming | undefined }[] = [];
  readonly plugins: Record<string, unknown>[] = [];
  readonly handlers = new Map<string, Set<Handler>>();
  zoom = 1;
  /** Canvas point at the viewport's top-left corner (the fake pans by moving it). */
  origin: [number, number] = [-400, -300];
  private held: (() => void)[] = [];
  hold = false;
  /** When set, focusElement never settles (like G6 when destroyed mid-animation). */
  holdFocus = false;

  constructor(readonly init: GraphOptions) {
    this.addData(init.data ?? {});
  }
  get data(): GraphData {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
  addData(data: GraphData): void {
    this.log.push('add');
    for (const n of data.nodes ?? []) {
      if (this.nodes.has(n.id) || this.edges.has(n.id)) throw new Error(`duplicate ${n.id}`);
      this.nodes.set(n.id, n);
    }
    for (const e of data.edges ?? []) {
      const id = e.id as ID;
      if (this.nodes.has(id) || this.edges.has(id)) throw new Error(`duplicate ${id}`);
      if (!this.nodes.has(e.source) || !this.nodes.has(e.target)) throw new Error(`dangling ${id}`);
      this.edges.set(id, e);
    }
  }
  updateData(data: GraphData): void {
    this.log.push('update');
    const merge = <T extends NodeData | EdgeData>(old: T | undefined, patch: T): T => {
      if (old === undefined) throw new Error(`update of unknown ${String(patch.id)}`);
      this.updates.push(patch);
      return {
        ...old,
        ...patch,
        style: { ...old.style, ...patch.style },
        data: { ...old.data, ...patch.data },
      };
    };
    for (const n of data.nodes ?? []) this.nodes.set(n.id, merge(this.nodes.get(n.id), n));
    for (const e of data.edges ?? []) {
      const id = e.id as ID;
      if (!this.nodes.has(e.source) || !this.nodes.has(e.target)) throw new Error(`dangling ${id}`);
      this.edges.set(id, merge(this.edges.get(id), e));
    }
  }
  removeData(ids: { nodes?: ID[]; edges?: ID[] }): void {
    this.log.push('remove');
    for (const id of ids.edges ?? []) this.edges.delete(id);
    for (const id of ids.nodes ?? []) {
      this.nodes.delete(id);
      for (const [eid, e] of this.edges)
        if (e.source === id || e.target === id) this.edges.delete(eid);
    }
  }
  async render(): Promise<void> {
    this.log.push('render');
  }
  draw(): Promise<void> {
    this.log.push('draw');
    this.draws++;
    if (!this.hold) return Promise.resolve();
    return new Promise((resolve) => this.held.push(resolve));
  }
  release(): void {
    for (const r of this.held.splice(0)) r();
  }
  setOptions(options: GraphOptions): void {
    this.animations.push(options.animation);
  }
  async fitView(_o?: FitViewOptions, animation?: ViewportAnimationEffectTiming): Promise<void> {
    this.log.push(`fitView:${String(animation)}`);
  }
  focusElement(id: ID | ID[], animation?: ViewportAnimationEffectTiming): Promise<void> {
    this.focused.push({ ids: Array.isArray(id) ? id : [id], animation });
    return this.holdFocus ? new Promise(() => {}) : Promise.resolve();
  }
  getZoom(): number {
    return this.zoom;
  }
  getSize(): [number, number] {
    return [800, 600];
  }
  getCanvasByViewport(point: Point): Point {
    return [
      this.origin[0] + (point[0] as number) / this.zoom,
      this.origin[1] + (point[1] as number) / this.zoom,
    ];
  }
  updatePlugin(plugin: { key: string; [key: string]: unknown }): void {
    this.plugins.push(plugin);
  }
  on(name: string, handler: Handler): void {
    const set = this.handlers.get(name) ?? new Set<Handler>();
    this.handlers.set(name, set);
    set.add(handler);
  }
  off(name: string, handler: Handler): void {
    this.handlers.get(name)?.delete(handler);
  }
  emit(name: string, event: unknown = {}): void {
    for (const h of this.handlers.get(name) ?? []) h(event as IEvent);
  }
  destroy(): void {
    this.destroyed = true;
    this.log.push('destroy');
  }
  node(id: string): NodeData {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error(`node ${id} not in data`);
    return n;
  }
  has(id: string): boolean {
    return this.nodes.has(id) || this.edges.has(id);
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let live: DiffGraphControllerImpl<FakeGraph>[] = [];
afterEach(() => {
  for (const c of live) c.destroy();
  live = [];
  deadlines.length = 0;
});

/** Draw deadlines handed out by the controller; tests fire them explicitly. */
const deadlines: { ms: number; fire: () => void }[] = [];

async function setup(
  options: ControllerOptions = {},
  scene: Scene = datasetScene(),
): Promise<{ c: DiffGraphControllerImpl<FakeGraph>; g: FakeGraph; waits: number[]; scene: Scene }> {
  const waits: number[] = [];
  const c = new DiffGraphControllerImpl(scene, options, {
    createGraph: (o) => new FakeGraph(o),
    wait: async (ms) => {
      waits.push(ms);
    },
    deadline: (ms) =>
      new Promise((resolve) => {
        deadlines.push({ ms, fire: resolve });
      }),
  });
  live.push(c);
  await c.start('stage');
  return { c, g: c.graph, waits, scene };
}

/** Node styles by id (G6 keeps insertion order, which differs after removals and re-adds). */
function stylesById(g: FakeGraph): [string, unknown][] {
  return [...g.nodes.values()]
    .map((n): [string, unknown] => [String(n.id), n.style])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sceneNodeIds(data: GraphData): string[] {
  return (data.nodes ?? [])
    .filter((n) => kgdiffData(n.data)?.kgdiff === 'node')
    .map((n) => String(n.id));
}

describe('start', () => {
  it('creates the graph from generated + user options, renders and fits the view', async () => {
    const { g, scene } = await setup({ g6: { width: 640, behaviors: ['brush-select'] } });
    expect(g.init).toMatchObject({
      container: 'stage',
      theme: false,
      width: 640,
      animation: false,
    });
    expect(g.init.behaviors?.at(-1)).toBe('brush-select');
    expect(sceneNodeIds(g.data)).toHaveLength(scene.nodes.length);
    expect(g.log).toEqual(['add', 'render', 'fitView:false']);
    expect(g.handlers.get('aftertransform')?.size).toBe(1);
    expect(g.handlers.get('node:click')?.size).toBe(1);
  });

  it('binds no click handlers when not interactive', async () => {
    const { g } = await setup({ interactive: false });
    expect(g.init.behaviors).toEqual([]);
    expect(g.handlers.has('node:click')).toBe(false);
  });

  it('starts from the given view', async () => {
    const { g, scene } = await setup({ view: { layer: 'after' } });
    const after = scene.nodes.filter((n) => n.presentAfter).length;
    expect(sceneNodeIds(g.data)).toHaveLength(after);
  });
});

describe('setLayer', () => {
  it('maps the layer and animates it with the theme motion', async () => {
    const { c, g, scene } = await setup();
    await c.setLayer('before');
    expect(sceneNodeIds(g.data)).toHaveLength(scene.nodes.filter((n) => n.presentBefore).length);
    expect(g.animations.at(-1)).toEqual({
      duration: scene.theme.motion.base,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    });
    expect(g.log.at(-1)).toBe('draw');
    expect(g.log).toContain('remove');
  });

  it('rejects anything but union / before / after', async () => {
    const { c } = await setup();
    await expect(c.setLayer('replay' as 'union')).rejects.toBeInstanceOf(KgdiffError);
  });

  it('turns every animation off when the G6 options say so', async () => {
    const { c, g } = await setup({ g6: { animation: false } });
    await c.setLayer('after');
    expect(g.animations.every((a) => a === false)).toBe(true);
  });

  it('sends G6 only the elements that changed, with only their changed keys', async () => {
    const { c, g } = await setup();
    await c.setLayer('union');
    expect(g.draws).toBe(0); // nothing changed: no patch, no draw
    await c.setLayer('after');
    expect(g.updates.length).toBeGreaterThan(0);
    expect(g.updates.length).toBeLessThan(g.nodes.size + g.edges.size);
    for (const u of g.updates) {
      const keys = Object.keys(u.style ?? {});
      expect(keys.length).toBeLessThan(20);
      // Edges always carry their zIndex, or G6 would recompute it from their endpoints.
      if ('source' in u) expect(keys).toContain('zIndex');
    }
    // The merged result equals a fresh mapping of the same view.
    const fresh = await setup({ view: { layer: 'after' } });
    expect(stylesById(g)).toEqual(stylesById(fresh.g));
  });
});

describe('selection', () => {
  it('spotlights the hunk and pans to its drawn nodes', async () => {
    const { c, g, scene } = await setup();
    const h = scene.hunks.findIndex((x) => x.nodes.length > 0);
    await c.selectHunk(h);
    const hunk = scene.hunks[h];
    const inHunk = new Set(hunk?.nodes.map((i) => scene.nodes[i]?.id));
    const rest = (g.data.nodes ?? []).filter(
      (n) => kgdiffData(n.data)?.kgdiff === 'node' && !inHunk.has(String(n.id)),
    );
    expect(rest.some((n) => (n.style?.opacity as number) < 0.5)).toBe(true);
    const last = g.focused.at(-1);
    expect(last?.ids.length).toBeGreaterThan(0);
    for (const id of last?.ids ?? []) expect(inHunk.has(String(id))).toBe(true);
    expect(last?.animation).toEqual({
      duration: scene.theme.motion.slow,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    });
    await c.selectHunk(-1);
    expect(g.focused).toHaveLength(1);
    expect((g.data.nodes ?? []).every((n) => (n.style?.opacity as number) > 0.5)).toBe(true);
  });

  it('cuts instead of flying with reduced motion', async () => {
    const { c, g, scene } = await setup({ view: { reducedMotion: true } });
    await c.selectHunk(scene.hunks.findIndex((x) => x.nodes.length > 0));
    expect(g.focused.at(-1)?.animation).toBe(false);
  });

  it('rejects indices outside [-1, hunks)', async () => {
    const { c, scene } = await setup();
    for (const bad of [-2, 0.5, scene.hunks.length, Number.NaN]) {
      await expect(c.selectHunk(bad)).rejects.toBeInstanceOf(KgdiffError);
    }
  });

  it('selects the hunk of a clicked change, an unchanged node itself, and clears on canvas', async () => {
    const { g, scene } = await setup();
    const changed = scene.nodes.find((n) => n.hunk >= 0);
    const plain = scene.nodes.find((n) => n.hunk < 0);
    if (changed === undefined || plain === undefined) throw new Error('fixture');
    g.emit('node:click', { target: { id: changed.id } } as unknown as IEvent);
    await settle();
    expect(g.focused).toHaveLength(1);
    g.emit('node:click', { target: { id: plain.id } } as unknown as IEvent);
    await settle();
    // An unchanged node is picked: accent ring, no spotlight.
    expect(g.node(plain.id).style).toMatchObject({
      ring: true,
      ringStroke: scene.theme.accent.base,
    });
    g.emit('canvas:click');
    await settle();
    expect(g.node(plain.id).style?.ringStroke).not.toBe(scene.theme.accent.base);
    const draws = g.draws;
    g.emit('canvas:click');
    g.emit('node:click', { target: { id: 'nope' } } as unknown as IEvent);
    await settle();
    expect(g.draws).toBe(draws);
  });

  it('selects the hunk of a clicked changed edge', async () => {
    const { g, scene } = await setup();
    const e = scene.edges.find((x) => x.hunk >= 0 && g.has(x.id));
    if (e === undefined) throw new Error('fixture');
    g.emit('edge:click', { target: { id: e.id } } as unknown as IEvent);
    await settle();
    expect(g.animations.at(-1)).toMatchObject({ duration: scene.theme.motion.base });
    expect(g.draws).toBeGreaterThan(0);
  });
});

describe('hover', () => {
  it('lets the hover behavior activate kgdiff elements only', async () => {
    const { g, scene } = await setup();
    const hover = (g.init.behaviors ?? []).find(
      (b): b is { type: string; key: string; enable: (e: IEvent) => boolean } =>
        typeof b === 'object' && (b as { key?: string }).key === HOVER_BEHAVIOR_KEY,
    );
    const target = (id: string): IEvent => ({ target: { id } }) as unknown as IEvent;
    expect(hover?.enable(target(String(scene.nodes[0]?.id)))).toBe(true);
    expect(hover?.enable(target('unknown'))).toBe(false);
    expect(hover?.enable({} as IEvent)).toBe(false);
  });

  it('styles hovered nodes with the current theme', async () => {
    const { c, g, scene } = await setup();
    const state = g.init.node?.state?.[HOVER_STATE] as (d: NodeData) => Record<string, unknown>;
    const changed = (g.data.nodes ?? []).find((n) => kgdiffData(n.data)?.family === 'added');
    if (changed === undefined) throw new Error('fixture');
    expect(state(changed).stroke).toBe(scene.theme.family.added.strong);
    await c.setTheme(getTheme('light'));
    expect(state(changed).stroke).toBe(getTheme('light').family.added.strong);
  });
});

describe('level of detail', () => {
  it('re-maps without animation when the zoom crosses a threshold', async () => {
    const { g } = await setup();
    const withBadge = (): number =>
      (g.data.nodes ?? []).filter((n) => n.style?.badge === true).length;
    expect(withBadge()).toBe(0);
    const draws = g.draws;
    g.zoom = 1.05; // no threshold between 1 and 1.05
    g.emit('aftertransform');
    await settle();
    expect(g.draws).toBe(draws);
    g.zoom = 1.5;
    g.emit('aftertransform');
    g.emit('aftertransform');
    await settle();
    expect(g.draws).toBe(draws + 1);
    expect(g.animations.at(-1)).toBe(false);
    expect(withBadge()).toBeGreaterThan(0);
  });
});

describe('replay', () => {
  it('plays every window to the after state, paced by the timeline at the given speed', async () => {
    const { c, g, waits, scene } = await setup();
    await c.playReplay({ speed: 4 });
    const total = waits.reduce((a, b) => a + b, 0);
    const lastEnd = Math.max(...scene.timeline.windows.map((w) => w.end));
    expect(total).toBeCloseTo(lastEnd / 4, 6);
    const stepDurations = g.animations.map((a) =>
      a === false || a === true || a === undefined ? 0 : (a.duration ?? 0),
    );
    // First draw: morph into the before state over motion.base; then one draw per step.
    expect(stepDurations[0]).toBe(scene.theme.motion.base);
    expect(stepDurations.slice(1).reduce((a, b) => a + b, 0)).toBeCloseTo(lastEnd / 4, 6);
    const after = scene.nodes.filter((n) => n.presentAfter).map((n) => n.id);
    expect(sceneNodeIds(g.data).sort()).toEqual([...after].sort());
  });

  it('folds steps too short to see into the next one', async () => {
    const { c, waits } = await setup();
    await c.playReplay({ speed: 1e4 });
    for (const w of waits.slice(0, -1)) expect(w).toBeGreaterThanOrEqual(16);
  });

  it('follows units that are mostly out of view', async () => {
    const { c, g } = await setup();
    g.origin = [1e6, 1e6];
    await c.playReplay({ speed: 100 });
    expect(g.focused.length).toBeGreaterThan(0);
    const { c: c2, g: g2, scene } = await setup();
    const b = scene.bounds;
    g2.origin = [b.x - 10, b.y - 10];
    g2.zoom = Math.min(800 / (b.width + 20), 600 / (b.height + 20));
    await c2.playReplay({ speed: 100 });
    expect(g2.focused).toHaveLength(0);
  });

  it('resolves at once when stopped and draws nothing more', async () => {
    const { c, g } = await setup();
    g.hold = true;
    const playing = c.playReplay();
    await settle();
    c.stop();
    await expect(playing).resolves.toBeUndefined();
    const count = g.draws;
    g.hold = false;
    g.release();
    await settle();
    await settle();
    expect(g.draws).toBe(count);
  });

  it('is stopped by setLayer and by a new replay', async () => {
    const { c, g } = await setup();
    g.hold = true;
    const first = c.playReplay();
    await settle();
    const layer = c.setLayer('after');
    await expect(first).resolves.toBeUndefined();
    g.hold = false;
    g.release();
    await layer;
    const second = c.playReplay({ speed: 1000 });
    const third = c.playReplay({ speed: 1000 });
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
  });

  it('rejects a non-positive or non-finite speed', async () => {
    const { c } = await setup();
    for (const speed of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(c.playReplay({ speed })).rejects.toBeInstanceOf(KgdiffError);
    }
  });
});

/** Everything the fake holds, by id: what G6 would draw. */
function snapshot(g: FakeGraph): unknown[] {
  const all: [string, unknown][] = [
    ...[...g.nodes.values()].map((n): [string, unknown] => [
      `n ${String(n.id)}`,
      { style: n.style, data: n.data },
    ]),
    ...[...g.edges.values()].map((e): [string, unknown] => [
      `e ${String(e.id)}`,
      { source: e.source, target: e.target, type: e.type, style: e.style, data: e.data },
    ]),
  ];
  return all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe('seekReplay', () => {
  /** A fresh replay controller at `step`: its start, or `selectHunk(step)`. */
  async function freshAt(step: number): Promise<unknown[]> {
    const { c, g } = await setup({ view: { layer: 'replay' } });
    if (step >= 0) await c.selectHunk(step);
    return snapshot(g);
  }

  it('steps forwards and backwards to the state a fresh controller has there', async () => {
    const { c, g, scene } = await setup({ view: { layer: 'replay' } });
    const H = scene.hunks.length;
    expect(H).toBeGreaterThan(2);
    const start = snapshot(g);
    for (let k = 0; k < H; k++) await c.seekReplay(k);
    expect(snapshot(g)).toEqual(await freshAt(H - 1));
    for (const k of [Math.floor(H / 2), 1, 0]) {
      await c.seekReplay(k);
      expect(snapshot(g)).toEqual(await freshAt(k));
    }
    await c.seekReplay(-1);
    expect(snapshot(g)).toEqual(start);
    expect(snapshot(g)).toEqual(await freshAt(-1));
    await c.seekReplay(H - 1);
    await c.seekReplay(-1);
    expect(snapshot(g)).toEqual(start);
  });

  it('returns to the start after a replay has played', async () => {
    const { c, g } = await setup({ view: { layer: 'replay' } });
    const start = snapshot(g);
    await c.playReplay({ speed: 1000 });
    expect(snapshot(g)).not.toEqual(start);
    await c.seekReplay(-1);
    expect(snapshot(g)).toEqual(start);
  });

  it('enters the replay layer from another one, and setLayer leaves it', async () => {
    const { c, g, scene } = await setup();
    const union = snapshot(g);
    await c.seekReplay(-1);
    const before = scene.nodes.filter((n) => n.presentBefore).map((n) => n.id);
    expect(sceneNodeIds(g.data).sort()).toEqual([...before].sort());
    expect(snapshot(g)).toEqual(await freshAt(-1));
    await c.setLayer('union');
    expect(snapshot(g)).toEqual(union);
  });

  it('pans to the hunk it seeks to, and leaves the camera alone at the start', async () => {
    const { c, g, scene } = await setup({ view: { layer: 'replay' } });
    const h = scene.hunks.findIndex((x) => x.nodes.length > 0);
    await c.seekReplay(h);
    expect(g.focused).toHaveLength(1);
    await c.seekReplay(-1);
    expect(g.focused).toHaveLength(1);
  });

  it('stops a running replay', async () => {
    const { c, g } = await setup({ view: { layer: 'replay' } });
    g.hold = true;
    const playing = c.playReplay();
    await settle();
    const seek = c.seekReplay(-1);
    await expect(playing).resolves.toBeUndefined();
    g.hold = false;
    g.release();
    await seek;
  });

  it('rejects positions outside [-1, hunks), and after destroy', async () => {
    const { c, scene } = await setup();
    for (const bad of [-2, 0.5, scene.hunks.length, Number.NaN]) {
      await expect(c.seekReplay(bad)).rejects.toBeInstanceOf(KgdiffError);
    }
    c.destroy();
    await expect(c.seekReplay(-1)).rejects.toBeInstanceOf(KgdiffError);
  });

  it('leaves selectHunk as it was: -1 clears the selection and keeps the time', async () => {
    const { c, g, scene } = await setup({ view: { layer: 'replay' } });
    const k = scene.hunks.length - 1;
    await c.seekReplay(k);
    const sought = snapshot(g);
    await c.selectHunk(-1);
    await c.selectHunk(k);
    expect(snapshot(g)).toEqual(sought);
    await c.selectHunk(-1);
    expect(snapshot(g)).not.toEqual(await freshAt(-1));
  });
});

describe('hunkOf', () => {
  it('names the hunk of every drawn element, as its data says', async () => {
    const { c, g, scene } = await setup();
    const drawn = [...g.nodes.values(), ...g.edges.values()];
    expect(drawn.length).toBeGreaterThan(0);
    for (const datum of drawn) {
      expect(c.hunkOf(String(datum.id))).toBe(kgdiffData(datum.data)?.hunk);
    }
    const changed = scene.nodes.find((n) => n.hunk >= 0);
    const plain = scene.nodes.find((n) => n.hunk < 0);
    const edge = scene.edges.find((e) => e.hunk >= 0 && g.has(e.id));
    if (changed === undefined || plain === undefined || edge === undefined) {
      throw new Error('fixture');
    }
    expect(c.hunkOf(changed.id)).toBe(changed.hunk);
    expect(c.hunkOf(edge.id)).toBe(edge.hunk);
    expect(c.hunkOf(plain.id)).toBe(-1);
    expect(c.hunkOf('not drawn')).toBe(-1);
  });

  it('follows what is drawn, and is -1 after destroy', async () => {
    const { c, g, scene } = await setup({ view: { layer: 'replay' } });
    const added = scene.nodes.find((n) => !n.presentBefore && n.hunk >= 0);
    if (added === undefined) throw new Error('fixture');
    expect(g.has(added.id)).toBe(false);
    expect(c.hunkOf(added.id)).toBe(-1);
    await c.seekReplay(scene.hunks.length - 1);
    expect(c.hunkOf(added.id)).toBe(added.hunk);
    c.destroy();
    expect(c.hunkOf(added.id)).toBe(-1);
  });
});

describe('theme and lifecycle', () => {
  it('switches the background plugin and every color', async () => {
    const { c, g } = await setup();
    const light = getTheme('light');
    await c.setTheme(light);
    expect(g.plugins.at(-1)).toEqual({
      key: BACKGROUND_PLUGIN_KEY,
      background: light.canvas.background,
    });
    const added = (g.data.nodes ?? []).find((n) => kgdiffData(n.data)?.family === 'added');
    expect(added?.style?.fill).toBe(light.family.added.base);
    await expect(c.setTheme(null as unknown as typeof light)).rejects.toBeInstanceOf(KgdiffError);
  });

  it('destroys the graph once, unbinds its handlers and rejects later calls', async () => {
    const { c, g } = await setup();
    g.hold = true;
    const playing = c.playReplay();
    await settle();
    c.destroy();
    c.destroy();
    await expect(playing).resolves.toBeUndefined();
    expect(g.log.filter((l) => l === 'destroy')).toHaveLength(1);
    expect([...g.handlers.values()].every((s) => s.size === 0)).toBe(true);
    await expect(c.setLayer('after')).rejects.toBeInstanceOf(KgdiffError);
    await expect(c.playReplay()).rejects.toBeInstanceOf(KgdiffError);
  });

  it('does not wait forever on a draw interrupted by destroy', async () => {
    const { c, g } = await setup();
    g.hold = true;
    const layer = c.setLayer('after');
    await settle();
    c.destroy();
    await expect(layer).resolves.toBeUndefined();
  });
});

describe('draw deadline', () => {
  it('stops waiting for a draw G6 never settles (paused animation frames)', async () => {
    const { c, g, scene } = await setup();
    g.hold = true;
    const layer = c.setLayer('after');
    await settle();
    expect(deadlines.at(-1)?.ms).toBe(scene.theme.motion.base + 1000);
    deadlines.at(-1)?.fire();
    await expect(layer).resolves.toBeUndefined();
    // The queue moves on.
    g.hold = false;
    await c.setLayer('before');
    expect(g.draws).toBe(2);
  });
});

describe('coalescing', () => {
  it('collapses requests queued behind a draw into one update, latest wins', async () => {
    const { c, g, scene } = await setup();
    const hunks = scene.hunks.map((h, i) => (h.nodes.length > 0 ? i : -1)).filter((i) => i >= 0);
    g.hold = true;
    const first = c.setLayer('before');
    await settle();
    expect(g.draws).toBe(1);
    const burst = [
      c.selectHunk(hunks[0] as number),
      c.setLayer('after'),
      c.setTheme(getTheme('light')),
      c.selectHunk(hunks[1] as number),
      c.setLayer('union'),
    ];
    g.hold = false;
    g.release();
    await Promise.all([first, ...burst]);
    expect(g.draws).toBe(2);
    // One camera move, to the last selection.
    const last = scene.hunks[hunks[1] as number];
    expect(g.focused).toHaveLength(1);
    expect(new Set(g.focused[0]?.ids)).toEqual(
      new Set(last?.nodes.map((i) => scene.nodes[i]?.id).filter((id) => g.has(String(id)))),
    );
    expect(g.plugins).toHaveLength(1);
    const fresh = await setup(
      { view: { layer: 'union', selectedHunk: hunks[1] as number } },
      { ...scene, theme: getTheme('light') },
    );
    expect(stylesById(g)).toEqual(stylesById(fresh.g));
  });

  it('lets a later clear cancel a pending camera move', async () => {
    const { c, g, scene } = await setup();
    g.hold = true;
    const first = c.setLayer('after');
    await settle();
    const select = c.selectHunk(scene.hunks.findIndex((h) => h.nodes.length > 0));
    const clear = c.selectHunk(-1);
    g.hold = false;
    g.release();
    await Promise.all([first, select, clear]);
    expect(g.focused).toHaveLength(0);
  });
});

describe('destroy while busy', () => {
  /** Resolves to the promise's outcome, or 'pending' if it has not settled within `ms`. */
  async function outcome(p: Promise<unknown>, ms = 30): Promise<string> {
    return Promise.race([
      p.then(
        () => 'resolved',
        (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
    ]);
  }

  it('settles a selection whose camera move G6 abandons', async () => {
    const { c, g, scene } = await setup();
    g.holdFocus = true;
    const select = c.selectHunk(scene.hunks.findIndex((h) => h.nodes.length > 0));
    await settle();
    c.destroy();
    expect(await outcome(select)).toBe('resolved');
  });

  it('rejects calls made after destroy at once instead of queueing them', async () => {
    const { c, g, scene } = await setup();
    g.holdFocus = true;
    void c.selectHunk(scene.hunks.findIndex((h) => h.nodes.length > 0));
    await settle();
    c.destroy();
    const error = 'rejected: This diff graph has been destroyed.';
    expect(await outcome(c.setLayer('union'))).toBe(error);
    expect(await outcome(c.selectHunk(-1))).toBe(error);
    expect(await outcome(c.setTheme(getTheme('light')))).toBe(error);
    expect(await outcome(c.playReplay())).toBe(error);
  });

  it('settles a replay whose camera move is in flight', async () => {
    const { c, g } = await setup();
    g.holdFocus = true;
    g.origin = [1e6, 1e6];
    const playing = c.playReplay({ speed: 1000 });
    await settle();
    c.destroy();
    expect(await outcome(playing)).toBe('resolved');
  });

  it('raises nothing for clicks or zooms still queued at destroy', async () => {
    const thrown: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (cb: () => void): void =>
      original(() => {
        try {
          cb();
        } catch (error) {
          thrown.push(error);
        }
      });
    try {
      const { c, g, scene } = await setup();
      g.hold = true;
      const layer = c.setLayer('after');
      const changed = scene.nodes.find((n) => n.hunk >= 0);
      g.emit('node:click', { target: { id: changed?.id } } as unknown as IEvent);
      g.emit('canvas:click');
      g.zoom = 0.05;
      g.emit('aftertransform');
      c.destroy();
      expect(await outcome(layer)).toBe('resolved');
      await settle();
      await settle();
      expect(thrown).toEqual([]);
    } finally {
      globalThis.queueMicrotask = original;
    }
  });
});
