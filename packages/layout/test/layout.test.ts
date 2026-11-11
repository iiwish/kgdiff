import { KgdiffError } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { type LayoutResult, layoutDiff, layoutToJSON, nodeRadius } from '../src/index.js';
import { LABEL_GAP, labelBox } from '../src/label-box.js';
import { deepFreeze, type GraphSpec, makeDiff } from './support/diff-builder.js';
import { changes, components, shuffled, tree } from './support/fixtures.js';

const json = (layout: LayoutResult): string => JSON.stringify(layoutToJSON(layout));

describe('layoutDiff: basics', () => {
  it('returns an empty layout for an empty diff', () => {
    const layout = layoutDiff(makeDiff({ nodes: [], edges: [] }));
    expect(layout.positions.size).toBe(0);
    expect(layout.components).toEqual([]);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(layout.stats).toMatchObject({ strategy: 'union', iterations: 0, nodes: 0 });
  });

  it('places a single node at the origin with its label below', () => {
    const layout = layoutDiff(makeDiff({ nodes: [{ id: 'only', label: 'Only' }], edges: [] }));
    const p = layout.positions.get('only')!;
    expect(layout.radii.get('only')).toBe(nodeRadius(0));
    // Bounds (node + label) are centered on the origin.
    expect(layout.bounds.x + layout.bounds.width / 2).toBeCloseTo(0, 1);
    expect(layout.bounds.y + layout.bounds.height / 2).toBeCloseTo(0, 1);
    expect(p.y).toBeLessThan(0);
    expect(layout.components).toHaveLength(1);
  });

  it('handles self-loops, parallel edges, cycles and special ids without NaN', () => {
    const ids = ['a|b', 'say "hi"', 'with space', 'http://x.org/onto#C', '__proto__', '42'];
    const spec: GraphSpec = {
      nodes: ids.map((id) => ({ id })),
      edges: [
        { source: 'a|b', target: 'a|b' },
        { source: 'a|b', target: 'say "hi"' },
        { source: 'a|b', target: 'say "hi"' },
        { source: 'say "hi"', target: 'a|b', predicate: 'other' },
        { source: 'say "hi"', target: 'with space' },
        { source: 'with space', target: 'a|b' },
        { source: '__proto__', target: '42' },
      ],
    };
    const layout = layoutDiff(makeDiff(spec));
    expect(layout.positions.size).toBe(ids.length);
    for (const p of layout.positions.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    expect(Object.hasOwn(layoutToJSON(layout).positions, '__proto__')).toBe(true);
  });

  it('gives every node the radius of its max degree across versions', () => {
    const diff = makeDiff(changes());
    const layout = layoutDiff(diff);
    for (const node of diff.nodes) {
      expect(layout.radii.get(node.id)).toBe(
        nodeRadius(Math.max(node.degree.before, node.degree.after)),
      );
    }
  });

  it('rounds computed coordinates to 0.01', () => {
    const layout = layoutDiff(makeDiff(tree(40)));
    for (const p of layout.positions.values()) {
      expect(Math.round(p.x * 100) / 100).toBe(p.x);
      expect(Math.round(p.y * 100) / 100).toBe(p.y);
    }
  });

  it('reports bounds that contain every node and label box, centered on the origin', () => {
    const diff = makeDiff(changes());
    const layout = layoutDiff(diff);
    const b = layout.bounds;
    for (const node of diff.nodes) {
      const p = layout.positions.get(node.id)!;
      const r = layout.radii.get(node.id)!;
      const rename = node.facets.find((f) => f.kind === 'rename');
      const label = labelBox(node.label, rename?.kind === 'rename' ? rename.from : undefined, 12);
      expect(p.x - Math.max(r, label.width / 2)).toBeGreaterThanOrEqual(b.x - 1e-9);
      expect(p.x + Math.max(r, label.width / 2)).toBeLessThanOrEqual(b.x + b.width + 1e-9);
      expect(p.y - r).toBeGreaterThanOrEqual(b.y - 1e-9);
      expect(p.y + r + LABEL_GAP + label.height).toBeLessThanOrEqual(b.y + b.height + 1e-9);
    }
    expect(Math.abs(b.x + b.width / 2)).toBeLessThan(0.05);
    expect(Math.abs(b.y + b.height / 2)).toBeLessThan(0.05);
  });

  it('lists connected components largest first, each node exactly once', () => {
    const diff = makeDiff(components());
    const layout = layoutDiff(diff);
    const seen = new Set<string>();
    let previous = Number.POSITIVE_INFINITY;
    for (const component of layout.components) {
      expect(component.nodes.length).toBeLessThanOrEqual(previous);
      previous = component.nodes.length;
      for (const id of component.nodes) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      expect([...component.nodes]).toEqual([...component.nodes].sort());
    }
    expect(seen.size).toBe(diff.nodes.length);
  });

  it('does not mutate its input', () => {
    const diff = deepFreeze(makeDiff(changes()));
    expect(() => layoutDiff(diff)).not.toThrow();
  });

  it('returns frozen points, components and stats', () => {
    const layout = layoutDiff(makeDiff(tree(10)));
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.positions.get('t0000'))).toBe(true);
    expect(Object.isFrozen(layout.components)).toBe(true);
    expect(Object.isFrozen(layout.stats)).toBe(true);
  });
});

describe('layoutDiff: determinism', () => {
  it('produces byte-identical JSON for the same input and seed', () => {
    const a = layoutDiff(makeDiff(changes()), { seed: 7 });
    const b = layoutDiff(makeDiff(changes()), { seed: 7 });
    expect(json(a)).toBe(json(b));
  });

  it('produces a different layout for a different seed', () => {
    const diff = makeDiff(changes());
    expect(json(layoutDiff(diff, { seed: 1 }))).not.toBe(json(layoutDiff(diff, { seed: 2 })));
  });

  it('does not depend on the order fixtures are built in', () => {
    const spec = changes();
    const reference = json(layoutDiff(makeDiff(spec)));
    for (const seed of [1, 2, 3]) {
      expect(json(layoutDiff(makeDiff(shuffled(spec, seed))))).toBe(reference);
    }
  });

  it('sorts unsorted node / edge arrays itself', () => {
    const diff = makeDiff(components(8, 5));
    const reversed = {
      ...diff,
      nodes: [...diff.nodes].reverse(),
      edges: [...diff.edges].reverse(),
    };
    expect(json(layoutDiff(reversed))).toBe(json(layoutDiff(diff)));
  });

  it('accepts non-integer seeds deterministically', () => {
    const diff = makeDiff(tree(30));
    expect(json(layoutDiff(diff, { seed: 0.5 }))).toBe(json(layoutDiff(diff, { seed: 0.5 })));
    expect(json(layoutDiff(diff, { seed: 0.5 }))).not.toBe(json(layoutDiff(diff, { seed: 1 })));
  });
});

describe('layoutDiff: options', () => {
  it('uses clamp(300 − 25·log2(N), 120, 300) iterations by default', () => {
    expect(layoutDiff(makeDiff(tree(2))).stats.iterations).toBe(275);
    expect(layoutDiff(makeDiff(tree(64))).stats.iterations).toBe(150);
    expect(layoutDiff(makeDiff(tree(300))).stats.iterations).toBe(120);
    expect(layoutDiff(makeDiff(tree(30)), { iterations: 17 }).stats.iterations).toBe(17);
  });

  it('still separates nodes and labels with zero iterations', () => {
    const diff = makeDiff(tree(60));
    const layout = layoutDiff(diff, { iterations: 0 });
    expect(layout.stats.iterations).toBe(0);
    const ids = [...layout.positions.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = layout.positions.get(ids[i]!)!;
        const b = layout.positions.get(ids[j]!)!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d).toBeGreaterThanOrEqual(layout.radii.get(ids[i]!)! + layout.radii.get(ids[j]!)!);
      }
    }
  });

  it('scales with linkDistance', () => {
    const diff = makeDiff(tree(40));
    const small = layoutDiff(diff, { linkDistance: 30, labelAware: false });
    const large = layoutDiff(diff, { linkDistance: 120, labelAware: false });
    expect(large.bounds.width * large.bounds.height).toBeGreaterThan(
      2 * small.bounds.width * small.bounds.height,
    );
  });

  it('reserves less room when labels are ignored', () => {
    const diff = makeDiff(tree(80));
    const aware = layoutDiff(diff);
    const unaware = layoutDiff(diff, { labelAware: false });
    expect(unaware.bounds.width * unaware.bounds.height).toBeLessThan(
      aware.bounds.width * aware.bounds.height,
    );
  });

  it.each([
    [{ linkDistance: 0 }],
    [{ linkDistance: Number.NaN }],
    [{ fontSize: -1 }],
    [{ iterations: 1.5 }],
    [{ iterations: -1 }],
    [{ contextHops: -1 }],
    [{ componentGap: Number.POSITIVE_INFINITY }],
    [{ seed: Number.NaN }],
    [{ strategy: 'force' as never }],
    [{ scope: 'some' as never }],
    [{ pinned: new Map([['t0000', { x: Number.NaN, y: 0 }]]) }],
  ])('rejects invalid options %j with KgdiffError invalid-input', (options) => {
    const diff = makeDiff(tree(3));
    try {
      layoutDiff(diff, options);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(KgdiffError);
      expect((error as KgdiffError).code).toBe('invalid-input');
    }
  });
});
