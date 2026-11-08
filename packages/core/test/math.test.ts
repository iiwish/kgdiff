import { log2 } from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/** Distance from log₂(x) as the engine computes it, relative once |log₂(x)| > 1. */
const error = (x: number): number =>
  Math.abs(log2(x) - Math.log2(x)) / Math.max(1, Math.abs(Math.log2(x)));

describe('log2', () => {
  it('is exact on powers of two, subnormals and the largest exponent included', () => {
    for (let k = -1074; k <= 1023; k++) expect(log2(2 ** k)).toBe(k);
  });

  it('maps the rest of the domain like Math.log2', () => {
    for (const x of [0, -0, -1, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(log2(x)).toBe(Number.NEGATIVE_INFINITY);
    }
    expect(log2(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(log2(Number.MAX_VALUE)).toBe(1024);
  });

  it('stays within 1e-15 of the true value', () => {
    for (const x of [3, 7.5, 1000, 2001, 1e-3, 123456.789, 1 + 2 ** -52, 2 - 2 ** -52]) {
      expect(error(x)).toBeLessThan(1e-15);
    }
    fc.assert(
      fc.property(
        fc.double({ min: Number.MIN_VALUE, noNaN: true, noDefaultInfinity: true }),
        (x) => error(x) < 1e-15,
      ),
    );
  });

  it('is increasing on the integers matching and the layout pass', () => {
    let firstNotIncreasing: number | undefined;
    for (let n = 2; n <= 2 ** 20 && firstNotIncreasing === undefined; n++) {
      if (!(log2(n) > log2(n - 1))) firstNotIncreasing = n;
    }
    expect(firstNotIncreasing).toBeUndefined();
  });

  it('gives the bits the conformance corpus pins, where V8 rounds Math.log2 the other way', () => {
    // conformance/primitives/log2.json pins every integer up to 2²².
    const bits = (x: number): string => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, x);
      return view.getBigUint64(0).toString(16).padStart(16, '0');
    };
    expect(bits(log2(3))).toBe('3ff95c01a39fbd69');
    expect(bits(log2(7))).toBe('400675767f54042c');
  });
});
