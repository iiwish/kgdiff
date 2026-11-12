import {
  applyDelta,
  type DeltaOp,
  type GraphInput,
  hashGraph,
  invertDelta,
  normalize,
} from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from '../src/sync.js';

/**
 * Changes too large to spread into a single call: V8 caps a call's arguments at roughly 10^5 on
 * its default stack, and building the delta with `ops.push(...edges)` used to throw
 * `RangeError: Maximum call stack size exceeded`. These assert results, not speed.
 */
const NODES = 1_000;
const PER_NODE = 150;
/** 150k: edges added or removed, and attribute values changed. */
const CHANGES = NODES * PER_NODE;
const TIMEOUT = 120_000;

/** `NODES` nodes with `PER_NODE` attributes each; `changed` flips them and adds `CHANGES` edges. */
function graph(changed: boolean): GraphInput {
  const value = changed ? 1 : 0;
  const nodes = Array.from({ length: NODES }, (_, i) => ({
    id: `n${i}`,
    attrs: Object.fromEntries(Array.from({ length: PER_NODE }, (_, k) => [`a${k}`, value])),
  }));
  const edges = changed
    ? Array.from({ length: CHANGES }, (_, j) => {
        const i = Math.floor(j / PER_NODE);
        return { source: `n${i}`, target: `n${(i + 1 + (j % PER_NODE)) % NODES}`, predicate: 'p' };
      })
    : [];
  return { nodes, edges };
}

const count = (ops: readonly DeltaOp[], kind: DeltaOp['op']): number =>
  ops.filter((op) => op.op === kind).length;

describe('changes larger than a call’s argument limit', () => {
  const before = normalize(graph(false));
  const after = normalize(graph(true));

  it(
    'diffs and applies 150k edge additions and 150k attribute changes',
    () => {
      const d = diff(before, after);
      expect(count(d.delta.ops, 'edge.add')).toBe(CHANGES);
      expect(count(d.delta.ops, 'node.attr')).toBe(CHANGES);
      expect(hashGraph(applyDelta(before, d.delta))).toBe(hashGraph(after));
    },
    TIMEOUT,
  );

  it(
    'diffs, applies and inverts 150k edge removals',
    () => {
      const d = diff(after, before);
      expect(count(d.delta.ops, 'edge.remove')).toBe(CHANGES);
      expect(hashGraph(applyDelta(after, d.delta))).toBe(hashGraph(before));
      expect(hashGraph(applyDelta(before, invertDelta(d.delta)))).toBe(hashGraph(after));
    },
    TIMEOUT,
  );
});
