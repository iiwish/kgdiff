/**
 * `createRenderer`: DOM wiring around the painter.
 *
 * - One canvas sized in device pixels (ResizeObserver, `device-pixel-content-box` when
 *   supported), `pixelRatio ≤ 3`; resizes repaint synchronously, so there is never a blank frame.
 * - One requestAnimationFrame loop that runs only while something is dirty or animating: the
 *   camera advances, `camera` fires (once per frame), hover is picked (once per frame), the
 *   frame is painted and `frame` fires. Idle = no callbacks at all.
 */
import type { Rect } from '@kgdiff/core';
import { KgdiffError } from '@kgdiff/core';
import type { FrameVisuals, Theme } from '@kgdiff/scene';
import { CameraController, type Insets, NO_INSETS, type Size } from './camera.js';
import { type Ctx2D, domSurfaceFactory, type SurfaceFactory } from './ctx.js';
import { FrameCache, unionBounds } from './frame-cache.js';
import type {
  CameraState,
  PickResult,
  Renderer,
  RendererEvents,
  RendererLayer,
  RendererOptions,
  SplitFrame,
} from './index.js';
import { attachInput } from './input.js';
import { clamp } from './math.js';
import { isSplit, LABEL_RASTER_BUDGET, NO_LAYERS, Painter, Resources, splitX } from './paint.js';
import { pickAt } from './pick.js';

/** Test seams and platform overrides (not part of the public API). */
export interface RendererDeps {
  /** Context to draw into instead of `canvas.getContext('2d')` (null = no drawing). */
  readonly context?: Ctx2D | null;
  readonly surfaceFactory?: SurfaceFactory;
  readonly now?: () => number;
  readonly requestFrame?: (cb: (time: number) => void) => number;
  readonly cancelFrame?: (id: number) => void;
}

/** What the minimap needs from its renderer beyond the public API. */
export interface RendererInternals {
  theme(): Theme;
  pixelRatio(): number;
  size(): Size;
  onTheme(listener: (theme: Theme) => void): () => void;
  /** Move the camera on behalf of the user (minimap drags): `camera` reports source 'user'. */
  userSet(state: CameraState): void;
  readonly requestFrame: (cb: (time: number) => void) => number;
  readonly cancelFrame: (id: number) => void;
}

export const internals = new WeakMap<Renderer, RendererInternals>();

type Listeners = { [K in keyof RendererEvents]: Set<(event: RendererEvents[K]) => void> };

const MAX_PIXEL_RATIO = 3;

function samePick(a: PickResult | null, b: PickResult | null): boolean {
  return a === b || (a !== null && b !== null && a.type === b.type && a.index === b.index);
}

function windowRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

class CanvasRenderer implements Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly camera: CameraController;
  private readonly ctx: Ctx2D | null;
  private theme: Theme;
  private safe: Insets;
  private readonly grid: boolean;
  private readonly fixedRatio: number | undefined;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private frame: FrameVisuals | SplitFrame | null = null;
  private version = 0;
  private readonly caches = {
    main: new FrameCache(),
    before: new FrameCache(),
    after: new FrameCache(),
  };
  private readonly res: Resources;
  private readonly painter: Painter;
  private readonly listeners: Listeners = {
    hover: new Set(),
    click: new Set(),
    dblclick: new Set(),
    camera: new Set(),
    frame: new Set(),
  };
  private readonly themeListeners = new Set<(theme: Theme) => void>();
  private readonly cleanup: (() => void)[] = [];
  private readonly now: () => number;
  private readonly requestFrame: (cb: (time: number) => void) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly motionQuery: MediaQueryList | null;
  private rafId = 0;
  private dirty = true;
  private busy = false;
  private destroyed = false;
  private cameraChanged = true;
  /** The viewport changed size: `camera` fires even if the state did not change. */
  private viewportChanged = true;
  private emitted: CameraState | null = null;
  private autoFitted = false;
  private pointer: { x: number; y: number } | null = null;
  private hoverPending = false;
  private hovered: PickResult | null = null;
  private dragging = false;

  constructor(container: HTMLElement, options: RendererOptions, deps: RendererDeps) {
    const minZoom = options.minZoom ?? 0.05;
    const maxZoom = options.maxZoom ?? 6;
    if (!(minZoom > 0) || !(maxZoom >= minZoom) || !Number.isFinite(maxZoom)) {
      throw new KgdiffError(
        'invalid-input',
        `createRenderer: expected 0 < minZoom ≤ maxZoom, got minZoom ${minZoom}, maxZoom ${maxZoom}`,
      );
    }
    if (options.pixelRatio !== undefined && !(options.pixelRatio > 0)) {
      throw new KgdiffError(
        'invalid-input',
        `createRenderer: pixelRatio must be > 0, got ${options.pixelRatio}`,
      );
    }
    this.theme = options.theme;
    this.safe = options.safeArea ?? NO_INSETS;
    this.grid = options.grid ?? true;
    this.fixedRatio = options.pixelRatio;
    this.now = deps.now ?? (() => performance.now());
    this.requestFrame =
      deps.requestFrame ??
      ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0));
    this.cancelFrame =
      deps.cancelFrame ??
      ((id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : undefined));
    this.motionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    const st = canvas.style;
    st.position = 'absolute';
    st.left = '0';
    st.top = '0';
    st.width = '100%';
    st.height = '100%';
    st.display = 'block';
    st.touchAction = 'none';
    st.userSelect = 'none';
    st.setProperty('-webkit-user-select', 'none');
    st.setProperty('-webkit-tap-highlight-color', 'transparent');
    st.outline = 'none';
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx =
      deps.context !== undefined ? deps.context : canvas.getContext('2d', { alpha: false });

    this.camera = new CameraController(
      {
        size: () => ({ width: this.width, height: this.height }),
        safeArea: () => this.safe,
        contentBounds: () => this.contentBounds(),
        reducedMotion: () => this.motionQuery?.matches ?? false,
        invalidate: () => {
          this.cameraChanged = true;
          if (this.pointer) this.hoverPending = true;
          this.requestRender();
        },
      },
      minZoom,
      maxZoom,
    );
    this.res = new Resources(deps.surfaceFactory ?? domSurfaceFactory, this.theme, this.ctx);
    this.painter = new Painter(this.res);
    this.painter.labelsInside = options.labelsInside ?? false;

    this.observeSize();
    this.watchPixelRatio();
    this.watchFonts();
    if (options.interactive ?? true) {
      this.cleanup.push(
        attachInput(canvas, {
          camera: this.camera,
          hover: (x, y) => {
            this.pointer = { x, y };
            this.hoverPending = true;
            this.schedule();
          },
          leave: () => {
            this.pointer = null;
            this.setHover(null);
          },
          click: (x, y, event) => {
            this.emit('click', {
              pick: this.pick(x, y),
              world: this.camera.screenToWorld({ x, y }),
              event,
            });
          },
          dblclick: (x, y, event) => {
            this.emit('dblclick', {
              pick: this.pick(x, y),
              world: this.camera.screenToWorld({ x, y }),
              event,
            });
          },
          dragging: (active) => {
            this.dragging = active;
            this.canvas.style.cursor = active ? 'grabbing' : '';
            if (active) this.setHover(null);
            else if (this.pointer) {
              this.hoverPending = true;
              this.schedule();
            }
          },
          now: this.now,
        }),
      );
    }
    internals.set(this, {
      theme: () => this.theme,
      pixelRatio: () => this.dpr,
      size: () => ({ width: this.width, height: this.height }),
      userSet: (state) => this.camera.set(state, 'user'),
      onTheme: (listener) => {
        this.themeListeners.add(listener);
        return () => this.themeListeners.delete(listener);
      },
      requestFrame: this.requestFrame,
      cancelFrame: this.cancelFrame,
    });
    this.resize();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  setFrame(frame: FrameVisuals | SplitFrame): void {
    if (this.destroyed) return;
    this.frame = frame;
    this.version++;
    if (this.pointer) this.hoverPending = true;
    this.requestRender();
  }

  setTheme(theme: Theme): void {
    if (this.destroyed || theme === this.theme) return;
    this.theme = theme;
    this.res.setTheme(theme);
    for (const fn of this.themeListeners) fn(theme);
    this.requestRender();
  }

  setSafeArea(area: { top: number; right: number; bottom: number; left: number }): void {
    this.safe = { top: area.top, right: area.right, bottom: area.bottom, left: area.left };
  }

  setLabelsInside(inside: boolean): void {
    if (this.destroyed || this.painter.labelsInside === inside) return;
    this.painter.labelsInside = inside;
    this.dirty = true;
    this.requestRender();
  }

  pick(x: number, y: number): PickResult | null {
    const f = this.frame;
    if (!f || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const k = this.camera.k;
    const view = {
      k,
      ox: this.width / 2 - this.camera.x * k,
      oy: this.height / 2 - this.camera.y * k,
      dpr: this.dpr,
    };
    let frame: FrameVisuals;
    let cache: FrameCache;
    if (isSplit(f)) {
      const left = x < splitX(f.split, this.width, this.dpr);
      frame = left ? f.before : f.after;
      cache = left ? this.caches.before : this.caches.after;
    } else {
      frame = f;
      cache = this.caches.main;
    }
    cache.sync(frame, this.version, this.res.interner);
    return pickAt(frame, cache, view, x, y, this.res.fonts, this.res.measurer);
  }

  addLayer(layer: RendererLayer): () => void {
    const order = layer?.order;
    if ((order !== 'under' && order !== 'over') || typeof layer.draw !== 'function') {
      throw new KgdiffError(
        'invalid-input',
        "addLayer: expected { order: 'under' | 'over', draw(ctx, view) }",
      );
    }
    if (this.destroyed) return () => undefined;
    // The painter's lists are replaced, not mutated: a layer may add or remove while it draws.
    const p = this.painter;
    p[order] = [...p[order], layer];
    this.requestRender();
    let added = true;
    return () => {
      if (!added) return;
      added = false;
      const at = p[order].lastIndexOf(layer);
      if (at < 0) return; // the renderer was destroyed
      const rest = p[order].filter((_, i) => i !== at);
      p[order] = rest.length > 0 ? rest : NO_LAYERS;
      this.requestRender();
    };
  }

  on<K extends keyof RendererEvents>(
    type: K,
    listener: (event: RendererEvents[K]) => void,
  ): () => void {
    const set = this.listeners[type];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  resize(): void {
    if (this.destroyed) return;
    this.applySize(this.canvas.clientWidth, this.canvas.clientHeight, null);
    this.draw();
  }

  requestRender(): void {
    if (this.destroyed) return;
    this.dirty = true;
    if (!this.busy) this.schedule();
  }

  toDataURL(scale?: number): string {
    const s = scale !== undefined && scale > 0 ? Math.min(scale, 8) : this.dpr;
    if (!this.ctx) return this.canvas.toDataURL('image/png');
    if (s === this.dpr) {
      // Exports contain every label: no per-frame raster budget.
      this.painter.rasterBudget = Number.POSITIVE_INFINITY;
      this.draw();
      this.painter.rasterBudget = LABEL_RASTER_BUDGET;
      return this.canvas.toDataURL('image/png');
    }
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(this.width * s));
    out.height = Math.max(1, Math.round(this.height * s));
    const ctx = out.getContext('2d', { alpha: false });
    if (!ctx) return this.canvas.toDataURL('image/png');
    this.painter.rasterBudget = Number.POSITIVE_INFINITY;
    this.painter.paint(
      { ctx, width: this.width, height: this.height, dpr: s },
      this.camera,
      this.frame,
      this.caches,
      this.version,
      this.theme,
      this.grid,
    );
    this.painter.rasterBudget = LABEL_RASTER_BUDGET;
    this.dirty = true; // pixel-ratio caches were re-keyed for the export
    this.schedule();
    return out.toDataURL('image/png');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId) this.cancelFrame(this.rafId);
    this.rafId = 0;
    this.camera.stop();
    for (const fn of this.cleanup.splice(0)) fn();
    for (const set of Object.values(this.listeners)) set.clear();
    this.themeListeners.clear();
    this.painter.under = NO_LAYERS;
    this.painter.over = NO_LAYERS;
    this.canvas.remove();
    internals.delete(this);
  }

  // ─── Loop ─────────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.rafId === 0 && !this.destroyed) this.rafId = this.requestFrame(this.tick) || 0;
  }

  private readonly tick = (time: number): void => {
    this.rafId = 0;
    if (this.destroyed) return;
    this.busy = true;
    try {
      this.camera.tick(time);
      this.emitCamera();
      if (this.hoverPending) this.updateHover();
    } finally {
      this.busy = false;
    }
    if (this.dirty) this.draw();
    if (this.camera.animating) this.schedule();
  };

  private draw(): void {
    if (this.destroyed) return;
    const ctx = this.ctx;
    if (!ctx || this.width <= 0 || this.height <= 0) {
      this.dirty = false;
      return;
    }
    this.busy = true;
    try {
      this.autoFit();
      this.dirty = false;
      const t0 = this.now();
      this.painter.paint(
        { ctx, width: this.width, height: this.height, dpr: this.dpr },
        this.camera,
        this.frame,
        this.caches,
        this.version,
        this.theme,
        this.grid,
      );
      const ms = this.now() - t0;
      // Labels the raster budget left for the next frame.
      if (this.painter.stats.deferredLabels > 0) this.dirty = true;
      this.emitCamera();
      this.emit('frame', { ms });
    } finally {
      this.busy = false;
    }
    if (this.dirty) this.schedule();
  }

  /** The first frame with content is fitted (as a jump) unless the camera was used already. */
  private autoFit(): void {
    if (this.autoFitted || this.camera.touched || !this.frame) return;
    const bounds = this.contentBounds();
    if (!bounds) return;
    this.autoFitted = true;
    this.camera.jump(this.camera.targetFor(bounds, {}, { width: this.width, height: this.height }));
  }

  private emitCamera(): void {
    if (!this.cameraChanged) return;
    this.cameraChanged = false;
    const s = this.camera.get();
    const e = this.emitted;
    const resized = this.viewportChanged;
    this.viewportChanged = false;
    const source = this.camera.takeSource();
    if (!resized && e && e.x === s.x && e.y === s.y && e.k === s.k) return;
    this.emitted = s;
    this.emit('camera', { x: s.x, y: s.y, k: s.k, source });
  }

  private updateHover(): void {
    this.hoverPending = false;
    if (!this.pointer || this.dragging) return;
    this.setHover(this.pick(this.pointer.x, this.pointer.y));
  }

  private setHover(pick: PickResult | null): void {
    if (samePick(pick, this.hovered)) return;
    this.hovered = pick;
    if (!this.dragging) this.canvas.style.cursor = pick ? 'pointer' : '';
    this.emit('hover', pick);
  }

  private emit<K extends keyof RendererEvents>(type: K, event: RendererEvents[K]): void {
    for (const fn of this.listeners[type]) fn(event);
  }

  private contentBounds(): Rect | null {
    const f = this.frame;
    if (!f) return null;
    const { interner } = this.res;
    if (isSplit(f)) {
      this.caches.before.sync(f.before, this.version, interner);
      this.caches.after.sync(f.after, this.version, interner);
      return unionBounds(this.caches.before.contentBounds(), this.caches.after.contentBounds());
    }
    this.caches.main.sync(f, this.version, interner);
    return this.caches.main.contentBounds();
  }

  // ─── Size, pixel ratio, fonts ─────────────────────────────────────────────

  private pixelRatio(): number {
    return clamp(this.fixedRatio ?? windowRatio(), 0.25, MAX_PIXEL_RATIO);
  }

  private applySize(width: number, height: number, device: readonly [number, number] | null): void {
    const dpr = this.pixelRatio();
    const exact =
      device !== null && this.fixedRatio === undefined && windowRatio() <= MAX_PIXEL_RATIO;
    const bw = Math.max(1, exact ? device[0] : Math.round(width * dpr));
    const bh = Math.max(1, exact ? device[1] : Math.round(height * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    const changed = width !== this.width || height !== this.height || dpr !== this.dpr;
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.dpr = dpr;
    if (changed) {
      this.cameraChanged = true;
      this.viewportChanged = true;
      this.camera.resized();
    }
    this.dirty = true;
  }

  private observeSize(): void {
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((entries) => {
      if (this.destroyed) return;
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      const width = box ? box.inlineSize : entry.contentRect.width;
      const height = box ? box.blockSize : entry.contentRect.height;
      const dev = entry.devicePixelContentBoxSize?.[0];
      this.applySize(width, height, dev ? [dev.inlineSize, dev.blockSize] : null);
      this.draw(); // synchronously, before the browser paints the cleared canvas
    });
    try {
      ro.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(this.canvas);
    }
    this.cleanup.push(() => ro.disconnect());
  }

  private watchPixelRatio(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList | null = null;
    const onChange = (): void => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${windowRatio()}dppx)`);
      query.addEventListener('change', onChange);
      if (!this.destroyed && this.pixelRatio() !== this.dpr) this.resize();
    };
    query = window.matchMedia(`(resolution: ${windowRatio()}dppx)`);
    query.addEventListener('change', onChange);
    this.cleanup.push(() => query?.removeEventListener('change', onChange));
  }

  private watchFonts(): void {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.addEventListener !== 'function') return;
    const onLoaded = (): void => {
      this.res.fontsChanged();
      this.requestRender();
    };
    fonts.addEventListener('loadingdone', onLoaded);
    this.cleanup.push(() => fonts.removeEventListener('loadingdone', onLoaded));
  }
}

/** Implementation of `createRenderer` with optional test seams. */
export function createRendererImpl(
  container: HTMLElement,
  options: RendererOptions,
  deps: RendererDeps = {},
): Renderer {
  if (!container || typeof container.appendChild !== 'function') {
    throw new KgdiffError('invalid-input', 'createRenderer: container must be an HTMLElement');
  }
  return new CanvasRenderer(container, options, deps);
}
