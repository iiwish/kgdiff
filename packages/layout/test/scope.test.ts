import type { DiffResult } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { layoutDiff } from '../src/sync.js';
import { makeDiff } from './support/diff-builder.js';
import { changes, tree } from './support/fixtures.js';

/** Brute-force reference: neighbours over both versions of every edge. */
function neighbours(diff: DiffResult): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(diff.nodes.map((n) => [n.id, new Set()]));
  const link = (a: string | undefined, b: string | undefined): void => {
    if (a === undefined || b === undefined || a === b) return;
    out.get(a)?.add(b);
    out.get(b)?.add(a);
  };
  for (const e of diff.edges) {
    link(e.source, e.target);
    link(e.sourceBefore ?? e.source, e.targetBefore ?? e.target);
  }
  return out;
}

/**
 * Reference for scope `changes` (docs/algorithms.md §12): changed nodes at distance 0, unchanged
 * endpoints of changed edges at distance 1, BFS that never expands from a hub.
 */
function expectedScope(diff: DiffResult, hops: number, hubDegree = 40): Set<string> {
  const adj = neighbours(diff);
  const degree = new Map(diff.nodes.map((n) => [n.id, Math.max(n.degree.before, n.degree.after)]));
  const distance = new Map<string, number>();
  for (const n of diff.nodes) if (n.status !== 'unchanged') distance.set(n.id, 0);
  for (const e of diff.edges) {
    if (e.status === 'unchanged') continue;
    for (const id of [e.source, e.target, e.sourceBefore, e.targetBefore]) {
      if (id !== undefined && !distance.has(id)) distance.set(id, 1);
    }
  }
  for (let d = 0; d < hops; d++) {
    for (const [id, dist] of [...distance]) {
      if (dist !== d || degree.get(id)! > hubDegree) continue;
      for (const v of adj.get(id) ?? []) if (!distance.has(v)) distance.set(v, d + 1);
    }
  }
  return new Set(distance.keys());
}

describe('scope', () => {
  const diff = makeDiff(changes());

  it.each([0, 1, 2, 3])('changes + %i context hops places exactly those nodes', (hops) => {
    const layout = layoutDiff(diff, { scope: 'changes', contextHops: hops });
    const expected = expectedScope(diff, hops);
    expect(new Set(layout.positions.keys())).toEqual(expected);
    expect(layout.scope).toBe('changes');
    expect(layout.radii.size).toBe(expected.size);
    expect(layout.stats.nodes).toBe(expected.size);
  });

  it('counts hidden neighbours per visible node', () => {
    const layout = layoutDiff(diff, { scope: 'changes' });
    const adj = neighbours(diff);
    let total = 0;
    for (const id of layout.positions.keys()) {
      const missing = [...adj.get(id)!].filter((v) => !layout.positions.has(v)).length;
      expect(layout.hidden.get(id) ?? 0).toBe(missing);
      total += missing;
    }
    expect(total).toBeGreaterThan(0);
    for (const [id, count] of layout.hidden) {
      expect(layout.positions.has(id)).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
  });

  it('keeps both endpoints of a relation-only change readable', () => {
    const spec = tree(30);
    const relation = makeDiff({
      nodes: spec.nodes,
      edges: [...spec.edges, { source: 't0020', target: 't0021', status: 'added' }],
    });
    const layout = layoutDiff(relation, { scope: 'changes', contextHops: 0 });
    expect([...layout.positions.keys()].sort()).toEqual(['t0020', 't0021']);
  });

  it('defaults to changes only above largeGraphThreshold nodes', () => {
    expect(layoutDiff(diff).scope).toBe('all');
    expect(layoutDiff(diff, { largeGraphThreshold: 100 }).scope).toBe('changes');
    expect(layoutDiff(diff, { largeGraphThreshold: 130 }).scope).toBe('all');
  });

  it('has no hidden nodes for scope all', () => {
    expect(layoutDiff(diff).hidden.size).toBe(0);
  });

  it('never expands context from a hub, counting what it hides', () => {
    // A changed hub with 60 leaves, one changed leaf with an unchanged neighbour chain.
    const nodes = [
      {
        id: 'hub',
        status: 'modified' as const,
        facets: [{ kind: 'rename' as const, from: 'H', to: 'hub' }],
      },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `leaf${String(i).padStart(2, '0')}` })),
      { id: 'x', status: 'added' as const },
      { id: 'y' },
      { id: 'z' },
    ];
    const edges = [
      ...nodes.slice(1, 61).map((n) => ({ source: n.id, target: 'hub' })),
      { source: 'x', target: 'leaf00', status: 'added' as const },
      { source: 'y', target: 'x', status: 'added' as const },
      { source: 'z', target: 'y' },
    ];
    const hubDiff = makeDiff({ nodes, edges });
    const layout = layoutDiff(hubDiff, { scope: 'changes' });
    // hub (changed), x (added), leaf00 and y (endpoints of added edges, distance 1). The hub's
    // other leaves would only enter through the hub; z is two hops from x.
    expect([...layout.positions.keys()].sort()).toEqual(['hub', 'leaf00', 'x', 'y']);
    expect(layout.hidden.get('hub')).toBe(59);
    expect(layout.hidden.get('y')).toBe(1);
    expect(new Set(layout.positions.keys())).toEqual(expectedScope(hubDiff, 1));
    // Without the rule the hub pulls in all of its leaves.
    const all = layoutDiff(hubDiff, { scope: 'changes', hubDegree: Number.POSITIVE_INFINITY });
    expect(all.positions.size).toBe(63);
    expect(all.hidden.get('hub')).toBeUndefined();
    // Two hops: z enters through y; the hub still does not expand.
    const two = layoutDiff(hubDiff, { scope: 'changes', contextHops: 2 });
    expect([...two.positions.keys()].sort()).toEqual(['hub', 'leaf00', 'x', 'y', 'z']);
  });

  it('keeps a reachable hub in scope without expanding from it', () => {
    const spec = {
      nodes: [
        { id: 'a', status: 'added' as const },
        { id: 'hub' },
        ...Array.from({ length: 50 }, (_, i) => ({ id: `n${i}` })),
      ],
      edges: [
        { source: 'a', target: 'hub', status: 'added' as const },
        ...Array.from({ length: 50 }, (_, i) => ({ source: `n${i}`, target: 'hub' })),
      ],
    };
    const layout = layoutDiff(makeDiff(spec), { scope: 'changes', contextHops: 3 });
    expect([...layout.positions.keys()].sort()).toEqual(['a', 'hub']);
    expect(layout.hidden.get('hub')).toBe(50);
  });

  it('rejects a negative hubDegree', () => {
    expect(() => layoutDiff(diff, { hubDegree: -1 })).toThrow(/hubDegree/);
  });

  it('is empty when nothing changed', () => {
    const layout = layoutDiff(makeDiff(tree(20)), { scope: 'changes' });
    expect(layout.positions.size).toBe(0);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
