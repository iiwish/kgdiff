/**
 * `toG6Data` / `mapFrame`: every visual primitive → G6 style, with hand-made frames.
 */
import type { EdgeData, NodeData } from '@antv/g6';
import { KgdiffError } from '@kgdiff/core';
import {
  evenShapeDash,
  type FrameVisuals,
  type GlyphVisual,
  type NodeVisual,
  type Scene,
} from '@kgdiff/scene';
import { describe, expect, it } from 'vitest';
import { evenCircleDash } from '../src/geometry.js';
import { toG6Data } from '../src/index.js';
import { crossesLod, type KgdiffDatumData, kgdiffData, mapFrame } from '../src/map.js';
import {
  deepFreeze,
  edgeVisual,
  frameOf,
  glyph,
  label,
  largeFrame,
  type MiniNode,
  miniScene,
  nodeVisual,
} from './support/frame.js';

const A: MiniNode = { id: 'a', x: 0, y: 0, r: 6, hunk: 0 };
const B: MiniNode = { id: 'b', x: 100, y: 0, r: 6 };
const C: MiniNode = { id: 'c', x: 0, y: 80, r: 8 };

function three(theme: 'dark' | 'light' = 'dark'): Scene {
  return miniScene(
    [A, B, C],
    [
      { id: 'a→b', s: 0, t: 1, hunk: 0 },
      { id: 'b→c', s: 1, t: 2 },
    ],
    theme,
  );
}

function nodes(scene: Scene, frame: FrameVisuals, zoom = 1, keepHidden = false): NodeData[] {
  return mapFrame(scene, frame, { idPrefix: '', keepHidden, zoom }).data.nodes;
}

function edges(scene: Scene, frame: FrameVisuals, zoom = 1, keepHidden = false): EdgeData[] {
  return mapFrame(scene, frame, { idPrefix: '', keepHidden, zoom }).data.edges;
}

function node(scene: Scene, frame: FrameVisuals, id: string, zoom = 1): NodeData {
  const found = nodes(scene, frame, zoom).find((n) => n.id === id);
  if (found === undefined) throw new Error(`node ${id} not mapped`);
  return found;
}

function edge(scene: Scene, frame: FrameVisuals, id: string, zoom = 1): EdgeData {
  const found = edges(scene, frame, zoom).find((e) => e.id === id);
  if (found === undefined) throw new Error(`edge ${id} not mapped`);
  return found;
}

function withNode(scene: Scene, i: number, patch: Partial<NodeVisual>): FrameVisuals {
  const frame = frameOf(scene);
  frame.nodes[i] = { ...(frame.nodes[i] as NodeVisual), ...patch };
  return frame;
}

function data(d: NodeData | EdgeData): KgdiffDatumData {
  const k = kgdiffData(d.data);
  if (k === null) throw new Error('no kgdiff data');
  return k;
}

describe('nodes', () => {
  it('maps position, diameter, colors, stroke, opacity and z band', () => {
    const scene = three();
    const frame = withNode(scene, 0, {
      x: 12,
      y: -4,
      r: 7,
      fill: '#34D399',
      stroke: '#6EE7B7',
      strokeWidth: 1.25,
      alpha: 0.7,
      z: 2,
      family: 'added',
    });
    const { style } = node(scene, frame, 'a');
    expect(style).toMatchObject({
      x: 12,
      y: -4,
      size: 14,
      fill: '#34D399',
      stroke: '#6EE7B7',
      lineWidth: 1.25,
      lineDash: 0,
      opacity: 0.7,
      zIndex: 32,
      visibility: 'visible',
    });
  });

  it('stores the scene index, hunk and family in data for picking', () => {
    const scene = three();
    const frame = withNode(scene, 0, { family: 'content' });
    const n = node(scene, frame, 'a');
    expect(data(n)).toEqual({
      kgdiff: 'node',
      index: 0,
      hunk: 0,
      family: 'content',
      changed: true,
      label: 'label a',
      glyph: '',
    });
    expect(data(node(scene, frame, 'b'))).toMatchObject({ index: 1, hunk: -1, changed: false });
  });

  it('fills hollow ghosts with the canvas and tiles their dashes evenly around the circle', () => {
    const scene = three();
    const frame = withNode(scene, 0, { fill: null, dash: [3, 2.5], r: 6 });
    const { style } = node(scene, frame, 'a');
    expect(style?.fill).toBe(scene.theme.canvas.background);
    const dash = style?.lineDash as number[];
    expect(dash).toHaveLength(2);
    const period = (dash[0] as number) + (dash[1] as number);
    const periods = (2 * Math.PI * 6) / period;
    expect(Math.abs(periods - Math.round(periods))).toBeLessThan(1e-9);
    expect((dash[0] as number) / (dash[1] as number)).toBeCloseTo(3 / 2.5, 9);
  });

  it('draws no outline when the node has no stroke', () => {
    const scene = three();
    const { style } = node(scene, withNode(scene, 0, { stroke: null }), 'a');
    expect(style?.lineWidth).toBe(0);
    expect(style?.lineDash).toBe(0);
  });

  it('maps a dark glow halo (radius, color, relative alpha) and a G6 band fallback', () => {
    const scene = three('dark');
    const frame = withNode(scene, 0, {
      r: 6,
      halo: { color: '#34D399', radius: 15.6, alpha: 0.32 },
    });
    const { style } = node(scene, frame, 'a');
    expect(style).toMatchObject({
      halo: true,
      haloGlow: true,
      haloRadius: 15.6,
      haloStroke: '#34D399',
      haloStrokeOpacity: 0.32,
    });
    // The built-in G6 halo is a band centred on the outline: it must reach the glow radius.
    expect(style?.haloLineWidth).toBeCloseTo(2 * (15.6 - 6), 9);
  });

  it('maps a light offset-ring halo', () => {
    const scene = three('light');
    const frame = withNode(scene, 0, { halo: { color: '#16A34A', radius: 6, alpha: 0.35 } });
    const { style } = node(scene, frame, 'a');
    expect(style).toMatchObject({ halo: true, haloGlow: false, haloRadius: 6, haloLineWidth: 14 });
  });

  it('switches every optional decoration off explicitly (G6 merges updates into old styles)', () => {
    const scene = three();
    const { style } = node(scene, frameOf(scene), 'a');
    expect(style).toMatchObject({
      halo: false,
      ring: false,
      pulse: 0,
      label: false,
      sublabel: false,
      badge: false,
      badges: [],
    });
  });

  it('maps a concentric ring', () => {
    const scene = three();
    const frame = withNode(scene, 0, {
      ring: { color: '#FBBF24', width: 1.5, gap: 3.5, alpha: 0.8 },
    });
    expect(node(scene, frame, 'a').style).toMatchObject({
      ring: true,
      ringStroke: '#FBBF24',
      ringLineWidth: 1.5,
      ringGap: 3.5,
      ringOpacity: 0.8,
    });
    const flat = withNode(scene, 0, { ring: { color: '#FBBF24', width: 0, gap: 3.5, alpha: 1 } });
    expect(node(scene, flat, 'a').style?.ring).toBe(false);
  });

  it('maps a replay pulse in (0, 1) and drops 0 / 1', () => {
    const scene = three();
    expect(node(scene, withNode(scene, 0, { pulse: 0.4 }), 'a').style?.pulse).toBe(0.4);
    expect(node(scene, withNode(scene, 0, { pulse: 1 }), 'a').style?.pulse).toBe(0);
    expect(node(scene, withNode(scene, 0, { pulse: 0 }), 'a').style?.pulse).toBe(0);
  });

  it('maps the label: text, color, size, weight, absolute opacity, offset and text halo', () => {
    const scene = three();
    const frame = withNode(scene, 0, {
      alpha: 0.5,
      label: label({
        text: '企业',
        color: '#FCD34D',
        size: 12,
        weight: 600,
        alpha: 0.8,
        offset: 5,
      }),
    });
    expect(node(scene, frame, 'a').style).toMatchObject({
      label: true,
      labelText: '企业',
      labelFill: '#FCD34D',
      labelFontSize: 12,
      labelFontWeight: 600,
      labelOpacity: 0.4,
      labelPlacement: 'bottom',
      labelOffsetY: 5,
      labelStroke: scene.theme.canvas.background,
      labelLineWidth: 3,
      labelStrokeOpacity: 0.36000000000000004,
      labelFontFamily: scene.theme.font.family,
      labelTextDecorationLine: 'none',
    });
  });

  it('strikes labels through in their own color', () => {
    const scene = three();
    const frame = withNode(scene, 0, { label: label({ strike: true, color: '#FCA5A5' }) });
    expect(node(scene, frame, 'a').style).toMatchObject({
      labelTextDecorationLine: 'line-through',
      labelTextDecorationColor: '#FCA5A5',
    });
  });

  it('applies label LOD at the given zoom but keeps the text for hover', () => {
    const scene = three();
    const frame = withNode(scene, 0, { label: label({ text: 'far', minZoom: 1.2 }) });
    expect(node(scene, frame, 'a', 1).style).toMatchObject({ label: false, labelText: 'far' });
    expect(node(scene, frame, 'a', 1.2).style?.label).toBe(true);
    const nan = withNode(scene, 0, { label: label({ minZoom: Number.NaN }) });
    expect(node(scene, nan, 'a').style?.label).toBe(true);
  });

  it('maps the struck old name as a secondary label', () => {
    const scene = three();
    const frame = withNode(scene, 0, {
      label: label({ text: 'new' }),
      secondaryLabel: label({ text: 'old', strike: true, color: '#737D8F', size: 11, offset: 19 }),
    });
    expect(node(scene, frame, 'a').style).toMatchObject({
      sublabel: true,
      sublabelText: 'old',
      sublabelFill: '#737D8F',
      sublabelFontSize: 11,
      sublabelOffsetY: 19,
      sublabelTextDecorationLine: 'line-through',
      sublabelOpacity: 1,
    });
  });

  it('maps a badge with an opaque background (tint composited over the canvas)', () => {
    const scene = three();
    const frame = withNode(scene, 0, {
      badge: { text: '+2 −1', color: '#FCD34D', background: 'rgba(251,191,36,0.15)', minZoom: 0 },
    });
    const style = node(scene, frame, 'a').style;
    expect(style?.badge).toBe(true);
    const [badge] = (style?.badges ?? []) as { backgroundFill: string }[];
    expect(badge).toMatchObject({ text: '+2 −1', fill: '#FCD34D', placement: 'right-top' });
    // 0.15 · (251, 191, 36) + 0.85 · #0B0E14 (11, 14, 20)
    expect(badge?.backgroundFill).toBe('rgb(47, 41, 22)');
  });

  it('hides badges below their LOD zoom', () => {
    const scene = three();
    const frame = withNode(scene, 0, {
      badge: { text: '⊕ 2', color: '#C4B5FD', background: '#171C26', minZoom: 1.2 },
    });
    expect(node(scene, frame, 'a', 1).style).toMatchObject({ badge: false, badges: [] });
    expect(node(scene, frame, 'a', 1.25).style?.badge).toBe(true);
  });

  it('omits invisible nodes, or keeps them hidden with keepHidden', () => {
    const scene = three();
    const frame = withNode(scene, 2, { visible: false, alpha: 0 });
    expect(nodes(scene, frame).map((n) => n.id)).toEqual(['a', 'b']);
    const kept = nodes(scene, frame, 1, true).find((n) => n.id === 'c');
    expect(kept?.style?.visibility).toBe('hidden');
  });

  it('gives every node the same style keys, so G6 merges never keep stale values', () => {
    const scene = three();
    const frame = withNode(scene, 0, {
      halo: { color: '#34D399', radius: 15, alpha: 0.3 },
      ring: { color: '#FBBF24', width: 1.5, gap: 3.5, alpha: 1 },
      label: label(),
      secondaryLabel: label({ text: 'old' }),
      badge: { text: '+1', color: '#fff', background: '#000', minZoom: 0 },
      pulse: 0.5,
      dash: [3, 2.5],
    });
    const keys = nodes(scene, frame).map((n) =>
      Object.keys(n.style ?? {})
        .sort()
        .join(','),
    );
    expect(new Set(keys).size).toBe(1);
  });
});

describe('edges', () => {
  it('maps straight edges to G6 lines with stroke, width, opacity, z band and data', () => {
    const scene = three();
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, { color: '#34D399', width: 1.75, alpha: 0.6, z: 1 });
    const e = edge(scene, frame, 'a→b');
    expect(e).toMatchObject({ source: 'a', target: 'b', type: 'line' });
    expect(e.style).toMatchObject({
      stroke: '#34D399',
      lineWidth: 1.75,
      opacity: 0.6,
      zIndex: 11,
      curveOffset: 0,
      lineDash: 0,
    });
    expect(data(e)).toMatchObject({ kgdiff: 'edge', index: 0, hunk: 0 });
  });

  it('turns curvature into a quadratic whose G6 control point is the scene control point', () => {
    const scene = three();
    const frame = frameOf(scene);
    const c = 0.18;
    frame.edges[0] = edgeVisual(scene, 0, { curvature: c });
    const e = edge(scene, frame, 'a→b');
    expect(e.type).toBe('quadratic');
    // Scene: midpoint + c·(−dy, dx). G6: midpoint + curveOffset·unit(dy, −dx).
    const [x1, y1, x2, y2] = [A.x, A.y, B.x, B.y];
    const sceneControl = [(x1 + x2) / 2 - c * (y2 - y1), (y1 + y2) / 2 + c * (x2 - x1)];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const off = e.style?.curveOffset as number;
    const g6Control = [
      (x1 + x2) / 2 + (off * (y2 - y1)) / len,
      (y1 + y2) / 2 + (off * -(x2 - x1)) / len,
    ];
    expect(g6Control[0]).toBeCloseTo(sceneControl[0] as number, 9);
    expect(g6Control[1]).toBeCloseTo(sceneControl[1] as number, 9);
  });

  it('shows arrowheads from arrowMinZoom on (evaluated at zoom 1 by toG6Data)', () => {
    const scene = three();
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, { arrow: true, arrowMinZoom: 1.2 });
    frame.edges[1] = edgeVisual(scene, 1, { arrow: false, arrowMinZoom: 0 });
    expect(edge(scene, frame, 'a→b', 1).style?.endArrow).toBe(false);
    expect(edge(scene, frame, 'a→b', 1.2).style?.endArrow).toBe(true);
    expect(edge(scene, frame, 'b→c', 5).style?.endArrow).toBe(false);
    const arrowed = edge(scene, frameOf(scene), 'a→b');
    expect(arrowed.style).toMatchObject({
      endArrow: true,
      endArrowType: 'triangle',
      endArrowSize: [7, 5],
      endArrowOffset: 5,
    });
  });

  it('draws self-loops as straight G6 loops without an arrowhead', () => {
    const scene = miniScene([A], [{ id: 'loop', s: 0, t: 0 }]);
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, { curvature: 0.3 });
    const e = edge(scene, frame, 'loop');
    expect(e).toMatchObject({ source: 'a', target: 'a', type: 'line' });
    expect(e.style).toMatchObject({ endArrow: false, curveOffset: 0, loop: true });
  });

  it('copies dash patterns (butt caps) and adds the flow dash offset', () => {
    const scene = three();
    const frame = frameOf(scene);
    const dash = [4, 3];
    frame.edges[0] = edgeVisual(scene, 0, { dash, dashOffset: 2 });
    const e = edge(scene, frame, 'a→b');
    expect(e.style?.lineDash).toEqual([4, 3]);
    expect(e.style?.lineDash).not.toBe(dash);
    expect(e.style).toMatchObject({ lineCap: 'butt', lineDashOffset: 2 });
  });

  it('draws a partial solid edge with a dash window and hides the arrow until it arrives', () => {
    const scene = three();
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, { progress: 0.5 });
    const e = edge(scene, frame, 'a→b');
    // Path between the outlines: 100 − 6 − 6 = 88.
    expect(e.style?.lineDash).toEqual([44, 1e6]);
    expect(e.style).toMatchObject({ lineDashOffset: 0, endArrow: false });
    frame.edges[0] = edgeVisual(scene, 0, { progress: 0.25, fromTarget: true });
    const back = edge(scene, frame, 'a→b');
    expect(back.style?.lineDash).toEqual([22, 1e6]);
    expect(back.style).toMatchObject({ lineDashOffset: -66, endArrow: true });
  });

  it('fades a partial dashed edge instead, and drops undrawn edges', () => {
    const scene = three();
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, { progress: 0.5, dash: [4, 3], alpha: 0.8 });
    frame.edges[1] = edgeVisual(scene, 1, { progress: 0 });
    expect(edge(scene, frame, 'a→b').style?.opacity).toBeCloseTo(0.4, 9);
    expect(edges(scene, frame).map((e) => e.id)).toEqual(['a→b']);
    const hidden = edges(scene, frame, 1, true).find((e) => e.id === 'b→c');
    expect(hidden?.style?.visibility).toBe('hidden');
  });

  it('attaches retargeted edges to the endpoint the frame draws them at', () => {
    const scene = miniScene([A, B, C], [{ id: 'r', s: 0, t: 1, tb: 2 }]);
    const after = frameOf(scene);
    expect(edge(scene, after, 'r').target).toBe('b');
    const before = frameOf(scene);
    before.edges[0] = edgeVisual(scene, 0, { x2: C.x, y2: C.y });
    expect(edge(scene, before, 'r').target).toBe('c');
  });

  it('omits edges whose endpoint node is not drawn', () => {
    const scene = three();
    const frame = withNode(scene, 1, { visible: false });
    expect(edges(scene, frame)).toEqual([]);
  });

  it('maps edge labels with LOD, strike and text halo', () => {
    const scene = three();
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, {
      alpha: 0.5,
      label: label({ text: '持股', size: 10.5, weight: 400, minZoom: 1.1, offset: 0 }),
    });
    frame.edges[1] = edgeVisual(scene, 1, { label: label({ text: 'old', strike: true }) });
    expect(edge(scene, frame, 'a→b', 1).style).toMatchObject({ label: false, labelText: '持股' });
    expect(edge(scene, frame, 'a→b', 1.1).style).toMatchObject({
      label: true,
      labelFontSize: 10.5,
      labelOpacity: 0.5,
      labelAutoRotate: false,
      labelPlacement: 'center',
      labelOffsetY: 0,
    });
    expect(edge(scene, frame, 'b→c').style?.labelTextDecorationLine).toBe('line-through');
  });

  it('gives every edge the same style keys', () => {
    const scene = three();
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, { dash: [4, 3], label: label(), curvature: 0.2 });
    frame.glyphs = [glyph(scene, 0, 2, { kind: 'suggestion', label: label({ text: '?' }) })];
    const keys = edges(scene, frame).map((e) =>
      Object.keys(e.style ?? {})
        .sort()
        .join(','),
    );
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('glyphs', () => {
  function glyphEdges(scene: Scene, frame: FrameVisuals): EdgeData[] {
    return edges(scene, frame).filter((e) => data(e).kgdiff === 'glyph');
  }

  it('turns arcs into extra edges between the nodes at their endpoints', () => {
    const scene = three();
    const frame = frameOf(scene, { glyphs: [glyph(scene, 2, 0, { curvature: 0.25 })] });
    const [g] = glyphEdges(scene, frame);
    expect(g).toMatchObject({
      id: 'kgdiff-glyph-merge-arrow:["c","a"]',
      source: 'c',
      target: 'a',
      type: 'quadratic',
    });
    expect(g?.style).toMatchObject({
      stroke: '#A78BFA',
      opacity: 0.9,
      lineWidth: 1.5,
      endArrow: true,
      zIndex: 20,
      curveOffset: -0.25 * 80,
    });
    expect(data(g as EdgeData)).toMatchObject({ kgdiff: 'glyph', glyph: 'merge-arrow', index: 0 });
    // Glyph hunk: the source's hunk, else the target's.
    expect(data(g as EdgeData).hunk).toBe(0);
  });

  it('keeps the arrow clear of the target ring (r2 beyond the node radius)', () => {
    const scene = three();
    const frame = frameOf(scene, { glyphs: [glyph(scene, 2, 0, { r2: 6 + 4 })] });
    expect(glyphEdges(scene, frame)[0]?.style?.endArrowOffset).toBe(3.5 + 1.5 + 4);
  });

  it('draws edge ghosts dashed with an arrowhead, keeping their own dash when given', () => {
    const scene = three();
    const frame = frameOf(scene, {
      glyphs: [
        glyph(scene, 0, 1, { kind: 'edge-ghost', curvature: 0 }),
        glyph(scene, 1, 2, { kind: 'edge-ghost', dash: [2, 2], curvature: 0 }),
      ],
    });
    const [a, b] = glyphEdges(scene, frame);
    expect(a?.style).toMatchObject({ lineDash: [4, 3], endArrow: true, lineCap: 'butt' });
    expect(a?.type).toBe('line');
    expect(b?.style?.lineDash).toEqual([2, 2]);
  });

  it('draws suggestions dotted with a ? mark and no arrow', () => {
    const scene = three();
    const g = glyph(scene, 0, 1, {
      kind: 'suggestion',
      curvature: 0.12,
      dash: [1, 3],
      color: '#A78BFA',
      label: label({ text: '?' }),
    });
    const [s] = glyphEdges(scene, frameOf(scene, { glyphs: [g] }));
    expect(s?.style).toMatchObject({
      lineDash: [1, 3],
      // Native rule: round caps only for sub-pixel "dot" dashes.
      lineCap: 'butt',
      endArrow: false,
      label: true,
      labelText: '?',
      labelBackground: true,
      labelBackgroundWidth: 14,
      labelBackgroundHeight: 14,
      labelBackgroundRadius: 7,
      labelBackgroundStroke: '#A78BFA',
    });
    // Too short for the mark: line only.
    const near = miniScene([A, { id: 'n', x: 20, y: 0 }]);
    const [short] = glyphEdges(near, frameOf(near, { glyphs: [{ ...g, x2: 20 }] }));
    expect(short?.style).toMatchObject({ label: false, labelBackground: false });
  });

  it('draws unknown glyph kinds as plain lines, and honours an own arrow flag', () => {
    const scene = three();
    const future = { ...glyph(scene, 0, 1), kind: 'future-kind' } as unknown as GlyphVisual;
    const flagged = { ...glyph(scene, 1, 2, { kind: 'suggestion' }), arrow: true } as GlyphVisual;
    const [a, b] = glyphEdges(scene, frameOf(scene, { glyphs: [future, flagged] }));
    expect(a?.style).toMatchObject({ endArrow: false, lineDash: 0 });
    expect(a?.id).toBe('kgdiff-glyph-future-kind:["a","b"]');
    expect(b?.style?.endArrow).toBe(true);
  });

  it('maps pivots to small non-interactive nodes on their node outline', () => {
    const scene = three();
    const pivot = glyph(scene, 0, 0, {
      kind: 'pivot',
      x1: 6,
      y1: 0,
      x2: 6,
      y2: 0,
      r1: 0,
      r2: 0,
      width: 5,
      color: '#38BDF8',
      alpha: 1,
      curvature: 0,
    });
    const out = nodes(scene, frameOf(scene, { glyphs: [pivot] }));
    const p = out.find((n) => String(n.id).startsWith('kgdiff-glyph-'));
    expect(p).toMatchObject({ id: 'kgdiff-glyph-pivot:["a","a"]' });
    expect(p?.style).toMatchObject({
      x: 6,
      y: 0,
      size: 6.5,
      fill: '#38BDF8',
      stroke: scene.theme.canvas.background,
      lineWidth: 1.5,
      pointerEvents: 'none',
      zIndex: 40,
      label: false,
    });
  });

  it('anchors ends without a drawn node to invisible points, keeping the arc', () => {
    const scene = three();
    // A split target that has not emerged yet: not drawn, its glyph end on its position.
    const toHidden = glyph(scene, 0, 2, { kind: 'split-arrow', curvature: 0, r2: 8 + 4 });
    const nowhere = glyph(scene, 0, 1, { x2: 500, y2: 500 });
    const frame = frameOf(scene, { glyphs: [toHidden, nowhere] });
    frame.nodes[2] = { ...(frame.nodes[2] as NodeVisual), visible: false };
    const out = mapFrame(scene, frame, { idPrefix: 'p/', keepHidden: false, zoom: 1 }).data;
    const anchors = out.nodes.filter((n) => data(n).kgdiff === 'anchor');
    expect(anchors.map((a) => [a.id, a.style?.x, a.style?.y, data(a).index])).toEqual([
      ['p/kgdiff-anchor-"c"', 0, 80, 2],
      ['p/kgdiff-anchor-"@500,500"', 500, 500, -1],
    ]);
    expect(anchors[0]?.style).toMatchObject({ pointerEvents: 'none', lineWidth: 0 });
    expect(anchors[0]?.style?.size as number).toBeLessThan(0.1);
    const [split, far] = out.edges.filter((e) => data(e).kgdiff === 'glyph');
    expect(split).toMatchObject({
      id: 'p/kgdiff-glyph-split-arrow:["a","c"]',
      source: 'p/a',
      target: 'p/kgdiff-anchor-"c"',
    });
    // The arrow stops at the target's ring clearance, measured from the anchor point.
    expect(split?.style?.endArrowOffset).toBe(3.5 + 1.5 + 12);
    expect(far?.target).toBe('p/kgdiff-anchor-"@500,500"');
    // Two arcs to one undrawn node share its anchor.
    const twice = frameOf(scene, { glyphs: [toHidden, glyph(scene, 1, 2, { curvature: 0 })] });
    twice.nodes[2] = { ...(twice.nodes[2] as NodeVisual), visible: false };
    const shared = nodes(scene, twice).filter((n) => data(n).kgdiff === 'anchor');
    expect(shared).toHaveLength(1);
  });

  it('omits glyphs with both ends on one node, or without alpha', () => {
    const scene = three();
    const frame = frameOf(scene, {
      glyphs: [glyph(scene, 0, 0), glyph(scene, 0, 1, { alpha: 0 })],
    });
    expect(glyphEdges(scene, frame)).toEqual([]);
  });

  it('hides the arrow of a glyph still being drawn', () => {
    const scene = three();
    const frame = frameOf(scene, { glyphs: [glyph(scene, 0, 1, { progress: 0.5, curvature: 0 })] });
    const [g] = glyphEdges(scene, frame);
    expect(g?.style).toMatchObject({ endArrow: false, lineDash: [44, 1e6] });
  });

  it('keeps glyph ids unique and stable', () => {
    const scene = three();
    const g = glyph(scene, 0, 1, { kind: 'edge-ghost' });
    const frame = frameOf(scene, { glyphs: [g, { ...g }] });
    expect(glyphEdges(scene, frame).map((e) => e.id)).toEqual([
      'kgdiff-glyph-edge-ghost:["a","b"]',
      'kgdiff-glyph-edge-ghost:["a","b"]#2',
    ]);
  });
});

describe('collapsed groups', () => {
  it('maps pills to point nodes whose label carries the pill', () => {
    const scene = three();
    const frame = frameOf(scene, {
      collapsed: [
        { id: 'near:a', x: 10, y: 20, count: 38, nodes: [], label: '+38 unchanged' },
        { id: 'component:b', x: 0, y: 0, count: 1200, nodes: [], label: '' },
        { id: 'empty', x: 0, y: 0, count: 0, nodes: [], label: 'x' },
      ],
    });
    const pills = nodes(scene, frame).filter((n) => data(n).kgdiff === 'collapsed');
    expect(pills.map((p) => [p.id, p.style?.labelText])).toEqual([
      ['kgdiff-collapsed-near:a', '+38 unchanged'],
      ['kgdiff-collapsed-component:b', '+1,200'],
    ]);
    expect(pills[0]?.style).toMatchObject({
      x: 10,
      y: 20,
      size: 1,
      zIndex: 0,
      labelPlacement: 'center',
      labelBackground: true,
      labelBackgroundFill: scene.theme.surface.raised,
      labelBackgroundStroke: scene.theme.surface.borderStrong,
      labelFill: scene.theme.text.secondary,
      labelFontSize: 11,
    });
  });
});

describe('ids, purity and validation', () => {
  it('prefixes every id and every edge endpoint', () => {
    const scene = three();
    const frame = frameOf(scene, { glyphs: [glyph(scene, 0, 1)] });
    const out = toG6Data(scene, frame, { idPrefix: 'diff/' });
    for (const n of out.nodes ?? []) expect(String(n.id).startsWith('diff/')).toBe(true);
    for (const e of out.edges ?? []) {
      expect(String(e.id).startsWith('diff/')).toBe(true);
      expect(String(e.source).startsWith('diff/')).toBe(true);
      expect(String(e.target).startsWith('diff/')).toBe(true);
    }
  });

  it('is deterministic and never writes to its inputs', () => {
    const scene = three();
    const frame = frameOf(scene, {
      glyphs: [glyph(scene, 0, 1)],
      collapsed: [{ id: 'g', x: 1, y: 1, count: 2, nodes: [], label: '+2' }],
    });
    frame.nodes[0] = nodeVisual(A, {
      label: label(),
      badge: { text: '+1', color: '#fff', background: '#000', minZoom: 0 },
      dash: [3, 2.5],
    });
    const first = toG6Data(scene, frame);
    deepFreeze(frame);
    expect(toG6Data(scene, frame)).toEqual(first);
  });

  it('disambiguates a node and an edge sharing an id', () => {
    const scene = miniScene([A, B], [{ id: 'a', s: 0, t: 1 }]);
    const out = toG6Data(scene, frameOf(scene));
    expect(out.edges?.[0]?.id).toBe('a#2');
  });

  it('rejects a frame resolved for another scene', () => {
    const scene = three();
    const other = miniScene([A]);
    expect(() => toG6Data(scene, frameOf(other))).toThrow(KgdiffError);
    expect(() =>
      toG6Data(scene, frameOf(scene), { idPrefix: 3 as unknown as string }),
    ).toThrowError(/idPrefix/);
  });
});

describe('level of detail', () => {
  it('reports the thresholds present in the frame', () => {
    const scene = three();
    const frame = frameOf(scene);
    frame.nodes[0] = nodeVisual(A, {
      label: label({ minZoom: 0.35 }),
      badge: { text: '+1', color: '#fff', background: '#000', minZoom: 1.2 },
    });
    frame.edges[0] = edgeVisual(scene, 0, { arrowMinZoom: 1.2, label: label({ minZoom: 1.1 }) });
    frame.edges[1] = edgeVisual(scene, 1, { arrow: false, arrowMinZoom: 3 });
    const { lod } = mapFrame(scene, frame, { idPrefix: '', keepHidden: false, zoom: 1 });
    expect(lod).toEqual([0.35, 1.1, 1.2]);
  });

  it('detects threshold crossings in both directions', () => {
    expect(crossesLod([0.35, 1.2], 1, 1.1)).toBe(false);
    expect(crossesLod([0.35, 1.2], 1, 1.2)).toBe(true);
    expect(crossesLod([0.35, 1.2], 1.3, 0.3)).toBe(true);
    expect(crossesLod([], 0.1, 10)).toBe(false);
  });

  it('recognizes its own data and nothing else', () => {
    expect(kgdiffData({ kgdiff: 'node', index: 1 })).not.toBeNull();
    expect(kgdiffData({ kgdiff: 'other' })).toBeNull();
    expect(kgdiffData(null)).toBeNull();
    expect(kgdiffData('node')).toBeNull();
  });
});

describe('edge cases', () => {
  it('maps an empty scene to empty data', () => {
    const scene = miniScene([]);
    expect(toG6Data(scene, frameOf(scene))).toEqual({ nodes: [], edges: [] });
  });

  it('keeps ids with separators, quotes, spaces, IRIs and CJK intact and unambiguous', () => {
    const odd = [
      'http://example.org/a b#c',
      'x|y',
      'say "hi"',
      '企业',
      'kgdiff-glyph-merge-arrow:["a","b"]',
    ];
    const scene = miniScene(
      odd.map((id, i) => ({ id, x: i * 40, y: 0 })),
      [{ id: 'x|y→企业', s: 1, t: 3 }],
    );
    const frame = frameOf(scene, { glyphs: [glyph(scene, 0, 1)] });
    const out = toG6Data(scene, frame);
    const ids = [...(out.nodes ?? []), ...(out.edges ?? [])].map((d) => String(d.id));
    expect(ids.slice(0, odd.length)).toEqual(odd);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.edges?.[0]).toMatchObject({ source: 'x|y', target: '企业' });
    expect(ids.at(-1)).toBe('kgdiff-glyph-merge-arrow:["http://example.org/a b#c","x|y"]');
  });

  it('fans parallel edges with opposite curve offsets', () => {
    const scene = miniScene(
      [A, B],
      [
        { id: 'p1', s: 0, t: 1 },
        { id: 'p2', s: 0, t: 1 },
      ],
    );
    const frame = frameOf(scene);
    frame.edges[0] = edgeVisual(scene, 0, { curvature: 0.18 });
    frame.edges[1] = edgeVisual(scene, 1, { curvature: -0.18 });
    const [p1, p2] = edges(scene, frame);
    expect(p1?.style?.curveOffset).toBeCloseTo(-18, 9);
    expect(p2?.style?.curveOffset).toBeCloseTo(18, 9);
  });

  it('survives non-finite geometry without emitting NaN', () => {
    const scene = three();
    const frame = withNode(scene, 0, { r: Number.NaN, z: Number.NaN, alpha: Number.NaN });
    frame.edges[0] = edgeVisual(scene, 0, { curvature: Number.NaN, width: Number.NaN });
    const out = toG6Data(scene, frame);
    for (const d of [...(out.nodes ?? []), ...(out.edges ?? [])]) {
      for (const v of Object.values(d.style ?? {})) {
        if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false);
      }
    }
  });

  it('maps 5,000 nodes and 10,000 edges', () => {
    const { scene, frame } = largeFrame(5000);
    const out = toG6Data(scene, frame);
    expect(out.nodes).toHaveLength(5000);
    expect(out.edges).toHaveLength(10_000);
  });
});

describe('node shapes', () => {
  it('maps the shape, defaulting to a circle', () => {
    const scene = three();
    expect(node(scene, frameOf(scene), 'a').style?.shape).toBe('circle');
    const square = withNode(scene, 0, { shape: 'square' });
    expect(node(scene, square, 'a').style?.shape).toBe('square');
  });

  it.each(['square', 'diamond', 'hexagon'] as const)(
    '%s: spaces ghost dashes along its outline',
    (shape) => {
      const scene = three();
      const frame = withNode(scene, 0, { shape, fill: null, stroke: '#f00', dash: [3, 2.5] });
      const style = node(scene, frame, 'a').style;
      const dash: number[] = [];
      const offset = evenShapeDash(shape, [3, 2.5], 6, dash);
      expect(style?.lineDash).toEqual(dash);
      expect(style?.lineDashOffset).toBeCloseTo(offset, 9);
    },
  );

  it('leaves the circle ghost as it was', () => {
    const scene = three();
    const frame = withNode(scene, 0, { fill: null, stroke: '#f00', dash: [3, 2.5] });
    const style = node(scene, frame, 'a').style;
    expect(style?.lineDash).toEqual(evenCircleDash([3, 2.5], 6));
    expect(style?.lineDashOffset).toBe(0);
  });

  it('anchors a badge on the outline', () => {
    const scene = three();
    const badge = { text: '+1', color: '#fff', background: '#000', minZoom: 0 };
    const offsets = (shape: 'circle' | 'square' | 'diamond'): number => {
      const style = node(scene, withNode(scene, 0, { r: 20, badge, shape }), 'a').style;
      const badges = (style?.badges ?? []) as { offsetX: number }[];
      return badges[0]?.offsetX ?? Number.NaN;
    };
    // From the key's corner: on the corner for a square, inside the box for a disc or a diamond.
    expect(offsets('square')).toBeCloseTo(-2 + 5, 6);
    expect(offsets('diamond')).toBeLessThan(offsets('circle'));
  });
});
