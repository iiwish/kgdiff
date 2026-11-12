import { diff } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { buildScene, computeFocus } from '../src/index.js';
import { makeLayout } from './fixtures.js';

/**
 * A hunk with more relations than fit in a call's arguments (roughly 10^5 on V8's default
 * stack): focusing it used to spread every edge into one `push` and throw `RangeError`.
 */
const LEAVES = 150_000;

describe('a hunk larger than a call’s argument limit', () => {
  it('focuses a hub removed with 150k relations', async () => {
    const leaves = Array.from({ length: LEAVES }, (_, i) => ({ id: `l${i}` }));
    const d = await diff(
      {
        nodes: [{ id: 'hub' }, ...leaves],
        edges: leaves.map((l) => ({ source: 'hub', target: l.id, predicate: 'p' })),
      },
      { nodes: leaves, edges: [] },
    );
    expect(d.hunks).toHaveLength(1);
    const positions = Object.fromEntries(
      d.nodes.map((n, i) => [n.id, [i % 400, Math.floor(i / 400)] as const]),
    );
    const focus = computeFocus(buildScene(d, makeLayout(d, positions)), { hunk: 0 });
    expect(focus.nodes.reduce((sum, v) => sum + v, 0)).toBe(LEAVES + 1);
    expect(focus.edges.reduce((sum, v) => sum + v, 0)).toBe(LEAVES);
  }, 120_000);
});
