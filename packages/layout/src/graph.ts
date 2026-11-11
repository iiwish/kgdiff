/**
 * The graph actually laid out: the union nodes in scope (re-indexed 0..n−1 in id order), their
 * radii and label blocks, and the links / partner springs among them.
 */
import type { UnionId, UnionNode } from '@kgdiff/core';
import { BOX_PADDING } from './geometry.js';
import { LABEL_GAP, labelBox } from './label-box.js';
import { buildAdjacency, type Partner, type UnionGraph } from './union.js';

export interface LayoutGraph {
  readonly n: number;
  readonly nodes: readonly UnionNode[];
  readonly indexOf: ReadonlyMap<UnionId, number>;
  /** `nodeRadius(max(degree.before, degree.after))`. */
  readonly radius: Float64Array;
  /**
   * Visual box of node + label relative to the node center: half width, top (negative) and
   * bottom offsets. Used for bounds, and for collision when the layout is label-aware.
   */
  readonly boxHalfWidth: Float64Array;
  readonly boxTop: Float64Array;
  readonly boxBottom: Float64Array;
  /** Area of the padded visual box. */
  readonly boxArea: Float64Array;
  /** Radius of a disc holding the padded boxes of all neighbours (label-aware link relaxation). */
  readonly crowding: Float64Array;
  /** Distinct neighbours within the layout (drives link and charge strengths). */
  readonly degree: Int32Array;
  /** Distinct undirected links [a, b], a < b. */
  readonly pairs: Int32Array;
  readonly offsets: Int32Array;
  readonly adjacency: Int32Array;
  readonly partners: readonly Partner[];
}

export interface GraphGeometry {
  readonly fontSize: number;
  readonly nodeRadius: (degree: number) => number;
}

function labelBefore(node: UnionNode): string | undefined {
  for (const facet of node.facets) if (facet.kind === 'rename') return facet.from;
  return undefined;
}

/** Induced subgraph of `union` over `visible`. */
export function buildLayoutGraph(
  union: UnionGraph,
  visible: Uint8Array,
  geometry: GraphGeometry,
): LayoutGraph {
  const local = new Int32Array(union.nodes.length).fill(-1);
  const nodes: UnionNode[] = [];
  for (let u = 0; u < union.nodes.length; u++) {
    if (!visible[u]) continue;
    local[u] = nodes.length;
    nodes.push(union.nodes[u]!);
  }
  const n = nodes.length;
  const indexOf = new Map<UnionId, number>();
  const radius = new Float64Array(n);
  const boxHalfWidth = new Float64Array(n);
  const boxTop = new Float64Array(n);
  const boxBottom = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const node = nodes[i]!;
    indexOf.set(node.id, i);
    const r = geometry.nodeRadius(Math.max(node.degree.before, node.degree.after));
    const label = labelBox(node.label, labelBefore(node), geometry.fontSize);
    radius[i] = r;
    boxHalfWidth[i] = Math.max(r, label.width / 2);
    boxTop[i] = -r;
    boxBottom[i] = r + LABEL_GAP + label.height;
  }

  const flat: number[] = [];
  for (let k = 0; k < union.pairs.length; k += 2) {
    const a = local[union.pairs[k]!]!;
    const b = local[union.pairs[k + 1]!]!;
    if (a >= 0 && b >= 0) flat.push(Math.min(a, b), Math.max(a, b));
  }
  const pairs = Int32Array.from(flat);
  const { offsets, adjacency } = buildAdjacency(n, pairs);
  const degree = new Int32Array(n);
  const boxArea = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    degree[i] = offsets[i + 1]! - offsets[i]!;
    boxArea[i] = (2 * boxHalfWidth[i]! + BOX_PADDING) * (boxBottom[i]! - boxTop[i]! + BOX_PADDING);
  }
  const crowding = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let area = 0;
    for (let k = offsets[i]!; k < offsets[i + 1]!; k++) area += boxArea[adjacency[k]!]!;
    crowding[i] = Math.sqrt(area / Math.PI);
  }

  const partners: Partner[] = [];
  for (const p of union.partners) {
    const mover = local[p.mover]!;
    const anchor = local[p.anchor]!;
    if (mover >= 0 && anchor >= 0) partners.push({ mover, anchor });
  }

  return {
    n,
    nodes,
    indexOf,
    radius,
    boxHalfWidth,
    boxTop,
    boxBottom,
    boxArea,
    crowding,
    degree,
    pairs,
    offsets,
    adjacency,
    partners,
  };
}
