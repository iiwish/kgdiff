/**
 * The CLI's large benchmark: a generated 10k-node pair (scripts/gen-synthetic.ts) whose class
 * hubs used to pull every node into the `changes` scope. Its timing is in perf.bench.ts.
 */

import { describe, expect, it } from 'vitest';
import { diff } from '../../core/src/sync.js';
import { layoutToJSON } from '../src/index.js';
import { layoutDiff } from '../src/sync.js';
import { quality } from './support/metrics.js';
import { syntheticPair } from './support/synthetic.js';

describe('synth-10k (scope changes, hub-aware context)', () => {
  const { before, after } = syntheticPair(10_000, 7);
  const result = diff(before, after);

  it('lays out the changes and their context, not the whole graph, deterministically', () => {
    const layout = layoutDiff(result);
    console.info(
      `synth-10k: ${result.nodes.length} union nodes → ${layout.positions.size} in scope, ` +
        `${layout.stats.iterations} ticks`,
    );
    expect(layout.scope).toBe('changes');
    expect(layout.positions.size).toBeGreaterThan(3000);
    expect(layout.positions.size).toBeLessThan(0.6 * result.nodes.length);
    for (const node of result.nodes) {
      if (node.status !== 'unchanged') expect(layout.positions.has(node.id)).toBe(true);
    }
    const again = layoutDiff(result);
    expect(JSON.stringify(layoutToJSON(again))).toBe(JSON.stringify(layoutToJSON(layout)));
    expect(quality(result, layout).labelOverlapRatio).toBeLessThan(0.001);
  }, 60_000);
});
