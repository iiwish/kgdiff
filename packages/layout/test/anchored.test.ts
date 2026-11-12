import type { Point } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { type LayoutResult, layoutToJSON } from '../src/index.js';
import { layoutDiff } from '../src/sync.js';
import { type GraphSpec, makeDiff, type NodeSpec } from './support/diff-builder.js';
import { scaleFree, tree } from './support/fixtures.js';
import { quality } from './support/metrics.js';

const L = 56;

/** The same graph with every node's before-position taken from `layout`. */
function withBeforePositions(spec: GraphSpec, layout: LayoutResult): NodeSpec[] {
  return spec.nodes.map((n) => {
    const p = layout.positions.get(n.id);
    return p ? { ...n, beforePosition: p } : n;
  });
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('anchored strategy', () => {
  const base = scaleFree(150, 1.3);
  const first = layoutDiff(makeDiff(base));
  const grown: GraphSpec = {
    nodes: [
      ...withBeforePositions(base, first),
      { id: 'new-a', label: 'New A', status: 'added' },
      { id: 'new-b', label: 'New B', status: 'added' },
      { id: 'new-c', label: 'New C', status: 'added' },
      { id: 'new-d', label: 'New D', status: 'added' },
    ],
    edges: [
      ...base.edges,
      { source: 'new-a', target: 's0000', status: 'added' },
      { source: 'new-b', target: 's0000', status: 'added' },
      { source: 'new-c', target: 's0042', status: 'added' },
      { source: 'new-d', target: 'new-c', status: 'added' },
    ],
  };
  const diff = makeDiff(grown);
  const layout = layoutDiff(diff);

  it('is the default when positions are known', () => {
    expect(layout.stats.strategy).toBe('anchored');
  });

  it('keeps every known position exactly, so nothing jumps', () => {
    for (const [id, p] of first.positions) expect(layout.positions.get(id)).toEqual(p);
  });

  it('places new nodes next to their neighbours, without overlap', () => {
    // "Next to": within the ring the neighbour's existing edges already span (a hub's
    // neighbourhood is full, so a new leaf may have to sit a little farther out), plus L.
    const reach = (id: string): number => {
      const p = first.positions.get(id);
      if (p === undefined) return 0;
      const lengths = diff.index
        .edgesOf(id)
        .flatMap((e) => [e.source, e.target])
        .map((v) => first.positions.get(v))
        .filter((q): q is Point => q !== undefined)
        .map((q) => distance(p, q));
      return Math.max(0, ...lengths);
    };
    for (const [node, neighbour] of [
      ['new-a', 's0000'],
      ['new-b', 's0000'],
      ['new-c', 's0042'],
      ['new-d', 'new-c'],
    ] as const) {
      const d = distance(layout.positions.get(node)!, layout.positions.get(neighbour)!);
      expect(d).toBeLessThan(Math.max(2.5 * L, reach(neighbour) + L));
    }
    const q = quality(diff, layout);
    expect(q.minClearance).toBeGreaterThanOrEqual(0);
    expect(q.overlappingPairs).toBe(0);
  });

  it('preserves pinned positions exactly, unrounded, and pins win over node positions', () => {
    const pinned = new Map<string, Point>([
      ['s0001', { x: 1234.5678, y: -98.7654 }],
      ['new-a', { x: 10.001, y: 20.002 }],
    ]);
    const pinnedLayout = layoutDiff(diff, { pinned });
    expect(pinnedLayout.positions.get('s0001')).toEqual({ x: 1234.5678, y: -98.7654 });
    expect(pinnedLayout.positions.get('new-a')).toEqual({ x: 10.001, y: 20.002 });
    expect(pinnedLayout.positions.get('s0002')).toEqual(first.positions.get('s0002'));
  });

  it('uses after-version positions for nodes that only exist after', () => {
    const spec: GraphSpec = {
      nodes: [
        { id: 'a', beforePosition: { x: 0, y: 0 } },
        { id: 'b', status: 'added', afterPosition: { x: 300, y: 40 } },
        { id: 'c', status: 'added' },
      ],
      edges: [
        { source: 'b', target: 'a', status: 'added' },
        { source: 'c', target: 'a', status: 'added' },
      ],
    };
    const result = layoutDiff(makeDiff(spec));
    expect(result.positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(result.positions.get('b')).toEqual({ x: 300, y: 40 });
    expect(distance(result.positions.get('c')!, { x: 0, y: 0 })).toBeLessThan(2.5 * L);
  });

  it('is deterministic and stable when more nodes are added elsewhere', () => {
    expect(JSON.stringify(layoutToJSON(layoutDiff(diff)))).toBe(
      JSON.stringify(layoutToJSON(layout)),
    );
    const more = makeDiff({
      nodes: [...grown.nodes, { id: 'new-z', label: 'Far away', status: 'added' }],
      edges: [...grown.edges, { source: 'new-z', target: 's0120', status: 'added' }],
    });
    const again = layoutDiff(more);
    for (const [id, p] of first.positions) expect(again.positions.get(id)).toEqual(p);
  });

  it('packs components without any known position beside the anchored region', () => {
    const spec: GraphSpec = {
      nodes: [
        ...withBeforePositions(base, first),
        { id: 'island-1', label: 'Island one', status: 'added' },
        { id: 'island-2', label: 'Island two', status: 'added' },
        { id: 'lonely', label: 'Lonely', status: 'added' },
      ],
      edges: [...base.edges, { source: 'island-1', target: 'island-2', status: 'added' }],
    };
    const result = layoutDiff(makeDiff(spec));
    const b = first.bounds;
    for (const id of ['island-1', 'island-2', 'lonely']) {
      const p = result.positions.get(id)!;
      const outside = p.x > b.x + b.width || p.y > b.y + b.height;
      expect(outside).toBe(true);
    }
  });

  it('ignores known positions when the union strategy is requested', () => {
    const union = layoutDiff(diff, { strategy: 'union' });
    expect(union.stats.strategy).toBe('union');
    expect(union.positions.get('s0001')).not.toEqual(first.positions.get('s0001'));
    expect(Math.abs(union.bounds.x + union.bounds.width / 2)).toBeLessThan(0.05);
  });

  it('falls back to a free layout when anchored is requested but nothing is known', () => {
    const result = layoutDiff(makeDiff(tree(20)), { strategy: 'anchored' });
    expect(result.stats.strategy).toBe('anchored');
    expect(result.positions.size).toBe(20);
  });
});
