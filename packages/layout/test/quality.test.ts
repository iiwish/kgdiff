/**
 * Layout quality as regression guards. Values are logged so changes in quality are visible in
 * the test output; thresholds are deliberately a little looser than today's values.
 */
import { describe, expect, it } from 'vitest';
import type { LayoutOptions } from '../src/index.js';
import { layoutDiff } from '../src/sync.js';
import { type GraphSpec, makeDiff } from './support/diff-builder.js';
import { changes, cjk, components, scaleFree, star, tree } from './support/fixtures.js';
import { type QualityReport, quality } from './support/metrics.js';

const L = 56;

function measure(name: string, spec: GraphSpec, options?: LayoutOptions): QualityReport {
  const diff = makeDiff(spec);
  const layout = layoutDiff(diff, options);
  const q = quality(diff, layout);
  console.info(
    `${name.padEnd(12)} n=${String(q.nodes).padStart(4)} ${layout.stats.ms.toFixed(0).padStart(4)}ms` +
      ` clearance=${q.minClearance.toFixed(2)} overlap=${q.labelOverlapRatio.toFixed(5)}` +
      ` (${q.overlappingPairs} pairs) edge=${(q.meanEdgeLength / L).toFixed(2)}L` +
      ` local=${(q.meanLocalEdgeLength / L).toFixed(2)}L median=${(q.medianEdgeLength / L).toFixed(2)}L` +
      ` aspect=${q.aspect.toFixed(2)} partners=[${q.partnerRatios.map((r) => r.toFixed(2)).join(' ')}]`,
  );
  return q;
}

function expectReadable(q: QualityReport): void {
  expect(q.hasNaN).toBe(false);
  // Circles never touch (padding keeps a gap).
  expect(q.minClearance).toBeGreaterThanOrEqual(0);
  // Node and label boxes essentially never overlap.
  expect(q.labelOverlapRatio).toBeLessThan(0.001);
  expect(q.componentOverlaps).toBe(0);
}

describe('layout quality', () => {
  it('tree (150 nodes)', () => {
    const q = measure('tree', tree(150));
    expectReadable(q);
    expect(q.meanEdgeLength / L).toBeGreaterThanOrEqual(0.6);
    expect(q.meanEdgeLength / L).toBeLessThanOrEqual(2.2);
  });

  it('scale-free (500 nodes, ~650 edges)', () => {
    const q = measure('scale-free', scaleFree(500, 1.3));
    expectReadable(q);
    // Hubs (degree up to ~40) carry the spec charge −(220 + 40·√deg) and weak 1/min(deg) links,
    // so hub-to-hub edges stretch well beyond L even without labels (~4.2·L); label boxes add
    // ~15%. The 2.2·L bound holds for trees and sparse components, not for hub-heavy graphs.
    expect(q.meanEdgeLength / L).toBeGreaterThanOrEqual(0.6);
    expect(q.meanEdgeLength / L).toBeLessThanOrEqual(6);
    const bare = measure('scale-free (no labels)', scaleFree(500, 1.3), { labelAware: false });
    expect(bare.meanEdgeLength / L).toBeLessThan(q.meanEdgeLength / L);
  });

  it('many components and isolated nodes', () => {
    const q = measure('components', components());
    expectReadable(q);
    expect(q.meanEdgeLength / L).toBeGreaterThanOrEqual(0.6);
    expect(q.meanEdgeLength / L).toBeLessThanOrEqual(2.2);
    // Packed towards a 16:10 picture.
    expect(q.aspect).toBeGreaterThan(1.2);
    expect(q.aspect).toBeLessThan(2.2);
  });

  it('star (60 labelled leaves)', () => {
    const q = measure('star', star(60));
    expectReadable(q);
    // 60 label blocks of ~100 × 33 units cannot sit on one ring of radius 2.2·L: they fill a
    // disc whose mean radius is ~2/3 of sqrt(60 · 3300 / (π · 0.5)) ≈ 4.2·L.
    expect(q.meanEdgeLength / L).toBeLessThanOrEqual(4.5);
    const bare = measure('star (no labels)', star(60), { labelAware: false });
    expect(bare.hasNaN).toBe(false);
    expect(bare.minClearance).toBeGreaterThanOrEqual(0);
    expect(bare.meanEdgeLength / L).toBeGreaterThanOrEqual(0.6);
    expect(bare.meanEdgeLength / L).toBeLessThanOrEqual(2.2);
  });

  it('a dense scale-free graph (~1000 edges) makes room for its labels', () => {
    expectReadable(measure('dense sf', scaleFree(500, 2)));
  });

  it('a hub with 300 labelled leaves spreads them instead of jamming', () => {
    const q = measure('star-300', star(300));
    expectReadable(q);
  });

  it('CJK labels', () => {
    const q = measure('cjk', cjk());
    expectReadable(q);
    // Random long-range cross links stretch a few edges; the typical edge keeps its length.
    expect(q.medianEdgeLength / L).toBeGreaterThanOrEqual(0.6);
    expect(q.medianEdgeLength / L).toBeLessThanOrEqual(2.2);
    expect(q.meanEdgeLength / L).toBeLessThanOrEqual(2.6);
  });

  it('a realistic review: merges stay next to their target', () => {
    const q = measure('changes', changes());
    expectReadable(q);
    expect(q.meanEdgeLength / L).toBeGreaterThanOrEqual(0.6);
    expect(q.meanEdgeLength / L).toBeLessThanOrEqual(2.2);
    const diff = makeDiff(changes());
    const layout = layoutDiff(diff);
    const median = q.medianEdgeLength;
    for (const node of diff.nodes) {
      for (const facet of node.facets) {
        if (facet.kind !== 'mergedInto') continue;
        const a = layout.positions.get(node.id)!;
        const b = layout.positions.get(facet.target)!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(median);
      }
    }
  });

  it.each([1, 2, 3, 4, 5])('merge sources stay closer than the median edge (seed %i)', (seed) => {
    const diff = makeDiff(changes(17 + seed));
    const layout = layoutDiff(diff, { seed });
    const q = quality(diff, layout);
    expectReadable(q);
    for (const node of diff.nodes) {
      for (const facet of node.facets) {
        if (facet.kind === 'mergedInto') {
          const a = layout.positions.get(node.id)!;
          const b = layout.positions.get(facet.target)!;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(q.medianEdgeLength);
        }
        if (facet.kind === 'splitFrom') {
          // Two targets compete for the spots next to one source: allow a little more.
          const a = layout.positions.get(node.id)!;
          const b = layout.positions.get(facet.source)!;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(5 * q.medianEdgeLength);
        }
      }
    }
  });
});
