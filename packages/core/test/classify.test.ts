import { diff, type GraphInput, type NodeInput } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';

const single = (node: NodeInput): GraphInput => ({ nodes: [node], edges: [] });
const facets = (b: NodeInput, a: NodeInput, options = {}) => {
  const d = diff(single(b), single(a), options);
  return { status: d.nodes[0]?.status, facets: d.nodes[0]?.facets };
};

describe('node classification', () => {
  it('reports an unchanged node without facets', () => {
    expect(
      facets(
        { id: 'a', label: 'A', attrs: { x: 1, y: 2 } },
        { id: 'a', label: 'A', attrs: { y: 2, x: 1 } },
      ),
    ).toEqual({
      status: 'unchanged',
      facets: [],
    });
  });

  it('reports a rename (exact label comparison)', () => {
    expect(facets({ id: 'a', label: 'Colour' }, { id: 'a', label: 'colour' })).toEqual({
      status: 'modified',
      facets: [{ kind: 'rename', from: 'Colour', to: 'colour' }],
    });
  });

  it('reports type and synonym set changes', () => {
    expect(
      facets(
        { id: 'a', type: ['A', 'B'], aliases: ['x'] },
        { id: 'a', type: ['B', 'C'], aliases: ['x', 'y'] },
      ).facets,
    ).toEqual([
      { kind: 'types', added: ['C'], removed: ['A'] },
      { kind: 'aliases', added: ['y'], removed: [] },
    ]);
  });

  it('reports attribute changes sorted by key, compared canonically', () => {
    const result = facets(
      { id: 'a', attrs: { z: 1, nested: { b: 1, a: 2 }, list: [1, 2], gone: 'x' } },
      { id: 'a', attrs: { nested: { a: 2, b: 1 }, list: [2, 1], z: 2, new: null } },
    );
    expect(result.facets).toEqual([
      {
        kind: 'attrs',
        changes: [
          { key: 'gone', before: 'x' },
          { key: 'list', before: [1, 2], after: [2, 1] },
          { key: 'new', after: null },
          { key: 'z', before: 1, after: 2 },
        ],
      },
    ]);
  });

  it('skips ignored attributes', () => {
    const b = { id: 'a', attrs: { updated: '2026-01-01', v: 1 } };
    const a = { id: 'a', attrs: { updated: '2026-02-01', v: 1 } };
    expect(facets(b, a, { ignoreAttrs: ['updated'] })).toEqual({ status: 'unchanged', facets: [] });
    expect(diff(single(b), single(a), { ignoreAttrs: ['updated'] }).hunks).toEqual([]);
  });

  it('reports deprecation and un-deprecation', () => {
    expect(facets({ id: 'a' }, { id: 'a', deprecated: true }).facets).toEqual([
      { kind: 'deprecate', deprecated: true },
    ]);
    expect(facets({ id: 'a', deprecated: true }, { id: 'a' }).facets).toEqual([
      { kind: 'deprecate', deprecated: false },
    ]);
  });

  it('lists facets in canonical order', () => {
    const result = facets(
      { id: 'a', label: 'A', type: 'T', aliases: ['x'], attrs: { k: 1 } },
      { id: 'a', label: 'B', type: 'U', aliases: ['y'], attrs: { k: 2 }, deprecated: true },
    );
    expect(result.facets?.map((f) => f.kind)).toEqual([
      'rename',
      'deprecate',
      'types',
      'aliases',
      'attrs',
    ]);
  });

  it('reports changed replacement links', () => {
    const d = diff(
      single({ id: 'a', deprecated: true, replacedBy: ['b'] }),
      single({ id: 'a', deprecated: true, replacedBy: ['c'] }),
    );
    expect(d.nodes[0]).toMatchObject({
      status: 'modified',
      facets: [
        {
          kind: 'replacement',
          replaces: { added: [], removed: [] },
          replacedBy: { added: ['c'], removed: ['b'] },
        },
      ],
      hunk: 'modify:a',
    });
    expect(d.delta.ops).toEqual([
      { op: 'node.set', id: 'a', field: 'replacedBy', from: ['b'], to: ['c'] },
    ]);
  });

  it('never reports a modified node without facets', () => {
    const d = diff(single({ id: 'a', replaces: ['x'] }), single({ id: 'a', replaces: ['y'] }));
    expect(d.nodes[0]?.facets.map((f) => f.kind)).toEqual(['replacement']);
  });

  it('does not report a node that only went from implicit to declared', () => {
    const b: GraphInput = { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'b' }] };
    const a: GraphInput = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    };
    expect(diff(b, a).stats.identical).toBe(true);
  });

  it('does not report id changes when ids are declared meaningless (strategy similarity)', () => {
    const d = diff(single({ id: 'old', label: 'Same' }), single({ id: 'new', label: 'Same' }), {
      match: { strategy: 'similarity' },
    });
    expect(d.nodes).toEqual([
      expect.objectContaining({ id: 'new', beforeId: 'old', status: 'unchanged', facets: [] }),
    ]);
    expect(d.stats.identical).toBe(true);
    expect(d.hunks).toEqual([]);
    // The delta still renames the node, so that applying it reproduces the after graph exactly.
    expect(d.delta.ops).toEqual([{ op: 'node.rekey', from: 'old', to: 'new' }]);
  });

  it('reports a rekey with the match score when ids are not used for matching', () => {
    const d = diff(single({ id: 'old', label: 'Same' }), single({ id: 'new', label: 'Same' }));
    expect(d.nodes).toEqual([
      expect.objectContaining({
        id: 'new',
        beforeId: 'old',
        afterId: 'new',
        status: 'modified',
        facets: [{ kind: 'rekey', from: 'old', to: 'new', score: 1 }],
      }),
    ]);
  });
});

describe('hierarchy moves', () => {
  const tree = (parents: Record<string, string[]>, predicate = 'rdfs:subClassOf'): GraphInput => ({
    nodes: ['root', 'A', 'B', 'C', 'x'].map((id) => ({ id })),
    edges: Object.entries(parents).flatMap(([child, ps]) =>
      ps.map((p) => ({ source: child, target: p, predicate })),
    ),
  });

  it('reports a parent change as a move with a retargeted hierarchy edge', () => {
    const d = diff(tree({ x: ['A'] }), tree({ x: ['B'] }));
    expect(d.index.node('x')?.facets).toEqual([
      { kind: 'move', predicate: 'rdfs:subClassOf', from: ['A'], to: ['B'] },
    ]);
    const edge = d.edges.find((e) => e.status !== 'unchanged');
    expect(edge).toMatchObject({ hierarchical: true, targetBefore: 'A', target: 'B' });
    expect(edge?.facets).toEqual([
      { kind: 'retarget', end: 'target', from: 'A', to: 'B', cause: 'move' },
    ]);
    expect(d.hunks).toEqual([
      expect.objectContaining({ id: 'modify:x', phase: 'restructure', context: ['A', 'B'] }),
    ]);
  });

  it('reports added and removed parents of a multi-parent node', () => {
    const d = diff(tree({ x: ['A', 'B'] }), tree({ x: ['B', 'C'] }));
    expect(d.index.node('x')?.facets).toEqual([
      { kind: 'move', predicate: 'rdfs:subClassOf', from: ['A'], to: ['C'] },
    ]);
  });

  it('reports one move per hierarchy predicate', () => {
    const d = diff(
      {
        nodes: tree({}).nodes,
        edges: [
          { source: 'x', target: 'A', predicate: 'is_a' },
          { source: 'x', target: 'A', predicate: 'skos:broader' },
        ],
      },
      {
        nodes: tree({}).nodes,
        edges: [
          { source: 'x', target: 'B', predicate: 'is_a' },
          { source: 'x', target: 'C', predicate: 'skos:broader' },
        ],
      },
    );
    expect(
      d.index.node('x')?.facets.map((f) => (f.kind === 'move' ? f.predicate : f.kind)),
    ).toEqual(['is_a', 'skos:broader']);
  });

  it('only treats configured predicates as hierarchical', () => {
    expect(
      diff(tree({ x: ['A'] }, 'parentOf'), tree({ x: ['B'] }, 'parentOf')).stats.facets.move,
    ).toBe(0);
    const custom = diff(tree({ x: ['A'] }, 'parentOf'), tree({ x: ['B'] }, 'parentOf'), {
      hierarchyPredicates: ['parentOf'],
    });
    expect(custom.stats.facets.move).toBe(1);
  });

  it('does not call dropping parents during an obsoletion a move', () => {
    const b = tree({ x: ['A'] });
    const deprecated: GraphInput = {
      nodes: b.nodes.map((n) => (n.id === 'x' ? { ...n, deprecated: true } : n)),
      edges: [],
    };
    const d = diff(b, deprecated);
    expect(d.index.node('x')?.facets).toEqual([{ kind: 'deprecate', deprecated: true }]);
    expect(d.hunks).toEqual([
      expect.objectContaining({
        id: 'modify:x',
        phase: 'modify',
        edges: [JSON.stringify(['x', 'rdfs:subClassOf', 'A'])],
      }),
    ]);
    // Gaining a parent is still a move.
    const moved: GraphInput = {
      ...deprecated,
      edges: [{ source: 'x', target: 'B', predicate: 'rdfs:subClassOf' }],
    };
    expect(
      diff(b, moved)
        .index.node('x')
        ?.facets.map((f) => f.kind),
    ).toEqual(['move', 'deprecate']);
  });

  it('does not call a parent merge a move', () => {
    const b: GraphInput = {
      nodes: [
        { id: 'x' },
        { id: 'P1', label: 'Parent' },
        { id: 'P2', label: 'Parent two', replaces: [] },
      ],
      edges: [{ source: 'x', target: 'P1', predicate: 'is_a' }],
    };
    const a: GraphInput = {
      nodes: [{ id: 'x' }, { id: 'P2', label: 'Parent two', replaces: ['P1'] }],
      edges: [{ source: 'x', target: 'P2', predicate: 'is_a' }],
    };
    const d = diff(b, a);
    expect(d.index.node('x')?.status).toBe('unchanged');
    expect(d.edges.find((e) => e.target === 'P2')?.facets).toEqual([
      { kind: 'retarget', end: 'target', from: 'P1', to: 'P2', cause: 'merge' },
    ]);
  });
});

describe('union node ids', () => {
  it('use the after id, else the before id, sorted by UTF-16 code units', () => {
    const d = diff(
      { nodes: [{ id: 'b' }, { id: 'Z' }, { id: 'é' }], edges: [] },
      { nodes: [{ id: 'b' }, { id: 'a' }, { id: '😀' }], edges: [] },
      { match: { strategy: 'id' } },
    );
    expect(d.nodes.map((n) => [n.id, n.status])).toEqual([
      ['Z', 'removed'],
      ['a', 'added'],
      ['b', 'unchanged'],
      ['é', 'removed'],
      ['😀', 'added'],
    ]);
  });

  it('append @before when a removed node shares its id with a different after node', () => {
    const d = diff(
      {
        nodes: [
          { id: 'x', label: 'Apple' },
          { id: 'y', label: 'Pear' },
        ],
        edges: [{ source: 'x', target: 'y' }],
      },
      { nodes: [{ id: 'x', label: 'Pear' }], edges: [] },
      { match: { strategy: 'similarity' } },
    );
    expect(d.nodes.map((n) => [n.id, n.beforeId, n.afterId, n.status])).toEqual([
      ['x', 'y', 'x', 'unchanged'],
      ['x@before', 'x', undefined, 'removed'],
    ]);
    expect(d.edges.map((e) => e.id)).toEqual([JSON.stringify(['x@before', '', 'x'])]);
  });

  it('expose display label, types and degrees in both versions', () => {
    const d = diff(
      {
        nodes: [{ id: 'a', label: 'Old', type: 'T' }, { id: 'b' }],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'a', target: 'a' },
        ],
      },
      { nodes: [{ id: 'a', label: 'New' }, { id: 'b' }], edges: [] },
    );
    expect(d.index.node('a')).toMatchObject({
      label: 'New',
      types: [],
      degree: { before: 3, after: 0 },
    });
  });
});
