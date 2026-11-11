/**
 * `buildScene`: diff + layout → the renderer-agnostic scene (indices, roles, families, labels,
 * badges, curvature, importance, hunks in tour order, timeline).
 */
import {
  type DiffResult,
  formatHunk,
  type GraphMeta,
  type Hunk,
  type Id,
  KgdiffError,
  type UnionEdge,
  type UnionId,
  type UnionNode,
} from '@kgdiff/core';
import { type LayoutResult, nodeRadius } from '@kgdiff/layout';
import { TIMELINE } from './constants.js';
import { addNodeBox, BoundsBuilder, edgeCurvatures, rectCenter } from './geometry.js';
import {
  edgeFamily,
  edgeLabelBefore,
  edgeRole,
  hunkFamily,
  nodeBadge,
  nodeFamily,
  nodeFamilyBefore,
  nodeLabelBefore,
  nodeRole,
} from './roles.js';
import { isNodeShape } from './shapes.js';
import { getTheme } from './theme.js';
import { buildTimeline, chapterPlan, type TourHunk, timelineMode, tourOrder } from './timeline.js';
import type {
  ChangeFamily,
  NodeShape,
  Scene,
  SceneEdge,
  SceneHunk,
  SceneNode,
  SceneOptions,
  SceneShape,
  SceneSuggestion,
  Theme,
} from './types.js';

function resolveTheme(options: SceneOptions): Theme {
  const t = options.theme;
  if (t !== undefined && typeof t === 'object') return t;
  return getTheme(t ?? 'dark', options.palette ?? 'default');
}

function resolveReplay(options: SceneOptions): { pace: number; chapterThreshold: number } {
  const pace = options.replay?.pace ?? TIMELINE.pace;
  const chapterThreshold = options.replay?.chapterThreshold ?? TIMELINE.chapterThreshold;
  if (!(Number.isFinite(pace) && pace > 0)) {
    throw new KgdiffError(
      'invalid-input',
      `replay.pace must be a positive number of ms, got ${pace}.`,
    );
  }
  if (!(chapterThreshold >= 0)) {
    throw new KgdiffError(
      'invalid-input',
      `replay.chapterThreshold must be ≥ 0, got ${chapterThreshold}.`,
    );
  }
  return { pace, chapterThreshold };
}

/** The entries of `options.shapes`, in order, checked; empty without any. */
function resolveShapes(options: SceneOptions): readonly SceneShape[] {
  const shapes = options.shapes;
  if (shapes === undefined) return [];
  if (typeof shapes !== 'object' || shapes === null) {
    throw new KgdiffError('invalid-input', 'shapes must be an object of type → shape.');
  }
  return Object.entries(shapes).map(([type, shape]) => {
    if (!isNodeShape(shape)) {
      throw new KgdiffError(
        'invalid-input',
        `shapes["${type}"] must be circle, square, diamond or hexagon, got ${JSON.stringify(shape)}.`,
      );
    }
    return { type, shape: shape as NodeShape };
  });
}

/** Importance in [0, 1]: changed nodes 0.8–1, unchanged 0–0.75, both by degree percentile. */
function importances(nodes: readonly UnionNode[]): Float64Array {
  const n = nodes.length;
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = (nodes[i] as UnionNode).degree;
    degree[i] = Math.max(d.before, d.after);
  }
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (degree[a] as number) - (degree[b] as number),
  );
  const at = (k: number): number => order[k] as number;
  // rank = share of nodes with a strictly lower degree (equal degrees share a rank).
  const rank = new Float64Array(n);
  for (let k = 0; k < n; ) {
    let j = k;
    while (j < n && degree[at(j)] === degree[at(k)]) j++;
    const r = n > 1 ? k / (n - 1) : 0;
    for (let m = k; m < j; m++) rank[at(m)] = r;
    k = j;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const changed = (nodes[i] as UnionNode).status !== 'unchanged';
    const r = rank[i] as number;
    out[i] = changed ? 0.8 + 0.2 * r : 0.75 * r;
  }
  return out;
}

function facetTarget(node: UnionNode, kind: 'mergedInto' | 'splitFrom'): UnionId | undefined {
  for (const f of node.facets) {
    if (f.kind === 'mergedInto' && kind === 'mergedInto') return f.target;
    if (f.kind === 'splitFrom' && kind === 'splitFrom') return f.source;
  }
  return undefined;
}

/** `meta.predicateLabels` of a graph when it is a plain object (formats: predicate → label). */
function predicateLabelTable(meta: GraphMeta): Readonly<Record<string, unknown>> | null {
  const table = meta.predicateLabels;
  return typeof table === 'object' && table !== null && !Array.isArray(table)
    ? (table as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * Display labels of edges. A predicate's label comes from the files' own property labels
 * (`after.meta.predicateLabels`, then `before.meta.predicateLabels`; own non-empty strings only),
 * else the edge's readable predicate name. Edges with a `label` facet carry explicit labels
 * that changed, so those are kept as they are.
 */
function edgeDisplayLabels(
  diff: DiffResult,
): (e: UnionEdge) => { label: string; labelBefore: string | undefined } {
  const tables = [predicateLabelTable(diff.after.meta), predicateLabelTable(diff.before.meta)];
  const lookup = (predicate: string | undefined): string | undefined => {
    if (predicate === undefined) return undefined;
    for (const table of tables) {
      if (table === null || !Object.hasOwn(table, predicate)) continue;
      const v = table[predicate];
      if (typeof v === 'string' && v !== '') return v;
    }
    return undefined;
  };
  return (e) => {
    if (e.facets.some((f) => f.kind === 'label')) {
      return { label: e.label, labelBefore: edgeLabelBefore(e) };
    }
    const predicateFacet = e.facets.find((f) => f.kind === 'predicate');
    const before =
      predicateFacet?.kind === 'predicate'
        ? (lookup(e.predicateBefore ?? predicateFacet.from) ?? edgeLabelBefore(e))
        : undefined;
    return { label: lookup(e.predicate) ?? e.label, labelBefore: before };
  };
}

/** Family of a hunk: the kind's default, refined for `modify` by its node's primary facet. */
function sceneHunkFamily(hunk: Hunk, byId: ReadonlyMap<UnionId, UnionNode>): ChangeFamily {
  if (hunk.kind !== 'modify') return hunkFamily(hunk.kind);
  const anchor = byId.get(hunk.anchor);
  if (anchor === undefined) return 'content';
  const f = nodeFamily(anchor, nodeRole(anchor));
  return f === 'neutral' ? 'content' : f;
}

/**
 * Build the visual model. Pure and deterministic.
 *
 * - Nodes absent from `layout.positions` (scope `changes`) are left out; edges need both
 *   endpoints. Before-version endpoints outside the layout fall back to the after ones.
 * - Node / edge order follows the diff (sorted by union id); indices are dense.
 * - Hunks are reordered as a spatial tour (docs/algorithms.md §10); titles come from core
 *   `formatHunk` in `options.locale`.
 * - `degree` is the max of the before / after degree (as used for the radius).
 *
 * O(N log N + E + H √H). See `SceneOptions` for defaults.
 *
 * @throws KgdiffError(`invalid-input`) for invalid replay options, shapes or theme names.
 */
export function buildScene(
  diff: DiffResult,
  layout: LayoutResult,
  options: SceneOptions = {},
): Scene {
  const theme = resolveTheme(options);
  const locale = options.locale ?? 'en';
  const { pace, chapterThreshold } = resolveReplay(options);
  const shapeEntries = resolveShapes(options);

  // ── Nodes in scope ──
  const unionNodes: UnionNode[] = [];
  const nodeIndex = new Map<UnionId, number>();
  const byId = new Map<UnionId, UnionNode>();
  for (const n of diff.nodes) {
    byId.set(n.id, n);
    const p = layout.positions.get(n.id);
    if (p === undefined || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    nodeIndex.set(n.id, unionNodes.length);
    unionNodes.push(n);
  }
  const byAfter = new Map<Id, number>();
  const byBefore = new Map<Id, number>();
  for (let i = 0; i < unionNodes.length; i++) {
    const n = unionNodes[i] as UnionNode;
    if (n.afterId !== undefined) byAfter.set(n.afterId, i);
    if (n.beforeId !== undefined) byBefore.set(n.beforeId, i);
  }

  // ── Edges in scope ──
  const unionEdges: UnionEdge[] = [];
  const ends: { s: number; t: number; sb: number; tb: number }[] = [];
  for (const e of diff.edges) {
    const s = nodeIndex.get(e.source);
    const t = nodeIndex.get(e.target);
    if (s === undefined || t === undefined) continue;
    const sb = e.sourceBefore === undefined ? s : (nodeIndex.get(e.sourceBefore) ?? s);
    const tb = e.targetBefore === undefined ? t : (nodeIndex.get(e.targetBefore) ?? t);
    unionEdges.push(e);
    ends.push({ s, t, sb, tb });
  }

  // ── Positions ──
  const xs = new Float64Array(unionNodes.length);
  const ys = new Float64Array(unionNodes.length);
  const rs = new Float64Array(unionNodes.length);
  for (let i = 0; i < unionNodes.length; i++) {
    const n = unionNodes[i] as UnionNode;
    const p = layout.positions.get(n.id) as { x: number; y: number };
    xs[i] = p.x;
    ys[i] = p.y;
    const r = layout.radii.get(n.id);
    rs[i] =
      r !== undefined && Number.isFinite(r) && r > 0
        ? r
        : nodeRadius(Math.max(n.degree.before, n.degree.after));
  }

  // ── Hunk tour order (respecting `requires`), then play order ──
  const diffHunkIndex = new Map<string, number>();
  for (let k = 0; k < diff.hunks.length; k++) diffHunkIndex.set((diff.hunks[k] as Hunk).id, k);
  const requiresOf = (h: Hunk): number[] => {
    const out: number[] = [];
    for (const id of h.requires ?? []) {
      const k = diffHunkIndex.get(id);
      if (k !== undefined) out.push(k);
    }
    return out;
  };
  const tourItems: TourHunk[] = diff.hunks.map((h) => {
    let x = 0;
    let y = 0;
    const a = nodeIndex.get(h.anchor);
    if (a !== undefined) {
      x = xs[a] as number;
      y = ys[a] as number;
    } else {
      let count = 0;
      for (const id of [...h.nodes, ...h.context]) {
        const i = nodeIndex.get(id);
        if (i === undefined) continue;
        x += xs[i] as number;
        y += ys[i] as number;
        count++;
      }
      if (count > 0) {
        x /= count;
        y /= count;
      }
    }
    return {
      phase: h.phase,
      size: h.nodes.length + h.edges.length,
      order: h.order,
      x,
      y,
      requires: requiresOf(h),
    };
  });
  let tour = tourOrder(tourItems);
  if (timelineMode(tour.length, chapterThreshold) === 'chapters') {
    // A hunk that requires one of a later chapter plays in that chapter: reorder so the scene's
    // hunk order is the play order (still requirement-respecting).
    const pos = new Int32Array(tour.length);
    for (let k = 0; k < tour.length; k++) pos[tour[k] as number] = k;
    const plan = chapterPlan(
      tour.map((h) => ({
        phase: (tourItems[h] as TourHunk).phase,
        requires: (tourItems[h] as TourHunk).requires.map((r) => pos[r] as number),
      })),
    );
    tour = tour
      .map((h, k) => ({ h, k, c: plan[k] as number }))
      .sort((a, b) => a.c - b.c || a.k - b.k)
      .map((x) => x.h);
  }
  const hunkIndex = new Map<string, number>();
  for (let k = 0; k < tour.length; k++)
    hunkIndex.set((diff.hunks[tour[k] as number] as Hunk).id, k);
  const hunkOf = (id: string | undefined): number =>
    id === undefined ? -1 : (hunkIndex.get(id) ?? -1);

  // ── Scene nodes ──
  const importance = importances(unionNodes);
  const shapesInUse = new Set<SceneShape>();
  const nodes: SceneNode[] = unionNodes.map((n, i) => {
    const role = nodeRole(n);
    const labelBefore = nodeLabelBefore(n);
    const badge = nodeBadge(n, role);
    let flow: number | undefined;
    if (role === 'merge-source') {
      const target = facetTarget(n, 'mergedInto');
      flow = target === undefined ? undefined : nodeIndex.get(target);
    } else if (role === 'split-target') {
      const source = facetTarget(n, 'splitFrom');
      flow = source === undefined ? undefined : nodeIndex.get(source);
    } else if (role === 'deprecated') {
      for (const id of n.after?.replacedBy ?? []) {
        flow = byAfter.get(id) ?? nodeIndex.get(id);
        if (flow !== undefined) break;
      }
    }
    if (flow === i) flow = undefined;
    const family = nodeFamily(n, role);
    // `types` is the after version's, the before version's for a removed node.
    const entry = shapeEntries.find((e) => n.types.includes(e.type));
    if (entry !== undefined) shapesInUse.add(entry);
    const node: SceneNode = {
      index: i,
      id: n.id,
      x: xs[i] as number,
      y: ys[i] as number,
      r: rs[i] as number,
      status: n.status,
      role,
      family,
      familyBefore: nodeFamilyBefore(n, role, family),
      label: n.label,
      ...(labelBefore !== undefined && labelBefore !== n.label ? { labelBefore } : {}),
      ...(badge !== undefined ? { badge } : {}),
      ...(entry !== undefined && entry.shape !== 'circle' ? { shape: entry.shape } : {}),
      ...(flow !== undefined ? { flow } : {}),
      hunk: hunkOf(n.hunk),
      presentBefore: n.before !== undefined || n.beforeId !== undefined,
      presentAfter: n.after !== undefined || n.afterId !== undefined,
      implicit: (n.after ?? n.before)?.implicit ?? false,
      degree: Math.max(n.degree.before, n.degree.after),
      hidden: layout.hidden.get(n.id) ?? 0,
      importance: importance[i] as number,
    };
    return node;
  });

  // ── Scene edges ──
  const curv = edgeCurvatures(ends);
  const displayLabels = edgeDisplayLabels(diff);
  const edges: SceneEdge[] = unionEdges.map((e, j) => {
    const role = edgeRole(e);
    const end = ends[j] as { s: number; t: number; sb: number; tb: number };
    const { label, labelBefore } = displayLabels(e);
    return {
      index: j,
      id: e.id,
      s: end.s,
      t: end.t,
      sb: end.sb,
      tb: end.tb,
      status: e.status,
      role,
      family: edgeFamily(e, role),
      label,
      ...(labelBefore !== undefined && labelBefore !== label ? { labelBefore } : {}),
      curvature: curv.primary[j] as number,
      hunk: hunkOf(e.hunk),
      presentBefore: e.before !== undefined || e.beforeKey !== undefined,
      presentAfter: e.after !== undefined || e.afterKey !== undefined,
      hierarchical: e.hierarchical,
    };
  });

  // ── Bounds ──
  const all = new BoundsBuilder();
  for (const n of nodes) addNodeBox(all, n.x, n.y, n.r, n.label, n.labelBefore);
  const bounds = all.rect();
  const center = rectCenter(bounds);

  // ── Hunks ──
  const indicesOf = (ids: readonly UnionId[], index: ReadonlyMap<UnionId, number>): number[] => {
    const out: number[] = [];
    for (const id of ids) {
      const i = index.get(id);
      if (i !== undefined) out.push(i);
    }
    return out;
  };
  const edgeIndex = new Map<UnionId, number>();
  for (const e of edges) edgeIndex.set(e.id, e.index);
  const hunks: SceneHunk[] = tour.map((h, k) => {
    const hunk = diff.hunks[h] as Hunk;
    const hn = indicesOf(hunk.nodes, nodeIndex);
    const hc = indicesOf(hunk.context, nodeIndex);
    const b = new BoundsBuilder();
    for (const i of [...hn, ...hc]) {
      const n = nodes[i] as SceneNode;
      addNodeBox(b, n.x, n.y, n.r, n.label, n.labelBefore);
    }
    const text = formatHunk(hunk, diff, locale);
    return {
      index: k,
      id: hunk.id,
      kind: hunk.kind,
      phase: hunk.phase,
      family: sceneHunkFamily(hunk, byId),
      title: text.title,
      subtitle: text.subtitle,
      anchor: nodeIndex.get(hunk.anchor) ?? -1,
      nodes: hn,
      edges: indicesOf(hunk.edges, edgeIndex),
      context: hc,
      bounds: b.rect({ x: center.x, y: center.y, width: 0, height: 0 }),
    };
  });

  // ── Suggestions ──
  const suggestions: SceneSuggestion[] = [];
  for (const s of diff.suggestions) {
    const before = byBefore.get(s.before);
    const after = byAfter.get(s.after);
    if (before !== undefined && after !== undefined && before !== after) {
      suggestions.push({ before, after, score: s.score });
    }
  }

  const playPos = new Int32Array(tour.length);
  for (let k = 0; k < tour.length; k++) playPos[tour[k] as number] = k;
  const timeline = buildTimeline(
    hunks.map((h, k) => {
      const item = tourItems[tour[k] as number] as TourHunk;
      return {
        kind: h.kind,
        phase: h.phase,
        size: item.size,
        bounds: h.bounds,
        requires: item.requires.map((r) => playPos[r] as number),
      };
    }),
    pace,
    chapterThreshold,
  );

  const hunkIdx = new Map<string, number>();
  for (const h of hunks) hunkIdx.set(h.id, h.index);

  return {
    nodes,
    edges,
    hunks,
    suggestions,
    bounds,
    stats: diff.stats,
    timeline,
    theme,
    locale,
    meta: { before: diff.before.meta, after: diff.after.meta },
    nodeIndex,
    edgeIndex,
    hunkIndex: hunkIdx,
    ...(shapesInUse.size > 0
      ? { shapes: shapeEntries.filter((entry) => shapesInUse.has(entry)) }
      : {}),
  };
}
