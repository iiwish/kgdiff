/**
 * Hit testing at a screen point, topmost first: nodes (grid lookup; a point inside a disc beats
 * the tolerance ring, then higher z), then edges (distance to the segment / curve / loop, higher
 * z first), then collapsed pills. Invisible and fully transparent elements, and pills hidden by
 * label collision, are never picked.
 */
import type { FrameVisuals } from '@kgdiff/scene';
import { pillRect } from './draw/collapsed.js';
import { isLoop } from './draw/edges.js';
import { loopCenterY, loopRadius } from './draw/link.js';
import { NODE_MIN_R } from './draw/view.js';
import type { FrameCache } from './frame-cache.js';
import type { PickResult } from './index.js';
import { distToQuadSq, distToSegmentSq } from './math.js';
import type { Fonts, TextMeasurer } from './text.js';

/** Extra reach (px) around node discs. */
export const NODE_PICK_TOLERANCE = 3;
/** Extra reach (px) beyond half an edge's width. */
export const EDGE_PICK_TOLERANCE = 4;

export interface PickView {
  readonly k: number;
  readonly ox: number;
  readonly oy: number;
  readonly dpr: number;
}

const candidates: number[] = [];
const rect = new Float64Array(4);

function pickNode(
  frame: FrameVisuals,
  cache: FrameCache,
  v: PickView,
  sx: number,
  sy: number,
): number {
  if (cache.nodeCount === 0) return -1;
  const { k } = v;
  const wx = (sx - v.ox) / k;
  const wy = (sy - v.oy) / k;
  const grid = cache.nodeGrid();
  const reach = Math.max(grid.maxR, NODE_MIN_R / k) + NODE_PICK_TOLERANCE / k;
  grid.query(wx - reach, wy - reach, wx + reach, wy + reach, candidates);
  let best = -1;
  let bestInside = false;
  let bestZ = Number.NEGATIVE_INFINITY;
  let bestD = Number.POSITIVE_INFINITY;
  for (const i of candidates) {
    const n = frame.nodes[i]!;
    const r = Math.max(n.r, NODE_MIN_R / k);
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d > r + NODE_PICK_TOLERANCE / k) continue;
    const inside = d <= r;
    const better =
      best < 0 ||
      (inside && !bestInside) ||
      (inside === bestInside &&
        (n.z > bestZ || (n.z === bestZ && (inside ? i > best : d < bestD))));
    if (better) {
      best = i;
      bestInside = inside;
      bestZ = n.z;
      bestD = d;
    }
  }
  return best;
}

function pickEdge(
  frame: FrameVisuals,
  cache: FrameCache,
  v: PickView,
  sx: number,
  sy: number,
): number {
  const { k } = v;
  const wx = (sx - v.ox) / k;
  const wy = (sy - v.oy) / k;
  let best = -1;
  let bestZ = Number.NEGATIVE_INFINITY;
  let bestD = Number.POSITIVE_INFINITY;
  for (const b of cache.edgeBuckets) {
    const tol = (b.width / 2 + EDGE_PICK_TOLERANCE) / k;
    const tol2 = tol * tol;
    for (const i of b.members) {
      const e = frame.edges[i]!;
      let d2: number;
      if (isLoop(e.x1, e.y1, e.x2, e.y2)) {
        const r = Math.max(e.r1 * k, NODE_MIN_R);
        const rho = loopRadius(r, e.curvature) / k;
        const cy = loopCenterY(e.y1 * k, r, rho * k) / k;
        const d = Math.abs(Math.hypot(wx - e.x1, wy - cy) - rho);
        d2 = d * d;
      } else if (e.curvature === 0) {
        if (
          wx < Math.min(e.x1, e.x2) - tol ||
          wx > Math.max(e.x1, e.x2) + tol ||
          wy < Math.min(e.y1, e.y2) - tol ||
          wy > Math.max(e.y1, e.y2) + tol
        ) {
          continue;
        }
        d2 = distToSegmentSq(wx, wy, e.x1, e.y1, e.x2, e.y2);
      } else {
        const cx = (e.x1 + e.x2) / 2 - (e.y2 - e.y1) * e.curvature;
        const cy = (e.y1 + e.y2) / 2 + (e.x2 - e.x1) * e.curvature;
        if (
          wx < Math.min(e.x1, e.x2, cx) - tol ||
          wx > Math.max(e.x1, e.x2, cx) + tol ||
          wy < Math.min(e.y1, e.y2, cy) - tol ||
          wy > Math.max(e.y1, e.y2, cy) + tol
        ) {
          continue;
        }
        d2 = distToQuadSq(wx, wy, e.x1, e.y1, cx, cy, e.x2, e.y2);
      }
      if (d2 > tol2) continue;
      if (b.z > bestZ || (b.z === bestZ && d2 < bestD)) {
        best = i;
        bestZ = b.z;
        bestD = d2;
      }
    }
  }
  return best;
}

function pickCollapsed(
  frame: FrameVisuals,
  cache: FrameCache,
  v: PickView,
  sx: number,
  sy: number,
  fonts: Fonts,
  measurer: TextMeasurer,
): number {
  const groups = frame.collapsed;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (!(g.count > 0) || !Number.isFinite(g.x + g.y) || !cache.pillPickable(i)) continue;
    pillRect(g, v, fonts, measurer, rect);
    if (
      sx >= rect[0]! &&
      sx <= rect[0]! + rect[2]! &&
      sy >= rect[1]! &&
      sy <= rect[1]! + rect[3]!
    ) {
      return i;
    }
  }
  return -1;
}

/** Topmost element at screen point (sx, sy), or null. */
export function pickAt(
  frame: FrameVisuals,
  cache: FrameCache,
  v: PickView,
  sx: number,
  sy: number,
  fonts: Fonts,
  measurer: TextMeasurer,
): PickResult | null {
  const node = pickNode(frame, cache, v, sx, sy);
  if (node >= 0) return { type: 'node', index: node };
  const edge = pickEdge(frame, cache, v, sx, sy);
  if (edge >= 0) return { type: 'edge', index: edge };
  const group = pickCollapsed(frame, cache, v, sx, sy, fonts, measurer);
  if (group >= 0) return { type: 'collapsed', index: group };
  return null;
}
