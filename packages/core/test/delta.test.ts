import {
  applyDelta,
  type Delta,
  type DeltaOp,
  type GraphInput,
  hashGraph,
  invertDelta,
  KgdiffError,
  normalize,
} from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from './support/engine.js';

const before: GraphInput = {
  meta: { name: 'demo', version: 'v1' },
  nodes: [{ id: 'keep', label: 'Keep', attrs: { a: 1, gone: true } }, { id: 'old' }, { id: 'z' }],
  edges: [
    { source: 'keep', target: 'old', predicate: 'p' },
    { source: 'keep', target: 'z', predicate: 'q', label: 'Q' },
    { source: 'z', target: 'keep', predicate: 'r', attrs: { w: 1 } },
  ],
};
const after: GraphInput = {
  meta: { name: 'demo', version: 'v2' },
  nodes: [
    { id: 'keep', label: 'Kept', type: 'T', attrs: { a: 2, added: 'x' } },
    { id: 'z' },
    { id: 'new' },
  ],
  edges: [
    { source: 'keep', target: 'new', predicate: 'p2' },
    { source: 'keep', target: 'z', predicate: 'q', label: 'Q2' },
    { source: 'z', target: 'keep', predicate: 'r', attrs: { w: 2 } },
  ],
};

describe('delta emission', () => {
  const d = diff(before, after);

  it('wraps the ops in a versioned envelope that identifies both graphs', () => {
    expect(d.delta).toMatchObject({
      format: 'kgdiff.delta',
      version: 1,
      edgeIdentity: 'structure',
      base: { name: 'demo', version: 'v1', hash: hashGraph(d.before), nodes: 3, edges: 3 },
      target: { name: 'demo', version: 'v2', hash: hashGraph(d.after), nodes: 3, edges: 3 },
    });
  });

  it('emits ops in canonical order', () => {
    expect(d.delta.ops).toEqual([
      { op: 'edge.remove', edge: { source: 'keep', target: 'old', predicate: 'p' } },
      { op: 'node.remove', node: { id: 'old' } },
      { op: 'node.set', id: 'keep', field: 'label', from: 'Keep', to: 'Kept' },
      { op: 'node.set', id: 'keep', field: 'types', from: [], to: ['T'] },
      { op: 'node.attr', id: 'keep', key: 'a', from: 1, to: 2 },
      { op: 'node.attr', id: 'keep', key: 'added', to: 'x' },
      { op: 'node.attr', id: 'keep', key: 'gone', from: true },
      { op: 'node.add', node: { id: 'new' } },
      { op: 'edge.add', edge: { source: 'keep', target: 'new', predicate: 'p2' } },
      {
        op: 'edge.set',
        edge: { source: 'keep', target: 'z', predicate: 'q' },
        field: 'label',
        from: 'Q',
        to: 'Q2',
      },
      {
        op: 'edge.attr',
        edge: { source: 'z', target: 'keep', predicate: 'r' },
        key: 'w',
        from: 1,
        to: 2,
      },
    ]);
  });

  it('is empty for identical graphs', () => {
    expect(diff(before, before).delta.ops).toEqual([]);
  });
});

describe('applyDelta', () => {
  const d = diff(before, after);

  it('turns the base into the target, keeping meta and untouched positions', () => {
    const positioned = normalize({
      ...before,
      nodes: [
        { ...before.nodes[0], id: 'keep', position: { x: 3, y: 4 } },
        ...before.nodes.slice(1),
      ],
    });
    const result = applyDelta(positioned, d.delta);
    expect(hashGraph(result)).toBe(hashGraph(d.after));
    expect(result.nodes.get('keep')?.position).toEqual({ x: 3, y: 4 });
    expect(result.meta).toEqual({ name: 'demo', version: 'v2' });
  });

  it('rejects a graph that is not the base', () => {
    expect(() => applyDelta(d.after, d.delta)).toThrowError(
      expect.objectContaining({
        code: 'delta-base-mismatch',
        details: { expected: d.delta.base.hash, actual: hashGraph(d.after) },
      }),
    );
  });

  it('reports the first violated precondition with its op', () => {
    const tampered: Delta = {
      ...d.delta,
      ops: d.delta.ops.map((op, i) => (i === 2 ? ({ ...op, from: 'Nope' } as DeltaOp) : op)),
    };
    try {
      applyDelta(d.before, tampered);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(KgdiffError);
      expect(error).toMatchObject({
        code: 'delta-conflict',
        details: {
          opIndex: 2,
          op: tampered.ops[2],
          reason: 'node "keep" label differs from "from"',
        },
      });
    }
  });

  it.each<[string, DeltaOp, string]>([
    [
      'adding an existing node',
      { op: 'node.add', node: { id: 'keep' } },
      'node "keep" already exists',
    ],
    [
      'removing a node that still has edges',
      { op: 'node.remove', node: { id: 'z' } },
      'node "z" still has edges',
    ],
    [
      'removing a node that differs',
      { op: 'node.remove', node: { id: 'old', label: 'Other' } },
      'node "old" differs from the snapshot',
    ],
    [
      'removing a missing edge',
      { op: 'edge.remove', edge: { source: 'z', target: 'old' } },
      'edge not found',
    ],
    [
      'removing an edge that differs',
      { op: 'edge.remove', edge: { source: 'z', target: 'keep', predicate: 'r' } },
      'edge differs from the snapshot',
    ],
    [
      'adding an existing edge',
      { op: 'edge.add', edge: { source: 'keep', target: 'old', predicate: 'p' } },
      'edge already exists',
    ],
    [
      'adding an edge to a missing node',
      { op: 'edge.add', edge: { source: 'keep', target: 'ghost' } },
      'target node "ghost" does not exist',
    ],
    [
      'rekeying onto an existing id',
      { op: 'node.rekey', from: 'old', to: 'z' },
      'node "z" already exists',
    ],
    [
      'setting an attribute from a wrong value',
      { op: 'node.attr', id: 'keep', key: 'a', from: 9, to: 1 },
      'node "keep" attribute "a" differs from "from"',
    ],
    [
      'relabeling an edge from a wrong label',
      {
        op: 'edge.set',
        edge: { source: 'keep', target: 'z', predicate: 'q' },
        field: 'label',
        from: 'X',
        to: 'Y',
      },
      'edge label differs from "from"',
    ],
  ])('fails strictly on %s', (_name, op, reason) => {
    const delta: Delta = { ...d.delta, ops: [op] };
    expect(() => applyDelta(d.before, delta)).toThrowError(
      expect.objectContaining({ code: 'delta-conflict', details: { opIndex: 0, op, reason } }),
    );
  });

  it('skips failing ops when not strict, including the base check', () => {
    const delta: Delta = {
      ...d.delta,
      ops: [
        { op: 'node.add', node: { id: 'keep' } },
        { op: 'node.add', node: { id: 'fresh', label: 'Fresh' } },
      ],
    };
    const result = applyDelta(d.after, delta, { strict: false });
    expect(result.nodes.get('fresh')?.label).toBe('Fresh');
    expect(result.nodes.get('keep')?.label).toBe('Kept');
  });

  it('reports every skipped op to onSkip, with the reason strict mode would give', () => {
    const delta: Delta = {
      ...d.delta,
      ops: [
        { op: 'node.add', node: { id: 'keep' } },
        { op: 'node.add', node: { id: 'fresh' } },
        { op: 'node.set', id: 'ghost', field: 'label', from: 'a', to: 'b' },
      ],
    };
    const skipped: unknown[] = [];
    const result = applyDelta(d.after, delta, { strict: false, onSkip: (s) => skipped.push(s) });
    expect(result.nodes.has('fresh')).toBe(true);
    expect(skipped).toEqual([
      { index: 0, op: delta.ops[0], reason: 'node "keep" already exists' },
      { index: 2, op: delta.ops[2], reason: 'node "ghost" does not exist' },
    ]);
    // Strict mode raises the same reason for the first of them.
    expect(() =>
      applyDelta(d.after, { ...delta, base: { ...delta.base, hash: hashGraph(d.after) } }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ opIndex: 0, reason: 'node "keep" already exists' }),
      }),
    );
  });

  it('does not call onSkip when nothing is skipped, nor in strict mode', () => {
    const onSkip = (): never => {
      throw new Error('unexpected skip');
    };
    expect(() => applyDelta(d.before, d.delta, { strict: false, onSkip })).not.toThrow();
    expect(() => applyDelta(d.before, d.delta, { onSkip })).not.toThrow();
  });

  it('applies under the delta edge identity whatever the graph uses', () => {
    const idDiff = diff(
      { nodes: [{ id: 'a' }], edges: [{ id: 'e1', source: 'a', target: 'a', predicate: 'p' }] },
      { nodes: [{ id: 'a' }], edges: [{ id: 'e1', source: 'a', target: 'a', predicate: 'q' }] },
      { edgeIdentity: 'id' },
    );
    const structural = normalize({
      nodes: [{ id: 'a' }],
      edges: [{ id: 'e1', source: 'a', target: 'a', predicate: 'p' }],
    });
    expect(hashGraph(applyDelta(structural, idDiff.delta))).toBe(hashGraph(idDiff.after));
  });

  it('locates parallel copies by content in hand-written deltas', () => {
    const g = normalize({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b', predicate: 'KNOWS', attrs: { since: 1 } },
        { source: 'a', target: 'b', predicate: 'KNOWS', attrs: { since: 2 } },
      ],
    });
    const base = {
      format: 'kgdiff.delta',
      version: 1,
      edgeIdentity: 'structure',
      base: { hash: hashGraph(g), nodes: 2, edges: 2 },
      target: { hash: '', nodes: 2, edges: 2 },
    } as const;
    const ambiguous: Delta = {
      ...base,
      ops: [
        {
          op: 'edge.attr',
          edge: { source: 'a', target: 'b', predicate: 'KNOWS' },
          key: 'since',
          from: 1,
          to: 3,
        },
      ],
    };
    expect(() => applyDelta(g, ambiguous)).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'edge is ambiguous (parallel copies)' }),
      }),
    );
    const precise: Delta = {
      ...base,
      ops: [
        {
          op: 'edge.attr',
          edge: { source: 'a', target: 'b', predicate: 'KNOWS', attrs: { since: 1 } },
          key: 'since',
          from: 1,
          to: 3,
        },
      ],
    };
    expect([...applyDelta(g, precise).edges.values()].map((e) => e.attrs)).toEqual([
      { since: 2 },
      { since: 3 },
    ]);
  });

  it('rejects unknown formats, versions and ops', () => {
    expect(() => applyDelta(d.before, { ...d.delta, version: 2 } as unknown as Delta)).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    );
    expect(() =>
      applyDelta(d.before, { ...d.delta, format: 'other' } as unknown as Delta),
    ).toThrowError(expect.objectContaining({ code: 'unsupported-version' }));
    const unknown = { ...d.delta, ops: [{ op: 'node.explode', id: 'keep' }] } as unknown as Delta;
    expect(() => applyDelta(d.before, unknown)).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() => applyDelta(d.before, unknown, { strict: false })).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() => invertDelta(unknown)).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});

describe('ignored attributes in the delta', () => {
  const ignoreAttrs = ['ts'];
  const roundTrips = (d: ReturnType<typeof diff>): void => {
    expect(hashGraph(applyDelta(d.before, d.delta))).toBe(d.delta.target.hash);
    expect(hashGraph(applyDelta(d.after, invertDelta(d.delta)))).toBe(d.delta.base.hash);
  };

  it('carries them on an unchanged node and edge, in no hunk, showing no change', () => {
    const d = diff(
      {
        nodes: [{ id: 'a', attrs: { ts: 1 } }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b', predicate: 'p', attrs: { ts: 1 } }],
      },
      {
        nodes: [{ id: 'a' }, { id: 'b', attrs: { ts: 2 } }],
        edges: [{ source: 'a', target: 'b', predicate: 'p', attrs: { ts: 2 } }],
      },
      { ignoreAttrs },
    );
    expect(d.delta.ops).toEqual([
      { op: 'node.attr', id: 'a', key: 'ts', from: 1 },
      { op: 'node.attr', id: 'b', key: 'ts', to: 2 },
      {
        op: 'edge.attr',
        edge: { source: 'a', target: 'b', predicate: 'p' },
        key: 'ts',
        from: 1,
        to: 2,
      },
    ]);
    expect(d.hunks).toEqual([]);
    expect(d.stats.identical).toBe(true);
    expect(d.nodes.every((n) => n.status === 'unchanged' && n.facets.length === 0)).toBe(true);
    roundTrips(d);
  });

  it('heads the delta, keeping them out of the hunk of a modified node', () => {
    const d = diff(
      { nodes: [{ id: 'a', label: 'A', attrs: { ts: 1, k: 1 } }], edges: [] },
      { nodes: [{ id: 'a', label: 'A', attrs: { ts: 2, k: 2 } }], edges: [] },
      { ignoreAttrs },
    );
    expect(d.delta.ops).toEqual([
      { op: 'node.attr', id: 'a', key: 'ts', from: 1, to: 2 },
      { op: 'node.attr', id: 'a', key: 'k', from: 1, to: 2 },
    ]);
    expect(d.hunks.map((h) => h.ops)).toEqual([[1]]);
    expect(d.nodes[0]?.facets).toEqual([
      { kind: 'attrs', changes: [{ key: 'k', before: 1, after: 2 }] },
    ]);
    roundTrips(d);
  });

  it('addresses the before graph, ahead of a rename that belongs to a hunk', () => {
    const d = diff(
      {
        nodes: [
          { id: 'old', label: 'Same', attrs: { k: 1 } },
          { id: 'z', label: 'Other' },
        ],
        edges: [{ source: 'old', target: 'z', predicate: 'p', attrs: { ts: 1 } }],
      },
      {
        nodes: [
          { id: 'new', label: 'Same', attrs: { k: 2 } },
          { id: 'z', label: 'Other' },
        ],
        edges: [{ source: 'new', target: 'z', predicate: 'p', attrs: { ts: 2 } }],
      },
      { ignoreAttrs, match: { strategy: 'similarity' } },
    );
    expect(d.delta.ops[0]).toEqual({
      op: 'edge.attr',
      edge: { source: 'old', target: 'z', predicate: 'p' },
      key: 'ts',
      from: 1,
      to: 2,
    });
    expect(d.delta.ops[1]).toEqual({ op: 'node.rekey', from: 'old', to: 'new' });
    expect(d.hunks.flatMap((h) => h.ops)).not.toContain(0);
    expect(d.edges[0]?.status).toBe('unchanged');
    roundTrips(d);
  });

  it('replaces a parallel copy, which has no locator of its own', () => {
    const copies = (ts: number) => [
      { source: 'a', target: 'b', predicate: 'p', attrs: { ts, tag: 'x' } },
      { source: 'a', target: 'b', predicate: 'p', attrs: { ts: 9, tag: 'y' } },
    ];
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const d = diff({ nodes, edges: copies(1) }, { nodes, edges: copies(2) }, { ignoreAttrs });
    const edge = { source: 'a', target: 'b', predicate: 'p' };
    expect(d.delta.ops).toEqual([
      { op: 'edge.remove', edge: { ...edge, attrs: { tag: 'x', ts: 1 } } },
      { op: 'edge.add', edge: { ...edge, attrs: { tag: 'x', ts: 2 } } },
    ]);
    expect(d.hunks).toEqual([]);
    expect(d.edges.every((e) => e.status === 'unchanged')).toBe(true);
    roundTrips(d);
  });
});

describe('invertDelta', () => {
  const d = diff(before, after);

  it('reverses and inverts every op and swaps base and target', () => {
    const inverse = invertDelta(d.delta);
    expect(inverse.base).toEqual(d.delta.target);
    expect(inverse.target).toEqual(d.delta.base);
    expect(inverse.ops[0]).toEqual({
      op: 'edge.attr',
      edge: { source: 'z', target: 'keep', predicate: 'r' },
      key: 'w',
      from: 2,
      to: 1,
    });
    expect(inverse.ops.at(-1)).toEqual({
      op: 'edge.add',
      edge: { source: 'keep', target: 'old', predicate: 'p' },
    });
    expect(inverse.ops).toContainEqual({ op: 'node.attr', id: 'keep', key: 'gone', to: true });
    expect(inverse.ops).toContainEqual({ op: 'node.attr', id: 'keep', key: 'added', from: 'x' });
  });

  it('undoes the delta', () => {
    expect(hashGraph(applyDelta(d.after, invertDelta(d.delta)))).toBe(hashGraph(d.before));
  });
});

describe('rekeys', () => {
  it('round-trips a swap of identities found by similarity matching', () => {
    const g1: GraphInput = {
      nodes: [
        { id: 'k1', label: 'Foo' },
        { id: 'k2', label: 'Bar' },
      ],
      edges: [{ source: 'k1', target: 'k2', predicate: 'p' }],
    };
    const g2: GraphInput = {
      nodes: [
        { id: 'k1', label: 'Bar' },
        { id: 'k2', label: 'Foo' },
      ],
      edges: [{ source: 'k2', target: 'k1', predicate: 'p' }],
    };
    const d = diff(g1, g2, { match: { strategy: 'similarity' } });
    expect(d.edges.map((e) => e.status)).toEqual(['unchanged']);
    expect(d.delta.ops.filter((op) => op.op === 'node.rekey')).toHaveLength(3);
    expect(hashGraph(applyDelta(d.before, d.delta))).toBe(hashGraph(d.after));
    expect(hashGraph(applyDelta(d.after, invertDelta(d.delta)))).toBe(hashGraph(d.before));
  });
});

describe('applyDelta: malformed ops', () => {
  const d = diff(
    { nodes: [{ id: 'a' }], edges: [] },
    { nodes: [{ id: 'a', label: 'A' }], edges: [] },
  );

  it.each<[string, unknown]>([
    [
      'a label that is not a string',
      { op: 'node.set', id: 'a', field: 'label', from: 'a', to: 42 },
    ],
    ['an unknown node field', { op: 'node.set', id: 'a', field: 'colour', from: [], to: [] }],
    ['an edge without a target', { op: 'edge.add', edge: { source: 'a' } }],
    ['a node snapshot without an id', { op: 'node.add', node: { label: 'x' } }],
  ])('rejects %s as invalid-input, even when not strict', (_name, op) => {
    const delta = { ...d.delta, ops: [op] } as unknown as Delta;
    expect(() => applyDelta(d.before, delta, { strict: false })).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});
