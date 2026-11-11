/**
 * Rounding of output coordinates, shared by the layout engine and the JSON transport.
 */

/** Round to 0.01 (the layout's output precision); never returns `-0`. */
export function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
