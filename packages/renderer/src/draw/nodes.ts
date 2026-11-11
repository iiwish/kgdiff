/**
 * Node pass, per z level: style buckets (one path, one fill, one stroke each), then the
 * level's rings and replay pulses. Hollow ghosts are filled with the canvas background so
 * edges do not show through; their dashes are stretched to tile the outline evenly. A bucket
 * holds one shape, so polygons batch like discs; rings and pulses are the outline grown.
 */
import {
  evenShapeDash,
  type FrameVisuals,
  type NodeVisual,
  shapeVertexRadius,
  shapeVertices,
  type Theme,
} from '@kgdiff/scene';
import { type Ctx2D, NO_DASH } from '../ctx.js';
import { type FrameCache, type NodeBucket, zLevel } from '../frame-cache.js';
import { TAU } from '../math.js';
import { polygonPath } from './shapes.js';
import { CULL_MARGIN, NODE_DASH_MIN_R, NODE_MIN_R, NODE_TINY_R, type View } from './view.js';

const evenDash: number[] = [];

/** `dash` scaled so a whole number of periods fits a circle of radius `r` (no seam). */
export function evenCircleDash(dash: readonly number[], r: number, out: number[]): number[] {
  let period = 0;
  for (const d of dash) period += d;
  if (dash.length % 2 === 1) period *= 2;
  out.length = dash.length;
  const circumference = TAU * r;
  const count = Math.max(1, Math.round(circumference / period));
  const s = period > 0 ? circumference / (count * period) : 1;
  for (let i = 0; i < dash.length; i++) out[i] = dash[i]! * s;
  return out;
}

function visibleAt(v: View, x: number, y: number, r: number): boolean {
  return (
    x + r >= v.x0 - CULL_MARGIN &&
    x - r <= v.x1 + CULL_MARGIN &&
    y + r >= v.y0 - CULL_MARGIN &&
    y - r <= v.y1 + CULL_MARGIN
  );
}

function drawBucket(
  ctx: Ctx2D,
  b: NodeBucket,
  nodes: readonly NodeVisual[],
  v: View,
  bg: string,
): void {
  const { k, ox, oy } = v;
  const members = b.members;
  const fill = b.fill ?? bg;
  const shape = b.shape;
  const vertices = shapeVertices(shape);
  const polygon = vertices.length > 0;
  ctx.globalAlpha = b.alpha;
  if (polygon) ctx.lineJoin = 'round';

  if (b.dash !== null && b.stroke !== null) {
    // Dashed outlines (ghosts) are few: draw one by one with evenly spaced dashes.
    ctx.fillStyle = fill;
    ctx.strokeStyle = b.stroke;
    ctx.lineWidth = b.strokeWidth;
    ctx.lineCap = 'butt';
    for (let m = 0; m < members.length; m++) {
      const n = nodes[members[m]!]!;
      const x = n.x * k + ox;
      const y = n.y * k + oy;
      const r = Math.max(n.r * k, NODE_MIN_R);
      if (!visibleAt(v, x, y, r)) {
        v.stats.culledNodes++;
        continue;
      }
      v.stats.nodes++;
      ctx.beginPath();
      if (polygon) polygonPath(ctx, vertices, x, y, shapeVertexRadius(shape, r, 0));
      else ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      if (r < NODE_DASH_MIN_R) ctx.setLineDash(NO_DASH);
      else if (polygon) {
        ctx.lineDashOffset = evenShapeDash(shape, b.dash, r, evenDash);
        ctx.setLineDash(evenDash);
      } else ctx.setLineDash(evenCircleDash(b.dash, r, evenDash));
      ctx.stroke();
    }
    ctx.setLineDash(NO_DASH);
    if (polygon) ctx.lineDashOffset = 0;
    return;
  }

  let started = false;
  let tiny = 0;
  for (let m = 0; m < members.length; m++) {
    const n = nodes[members[m]!]!;
    const x = n.x * k + ox;
    const y = n.y * k + oy;
    const r = Math.max(n.r * k, NODE_MIN_R);
    if (!visibleAt(v, x, y, r)) {
      v.stats.culledNodes++;
      continue;
    }
    v.stats.nodes++;
    if (r < NODE_TINY_R) {
      tiny++;
      continue;
    }
    if (!started) {
      ctx.beginPath();
      started = true;
    }
    if (polygon) polygonPath(ctx, vertices, x, y, shapeVertexRadius(shape, r, 0));
    else {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
  }
  if (started) {
    ctx.fillStyle = fill;
    ctx.fill();
    if (b.stroke !== null) {
      ctx.strokeStyle = b.stroke;
      ctx.lineWidth = b.strokeWidth;
      ctx.setLineDash(NO_DASH);
      ctx.stroke();
    }
  }
  if (tiny > 0) {
    // Sub-pixel nodes: squares in the most visible color, no stroke.
    ctx.beginPath();
    for (let m = 0; m < members.length; m++) {
      const n = nodes[members[m]!]!;
      const r = Math.max(n.r * k, NODE_MIN_R);
      if (r >= NODE_TINY_R) continue;
      const x = n.x * k + ox;
      const y = n.y * k + oy;
      if (!visibleAt(v, x, y, r)) continue;
      ctx.rect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.fillStyle = b.fill ?? b.stroke ?? bg;
    ctx.fill();
  }
}

function drawDecor(ctx: Ctx2D, n: NodeVisual, v: View, theme: Theme): void {
  const x = n.x * v.k + v.ox;
  const y = n.y * v.k + v.oy;
  const r = Math.max(n.r * v.k, NODE_MIN_R);
  const ring = n.ring;
  const reach = r + (ring ? ring.gap + ring.width : 0) + 24;
  if (!visibleAt(v, x, y, reach)) return;
  const vertices = shapeVertices(n.shape);
  const polygon = vertices.length > 0;
  if (polygon) ctx.lineJoin = 'round';
  if (ring !== null && ring.width > 0) {
    const a = ring.alpha * n.alpha;
    if (a >= 0.01) {
      ctx.globalAlpha = a;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = ring.width;
      ctx.setLineDash(NO_DASH);
      ctx.beginPath();
      if (polygon) polygonPath(ctx, vertices, x, y, shapeVertexRadius(n.shape, r, ring.gap));
      else ctx.arc(x, y, r + ring.gap, 0, TAU);
      ctx.stroke();
    }
  }
  const p = n.pulse;
  if (p > 0 && p < 1) {
    // Expanding ring that fades out (replay emphasis).
    const fade = 1 - p;
    const a = fade * fade * 0.85 * n.alpha;
    if (a >= 0.01) {
      ctx.globalAlpha = a;
      ctx.strokeStyle = ring?.color ?? n.stroke ?? n.fill ?? theme.accent.base;
      ctx.lineWidth = 0.75 + 1.75 * fade;
      ctx.setLineDash(NO_DASH);
      ctx.beginPath();
      const grow = 3 + p * (12 + r * 0.6);
      if (polygon) polygonPath(ctx, vertices, x, y, shapeVertexRadius(n.shape, r, grow));
      else ctx.arc(x, y, r + grow, 0, TAU);
      ctx.stroke();
    }
  }
}

export function drawNodes(
  ctx: Ctx2D,
  frame: FrameVisuals,
  cache: FrameCache,
  v: View,
  theme: Theme,
): void {
  const nodes = frame.nodes;
  const buckets = cache.nodeBuckets;
  const decor = cache.decor;
  const bg = theme.canvas.background;
  let d = 0;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    drawBucket(ctx, b, nodes, v, bg);
    const next = buckets[i + 1];
    if (next !== undefined && next.z === b.z) continue;
    // End of a z level: its rings and pulses go on top of it, below the next level.
    while (d < decor.length && zLevel(nodes[decor[d]!]!.z) <= b.z) {
      drawDecor(ctx, nodes[decor[d]!]!, v, theme);
      d++;
    }
  }
  while (d < decor.length) drawDecor(ctx, nodes[decor[d++]!]!, v, theme);
}
