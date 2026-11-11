/**
 * Node outlines (docs/visual-language.md §Shape says what kind): the one place their geometry
 * lives, for the scene, the canvas renderer and the G6 adapter.
 *
 * Every shape is a convex, centrally symmetric outline inside the square of half side `r` around
 * the node's center, the box the layout reserves. The polygons are regular, which makes growing
 * one exact and cheap: the outline grown by `g` is the same polygon with `g` added to its
 * apothem. All functions take sizes in any one unit (world or px) and allocate nothing, except
 * where they say so.
 */
import type { NodeShape } from './types.js';

/** @experimental Becomes stable in 1.0. */
export const NODE_SHAPES: readonly NodeShape[] = Object.freeze([
  'circle',
  'square',
  'diamond',
  'hexagon',
]);

/** Half side of the square, per unit of `r`: the same area as the disc (√π / 2 ≈ 0.886). */
const SQUARE_HALF = Math.sqrt(Math.PI) / 2;
const SIN_60 = Math.sqrt(3) / 2;

function ring(count: number, firstDegrees: number): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = ((firstDegrees + (i * 360) / count) * Math.PI) / 180;
    out.push(Math.cos(a), Math.sin(a));
  }
  return Object.freeze(out);
}

const NO_VERTICES: readonly number[] = Object.freeze([]);
const SQUARE_VERTICES = ring(4, 45);
const DIAMOND_VERTICES = ring(4, 0);
const HEXAGON_VERTICES = ring(6, 0);

/** Whether `value` is one of the shapes. @experimental Becomes stable in 1.0. */
export function isNodeShape(value: unknown): value is NodeShape {
  return value === 'circle' || value === 'square' || value === 'diamond' || value === 'hexagon';
}

/**
 * The vertices of a polygon outline as `[x0, y0, x1, y1, …]` on the unit circle, clockwise on
 * screen (y down); scale them by `shapeVertexRadius`. Empty for a circle and for a value that is
 * not a shape, which renderers draw as a circle.
 *
 * @experimental Becomes stable in 1.0.
 */
export function shapeVertices(shape: NodeShape | undefined): readonly number[] {
  switch (shape) {
    case 'square':
      return SQUARE_VERTICES;
    case 'diamond':
      return DIAMOND_VERTICES;
    case 'hexagon':
      return HEXAGON_VERTICES;
    default:
      return NO_VERTICES;
  }
}

/**
 * Distance from the center to the middle of a side at size `r` (the radius, for a circle).
 *
 * @experimental Becomes stable in 1.0.
 */
export function shapeApothem(shape: NodeShape | undefined, r: number): number {
  switch (shape) {
    case 'square':
      return r * SQUARE_HALF;
    case 'diamond':
      return r * Math.SQRT1_2;
    case 'hexagon':
      return r * SIN_60;
    default:
      return r;
  }
}

/**
 * Distance from the center to a vertex of the outline at size `r` grown by `grow` (`r + grow`,
 * for a circle).
 *
 * @experimental Becomes stable in 1.0.
 */
export function shapeVertexRadius(shape: NodeShape | undefined, r: number, grow: number): number {
  switch (shape) {
    case 'square':
      return (r * SQUARE_HALF + grow) * Math.SQRT2;
    case 'diamond':
      return r + grow * Math.SQRT2;
    case 'hexagon':
      return r + grow / SIN_60;
    default:
      return r + grow;
  }
}

/**
 * The apothem of the outline, of this shape and center, that passes through the point (dx, dy)
 * relative to the center. A point is inside the outline at size `r` grown by `g` exactly when
 * this is at most `shapeApothem(shape, r) + g`.
 *
 * @experimental Becomes stable in 1.0.
 */
export function shapeGauge(shape: NodeShape | undefined, dx: number, dy: number): number {
  const x = Math.abs(dx);
  const y = Math.abs(dy);
  switch (shape) {
    case 'square':
      return Math.max(x, y);
    case 'diamond':
      return (x + y) * Math.SQRT1_2;
    case 'hexagon':
      return Math.max(y, x * SIN_60 + y / 2);
    default:
      return Math.hypot(x, y);
  }
}

/**
 * Distance from the center to the outline at size `r` grown by `grow`, along the unit vector
 * (ux, uy).
 *
 * @experimental Becomes stable in 1.0.
 */
export function shapeDistance(
  shape: NodeShape | undefined,
  r: number,
  grow: number,
  ux: number,
  uy: number,
): number {
  const gauge = shapeGauge(shape, ux, uy);
  return gauge > 0 ? (shapeApothem(shape, r) + grow) / gauge : r + grow;
}

/**
 * Lays dashes along a polygon outline at size `r` whose path starts in the middle of a side:
 * writes into `out` the pattern `dash` stretched to a whole number of periods per side, and
 * returns the dash offset that centers a dash on every vertex. So all sides look alike, there is
 * no seam, and a ghost keeps its corners. For the circle, see `evenCircleDash` in the renderers.
 *
 * @experimental Becomes stable in 1.0.
 */
export function evenShapeDash(
  shape: NodeShape | undefined,
  dash: readonly number[],
  r: number,
  out: number[],
): number {
  const sides = shapeVertices(shape).length / 2;
  let period = 0;
  for (const d of dash) period += d;
  if (dash.length % 2 === 1) period *= 2;
  out.length = dash.length;
  // A regular polygon's side is 2 · apothem · tan(π / n).
  const side = sides > 0 ? 2 * shapeApothem(shape, r) * Math.tan(Math.PI / sides) : 0;
  const count = period > 0 ? Math.max(1, Math.round(side / period)) : 1;
  const s = period > 0 ? side / (count * period) : 1;
  for (let i = 0; i < dash.length; i++) out[i] = (dash[i] as number) * s;
  const stretched = period * s;
  if (!(stretched > 0)) return 0;
  // The first vertex is half a side along the path; there the pattern must be half a dash in.
  const offset = ((out[0] as number) / 2 - side / 2) % stretched;
  return offset < 0 ? offset + stretched : offset;
}
