import { applyDelta, type DeltaOp, type GraphInput, hashGraph } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from '../src/sync.js';

const key = (s: string, p: string, t: string) => JSON.stringify([s, p, t]);

describe('hunks: kinds', () => {
  it('groups connected added nodes with their edges, anchored at the best-connected node', () => {
    const d = diff(
      { nodes: [{ id: 'hub' }], edges: [] },
      {
        nodes: [{ id: 'hub' }, { id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'lonely' }],
        edges: [
          { source: 'n1', target: 'n2', predicate: 'p' },
          { source: 'n2', target: 'n3', predicate: 'p' },
          { source: 'n2', target: 'hub', predicate: 'p' },
        ],
      },
    );
    expect(d.hunks.map((h) => [h.id, h.nodes, h.edges.length, h.context])).toEqual([
      ['add:n2', ['n2', 'n1', 'n3'], 3, ['hub']],
      ['add:lonely', ['lonely'], 0, []],
    ]);
  });

  it('groups removed nodes the same way', () => {
    const d = diff(
      {
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'keep' }],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'keep' },
        ],
      },
      { nodes: [{ id: 'keep' }], edges: [] },
    );
    expect(d.hunks.map((h) => [h.id, h.kind, h.phase, h.nodes, h.edges.length, h.context])).toEqual(
      [['remove:b', 'remove', 'remove', ['b', 'a'], 2, ['keep']]],
    );
  });

  it('gives a modified node its outgoing edge changes, like a file in git', () => {
    const d = diff(
      {
        nodes: [{ id: 'a', label: 'A' }, { id: 'b' }, { id: 'c' }],
        edges: [{ source: 'c', target: 'a', predicate: 'in' }],
      },
      {
        nodes: [{ id: 'a', label: 'A2' }, { id: 'b' }, { id: 'c' }],
        edges: [{ source: 'a', target: 'b', predicate: 'out' }],
      },
    );
    expect(d.hunks.map((h) => [h.id, h.nodes, h.edges])).toEqual([
      ['relations:c', [], [key('c', 'in', 'a')]],
      ['modify:a', ['a'], [key('a', 'out', 'b')]],
    ]);
  });

  it('groups edge-only changes by their source node', () => {
    const d = diff(
      { nodes: [{ id: 's' }, { id: 't' }, { id: 'u' }], edges: [] },
      {
        nodes: [{ id: 's' }, { id: 't' }, { id: 'u' }],
        edges: [
          { source: 's', target: 't', predicate: 'p' },
          { source: 's', target: 'u', predicate: 'p' },
          { source: 't', target: 'u', predicate: 'p' },
        ],
      },
    );
    expect(d.hunks.map((h) => [h.id, h.edges.length, h.context, h.summary])).toEqual([
      [
        'relations:s',
        2,
        ['s', 't', 'u'],
        {
          nodes: { added: 0, removed: 0, modified: 0 },
          edges: { added: 2, removed: 0, modified: 0 },
          facets: [],
        },
      ],
      [
        'relations:t',
        1,
        ['t', 'u'],
        {
          nodes: { added: 0, removed: 0, modified: 0 },
          edges: { added: 1, removed: 0, modified: 0 },
          facets: [],
        },
      ],
    ]);
  });
});

describe('hunks: order, phase and ops', () => {
  const before: GraphInput = {
    nodes: [
      { id: 'gone' },
      { id: 'renamed', label: 'Old' },
      { id: 'child' },
      { id: 'P1' },
      { id: 'P2' },
      { id: 'z', label: 'Zed' },
      { id: 'y', label: 'Why' },
    ],
    edges: [{ source: 'child', target: 'P1', predicate: 'is_a' }],
  };
  const after: GraphInput = {
    nodes: [
      { id: 'new' },
      { id: 'renamed', label: 'New' },
      { id: 'child' },
      { id: 'P1' },
      { id: 'P2' },
      { id: 'z', label: 'Zed!' },
      { id: 'y', label: 'Why!' },
    ],
    edges: [{ source: 'child', target: 'P2', predicate: 'is_a' }],
  };

  it('orders by phase, then size, then anchor label', () => {
    const d = diff(before, after);
    expect(d.hunks.map((h) => [h.order, h.id, h.phase])).toEqual([
      [0, 'remove:gone', 'remove'],
      [1, 'modify:child', 'restructure'],
      [2, 'modify:renamed', 'modify'],
      [3, 'modify:y', 'modify'],
      [4, 'modify:z', 'modify'],
      [5, 'add:new', 'add'],
    ]);
  });

  it('lists the delta ops of each hunk in ascending order', () => {
    const d = diff(before, after);
    for (const h of d.hunks) {
      expect(h.ops.length).toBeGreaterThan(0);
      for (const i of h.ops) expect(d.delta.ops[i]).toBeDefined();
    }
    const move = d.index.hunk('modify:child');
    expect(move?.ops.map((i) => d.delta.ops[i]?.op)).toEqual(['edge.remove', 'edge.add']);
    expect(move?.context).toEqual(['P1', 'P2']);
    expect(move?.summary).toEqual({
      nodes: { added: 0, removed: 0, modified: 1 },
      edges: { added: 0, removed: 0, modified: 1 },
      facets: ['move', 'retarget'],
    });
  });

  it('assigns every changed element to its hunk', () => {
    const d = diff(before, after);
    for (const n of d.nodes) {
      if (n.status === 'unchanged') expect(n.hunk).toBeUndefined();
      else expect(d.index.hunk(n.hunk ?? '')?.nodes).toContain(n.id);
    }
  });

  it('is empty for identical graphs', () => {
    expect(diff(before, before).hunks).toEqual([]);
  });
});

describe('hunks: dependencies', () => {
  const applyInOrder = (d: ReturnType<typeof diff>) => {
    let graph = d.before;
    const owned = new Set(d.hunks.flatMap((h) => h.ops));
    const batches = [
      d.delta.ops.map((_, i) => i).filter((i) => !owned.has(i)),
      ...d.hunks.map((h) => h.ops),
    ];
    for (const indices of batches) {
      if (indices.length === 0) continue;
      const ops = indices.map((i) => d.delta.ops[i] as DeltaOp);
      graph = applyDelta(graph, {
        ...d.delta,
        base: { ...d.delta.base, hash: hashGraph(graph) },
        ops,
      });
    }
    return graph;
  };

  it('orders a move under a new parent after the parent is added', () => {
    const d = diff(
      {
        nodes: [{ id: 'c' }, { id: 'P1' }],
        edges: [{ source: 'c', target: 'P1', predicate: 'is_a' }],
      },
      {
        nodes: [{ id: 'c' }, { id: 'P1' }, { id: 'P3' }],
        edges: [
          { source: 'c', target: 'P3', predicate: 'is_a' },
          { source: 'P3', target: 'P1', predicate: 'is_a' },
        ],
      },
    );
    expect(d.hunks.map((h) => [h.id, h.requires])).toEqual([
      ['add:P3', []],
      ['modify:c', ['add:P3']],
    ]);
    expect(hashGraph(applyInOrder(d))).toBe(hashGraph(d.after));
  });

  it('removes a node only after the edges pointing to it are gone', () => {
    const d = diff(
      {
        nodes: [{ id: 'x' }, { id: 'n' }, { id: 'y' }],
        edges: [{ source: 'n', target: 'x', predicate: 'p' }],
      },
      {
        nodes: [{ id: 'n' }, { id: 'y' }, { id: 'z' }],
        edges: [{ source: 'n', target: 'z', predicate: 'p' }],
      },
    );
    expect(d.hunks.map((h) => [h.id, h.requires])).toEqual([
      ['add:z', []],
      ['relations:n', ['add:z']],
      ['remove:x', ['relations:n']],
    ]);
    expect(hashGraph(applyInOrder(d))).toBe(hashGraph(d.after));
  });

  it('merges hunks that depend on each other into one', () => {
    // a1 becomes a2 (a hinted rekey, in a2's hunk); a2's edge moves to the new node c, whose
    // own new edge points back at a2: each hunk needs the other first.
    const d = diff(
      {
        nodes: [{ id: 'a1', label: 'Alpha' }, { id: 'b' }],
        edges: [{ source: 'a1', target: 'b', predicate: 'p' }],
      },
      {
        nodes: [{ id: 'a2', label: 'Alpha', replaces: ['a1'] }, { id: 'b' }, { id: 'c' }],
        edges: [
          { source: 'a2', target: 'c', predicate: 'p' },
          { source: 'c', target: 'a2', predicate: 'q' },
        ],
      },
    );
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({
      id: 'modify:a2',
      anchor: 'a2',
      nodes: ['a2', 'c'],
      requires: [],
    });
    expect(d.index.node('c')?.hunk).toBe('modify:a2');
    expect(d.hunks[0]?.ops).toEqual(d.delta.ops.map((_, i) => i));
    expect(hashGraph(applyInOrder(d))).toBe(hashGraph(d.after));
  });
});
