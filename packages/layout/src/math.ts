/**
 * Deterministic arithmetic.
 *
 * ECMAScript only guarantees exact (correctly rounded) results for + − × ÷ and, in every engine
 * in practice, `Math.sqrt`. `Math.log2`, `Math.pow`, `Math.sin`… are implementation-approximated
 * and can differ in the last bit between V8, SpiderMonkey and JavaScriptCore. A force simulation
 * amplifies such differences, so everything that feeds it goes through these helpers to keep
 * layouts byte-identical between the CLI (Node) and the browser.
 */

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * log₂ from exactly rounded operations: `@kgdiff/core`'s, so that the layout and matching share
 * one function (and a port reproduces both by porting it once).
 */
export { log2 } from '@kgdiff/core';

/** bⁿ for integer n ≥ 0 by repeated squaring (exact operation sequence). */
export function powInt(base: number, exponent: number): number {
  let result = 1;
  let b = base;
  let n = exponent;
  while (n > 0) {
    if (n & 1) result *= b;
    b *= b;
    n >>>= 1;
  }
  return result;
}

/**
 * The per-tick factor `r` with `r^ticks = ratio` (ratio ∈ (0, 1]), found by bisection over
 * `powInt` so it is reproducible everywhere. Used for the alpha cooling schedule.
 */
export function coolingFactor(ratio: number, ticks: number): number {
  if (ticks <= 0 || ratio >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (powInt(mid, ticks) < ratio) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Monotonic stand-in for the polar angle of (x, y), in [0, 4). Sorting by it equals sorting by
 * `atan2` without any transcendental function.
 */
export function pseudoAngle(x: number, y: number): number {
  const d = Math.abs(x) + Math.abs(y);
  if (d === 0) return 0;
  const p = x / d;
  return y >= 0 ? 1 - p : 3 + p;
}

/** Shortest distance between two pseudo-angles on the [0, 4) circle. */
export function pseudoAngleDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return d > 2 ? 4 - d : d;
}
