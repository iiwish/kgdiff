import { KgdiffError } from '@kgdiff/core';
import { describe, expect, it, vi } from 'vitest';
import { desaturate } from '../src/color.js';
import {
  buildScene,
  type ChangeFamily,
  computeFocus,
  createViewState,
  createVisualResolver,
  type EdgeVisual,
  type FrameVisuals,
  type GlyphVisual,
  getTheme,
  type NodeVisual,
  parseColor,
  type Scene,
  type ViewState,
} from '../src/index.js';
import { IDS, kitchenSink, makeLayout, POSITIONS, synthetic } from './fixtures.js';

vi.mock('@kgdiff/core', async (orig) => ({
  ...(await orig<object>()),
  formatHunk: (await import('./mock-core.js')).fakeFormatHunk,
}));

const T = getTheme('dark');
const F = T.family;
const N = T.neutral;
const diff = kitchenSink();
const scene = buildScene(diff, makeLayout(diff, POSITIONS));
const resolver = createVisualResolver(scene);

const frame = (view: Partial<ViewState> = {}, s: Scene = scene): FrameVisuals =>
  (s === scene ? resolver : createVisualResolver(s)).resolve(createViewState(view));
const ni = (id: string, s: Scene = scene): number => {
  const i = s.nodeIndex.get(id);
  if (i === undefined) throw new Error(id);
  return i;
};
const ei = (id: string): number => {
  const j = scene.edgeIndex.get(id);
  if (j === undefined) throw new Error(id);
  return j;
};
const nv = (f: FrameVisuals, id: string, s: Scene = scene): NodeVisual =>
  f.nodes[ni(id, s)] as NodeVisual;
const ev = (f: FrameVisuals, id: string): EdgeVisual => f.edges[ei(id)] as EdgeVisual;
const pos = (id: string) => scene.nodes[ni(id)] as Scene['nodes'][number];
const glyphs = (f: FrameVisuals, kind: GlyphVisual['kind']) =>
  f.glyphs.filter((g) => g.kind === kind);

describe('union layer (overlay)', () => {
  const f = frame();

  it('draws unchanged context quietly', () => {
    const a = nv(f, 'A');
    expect(a).toMatchObject({
      visible: true,
      alpha: 1,
      fill: N.node,
      stroke: N.nodeStroke,
      strokeWidth: 1.25,
      dash: null,
      ring: null,
      halo: null,
      badge: null,
      secondaryLabel: null,
      pulse: 0,
      z: 0,
    });
    expect(a.label).toMatchObject({
      text: 'Alpha',
      color: N.label,
      weight: 400,
      size: 12,
      strike: false,
      offset: 5,
    });
    const e = ev(f, IDS.unchangedAB1);
    expect(e).toMatchObject({
      visible: true,
      color: N.edge,
      width: 1,
      alpha: 1,
      dash: null,
      arrow: true,
      arrowMinZoom: 1.2,
      label: null,
    });
    expect(e).toMatchObject({ progress: 1, fromTarget: false, z: 0 });
    expect(nv(f, 'A').family).toBe('neutral');
  });

  it('draws added nodes solid with a halo', () => {
    const n = nv(f, 'N1');
    expect(n).toMatchObject({
      fill: F.added.base,
      stroke: F.added.strong,
      ring: null,
      dash: null,
      z: 2,
    });
    expect(n.halo).toEqual({ color: F.added.base, radius: pos('N1').r * 2.6, alpha: 0.32 });
    expect(n.label).toMatchObject({
      text: 'New one',
      color: T.text.primary,
      weight: 600,
      minZoom: 0.2,
    });
    const e = ev(f, IDS.addedN1A);
    expect(e).toMatchObject({ color: F.added.base, width: 1.75, dash: null, arrow: true });
    expect(e.label).toMatchObject({
      text: 'likes',
      color: F.added.text,
      size: 10.5,
      minZoom: 1.1,
      offset: 0,
    });
  });

  it('draws removed nodes as hollow dashed ghosts with struck labels', () => {
    const n = nv(f, 'R1');
    expect(n).toMatchObject({
      fill: null,
      stroke: F.removed.base,
      dash: [3, 2.5],
      ring: null,
      halo: null,
      z: 1,
    });
    expect(n.label).toMatchObject({ text: 'Old one', strike: true });
    const e = ev(f, IDS.removedR1B);
    expect(e).toMatchObject({ color: F.removed.base, width: 1.75, dash: [4, 3], arrow: true });
    expect(e.label?.strike).toBe(true);
  });

  it('draws modified nodes with a family ring, the new name and the struck old one, and a badge', () => {
    const n = nv(f, 'M1');
    expect(n).toMatchObject({ fill: F.content.base, stroke: F.content.strong, halo: null });
    expect(n.ring).toEqual({ color: F.content.base, width: 1.5, gap: 3.5, alpha: 1 });
    expect(n.label).toMatchObject({ text: 'Mu', strike: false, weight: 600 });
    expect(n.secondaryLabel).toMatchObject({
      text: 'Mu old',
      strike: true,
      color: T.text.muted,
      size: 11,
      offset: 19,
      minZoom: 0.2,
    });
    expect(n.badge).toEqual({
      text: '+2 −1 ~1',
      color: F.content.text,
      background: F.content.soft,
      minZoom: 1.2,
    });
    expect(nv(f, 'M2').ring?.color).toBe(F.structure.base);
    expect(nv(f, 'M4').ring?.color).toBe(F.identity.base);
    expect(nv(f, 'M5').ring?.color).toBe(F.structure.base);
  });

  it('draws deprecated nodes desaturated and struck, with an arc to the replacement', () => {
    const n = nv(f, 'DP');
    expect(n.fill).toBe(desaturate(F.content.base, 0.6));
    expect(n.label?.strike).toBe(true);
    const [arc] = glyphs(f, 'replacement-arrow');
    expect(arc).toMatchObject({
      x1: pos('DP').x,
      y1: pos('DP').y,
      x2: pos('C').x,
      y2: pos('C').y,
      color: F.identity.base,
      curvature: 0.25,
      progress: 1,
    });
  });

  it('draws merges: ghost sources with arcs, target ring + halo + ⊕ badge', () => {
    const s1 = nv(f, 'S1');
    expect(s1).toMatchObject({ fill: null, stroke: F.identity.base, dash: [3, 2.5] });
    expect(s1.label?.strike).toBe(true);
    const t = nv(f, 'T');
    expect(t).toMatchObject({ fill: F.identity.base });
    expect(t.ring?.color).toBe(F.identity.base);
    expect(t.halo?.color).toBe(F.identity.base);
    expect(t.badge?.text).toBe('⊕ 2');
    expect(t.secondaryLabel?.text).toBe('Tee old');
    const arcs = glyphs(f, 'merge-arrow');
    expect(arcs).toHaveLength(2);
    // Arcs run between node centers and stop at r + 4 (clear of the rings), like edges.
    const fromS1 = arcs.find((g) => g.x1 === pos('S1').x && g.y1 === pos('S1').y);
    expect(fromS1).toMatchObject({
      x2: pos('T').x,
      y2: pos('T').y,
      r1: pos('S1').r + 4,
      r2: pos('T').r + 4,
      curvature: 0.25,
    });
    expect(ev(f, IDS.carriedTD)).toMatchObject({ color: F.identity.base, width: 1.75, dash: null });
    expect(ev(f, IDS.collapsedS2A)).toMatchObject({
      color: F.identity.base,
      dash: [4, 3],
      alpha: 0.5,
    });
  });

  it('draws splits: source and targets with identity rings and arcs from the source', () => {
    expect(nv(f, 'X').ring?.color).toBe(F.identity.base);
    expect(nv(f, 'X').halo).not.toBeNull();
    expect(nv(f, 'Y1').ring?.color).toBe(F.identity.base);
    const arcs = glyphs(f, 'split-arrow');
    expect(arcs).toHaveLength(2);
    for (const g of arcs)
      expect(g).toMatchObject({ x1: pos('X').x, y1: pos('X').y, r1: pos('X').r + 4 });
  });

  it('draws retargets as the new edge plus the old dashed ghost and a pivot', () => {
    const e = ev(f, IDS.retargetCB);
    expect(e).toMatchObject({
      color: F.structure.base,
      width: 1.75,
      dash: null,
      arrow: true,
      arrowMinZoom: 0,
    });
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([pos('C').x, pos('C').y, pos('B').x, pos('B').y]);
    const ghosts = glyphs(f, 'edge-ghost');
    const ghost = ghosts.find(
      (g) =>
        Math.hypot(g.x2 - pos('D').x, g.y2 - pos('D').y) <= pos('D').r + 1e-6 &&
        Math.abs(g.x1 - pos('C').x) < 20,
    );
    expect(ghost).toMatchObject({ color: F.removed.base, alpha: 0.45, dash: [4, 3] });
    expect(Math.abs(ghost?.curvature ?? 0)).toBeCloseTo(0.18, 12);
    const pivots = glyphs(f, 'pivot');
    expect(pivots).toHaveLength(3);
    const pivot = pivots.find(
      (g) => Math.hypot(g.x1 - pos('C').x, g.y1 - pos('C').y) < pos('C').r + 1e-6,
    );
    expect(pivot).toMatchObject({
      color: F.structure.base,
      width: 5,
      x2: pivot?.x1,
      y2: pivot?.y1,
    });
    // The carried edge's before form is a faint identity ghost.
    expect(ghosts.some((g) => g.color === F.identity.base && g.alpha === 0.45)).toBe(true);
  });

  it('labels relabeled and re-predicated edges "old → new"', () => {
    expect(ev(f, IDS.labelM1C).label?.text).toBe('held → owns');
    expect(ev(f, IDS.labelM1C).color).toBe(F.content.base);
    expect(ev(f, IDS.predicateM3D).label?.text).toBe('p → q');
    expect(ev(f, IDS.predicateM3D).color).toBe(F.structure.base);
  });

  it('shows suggestions as dotted identity links with "?" when enabled', () => {
    const [s] = glyphs(f, 'suggestion');
    expect(s).toMatchObject({ color: F.identity.base, dash: [1, 3], width: 1.25 });
    expect(s?.label).toMatchObject({ text: '?', minZoom: 0.2 });
    expect(glyphs(frame({ showSuggestions: false }), 'suggestion')).toHaveLength(0);
  });

  it('has no spotlight and no collapsed groups by default', () => {
    expect(f.spotlight).toBe(0);
    expect(f.collapsed).toEqual([]);
  });
});

describe('before layer', () => {
  const f = frame({ layer: 'before' });

  it('hides what does not exist yet and shows what will go solid', () => {
    for (const id of ['N1', 'N2', 'Q2', 'Y1', 'Y2']) expect(nv(f, id).visible, id).toBe(false);
    expect(nv(f, 'R1')).toMatchObject({ visible: true, fill: F.removed.base, dash: null });
    expect(nv(f, 'R1').label?.strike).toBe(false);
    expect(ev(f, IDS.addedN1A).visible).toBe(false);
    expect(ev(f, IDS.removedR1B)).toMatchObject({
      visible: true,
      color: F.removed.base,
      dash: null,
    });
    expect(f.glyphs).toEqual([]);
  });

  it('shows old names without badges', () => {
    const m1 = nv(f, 'M1');
    expect(m1.label?.text).toBe('Mu old');
    expect(m1.secondaryLabel).toBeNull();
    expect(m1.badge).toBeNull();
    expect(m1.ring?.color).toBe(F.content.base);
    const dp = nv(f, 'DP');
    expect(dp.fill).toBe(F.content.base);
    expect(dp.label?.strike).toBe(false);
  });

  it('shows merge sources solid identity and the target as its own facet', () => {
    expect(nv(f, 'S1')).toMatchObject({ fill: F.identity.base, dash: null });
    const t = nv(f, 'T');
    expect(t.label?.text).toBe('Tee old');
    expect(t.ring?.color).toBe(F.content.base);
    expect(t.halo).toBeNull();
    expect(t.badge).toBeNull();
    expect(nv(f, 'X')).toMatchObject({ fill: F.identity.base, ring: null });
  });

  it('draws retargeted and carried edges in their before form', () => {
    const r = ev(f, IDS.retargetCB);
    expect([r.x2, r.y2]).toEqual([pos('D').x, pos('D').y]);
    expect(r.color).toBe(F.structure.base);
    const c = ev(f, IDS.carriedTD);
    expect([c.x1, c.y1]).toEqual([pos('S1').x, pos('S1').y]);
    expect(c.color).toBe(F.identity.base);
    expect(ev(f, IDS.collapsedS2A)).toMatchObject({
      visible: true,
      dash: null,
      alpha: 1,
      color: F.identity.base,
    });
    expect(ev(f, IDS.labelM1C).label?.text).toBe('held');
  });
});

describe('after layer', () => {
  const f = frame({ layer: 'after' });

  it('hides what is gone', () => {
    for (const id of ['R1', 'R2', 'Q1', 'S1', 'S2']) expect(nv(f, id).visible, id).toBe(false);
    for (const id of [IDS.removedR1B, IDS.collapsedS2A, IDS.removedS1B])
      expect(ev(f, id).visible).toBe(false);
  });

  it('shows new names, badges, targets with ring + halo, deprecated nodes', () => {
    expect(nv(f, 'M1').label?.text).toBe('Mu');
    expect(nv(f, 'M1').secondaryLabel).toBeNull();
    expect(nv(f, 'M1').badge?.text).toBe('+2 −1 ~1');
    expect(nv(f, 'T').badge?.text).toBe('⊕ 2');
    expect(nv(f, 'T').halo).not.toBeNull();
    expect(nv(f, 'DP').label?.strike).toBe(true);
    const r = ev(f, IDS.retargetCB);
    expect([r.x2, r.y2]).toEqual([pos('B').x, pos('B').y]);
    expect(ev(f, IDS.labelM1C).label?.text).toBe('owns');
    expect(f.glyphs.map((g) => g.kind)).toEqual(['replacement-arrow']);
  });
});

describe('selection spotlight', () => {
  const h = scene.hunkIndex.get('merge:T') as number;
  const f = frame({ selectedHunk: h });

  it('keeps the hunk at full strength with halos, context at 70%, the rest at 18% without labels', () => {
    for (const id of ['T', 'S1', 'S2']) {
      expect(nv(f, id).alpha, id).toBe(1);
      expect(nv(f, id).halo, id).not.toBeNull();
      expect(nv(f, id).label?.minZoom, id).toBe(0);
    }
    expect(nv(f, 'T').badge?.minZoom).toBe(0);
    for (const id of ['A', 'B', 'D']) {
      expect(nv(f, id).alpha, id).toBeCloseTo(0.7, 12);
      expect(nv(f, id).label, id).not.toBeNull();
    }
    for (const id of ['F', 'N1', 'M1']) {
      expect(nv(f, id).alpha, id).toBeCloseTo(0.18, 12);
      expect(nv(f, id).label, id).toBeNull();
      expect(nv(f, id).badge, id).toBeNull();
    }
    expect(f.spotlight).toBe(1);
  });

  it('thickens hunk edges and dims the rest', () => {
    expect(ev(f, IDS.carriedTD)).toMatchObject({ width: 2.5, alpha: 1, z: 3 });
    expect(ev(f, IDS.carriedTD).label?.minZoom).toBe(0);
    expect(ev(f, IDS.unchangedAB1).alpha).toBeCloseTo(0.7, 12);
    expect(ev(f, IDS.addedN1N2).alpha).toBeCloseTo(0.18, 12);
    expect(ev(f, IDS.addedN1N2).label).toBeNull();
    const near = (g: GlyphVisual, id: string) =>
      Math.hypot(g.x1 - pos(id).x, g.y1 - pos(id).y) < pos(id).r + 5;
    const arcs = glyphs(f, 'merge-arrow');
    for (const id of ['S1', 'S2'])
      expect(arcs.find((g) => near(g, id))?.alpha, id).toBeCloseTo(0.9, 12);
    // The deprecated node's replacement arc is outside the hunk.
    expect(glyphs(f, 'replacement-arrow')[0]?.alpha).toBeCloseTo(0.9 * 0.18, 12);
    const [s] = glyphs(f, 'suggestion');
    expect(s?.alpha).toBeCloseTo(0.85 * 0.18, 12);
    expect(s?.label).toBeNull();
  });

  it('ignores an out-of-range selection', () => {
    expect(frame({ selectedHunk: 999 }).spotlight).toBe(0);
  });

  it('renders label priority as selected hunk > hovered > changed > neutral', () => {
    const g = frame({ selectedHunk: h, hoveredNode: ni('A') });
    const p = (id: string) => nv(g, id).label?.priority ?? -1;
    expect(p('T')).toBeGreaterThan(p('A'));
    const plain = frame({ hoveredNode: ni('A') });
    const q = (id: string) => nv(plain, id).label?.priority ?? -1;
    expect(q('A')).toBeGreaterThan(q('M1'));
    expect(q('M1')).toBeGreaterThan(q('B'));
    expect(nv(plain, 'M1').secondaryLabel?.priority).toBeLessThan(q('M1'));
  });
});

describe('selection emphasis (view.emphasis animates the spotlight in)', () => {
  const h = scene.hunkIndex.get('merge:T') as number;

  it('applies nothing at emphasis 0', () => {
    const f = frame({ selectedHunk: h, emphasis: 0 });
    expect(nv(f, 'F').alpha).toBe(1);
    expect(nv(f, 'A').alpha).toBe(1);
    expect(nv(f, 'F').label?.alpha).toBe(1);
    expect(nv(f, 'S1').halo).toBeNull();
    expect(ev(f, IDS.carriedTD).width).toBe(1.75);
    expect(f.spotlight).toBe(0);
    // Selection bookkeeping (labels always shown for the hunk) does not wait for the emphasis.
    expect(nv(f, 'T').label?.minZoom).toBe(0);
  });

  it('interpolates dim levels, halos, edge width, rest labels and spotlight', () => {
    const f = frame({ selectedHunk: h, emphasis: 0.5 });
    expect(nv(f, 'F').alpha).toBeCloseTo(1 + (0.18 - 1) * 0.5, 12);
    expect(nv(f, 'A').alpha).toBeCloseTo(1 + (0.7 - 1) * 0.5, 12);
    expect(nv(f, 'T').alpha).toBe(1);
    expect(nv(f, 'F').label?.alpha).toBeCloseTo(0.5, 12);
    expect(nv(f, 'A').label?.alpha).toBe(1); // context keeps its labels
    expect(nv(f, 'S1').halo?.alpha).toBeCloseTo(0.32 * 0.5, 12);
    expect(ev(f, IDS.carriedTD).width).toBeCloseTo(1.75 + (2.5 - 1.75) * 0.5, 12);
    expect(f.spotlight).toBe(0.5);
    // Badges have no alpha: they go once the fade is past halfway.
    expect(nv(frame({ selectedHunk: h, emphasis: 0.4 }), 'M1').badge).not.toBeNull();
    expect(nv(frame({ selectedHunk: h, emphasis: 0.6 }), 'M1').badge).toBeNull();
  });

  it('clamps out-of-range values and treats non-finite ones as 1', () => {
    expect(frame({ selectedHunk: h, emphasis: 7 }).spotlight).toBe(1);
    expect(frame({ selectedHunk: h, emphasis: -1 }).spotlight).toBe(0);
    expect(frame({ selectedHunk: h, emphasis: Number.NaN }).spotlight).toBe(1);
  });

  it('does not touch the replay spotlight', () => {
    const t = scene.timeline.windows[0]?.start ?? 0;
    const w = scene.timeline.windows[0];
    const mid = w === undefined ? t : (w.start + w.end) / 2;
    const a = createVisualResolver(scene).resolve(
      createViewState({ layer: 'replay', t: mid, emphasis: 0 }),
    );
    const b = createVisualResolver(scene).resolve(
      createViewState({ layer: 'replay', t: mid, emphasis: 1 }),
    );
    expect(nv(a, 'F').alpha).toBe(nv(b, 'F').alpha);
    expect(a.spotlight).toBe(b.spotlight);
  });
});

describe('family filter', () => {
  const only = (...fams: ChangeFamily[]) => frame({ families: new Set(fams) });

  it('renders other families as neutral at 40%, keeping the ghost shape', () => {
    const f = only('added');
    expect(nv(f, 'N1')).toMatchObject({ alpha: 1, fill: F.added.base });
    const r1 = nv(f, 'R1');
    expect(r1).toMatchObject({
      alpha: 0.4,
      fill: null,
      stroke: N.nodeStroke,
      dash: [3, 2.5],
      halo: null,
    });
    // Drawn as neutral context: neutral label LOD (small scene: 0.25).
    expect(r1.label).toMatchObject({ color: N.label, weight: 400, minZoom: 0.25 });
    const m1 = nv(f, 'M1');
    expect(m1).toMatchObject({
      alpha: 0.4,
      fill: N.node,
      ring: null,
      badge: null,
      secondaryLabel: null,
    });
    expect(nv(f, 'A').alpha).toBe(0.4);
    expect(ev(f, IDS.removedR1B)).toMatchObject({
      alpha: 0.4,
      color: N.edge,
      width: 1,
      arrowMinZoom: 1.2,
    });
    expect(ev(f, IDS.addedBD).alpha).toBe(1);
    // Drawn as context: the minimap colors it neutral.
    expect(r1.family).toBe('neutral');
    expect(nv(f, 'N1').family).toBe('added');
  });

  it('keeps elements whose hunk matches the filter', () => {
    const f = only('structure');
    // B → D is added (green) but belongs to a relations hunk (structure).
    expect(ev(f, IDS.addedBD)).toMatchObject({ alpha: 1, color: F.added.base });
    expect(nv(f, 'M2').alpha).toBe(1);
    expect(nv(f, 'N1').alpha).toBe(0.4);
  });
});

describe('focus (changes only)', () => {
  it('hides what focus hides, quiets context and passes collapsed groups through', () => {
    const focus = computeFocus(scene);
    const f = frame({ focus });
    expect(nv(f, 'F').visible).toBe(false);
    expect(nv(f, 'A').alpha).toBeCloseTo(0.55, 12);
    expect(nv(f, 'N1').alpha).toBe(1);
    expect(ev(f, IDS.unchangedAB1).alpha).toBeCloseTo(0.55, 12);
    expect(f.collapsed).toBe(focus.collapsed);
    const narrow = computeFocus(scene, { hops: 0 });
    const g = frame({ focus: narrow });
    // E is an endpoint of changed edges, so it stays; so does the unchanged D → E between two visible nodes.
    expect(nv(g, 'E').visible).toBe(true);
    expect(ev(g, IDS.unchangedDE).visible).toBe(true);
    expect(glyphs(g, 'suggestion')).toHaveLength(1);
    // A focus that hides an endpoint hides the glyphs attached to it.
    const nodes = Uint8Array.from(narrow.nodes);
    nodes[ni('Q2')] = 0;
    expect(glyphs(frame({ focus: { ...narrow, nodes } }), 'suggestion')).toHaveLength(0);
  });

  it('rejects a focus computed for another scene', () => {
    const other = buildScene(diff, makeLayout(diff, { A: [0, 0] }));
    expect(() => frame({ focus: computeFocus(other) })).toThrow(KgdiffError);
  });
});

describe('hover and selected node', () => {
  it('emphasizes the hovered node and always labels it', () => {
    const f = frame({ hoveredNode: ni('F') });
    expect(nv(f, 'F')).toMatchObject({ strokeWidth: 2, stroke: T.text.secondary, z: 4 });
    expect(nv(f, 'F').label?.minZoom).toBe(0);
    const g = frame({ hoveredNode: ni('M1') });
    expect(nv(g, 'M1').stroke).toBe(F.content.strong);
  });

  it('labels the hovered edge, even a neutral one', () => {
    const f = frame({ hoveredEdge: ei(IDS.unchangedAB1) });
    expect(ev(f, IDS.unchangedAB1)).toMatchObject({ width: 2.5, arrowMinZoom: 0, z: 4 });
    expect(ev(f, IDS.unchangedAB1).label).toMatchObject({ text: 'p1', minZoom: 0, color: N.label });
  });

  it('rings the selected node in the accent color', () => {
    const f = frame({ selectedNode: ni('A') });
    expect(nv(f, 'A').ring).toEqual({ color: T.accent.base, width: 2, gap: 3.5, alpha: 1 });
    expect(nv(f, 'A').label?.minZoom).toBe(0);
  });
});

describe('level of detail', () => {
  const big = synthetic(400, 600, 5);
  const large = buildScene(big.diff, big.layout);
  const largeFrame = createVisualResolver(large).resolve(createViewState());
  const labelZoom = (f: FrameVisuals, s: Scene, pick: (n: Scene['nodes'][number]) => boolean) =>
    new Set(s.nodes.filter(pick).map((n) => f.nodes[n.index]?.label?.minZoom));

  it('labels large scenes from 0.35 (changed) and 0.5 / 0.35 (neutral, important ≥ 0.7)', () => {
    expect(large.nodes.length).toBeGreaterThan(300);
    expect(labelZoom(largeFrame, large, (n) => n.status !== 'unchanged')).toEqual(new Set([0.35]));
    expect(
      labelZoom(largeFrame, large, (n) => n.status === 'unchanged' && n.importance < 0.7),
    ).toEqual(new Set([0.5]));
    expect(
      labelZoom(largeFrame, large, (n) => n.status === 'unchanged' && n.importance >= 0.7),
    ).toEqual(new Set([0.35]));
  });

  it('labels small scenes (≤ 300 visible nodes) from 0.2 (changed) and 0.25 (neutral)', () => {
    const f = frame();
    expect(nv(f, 'N1').label?.minZoom).toBe(0.2);
    expect(nv(f, 'M1').secondaryLabel?.minZoom).toBe(0.2);
    expect(pos('B').importance).toBeGreaterThanOrEqual(0.7);
    expect(nv(f, 'B').label?.minZoom).toBe(0.25);
    expect(pos('F').importance).toBeLessThan(0.7);
    expect(nv(f, 'F').label?.minZoom).toBe(0.25);
  });

  it('counts visible nodes after focus', () => {
    const focus = computeFocus(large, { hops: 0 });
    const visible = [...focus.nodes].filter((v) => v === 1).length;
    expect(visible).toBeLessThanOrEqual(300);
    const f = createVisualResolver(large).resolve(createViewState({ focus }));
    const shown = large.nodes.filter((n) => focus.nodes[n.index] === 1);
    expect(
      new Set(
        shown.filter((n) => n.status !== 'unchanged').map((n) => f.nodes[n.index]?.label?.minZoom),
      ),
    ).toEqual(new Set([0.2]));
  });

  it('keeps the other LOD rows: badges 1.2, changed edge labels 1.1, arrowheads', () => {
    const f = frame();
    expect(nv(f, 'M1').badge?.minZoom).toBe(1.2);
    expect(ev(f, IDS.labelM1C).label?.minZoom).toBe(1.1);
    expect(ev(f, IDS.unchangedBC).label).toBeNull();
    // Arrowheads: changed edges always, neutral ones from zoom 1.2; selected edges always.
    expect(ev(f, IDS.addedN1A)).toMatchObject({ arrow: true, arrowMinZoom: 0 });
    expect(ev(f, IDS.unchangedBC)).toMatchObject({ arrow: true, arrowMinZoom: 1.2 });
    const sel = frame({ selectedHunk: scene.hunkIndex.get('merge:T') as number });
    expect(ev(sel, IDS.carriedTD).arrowMinZoom).toBe(0);
  });
});

describe('contract details', () => {
  it('reports the family each node is drawn in', () => {
    expect(nv(frame(), 'DP').family).toBe('content');
    expect(nv(frame(), 'S1').family).toBe('identity');
    expect(nv(frame(), 'M2').family).toBe('structure');
    expect(nv(frame({ layer: 'before' }), 'T').family).toBe('content'); // renamed: its own facet
    expect(nv(frame({ layer: 'before' }), 'X').family).toBe('identity');
    expect(nv(frame({ families: new Set(['added'] as const) }), 'M1').family).toBe('neutral');
  });

  it('keeps nested alphas relative to their element', () => {
    const f = frame({ selectedHunk: scene.hunkIndex.get('merge:T') as number });
    // Context at 70%: its label keeps alpha 1 (renderers multiply).
    expect(nv(f, 'A').alpha).toBeCloseTo(0.7, 12);
    expect(nv(f, 'A').label?.alpha).toBe(1);
    // Focus context at 55%.
    const g = frame({ focus: computeFocus(scene) });
    expect(nv(g, 'A').alpha).toBeCloseTo(0.55, 12);
    expect(nv(g, 'A').label?.alpha).toBe(1);
    // Halo alpha is the token value, relative to the node.
    expect(nv(frame({ families: new Set(['identity'] as const) }), 'T').halo?.alpha).toBe(0.32);
    const filtered = frame({ families: new Set(['identity'] as const) });
    expect(ev(filtered, IDS.labelM1C).alpha).toBe(0.4);
    expect(ev(filtered, IDS.labelM1C).label?.alpha).toBe(1);
    const [s] = glyphs(frame(), 'suggestion');
    expect(s?.alpha).toBe(0.85);
    expect(s?.label?.alpha).toBe(1);
  });

  it('places pivots as dots with zero radii', () => {
    for (const p of glyphs(frame(), 'pivot')) {
      expect(p).toMatchObject({ r1: 0, r2: 0, curvature: 0, width: 5 });
      expect([p.x2, p.y2]).toEqual([p.x1, p.y1]);
    }
  });

  it('gives retarget ghosts the radii of their old endpoints', () => {
    const ghost = glyphs(frame(), 'edge-ghost').find(
      (g) => g.x2 === pos('D').x && g.x1 === pos('C').x,
    );
    expect(ghost).toMatchObject({ r1: pos('C').r, r2: pos('D').r });
  });
});

describe('themes', () => {
  it('uses crisp offset rings for halos in light themes', () => {
    const light = buildScene(diff, makeLayout(diff, POSITIONS), { theme: 'light' });
    const f = frame({}, light);
    const halo = nv(f, 'N1', light).halo;
    expect(halo).toEqual({
      color: getTheme('light').family.added.base,
      radius: pos('N1').r,
      alpha: 0.35,
    });
  });

  it('uses the colorblind palette when asked', () => {
    const cb = buildScene(diff, makeLayout(diff, POSITIONS), { palette: 'colorblind' });
    expect(nv(frame({}, cb), 'N1', cb).fill).toBe('#56B4E9');
  });
});

describe('frame reuse', () => {
  it('returns visuals in scene order and rejects unknown layers', () => {
    const f = frame();
    expect(f.nodes).toHaveLength(scene.nodes.length);
    expect(f.edges).toHaveLength(scene.edges.length);
    expect(() => frame({ layer: 'sideways' as ViewState['layer'] })).toThrow(KgdiffError);
  });

  it('fills a foreign or wrongly sized `out`', () => {
    const out: FrameVisuals = { nodes: [], edges: [], glyphs: [], collapsed: [], spotlight: 0 };
    const f = resolver.resolve(createViewState(), out);
    expect(f).toBe(out);
    expect(out.nodes).toHaveLength(scene.nodes.length);
    expect(out.edges[0]?.visible).toBe(true);
    const small = createVisualResolver(
      buildScene(diff, makeLayout(diff, { A: [0, 0], B: [10, 0] })),
    );
    small.resolve(createViewState(), out);
    expect(out.nodes).toHaveLength(2);
  });
});

describe('glyph nodes', () => {
  type Glyph = FrameVisuals['glyphs'][number];
  const at = (i: number | undefined) => scene.nodes[i as number] as Scene['nodes'][number];

  /** The glyph's coordinates come from the nodes it names. */
  const expectOnItsNodes = (g: Glyph): void => {
    const a = at(g.node1);
    expect(a, g.kind).toBeDefined();
    if (g.kind === 'pivot') {
      expect(g.node2).toBeUndefined();
      // The dot sits on the outline of its node.
      expect(Math.hypot(g.x1 - a.x, g.y1 - a.y)).toBeCloseTo(a.r, 9);
      return;
    }
    const b = at(g.node2);
    expect(b, g.kind).toBeDefined();
    expect([g.x1, g.y1, g.x2, g.y2]).toEqual([a.x, a.y, b.x, b.y]);
  };

  it('names the nodes of every glyph kind', () => {
    const f = frame();
    expect(new Set(f.glyphs.map((g) => g.kind))).toEqual(
      new Set([
        'merge-arrow',
        'split-arrow',
        'replacement-arrow',
        'edge-ghost',
        'pivot',
        'suggestion',
      ]),
    );
    for (const g of f.glyphs) expectOnItsNodes(g);
    const ends = (kind: GlyphVisual['kind']) =>
      glyphs(f, kind)
        .map((g) => [at(g.node1).id, g.node2 === undefined ? null : at(g.node2).id])
        .sort();
    expect(ends('merge-arrow')).toEqual([
      ['S1', 'T'],
      ['S2', 'T'],
    ]);
    expect(ends('split-arrow').map(([a]) => a)).toEqual(['X', 'X']);
    expect(ends('replacement-arrow')).toEqual([['DP', 'C']]);
    const [suggestion] = scene.suggestions;
    expect(ends('suggestion')).toEqual([[at(suggestion?.before).id, at(suggestion?.after).id]]);
    // A ghost runs between the before ends of its edge; a pivot sits on the end the edge kept.
    for (const g of glyphs(f, 'edge-ghost'))
      expect(
        scene.edges.some(
          (e) =>
            (e.role === 'retarget' || e.role === 'carried') && e.sb === g.node1 && e.tb === g.node2,
        ),
      ).toBe(true);
    for (const g of glyphs(f, 'pivot'))
      expect(
        scene.edges.some((e) => e.role === 'retarget' && (e.s === e.sb ? e.s : e.t) === g.node1),
      ).toBe(true);
  });

  it('does not keep the far node of an earlier frame in a reused glyph', () => {
    const out = resolver.resolve(createViewState());
    const views = [
      createViewState({ showSuggestions: false }),
      ...scene.timeline.windows.flatMap((w) =>
        [0.3, 0.5, 0.7].map((u) =>
          createViewState({ layer: 'replay', t: w.start + u * (w.end - w.start) }),
        ),
      ),
      createViewState(),
    ];
    let reused = 0;
    for (const view of views) {
      const before = new Map(out.glyphs.map((g) => [g, g.kind]));
      resolver.resolve(view, out);
      for (const g of out.glyphs) {
        expectOnItsNodes(g);
        const was = before.get(g);
        if (was !== undefined && was !== 'pivot' && g.kind === 'pivot') reused++;
      }
    }
    // The sequence does turn a line glyph of the pool into a pivot.
    expect(reused).toBeGreaterThan(0);
  });
});

describe('colors a scene carries', () => {
  const COLOR_KEYS = new Set(['color', 'fill', 'stroke', 'background']);
  /** Every color string of a visual and of what it nests (rings, halos, labels, badges). */
  const visualColors = (v: unknown, out: Set<string>): void => {
    if (typeof v !== 'object' || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && COLOR_KEYS.has(k)) out.add(x);
      else if (typeof x === 'object') visualColors(x, out);
    }
  };
  /** Every string of the theme, but its names, fonts and the box-shadow (CSS, not a color). */
  const themeColors = (v: unknown, out: Set<string>): void => {
    if (typeof v !== 'object' || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'name' || k === 'palette' || k === 'font' || k === 'shadow') continue;
      if (typeof x === 'string') out.add(x);
      else themeColors(x, out);
    }
  };

  it.each([
    ['dark', 'default'],
    ['dark', 'colorblind'],
    ['light', 'default'],
    ['light', 'colorblind'],
  ] as const)(
    'parses every color of the %s theme (%s palette) and its frames',
    (theme, palette) => {
      const s = buildScene(diff, makeLayout(diff, POSITIONS), { theme, palette });
      const r = createVisualResolver(s);
      const views: Partial<ViewState>[] = [
        {},
        { layer: 'before' },
        { layer: 'after' },
        { selectedHunk: 0, hoveredNode: 0, selectedNode: 1 },
        { families: new Set(['identity'] as const) },
        ...s.timeline.windows.flatMap((w) =>
          [0.2, 0.5, 0.8].map((u) => ({
            layer: 'replay' as const,
            t: w.start + u * (w.end - w.start),
          })),
        ),
      ];
      const colors = new Set<string>();
      themeColors(s.theme, colors);
      const themed = colors.size;
      for (const view of views) {
        const f = r.resolve(createViewState(view));
        // What a frame draws: its visible nodes and edges (a hidden one need not have a color),
        // and every glyph it lists.
        for (const v of [...f.nodes, ...f.edges]) if (v.visible) visualColors(v, colors);
        for (const g of f.glyphs) visualColors(g, colors);
      }
      expect(themed).toBeGreaterThan(20);
      expect(colors.size).toBeGreaterThan(themed);
      for (const c of colors) expect(() => parseColor(c), c).not.toThrow();
    },
  );
});
