/**
 * End to end with the real diff engine: GraphInput × 2 → diff → layout.
 */
import type { EdgeInput, GraphInput, NodeInput } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from '../../core/src/sync.js';
import { layoutToJSON } from '../src/index.js';
import { mulberry32 } from '../src/prng.js';
import { extendLayout, layoutDiff } from '../src/sync.js';
import { englishLabel } from './support/fixtures.js';
import { quality } from './support/metrics.js';

interface Versions {
  readonly before: GraphInput;
  readonly after: GraphInput;
}

/** A 300-class ontology and its next release: renames, removals, additions, moves, merges. */
function ontology(seed = 21): Versions {
  const random = mulberry32(seed);
  const id = (i: number) => `C:${String(i).padStart(4, '0')}`;
  const n = 300;
  const labels = Array.from({ length: n }, () => englishLabel(random));
  const parent = Array.from({ length: n }, (_, i) => (i === 0 ? -1 : Math.floor(random() * i)));
  const beforeNodes: NodeInput[] = labels.map((label, i) => ({ id: id(i), label }));
  const isA = (child: number, p: number): EdgeInput => ({
    source: id(child),
    target: id(p),
    predicate: 'is_a',
  });
  const beforeEdges = parent.flatMap((p, i) => (p >= 0 ? [isA(i, p)] : []));

  const leaves = new Set(parent.map((_, i) => i));
  for (const p of parent) leaves.delete(p);
  const leafList = [...leaves].sort((a, b) => a - b);
  const removed = new Set(leafList.slice(0, 5));
  const merged = new Map(leafList.slice(5, 8).map((leaf, k) => [leaf, leafList[20 + k]!]));
  const moved = new Map(leafList.slice(30, 35).map((leaf, k) => [leaf, 1 + k]));
  const renamed = new Set([3, 17, 42, 99, 150]);

  const afterNodes: NodeInput[] = [];
  for (let i = 0; i < n; i++) {
    if (removed.has(i) || merged.has(i)) continue;
    const replaces = [...merged].filter(([, into]) => into === i).map(([from]) => id(from));
    afterNodes.push({
      id: id(i),
      label: renamed.has(i) ? `${labels[i]} (v2)` : labels[i]!,
      ...(replaces.length ? { replaces } : {}),
    });
  }
  const afterEdges: EdgeInput[] = [];
  for (let i = 1; i < n; i++) {
    if (removed.has(i) || merged.has(i)) continue;
    afterEdges.push(isA(i, moved.get(i) ?? parent[i]!));
  }
  for (let k = 0; k < 10; k++) {
    afterNodes.push({ id: `N:${k}`, label: englishLabel(random) });
    afterEdges.push({ source: `N:${k}`, target: id(Math.floor(random() * 60)), predicate: 'is_a' });
  }
  return {
    before: { nodes: beforeNodes, edges: beforeEdges },
    after: { nodes: afterNodes, edges: afterEdges },
  };
}

const json = (value: unknown) => JSON.stringify(value);

describe('with the real diff engine', () => {
  const { before, after } = ontology();
  const result = diff(before, after);
  const layout = layoutDiff(result);

  it('lays out every union node readably', () => {
    expect(layout.positions.size).toBe(result.nodes.length);
    const q = quality(result, layout);
    console.info(
      `ontology diff: ${result.nodes.length} nodes, ${layout.stats.ms.toFixed(0)} ms, ` +
        `edge ${(q.meanEdgeLength / 56).toFixed(2)}L, overlap ${q.labelOverlapRatio.toFixed(5)}, ` +
        `merge partners ${q.partnerRatios.map((r) => r.toFixed(2)).join(' ')}`,
    );
    expect(q.hasNaN).toBe(false);
    expect(q.minClearance).toBeGreaterThanOrEqual(0);
    expect(q.overlappingPairs).toBe(0);
    expect(q.meanEdgeLength / 56).toBeLessThanOrEqual(2.2);
    expect(q.partnerRatios.length).toBe(3);
    for (const ratio of q.partnerRatios) expect(ratio).toBeLessThan(1);
  });

  it('is identical for shuffled inputs', () => {
    const random = mulberry32(5);
    const shuffle = <T>(list: readonly T[]): T[] =>
      list
        .map((item) => ({ item, key: random() }))
        .sort((a, b) => a.key - b.key)
        .map((e) => e.item);
    const again = diff(
      { nodes: shuffle(before.nodes), edges: shuffle(before.edges) },
      { nodes: shuffle(after.nodes), edges: shuffle(after.edges) },
    );
    expect(json(layoutToJSON(layoutDiff(again)))).toBe(json(layoutToJSON(layout)));
  });

  it('keeps the previous picture when the before graph carries positions', () => {
    const previous = layoutDiff(diff(before, before));
    const positioned: GraphInput = {
      nodes: before.nodes.map((node) => ({ ...node, position: previous.positions.get(node.id)! })),
      edges: before.edges,
    };
    const anchored = layoutDiff(diff(positioned, after));
    expect(anchored.stats.strategy).toBe('anchored');
    for (const [nodeId, p] of previous.positions) expect(anchored.positions.get(nodeId)).toEqual(p);
    // Known nodes keep their place even where a rename now needs a second label line; every
    // node the layout placed itself is clear of everything.
    const q = quality(diff(positioned, after), anchored);
    for (const [a, b] of q.overlaps) {
      expect(previous.positions.has(a) && previous.positions.has(b)).toBe(true);
    }
  });

  it('focuses on changes and expands them without moving anything', () => {
    const focused = layoutDiff(result, { scope: 'changes' });
    expect(focused.positions.size).toBeLessThan(result.nodes.length);
    for (const hunk of result.hunks) {
      for (const nodeId of [...hunk.nodes, ...hunk.context]) {
        expect(focused.positions.has(nodeId)).toBe(true);
      }
    }
    const [first] = focused.hidden.keys();
    const expand = result.index
      .edgesOf(first!)
      .flatMap((e) => [e.source, e.target])
      .filter((v) => !focused.positions.has(v));
    const expanded = extendLayout(result, focused, expand);
    for (const [nodeId, p] of focused.positions) expect(expanded.positions.get(nodeId)).toBe(p);
    expect(expanded.hidden.get(first!) ?? 0).toBe(0);
  });
});
