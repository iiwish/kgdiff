/**
 * Layout timings (`pnpm bench`). Budget (docs/architecture.md): layoutDiff, 2k nodes < 800 ms on
 * an M-class laptop; CLI targets: 5k nodes < 3 s, 10k nodes < 2 s. The assertions are generous so
 * they catch complexity regressions on any machine; the bench tables show the actual times.
 * Quality and determinism at these sizes are tested in perf.test.ts.
 */

import { expect, test } from 'vitest';
import { diff } from '../../core/src/sync.js';
import { extendLayout, layoutDiff } from '../src/sync.js';
import { makeDiff } from './support/diff-builder.js';
import { scaleFree, tree } from './support/fixtures.js';
import { syntheticPair } from './support/synthetic.js';

/** Every sample is a whole layout: a few samples after one warm-up run. */
const WHOLE_LAYOUT = { iterations: 3, time: 0, warmupIterations: 1, warmupTime: 0 };
/** One cold run, as the CLI does it. */
const COLD = { iterations: 1, time: 0, warmup: false };

test('layoutDiff, 2k-node hierarchy (budget 800 ms)', async ({ bench }) => {
  const d = makeDiff(tree(2000));
  const result = await bench('tree 2k', () => layoutDiff(d)).run(WHOLE_LAYOUT);
  expect(result.latency.p50).toBeLessThan(4000);
});

test('layoutDiff, 2k-node scale-free graph (budget 800 ms)', async ({ bench }) => {
  const d = makeDiff(scaleFree(2000, 1.3));
  const result = await bench('scale-free 2k', () => layoutDiff(d)).run(WHOLE_LAYOUT);
  expect(result.latency.p50).toBeLessThan(4000);
});

test('layoutDiff, 5k nodes, scope all (CLI target 3 s)', async ({ bench }) => {
  const d = makeDiff(scaleFree(5000, 1.3));
  const result = await bench('scale-free 5k', () => layoutDiff(d, { scope: 'all' })).run(
    WHOLE_LAYOUT,
  );
  expect(result.latency.p50).toBeLessThan(9000);
});

test('layoutDiff, dense 10k nodes, scope all (CLI target 2 s)', async ({ bench }) => {
  const d = makeDiff(scaleFree(10_000, 2));
  const result = await bench('scale-free 10k', () => layoutDiff(d, { scope: 'all' })).run(COLD);
  expect(result.latency.p50).toBeLessThan(8000);
});

test('layoutDiff, synth-10k, scope changes (scripts/gen-synthetic.ts)', async ({ bench }) => {
  const { before, after } = syntheticPair(10_000, 7);
  const d = diff(before, after);
  const result = await bench('synth-10k', () => layoutDiff(d)).run(WHOLE_LAYOUT);
  expect(result.latency.p50).toBeLessThan(8000);
});

test('extendLayout, 5 nodes into a 1,495-node layout (simulation window)', async ({ bench }) => {
  const big = makeDiff(scaleFree(1500, 1.3));
  const all = layoutDiff(big);
  const removed = ['s0100', 's0200', 's0300', 's0400', 's0500'];
  const partial = {
    ...all,
    positions: new Map([...all.positions].filter(([id]) => !removed.includes(id))),
  };
  const result = await bench('extend 5 into 1495', () => extendLayout(big, partial, removed)).run({
    iterations: 5,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  });
  expect(result.latency.p50).toBeLessThan(2000);
});
