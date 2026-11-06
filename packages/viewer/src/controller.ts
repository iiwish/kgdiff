/**
 * The canvas side of the viewer: a `DiffSession` (state, commands, events; `session.ts`) plus
 * the one view that draws it (RFC 0001 §1: renderer, camera, framing, minimap), behind the
 * `SessionView` boundary. Phase 3 of the RFC moves this view out into a `StageView` of its own,
 * so one session can drive several canvases.
 *
 * - draws the session's view state into the renderer (and the minimap, throttled while
 *   replaying);
 * - frames what the session asks for in the free part of the canvas, clear of the chrome over
 *   it (`framing.ts`); the replay camera follows the playing hunk / chapter unless the user
 *   moved it in the last 2 s;
 * - fits a new diff once the canvas is laid out, and again on resize with `autoFit`;
 * - turns canvas hovers and clicks into session commands.
 */
import type { Rect } from '@kgdiff/core';
import {
  type Camera,
  type CameraState,
  labelFootprint,
  type Minimap,
  type PickResult,
  type Renderer,
} from '@kgdiff/renderer';
import {
  createViewState,
  type FocusState,
  type FrameVisuals,
  frameBounds,
  type Layer,
  type Scene,
} from '@kgdiff/scene';
import {
  type ChromeLayout,
  chromeInsets,
  FRAME_PADDING,
  freeView,
  type Insets,
  NO_INSETS,
  zoomFit,
} from './framing.js';
import { renderBackend } from './renderer-port.js';
import {
  DiffSession,
  padRect,
  type SessionDeps,
  type SessionHost,
  type SessionView,
} from './session.js';

export type { Preference, Status, Topic } from './session.js';
export type ControllerHost = SessionHost;
export type ControllerDeps = SessionDeps;

export interface FitOptions {
  readonly animate?: boolean;
  /** Room around the content, px (default `FRAME_PADDING`); kept for later automatic fits. */
  readonly padding?: number;
}

/** Camera follow is suppressed this long after the user moved the camera (ms). */
export const USER_CAMERA_GRACE = 2000;
/** The camera follows when less than this share of the target bounds is in view. */
export const FOLLOW_COVERAGE = 0.7;
/** Flights to a change never zoom in further, so its neighbourhood stays readable. */
export const FLY_MAX_ZOOM = 1.8;
/** Fitting everything never zooms in further (the renderer's default). */
export const FIT_MAX_ZOOM = 2.5;
/** Minimap marks are re-rasterized at most this often while replaying (ms). */
const MINIMAP_INTERVAL = 200;
/** Everything counts as in view (the minimap hides) from this share of the content bounds on. */
export const OVERVIEW_COVERAGE = 0.98;

interface Frames {
  main: FrameVisuals | null;
  before: FrameVisuals | null;
  after: FrameVisuals | null;
}

/** Share of `bounds` inside `view`, in [0, 1]. */
export function coverage(bounds: Rect, view: Rect): number {
  const w = Math.min(bounds.x + bounds.width, view.x + view.width) - Math.max(bounds.x, view.x);
  const h = Math.min(bounds.y + bounds.height, view.y + view.height) - Math.max(bounds.y, view.y);
  const area = bounds.width * bounds.height;
  if (!(area > 0)) {
    const inside =
      bounds.x >= view.x &&
      bounds.x <= view.x + view.width &&
      bounds.y >= view.y &&
      bounds.y <= view.y + view.height;
    return inside ? 1 : 0;
  }
  return w > 0 && h > 0 ? (w * h) / area : 0;
}

export class ViewerController extends DiffSession implements SessionView {
  /**
   * Keep the view fitted (embeds without controls): fit again when the canvas is resized unless
   * the user moved the camera since, and at the start of every loop.
   */
  autoFit = false;
  /** Canvas clicks select (and double clicks fly); off for embeds without controls. */
  selectOnClick = true;
  /** The whole content is in view (the minimap has nothing to add). */
  overview = true;

  #labelsInside = false;
  #renderer: Renderer | null = null;
  #minimap: Minimap | null = null;
  readonly #unbind: (() => void)[] = [];
  readonly #frames: Frames = { main: null, before: null, after: null };
  #minimapDirty = true;
  #lastMinimap = Number.NEGATIVE_INFINITY;
  #lastUserCamera = Number.NEGATIVE_INFINITY;
  #boundsCache: {
    readonly scene: Scene;
    readonly focus: FocusState | null;
    readonly rect: Rect | null;
  } | null = null;
  #chrome: (() => ChromeLayout) | null = null;
  /** Camera kept across detach / attach (element moved in the DOM). */
  #savedCamera: CameraState | null = null;
  /** A new diff is installed but has not been fitted to a laid-out canvas yet. */
  #needsFit = false;
  /** The user panned or zoomed since the last fit. */
  #userMoved = false;
  #fitPadding = FRAME_PADDING;
  readonly #now: () => number;

  constructor(host: SessionHost, deps: SessionDeps) {
    super(host, deps);
    this.#now = deps.now;
    this.addView(this);
  }

  // ─── Renderer ─────────────────────────────────────────────────────────────

  attach(stage: HTMLElement, minimapHost: HTMLElement | null): void {
    if (this.#renderer) return;
    const backend = renderBackend();
    const renderer = backend.createRenderer(stage, {
      theme: this.theme,
      labelsInside: this.#labelsInside,
    });
    this.#renderer = renderer;
    // Re-attached (element moved): keep the view; this also stops the renderer's auto-fit.
    if (this.#savedCamera) renderer.camera.set(this.#savedCamera);
    if (minimapHost) this.#minimap = backend.createMinimap(minimapHost, renderer);
    this.#unbind.push(
      renderer.on('hover', (pick) => this.#onHover(pick)),
      renderer.on('click', ({ pick }) => this.#onCanvasClick(pick)),
      renderer.on('dblclick', ({ pick }) => this.#onCanvasDblClick(pick)),
      renderer.on('camera', ({ source }) => {
        if (source === 'user') this.noteUserCamera();
        this.#updateOverview();
      }),
    );
    this.#minimapDirty = true;
    this.invalidate();
  }

  detach(): void {
    // A pending initial fit still runs after re-attach (`layoutChanged`), overriding this.
    if (this.#renderer && this.status === 'ready') this.#savedCamera = this.#renderer.camera.get();
    this.sleep();
    for (const fn of this.#unbind.splice(0)) fn();
    this.#minimap?.destroy();
    this.#minimap = null;
    this.#renderer?.destroy();
    this.#renderer = null;
  }

  override destroy(): void {
    super.destroy();
    this.detach();
  }

  get camera(): Camera | null {
    return this.#renderer?.camera ?? null;
  }

  /**
   * Where floating chrome covers the canvas (measured by the element at fit / flight time).
   * Every fit and flight frames its target in the free part of the canvas (`framing.ts`).
   */
  setChrome(provider: (() => ChromeLayout) | null): void {
    this.#chrome = provider;
  }

  /**
   * Keep labels whole inside the canvas (embeds without camera controls): a label pushed from
   * its spot by a neighbour moves inside or is left out, never cut at the edge.
   */
  setLabelsInside(inside: boolean): void {
    this.#labelsInside = inside;
    this.#renderer?.setLabelsInside(inside);
  }

  /**
   * The canvas was laid out or resized: run the initial fit a new diff is waiting for, or (with
   * `autoFit`) fit again unless the user moved the camera since the last fit.
   */
  layoutChanged(): void {
    this.#updateOverview();
    if (this.status !== 'ready') return;
    if (!this.#needsFit) {
      if (this.autoFit && !this.#userMoved) void this.fit({ animate: false });
      return;
    }
    // A selection made before the first layout (deep link, `kgdiff-ready` handler) wins.
    const target = this.selectionBounds();
    if (target) {
      if (!this.#frameInsets(target, FLY_MAX_ZOOM)) return;
      this.#needsFit = false;
      this.#flyTo(target, { animate: false });
      return;
    }
    const fit = this.#fitTarget();
    const camera = this.#renderer?.camera;
    if (!fit || !camera) return;
    void this.#fitTo(camera, fit, { animate: false });
  }

  /** The user panned / zoomed: suspend replay camera follow for `USER_CAMERA_GRACE`. */
  noteUserCamera(): void {
    this.#lastUserCamera = this.#now();
    this.#userMoved = true;
  }

  // ─── SessionView ──────────────────────────────────────────────────────────

  /** Resolve the current view and hand it to the renderer (and the minimap). */
  draw(now = this.#now()): void {
    const resolver = this.resolver;
    const renderer = this.#renderer;
    if (!resolver || !renderer || this.status !== 'ready') return;
    const f = this.#frames;
    let mapFrame: FrameVisuals;
    if (this.mode === 'swipe') {
      f.before = resolver.resolve(this.viewState('before'), f.before ?? undefined);
      f.after = resolver.resolve(this.viewState('after'), f.after ?? undefined);
      renderer.setFrame({ split: this.split, before: f.before, after: f.after });
      mapFrame = f.after;
    } else {
      const layer: Layer = this.mode === 'replay' ? 'replay' : 'union';
      f.main = resolver.resolve(this.viewState(layer), f.main ?? undefined);
      renderer.setFrame(f.main);
      mapFrame = f.main;
    }
    const replaying = this.mode === 'replay' && (this.clock?.playing ?? false);
    if (
      this.#minimap &&
      (this.#minimapDirty || (replaying && now - this.#lastMinimap >= MINIMAP_INTERVAL))
    ) {
      this.#minimap.update(mapFrame);
      this.#minimapDirty = false;
      this.#lastMinimap = now;
    }
  }

  sceneChanged(): void {
    const f = this.#frames;
    f.main = f.before = f.after = null;
    this.#renderer?.setTheme(this.scene?.theme ?? this.theme);
    this.#minimapDirty = true;
  }

  installed(): void {
    // Fitted after the UI has shown its chrome (the session's notification is delivered
    // first) and once the canvas has a size (see `layoutChanged`).
    this.#needsFit = true;
    this.#savedCamera = null;
    queueMicrotask(() => this.layoutChanged());
  }

  drawnChanged(): void {
    this.#updateOverview();
    this.#minimapDirty = true;
  }

  show(bounds: Rect): void {
    this.#flyTo(bounds);
  }

  /** Follow `bounds` (replay): fly unless the user steered recently or it is mostly visible. */
  follow(bounds: Rect): void {
    if (this.#now() - this.#lastUserCamera < USER_CAMERA_GRACE) return;
    const free = this.#freeWorld(bounds);
    if (!free || coverage(bounds, free) >= FOLLOW_COVERAGE) return;
    this.#flyTo(bounds);
  }

  looped(): void {
    if (this.autoFit) void this.fit();
  }

  viewport(): Rect | null {
    return this.#renderer?.camera.viewport() ?? null;
  }

  // ─── Camera ───────────────────────────────────────────────────────────────

  /** Insets keeping `bounds` clear of the chrome over the canvas, or null before layout. */
  #frameInsets(bounds: Rect, maxZoom: number): Insets | null {
    const layout = this.#chrome?.();
    if (!layout || !(layout.width > 0) || !(layout.height > 0)) return null;
    return chromeInsets(bounds, layout, FRAME_PADDING, maxZoom);
  }

  #flyTo(bounds: Rect, options: { readonly animate?: boolean } = {}): void {
    const camera = this.#renderer?.camera;
    if (!camera) return;
    const padding = this.#frameInsets(bounds, FLY_MAX_ZOOM);
    void camera.flyTo(bounds, {
      ...options,
      maxZoom: FLY_MAX_ZOOM,
      ...(padding ? { padding } : {}),
    });
  }

  /** The world region visible outside the chrome, as framed for `bounds`. */
  #freeWorld(bounds: Rect): Rect | null {
    const camera = this.#renderer?.camera;
    if (!camera) return null;
    const insets = this.#frameInsets(bounds, FLY_MAX_ZOOM) ?? NO_INSETS;
    return freeView(camera.viewport(), camera.get().k, insets);
  }

  /**
   * Fit everything visible (the focus in changes-only mode), labels included, into the free part
   * of the canvas. Before the canvas is laid out it falls back to the renderer's own fit.
   */
  fit(options: FitOptions = {}): Promise<void> {
    const camera = this.#renderer?.camera;
    if (!camera) return Promise.resolve();
    const { padding, ...transition } = options;
    if (padding !== undefined) {
      this.#fitPadding = Number.isFinite(padding) && padding >= 0 ? padding : FRAME_PADDING;
    }
    const fit = this.#fitTarget();
    if (!fit) return camera.fit(undefined, transition);
    return this.#fitTo(camera, fit, transition);
  }

  #fitTo(
    camera: Camera,
    fit: { readonly bounds: Rect; readonly insets: Insets },
    transition: { readonly animate?: boolean },
  ): Promise<void> {
    this.#needsFit = false;
    this.#userMoved = false;
    return camera.fit(fit.bounds, { ...transition, padding: fit.insets, maxZoom: FIT_MAX_ZOOM });
  }

  /**
   * Bounds and insets that show everything visible (the changes-only focus) with every label
   * in its spot below its node, clear of the chrome, or null before layout. Measured in the
   * union layer, which holds every state a replay or swipe passes through. Insets depend on
   * what is framed, which depends on the zoom they allow: they are settled once more.
   */
  #fitTarget(): { bounds: Rect; insets: Insets } | null {
    const layout = this.#chrome?.();
    const resolver = this.resolver;
    if (!layout || !resolver || !(layout.width > 0) || !(layout.height > 0)) return null;
    const frame = resolver.resolve(
      createViewState({
        layer: 'union',
        focus: this.focus,
        families: this.families,
        reducedMotion: this.reducedMotion,
      }),
    );
    const footprint = labelFootprint(frame, this.theme);
    const extent = (k: number): Rect | null => footprint.at(k);
    const discs = extent(Number.POSITIVE_INFINITY);
    if (!discs) return null;
    const { width, height } = layout;
    const padding = this.#fitPadding;
    let insets = chromeInsets(discs, layout, padding, FIT_MAX_ZOOM);
    let fit = zoomFit(extent, width, height, insets, FIT_MAX_ZOOM);
    if (!fit) return null;
    const settled = chromeInsets(fit.content, layout, padding, FIT_MAX_ZOOM);
    if (!sameInsets(settled, insets)) {
      insets = settled;
      fit = zoomFit(extent, width, height, insets, FIT_MAX_ZOOM) ?? fit;
    }
    return { bounds: fit.bounds, insets };
  }

  /** Bounds of what is drawn: the scene, or the visible part of the `changes` scope's focus. */
  #contentBounds(): Rect | null {
    const scene = this.scene;
    if (!scene) return null;
    const focus = this.focus;
    const cached = this.#boundsCache;
    if (cached && cached.scene === scene && cached.focus === focus) return cached.rect;
    const rect = focus ? focusBounds(scene, focus) : frameBounds(scene);
    this.#boundsCache = { scene, focus, rect };
    return rect;
  }

  /** Whether everything drawn is in view; the minimap hides while it is. */
  #updateOverview(): void {
    const bounds = this.#contentBounds();
    const view = this.#renderer?.camera.viewport();
    const next = !bounds || !view || coverage(bounds, view) >= OVERVIEW_COVERAGE;
    if (next === this.overview) return;
    this.overview = next;
    this.notify('overview');
  }

  zoom(direction: 1 | -1): void {
    this.noteUserCamera();
    this.#renderer?.camera.zoomBy(direction > 0 ? 1.4 : 1 / 1.4);
  }

  // ─── Canvas events ────────────────────────────────────────────────────────

  #onHover(pick: PickResult | null): void {
    this.setHover(
      pick?.type === 'node' ? pick.index : -1,
      pick?.type === 'edge' ? pick.index : -1,
      pick?.type === 'collapsed' ? pick.index : -1,
    );
  }

  #onCanvasClick(pick: PickResult | null): void {
    if (!this.selectOnClick) return;
    if (!pick) {
      this.clearSelection();
      return;
    }
    switch (pick.type) {
      case 'node':
        this.selectNode(pick.index, { fly: false });
        break;
      case 'edge': {
        const e = this.scene?.edges[pick.index];
        if (e && e.hunk >= 0) this.selectHunk(e.hunk, { fly: false });
        this.pinnedEdge = pick.index;
        this.invalidate();
        break;
      }
      case 'collapsed':
        this.expandGroup(pick.index);
        break;
      default:
        break;
    }
  }

  #onCanvasDblClick(pick: PickResult | null): void {
    if (!this.selectOnClick || pick?.type !== 'node') return;
    const n = this.scene?.nodes[pick.index];
    if (!n) return;
    if (n.hunk >= 0) this.flyToHunk(n.hunk);
    else this.flyToNode(pick.index);
  }
}

function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Bounds of the visible part of `focus`, with room for labels and the collapsed pills. */
function focusBounds(scene: Scene, focus: FocusState): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number, rx: number, top: number, bottom: number): void => {
    x0 = Math.min(x0, x - rx);
    x1 = Math.max(x1, x + rx);
    y0 = Math.min(y0, y - top);
    y1 = Math.max(y1, y + bottom);
  };
  // Labels sit centered below their node: leave room for a typical one.
  for (const n of scene.nodes)
    if (focus.nodes[n.index] === 1) add(n.x, n.y, n.r + 48, n.r, n.r + 24);
  for (const g of focus.collapsed) add(g.x, g.y, 48, 12, 12);
  if (!(x0 <= x1)) return frameBounds(scene);
  return padRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, 160, 1.12);
}
