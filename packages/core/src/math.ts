/**
 * Deterministic arithmetic.
 *
 * ECMAScript only guarantees exact (correctly rounded) results for + − × ÷ and, in every engine
 * in practice, `Math.sqrt`. `Math.log2`, `Math.pow`, `Math.sin`… are implementation-approximated
 * and can differ in the last bit between V8, SpiderMonkey and JavaScriptCore (and from any C
 * library). Matching weighs evidence with log₂, and a weight one bit off can reorder candidates,
 * so it uses this `log2` instead; so does `@kgdiff/layout`, whose force simulation amplifies
 * such differences. Results are then identical in every engine and in a port that repeats the
 * same operations in the same order.
 */

/** log₂(x) for x > 0, using only exactly rounded operations. Accurate to ~1e-15. */
export function log2(x: number): number {
  if (!(x > 0)) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return x;
  // x = m·2^e with m ∈ [1, 2); scaling by 2 is exact.
  let m = x;
  let e = 0;
  while (m >= 2) {
    m /= 2;
    e++;
  }
  while (m < 1) {
    m *= 2;
    e--;
  }
  // ln(m) = 2·atanh(s), s = (m − 1)/(m + 1) ∈ [0, 1/3): the series converges by 1/9 per term.
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let term = s;
  let sum = 0;
  for (let k = 1; k < 40; k += 2) {
    sum += term / k;
    term *= s2;
  }
  return e + (2 * sum) / Math.LN2;
}
