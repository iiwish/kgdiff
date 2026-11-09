import { KgdiffError } from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  extendLayout,
  type LayoutJSON,
  type LayoutJSONV1,
  type LayoutJSONV2,
  layoutDiff,
  layoutFromJSON,
  layoutToJSON,
} from '../src/index.js';
import { makeDiff } from './support/diff-builder.js';
import { changes, components } from './support/fixtures.js';

describe('layoutToJSON / layoutFromJSON', () => {
  const layout = layoutDiff(makeDiff(changes()), { scope: 'changes' });
  const json = layoutToJSON(layout);

  it('emits a versioned document without timing information', () => {
    expect(json.format).toBe('kgdiff.layout');
    expect(json.version).toBe(1);
    expect(json.strategy).toBe(layout.stats.strategy);
    expect(json.scope).toBe('changes');
    expect(json.iterations).toBe(layout.stats.iterations);
    expect(JSON.stringify(json)).not.toContain('"ms"');
    expect(Object.keys(json.positions)).toHaveLength(layout.positions.size);
    expect(Object.keys(json.hidden)).toHaveLength(layout.hidden.size);
  });

  it('rounds coordinates and radii to 0.01', () => {
    for (const [x, y] of Object.values(json.positions)) {
      expect(Math.round(x * 100) / 100).toBe(x);
      expect(Math.round(y * 100) / 100).toBe(y);
    }
    for (const r of Object.values(json.radii)) expect(Math.round(r * 100) / 100).toBe(r);
  });

  it('round-trips: toJSON(fromJSON(json)) equals json, also through text', () => {
    const text = JSON.stringify(json);
    const back = layoutFromJSON(JSON.parse(text) as LayoutJSON);
    expect(JSON.stringify(layoutToJSON(back))).toBe(text);
    expect(back.stats.ms).toBe(0);
    expect(back.stats.nodes).toBe(layout.positions.size);
    for (const [id, p] of layout.positions) {
      expect(back.positions.get(id)!.x).toBeCloseTo(p.x, 2);
      expect(back.positions.get(id)!.y).toBeCloseTo(p.y, 2);
    }
    expect(back.components.map((c) => c.nodes)).toEqual(layout.components.map((c) => c.nodes));
  });

  it('is independent of map insertion order', () => {
    const shuffledLayout = {
      ...layout,
      positions: new Map([...layout.positions].reverse()),
      radii: new Map([...layout.radii].reverse()),
      hidden: new Map([...layout.hidden].reverse()),
    };
    expect(JSON.stringify(layoutToJSON(shuffledLayout))).toBe(JSON.stringify(json));
  });

  it('keeps awkward ids as plain data', () => {
    const ids = [
      '__proto__',
      'constructor',
      '0',
      '10',
      '2',
      'a"b',
      'x|y',
      'http://e.org/a#b',
      '中文',
    ];
    const diff = makeDiff({ nodes: ids.map((id) => ({ id })), edges: [] });
    const out = layoutToJSON(layoutDiff(diff));
    expect(Object.keys(out.positions).sort()).toEqual([...ids].sort());
    expect(Object.getPrototypeOf(out.positions)).toBe(Object.prototype);
    const back = layoutFromJSON(JSON.parse(JSON.stringify(out)) as LayoutJSON);
    expect([...back.positions.keys()]).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
  });

  it('property: round trip is idempotent for any seed', () => {
    const diff = makeDiff(components(6, 4));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (seed) => {
        const once = layoutToJSON(layoutDiff(diff, { seed, iterations: 30 }));
        const twice = layoutToJSON(layoutFromJSON(once));
        return JSON.stringify(once) === JSON.stringify(twice);
      }),
      { numRuns: 15 },
    );
  });

  it('rejects other documents and versions', () => {
    const expectCode = (value: unknown, code: string): void => {
      try {
        layoutFromJSON(value as LayoutJSON);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(KgdiffError);
        expect((error as KgdiffError).code).toBe(code);
      }
    };
    expectCode(null, 'invalid-input');
    expectCode({ ...json, format: 'kgdiff.diff' }, 'invalid-input');
    expectCode({ ...json, version: 3 }, 'unsupported-version');
    expectCode({ ...json, strategy: 'random' }, 'invalid-input');
    expectCode({ ...json, positions: { a: [1] } }, 'invalid-input');
    expectCode({ ...json, positions: { a: [1, 'x'] } }, 'invalid-input');
    expectCode({ ...json, radii: { a: null } }, 'invalid-input');
    expectCode({ ...json, bounds: { x: 0 } }, 'invalid-input');
    expectCode({ ...json, components: [{ nodes: [1], bounds: json.bounds }] }, 'invalid-input');
  });
});

describe('layout documents, version 2', () => {
  const diff = makeDiff(changes());
  const layout = layoutDiff(diff, { scope: 'changes' });
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  // Another engine's positions for the same scope (what the Rust layout writes): moved, and still
  // rounded to 0.01.
  const v1: LayoutJSONV1 = (() => {
    const json = layoutToJSON(layout);
    if (json.version !== 1) throw new Error('layoutDiff writes version 1');
    const positions = Object.fromEntries(
      Object.entries(json.positions).map(([id, [x, y]]) => [
        id,
        [round2(x * 1.25 + 3.17), round2(-y)] as const,
      ]),
    );
    return { ...json, positions };
  })();
  const { version: _, ...members } = v1;
  const v2: LayoutJSONV2 = { ...members, version: 2, generator: 'kgdiff-layout/1' };

  it('reads version 2 like version 1, and keeps its generator', () => {
    const fromV1 = layoutFromJSON(v1);
    const fromV2 = layoutFromJSON(JSON.parse(JSON.stringify(v2)) as LayoutJSON);
    expect(fromV2.generator).toBe('kgdiff-layout/1');
    expect('generator' in fromV1).toBe(false);
    const { generator, ...rest } = fromV2;
    expect(rest).toEqual(fromV1);
    expect(Object.isFrozen(fromV2)).toBe(true);
    for (const [id, [x, y]] of Object.entries(v2.positions)) {
      expect(fromV2.positions.get(id)).toEqual({ x, y });
    }
  });

  it('writes what it read from version 2 back as version 2, with its generator (D-3)', () => {
    const out = layoutToJSON(layoutFromJSON(v2));
    expect(out).toEqual(v2);
    // In the member order of kgdiff-layout's layout_to_json: format, version, generator, …
    const { format, ...rest } = members;
    const canonical = { format, version: 2, generator: 'kgdiff-layout/1', ...rest };
    expect(JSON.stringify(out)).toBe(JSON.stringify(canonical));
    expect(JSON.stringify(layoutToJSON(layoutFromJSON(out)))).toBe(JSON.stringify(out));
  });

  it('writes its own layouts as version 1', () => {
    expect(layoutToJSON(layoutDiff(diff)).version).toBe(1);
    const read = layoutFromJSON(v2);
    const outside = diff.nodes.map((n) => n.id).filter((id) => !read.positions.has(id));
    const extended = layoutToJSON(extendLayout(diff, read, outside.slice(0, 1)));
    expect(extended.version).toBe(1);
    expect(JSON.stringify(extended)).not.toContain('generator');
  });

  it('ignores a generator in a version 1 document', () => {
    const stray = { ...v1, generator: 'kgdiff-layout/1' } as LayoutJSON;
    const back = layoutFromJSON(stray);
    expect('generator' in back).toBe(false);
    expect(JSON.stringify(layoutToJSON(back))).toBe(JSON.stringify(v1));
  });

  it('positions read from version 2 are pins: anchored layouts keep them exactly', () => {
    const read = layoutFromJSON(v2);
    const anchored = layoutDiff(diff, { scope: 'changes', pinned: read.positions });
    expect(anchored.stats.strategy).toBe('anchored');
    for (const [id, p] of read.positions) expect(anchored.positions.get(id)).toEqual(p);
    expect(anchored.generator).toBeUndefined();
  });

  it('extendLayout keeps every position read from version 2, and the generator only when it adds nothing', () => {
    const read = layoutFromJSON(v2);
    const outside = diff.nodes.map((n) => n.id).filter((id) => !read.positions.has(id));
    expect(outside.length).toBeGreaterThan(0);
    const extended = extendLayout(diff, read, outside.slice(0, 3));
    for (const [id, p] of read.positions) expect(extended.positions.get(id)).toBe(p);
    expect(extended.positions.size).toBe(read.positions.size + 3);
    expect(extended.generator).toBeUndefined();
    expect(extendLayout(diff, read, [...read.positions.keys()].slice(0, 2))).toBe(read);
  });

  it('rejects a version 2 document without a generator, and versions other than 1 and 2', () => {
    for (const generator of [undefined, '', 1, null, ['kgdiff-layout/1']]) {
      const doc = { ...v2, generator } as unknown as LayoutJSON;
      expect(() => layoutFromJSON(doc)).toThrow(/generator must be a non-empty string/);
      expect(() => layoutFromJSON(doc)).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    }
    for (const version of [3, 0, '2', 1.5, undefined]) {
      const doc = { ...v2, version } as unknown as LayoutJSON;
      expect(() => layoutFromJSON(doc)).toThrow(
        expect.objectContaining({
          code: 'unsupported-version',
          message: `Unsupported kgdiff.layout version ${String(version)}`,
          details: { version },
        }),
      );
    }
  });
});
