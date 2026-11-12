/**
 * The engine at the sizes of the budgets in docs/architecture.md: results stay correct on big
 * inputs, and the heap budget holds. The timings are in performance.bench.ts (`pnpm bench`); the
 * timeout here only guards against hangs. Retained memory, unlike time, barely varies between
 * runs and machines, so it is asserted here.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { applyDelta, hashGraph, normalize } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff, matchNodes } from '../src/sync.js';
import { editGraph, extractionPair, syntheticGraph } from './support/synthetic.js';

/** Bytes of heap retained by what `make` returns (returned too, so it stays alive). */
function retainedBy<T>(make: () => T): readonly [T, number] {
  // Exposes `gc` to new contexts, so the test needs no `--expose-gc` flag.
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  const start = process.memoryUsage().heapUsed;
  const value = make();
  gc();
  return [value, process.memoryUsage().heapUsed - start];
}

describe('memory', { timeout: 60_000 }, () => {
  // About 111 MB on Node 24. Edge keys built by concatenation (V8 ropes) instead of as flat
  // strings took it to 157 MB.
  it('normalizes 100k nodes / 300k edges within the heap budget (135 MB)', () => {
    const input = syntheticGraph(100_000, 300_000);
    const [graph, bytes] = retainedBy(() => normalize(input));
    expect(graph.edges.size).toBeGreaterThan(299_000);
    expect(bytes / 2 ** 20).toBeLessThan(135);
  });
});

describe('large inputs', { timeout: 60_000 }, () => {
  it('diffs 10k nodes / 30k edges with exact ids into a delta that applies', () => {
    const before = syntheticGraph(10_000, 30_000);
    const result = diff(before, editGraph(before));
    expect(result.stats.nodes.added).toBeGreaterThan(0);
    expect(hashGraph(applyDelta(result.before, result.delta))).toBe(hashGraph(result.after));
  });

  it.each([2000, 5000])('matches %i unmatched nodes per side by similarity', (n) => {
    const [before, after] = extractionPair(n).map((g) => normalize(g));
    const result = matchNodes(before!, after!, { strategy: 'similarity' });
    expect(result.matches.length).toBeGreaterThan(n * 0.95);
  });

  it('round-trips 20k parallel copies of one triple', () => {
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
    expect(hashGraph(applyDelta(before, diff(before, after).delta))).toBe(hashGraph(after));
  });
});
