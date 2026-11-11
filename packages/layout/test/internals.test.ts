/**
 * Building blocks: deterministic math, PRNG, packing and overlap removal.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { removeOverlaps } from '../src/forces/collide-rect.js';
import { coolingFactor, log2, powInt, pseudoAngle } from '../src/math.js';
import { defaultIterations } from '../src/options.js';
import { pack } from '../src/pack.js';
import { hashString, mulberry32, randomDirection, seedState } from '../src/prng.js';
import { round2 } from '../src/round.js';
import type { SimNode } from '../src/simulate.js';

describe('deterministic math', () => {
  it('log2 matches Math.log2 to ~1e-14 using exact operations only', () => {
    for (const x of [1, 2, 3, 7.5, 1000, 2001, 1e-3, 123456.789]) {
      expect(log2(x)).toBeCloseTo(Math.log2(x), 12);
    }
    expect(log2(1024)).toBe(10);
    expect(log2(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('coolingFactor solves r^n = ratio', () => {
    for (const n of [1, 120, 300]) {
      expect(powInt(coolingFactor(0.001, n), n)).toBeCloseTo(0.001, 10);
    }
    expect(coolingFactor(0.5, 0)).toBe(1);
  });

  it('round2 rounds to 0.01 without negative zero', () => {
    expect(round2(1.005)).toBe(1);
    expect(round2(-0.004)).toBe(0);
    expect(Object.is(round2(-0.004), 0)).toBe(true);
    expect(round2(12.345678)).toBe(12.35);
  });

  it('pseudoAngle orders directions like atan2', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (ax, ay, bx, by) => {
          fc.pre(Math.abs(ax) + Math.abs(ay) > 1e-6 && Math.abs(bx) + Math.abs(by) > 1e-6);
          const angle = (x: number, y: number) => (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
          // Skip the wrap-around at angle 0 / 2π, where float rounding of atan2 + 2π is lossy.
          const near0 = (t: number) => t < 1e-9 || t > 2 * Math.PI - 1e-9;
          fc.pre(!near0(angle(ax, ay)) && !near0(angle(bx, by)));
          const da = angle(ax, ay) - angle(bx, by);
          const dp = pseudoAngle(ax, ay) - pseudoAngle(bx, by);
          return Math.abs(da) < 1e-9 || Math.sign(da) === Math.sign(dp);
        },
      ),
    );
  });
});

describe('defaultIterations', () => {
  it('follows the spec up to 2000 nodes, then holds the work of a 2000-node run', () => {
    expect(defaultIterations(1)).toBe(300);
    expect(defaultIterations(64)).toBe(150);
    expect(defaultIterations(2000)).toBe(120);
    expect(defaultIterations(2001)).toBe(120);
    expect(defaultIterations(5000)).toBe(48);
    expect(defaultIterations(10_000)).toBe(30);
    expect(defaultIterations(1_000_000)).toBe(30);
  });
});

describe('seeded randomness', () => {
  it('mulberry32 is reproducible and uniform enough', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it('hashes ids and seeds deterministically', () => {
    expect(hashString('node')).toBe(hashString('node'));
    expect(hashString('node', 1)).not.toBe(hashString('node', 2));
    expect(seedState(1)).toBe(1);
    expect(seedState(-1)).toBe(4294967295);
    expect(seedState(0.5)).toBe(seedState(0.5));
  });

  it('randomDirection returns unit vectors', () => {
    const random = mulberry32(3);
    for (let i = 0; i < 100; i++) {
      const d = randomDirection(random);
      expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 12);
    }
  });
});

describe('pack', () => {
  const overlap = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('places component boxes without overlap, keeping the gap, near 16:10', () => {
    const random = mulberry32(9);
    const sizes = Array.from({ length: 40 }, () => ({
      width: 40 + random() * 300,
      height: 30 + random() * 200,
    }));
    const gap = 20;
    const result = pack({
      components: sizes,
      isolated: [],
      componentGap: gap,
      gridGapX: 0,
      gridGapY: 0,
    });
    const boxes = sizes.map((s, i) => ({
      x: result.components[i]!.x,
      y: result.components[i]!.y,
      w: s.width + gap,
      h: s.height + gap,
    }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
    }
    expect(result.width / result.height).toBeGreaterThan(1.1);
    expect(result.width / result.height).toBeLessThan(2.4);
  });

  it('lays isolated nodes out as an aligned table below the components', () => {
    const isolated = Array.from({ length: 30 }, (_, i) => ({
      halfWidth: 20 + (i % 5) * 10,
      top: -4,
      bottom: 24,
    }));
    const result = pack({
      components: [{ width: 300, height: 200 }],
      isolated,
      componentGap: 50,
      gridGapX: 18,
      gridGapY: 12,
    });
    const rows = new Set(result.isolated.map((p) => p.y));
    const cols = new Set(result.isolated.map((p) => p.x));
    expect(rows.size * cols.size).toBeGreaterThanOrEqual(30);
    for (const p of result.isolated) expect(p.y).toBeGreaterThan(200 + 50);
  });

  it('handles nothing to pack', () => {
    expect(
      pack({ components: [], isolated: [], componentGap: 1, gridGapX: 1, gridGapY: 1 }),
    ).toEqual({
      components: [],
      isolated: [],
      width: 0,
      height: 0,
    });
  });
});

describe('removeOverlaps', () => {
  const boxes = (n: number, invMass = 1) => ({
    halfWidth: new Float64Array(n).fill(30),
    halfHeight: new Float64Array(n).fill(10),
    offsetY: new Float64Array(n).fill(5),
    invMass: new Float64Array(n).fill(invMass),
  });

  it('separates a dense jam of boxes completely', () => {
    const random = mulberry32(5);
    const nodes: SimNode[] = Array.from({ length: 200 }, (_, index) => ({
      index,
      x: random() * 100,
      y: random() * 100,
      vx: 0,
      vy: 0,
    }));
    const b = boxes(200);
    removeOverlaps(nodes, b, 2, 400);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = Math.abs(nodes[i]!.x - nodes[j]!.x);
        const dy = Math.abs(nodes[i]!.y - nodes[j]!.y);
        expect(dx >= 62 - 1e-9 || dy >= 22 - 1e-9).toBe(true);
      }
    }
  });

  it('never moves immovable nodes and separates coincident ones deterministically', () => {
    const nodes: SimNode[] = [
      { index: 0, x: 0, y: 0, vx: 0, vy: 0 },
      { index: 1, x: 0, y: 0, vx: 0, vy: 0 },
      { index: 2, x: 0, y: 0, vx: 0, vy: 0 },
    ];
    const b = boxes(3);
    b.invMass[0] = 0;
    removeOverlaps(nodes, b, 2, 100);
    expect(nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(nodes[1]!.x !== 0 || nodes[1]!.y !== 0).toBe(true);
    expect(nodes[2]!.x !== nodes[1]!.x || nodes[2]!.y !== nodes[1]!.y).toBe(true);
  });
});
