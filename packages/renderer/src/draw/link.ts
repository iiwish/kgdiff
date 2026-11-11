/**
 * Geometry of one link (edge or glyph arc) in screen space: straight or quadratic, trimmed at
 * the endpoint radii, partially drawn (`progress`), optionally ending in an arrowhead.
 */
import { type NodeShape, shapeDistance, shapeVertices } from '@kgdiff/scene';
import type { Ctx2D } from '../ctx.js';
import { quadAt, quadSlope, quadTrim, TAU } from '../math.js';
import { ARROW_LEN } from './view.js';

export const LINK_NONE = 0;
export const LINK_DRAWN = 1;
export const LINK_ARROW = 2;

/** Drawn fraction in [0, 1]; NaN draws nothing. */
function progressOf(p: number): number {
  if (!(p > 0)) return 0;
  return Math.min(p, 1);
}

/**
 * Append the visible part of the link (x1, y1) → (x2, y2) to the current path.
 * `trim1` / `trim2` are px cut from each end; `progress` is the drawn fraction from the source
 * (from the target when `fromTarget`). With `arrow`, the line stops short of the tip and the
 * tip (x, y) and unit direction (ux, uy) are written to `tip`.
 * Returns LINK_NONE, LINK_DRAWN or LINK_ARROW.
 */
export function linkPath(
  ctx: Ctx2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number,
  trim1: number,
  trim2: number,
  progress: number,
  fromTarget: boolean,
  arrow: boolean,
  tip: Float64Array,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const p = progressOf(progress);
  if (!(len > 1e-6) || p <= 0) return LINK_NONE;

  if (curvature === 0 || !Number.isFinite(curvature)) {
    const ux = dx / len;
    const uy = dy / len;
    const a0 = trim1;
    const a1 = len - trim2;
    if (a1 - a0 < 0.5) return LINK_NONE;
    let s0 = a0;
    let s1 = a1;
    if (p < 1) {
      const span = (a1 - a0) * p;
      if (fromTarget) s0 = a1 - span;
      else s1 = a0 + span;
    }
    let end = s1;
    const withArrow = arrow && s1 - s0 > ARROW_LEN * 1.2;
    if (withArrow) {
      end = s1 - (ARROW_LEN - 1);
      tip[0] = x1 + ux * s1;
      tip[1] = y1 + uy * s1;
      tip[2] = ux;
      tip[3] = uy;
    }
    ctx.moveTo(x1 + ux * s0, y1 + uy * s0);
    ctx.lineTo(x1 + ux * end, y1 + uy * end);
    return withArrow ? LINK_ARROW : LINK_DRAWN;
  }

  const cx = (x1 + x2) / 2 - dy * curvature;
  const cy = (y1 + y2) / 2 + dx * curvature;
  const ta = quadTrim(x1, y1, cx, cy, x2, y2, trim1, false);
  const tb = quadTrim(x1, y1, cx, cy, x2, y2, trim2, true);
  if (tb - ta < 0.01) return LINK_NONE;
  let t0 = ta;
  let t1 = tb;
  if (p < 1) {
    const span = (tb - ta) * p;
    if (fromTarget) t0 = tb - span;
    else t1 = ta + span;
  }
  let tEnd = t1;
  let withArrow = false;
  if (arrow) {
    const sx = quadSlope(x1, cx, x2, t1);
    const sy = quadSlope(y1, cy, y2, t1);
    const speed = Math.hypot(sx, sy);
    if (speed > 1e-6) {
      const dt = (ARROW_LEN - 1) / speed;
      if (t1 - t0 > dt * 1.2) {
        withArrow = true;
        tEnd = t1 - dt;
        tip[0] = quadAt(x1, cx, x2, t1);
        tip[1] = quadAt(y1, cy, y2, t1);
        tip[2] = sx / speed;
        tip[3] = sy / speed;
      }
    }
  }
  // Sub-curve [t0, tEnd]: control = B(t0) + (tEnd − t0) / 2 · B′(t0).
  const px = quadAt(x1, cx, x2, t0);
  const py = quadAt(y1, cy, y2, t0);
  const h = (tEnd - t0) / 2;
  ctx.moveTo(px, py);
  ctx.quadraticCurveTo(
    px + h * quadSlope(x1, cx, x2, t0),
    py + h * quadSlope(y1, cy, y2, t0),
    quadAt(x1, cx, x2, tEnd),
    quadAt(y1, cy, y2, tEnd),
  );
  return withArrow ? LINK_ARROW : LINK_DRAWN;
}

/**
 * px to cut from one end of the link (x1, y1) → (x2, y2) so it stops at the outline of a node
 * of screen size `r` there (the end at (x2, y2) with `fromEnd`). A disc needs `r` whatever the
 * direction; on a polygon the distance depends on where the line crosses, found on a curve by
 * two refinements from the disc's crossing.
 */
export function outlineTrim(
  shape: NodeShape | undefined,
  r: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number,
  fromEnd: boolean,
): number {
  if (shapeVertices(shape).length === 0) return r;
  const ox = fromEnd ? x2 : x1;
  const oy = fromEnd ? y2 : y1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (curvature === 0 || !Number.isFinite(curvature)) {
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return r;
    const s = fromEnd ? -1 : 1;
    return shapeDistance(shape, r, 0, (s * dx) / len, (s * dy) / len);
  }
  const cx = (x1 + x2) / 2 - dy * curvature;
  const cy = (y1 + y2) / 2 + dx * curvature;
  let d = r;
  for (let i = 0; i < 2; i++) {
    const t = quadTrim(x1, y1, cx, cy, x2, y2, d, fromEnd);
    const px = quadAt(x1, cx, x2, t) - ox;
    const py = quadAt(y1, cy, y2, t) - oy;
    const at = Math.hypot(px, py);
    if (!(at > 1e-6)) return d;
    d = shapeDistance(shape, r, 0, px / at, py / at);
  }
  return d;
}

/** Self-loop circle radius (px) for a node of screen radius `r`; |curvature| enlarges it. */
export function loopRadius(r: number, curvature: number): number {
  const c = Number.isFinite(curvature) ? Math.min(Math.abs(curvature), 1) : 0;
  return Math.max(6, r * 0.8) * (1 + 2 * c);
}

/** Centre y of the self-loop circle above a node at screen y `y` with radius `r`. */
export function loopCenterY(y: number, r: number, rho: number): number {
  return y - r - rho * 0.5;
}

/** Append a self-loop above the node (x, y, r); `progress` sweeps the circle. */
export function loopPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  r: number,
  curvature: number,
  progress: number,
): number {
  const p = progressOf(progress);
  if (p <= 0) return LINK_NONE;
  const rho = loopRadius(r, curvature);
  const cy = loopCenterY(y, r, rho);
  const a0 = Math.PI / 2;
  ctx.moveTo(x, cy + rho);
  ctx.arc(x, cy, rho, a0, a0 + TAU * p);
  return LINK_DRAWN;
}

/** Point on the link at its middle (t = 0.5), screen space. */
export function linkMidpoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number,
): [number, number] {
  const c = Number.isFinite(curvature) ? curvature : 0;
  return [(x1 + x2) / 2 - ((y2 - y1) * c) / 2, (y1 + y2) / 2 + ((x2 - x1) * c) / 2];
}
