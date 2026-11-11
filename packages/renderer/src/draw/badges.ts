/** Badge pass: compact change summaries (`+2 −1 ~1`, `⊕ 3`) as pills at a node's upper right. */
import { type FrameVisuals, shapeDistance, shapeVertices, type Theme } from '@kgdiff/scene';
import type { Ctx2D } from '../ctx.js';
import type { FrameCache } from '../frame-cache.js';
import type { CollisionGrid } from '../labels.js';
import { snap } from '../math.js';
import type { Fonts, TextMeasurer } from '../text.js';
import { roundRectPath } from './shapes.js';
import { NODE_MIN_R, type View } from './view.js';

export const BADGE_HEIGHT = 15;
export const BADGE_PAD_X = 5;
export const BADGE_FONT_SIZE = 10;

/**
 * Badges are laid out before label placement (they are obstacles labels and pills avoid) and
 * drawn after nodes. The pill gets an opaque background first so its translucent tint reads the
 * same over edges and over empty canvas.
 */
export class BadgePass {
  /** x, y, w, h, node index per laid-out badge. */
  private boxes = new Float64Array(5 * 32);
  private count = 0;
  private font = '';

  /** Compute visible badge boxes and register them in `obstacles`. */
  layout(
    frame: FrameVisuals,
    cache: FrameCache,
    v: View,
    fonts: Fonts,
    measurer: TextMeasurer,
    obstacles: CollisionGrid,
  ): void {
    this.count = 0;
    if (cache.badges.length === 0) return;
    const { k, ox, oy, dpr } = v;
    const font = fonts.get(BADGE_FONT_SIZE, 600, true);
    this.font = font;
    for (const i of cache.badges) {
      const n = frame.nodes[i]!;
      const badge = n.badge!;
      if (k < badge.minZoom || n.alpha < 0.02) continue;
      // Anchor on the outermost outline (ring included) so the pill never covers it.
      const ring = n.ring;
      const nodeR = Math.max(n.r * k, NODE_MIN_R);
      const grow = ring ? ring.gap + ring.width / 2 : 0;
      // Where the outline meets the diagonal to the upper right, per axis (0.7 · r on a disc).
      const reach =
        shapeVertices(n.shape).length > 0
          ? shapeDistance(n.shape, nodeR, grow, Math.SQRT1_2, -Math.SQRT1_2) * Math.SQRT1_2
          : (nodeR + grow) * 0.7;
      const w = Math.ceil(measurer.width(font, badge.text)) + 2 * BADGE_PAD_X;
      const h = BADGE_HEIGHT;
      const bx = snap(n.x * k + ox + reach - 2, dpr);
      const by = snap(n.y * k + oy - reach - h + 2, dpr);
      if (bx + w < v.x0 || bx > v.x1 || by + h < v.y0 || by > v.y1) continue;
      obstacles.insert(bx - 1, by - 1, w + 2, h + 2);
      if (this.boxes.length < (this.count + 1) * 5) {
        const next = new Float64Array(this.boxes.length * 2);
        next.set(this.boxes);
        this.boxes = next;
      }
      const o = this.count++ * 5;
      this.boxes[o] = bx;
      this.boxes[o + 1] = by;
      this.boxes[o + 2] = w;
      this.boxes[o + 3] = h;
      this.boxes[o + 4] = i;
    }
  }

  /** Draw the badges laid out by `layout`. */
  draw(ctx: Ctx2D, frame: FrameVisuals, theme: Theme): void {
    if (this.count === 0) return;
    ctx.font = this.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let b = 0; b < this.count; b++) {
      const o = b * 5;
      const bx = this.boxes[o]!;
      const by = this.boxes[o + 1]!;
      const w = this.boxes[o + 2]!;
      const h = this.boxes[o + 3]!;
      const n = frame.nodes[this.boxes[o + 4]!]!;
      const badge = n.badge;
      if (!badge) continue;
      ctx.globalAlpha = n.alpha;
      ctx.beginPath();
      roundRectPath(ctx, bx, by, w, h, h / 2);
      ctx.fillStyle = theme.canvas.background;
      ctx.fill();
      ctx.fillStyle = badge.background;
      ctx.fill();
      ctx.fillStyle = badge.color;
      ctx.fillText(badge.text, bx + w / 2, by + h / 2 + 0.5);
    }
  }
}
