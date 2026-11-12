import type { EdgeInput, GraphInput } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from '../src/sync.js';

const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
const g = (edges: EdgeInput[], options?: { nodes?: GraphInput['nodes'] }): GraphInput => ({
  nodes: options?.nodes ?? nodes,
  edges,
});
const changed = (d: ReturnType<typeof diff>) => d.edges.filter((e) => e.status !== 'unchanged');
const key = (s: string, p: string, t: string) => JSON.stringify([s, p, t]);

describe('edge pairing', () => {
  it('pairs identical edges, sharing one union id', () => {
    const d = diff(
      g([{ source: 'a', target: 'b', predicate: 'p' }]),
      g([{ source: 'a', target: 'b', predicate: 'p' }]),
    );
    expect(d.edges).toEqual([
      expect.objectContaining({
        id: key('a', 'p', 'b'),
        status: 'unchanged',
        beforeKey: key('a', 'p', 'b'),
        afterKey: key('a', 'p', 'b'),
      }),
    ]);
  });

  it('reports label and attribute changes and updates them in place', () => {
    const d = diff(
      g([{ source: 'a', target: 'b', predicate: 'p', label: 'old', attrs: { w: 1 } }]),
      g([{ source: 'a', target: 'b', predicate: 'p', label: 'new', attrs: { w: 2 } }]),
    );
    expect(d.edges[0]?.facets).toEqual([
      { kind: 'label', from: 'old', to: 'new' },
      { kind: 'attrs', changes: [{ key: 'w', before: 1, after: 2 }] },
    ]);
    expect(d.delta.ops.map((o) => o.op)).toEqual(['edge.set', 'edge.attr']);
  });

  it('pairs a lone predicate change between the same nodes', () => {
    const d = diff(
      g([{ source: 'a', target: 'b', predicate: 'worksFor' }]),
      g([{ source: 'a', target: 'b', predicate: 'employedBy' }]),
    );
    expect(d.edges).toEqual([
      expect.objectContaining({
        id: key('a', 'employedBy', 'b'),
        status: 'modified',
        predicate: 'employedBy',
        predicateBefore: 'worksFor',
        facets: [{ kind: 'predicate', from: 'worksFor', to: 'employedBy' }],
      }),
    ]);
  });

  it('pairs a lone target change as a retarget', () => {
    const d = diff(
      g([{ source: 'a', target: 'b', predicate: 'p' }]),
      g([{ source: 'a', target: 'c', predicate: 'p' }]),
    );
    expect(d.edges).toEqual([
      expect.objectContaining({
        id: key('a', 'p', 'c'),
        target: 'c',
        targetBefore: 'b',
        facets: [{ kind: 'retarget', end: 'target', from: 'b', to: 'c', cause: 'edit' }],
      }),
    ]);
    expect(d.edges[0]?.sourceBefore).toBeUndefined();
  });

  it('pairs a lone source change as a retarget of the source end', () => {
    const d = diff(
      g([{ source: 'a', target: 'b', predicate: 'p' }]),
      g([{ source: 'c', target: 'b', predicate: 'p' }]),
    );
    expect(d.edges[0]).toMatchObject({ source: 'c', sourceBefore: 'a' });
    expect(d.edges[0]?.facets).toEqual([
      { kind: 'retarget', end: 'source', from: 'a', to: 'c', cause: 'edit' },
    ]);
  });

  it('never guesses when a change is ambiguous', () => {
    const d = diff(
      g([
        { source: 'a', target: 'b', predicate: 'p' },
        { source: 'a', target: 'c', predicate: 'p' },
      ]),
      g([{ source: 'a', target: 'd', predicate: 'p' }]),
    );
    expect(
      changed(d)
        .map((e) => e.status)
        .sort(),
    ).toEqual(['added', 'removed', 'removed']);
  });

  it('pairs parallel copies content-first so an untouched copy stays unchanged', () => {
    const copy = (since: number): EdgeInput => ({
      source: 'a',
      target: 'b',
      predicate: 'KNOWS',
      attrs: { since },
    });
    const d = diff(g([copy(2019), copy(2020)]), g([copy(2020)]));
    expect(d.edges.map((e) => [e.id, e.status, e.before?.attrs])).toEqual([
      [key('a', 'KNOWS', 'b'), 'unchanged', { since: 2020 }],
      [`${key('a', 'KNOWS', 'b')}#2`, 'removed', { since: 2019 }],
    ]);
  });

  it('replaces a modified parallel copy instead of updating it in place', () => {
    const copy = (since: number): EdgeInput => ({
      source: 'a',
      target: 'b',
      predicate: 'KNOWS',
      attrs: { since },
    });
    const d = diff(g([copy(1), copy(2)]), g([copy(1), copy(3)]));
    expect(changed(d)).toEqual([
      expect.objectContaining({
        status: 'modified',
        facets: [expect.objectContaining({ kind: 'attrs' })],
      }),
    ]);
    expect(d.delta.ops.map((o) => o.op)).toEqual(['edge.remove', 'edge.add']);
  });

  it('handles self-loops', () => {
    const d = diff(
      g([{ source: 'a', target: 'a', predicate: 'p' }]),
      g([{ source: 'a', target: 'b', predicate: 'p' }]),
    );
    expect(d.edges[0]?.facets).toEqual([
      { kind: 'retarget', end: 'target', from: 'a', to: 'b', cause: 'edit' },
    ]);
  });

  it('computes union edge ids from union node ids', () => {
    const d = diff(
      {
        nodes: [{ id: 'old', label: 'Same' }, { id: 'b' }],
        edges: [{ source: 'old', target: 'b', predicate: 'p' }],
      },
      {
        nodes: [{ id: 'new', label: 'Same' }, { id: 'b' }],
        edges: [{ source: 'new', target: 'b', predicate: 'p' }],
      },
    );
    expect(d.edges).toEqual([
      expect.objectContaining({
        id: key('new', 'p', 'b'),
        status: 'unchanged',
        beforeKey: key('old', 'p', 'b'),
      }),
    ]);
  });

  it('sorts union edges by id', () => {
    const d = diff(
      g([
        { source: 'b', target: 'a' },
        { source: 'a', target: 'b' },
      ]),
      g([{ source: 'c', target: 'a' }]),
    );
    expect(d.edges.map((e) => e.id)).toEqual([...d.edges.map((e) => e.id)].sort());
  });
});

describe('edge pairing under id identity', () => {
  it('pairs edges by id and reports endpoint and predicate changes', () => {
    const d = diff(
      g([{ id: 'e1', source: 'a', target: 'b', predicate: 'p' }]),
      g([{ id: 'e1', source: 'c', target: 'd', predicate: 'q' }]),
      { edgeIdentity: 'id' },
    );
    expect(d.edges).toEqual([
      expect.objectContaining({
        id: 'e1',
        sourceBefore: 'a',
        targetBefore: 'b',
        predicateBefore: 'p',
        facets: [
          { kind: 'retarget', end: 'source', from: 'a', to: 'c', cause: 'edit' },
          { kind: 'retarget', end: 'target', from: 'b', to: 'd', cause: 'edit' },
          { kind: 'predicate', from: 'p', to: 'q' },
        ],
      }),
    ]);
  });

  it('does not pair different ids even when the triple is the same', () => {
    const d = diff(
      g([{ id: 'e1', source: 'a', target: 'b', predicate: 'p' }]),
      g([{ id: 'e2', source: 'a', target: 'b', predicate: 'p' }]),
      { edgeIdentity: 'id' },
    );
    expect(d.edges.map((e) => [e.id, e.status])).toEqual([
      ['e1', 'removed'],
      ['e2', 'added'],
    ]);
  });
});

describe('edges carried by a merge', () => {
  it('turns a carried edge into one modified edge and collapses duplicates', () => {
    const d = diff(
      {
        nodes: [{ id: 'x', label: 'Old' }, { id: 'T', label: 'New' }, { id: 'n' }, { id: 'm' }],
        edges: [
          { source: 'x', target: 'n', predicate: 'p' },
          { source: 'T', target: 'n', predicate: 'p' },
          { source: 'm', target: 'x', predicate: 'q' },
        ],
      },
      {
        nodes: [{ id: 'T', label: 'New', replaces: ['x'] }, { id: 'n' }, { id: 'm' }],
        edges: [
          { source: 'T', target: 'n', predicate: 'p' },
          { source: 'm', target: 'T', predicate: 'q' },
        ],
      },
    );
    expect(changed(d)).toEqual([
      expect.objectContaining({
        id: key('m', 'q', 'T'),
        status: 'modified',
        targetBefore: 'x',
        facets: [{ kind: 'retarget', end: 'target', from: 'x', to: 'T', cause: 'merge' }],
      }),
      expect.objectContaining({
        id: key('x', 'p', 'n'),
        status: 'removed',
        facets: [{ kind: 'collapsed', into: key('T', 'p', 'n') }],
      }),
    ]);
  });
});

describe('source-end retargets', () => {
  it('do not absorb the statements of a removed and an added subject', () => {
    const d = diff(
      {
        nodes: [{ id: 'bird' }, { id: 'dodo' }],
        edges: [{ source: 'dodo', target: 'bird', predicate: 'is_a' }],
      },
      {
        nodes: [{ id: 'bird' }, { id: 'owl' }],
        edges: [{ source: 'owl', target: 'bird', predicate: 'is_a' }],
      },
      { match: { strategy: 'id' } },
    );
    expect(changed(d).map((e) => [e.id, e.status, e.facets])).toEqual([
      [key('dodo', 'is_a', 'bird'), 'removed', []],
      [key('owl', 'is_a', 'bird'), 'added', []],
    ]);
    expect(d.hunks.map((h) => h.id).sort()).toEqual(['add:owl', 'remove:dodo']);
  });

  it('still pair a statement moved between two persisting subjects', () => {
    const d = diff(
      g([{ source: 'a', target: 'b', predicate: 'p' }]),
      g([{ source: 'c', target: 'b', predicate: 'p' }]),
    );
    expect(changed(d)[0]?.facets).toEqual([
      { kind: 'retarget', end: 'source', from: 'a', to: 'c', cause: 'edit' },
    ]);
  });

  it('allow target-end retargets towards added or away from removed nodes', () => {
    const d = diff(
      {
        nodes: [{ id: 's' }, { id: 'old' }],
        edges: [{ source: 's', target: 'old', predicate: 'p' }],
      },
      {
        nodes: [{ id: 's' }, { id: 'new' }],
        edges: [{ source: 's', target: 'new', predicate: 'p' }],
      },
      { match: { strategy: 'id' } },
    );
    expect(changed(d)[0]?.facets).toEqual([
      { kind: 'retarget', end: 'target', from: 'old', to: 'new', cause: 'edit' },
    ]);
  });
});
