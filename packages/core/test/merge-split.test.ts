import type { DiffOptions, GraphInput } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from '../src/sync.js';

const facetsOf = (d: ReturnType<typeof diff>, id: string) => d.index.node(id)?.facets ?? [];
const kinds = (d: ReturnType<typeof diff>, id: string) => facetsOf(d, id).map((f) => f.kind);

const before: GraphInput = {
  nodes: [
    { id: 'x', label: 'Old Name' },
    { id: 'T', label: 'Target' },
    { id: 'n', label: 'Neighbour' },
  ],
  edges: [
    { source: 'x', target: 'n', predicate: 'p' },
    { source: 'n', target: 'x', predicate: 'q' },
  ],
};

describe('merges: hints', () => {
  it('reads replacedBy on a node that disappears', () => {
    const b: GraphInput = {
      ...before,
      nodes: before.nodes.map((n) => (n.id === 'x' ? { ...n, replacedBy: ['T'] } : n)),
    };
    const a: GraphInput = {
      nodes: [
        { id: 'T', label: 'Target' },
        { id: 'n', label: 'Neighbour' },
      ],
      edges: [
        { source: 'T', target: 'n', predicate: 'p' },
        { source: 'n', target: 'T', predicate: 'q' },
      ],
    };
    const d = diff(b, a);
    expect(d.index.node('x')).toMatchObject({ status: 'removed' });
    expect(facetsOf(d, 'x')).toEqual([
      { kind: 'mergedInto', target: 'T', confidence: 1, via: 'hint' },
    ]);
    expect(facetsOf(d, 'T')).toEqual([{ kind: 'mergeTarget', sources: ['x'] }]);
    expect(d.hunks.map((h) => h.id)).toEqual(['merge:T']);
    expect(d.hunks[0]?.edges).toHaveLength(2);
  });

  it('reads replaces on the target', () => {
    const a: GraphInput = {
      nodes: [
        { id: 'T', label: 'Target', replaces: ['x'] },
        { id: 'n', label: 'Neighbour' },
      ],
      edges: [],
    };
    expect(kinds(diff(before, a), 'x')).toEqual(['mergedInto']);
  });

  it('keeps a deprecated source as modified and reports the deprecation', () => {
    const a: GraphInput = {
      nodes: [
        { id: 'x', label: 'Old Name', deprecated: true, replacedBy: ['T'] },
        { id: 'T', label: 'Target' },
        { id: 'n', label: 'Neighbour' },
      ],
      edges: before.edges,
    };
    const d = diff(before, a);
    expect(d.index.node('x')?.status).toBe('modified');
    expect(kinds(d, 'x')).toEqual(['mergedInto', 'deprecate', 'replacement']);
  });

  it('ignores replacement hints that were already present before', () => {
    const deprecated = { id: 'x', label: 'Old Name', deprecated: true, replacedBy: ['T'] };
    const b: GraphInput = {
      ...before,
      nodes: [deprecated, { id: 'T', label: 'Target' }, { id: 'n', label: 'Neighbour' }],
    };
    const d = diff(b, b);
    expect(d.stats.identical).toBe(true);
    const a: GraphInput = {
      ...b,
      nodes: [{ ...deprecated, label: 'obsolete Old Name' }, ...b.nodes.slice(1)],
    };
    expect(kinds(diff(b, a), 'x')).toEqual(['rename']);
  });

  it('merges several sources into a new node', () => {
    const a: GraphInput = {
      nodes: [
        { id: 'U', label: 'Union', replaces: ['x', 'T'] },
        { id: 'n', label: 'Neighbour' },
      ],
      edges: [],
    };
    const d = diff(before, a);
    expect(d.index.node('U')).toMatchObject({
      status: 'added',
      facets: [{ kind: 'mergeTarget', sources: ['T', 'x'] }],
    });
    expect(d.hunks.map((h) => h.kind)).toEqual(['merge']);
  });

  it('does not call a one-to-one replacement by a new node a merge', () => {
    const a: GraphInput = {
      nodes: [
        { id: 'U', label: 'Union', replaces: ['x'] },
        { id: 'T', label: 'Target' },
        { id: 'n', label: 'Neighbour' },
      ],
      edges: [],
    };
    const d = diff(before, a);
    expect(d.stats.facets.mergedInto).toBe(0);
    expect(d.stats.facets.splitInto).toBe(0);
  });

  it('can be switched off', () => {
    const a: GraphInput = {
      nodes: [
        { id: 'T', label: 'Target', replaces: ['x'] },
        { id: 'n', label: 'Neighbour' },
      ],
      edges: [],
    };
    expect(diff(before, a, { detectMerges: false }).stats.facets.mergedInto).toBe(0);
  });
});

describe('merges: heuristic', () => {
  const graphs = (synonym: string, carried: number): [GraphInput, GraphInput] => {
    const neighbours = ['n1', 'n2', 'n3', 'n4'];
    const b: GraphInput = {
      nodes: [
        { id: 'x', label: 'Alpha Beta Gamma Delta' },
        { id: 'T', label: 'Target' },
        ...neighbours.map((id) => ({ id })),
      ],
      edges: neighbours.map((id) => ({ source: 'x', target: id, predicate: 'p' })),
    };
    const a: GraphInput = {
      nodes: [
        { id: 'T', label: 'Target', aliases: [synonym] },
        ...neighbours.map((id) => ({ id })),
      ],
      edges: neighbours
        .slice(0, carried)
        .map((id) => ({ source: 'T', target: id, predicate: 'p' })),
    };
    return [b, a];
  };

  it('accepts a new synonym plus carried edges', () => {
    const d = diff(...graphs('Alpha Beta Gamma Delta', 4));
    expect(facetsOf(d, 'x')).toEqual([
      { kind: 'mergedInto', target: 'T', confidence: 1, via: 'heuristic' },
    ]);
    expect(
      d.edges.filter((e) => e.facets.some((f) => f.kind === 'retarget' && f.cause === 'merge')),
    ).toHaveLength(4);
  });

  it('requires at least half of the edges to be carried over', () => {
    expect(diff(...graphs('Alpha Beta Gamma Delta', 1)).stats.facets.mergedInto).toBe(0);
  });

  it('turns a weaker candidate into a suggestion', () => {
    const d = diff(...graphs('Alpha Beta Gamma Delta Inc', 2));
    expect(d.stats.facets.mergedInto).toBe(0);
    expect(d.suggestions).toEqual([
      expect.objectContaining({
        before: 'x',
        after: 'T',
        reason: 'below-threshold',
        score: expect.closeTo(0.71, 2),
      }),
    ]);
  });

  it('needs similar names', () => {
    expect(diff(...graphs('Something Else', 4)).stats.facets.mergedInto).toBe(0);
  });
});

describe('splits', () => {
  const b: GraphInput = {
    nodes: [{ id: 'x', label: 'Alpha Beta Gamma Delta' }, { id: 'n1' }, { id: 'n2' }],
    edges: [
      { source: 'x', target: 'n1', predicate: 'p' },
      { source: 'x', target: 'n2', predicate: 'q' },
    ],
  };

  it('splits a surviving node into itself and a new node that replaces it', () => {
    const a: GraphInput = {
      nodes: [
        { id: 'x', label: 'Alpha Beta Gamma Delta' },
        { id: 't', label: 'Other', replaces: ['x'] },
        { id: 'n1' },
        { id: 'n2' },
      ],
      edges: [
        { source: 'x', target: 'n1', predicate: 'p' },
        { source: 't', target: 'n2', predicate: 'q' },
      ],
    };
    const d = diff(b, a);
    expect(facetsOf(d, 'x')).toEqual([{ kind: 'splitInto', targets: ['t'] }]);
    expect(facetsOf(d, 't')).toEqual([
      { kind: 'splitFrom', source: 'x', confidence: 1, via: 'hint' },
    ]);
    const carried = d.edges.find((e) => e.source === 't');
    expect(carried).toMatchObject({ status: 'modified', sourceBefore: 'x' });
    expect(carried?.facets).toEqual([
      { kind: 'retarget', end: 'source', from: 'x', to: 't', cause: 'split' },
    ]);
    expect(d.hunks.map((h) => h.id)).toEqual(['split:x']);
  });

  it('detects a split heuristically from a near-identical name and carried edges', () => {
    const a: GraphInput = {
      nodes: [...b.nodes, { id: 't', label: 'Alpha Beta Gamma Delta Inc' }],
      edges: [
        ...b.edges,
        { source: 't', target: 'n1', predicate: 'p' },
        { source: 't', target: 'n2', predicate: 'q' },
      ],
    };
    const d = diff(b, a);
    expect(facetsOf(d, 't')).toEqual([
      { kind: 'splitFrom', source: 'x', confidence: expect.closeTo(0.96, 2), via: 'heuristic' },
    ]);
  });

  it('accepts the old name as a synonym of the new node as label evidence', () => {
    const a: GraphInput = {
      nodes: [
        ...b.nodes,
        { id: 't', label: 'Something else', aliases: ['Alpha Beta Gamma Delta'] },
      ],
      edges: [...b.edges, { source: 't', target: 'n1', predicate: 'p' }],
    };
    expect(facetsOf(diff(b, a), 't')).toEqual([
      { kind: 'splitFrom', source: 'x', confidence: 1, via: 'heuristic' },
    ]);
  });

  it('reviews every changed edge of the split source in the split hunk', () => {
    const a: GraphInput = {
      nodes: [...b.nodes, { id: 't', label: 'Other', replaces: ['x'] }, { id: 'n3' }],
      edges: [...b.edges, { source: 'x', target: 'n3', predicate: 'r' }],
    };
    const d = diff(b, a);
    // The split hunk's new edge points at n3, so the addition of n3 comes first.
    expect(d.hunks.map((h) => [h.id, h.edges, h.requires])).toEqual([
      ['add:n3', [], []],
      ['split:x', [JSON.stringify(['x', 'r', 'n3'])], ['add:n3']],
    ]);
  });

  it('can be switched off', () => {
    const a: GraphInput = { nodes: [...b.nodes, { id: 't', replaces: ['x'] }], edges: b.edges };
    const options: DiffOptions = { detectSplits: false };
    expect(diff(b, a, options).stats.facets.splitFrom).toBe(0);
  });
});

describe('overlapping restructurings', () => {
  it('collapses a merge chain onto its final target', () => {
    const b: GraphInput = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'n', label: 'N' },
        { id: 'e', label: 'E' },
      ],
      edges: [],
    };
    const a: GraphInput = {
      nodes: [
        { id: 'n', label: 'N', deprecated: true, replacedBy: ['e'] },
        { id: 'e', label: 'E' },
      ],
      edges: [],
    };
    const d = diff(
      { ...b, nodes: b.nodes.map((n) => (n.id === 'a' ? { ...n, replacedBy: ['n'] } : n)) },
      a,
    );
    expect(d.index.node('e')?.facets[0]).toEqual({ kind: 'mergeTarget', sources: ['a', 'n'] });
    expect(facetsOf(d, 'a')[0]).toMatchObject({ kind: 'mergedInto', target: 'e' });
    expect(d.hunks.map((h) => [h.id, h.nodes])).toEqual([['merge:e', ['e', 'a', 'n']]]);
  });

  it('does not treat nodes that replace each other as merges', () => {
    const b: GraphInput = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [],
    };
    const a: GraphInput = {
      nodes: [
        { id: 'a', label: 'A', deprecated: true, replacedBy: ['b'] },
        { id: 'b', label: 'B', deprecated: true, replacedBy: ['a'] },
      ],
      edges: [],
    };
    const d = diff(b, a);
    expect(d.stats.facets.mergedInto).toBe(0);
    expect(d.hunks.map((h) => h.kind)).toEqual(['modify', 'modify']);
  });

  it('reviews a node that absorbs one node and splits off another as one hunk', () => {
    const b: GraphInput = {
      nodes: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
      ],
      edges: [],
    };
    const a: GraphInput = {
      nodes: [
        { id: 'x', label: 'X', replaces: ['y'] },
        { id: 't', label: 'T', replaces: ['x'] },
      ],
      edges: [],
    };
    const d = diff(b, a);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ kind: 'merge', anchor: 'x', nodes: ['x', 't', 'y'] });
    expect(kinds(d, 'x')).toEqual(['mergeTarget', 'splitInto', 'replacement']);
  });
});
