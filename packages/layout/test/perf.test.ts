/**
 * Layout quality and determinism at the sizes of the performance budgets (docs/architecture.md):
 * 2k nodes, and 5k / 10k nodes with scope `all` as the CLI lays them out. Their timings are in
 * perf.bench.ts (`pnpm bench`); the timeout here only guards against hangs.
 */
import { describe, expect, it } from 'vitest';
import { layoutToJSON } from '../src/index.js';
import { layoutDiff } from '../src/sync.js';
import { makeDiff } from './support/diff-builder.js';
import { scaleFree, tree } from './support/fixtures.js';
import { quality } from './support/metrics.js';

describe('large graphs', { timeout: 60_000 }, () => {
  it('lays out a 2k-node hierarchy without overlapping nodes', () => {
    const diff = makeDiff(tree(2000));
    expect(quality(diff, layoutDiff(diff)).overlappingPairs).toBe(0);
  });

  it('lays out a 2k-node scale-free graph with almost no overlapping labels', () => {
    const diff = makeDiff(scaleFree(2000, 1.3));
    expect(quality(diff, layoutDiff(diff)).labelOverlapRatio).toBeLessThan(0.001);
  });

  it('lays out a 5k-node graph (scope all) in 48 ticks, deterministically', () => {
    const diff = makeDiff(scaleFree(5000, 1.3));
    const layout = layoutDiff(diff, { scope: 'all' });
    const again = layoutDiff(diff, { scope: 'all' });
    expect(layout.stats.iterations).toBe(48);
    expect(JSON.stringify(layoutToJSON(again))).toBe(JSON.stringify(layoutToJSON(layout)));
    expect(quality(diff, layout).labelOverlapRatio).toBeLessThan(0.001);
  });

  it('lays out a dense 10k-node graph (scope all) in 30 ticks', () => {
    const diff = makeDiff(scaleFree(10_000, 2));
    const layout = layoutDiff(diff, { scope: 'all' });
    expect(layout.stats.iterations).toBe(30);
    expect(quality(diff, layout).labelOverlapRatio).toBeLessThan(0.001);
  });
});
