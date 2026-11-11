/** Small numeric helpers shared by the camera, drawing, culling and picking. */

export const TAU = Math.PI * 2;

/** `value` limited to [lo, hi] (NaN stays NaN). */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** Hermite smoothstep of `x` between `edge0` and `edge1`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Round a CSS-pixel coordinate to the device-pixel grid (crisp text and hairlines). */
export function snap(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

/**
 * Offset (css px) that puts a stroke of `width` css px on whole device pixels:
 * odd device widths are centred on pixel centres, even ones on pixel edges.
 */
export function crispOffset(width: number, dpr: number): number {
  return Math.round(width * dpr) % 2 === 1 ? 0.5 / dpr : 0;
}

// ─── Quadratic Bézier edges ─────────────────────────────────────────────────
//
// Curvature convention (edges and glyphs): the control point is the chord midpoint
// moved along the left normal (−dy, dx) by `curvature · chord length`. The curve's
// apex therefore sits `curvature / 2 · length` off the chord; the sign picks the side.

/** One coordinate of B(t) for a quadratic with endpoints `p0`, `p2` and control `c`. */
export function quadAt(p0: number, c: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * c + t * t * p2;
}

/** One coordinate of B′(t). */
export function quadSlope(p0: number, c: number, p2: number, t: number): number {
  return 2 * (1 - t) * (c - p0) + 2 * t * (p2 - c);
}

/**
 * Parameter where the curve is `dist` away from its start (`fromEnd` false) or end
 * (`fromEnd` true). Bisection, valid for the gentle curvatures used for parallel edges.
 */
export function quadTrim(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x2: number,
  y2: number,
  dist: number,
  fromEnd: boolean,
): number {
  if (dist <= 0) return fromEnd ? 1 : 0;
  const ox = fromEnd ? x2 : x0;
  const oy = fromEnd ? y2 : y0;
  const d2 = dist * dist;
  let lo = fromEnd ? 1 : 0;
  let hi = 0.5;
  const mx = quadAt(x0, cx, x2, 0.5) - ox;
  const my = quadAt(y0, cy, y2, 0.5) - oy;
  if (mx * mx + my * my <= d2) return 0.5;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const px = quadAt(x0, cx, x2, mid) - ox;
    const py = quadAt(y0, cy, y2, mid) - oy;
    if (px * px + py * py < d2) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Squared distance from (px, py) to the segment a–b. */
export function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Squared distance from (px, py) to a quadratic curve, by flattening into `steps` segments. */
export function distToQuadSq(
  px: number,
  py: number,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x2: number,
  y2: number,
  steps = 16,
): number {
  let best = Number.POSITIVE_INFINITY;
  let ax = x0;
  let ay = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const bx = quadAt(x0, cx, x2, t);
    const by = quadAt(y0, cy, y2, t);
    const d = distToSegmentSq(px, py, ax, ay, bx, by);
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}

/** Whether segment a–b touches the axis-aligned rectangle (Liang–Barsky). */
export function segmentHitsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1) return true;
  if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1) return true;
  if (
    (ax < x0 && bx < x0) ||
    (ax > x1 && bx > x1) ||
    (ay < y0 && by < y0) ||
    (ay > y1 && by > y1)
  ) {
    return false;
  }
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay);
}

/** Whether two rectangles given as x, y, w, h overlap (touching edges do not count). */
export function rectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}
