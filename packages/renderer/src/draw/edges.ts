/**
 * Edge pass: one path + one stroke per style bucket (and one fill for its arrowheads),
 * buckets in z order. Endpoints are trimmed at node radii; culled against the region.
 */
import type { FrameVisuals } from '@kgdiff/scene';
import { type Ctx2D, NO_DASH } from '../ctx.js';
import type { EdgeBucket, FrameCache } from '../frame-cache.js';
import { segmentHitsRect } from '../math.js';
import { LINK_ARROW, LINK_NONE, linkPath, loopCenterY, loopPath, loopRadius } from './link.js';
import { arrowPath } from './shapes.js';
import { ARROW_GAP, CULL_MARGIN, NODE_MIN_R, type View } from './view.js';

const tip = new Float64Array(4);
let arrows = new Float64Array(4 * 256);

function pushArrow(n: number): void {
  if (arrows.length < (n + 1) * 4) {
    const next = new Float64Array(arrows.length * 2);
    next.set(arrows);
    arrows = next;
  }
  const o = n * 4;
  arrows[o] = tip[0]!;
  arrows[o + 1] = tip[1]!;
  arrows[o + 2] = tip[2]!;
  arrows[o + 3] = tip[3]!;
}

function applyStroke(ctx: Ctx2D, b: EdgeBucket): void {
  ctx.globalAlpha = b.alpha;
  ctx.strokeStyle = b.color;
  ctx.lineWidth = b.width;
  ctx.setLineDash(b.dash ?? NO_DASH);
  ctx.lineDashOffset = b.dash ? b.dashOffset : 0;
  ctx.lineCap = b.dash ? 'butt' : 'round';
  ctx.lineJoin = 'round';
}

/** Whether a link is a self-loop (both endpoints at the same world position). */
export function isLoop(x1: number, y1: number, x2: number, y2: number): boolean {
  return Math.abs(x2 - x1) + Math.abs(y2 - y1) < 1e-9;
}

/** Arrowhead LOD: shown from `arrowMinZoom` on (a missing / NaN threshold shows it). */
function showsArrow(arrow: boolean, minZoom: number, k: number): boolean {
  return arrow && !(k < minZoom);
}

export function drawEdges(ctx: Ctx2D, frame: FrameVisuals, cache: FrameCache, v: View): void {
  const { k, ox, oy } = v;
  const minX = v.x0 - CULL_MARGIN;
  const maxX = v.x1 + CULL_MARGIN;
  const minY = v.y0 - CULL_MARGIN;
  const maxY = v.y1 + CULL_MARGIN;
  const edges = frame.edges;
  for (const b of cache.edgeBuckets) {
    let started = false;
    let nArrows = 0;
    const members = b.members;
    for (let m = 0; m < members.length; m++) {
      const e = edges[members[m]!]!;
      const x1 = e.x1 * k + ox;
      const y1 = e.y1 * k + oy;
      const x2 = e.x2 * k + ox;
      const y2 = e.y2 * k + oy;
      const r1 = Math.max(e.r1 * k, NODE_MIN_R);
      const loop = isLoop(e.x1, e.y1, e.x2, e.y2);
      if (loop) {
        const rho = loopRadius(r1, e.curvature);
        const cy = loopCenterY(y1, r1, rho);
        if (x1 + rho < minX || x1 - rho > maxX || cy + rho < minY || cy - rho > maxY) {
          v.stats.culledEdges++;
          continue;
        }
      } else if (e.curvature === 0) {
        if (!segmentHitsRect(x1, y1, x2, y2, minX, minY, maxX, maxY)) {
          v.stats.culledEdges++;
          continue;
        }
      } else {
        const cx = (x1 + x2) / 2 - (y2 - y1) * e.curvature;
        const cy = (y1 + y2) / 2 + (x2 - x1) * e.curvature;
        if (
          Math.max(x1, x2, cx) < minX ||
          Math.min(x1, x2, cx) > maxX ||
          Math.max(y1, y2, cy) < minY ||
          Math.min(y1, y2, cy) > maxY
        ) {
          v.stats.culledEdges++;
          continue;
        }
      }
      if (!started) {
        applyStroke(ctx, b);
        ctx.beginPath();
        started = true;
      }
      let res: number;
      if (loop) {
        res = loopPath(ctx, x1, y1, r1, e.curvature, e.progress);
      } else {
        const arrow = showsArrow(e.arrow, e.arrowMinZoom, k);
        const r2 = Math.max(e.r2 * k, NODE_MIN_R) + (arrow ? ARROW_GAP : 0);
        res = linkPath(
          ctx,
          x1,
          y1,
          x2,
          y2,
          e.curvature,
          r1,
          r2,
          e.progress,
          e.fromTarget,
          arrow,
          tip,
        );
        if (res === LINK_ARROW) pushArrow(nArrows++);
      }
      if (res !== LINK_NONE) v.stats.edges++;
    }
    if (!started) continue;
    ctx.stroke();
    v.stats.edgeStrokes++;
    if (nArrows > 0) {
      ctx.fillStyle = b.color;
      ctx.beginPath();
      for (let a = 0; a < nArrows; a++) {
        const o = a * 4;
        arrowPath(ctx, arrows[o]!, arrows[o + 1]!, arrows[o + 2]!, arrows[o + 3]!);
      }
      ctx.fill();
    }
  }
}
