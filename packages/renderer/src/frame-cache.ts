/**
 * Per-frame derived data, rebuilt when `setFrame` is called (never on pan / zoom):
 *
 * - style buckets for edges and nodes, keyed by every stroke / fill property plus `z`, sorted
 *   by z. Drawing a bucket is one path + one stroke (and one fill for arrows / node bodies),
 *   so a 10k-edge frame with a handful of styles issues a handful of strokes;
 * - lists of nodes with halos, rings / pulses (sorted by z), badges; glyphs split into
 *   arcs and pivots;
 * - lazily: a point grid over visible nodes (picking) and content bounds.
 *
 * Bucket keys are numbers built from interned style ids and quantized values, so building
 * allocates nothing per element in steady state.
 */
import type { Rect } from '@kgdiff/core';
import type { FrameVisuals, NodeShape } from '@kgdiff/scene';
import { clamp } from './math.js';
import { PointGrid } from './spatial.js';

const MAX_COLORS = 2047;
const MAX_DASHES = 63;

/** Interns style values to small integer ids for bucket keys. */
export class Interner {
  private colors = new Map<string, number>();
  private dashIds = new WeakMap<readonly number[], number>();
  private dashKeys = new Map<string, number>();

  /** Called before a build: start over when the id space is exhausted (animated rgba strings). */
  maintain(): void {
    if (this.colors.size > MAX_COLORS - 64) this.colors.clear();
    if (this.dashKeys.size > MAX_DASHES - 8) {
      this.dashKeys.clear();
      this.dashIds = new WeakMap();
    }
  }

  /** 0 is reserved for null. */
  color(c: string | null): number {
    if (c === null) return 0;
    let id = this.colors.get(c);
    if (id === undefined) {
      id = this.colors.size + 1;
      this.colors.set(c, id);
    }
    return Math.min(id, MAX_COLORS);
  }

  /** 0 is reserved for solid (null / empty). */
  dash(d: readonly number[] | null): number {
    if (d === null || d.length === 0) return 0;
    let id = this.dashIds.get(d);
    if (id === undefined) {
      const key = d.join(',');
      id = this.dashKeys.get(key);
      if (id === undefined) {
        id = this.dashKeys.size + 1;
        this.dashKeys.set(key, id);
      }
      this.dashIds.set(d, id);
    }
    return Math.min(id, MAX_DASHES);
  }
}

/** Alpha is quantized to 1/64 for bucketing (invisible differences, far fewer buckets). */
export function quantizeAlpha(a: number): number {
  return Number.isFinite(a) ? Math.round(clamp(a, 0, 1) * 64) : 0;
}

function quantizeZ(z: number): number {
  return zLevel(z) + 512;
}

/** The integer draw level a `z` value is bucketed into (non-finite → 0). */
export function zLevel(z: number): number {
  return Number.isFinite(z) ? clamp(Math.round(z), -512, 511) : 0;
}

/** Bucket id of a shape: 0 for a circle, a missing or an unknown shape (drawn as a circle). */
function shapeId(shape: NodeShape | undefined): number {
  switch (shape) {
    case 'square':
      return 1;
    case 'diamond':
      return 2;
    case 'hexagon':
      return 3;
    default:
      return 0;
  }
}

function quantizeWidth(w: number): number {
  return Number.isFinite(w) ? Math.round(clamp(w, 0, 15.75) * 4) : 0;
}

/** Dash offset reduced to one period of the pattern, in half pixels. */
function quantizeOffset(offset: number, dash: readonly number[] | null): number {
  if (dash === null || dash.length === 0 || !Number.isFinite(offset)) return 0;
  let period = 0;
  for (const d of dash) period += d;
  if (dash.length % 2 === 1) period *= 2;
  if (!(period > 0)) return 0;
  const o = ((offset % period) + period) % period;
  return clamp(Math.round(o * 2), 0, 511);
}

export interface EdgeBucket {
  key: number;
  seq: number;
  z: number;
  color: string;
  width: number;
  dash: readonly number[] | null;
  dashOffset: number;
  alpha: number;
  readonly members: number[];
}

export interface NodeBucket {
  key: number;
  seq: number;
  z: number;
  /** null = hollow ghost (filled with the canvas background). */
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  dash: readonly number[] | null;
  alpha: number;
  /** undefined = circle. */
  shape: NodeShape | undefined;
  readonly members: number[];
}

function bySeq(a: { z: number; seq: number }, b: { z: number; seq: number }): number {
  return a.z - b.z || a.seq - b.seq;
}

export class FrameCache {
  frame: FrameVisuals | null = null;
  version = -1;
  /** Sorted by z, then first appearance. */
  readonly edgeBuckets: EdgeBucket[] = [];
  readonly nodeBuckets: NodeBucket[] = [];
  /** Nodes with a ring or an active pulse, sorted by (z, index). */
  readonly decor: number[] = [];
  readonly halos: number[] = [];
  readonly badges: number[] = [];
  readonly glyphArcs: number[] = [];
  readonly pivots: number[] = [];
  /** Largest visible node radius (world). */
  maxR = 0;
  /** Visible node / edge counts. */
  nodeCount = 0;
  edgeCount = 0;
  /**
   * Collapsed pills shown by the last paint of this frame (1) or hidden by label collision (0).
   * Valid while `pillsVersion === version`; picking ignores hidden pills.
   */
  pillShown = new Uint8Array(0);
  pillsVersion = -1;

  private readonly edgeMap = new Map<number, EdgeBucket>();
  private readonly nodeMap = new Map<number, NodeBucket>();
  private readonly edgePool: EdgeBucket[] = [];
  private readonly nodePool: NodeBucket[] = [];
  private gridVersion = -1;
  private readonly grid = new PointGrid();
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private rs = new Float64Array(0);
  private ids = new Int32Array(0);
  private boundsVersion = -1;
  private boundsValue: Rect | null = null;

  /** Rebuild when `frame` or `version` changed. */
  sync(frame: FrameVisuals, version: number, interner: Interner): void {
    if (frame === this.frame && version === this.version) return;
    this.frame = frame;
    this.version = version;
    this.build(frame, interner);
  }

  private build(frame: FrameVisuals, interner: Interner): void {
    interner.maintain();
    this.edgeMap.clear();
    this.nodeMap.clear();
    this.edgeBuckets.length = 0;
    this.nodeBuckets.length = 0;
    this.decor.length = 0;
    this.halos.length = 0;
    this.badges.length = 0;
    this.glyphArcs.length = 0;
    this.pivots.length = 0;
    this.maxR = 0;
    this.nodeCount = 0;
    this.edgeCount = 0;

    const edges = frame.edges;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      if (!e.visible) continue;
      const aq = quantizeAlpha(e.alpha);
      if (aq === 0 || !(e.width > 0)) continue;
      if (!Number.isFinite(e.x1 + e.y1 + e.x2 + e.y2)) continue;
      const zq = quantizeZ(e.z);
      const wq = quantizeWidth(e.width);
      const dash = e.dash !== null && e.dash.length > 0 ? e.dash : null;
      const oq = quantizeOffset(e.dashOffset, dash);
      const key =
        ((((zq * 2048 + interner.color(e.color)) * 64 + wq) * 64 + interner.dash(dash)) * 512 +
          oq) *
          65 +
        aq;
      let b = this.edgeMap.get(key);
      if (!b) {
        b = this.edgePool[this.edgeBuckets.length];
        if (!b) {
          b = {
            key: 0,
            seq: 0,
            z: 0,
            color: '',
            width: 0,
            dash: null,
            dashOffset: 0,
            alpha: 0,
            members: [],
          };
          this.edgePool.push(b);
        }
        b.key = key;
        b.seq = this.edgeBuckets.length;
        b.z = zq - 512;
        b.color = e.color;
        b.width = wq / 4;
        b.dash = dash;
        b.dashOffset = oq / 2;
        b.alpha = aq / 64;
        b.members.length = 0;
        this.edgeMap.set(key, b);
        this.edgeBuckets.push(b);
      }
      b.members.push(i);
      this.edgeCount++;
    }
    this.edgeBuckets.sort(bySeq);

    const nodes = frame.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (!n.visible) continue;
      const aq = quantizeAlpha(n.alpha);
      if (aq === 0 || !Number.isFinite(n.x + n.y + n.r) || n.r < 0) continue;
      const zq = quantizeZ(n.z);
      const stroke = n.stroke !== null && n.strokeWidth > 0 ? n.stroke : null;
      const dash = stroke !== null && n.dash !== null && n.dash.length > 0 ? n.dash : null;
      const sid = shapeId(n.shape);
      // Below 2^53: z (2^10) · fill, stroke (2^11 each) · width, dash (2^6 each) · alpha (65) · 4.
      const key =
        (((((zq * 2048 + interner.color(n.fill)) * 2048 + interner.color(stroke)) * 64 +
          (stroke ? quantizeWidth(n.strokeWidth) : 0)) *
          64 +
          interner.dash(dash)) *
          65 +
          aq) *
          4 +
        sid;
      let b = this.nodeMap.get(key);
      if (!b) {
        b = this.nodePool[this.nodeBuckets.length];
        if (!b) {
          b = {
            key: 0,
            seq: 0,
            z: 0,
            fill: null,
            stroke: null,
            strokeWidth: 0,
            dash: null,
            alpha: 0,
            shape: undefined,
            members: [],
          };
          this.nodePool.push(b);
        }
        b.key = key;
        b.seq = this.nodeBuckets.length;
        b.z = zq - 512;
        b.fill = n.fill;
        b.stroke = stroke;
        b.strokeWidth = stroke ? quantizeWidth(n.strokeWidth) / 4 : 0;
        b.dash = dash;
        b.alpha = aq / 64;
        b.shape = sid === 0 ? undefined : n.shape;
        b.members.length = 0;
        this.nodeMap.set(key, b);
        this.nodeBuckets.push(b);
      }
      b.members.push(i);
      this.nodeCount++;
      if (n.r > this.maxR) this.maxR = n.r;
      if (n.ring !== null || (n.pulse > 0 && n.pulse < 1)) this.decor.push(i);
      if (n.halo !== null && n.halo.alpha > 0) this.halos.push(i);
      if (n.badge !== null && n.badge.text.length > 0) this.badges.push(i);
    }
    this.nodeBuckets.sort(bySeq);
    if (this.decor.length > 1) {
      this.decor.sort((a, b) => quantizeZ(nodes[a]!.z) - quantizeZ(nodes[b]!.z) || a - b);
    }

    const glyphs = frame.glyphs;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      if (quantizeAlpha(g.alpha) === 0 || !Number.isFinite(g.x1 + g.y1 + g.x2 + g.y2)) continue;
      if (g.kind === 'pivot') this.pivots.push(i);
      else this.glyphArcs.push(i);
    }
  }

  /** Whether collapsed pill `i` may be picked (shown by the last paint, or not yet placed). */
  pillPickable(i: number): boolean {
    return this.pillsVersion !== this.version || this.pillShown[i] === 1;
  }

  /** Spatial index over visible node centres (built on first use after a frame change). */
  nodeGrid(): PointGrid {
    const frame = this.frame;
    if (this.gridVersion === this.version || !frame) return this.grid;
    this.gridVersion = this.version;
    const n = this.nodeCount;
    if (this.xs.length < n) {
      const cap = Math.max(n, this.xs.length * 2);
      this.xs = new Float64Array(cap);
      this.ys = new Float64Array(cap);
      this.rs = new Float64Array(cap);
      this.ids = new Int32Array(cap);
    }
    let j = 0;
    for (const b of this.nodeBuckets) {
      for (const i of b.members) {
        const node = frame.nodes[i]!;
        this.xs[j] = node.x;
        this.ys[j] = node.y;
        this.rs[j] = node.r;
        this.ids[j] = i;
        j++;
      }
    }
    this.grid.build(this.xs, this.ys, this.rs, this.ids, j);
    return this.grid;
  }

  /** Bounds of every visible node (with its radius), collapsed pill and glyph; null if empty. */
  contentBounds(): Rect | null {
    const frame = this.frame;
    if (!frame) return null;
    if (this.boundsVersion === this.version) return this.boundsValue;
    this.boundsVersion = this.version;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const b of this.nodeBuckets) {
      for (const i of b.members) {
        const n = frame.nodes[i]!;
        if (n.x - n.r < x0) x0 = n.x - n.r;
        if (n.y - n.r < y0) y0 = n.y - n.r;
        if (n.x + n.r > x1) x1 = n.x + n.r;
        if (n.y + n.r > y1) y1 = n.y + n.r;
      }
    }
    for (const g of frame.collapsed) {
      if (!Number.isFinite(g.x + g.y)) continue;
      x0 = Math.min(x0, g.x);
      y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x);
      y1 = Math.max(y1, g.y);
    }
    for (const i of this.glyphArcs) {
      const g = frame.glyphs[i]!;
      x0 = Math.min(x0, g.x1, g.x2);
      y0 = Math.min(y0, g.y1, g.y2);
      x1 = Math.max(x1, g.x1, g.x2);
      y1 = Math.max(y1, g.y1, g.y2);
    }
    this.boundsValue = x0 <= x1 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
    return this.boundsValue;
  }
}

/** Union of two optional rectangles. */
export function unionBounds(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
