/**
 * Timings against the budgets in docs/architecture.md (`pnpm bench`). The assertions are 10×
 * the budget, so they catch complexity regressions on any machine; the bench tables show the
 * actual times. Correctness at these sizes is tested in performance.test.ts.
 */
import { applyDelta, type DiffJSON, diffFromJSON, diffToJSON, normalize } from '@kgdiff/core';
import { expect, test } from 'vitest';
import { diff, matchNodes } from '../src/sync.js';
import { editGraph, extractionPair, syntheticGraph } from './support/synthetic.js';

/** Every sample is a whole diff: a few samples after one warm-up run. */
const WHOLE_RUN = { iterations: 3, time: 0, warmupIterations: 1, warmupTime: 0 };

test('diff, 10k nodes / 30k edges, exact ids (budget 150 ms)', async ({ bench }) => {
  const before = syntheticGraph(10_000, 30_000);
  const after = editGraph(before);
  const fromInputs = await bench('from inputs', () => diff(before, after)).run(WHOLE_RUN);
  const a = normalize(before);
  const b = normalize(after);
  await bench('from normalized graphs', () => diff(a, b)).run(WHOLE_RUN);
  const result = diff(a, b);
  await bench('diffToJSON', () => JSON.stringify(diffToJSON(result))).run(WHOLE_RUN);
  const json = JSON.parse(JSON.stringify(diffToJSON(result))) as DiffJSON;
  await bench('diffFromJSON', () => diffFromJSON(json)).run(WHOLE_RUN);
  expect(fromInputs.latency.p50).toBeLessThan(1500);
});

test.for([2000, 5000])(
  'similarity matching, %i unmatched nodes per side (budget 1.5 s at 5k)',
  async (n, { bench }) => {
    const [before, after] = extractionPair(n).map((g) => normalize(g));
    const match = await bench('matchNodes', () =>
      matchNodes(before!, after!, { strategy: 'similarity' }),
    ).run(WHOLE_RUN);
    await bench('diff', () => diff(before!, after!, { match: { strategy: 'similarity' } })).run({
      ...WHOLE_RUN,
      iterations: 1,
    });
    expect(match.latency.p50).toBeLessThan(15_000);
  },
);

test('diff around a hub: 5k leaves removed from / added to a 10k-child hub', async ({ bench }) => {
  const n = 10_000;
  const nodes = [
    { id: 'root', label: 'Root' },
    ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `Child term number ${i}` })),
  ];
  const edges = Array.from({ length: n }, (_, i) => ({
    source: `c${i}`,
    target: 'root',
    predicate: 'is_a',
  }));
  const full = normalize({ nodes, edges });
  const half = normalize({
    nodes: nodes.filter((_, i) => i % 2 === 0),
    edges: edges.filter((_, i) => i % 2 === 1),
  });
  const grown = normalize({
    nodes: [
      ...nodes,
      ...Array.from({ length: n / 2 }, (_, i) => ({ id: `n${i}`, label: `New term ${i}` })),
    ],
    edges: [
      ...edges,
      ...Array.from({ length: n / 2 }, (_, i) => ({
        source: `n${i}`,
        target: 'root',
        predicate: 'is_a',
      })),
    ],
  });
  // Merge and split detection are on (the default): they must not go quadratic on the hub.
  const removal = await bench('remove 5k leaves', () => diff(full, half)).run(WHOLE_RUN);
  const addition = await bench('add 5k leaves', () => diff(full, grown)).run(WHOLE_RUN);
  expect(removal.latency.p50).toBeLessThan(1500);
  expect(addition.latency.p50).toBeLessThan(1500);
});

test('20k parallel copies of one triple (linear)', async ({ bench }) => {
  const p = 20_000;
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const edges = (offset: number) =>
    Array.from({ length: p }, (_, i) => ({
      source: 'a',
      target: 'b',
      predicate: 'p',
      attrs: { i: i + offset },
    }));
  const before = normalize({ nodes, edges: edges(0) });
  const after = normalize({ nodes, edges: edges(p) });
  const delta = diff(before, after).delta;
  const d = await bench('diff', () => diff(before, after)).run(WHOLE_RUN);
  const applied = await bench('applyDelta', () => applyDelta(before, delta)).run(WHOLE_RUN);
  expect(d.latency.p50 + applied.latency.p50).toBeLessThan(3000);
});
