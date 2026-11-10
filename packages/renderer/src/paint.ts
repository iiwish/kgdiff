/**
 * Paints one frame (or a swipe pair) into a `Ctx2D`. Pass order (docs/visual-language.md):
 * background + grid → the host's `under` layers → collapsed pills → edges → glyph arcs → halos
 * → nodes (+ rings, pulses) → pivots → badges → labels → the host's `over` layers. Swipe draws
 * the background once, then each side clipped to its half with its own label placement and its
 * own call of every layer.
 */

import type { FrameVisuals, Theme } from '@kgdiff/scene';
import { LabelAtlas } from './atlas.js';
import { type Ctx2D, NO_DASH, type SurfaceFactory } from './ctx.js';
import { drawBackground, GridTiles } from './draw/background.js';
import { BadgePass } from './draw/badges.js';
import { drawCollapsed } from './draw/collapsed.js';
import { drawEdges } from './draw/edges.js';
import { drawGlyphArcs, drawPivots } from './draw/glyphs.js';
import { drawHalos, HaloSprites } from './draw/halos.js';
import { LabelPass } from './draw/labels.js';
import { drawNodes } from './draw/nodes.js';
import type { View } from './draw/view.js';
import { type FrameCache, Interner } from './frame-cache.js';
import type { CameraState, LayerView, RendererLayer, SplitFrame } from './index.js';
import { CollisionGrid } from './labels.js';
import { clamp, snap } from './math.js';
import { createStats, type PaintStats, resetStats } from './paint-stats.js';
import { Fonts, TextMeasurer } from './text.js';

export function isSplit(frame: FrameVisuals | SplitFrame): frame is SplitFrame {
  return 'before' in frame && 'after' in frame && 'split' in frame;
}

/** Divider position (css px, on the device-pixel grid) for a split fraction. */
export function splitX(split: number, width: number, dpr: number): number {
  return snap(clamp(Number.isFinite(split) ? split : 0.5, 0, 1) * width, dpr);
}

/** Caches that live as long as a renderer: fonts, text metrics, sprites, atlas, tiles. */
export class Resources {
  readonly fonts: Fonts;
  readonly measurer: TextMeasurer;
  readonly atlas: LabelAtlas | null;
  readonly halos: HaloSprites;
  readonly tiles: GridTiles;
  readonly interner = new Interner();
  private dpr = 0;
  private theme: Theme;

  constructor(
    readonly factory: SurfaceFactory,
    theme: Theme,
    fallbackMeasureCtx: Ctx2D | null,
  ) {
    this.theme = theme;
    this.fonts = new Fonts(theme);
    // A private context for measuring, so measuring never disturbs drawing state.
    this.measurer = new TextMeasurer(factory(1, 1)?.ctx ?? fallbackMeasureCtx);
    this.atlas = new LabelAtlas(factory);
    this.halos = new HaloSprites(factory);
    this.tiles = new GridTiles(factory);
  }

  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.fonts.setTheme(theme);
    this.measurer.clear();
    this.halos.clear();
    this.tiles.clear();
    this.atlas?.configure(this.dpr || 1, theme.canvas.background);
  }

  /** Called before painting: re-keys pixel-ratio dependent caches. */
  prepare(dpr: number): void {
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.tiles.clear();
    this.atlas?.configure(dpr, this.theme.canvas.background);
  }

  /** Web fonts finished loading: metrics and rasterized labels are stale. */
  fontsChanged(): void {
    this.measurer.clear();
    this.atlas?.wipe();
  }
}

export interface PaintTarget {
  readonly ctx: Ctx2D;
  /** css px */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface PaintCaches {
  readonly main: FrameCache;
  readonly before: FrameCache;
  readonly after: FrameCache;
}

/** No host layers: the paint path without them (shared, so adding none allocates nothing). */
export const NO_LAYERS: readonly RendererLayer[] = Object.freeze([]);

/** What the layers of one side (or of the whole canvas) are told: a snapshot of this frame. */
function layerView(cam: CameraState, v: View, side: 'before' | 'after' | null): LayerView {
  const { k, ox, oy } = v;
  const view = {
    camera: { x: cam.x, y: cam.y, k: cam.k },
    viewport: {
      x: (v.x0 - ox) / k,
      y: (v.y0 - oy) / k,
      width: (v.x1 - v.x0) / k,
      height: (v.y1 - v.y0) / k,
    },
    pixelRatio: v.dpr,
    worldToScreen: (p: { readonly x: number; readonly y: number }) => ({
      x: p.x * k + ox,
      y: p.y * k + oy,
    }),
  };
  return side === null ? view : { ...view, side };
}

/** A layer that throws must not take the frame with it: report as an uncaught error would be. */
function reportLayerError(error: unknown): void {
  if (typeof reportError === 'function') reportError(error);
  else console.error('[kgdiff] a renderer layer threw:', error);
}

/** New label rasterizations per frame (≈ 3–5 ms of text rendering on mid-range hardware). */
export const LABEL_RASTER_BUDGET = 160;

export class Painter {
  readonly stats: PaintStats = createStats();
  /** Override for exports, which must contain every label in one paint. */
  rasterBudget = LABEL_RASTER_BUDGET;
  /** Labels never cross the canvas edges (one without room inside is left out). */
  labelsInside = false;
  /**
   * The host's layers (`Renderer.addLayer`), in the order added. Replaced, never mutated, so a
   * layer may add or remove layers while it draws.
   */
  under: readonly RendererLayer[] = NO_LAYERS;
  over: readonly RendererLayer[] = NO_LAYERS;
  private readonly labels = new LabelPass();
  private readonly badges = new BadgePass();
  private readonly grid = new CollisionGrid();
  private readonly view: View = {
    k: 1,
    ox: 0,
    oy: 0,
    width: 0,
    height: 0,
    dpr: 1,
    x0: 0,
    x1: 0,
    y0: 0,
    y1: 0,
    strictX: false,
    strictY: false,
    stats: this.stats,
  };

  constructor(private readonly res: Resources) {}

  paint(
    target: PaintTarget,
    cam: CameraState,
    frame: FrameVisuals | SplitFrame | null,
    caches: PaintCaches,
    version: number,
    theme: Theme,
    grid: boolean,
  ): PaintStats {
    const { ctx, width, height, dpr } = target;
    const v = this.view;
    resetStats(this.stats);
    this.res.prepare(dpr);
    this.res.atlas?.beginFrame(this.rasterBudget);
    v.k = cam.k;
    v.ox = width / 2 - cam.x * cam.k;
    v.oy = height / 2 - cam.y * cam.k;
    v.width = width;
    v.height = height;
    v.dpr = dpr;
    v.x0 = 0;
    v.x1 = width;
    v.y0 = 0;
    v.y1 = height;
    v.strictX = this.labelsInside;
    v.strictY = this.labelsInside;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    const split = frame !== null && isSplit(frame);
    const spotlight =
      frame === null
        ? 0
        : split
          ? Math.max(frame.before.spotlight, frame.after.spotlight)
          : frame.spotlight;
    drawBackground(ctx, v, theme, grid ? this.res.tiles : null, spotlight);
    this.stats.phases.push('background');
    if (frame === null) {
      // Layers are the host's picture, drawn from its own positions: a frame is not needed.
      if (this.under.length + this.over.length > 0) {
        const lv = layerView(cam, v, null);
        this.hostLayers(ctx, this.under, lv, 'under');
        this.hostLayers(ctx, this.over, lv, 'over');
      }
      return this.stats;
    }

    if (!split) {
      caches.main.sync(frame, version, this.res.interner);
      this.passes(ctx, frame, caches.main, theme, cam, null);
      return this.stats;
    }

    const sx = splitX(frame.split, width, dpr);
    caches.before.sync(frame.before, version, this.res.interner);
    caches.after.sync(frame.after, version, this.res.interner);
    if (sx > 0) {
      v.x0 = 0;
      v.x1 = sx;
      v.strictX = true;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, sx, height);
      ctx.clip();
      this.passes(ctx, frame.before, caches.before, theme, cam, 'before');
      ctx.restore();
    }
    if (sx < width) {
      v.x0 = sx;
      v.x1 = width;
      v.strictX = true;
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, 0, width - sx, height);
      ctx.clip();
      this.passes(ctx, frame.after, caches.after, theme, cam, 'after');
      ctx.restore();
    }
    if (sx > 0 && sx < width) {
      // 1 css px divider on whole device pixels.
      const w = Math.max(1, Math.round(dpr));
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.surface.borderStrong;
      ctx.fillRect(Math.round(sx * dpr - w / 2) / dpr, 0, w / dpr, height);
    }
    this.stats.phases.push('divider');
    return this.stats;
  }

  /**
   * The host's layers of one order, each between a `save` and a `restore`: whatever a layer
   * leaves on the context (styles, alpha, dash, transform, clip) ends with it.
   */
  private hostLayers(
    ctx: Ctx2D,
    layers: readonly RendererLayer[],
    lv: LayerView,
    phase: 'under' | 'over',
  ): void {
    if (layers.length === 0) return;
    for (let i = 0; i < layers.length; i++) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.setLineDash(NO_DASH);
      try {
        // `Ctx2D` is the slice of the context the renderer's passes use; a layer gets the
        // context itself, which in a browser is the canvas's `CanvasRenderingContext2D`.
        layers[i]!.draw(ctx as unknown as CanvasRenderingContext2D, lv);
      } catch (error) {
        reportLayerError(error);
      } finally {
        ctx.restore();
      }
    }
    this.stats.phases.push(phase);
  }

  /** One side (or the whole canvas): every pass, in the region `view` holds. */
  private passes(
    ctx: Ctx2D,
    frame: FrameVisuals,
    cache: FrameCache,
    theme: Theme,
    cam: CameraState,
    side: 'before' | 'after' | null,
  ): void {
    const v = this.view;
    const res = this.res;
    const phases = this.stats.phases;
    const lv = this.under.length + this.over.length > 0 ? layerView(cam, v, side) : null;
    if (lv) this.hostLayers(ctx, this.under, lv, 'under');
    // Screen-space layout first: node discs and badges are obstacles; labels and pills compete
    // for the rest by priority. Drawing then follows the documented pass order.
    this.labels.begin(frame, cache, v, this.grid);
    this.badges.layout(frame, cache, v, res.fonts, res.measurer, this.grid);
    this.labels.place(frame, cache, v, res, this.grid);
    drawCollapsed(ctx, frame.collapsed, cache.pillShown, v, theme, res.fonts, res.measurer);
    phases.push('collapsed');
    drawEdges(ctx, frame, cache, v);
    phases.push('edges');
    drawGlyphArcs(ctx, frame, cache, v, theme, res.fonts);
    phases.push('glyphs');
    drawHalos(ctx, frame, cache, v, theme, res.halos);
    phases.push('halos');
    drawNodes(ctx, frame, cache, v, theme);
    phases.push('nodes');
    drawPivots(ctx, frame, cache, v, theme);
    phases.push('pivots');
    this.badges.draw(ctx, frame, theme);
    phases.push('badges');
    this.stats.labels += this.labels.draw(ctx, v, theme, res);
    this.stats.deferredLabels = res.atlas?.deferred ?? 0;
    phases.push('labels');
    if (lv) this.hostLayers(ctx, this.over, lv, 'over');
  }
}
