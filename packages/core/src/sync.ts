/**
 * The TypeScript diff engine, synchronous, for the TypeScript corpus generator (`conformance/`,
 * `scripts/differential.ts`) until it moves to Rust (RFC 0002, phase 5). Not exported by the
 * package: `@kgdiff/core`'s `diff`, `matchNodes` and `textSimilarity` run kgdiff's engine through
 * `@kgdiff/compute`. Deleted with the rest of the TypeScript engine (`tests/read-path.ts`).
 */
export { diff } from './diff.js';
export { matchNodes } from './match.js';
export { log2 } from './math.js';
export { textSimilarity } from './similarity.js';
