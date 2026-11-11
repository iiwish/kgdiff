/**
 * Glyph passes. Lines (merge / split / move / replacement arrows, edge ghosts, dotted
 * suggestions with a `?` mark) are drawn above edges and below nodes, trimmed at `r1` / `r2`
 * like edges; pivots are drawn above nodes so the dot on the shared endpoint stays visible.
 * Edge ghosts (the before form of a retargeted / carried edge) are drawn like edges: the glyph's
 * own dash (`4 3` in overlays, solid while crossfading in replay) and an edge-sized arrowhead,
 * always shown since ghosts only exist for changed edges.
 * Kinds this renderer does not know degrade to a plain line, so new scene kinds never break it.
 */
import type { FrameVisuals, GlyphVisual, Theme } from '@kgdiff/scene';
import { type Ctx2D, NO_DASH } from '../ctx.js';
import type { FrameCache } from '../frame-cache.js';
import { TAU } from '../math.js';
import type { Fonts } from '../text.js';
import { LINK_ARROW, linkMidpoint, linkPath, outlineTrim } from './link.js';
import { arrowPath } from './shapes.js';
import { ARROW_GAP, CULL_MARGIN, NODE_MIN_R, type View } from './view.js';

/** Default suggestion pattern: round dots every 4 px. */
export const SUGGESTION_DASH: readonly number[] = Object.freeze([0.001, 4]);
/** Radius (px) of the suggestion `?` mark. */
export const SUGGESTION_MARK_R = 7;

export interface GlyphStyle {
  /** Arrowhead at the end (a glyph's own `arrow` flag, when present, overrides it). */
  readonly arrow: boolean;
  /** Pattern used when the glyph has no `dash`. */
  readonly dash: readonly number[] | null;
  /** `?` mark at the midpoint. */
  readonly mark: boolean;
}

const ARC: GlyphStyle = { arrow: true, dash: null, mark: false };
const SUGGESTION: GlyphStyle = { arrow: false, dash: SUGGESTION_DASH, mark: true };
const PLAIN: GlyphStyle = { arrow: false, dash: null, mark: false };

/** How a glyph kind is drawn; unknown kinds (newer scenes) are a plain line. */
export function glyphStyle(kind: string): GlyphStyle {
  switch (kind) {
    case 'merge-arrow':
    case 'split-arrow':
    case 'move-arrow':
    case 'replacement-arrow':
    case 'edge-ghost':
      return ARC;
    case 'suggestion':
      return SUGGESTION;
    default:
      return PLAIN;
  }
}

/** World radius → screen trim (px); 0 when the endpoint is not a node. */
function trim(r: number, k: number): number {
  return r > 0 && Number.isFinite(r) ? Math.max(r * k, NODE_MIN_R) : 0;
}

const tip = new Float64Array(4);

export function drawGlyphArcs(
  ctx: Ctx2D,
  frame: FrameVisuals,
  cache: FrameCache,
  v: View,
  theme: Theme,
  fonts: Fonts,
): void {
  const { k, ox, oy } = v;
  const minX = v.x0 - CULL_MARGIN;
  const maxX = v.x1 + CULL_MARGIN;
  const minY = v.y0 - CULL_MARGIN;
  const maxY = v.y1 + CULL_MARGIN;
  for (const i of cache.glyphArcs) {
    const g = frame.glyphs[i]!;
    const x1 = g.x1 * k + ox;
    const y1 = g.y1 * k + oy;
    const x2 = g.x2 * k + ox;
    const y2 = g.y2 * k + oy;
    const c = Number.isFinite(g.curvature) ? g.curvature : 0;
    const cx = (x1 + x2) / 2 - (y2 - y1) * c;
    const cy = (y1 + y2) / 2 + (x2 - x1) * c;
    if (
      Math.max(x1, x2, cx) < minX ||
      Math.min(x1, x2, cx) > maxX ||
      Math.max(y1, y2, cy) < minY ||
      Math.min(y1, y2, cy) > maxY
    ) {
      continue;
    }
    const style = glyphStyle(g.kind);
    const own = (g as GlyphVisual & { readonly arrow?: boolean }).arrow;
    const arrow = typeof own === 'boolean' ? own : style.arrow;
    const r1 = trim(g.r1, k);
    const r2 = trim(g.r2, k);
    const t1 = g.shape1 && r1 > 0 ? outlineTrim(g.shape1, r1, x1, y1, x2, y2, c, false) : r1;
    const t2 = g.shape2 && r2 > 0 ? outlineTrim(g.shape2, r2, x1, y1, x2, y2, c, true) : r2;
    const dash = g.dash !== null && g.dash.length > 0 ? g.dash : style.dash;
    ctx.globalAlpha = g.alpha;
    ctx.strokeStyle = g.color;
    ctx.lineWidth = g.width;
    ctx.setLineDash(dash ?? NO_DASH);
    ctx.lineDashOffset = 0;
    ctx.lineCap = dash === null || (dash[0] ?? 0) < 0.5 ? 'round' : 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const res = linkPath(
      ctx,
      x1,
      y1,
      x2,
      y2,
      c,
      t1,
      t2 > 0 && arrow ? t2 + ARROW_GAP : t2,
      g.progress,
      false,
      arrow,
      tip,
    );
    ctx.stroke();
    if (res === LINK_ARROW) {
      ctx.fillStyle = g.color;
      ctx.beginPath();
      arrowPath(ctx, tip[0]!, tip[1]!, tip[2]!, tip[3]!);
      ctx.fill();
    }
    if (style.mark && g.progress >= 1 && Math.hypot(x2 - x1, y2 - y1) > 6 * SUGGESTION_MARK_R) {
      const [mx, my] = linkMidpoint(x1, y1, x2, y2, c);
      ctx.setLineDash(NO_DASH);
      ctx.beginPath();
      ctx.arc(mx, my, SUGGESTION_MARK_R, 0, TAU);
      ctx.fillStyle = theme.canvas.background;
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.fillStyle = g.color;
      ctx.font = fonts.get(10, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', mx, my + 0.5);
    }
  }
}

export function drawPivots(
  ctx: Ctx2D,
  frame: FrameVisuals,
  cache: FrameCache,
  v: View,
  theme: Theme,
): void {
  const { k, ox, oy } = v;
  for (const i of cache.pivots) {
    const g = frame.glyphs[i]!;
    const x = g.x1 * k + ox;
    const y = g.y1 * k + oy;
    // A dot of diameter `width` px, separated from what is under it by a background outline.
    const r = Math.max(1.5, g.width / 2);
    if (x + r < v.x0 || x - r > v.x1 || y + r < v.y0 || y - r > v.y1) continue;
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = theme.canvas.background;
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = g.color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
}
