/**
 * The packed transport of reports (`packDiffJSON` / `unpackDiffJSON`): lossless, deterministic,
 * and only packing what unpacks exactly.
 */
import {
  type DiffJSON,
  type DiffOptions,
  diff,
  diffFromJSON,
  diffToJSON,
  type PackedDiffJSON,
  packDiffJSON,
  unpackDiffJSON,
} from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { versionPairArb } from './support/arbitraries.js';
import {
  enterpriseAfter,
  enterpriseBefore,
  oboAfter,
  oboBefore,
  taxonomyAfter,
  taxonomyBefore,
} from './support/fixtures.js';
import { editGraph, syntheticGraph } from './support/synthetic.js';

/** Packs, goes through JSON text as a report does, and unpacks. */
const roundTrip = (json: DiffJSON): DiffJSON =>
  unpackDiffJSON(JSON.parse(JSON.stringify(packDiffJSON(json))) as PackedDiffJSON);

describe('packDiffJSON / unpackDiffJSON', () => {
  it.each([
    ['an enterprise graph (hints)', enterpriseBefore, enterpriseAfter('hint')],
    ['an enterprise graph (heuristics)', enterpriseBefore, enterpriseAfter('heuristic')],
    ['an ontology', oboBefore, oboAfter],
    ['a taxonomy', taxonomyBefore, taxonomyAfter],
  ])('round-trips %s byte for byte', (_name, before, after) => {
    const json = diffToJSON(diff(before, after));
    expect(JSON.stringify(roundTrip(json))).toBe(JSON.stringify(json));
  });

  it('round-trips random diffs byte for byte, under every edge identity and strategy', () => {
    const options = fc.constantFrom<DiffOptions | undefined>(
      undefined,
      { edgeIdentity: 'id' },
      { match: { strategy: 'similarity' } },
    );
    fc.assert(
      fc.property(versionPairArb(), options, ([before, after], opts) => {
        const json = diffToJSON(diff(before, after, opts));
        expect(JSON.stringify(roundTrip(json))).toBe(JSON.stringify(json));
      }),
      { numRuns: 200 },
    );
  });

  it('packs the unchanged elements and keeps the changed ones as they are', () => {
    const before = syntheticGraph(2_000, 6_000);
    const json = diffToJSON(diff(before, editGraph(before)));
    const packed = packDiffJSON(json);
    const unchanged = (list: readonly { status: string }[]) =>
      list.filter((x) => x.status === 'unchanged').length;
    expect(packed.unchangedNodes.length / 2).toBe(unchanged(json.nodes));
    expect(packed.unchangedEdges.length / 3).toBe(unchanged(json.edges));
    expect(packed.nodes.every((n) => n.status !== 'unchanged')).toBe(true);
    expect(new Set(packed.strings).size).toBe(packed.strings.length);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(json).length / 3);
    // What a report's viewer reads: the same diff.
    expect(diffFromJSON(unpackDiffJSON(packed)).nodes).toEqual(diffFromJSON(json).nodes);
  });

  it('is deterministic', () => {
    const json = diffToJSON(diff(enterpriseBefore, enterpriseAfter('hint')));
    expect(JSON.stringify(packDiffJSON(json))).toBe(JSON.stringify(packDiffJSON(json)));
  });

  it('leaves a document whose elements are not sorted by id unpacked', () => {
    const json = diffToJSON(diff(taxonomyBefore, taxonomyAfter));
    const shuffled = { ...json, nodes: [...json.nodes].reverse() };
    const packed = packDiffJSON(shuffled);
    expect(packed.unchangedNodes).toEqual([]);
    expect(packed.unchangedEdges).toEqual([]);
    expect(roundTrip(shuffled)).toEqual(shuffled);
  });

  it('rejects other formats and malformed tables', () => {
    const packed = packDiffJSON(diffToJSON(diff(taxonomyBefore, taxonomyAfter)));
    const damaged = (patch: Record<string, unknown>) =>
      ({ ...packed, ...patch }) as unknown as PackedDiffJSON;
    expect(() => unpackDiffJSON(damaged({ format: 'kgdiff.diff' }))).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    );
    expect(() => unpackDiffJSON(damaged({ version: 2 }))).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    );
    for (const [patch, message] of [
      [{ strings: [1] }, /strings must be a list of strings/],
      [{ unchangedNodes: [0] }, /pairs/],
      [{ unchangedEdges: [0, 0] }, /triples/],
      [{ unchangedEdges: [0, 0, packed.strings.length] }, /is not an index into strings/],
      [{ unchangedNodes: [0, 'x'] }, /is not a snapshot/],
      [{ unchangedNodes: [0, { id: 'other' }] }, /is not a snapshot without an id/],
    ] as const) {
      expect(() => unpackDiffJSON(damaged(patch))).toThrowError(
        expect.objectContaining({ code: 'invalid-input', message: expect.stringMatching(message) }),
      );
    }
  });
});
