/** Path helpers shared by passes. */
import type { Ctx2D } from '../ctx.js';
import { ARROW_LEN, ARROW_WIDTH } from './view.js';

/** Rounded rectangle subpath (radius clamped to half the shorter side). */
export function roundRectPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/**
 * Closed polygon subpath from `shapeVertices`, scaled to `radius`. It starts in the middle of
 * the last side, where `evenShapeDash` puts no corner, so a dashed outline has no seam.
 */
export function polygonPath(
  ctx: Ctx2D,
  vertices: readonly number[],
  x: number,
  y: number,
  radius: number,
): void {
  const n = vertices.length;
  ctx.moveTo(
    x + ((vertices[n - 2]! + vertices[0]!) / 2) * radius,
    y + ((vertices[n - 1]! + vertices[1]!) / 2) * radius,
  );
  for (let i = 0; i < n; i += 2) {
    ctx.lineTo(x + vertices[i]! * radius, y + vertices[i + 1]! * radius);
  }
  ctx.closePath();
}

/** Arrowhead subpath with its tip at (x, y) pointing along the unit vector (ux, uy). */
export function arrowPath(ctx: Ctx2D, x: number, y: number, ux: number, uy: number): void {
  const bx = x - ux * ARROW_LEN;
  const by = y - uy * ARROW_LEN;
  const hw = ARROW_WIDTH / 2;
  ctx.moveTo(x, y);
  ctx.lineTo(bx - uy * hw, by + ux * hw);
  ctx.lineTo(bx + uy * hw, by - ux * hw);
  ctx.closePath();
}
