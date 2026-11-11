/**
 * Halo pass. Dark themes: soft radial glows blitted from one cached gradient sprite per color.
 * Light themes: crisp offset rings at `r + 5` px, the node's outline grown by that much.
 */
import { type FrameVisuals, shapeVertexRadius, shapeVertices, type Theme } from '@kgdiff/scene';
import { parseColor, rgbaString } from '../color.js';
import { type Ctx2D, NO_DASH, type Surface, type SurfaceFactory } from '../ctx.js';
import type { FrameCache } from '../frame-cache.js';
import { TAU } from '../math.js';
import { polygonPath } from './shapes.js';
import { CULL_MARGIN, HALO_RING_OFFSET, HALO_RING_WIDTH, NODE_MIN_R, type View } from './view.js';

/** Glow falloff: (radius fraction, alpha) — a soft, roughly Gaussian profile. */
const GLOW_STOPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.3, 0.9],
  [0.5, 0.6],
  [0.7, 0.28],
  [0.86, 0.08],
  [1, 0],
];
const SPRITE_SIZE = 128;

export class HaloSprites {
  private readonly cache = new Map<string, Surface | null>();

  constructor(private readonly factory: SurfaceFactory) {}

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  sprite(color: string): Surface | null {
    let s = this.cache.get(color);
    if (s === undefined) {
      s = this.make(color);
      if (this.cache.size > 64) this.cache.clear();
      this.cache.set(color, s);
    }
    return s;
  }

  private make(color: string): Surface | null {
    const s = this.factory(SPRITE_SIZE, SPRITE_SIZE);
    if (!s) return null;
    const h = SPRITE_SIZE / 2;
    const g = s.ctx.createRadialGradient(h, h, 0, h, h, h);
    const rgba = parseColor(color);
    for (const [t, a] of GLOW_STOPS) {
      g.addColorStop(t, rgba ? rgbaString(rgba, a) : a > 0 ? color : 'rgba(0, 0, 0, 0)');
    }
    s.ctx.fillStyle = g;
    s.ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    return s;
  }
}

export function drawHalos(
  ctx: Ctx2D,
  frame: FrameVisuals,
  cache: FrameCache,
  v: View,
  theme: Theme,
  sprites: HaloSprites,
): void {
  const { k, ox, oy } = v;
  if (!theme.glow) {
    ctx.lineWidth = HALO_RING_WIDTH;
    ctx.setLineDash(NO_DASH);
  }
  for (const i of cache.halos) {
    const n = frame.nodes[i]!;
    const halo = n.halo!;
    const a = halo.alpha * n.alpha;
    if (a < 0.01) continue;
    const x = n.x * k + ox;
    const y = n.y * k + oy;
    const r = Math.max(n.r * k, NODE_MIN_R);
    // Light halos sit at r + 5 px, pushed outside a concentric ring when the node has one.
    const ring = n.ring;
    const ringOuter = ring ? r + ring.gap + ring.width / 2 : 0;
    const base = Math.max(halo.radius * k, NODE_MIN_R); // light themes: radius = r
    const lightR = Math.max(base + HALO_RING_OFFSET, ringOuter + 1.5 + HALO_RING_WIDTH / 2);
    const hr = theme.glow ? Math.max(halo.radius * k, r * 1.6) : lightR + HALO_RING_WIDTH;
    if (x + hr < v.x0 - CULL_MARGIN || x - hr > v.x1 + CULL_MARGIN) continue;
    if (y + hr < v.y0 - CULL_MARGIN || y - hr > v.y1 + CULL_MARGIN) continue;
    ctx.globalAlpha = a;
    if (theme.glow) {
      const s = sprites.sprite(halo.color);
      if (s) ctx.drawImage(s.canvas, x - hr, y - hr, hr * 2, hr * 2);
    } else {
      ctx.strokeStyle = halo.color;
      ctx.beginPath();
      const vertices = shapeVertices(n.shape);
      if (vertices.length > 0) {
        ctx.lineJoin = 'round';
        polygonPath(ctx, vertices, x, y, shapeVertexRadius(n.shape, r, lightR - r));
      } else ctx.arc(x, y, lightR, 0, TAU);
      ctx.stroke();
    }
  }
}
