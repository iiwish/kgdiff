/**
 * Layout quality metrics, used as regression guards in tests and printed by the preview script.
 */
import type { DiffResult, UnionId } from '@kgdiff/core';
import type { LayoutResult } from '../../src/index.js';
import { LABEL_GAP, labelBox } from '../../src/label-box.js';

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const intersection = (a: Box, b: Box): number => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};

const area = (b: Box): number => (b.x1 - b.x0) * (b.y1 - b.y0);

/** Every rect pair with positive intersection area, via sort-and-sweep on x. */
function overlappingPairs(
  boxes: readonly Box[],
  visit: (a: number, b: number, area: number) => void,
): void {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.x0 - boxes[b]!.x0);
  for (let p = 0; p < order.length; p++) {
    const a = boxes[order[p]!]!;
    for (let q = p + 1; q < order.length; q++) {
      const b = boxes[order[q]!]!;
      if (b.x0 >= a.x1) break;
      const o = intersection(a, b);
      if (o > 0) visit(order[p]!, order[q]!, o);
    }
  }
}

export interface QualityReport {
  readonly nodes: number;
  readonly hasNaN: boolean;
  /** min over node pairs of distance − (r1 + r2); ≥ 0 means no circles touch. */
  readonly minClearance: number;
  /** Σ pairwise intersection area of node / label boxes ÷ Σ box area. */
  readonly labelOverlapRatio: number;
  /** Number of box pairs (of different nodes) that intersect. */
  readonly overlappingPairs: number;
  /** The node ids of those pairs. */
  readonly overlaps: readonly (readonly [string, string])[];
  readonly meanEdgeLength: number;
  readonly medianEdgeLength: number;
  /** Mean length of edges between nodes of degree ≤ 4 (no hub spokes). */
  readonly meanLocalEdgeLength: number;
  /** Pairs of component bounds that intersect. */
  readonly componentOverlaps: number;
  /** For every merge source / split target: distance to its partner ÷ median edge length. */
  readonly partnerRatios: readonly number[];
  readonly aspect: number;
}

function labelBefore(diff: DiffResult, id: UnionId): string | undefined {
  const node = diff.index.node(id);
  for (const f of node?.facets ?? []) if (f.kind === 'rename') return f.from;
  return undefined;
}

export function quality(diff: DiffResult, layout: LayoutResult, fontSize = 12): QualityReport {
  const ids = [...layout.positions.keys()];
  let hasNaN = false;
  for (const p of layout.positions.values())
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) hasNaN = true;

  // Node squares and label blocks, separately (an approximation of what is drawn).
  const boxes: Box[] = [];
  const owner: number[] = [];
  ids.forEach((id, k) => {
    const p = layout.positions.get(id)!;
    const r = layout.radii.get(id)!;
    boxes.push({ x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r });
    owner.push(k);
    const node = diff.index.node(id);
    const label = labelBox(node?.label ?? id, labelBefore(diff, id), fontSize);
    const top = p.y + r + LABEL_GAP;
    boxes.push({
      x0: p.x - label.width / 2,
      y0: top,
      x1: p.x + label.width / 2,
      y1: top + label.height,
    });
    owner.push(k);
  });
  let overlapArea = 0;
  let pairs = 0;
  const overlaps: [string, string][] = [];
  overlappingPairs(boxes, (a, b, o) => {
    if (owner[a] === owner[b]) return;
    overlapArea += o;
    pairs++;
    overlaps.push([ids[owner[a]!]!, ids[owner[b]!]!]);
  });
  const totalArea = boxes.reduce((s, b) => s + area(b), 0);

  // Circle clearance (sweep on x with the largest radius as reach).
  let minClearance = Number.POSITIVE_INFINITY;
  const circles = ids.map((id) => ({ p: layout.positions.get(id)!, r: layout.radii.get(id)! }));
  circles.sort((a, b) => a.p.x - b.p.x);
  for (let i = 0; i < circles.length; i++) {
    const a = circles[i]!;
    for (let j = i + 1; j < circles.length; j++) {
      const b = circles[j]!;
      if (b.p.x - a.p.x - a.r - 14 > minClearance) break;
      const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) - a.r - b.r;
      if (d < minClearance) minClearance = d;
    }
  }

  const lengths: number[] = [];
  const local: number[] = [];
  const seen = new Set<string>();
  const degree = (id: string): number => {
    const node = diff.index.node(id);
    return node ? Math.max(node.degree.before, node.degree.after) : 0;
  };
  const addEdge = (s: string | undefined, t: string | undefined): void => {
    if (s === undefined || t === undefined || s === t) return;
    const key = s < t ? `${s}\u0000${t}` : `${t}\u0000${s}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ps = layout.positions.get(s);
    const pt = layout.positions.get(t);
    if (!ps || !pt) return;
    const length = Math.hypot(ps.x - pt.x, ps.y - pt.y);
    lengths.push(length);
    if (degree(s) <= 4 && degree(t) <= 4) local.push(length);
  };
  for (const e of diff.edges) {
    addEdge(e.source, e.target);
    addEdge(e.sourceBefore ?? e.source, e.targetBefore ?? e.target);
  }
  lengths.sort((a, b) => a - b);
  const mean = lengths.length ? lengths.reduce((s, l) => s + l, 0) / lengths.length : 0;
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)]! : 0;

  let componentOverlaps = 0;
  const comps = layout.components.map((c) => ({
    x0: c.bounds.x,
    y0: c.bounds.y,
    x1: c.bounds.x + c.bounds.width,
    y1: c.bounds.y + c.bounds.height,
  }));
  overlappingPairs(comps, () => {
    componentOverlaps++;
  });

  const partnerRatios: number[] = [];
  for (const node of diff.nodes) {
    for (const f of node.facets) {
      const partner =
        f.kind === 'mergedInto' ? f.target : f.kind === 'splitFrom' ? f.source : undefined;
      if (partner === undefined) continue;
      const a = layout.positions.get(node.id);
      const b = layout.positions.get(partner);
      if (a && b && median > 0) partnerRatios.push(Math.hypot(a.x - b.x, a.y - b.y) / median);
    }
  }

  return {
    nodes: ids.length,
    hasNaN,
    minClearance: ids.length > 1 ? minClearance : 0,
    labelOverlapRatio: totalArea > 0 ? overlapArea / totalArea : 0,
    overlappingPairs: pairs,
    overlaps,
    meanEdgeLength: mean,
    medianEdgeLength: median,
    meanLocalEdgeLength: local.length ? local.reduce((a, l) => a + l, 0) / local.length : 0,
    componentOverlaps,
    partnerRatios,
    aspect: layout.bounds.height > 0 ? layout.bounds.width / layout.bounds.height : 0,
  };
}
