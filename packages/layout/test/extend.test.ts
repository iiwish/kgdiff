import { KgdiffError } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { layoutToJSON, nodeRadius } from '../src/index.js';
import { extendLayout, layoutDiff } from '../src/sync.js';
import { makeDiff } from './support/diff-builder.js';
import { changes, scaleFree } from './support/fixtures.js';
import { quality } from './support/metrics.js';

describe('extendLayout', () => {
  const diff = makeDiff(changes());
  const scoped = layoutDiff(diff, { scope: 'changes' });
  const hiddenNeighbours = (id: string): string[] =>
    diff.index
      .edgesOf(id)
      .flatMap((e) => [e.source, e.target, e.sourceBefore, e.targetBefore])
      .filter((v): v is string => v !== undefined && v !== id && !scoped.positions.has(v));
  const expandFrom = [...scoped.hidden.keys()].slice(0, 4);
  const added = [...new Set(expandFrom.flatMap(hiddenNeighbours))].sort();
  const extended = extendLayout(diff, scoped, added);

  it('adds the requested nodes and keeps every existing position exactly', () => {
    expect(added.length).toBeGreaterThan(0);
    for (const [id, p] of scoped.positions) expect(extended.positions.get(id)).toBe(p);
    for (const id of added) expect(extended.positions.has(id)).toBe(true);
    expect(extended.positions.size).toBe(scoped.positions.size + added.length);
  });

  it('places new nodes without overlapping anything', () => {
    const q = quality(diff, extended);
    expect(q.hasNaN).toBe(false);
    expect(q.minClearance).toBeGreaterThanOrEqual(0);
    expect(q.overlappingPairs).toBe(0);
  });

  it('places new nodes among their placed neighbours', () => {
    const L = 56;
    const neighboursOf = (id: string): string[] =>
      diff.index
        .edgesOf(id)
        .flatMap((e) => [e.source, e.target])
        .filter((v) => v !== id && scoped.positions.has(v));
    const dist = (a: string, b: string): number => {
      const p = extended.positions.get(a)!;
      const q = extended.positions.get(b)!;
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    // How far a placed node's existing neighbours already sit (a hub's ring is wide).
    const reach = (v: string): number => Math.max(0, ...neighboursOf(v).map((u) => dist(u, v)));
    for (const id of added) {
      const placed = neighboursOf(id);
      expect(placed.length).toBeGreaterThan(0);
      const p = extended.positions.get(id)!;
      const xs = placed.map((v) => extended.positions.get(v)!.x);
      const ys = placed.map((v) => extended.positions.get(v)!.y);
      // Between its placed neighbours (their box grown by 3.5·L) …
      const between =
        p.x > Math.min(...xs) - 3.5 * L &&
        p.x < Math.max(...xs) + 3.5 * L &&
        p.y > Math.min(...ys) - 3.5 * L &&
        p.y < Math.max(...ys) + 3.5 * L;
      // … or close to one of them: within the ring that neighbour's edges already span plus L,
      // and at most 6·L (here several new nodes compete for room around one crowded hub).
      const near = placed.some((v) => dist(id, v) <= Math.max(6 * L, reach(v) + L));
      expect(between || near).toBe(true);
    }
  });

  it('recounts hidden neighbours and adds radii', () => {
    for (const id of expandFrom) {
      expect(extended.hidden.get(id) ?? 0).toBeLessThan(scoped.hidden.get(id)!);
    }
    for (const id of added) {
      const node = diff.index.node(id)!;
      expect(extended.radii.get(id)).toBe(
        nodeRadius(Math.max(node.degree.before, node.degree.after)),
      );
    }
    expect(extended.scope).toBe('changes');
    expect(extended.stats.strategy).toBe(scoped.stats.strategy);
  });

  it('is deterministic', () => {
    const again = extendLayout(diff, scoped, [...added].reverse());
    expect(JSON.stringify(layoutToJSON(again))).toBe(JSON.stringify(layoutToJSON(extended)));
  });

  it('returns the layout itself when every node is already placed', () => {
    expect(extendLayout(diff, scoped, [...scoped.positions.keys()].slice(0, 3))).toBe(scoped);
  });

  it('throws KgdiffError for ids that are not in the diff', () => {
    expect(() => extendLayout(diff, scoped, ['nope'])).toThrow(KgdiffError);
  });

  it('packs nodes with no placed neighbour beside the existing bounds', () => {
    const lonely = diff.nodes.find(
      (n) => !scoped.positions.has(n.id) && diff.index.edgesOf(n.id).length === 0,
    );
    const target =
      lonely?.id ??
      [...diff.nodes].reverse().find((n) => !scoped.positions.has(n.id) && hiddenNeighbours(n.id))
        ?.id;
    expect(target).toBeDefined();
    const result = extendLayout(diff, scoped, [target!]);
    const q = quality(diff, result);
    expect(q.overlappingPairs).toBe(0);
  });

  it('re-adds nodes to a large layout without moving the placed ones (simulation window)', () => {
    const big = makeDiff(scaleFree(1500, 1.3));
    const base = layoutDiff(big, { scope: 'changes', largeGraphThreshold: 0 });
    expect(base.positions.size).toBe(0);
    const all = layoutDiff(big);
    // Drop a handful of nodes from a full layout, then add them back.
    const removed = ['s0100', 's0200', 's0300', 's0400', 's0500'];
    const partial = {
      ...all,
      positions: new Map([...all.positions].filter(([id]) => !removed.includes(id))),
    };
    const back = extendLayout(big, partial, removed);
    for (const [id, p] of partial.positions) expect(back.positions.get(id)).toBe(p);
    // Only pairs among already placed nodes may overlap (a dense scale-free core can keep a
    // couple in the base layout); the re-added nodes are clear of everything.
    for (const [a, b] of quality(big, back).overlaps) {
      expect(removed.includes(a) || removed.includes(b)).toBe(false);
    }
  }, 60_000);
});
