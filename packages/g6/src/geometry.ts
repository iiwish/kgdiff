/** Small numeric helpers for the mapping (pure, allocation-light). */
import { type NodeShape, shapeVertexRadius, shapeVertices } from '@kgdiff/scene';

/** `v` clamped to [0, 1]; NaN → 0. */
export function unit(v: number): number {
  return v > 0 ? Math.min(v, 1) : 0;
}

/** `v` when finite, else `fallback`. */
export function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** zIndex inside a band: the scene's `z` clamped to [0, span) and added to `base`. */
export function band(base: number, z: number, span: number): number {
  const k = Number.isFinite(z) ? Math.round(z) : 0;
  return base + Math.min(span - 1, Math.max(0, k));
}

/**
 * `dash` scaled so a whole number of periods tiles a circle of radius `r` (no seam where the
 * outline closes), exactly like the native renderer's ghost outlines.
 */
export function evenCircleDash(dash: readonly number[], r: number): number[] {
  let period = 0;
  for (const d of dash) period += d;
  if (dash.length % 2 === 1) period *= 2;
  const circumference = 2 * Math.PI * r;
  const count = Math.max(1, Math.round(circumference / period));
  const s = period > 0 ? circumference / (count * period) : 1;
  return dash.map((d) => d * s);
}

/**
 * The points of a polygon outline at size `r` grown by `grow`, centered on the origin, starting
 * in the middle of the last side (`evenShapeDash` expects that); null for a circle.
 */
export function outlinePoints(
  shape: NodeShape | undefined,
  r: number,
  grow: number,
): [number, number][] | null {
  const v = shapeVertices(shape);
  const n = v.length;
  if (n === 0) return null;
  const radius = shapeVertexRadius(shape, r, grow);
  const points: [number, number][] = [
    [
      (((v[n - 2] as number) + (v[0] as number)) / 2) * radius,
      (((v[n - 1] as number) + (v[1] as number)) / 2) * radius,
    ],
  ];
  for (let i = 0; i < n; i += 2) {
    points.push([(v[i] as number) * radius, (v[i + 1] as number) * radius]);
  }
  return points;
}

/**
 * Approximate length of the quadratic link between two points `len` apart with curvature `c`
 * (scene curve convention: the control point sits `|c|·len` off the chord midpoint). Uses the
 * mean of the chord and the control polygon, within a few percent for |c| ≤ 0.5.
 */
export function linkLength(len: number, c: number): number {
  if (c === 0) return len;
  const half = len / 2;
  const off = Math.abs(c) * len;
  const polygon = 2 * Math.sqrt(half * half + off * off);
  return (len + polygon) / 2;
}
