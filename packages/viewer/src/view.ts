/**
 * A view of a diff session (RFC 0001 §1): one canvas, with its renderer, camera, framing and
 * minimaps, behind the session's `SessionView` boundary. A session can have several (each
 * `<kgdiff-stage>` has one); they share everything the session holds (selection, hover, mode,
 * scope, the replay clock, filters, search) and each frames it on its own canvas.
 *
 * - draws the session's view state into the renderer (and the minimaps, throttled while
 *   replaying); a view pinned to a `version` draws that version alone, whatever the mode;
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
import type { StageVersion } from './index.js';
import { renderBackend } from './renderer-port.js';
import { type DiffSession, padRect, type SessionView } from './session.js';

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

export class StageView implements SessionView {
  /**
   * Keep the view fitted (embeds without controls): fit again when the canvas is resized unless
   * the user moved the camera since, and at the start of every loop.
   */
  autoFit = false;
  /** Canvas clicks select (and double clicks fly); off for embeds without controls. */
  selectOnClick = true;
  /** The whole content is in view (the minimaps have nothing to add). */
  overview = true;

  readonly #session: DiffSession;
  #version: StageVersion | null = null;
  #labelsInside = false;
  #renderer: Renderer | null = null;
  /** Minimap hosts, with their minimap while the renderer is attached. */
  readonly #minimaps = new Map<HTMLElement, Minimap | null>();
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

  constructor(session: DiffSession) {
    this.#session = session;
    // A view joining a session that already shows a diff fits it once laid out.
    this.#needsFit = session.status === 'ready';
  }

  // ─── Renderer ─────────────────────────────────────────────────────────────

  attach(stage: HTMLElement, minimapHost: HTMLElement | null): void {
    if (this.#renderer) return;
    const s = this.#session;
    const backend = renderBackend();
    const renderer = backend.createRenderer(stage, {
      theme: s.theme,
      labelsInside: this.#labelsInside,
    });
    this.#renderer = renderer;
    // Re-attached (element moved): keep the view; this also stops the renderer's auto-fit.
    if (this.#savedCamera) renderer.camera.set(this.#savedCamera);
    if (minimapHost && !this.#minimaps.has(minimapHost)) this.#minimaps.set(minimapHost, null);
    for (const host of this.#minimaps.keys()) {
      this.#minimaps.set(host, backend.createMinimap(host, renderer));
    }
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
    s.invalidate();
  }

  detach(): void {
    // A pending initial fit still runs after re-attach (`layoutChanged`), overriding this.
    if (this.#renderer && this.#session.status === 'ready') {
      this.#savedCamera = this.#renderer.camera.get();
    }
    for (const fn of this.#unbind.splice(0)) fn();
    for (const [host, minimap] of this.#minimaps) {
      minimap?.destroy();
      this.#minimaps.set(host, null);
    }
    this.#renderer?.destroy();
    this.#renderer = null;
  }

  /**
   * Draw a minimap of this view into `host` (in addition to the one `attach` was given); returns
   * the function that removes it.
   */
  addMinimap(host: HTMLElement): () => void {
    if (!this.#minimaps.has(host)) {
      const renderer = this.#renderer;
      this.#minimaps.set(host, renderer ? renderBackend().createMinimap(host, renderer) : null);
      this.#minimapDirty = true;
      this.#session.invalidate();
    }
    return () => {
      this.#minimaps.get(host)?.destroy();
      this.#minimaps.delete(host);
    };
  }

  get camera(): Camera | null {
    return this.#renderer?.camera ?? null;
  }

  /** The version this view draws whatever the mode (`<kgdiff-stage version>`), or null. */
  get version(): StageVersion | null {
    return this.#version;
  }

  set version(version: StageVersion | null) {
    if (version === this.#version) return;
    this.#version = version;
    this.#minimapDirty = true;
    this.#session.invalidate();
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
    if (this.#session.status !== 'ready') return;
    if (!this.#needsFit) {
      if (this.autoFit && !this.#userMoved) void this.fit({ animate: false });
      return;
    }
    // A selection made before the first layout (deep link, `kgdiff-ready` handler) wins.
    const target = this.#session.selectionBounds();
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
    this.#lastUserCamera = this.#session.now();
    this.#userMoved = true;
  }

  // ─── SessionView ──────────────────────────────────────────────────────────

  /** Resolve the current view and hand it to the renderer (and the minimaps). */
  draw(now = this.#session.now()): void {
    const s = this.#session;
    const resolver = s.resolver;
    const renderer = this.#renderer;
    if (!resolver || !renderer || s.status !== 'ready') return;
    const f = this.#frames;
    let mapFrame: FrameVisuals;
    const version = this.#version;
    if (version) {
      f.main = resolver.resolve(s.viewState(version), f.main ?? undefined);
      renderer.setFrame(f.main);
      mapFrame = f.main;
    } else if (s.mode === 'swipe') {
      f.before = resolver.resolve(s.viewState('before'), f.before ?? undefined);
      f.after = resolver.resolve(s.viewState('after'), f.after ?? undefined);
      renderer.setFrame({ split: s.split, before: f.before, after: f.after });
      mapFrame = f.after;
    } else {
      const layer: Layer = s.mode === 'replay' ? 'replay' : 'union';
      f.main = resolver.resolve(s.viewState(layer), f.main ?? undefined);
      renderer.setFrame(f.main);
      mapFrame = f.main;
    }
    const replaying = !version && s.mode === 'replay' && (s.clock?.playing ?? false);
    if (
      this.#minimaps.size > 0 &&
      (this.#minimapDirty || (replaying && now - this.#lastMinimap >= MINIMAP_INTERVAL))
    ) {
      for (const minimap of this.#minimaps.values()) minimap?.update(mapFrame);
      this.#minimapDirty = false;
      this.#lastMinimap = now;
    }
  }

  sceneChanged(): void {
    const f = this.#frames;
    f.main = f.before = f.after = null;
    this.#renderer?.setTheme(this.#session.scene?.theme ?? this.#session.theme);
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
    if (this.#session.now() - this.#lastUserCamera < USER_CAMERA_GRACE) return;
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
   * union layer, which holds every state a replay or swipe passes through (and both versions,
   * so stages pinned to one version frame alike). Insets depend on what is framed, which
   * depends on the zoom they allow: they are settled once more.
   */
  #fitTarget(): { bounds: Rect; insets: Insets } | null {
    const s = this.#session;
    const layout = this.#chrome?.();
    const resolver = s.resolver;
    if (!layout || !resolver || !(layout.width > 0) || !(layout.height > 0)) return null;
    const frame = resolver.resolve(
      createViewState({
        layer: 'union',
        focus: s.focus,
        families: s.families,
        reducedMotion: s.reducedMotion,
      }),
    );
    const footprint = labelFootprint(frame, s.theme);
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
    const scene = this.#session.scene;
    if (!scene) return null;
    const focus = this.#session.focus;
    const cached = this.#boundsCache;
    if (cached && cached.scene === scene && cached.focus === focus) return cached.rect;
    const rect = focus ? focusBounds(scene, focus) : frameBounds(scene);
    this.#boundsCache = { scene, focus, rect };
    return rect;
  }

  /** Whether everything drawn is in view; the minimaps hide while it is. */
  #updateOverview(): void {
    const bounds = this.#contentBounds();
    const view = this.#renderer?.camera.viewport();
    const next = !bounds || !view || coverage(bounds, view) >= OVERVIEW_COVERAGE;
    if (next === this.overview) return;
    this.overview = next;
    this.#session.notify('overview');
  }

  zoom(direction: 1 | -1): void {
    this.noteUserCamera();
    this.#renderer?.camera.zoomBy(direction > 0 ? 1.4 : 1 / 1.4);
  }

  // ─── Canvas events ────────────────────────────────────────────────────────

  #onHover(pick: PickResult | null): void {
    this.#session.setHover(
      pick?.type === 'node' ? pick.index : -1,
      pick?.type === 'edge' ? pick.index : -1,
      pick?.type === 'collapsed' ? pick.index : -1,
    );
  }

  #onCanvasClick(pick: PickResult | null): void {
    if (!this.selectOnClick) return;
    const s = this.#session;
    if (!pick) {
      s.clearSelection();
      return;
    }
    switch (pick.type) {
      case 'node':
        s.selectNode(pick.index, { fly: false });
        break;
      case 'edge': {
        const e = s.scene?.edges[pick.index];
        if (e && e.hunk >= 0) s.selectHunk(e.hunk, { fly: false });
        s.pinnedEdge = pick.index;
        s.invalidate();
        break;
      }
      case 'collapsed':
        s.expandGroup(pick.index);
        break;
      default:
        break;
    }
  }

  #onCanvasDblClick(pick: PickResult | null): void {
    if (!this.selectOnClick || pick?.type !== 'node') return;
    const s = this.#session;
    const n = s.scene?.nodes[pick.index];
    if (!n) return;
    if (n.hunk >= 0) s.flyToHunk(n.hunk);
    else s.flyToNode(pick.index);
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
