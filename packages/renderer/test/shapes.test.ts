import {
  evenShapeDash,
  type FrameVisuals,
  type NodeShape,
  type NodeVisual,
  shapeApothem,
  shapeGauge,
  shapeVertexRadius,
  type Theme,
} from '@kgdiff/scene';
import { describe, expect, it } from 'vitest';
import { darkTheme, lightTheme } from '../dev/theme.js';
import { FrameCache, Interner } from '../src/frame-cache.js';
import { Painter, Resources } from '../src/paint.js';
import { pickAt } from '../src/pick.js';
import { Fonts, TextMeasurer } from '../src/text.js';
import {
  edge,
  frameOf,
  glyph,
  node,
  noSurfaces,
  type Op,
  RecordingContext,
  recordingFactory,
} from './helpers/recording-ctx.js';

const POLYGONS: readonly NodeShape[] = ['square', 'diamond', 'hexagon'];
const SIDES: Readonly<Record<string, number>> = { square: 4, diamond: 4, hexagon: 6 };
const CX = 400;
const CY = 300;

function painted(frame: FrameVisuals, theme: Theme = darkTheme, factory = noSurfaces) {
  const ctx = new RecordingContext();
  const res = new Resources(factory, theme, ctx);
  const painter = new Painter(res);
  const caches = { main: new FrameCache(), before: new FrameCache(), after: new FrameCache() };
  painter.paint(
    { ctx, width: 800, height: 600, dpr: 1 },
    { x: 0, y: 0, k: 1 },
    frame,
    caches,
    1,
    theme,
    false,
  );
  return ctx;
}

/** The subpaths of the path that `at`-th op of `name` drew: their moveTo / lineTo points. */
function pathBefore(ctx: RecordingContext, name: string, at = 0): [number, number][] {
  const end = ctx.ops.indexOf(ctx.calls(name)[at] as Op);
  let start = end;
  while (start > 0 && ctx.ops[start]?.name !== 'beginPath') start--;
  return ctx.ops
    .slice(start, end)
    .filter((o) => o.name === 'moveTo' || o.name === 'lineTo')
    .map((o) => [o.args[0] as number, o.args[1] as number]);
}

/** Every point lies on the outline at size r grown by `grow`, around (CX, CY). */
function expectOnOutline(
  points: readonly [number, number][],
  shape: NodeShape,
  r: number,
  grow: number,
): void {
  expect(points).toHaveLength((SIDES[shape] as number) + 1);
  for (const [x, y] of points) {
    expect(shapeGauge(shape, x - CX, y - CY)).toBeCloseTo(shapeApothem(shape, r) + grow, 6);
  }
}

describe.each(POLYGONS)('%s', (shape) => {
  const R = 12;

  it('draws its outline, no arc', () => {
    const ctx = painted(frameOf([node(0, 0, { r: R, shape, stroke: '#111' })]));
    expect(ctx.count('arc')).toBe(0);
    expect(ctx.count('closePath')).toBe(1);
    expectOnOutline(pathBefore(ctx, 'fill'), shape, R, 0);
  });

  it('spaces the ghost dashes along the outline', () => {
    const f = frameOf([node(0, 0, { r: R, shape, fill: null, stroke: '#f00', dash: [3, 2.5] })]);
    const ctx = painted(f);
    const op = ctx.calls('stroke')[0] as Op;
    const expected: number[] = [];
    const offset = evenShapeDash(shape, [3, 2.5], R, expected);
    expect(op.style.dash).toEqual(expected);
    expect(op.style.lineDashOffset).toBeCloseTo(offset, 9);
    expect(ctx.lineDashOffset).toBe(0);
    expect(ctx.count('arc')).toBe(0);
  });

  it('draws its ring as the outline grown by the gap', () => {
    const ring = { color: '#0f0', width: 1.5, gap: 3.5, alpha: 1 };
    const ctx = painted(frameOf([node(0, 0, { r: R, shape, ring })]));
    const at = ctx.calls('stroke').findIndex((o) => o.style.strokeStyle === '#0f0');
    expectOnOutline(pathBefore(ctx, 'stroke', at), shape, R, 3.5);
  });

  it('grows its outline for the replay pulse', () => {
    const p = 0.5;
    const ctx = painted(frameOf([node(0, 0, { r: R, shape, pulse: p, fill: '#00f' })]));
    const points = pathBefore(ctx, 'stroke', ctx.count('stroke') - 1);
    expectOnOutline(points, shape, R, 3 + p * (12 + R * 0.6));
  });

  it('draws the light halo as the outline at r + 5', () => {
    const halo = { color: '#0a0', radius: R, alpha: 0.35 };
    const ctx = painted(frameOf([node(0, 0, { r: R, shape, halo })]), lightTheme);
    const at = ctx.calls('stroke').findIndex((o) => o.style.strokeStyle === '#0a0');
    expectOnOutline(pathBefore(ctx, 'stroke', at), shape, R, 5);
  });

  it('keeps the dark glow radial', () => {
    const halo = { color: '#0a0', radius: R * 2.6, alpha: 0.32 };
    const { factory } = recordingFactory();
    const ctx = painted(frameOf([node(0, 0, { r: R, shape, halo })]), darkTheme, factory);
    const sprite = ctx.calls('drawImage')[0] as Op;
    expect(sprite.args.slice(1)).toEqual([CX - R * 2.6, CY - R * 2.6, R * 2.6 * 2, R * 2.6 * 2]);
  });

  it.each([
    ['right', 200, 0],
    ['down', 0, 200],
    ['oblique', 200, 90],
    ['the other way', -170, -130],
  ])('stops a straight edge at the outline, heading %s', (_, ox, oy) => {
    const a = node(0, 0, { r: R, shape });
    const b = node(ox, oy, { r: R });
    const f = frameOf([a, b], [edge(a, b, { r1: R, r2: R, shape1: shape, arrow: false })]);
    const ctx = painted(f);
    const [start] = pathBefore(ctx, 'stroke') as [[number, number]];
    expect(shapeGauge(shape, start[0] - CX, start[1] - CY)).toBeCloseTo(shapeApothem(shape, R), 6);
  });

  it('stops the target end, with its arrow gap, at the outline', () => {
    const a = node(-200, 40, { r: R });
    const b = node(0, 0, { r: R, shape });
    const f = frameOf(
      [a, b],
      [edge(a, b, { r1: R, r2: R, shape2: shape, arrow: true, arrowMinZoom: 0 })],
    );
    const ctx = painted(f);
    const fill = ctx.calls('fill').find((o) => o.style.fillStyle === f.edges[0]?.color);
    const tip = ctx.ops[ctx.ops.indexOf(fill as Op) - 4] as Op;
    expect(tip.name).toBe('moveTo');
    const gauge = shapeGauge(shape, (tip.args[0] as number) - CX, (tip.args[1] as number) - CY);
    expect(gauge).toBeGreaterThan(shapeApothem(shape, R));
    expect(gauge).toBeLessThan(shapeApothem(shape, R) + 1.51);
  });

  it('stops a curved edge at the outline', () => {
    const a = node(0, 0, { r: R, shape });
    const b = node(160, 60, { r: R });
    const f = frameOf(
      [a, b],
      [edge(a, b, { r1: R, r2: R, shape1: shape, curvature: 0.18, arrow: false })],
    );
    const ctx = painted(f);
    const [start] = pathBefore(ctx, 'stroke') as [[number, number]];
    expect(shapeGauge(shape, start[0] - CX, start[1] - CY)).toBeCloseTo(shapeApothem(shape, R), 1);
  });

  it('stops a glyph arc at the outline at its size', () => {
    const f = frameOf([node(0, 0, { r: R, shape })], [], {
      glyphs: [
        glyph('merge-arrow', {
          x1: 0,
          y1: 0,
          x2: 150,
          y2: 70,
          r1: R + 4,
          r2: 0,
          shape1: shape,
          curvature: 0,
        }),
      ],
    });
    const ctx = painted(f);
    const [start] = pathBefore(ctx, 'stroke') as [[number, number]];
    expect(shapeGauge(shape, start[0] - CX, start[1] - CY)).toBeCloseTo(
      shapeApothem(shape, R + 4),
      6,
    );
  });

  it('batches: one fill for many nodes of one style', () => {
    const nodes = [node(0, 0, { shape }), node(40, 0, { shape }), node(80, 0, { shape })];
    const ctx = painted(frameOf(nodes));
    expect(ctx.count('fill')).toBe(1);
    expect(ctx.count('closePath')).toBe(3);
  });

  it('draws a square below the tiny radius, like every node', () => {
    const f = frameOf([node(0, 0, { r: 1.1, shape })]);
    const ctx = painted(f);
    expect(ctx.count('rect')).toBe(1);
    expect(ctx.count('closePath')).toBe(0);
  });
});

describe('shapes together', () => {
  it('keys the buckets by shape, so each shape is one fill', () => {
    const shapes: (NodeShape | undefined)[] = [undefined, 'square', 'diamond', 'hexagon'];
    const nodes = [...shapes, ...shapes].map((shape, i) => node(i * 30, 0, shape ? { shape } : {}));
    const cache = new FrameCache();
    cache.sync(frameOf(nodes), 1, new Interner());
    expect(cache.nodeBuckets.map((b) => b.shape)).toEqual(shapes);
    expect(cache.nodeBuckets.map((b) => b.members.length)).toEqual([2, 2, 2, 2]);
  });

  it('draws circle, a missing shape and an unknown one identically', () => {
    const ring = { color: '#0f0', width: 1, gap: 2, alpha: 1 };
    const f = (o: Partial<NodeVisual>): FrameVisuals => {
      const a = node(0, 0, { r: 9, stroke: '#111', ring, ...o });
      const b = node(0, 90, { r: 9, fill: null, stroke: '#f00', dash: [3, 2.5], ...o });
      return frameOf([a, b], [edge(a, b, { r1: 9, r2: 9 })]);
    };
    const none = painted(f({})).ops;
    expect(painted(f({ shape: 'circle' })).ops).toEqual(none);
    expect(painted(f({ shape: 'blob' as NodeShape })).ops).toEqual(none);
  });

  it('anchors a badge on the outline at the upper right', () => {
    const badge = { text: '+1', color: '#fff', background: '#000', minZoom: 0 };
    const at = (shape?: NodeShape): number => {
      const ctx = painted(frameOf([node(0, 0, { r: 20, badge, ...(shape ? { shape } : {}) })]));
      const bg = ctx.calls('arc').find((o) => o.args[2] === 7.5) as Op;
      return bg.args[0] as number;
    };
    // Further out on a square's corner than on the disc, further in on a diamond's side.
    expect(at('square')).toBeGreaterThan(at());
    expect(at('diamond')).toBeLessThan(at());
  });
});

describe('picking shapes', () => {
  const fonts = new Fonts(darkTheme);
  const measurer = new TextMeasurer(new RecordingContext());
  const pick = (frame: FrameVisuals, sx: number, sy: number, k = 1) => {
    const cache = new FrameCache();
    cache.sync(frame, 1, new Interner());
    return pickAt(frame, cache, { k, ox: 400, oy: 300, dpr: 1 }, sx, sy, fonts, measurer);
  };
  const R = 20;
  const NODE = { type: 'node', index: 0 };

  it.each(POLYGONS)('%s: picks at its corners, not beyond the tolerance', (shape) => {
    const f = frameOf([node(0, 0, { r: R, shape })]);
    const radius = shapeVertexRadius(shape, R, 0);
    const angles: Record<string, number[]> = {
      square: [45, 135, 225, 315],
      diamond: [0, 90, 180, 270],
      hexagon: [0, 60, 120, 180, 240, 300],
    };
    for (const a of angles[shape] as number[]) {
      const ux = Math.cos((a * Math.PI) / 180);
      const uy = Math.sin((a * Math.PI) / 180);
      expect(pick(f, 400 + ux * (radius - 1), 300 + uy * (radius - 1))).toEqual(NODE);
      expect(pick(f, 400 + ux * (radius + 9), 300 + uy * (radius + 9))).toBeNull();
    }
  });

  it('a square picks its corner, outside the disc', () => {
    const f = frameOf([node(0, 0, { r: R, shape: 'square' })]);
    const c = shapeApothem('square', R) - 0.5;
    expect(Math.hypot(c, c)).toBeGreaterThan(R + 3);
    expect(pick(f, 400 + c, 300 + c)).toEqual(NODE);
    expect(pick(frameOf([node(0, 0, { r: R })]), 400 + c, 300 + c)).toBeNull();
  });

  it('a diamond does not pick the corner of its box', () => {
    const f = frameOf([node(0, 0, { r: R, shape: 'diamond' })]);
    expect(pick(f, 400 + 14, 300 + 14)).toBeNull();
    expect(pick(frameOf([node(0, 0, { r: R })]), 400 + 14, 300 + 14)).toEqual(NODE);
  });

  it('a hexagon does not pick above its flat top', () => {
    const f = frameOf([node(0, 0, { r: R, shape: 'hexagon' })]);
    expect(pick(f, 400, 300 - shapeApothem('hexagon', R) - 3.5)).toBeNull();
    expect(pick(f, 400, 300 - shapeApothem('hexagon', R) - 2.5)).toEqual(NODE);
  });

  it('keeps the tolerance band around the outline', () => {
    const f = frameOf([node(0, 0, { r: R, shape: 'square' })]);
    const a = shapeApothem('square', R);
    expect(pick(f, 400 + a + 2.5, 300)).toEqual(NODE);
    expect(pick(f, 400 + a + 3.5, 300)).toBeNull();
  });

  it('reaches the tolerance band beyond a diamond tip', () => {
    const f = frameOf([node(0, 0, { r: R, shape: 'diamond' })]);
    expect(pick(f, 400 + R + 4, 300)).toEqual(NODE);
  });

  it('prefers a shape holding the point over a near miss, then higher z', () => {
    const f = frameOf([
      node(0, 0, { r: R, z: 5, shape: 'diamond' }),
      node(26, 0, { r: 10, shape: 'square' }),
    ]);
    // Within the diamond's band only, inside the square.
    expect(pick(f, 400 + 19, 300 + 2)).toEqual({ type: 'node', index: 1 });
    const g = frameOf([
      node(0, 0, { r: R, z: 0, shape: 'square' }),
      node(4, 0, { r: R, z: 2, shape: 'hexagon' }),
    ]);
    expect(pick(g, 402, 300)).toEqual({ type: 'node', index: 1 });
  });
});
