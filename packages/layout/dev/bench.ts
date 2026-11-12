/**
 * Layout benchmark on generated before / after pairs (scripts/gen-synthetic.ts output).
 *
 *   pnpm tsx --tsconfig packages/layout/tsconfig.json packages/layout/dev/bench.ts <dir> [scope]
 *
 * Prints diff time, then layout time (warm-up + 3 runs), nodes in scope and quality metrics.
 * `ITER=<n>` overrides the tick count. Profile with
 *   TSX_TSCONFIG_PATH=packages/layout/tsconfig.json node --cpu-prof --import tsx/esm packages/layout/dev/bench.ts <dir>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphInput } from '@kgdiff/core';
import { diff } from '../../core/src/sync.js';
import { type LayoutScope, layoutToJSON } from '../src/index.js';
import { layoutDiff } from '../src/sync.js';
import { quality } from '../test/support/metrics.js';

const [dir, scopeArg] = process.argv.slice(2);
if (dir === undefined) throw new Error('usage: bench.ts <dir> [all|changes]');
const read = (name: string): GraphInput =>
  JSON.parse(readFileSync(join(dir, name), 'utf8')) as GraphInput;
const t0 = performance.now();
const result = diff(read('before.json'), read('after.json'));
console.log(
  `diff: ${result.nodes.length} union nodes in ${(performance.now() - t0).toFixed(0)} ms`,
);
const scope = scopeArg as LayoutScope | undefined;
const extra = process.env.ITER ? { iterations: Number(process.env.ITER) } : {};
const runs: number[] = [];
let layout = layoutDiff(result, { ...(scope ? { scope } : {}), ...extra });
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  layout = layoutDiff(result, { ...(scope ? { scope } : {}), ...extra });
  runs.push(performance.now() - t);
}
const q = quality(result, layout);
console.log(
  `layout (${layout.scope}, ${layout.stats.strategy}): ${layout.positions.size} nodes, ` +
    `${layout.components.length} components, ${layout.stats.iterations} ticks, ` +
    `runs ${runs.map((r) => r.toFixed(0)).join(' / ')} ms`,
);
console.log(
  `layoutToJSON sha256: ${createHash('sha256')
    .update(JSON.stringify(layoutToJSON(layout)))
    .digest('hex')
    .slice(0, 16)}`,
);
console.log(
  `quality: overlap pairs ${q.overlappingPairs} (ratio ${q.labelOverlapRatio.toFixed(5)}), ` +
    `clearance ${q.minClearance.toFixed(1)}, edge ${(q.meanEdgeLength / 56).toFixed(2)}L, aspect ${q.aspect.toFixed(2)}`,
);
