/**
 * The controller behind `createDiffGraph`: owns the view state and the resolver, turns every
 * view change into one resolved frame → mapped data → a patch of only what changed (`addData` /
 * `updateData` with the changed keys / `removeData`) + `graph.draw()` (G6 animates the
 * difference), and keeps G6's level of detail in step with the camera.
 *
 * All graph mutations go through one queue, so G6 never receives a new frame while it is still
 * starting the previous draw. View requests (layer, selection, theme, LOD) that pile up while a
 * draw runs collapse into one job, latest wins. Every queued task, draw and camera move is raced
 * against `destroy()`, so no promise outlives the graph. The graph is reached through
 * `GraphLike`, the subset of G6's `Graph` used here, so the logic is testable with a fake.
 */
import type {
  AnimationEffectTiming,
  FitViewOptions,
  GraphData,
  GraphOptions,
  ID,
  IEvent,
  Point,
  ViewportAnimationEffectTiming,
} from '@antv/g6';
import { KgdiffError } from '@kgdiff/core';
import {
  createViewState,
  createVisualResolver,
  type FrameVisuals,
  type Layer,
  type Scene,
  type Theme,
  type ViewState,
  type VisualResolver,
} from '@kgdiff/scene';
import {
  BACKGROUND_PLUGIN_KEY,
  DRAW_GRACE_MS,
  FOLLOW_VISIBLE_SHARE,
  MIN_STEP_MS,
} from './constants.js';
import { crossesLod, type KgdiffDatumData, kgdiffData, mapFrame } from './map.js';
import { generatedOptions, mergeG6Options } from './options.js';
import { type Datum, diffData } from './patch.js';
import { planReplay } from './replay.js';

/** The part of G6's `Graph` the controller uses. */
export interface GraphLike {
  readonly destroyed: boolean;
  render(): Promise<void>;
  draw(): Promise<void>;
  addData(data: GraphData): void;
  updateData(data: GraphData): void;
  removeData(ids: { nodes?: ID[]; edges?: ID[] }): void;
  setOptions(options: GraphOptions): void;
  fitView(options?: FitViewOptions, animation?: ViewportAnimationEffectTiming): Promise<void>;
  focusElement(id: ID | ID[], animation?: ViewportAnimationEffectTiming): Promise<void>;
  getZoom(): number;
  getSize(): [number, number];
  getCanvasByViewport(point: Point): Point;
  updatePlugin(plugin: { key: string; [key: string]: unknown }): void;
  on(eventName: string, callback: (event: IEvent) => void): unknown;
  off(eventName: string, callback: (event: IEvent) => void): unknown;
  destroy(): void;
}

export interface ControllerOptions {
  readonly view?: Partial<ViewState>;
  readonly g6?: Readonly<Record<string, unknown>>;
  readonly interactive?: boolean;
}

export interface ControllerDeps<G extends GraphLike> {
  readonly createGraph: (options: GraphOptions) => G;
  /** Resolves after `ms` (replay pacing when G6 animations are off). */
  readonly wait: (ms: number) => Promise<void>;
  /**
   * Resolves after `ms`: the longest a draw is awaited. Browsers pause animation frames in
   * background pages, and G6's draw promise only settles when its animation has run.
   */
  readonly deadline: (ms: number) => Promise<void>;
}

const EDITABLE_LAYERS: ReadonlySet<string> = new Set(['union', 'before', 'after']);

function invalid(message: string): KgdiffError {
  return new KgdiffError('invalid-input', message);
}

function targetId(event: IEvent): string | null {
  const target = (event as { readonly target?: { readonly id?: unknown } }).target;
  return typeof target?.id === 'string' ? target.id : null;
}

function destroyedError(): KgdiffError {
  return invalid('This diff graph has been destroyed.');
}

/** A pending view update; requests made before it starts are merged into it (latest wins). */
interface Job {
  /** Animation duration (ms) of the draw, or false for none. */
  duration: number | false;
  /** Hunks to pan to; null cancels an earlier request; undefined = leave the camera alone. */
  focus: readonly number[] | null | undefined;
  theme: Theme | null;
  promise: Promise<void>;
}

class ReplayRun {
  cancelled = false;
  readonly stopped: Promise<void>;
  private release!: () => void;
  constructor() {
    this.stopped = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  cancel(): void {
    this.cancelled = true;
    this.release();
  }
}

export class DiffGraphControllerImpl<G extends GraphLike> {
  private graphRef: G | null = null;
  private scene: Scene;
  private resolver: VisualResolver;
  private view: ViewState;
  private frame: FrameVisuals | undefined;
  private data = new Map<ID, Datum>();
  private meta = new Map<ID, KgdiffDatumData>();
  private lod: readonly number[] = [];
  private lodZoom = 1;
  private job: Job | null = null;
  private queue: Promise<void> = Promise.resolve();
  private replay: ReplayRun | null = null;
  private destroyed = false;
  private readonly dead: Promise<void>;
  private kill!: () => void;
  private readonly handlers: [string, (event: IEvent) => void][] = [];

  constructor(
    scene: Scene,
    private readonly options: ControllerOptions,
    private readonly deps: ControllerDeps<G>,
  ) {
    this.scene = scene;
    this.resolver = createVisualResolver(scene);
    this.view = createViewState(options.view ?? {});
    this.dead = new Promise((resolve) => {
      this.kill = resolve;
    });
  }

  get graph(): G {
    if (this.graphRef === null) throw invalid('The G6 graph is not created yet.');
    return this.graphRef;
  }

  /** Create, render and fit the graph. */
  async start(container: HTMLElement | string): Promise<void> {
    const interactive = this.options.interactive !== false;
    const initial = this.map(1);
    const generated = generatedOptions({
      container,
      data: initial,
      theme: () => this.scene.theme,
      interactive,
      hoverable: (event) => {
        const id = targetId(event);
        const d = id === null ? undefined : this.meta.get(id);
        return d !== undefined && d.kgdiff !== 'collapsed' && d.kgdiff !== 'anchor';
      },
    });
    const graph = this.deps.createGraph(
      mergeG6Options({ ...generated, animation: this.timing(false) }, this.options.g6),
    );
    this.graphRef = graph;
    if (interactive) {
      this.listen('node:click', (event) => this.onElementClick(event));
      this.listen('edge:click', (event) => this.onElementClick(event));
      this.listen('canvas:click', () => this.onCanvasClick());
    }
    await graph.render();
    // Only now: G6 emits transforms while it sets up its viewport, before `getZoom` works.
    this.listen('aftertransform', () => this.onTransform());
    await graph.fitView(undefined, false);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  setLayer(layer: Exclude<Layer, 'replay'>): Promise<void> {
    if (!EDITABLE_LAYERS.has(layer)) {
      return Promise.reject(
        invalid(`setLayer expects 'union', 'before' or 'after', got ${JSON.stringify(layer)}.`),
      );
    }
    if (this.destroyed) return Promise.reject(destroyedError());
    this.stop();
    this.view = createViewState({ ...this.view, layer });
    return this.request(this.scene.theme.motion.base);
  }

  selectHunk(index: number): Promise<void> {
    const H = this.scene.hunks.length;
    if (!Number.isInteger(index) || index < -1 || index >= H) {
      return Promise.reject(
        invalid(`Hunk index must be an integer in [-1, ${H - 1}], got ${String(index)}.`),
      );
    }
    return this.select(index, -1);
  }

  seekReplay(index: number): Promise<void> {
    const H = this.scene.hunks.length;
    if (!Number.isInteger(index) || index < -1 || index >= H) {
      return Promise.reject(
        invalid(`Replay position must be an integer in [-1, ${H - 1}], got ${String(index)}.`),
      );
    }
    if (this.destroyed) return Promise.reject(destroyedError());
    this.stop();
    // -1 is the start (the earlier version, nothing selected); a hunk is the end of its window
    // with the hunk selected, as `selectHunk` leaves the replay layer. Time moves either way.
    let t = 0;
    if (index >= 0) {
      const w = this.scene.timeline.windows.find((x) => x.hunk === index);
      t = w !== undefined ? w.end : this.view.t;
    }
    this.view = createViewState({
      ...this.view,
      layer: 'replay',
      t,
      selectedHunk: index,
      selectedNode: -1,
    });
    return this.request(this.scene.theme.motion.base, index >= 0 ? [index] : null);
  }

  hunkOf(elementId: string): number {
    if (this.destroyed) return -1;
    return this.meta.get(elementId)?.hunk ?? -1;
  }

  async playReplay(options: { readonly speed?: number } = {}): Promise<void> {
    const speed = options.speed ?? 1;
    if (!(typeof speed === 'number' && Number.isFinite(speed) && speed > 0)) {
      throw invalid(`Replay speed must be a positive number, got ${String(speed)}.`);
    }
    this.assertAlive();
    this.stop();
    const run = new ReplayRun();
    this.replay = run;
    try {
      await Promise.race([this.runReplay(run, speed), run.stopped, this.dead]);
    } finally {
      if (this.replay === run) this.replay = null;
    }
  }

  /** Stop a running replay (its promise resolves at once); no-op otherwise. */
  stop(): void {
    const run = this.replay;
    this.replay = null;
    run?.cancel();
  }

  setTheme(theme: Theme): Promise<void> {
    if (
      theme === null ||
      typeof theme !== 'object' ||
      typeof theme.canvas?.background !== 'string'
    ) {
      return Promise.reject(invalid('setTheme expects a Theme (see getTheme in @kgdiff/scene).'));
    }
    return this.request(theme.motion.base, undefined, theme);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.kill();
    const graph = this.graphRef;
    if (graph === null) return;
    for (const [name, handler] of this.handlers) graph.off(name, handler);
    this.handlers.length = 0;
    if (!graph.destroyed) graph.destroy();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private assertAlive(): void {
    if (this.destroyed) throw invalid('This diff graph has been destroyed.');
  }

  private listen(name: string, handler: (event: IEvent) => void): void {
    this.graph.on(name, handler);
    this.handlers.push([name, handler]);
  }

  /**
   * Run `task` after the queued ones. Rejects at once after `destroy()`; a task still queued or
   * running when the graph is destroyed settles (resolves) instead of waiting on G6.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    if (this.destroyed) return Promise.reject(destroyedError());
    const run = this.queue.then(() =>
      this.destroyed ? undefined : Promise.race([task(), this.dead]),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Schedule one view update: resolve the current view, patch the graph, optionally switch the
   * theme and pan. Requests made while an update is waiting in the queue join it (latest wins),
   * so a burst of clicks costs one G6 draw.
   */
  private request(
    duration: number | false,
    focus?: readonly number[] | null,
    theme?: Theme,
  ): Promise<void> {
    if (this.destroyed) return Promise.reject(destroyedError());
    let job = this.job;
    if (job === null) {
      const created: Job = { duration, focus: undefined, theme: null, promise: Promise.resolve() };
      created.promise = this.enqueue(() => this.runJob(created));
      this.job = created;
      job = created;
    }
    job.duration = duration;
    if (focus !== undefined) job.focus = focus;
    if (theme !== undefined) job.theme = theme;
    return job.promise;
  }

  private async runJob(job: Job): Promise<void> {
    if (this.job === job) this.job = null;
    if (job.theme !== null) {
      this.scene = { ...this.scene, theme: job.theme };
      this.resolver = createVisualResolver(this.scene);
      this.frame = undefined;
      this.graph.updatePlugin({
        key: BACKGROUND_PLUGIN_KEY,
        background: job.theme.canvas.background,
      });
    }
    const camera =
      job.focus !== undefined && job.focus !== null
        ? this.focus(job.focus, this.scene.theme.motion.slow)
        : null;
    await Promise.all([this.apply(this.timing(job.duration)), camera]);
  }

  /** Failures of fire-and-forget work (event handlers): surfaced, unless the graph is gone. */
  private report = (error: unknown): void => {
    if (this.destroyed) return;
    queueMicrotask(() => {
      throw error;
    });
  };

  /** G6's global animation option for one draw: false, or the theme easing over `duration`. */
  private timing(duration: number | false): false | AnimationEffectTiming {
    if (duration === false || this.options.g6?.animation === false) return false;
    const [x1, y1, x2, y2] = this.scene.theme.motion.easing;
    return { duration: Math.max(0, duration), easing: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})` };
  }

  private viewportTiming(duration: number): ViewportAnimationEffectTiming {
    const t = this.timing(duration);
    if (t === false || this.view.reducedMotion) return false;
    return { duration: t.duration ?? duration, easing: t.easing ?? 'ease' };
  }

  /** Resolve the current view and map it for `zoom`; records what was mapped. */
  private map(zoom: number): {
    nodes: NonNullable<GraphData['nodes']>;
    edges: NonNullable<GraphData['edges']>;
  } {
    this.frame = this.resolver.resolve(this.view, this.frame);
    const mapped = mapFrame(this.scene, this.frame, { idPrefix: '', keepHidden: false, zoom });
    const all: Datum[] = [...mapped.data.nodes, ...mapped.data.edges];
    this.data = new Map();
    this.meta = new Map();
    for (const datum of all) {
      if (datum.id === undefined) continue;
      this.data.set(datum.id, datum);
      const d = kgdiffData(datum.data);
      if (d !== null) this.meta.set(datum.id, d);
    }
    this.lod = mapped.lod;
    this.lodZoom = zoom;
    return mapped.data;
  }

  /** Map the current view and hand G6 only the difference to what it shows. */
  private async apply(animation: false | AnimationEffectTiming): Promise<void> {
    if (this.destroyed) return;
    const graph = this.graph;
    const prev = this.data;
    const next = this.map(graph.getZoom());
    const patch = diffData(prev, next);
    if (patch.size === 0) return;
    graph.setOptions({ animation });
    // G6's own order: add, update (edges may move to added nodes), then remove.
    if (patch.add.nodes.length + patch.add.edges.length > 0) graph.addData(patch.add);
    if (patch.update.nodes.length + patch.update.edges.length > 0) graph.updateData(patch.update);
    if (patch.remove.nodes.length + patch.remove.edges.length > 0) graph.removeData(patch.remove);
    if (patch.readd.nodes.length + patch.readd.edges.length > 0) graph.addData(patch.readd);
    const duration = animation === false ? 0 : (animation.duration ?? 0);
    await Promise.race([graph.draw(), this.dead, this.deps.deadline(duration + DRAW_GRACE_MS)]);
  }

  private select(hunk: number, node: number): Promise<void> {
    if (this.destroyed) return Promise.reject(destroyedError());
    this.stop();
    let view: Partial<ViewState> = { ...this.view, selectedHunk: hunk, selectedNode: node };
    if (this.view.layer === 'replay' && hunk >= 0) {
      // In the replay layer a selection seeks to the end of the hunk's window.
      const w = this.scene.timeline.windows.find((x) => x.hunk === hunk);
      if (w !== undefined) view = { ...view, t: w.end };
    }
    this.view = createViewState(view);
    return this.request(this.scene.theme.motion.base, hunk >= 0 ? [hunk] : null);
  }

  /** Ids of the hunks' nodes that are currently drawn. */
  private hunkNodeIds(hunks: readonly number[]): string[] {
    const ids: string[] = [];
    for (const h of hunks) {
      const hunk = this.scene.hunks[h];
      if (hunk === undefined) continue;
      for (const i of hunk.nodes) {
        const id = this.scene.nodes[i]?.id;
        if (id !== undefined && this.meta.get(id)?.kgdiff === 'node') ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Pan to the hunks' nodes. Called before the next patch, so G6 measures elements that still
   * exist; resolves when the camera has arrived — or when the graph is destroyed, since G6 then
   * cancels the camera animation without ever settling its promise.
   */
  private focus(hunks: readonly number[], duration: number): Promise<void> | null {
    const ids = this.hunkNodeIds(hunks);
    if (ids.length === 0) return null;
    const moving = this.graph.focusElement(ids, this.viewportTiming(duration)).catch(this.report);
    return Promise.race([moving, this.dead]);
  }

  /** Share of the hunks' bounds inside the viewport, in [0, 1]. */
  private visibleShare(hunks: readonly number[]): number {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const h of hunks) {
      const b = this.scene.hunks[h]?.bounds;
      if (b === undefined) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!(area > 0)) return 1;
    const graph = this.graph;
    const [w, h] = graph.getSize();
    const a = graph.getCanvasByViewport([0, 0]);
    const b = graph.getCanvasByViewport([w, h]);
    const vx0 = Math.min(a[0] as number, b[0] as number);
    const vx1 = Math.max(a[0] as number, b[0] as number);
    const vy0 = Math.min(a[1] as number, b[1] as number);
    const vy1 = Math.max(a[1] as number, b[1] as number);
    const ix = Math.max(0, Math.min(x1, vx1) - Math.max(x0, vx0));
    const iy = Math.max(0, Math.min(y1, vy1) - Math.max(y0, vy0));
    return (ix * iy) / area;
  }

  private async runReplay(run: ReplayRun, speed: number): Promise<void> {
    const steps = planReplay(this.scene.timeline);
    const base = this.scene.theme.motion.base;
    // Morph from whatever is shown into the before state at t = 0.
    await this.enqueue(async () => {
      if (run.cancelled) return;
      this.view = createViewState({
        ...this.view,
        layer: 'replay',
        t: 0,
        selectedHunk: -1,
        selectedNode: -1,
      });
      await this.apply(this.timing(base));
    });
    let pending = 0;
    let focus: readonly number[] | null = null;
    for (let k = 0; k < steps.length; k++) {
      if (run.cancelled) return;
      const step = steps[k] as (typeof steps)[number];
      pending += step.dt / speed;
      focus = step.focus ?? focus;
      // Steps too short to see are folded into the next one.
      if (pending < MIN_STEP_MS && k < steps.length - 1) continue;
      const duration = pending;
      const hunks = focus;
      pending = 0;
      focus = null;
      await this.enqueue(async () => {
        if (run.cancelled) return;
        const camera =
          hunks !== null && this.visibleShare(hunks) < FOLLOW_VISIBLE_SHARE
            ? this.focus(hunks, Math.min(Math.max(duration, 350), 1100))
            : null;
        this.view = createViewState({ ...this.view, t: step.t });
        await Promise.all([
          this.apply(this.timing(duration)),
          Promise.race([this.deps.wait(duration), this.dead]),
          camera,
        ]);
      });
    }
  }

  private onTransform(): void {
    // A queued update and a running replay both re-map at the current zoom anyway.
    if (this.destroyed || this.graphRef === null || this.job !== null || this.replay !== null) {
      return;
    }
    if (!crossesLod(this.lod, this.lodZoom, this.graph.getZoom())) return;
    this.request(false).catch(this.report);
  }

  private onElementClick(event: IEvent): void {
    const id = targetId(event);
    const d = id === null ? undefined : this.meta.get(id);
    if (d === undefined || d.kgdiff === 'collapsed' || d.kgdiff === 'anchor') return;
    if (d.hunk >= 0) this.select(d.hunk, -1).catch(this.report);
    else if (d.kgdiff === 'node') this.select(-1, d.index).catch(this.report);
  }

  private onCanvasClick(): void {
    if (this.view.selectedHunk < 0 && this.view.selectedNode < 0) return;
    this.select(-1, -1).catch(this.report);
  }
}
