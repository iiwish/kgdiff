/**
 * Helpers of the diff engine only (matching, merges and splits, classification): the
 * read path does not use them (tests/read-path.ts).
 */

/** Rounds a score to 1e-6, the precision of every score that leaves the engine. */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Clamps to [0, 1]. NaN becomes 0. */
export function clamp01(value: number): number {
  return value > 0 ? Math.min(value, 1) : 0;
}

/** `{ added: b \ a, removed: a \ b }` for two sorted, unique string arrays. */
export function sortedSetDiff(
  a: readonly string[],
  b: readonly string[],
): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && x < y)) {
      removed.push(x as string);
      i++;
    } else if (x === undefined || y < x) {
      added.push(y);
      j++;
    } else {
      i++;
      j++;
    }
  }
  return { added, removed };
}
