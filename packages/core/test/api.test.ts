import * as core from '@kgdiff/core';
import { DEFAULT_HIERARCHY_PREDICATES, type GraphInput, KgdiffError } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from './support/engine.js';
import { enterpriseAfter, enterpriseBefore } from './support/fixtures.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('public API', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(Object.keys(core).sort()).toEqual([
      'DEFAULT_HIERARCHY_PREDICATES',
      'FORMAT_EXTENSIONS',
      'KgdiffError',
      'applyDelta',
      'compactIri',
      'detectFormat',
      'diff',
      'diffFromJSON',
      'diffToJSON',
      'facetLabel',
      'formatHunk',
      'graphToJSON',
      'hashGraph',
      'invertDelta',
      'isKGraph',
      'matchNodes',
      'normalize',
      'packDiffJSON',
      'parseGraph',
      'predicateLabel',
      'resolveOptions',
      'textSimilarity',
      'unpackDiffJSON',
    ]);
    expect(DEFAULT_HIERARCHY_PREDICATES.length).toBeGreaterThan(0);
  });

  it('throws KgdiffError, a real Error with a stable code', () => {
    try {
      diff({ nodes: 'nope' } as unknown as GraphInput, { nodes: [], edges: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(KgdiffError);
      expect(error).toMatchObject({ name: 'KgdiffError', code: 'invalid-input' });
    }
  });

  it('never mutates its inputs', () => {
    const before = deepFreeze(structuredClone(enterpriseBefore));
    const after = deepFreeze(structuredClone(enterpriseAfter('heuristic')));
    const snapshot = JSON.stringify([before, after]);
    const d = diff(before, after);
    expect(JSON.stringify([before, after])).toBe(snapshot);
    // Results can be frozen too and still be serialized and re-applied.
    deepFreeze(d.nodes);
    deepFreeze(d.edges);
    deepFreeze(d.hunks);
    deepFreeze(d.delta);
    expect(() => core.diffToJSON(d)).not.toThrow();
    expect(core.hashGraph(core.applyDelta(d.before, d.delta))).toBe(core.hashGraph(d.after));
  });

  it('accepts normalized graphs and keeps their edge identity', () => {
    const a = core.normalize(
      { nodes: [{ id: 'a' }], edges: [{ id: 'e', source: 'a', target: 'a', predicate: 'p' }] },
      { edgeIdentity: 'id' },
    );
    const b = core.normalize(
      { nodes: [{ id: 'a' }], edges: [{ id: 'e', source: 'a', target: 'a', predicate: 'q' }] },
      { edgeIdentity: 'id' },
    );
    const d = diff(a, b);
    expect(d.options.edgeIdentity).toBe('id');
    expect(d.edges.map((e) => [e.id, e.status])).toEqual([['e', 'modified']]);
    expect(diff(a, b, { edgeIdentity: 'structure' }).edges.map((e) => [e.id, e.status])).toEqual([
      [JSON.stringify(['a', 'q', 'a']), 'modified'],
    ]);
  });

  it('diffs empty graphs', () => {
    const d = diff({ nodes: [], edges: [] }, { nodes: [], edges: [] });
    expect(d.nodes).toEqual([]);
    expect(d.stats.identical).toBe(true);
    expect(d.stats.byType).toEqual([]);
    expect(d.delta.ops).toEqual([]);
  });

  it('reports statistics per status, facet, hunk kind and type', () => {
    const d = diff(enterpriseBefore, enterpriseAfter('hint'));
    expect(d.stats).toMatchObject({
      nodes: { added: 1, removed: 2, modified: 3, unchanged: 3 },
      edges: { added: 2, removed: 2, modified: 2, unchanged: 3 },
      before: { nodes: 8, edges: 7 },
      after: { nodes: 7, edges: 7 },
      hunks: { add: 1, remove: 1, merge: 1, split: 0, modify: 2, relations: 1 },
      identical: false,
    });
    expect(d.stats.facets).toMatchObject({
      mergedInto: 1,
      mergeTarget: 1,
      replacement: 1,
      rename: 1,
      attrs: 1,
      retarget: 2,
      collapsed: 1,
      move: 0,
    });
    expect(Object.keys(d.stats.facets)).toHaveLength(16);
    expect(d.stats.byType[0]).toEqual({
      type: 'Role',
      added: 1,
      removed: 1,
      modified: 1,
      unchanged: 1,
    });
  });
});
