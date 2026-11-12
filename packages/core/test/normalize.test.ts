import {
  applyDelta,
  type GraphInput,
  graphToJSON,
  hashGraph,
  invertDelta,
  isKGraph,
  KgdiffError,
  normalize,
} from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from './support/engine.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('normalize: nodes', () => {
  it('fills defaults and canonicalizes sets', () => {
    const g = normalize({
      nodes: [
        { id: 'a' },
        {
          id: 'b',
          label: 'Bee',
          type: ['Z', 'A', 'Z'],
          aliases: ['y', 'Bee', 'x', 'y', ''],
          replacedBy: ['q', 'p'],
        },
      ],
      edges: [],
    });
    expect(g.nodes.get('a')).toEqual({
      id: 'a',
      label: 'a',
      types: [],
      aliases: [],
      attrs: {},
      deprecated: false,
      replaces: [],
      replacedBy: [],
      implicit: false,
    });
    expect(g.nodes.get('b')).toMatchObject({
      label: 'Bee',
      types: ['A', 'Z'],
      aliases: ['x', 'y'],
      replacedBy: ['p', 'q'],
    });
  });

  it('accepts a single type string, an empty label and numeric ids', () => {
    const g = normalize({
      nodes: [{ id: 'a', type: 'Class', label: '' }, { id: 7 as unknown as string }],
      edges: [],
    });
    expect(g.nodes.get('a')).toMatchObject({ label: 'a', types: ['Class'] });
    expect(g.nodes.get('7')?.label).toBe('7');
  });

  it('keeps attribute keys as given and positions when valid', () => {
    const g = normalize({
      nodes: [
        { id: 'a', attrs: { z: 1, a: [2, 1] }, position: { x: 1, y: 2 } },
        { id: 'b', position: { x: Number.NaN, y: 0 } },
      ],
      edges: [],
    });
    expect(Object.keys(g.nodes.get('a')?.attrs ?? {})).toEqual(['z', 'a']);
    expect(g.nodes.get('a')?.position).toEqual({ x: 1, y: 2 });
    expect(g.nodes.get('b')?.position).toBeUndefined();
  });

  it('drops nodes without an id and reports them', () => {
    const g = normalize({ nodes: [{ id: '' }, { id: 'a' }], edges: [] });
    expect([...g.nodes.keys()]).toEqual(['a']);
    expect(g.issues).toEqual([expect.objectContaining({ code: 'empty-id' })]);
  });

  it('merges duplicate declarations field-wise: later wins for scalars, union for sets', () => {
    const g = normalize({
      nodes: [
        { id: 'a', label: 'First', type: 'A', attrs: { k: 1, keep: true }, deprecated: true },
        { id: 'a', label: 'Second', type: 'B', attrs: { k: 2 } },
      ],
      edges: [],
    });
    expect(g.nodes.get('a')).toMatchObject({
      label: 'Second',
      types: ['A', 'B'],
      attrs: { k: 2, keep: true },
      deprecated: true,
    });
    expect(g.issues).toEqual([expect.objectContaining({ code: 'duplicate-node', ref: 'a' })]);
  });

  it('never mutates its input', () => {
    const input: GraphInput = deepFreeze({
      nodes: [{ id: 'a', aliases: ['z', 'a'], type: ['b', 'a'], attrs: { k: { x: 1 } } }],
      edges: [{ source: 'a', target: 'ghost' }],
    });
    const snapshot = JSON.stringify(input);
    expect(() => normalize(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('handles ids with special characters, IRIs and CJK', () => {
    const ids = ['x|y', 'q"uote', 'back\\slash', 'http://ex.org/n#1', '企业', ' sp ace '];
    const g = normalize({
      nodes: ids.map((id) => ({ id })),
      edges: ids.map((id, i) => ({
        source: id,
        target: ids[(i + 1) % ids.length] as string,
        predicate: 'p',
      })),
    });
    expect([...g.nodes.keys()]).toEqual(ids);
    for (const edge of g.edges.values()) {
      expect(JSON.parse(edge.key)).toEqual([edge.source, 'p', edge.target]);
    }
  });
});

describe('normalize: edges', () => {
  it('keys edges structurally and derives the label from the predicate', () => {
    const g = normalize({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b', predicate: 'http://purl.obolibrary.org/obo/part_of' },
        { source: 'b', target: 'a' },
      ],
    });
    expect([...g.edges.keys()]).toEqual([
      JSON.stringify(['a', 'http://purl.obolibrary.org/obo/part_of', 'b']),
      JSON.stringify(['b', '', 'a']),
    ]);
    expect([...g.edges.values()].map((e) => e.label)).toEqual(['part of', '']);
  });

  it('indexes outgoing and incoming edges in insertion order, including self-loops', () => {
    const g = normalize({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b', predicate: 'p' },
        { source: 'a', target: 'a', predicate: 'loop' },
        { source: 'b', target: 'a', predicate: 'q' },
      ],
    });
    const key = (s: string, p: string, t: string): string => JSON.stringify([s, p, t]);
    expect(g.outgoing.get('a')).toEqual([key('a', 'p', 'b'), key('a', 'loop', 'a')]);
    expect(g.incoming.get('a')).toEqual([key('a', 'loop', 'a'), key('b', 'q', 'a')]);
    expect(g.outgoing.get('b')).toEqual([key('b', 'q', 'a')]);
  });

  it('keys parallel copies of a triple #2, #3… in content order, independent of input order', () => {
    const copies = [
      { source: 'a', target: 'b', predicate: 'KNOWS', attrs: { since: 2021 } },
      { source: 'a', target: 'b', predicate: 'KNOWS', attrs: { since: 2019 } },
      { source: 'a', target: 'b', predicate: 'KNOWS', attrs: { since: 2020 } },
    ];
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const forward = normalize({ nodes, edges: copies });
    const backward = normalize({ nodes, edges: [...copies].reverse() });
    const base = JSON.stringify(['a', 'KNOWS', 'b']);
    expect([...forward.edges.keys()]).toEqual([base, `${base}#2`, `${base}#3`]);
    expect(forward.edges.get(base)?.attrs).toEqual({ since: 2019 });
    expect([...backward.edges.values()]).toEqual([...forward.edges.values()]);
    expect(forward.issues).toEqual([
      expect.objectContaining({ code: 'duplicate-edge', ref: base }),
    ]);
  });

  it('collapses copies that are identical in content', () => {
    const g = normalize({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { id: 'e2', source: 'a', target: 'b', predicate: 'p' },
        { id: 'e1', source: 'a', target: 'b', predicate: 'p' },
      ],
    });
    expect(g.edges.size).toBe(1);
    expect([...g.edges.values()][0]?.id).toBe('e1');
    expect(g.issues.map((i) => i.code)).toEqual(['duplicate-edge']);
  });

  it('keys edges by id under id identity, falling back to the structure', () => {
    const g = normalize(
      {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [
          { id: 'e1', source: 'a', target: 'b', predicate: 'p' },
          { id: 'e2', source: 'a', target: 'b', predicate: 'p' },
          { source: 'b', target: 'a', predicate: 'q' },
        ],
      },
      { edgeIdentity: 'id' },
    );
    expect([...g.edges.keys()]).toEqual(['e1', 'e2', JSON.stringify(['b', 'q', 'a'])]);
    expect(g.edgeIdentity).toBe('id');
  });

  it('merges repeated edge ids field-wise under id identity', () => {
    const g = normalize(
      {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [
          { id: 'e', source: 'a', target: 'b', predicate: 'p', attrs: { w: 1, keep: 1 } },
          { id: 'e', source: 'a', target: 'a', predicate: 'q', attrs: { w: 2 } },
        ],
      },
      { edgeIdentity: 'id' },
    );
    expect(g.edges.get('e')).toMatchObject({
      target: 'a',
      predicate: 'q',
      attrs: { w: 2, keep: 1 },
    });
    expect(g.issues.map((i) => i.code)).toEqual(['duplicate-edge']);
  });

  it('creates implicit nodes for dangling endpoints by default', () => {
    const g = normalize({
      nodes: [{ id: 'a' }],
      edges: [{ source: 'a', target: 'ghost', predicate: 'p' }],
    });
    expect(g.nodes.get('ghost')).toMatchObject({ id: 'ghost', label: 'ghost', implicit: true });
    expect(g.issues).toEqual([expect.objectContaining({ code: 'dangling-edge', ref: 'ghost' })]);
  });

  it('drops dangling edges on request', () => {
    const g = normalize(
      {
        nodes: [{ id: 'a' }],
        edges: [
          { source: 'ghost', target: 'a' },
          { source: 'a', target: 'a' },
        ],
      },
      { danglingEdges: 'drop' },
    );
    expect(g.edges.size).toBe(1);
    expect(g.nodes.has('ghost')).toBe(false);
    expect(g.issues.map((i) => i.code)).toEqual(['dangling-edge']);
  });

  it('throws on dangling edges on request', () => {
    expect(() =>
      normalize({ nodes: [], edges: [{ source: 'a', target: 'a' }] }, { danglingEdges: 'error' }),
    ).toThrowError(
      expect.objectContaining({
        code: 'dangling-edge',
        details: expect.objectContaining({ missing: 'a' }),
      }),
    );
  });

  it('drops edges with an empty endpoint', () => {
    const g = normalize({ nodes: [{ id: 'a' }], edges: [{ source: '', target: 'a' }] });
    expect(g.edges.size).toBe(0);
    expect(g.issues.map((i) => i.code)).toEqual(['empty-id']);
  });
});

describe('normalize: validation', () => {
  it.each([
    ['a non-object', 42],
    ['missing nodes', { edges: [] }],
    ['edges that are not an array', { nodes: [], edges: {} }],
    ['a node that is not an object', { nodes: ['a'], edges: [] }],
    ['aliases that are not strings', { nodes: [{ id: 'a', aliases: [1] }], edges: [] }],
    ['a non-boolean deprecated flag', { nodes: [{ id: 'a', deprecated: 'yes' }], edges: [] }],
    ['attrs that are not an object', { nodes: [{ id: 'a', attrs: [] }], edges: [] }],
    [
      'a non-string predicate',
      { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a', predicate: 3 }] },
    ],
  ])('rejects %s with invalid-input', (_name, input) => {
    expect(() => normalize(input as unknown as GraphInput)).toThrowError(KgdiffError);
    expect(() => normalize(input as unknown as GraphInput)).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });

  it('rejects unknown options', () => {
    expect(() =>
      normalize({ nodes: [], edges: [] }, { danglingEdges: 'ignore' as 'drop' }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
    expect(() => normalize({ nodes: [], edges: [] }, { edgeIdentity: 'key' as 'id' })).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });

  it('accepts an empty graph and a graph without edges', () => {
    expect(normalize({ nodes: [], edges: [] }).nodes.size).toBe(0);
    expect(normalize({ nodes: [{ id: 'a' }] } as unknown as GraphInput).edges.size).toBe(0);
  });
});

describe('isKGraph and graphToJSON', () => {
  it('distinguishes normalized graphs from inputs', () => {
    const input = { nodes: [], edges: [] };
    expect(isKGraph(input)).toBe(false);
    expect(isKGraph(normalize(input))).toBe(true);
    expect(isKGraph(null)).toBe(false);
  });

  it('serializes canonically and round-trips through normalize', () => {
    const g = normalize({
      meta: { name: 'demo' },
      nodes: [
        { id: 'b', label: 'Bee', type: 'T', attrs: { z: 1, a: { y: 1, x: 2 } }, deprecated: true },
        { id: 'a' },
      ],
      edges: [
        { source: 'b', target: 'a', predicate: 'rdfs:subClassOf' },
        { source: 'a', target: 'ghost', predicate: 'p', label: 'custom' },
      ],
    });
    const json = graphToJSON(g);
    expect(json).toEqual({
      format: 'kgdiff.graph',
      version: 1,
      meta: { name: 'demo' },
      nodes: [
        { id: 'a' },
        {
          id: 'b',
          label: 'Bee',
          types: ['T'],
          attrs: { a: { x: 2, y: 1 }, z: 1 },
          deprecated: true,
        },
        { id: 'ghost', implicit: true },
      ],
      edges: [
        { source: 'a', target: 'ghost', predicate: 'p', label: 'custom' },
        { source: 'b', target: 'a', predicate: 'rdfs:subClassOf' },
      ],
    });
    expect(JSON.stringify(Object.keys(json.nodes[1]?.attrs ?? {}))).toBe('["a","z"]');
    const back = normalize(json);
    expect(graphToJSON(back)).toEqual(json);
    expect(back.nodes.get('ghost')?.implicit).toBe(true);
  });

  it('leads with the format marker, with or without meta', () => {
    const bare = graphToJSON(normalize({ nodes: [{ id: 'a' }], edges: [] }));
    expect(Object.keys(bare)).toEqual(['format', 'version', 'nodes', 'edges']);
    const withMeta = graphToJSON(normalize({ meta: { name: 'm' }, nodes: [], edges: [] }));
    expect(Object.keys(withMeta)).toEqual(['format', 'version', 'meta', 'nodes', 'edges']);
  });
});

describe('normalize: the kgdiff JSON marker', () => {
  const graph = { nodes: [{ id: 'a' }], edges: [] };
  const unsupported = expect.objectContaining({ code: 'unsupported-version' });

  it('is optional, and accepted when it names kgdiff.graph version 1', () => {
    const marked = normalize({ format: 'kgdiff.graph', version: 1, ...graph });
    expect(hashGraph(marked)).toBe(hashGraph(normalize(graph)));
  });

  it('rejects other graph versions, a missing version included', () => {
    for (const version of [2, 0, '1', undefined]) {
      const input = { format: 'kgdiff.graph', version, ...graph } as unknown as GraphInput;
      expect(() => normalize(input)).toThrowError(unsupported);
    }
  });

  it('rejects the other kgdiff formats, such as a diff passed as a graph', () => {
    for (const format of ['kgdiff.diff', 'kgdiff.delta', 'kgdiff.graph2']) {
      const input = { format, version: 1, ...graph } as unknown as GraphInput;
      expect(() => normalize(input)).toThrowError(unsupported);
    }
  });

  it("ignores a format field that is not kgdiff's", () => {
    for (const format of ['graphml', 7, null]) {
      const input = { format, version: 9, ...graph } as unknown as GraphInput;
      expect(normalize(input).nodes.size).toBe(1);
    }
  });
});

describe('normalize: untrusted attribute data', () => {
  it('keeps __proto__ and constructor as ordinary attribute keys', () => {
    const before = JSON.parse(
      '{"nodes":[{"id":"a","attrs":{"__proto__":{"x":1},"k":1}}],"edges":[]}',
    );
    const after = JSON.parse(
      '{"nodes":[{"id":"a","attrs":{"__proto__":{"x":2},"k":1,"constructor":"c"}}],"edges":[]}',
    );
    const g = normalize(before);
    expect(Object.keys(g.nodes.get('a')?.attrs ?? {})).toEqual(['__proto__', 'k']);
    const d = diff(before, after);
    expect(d.nodes[0]?.facets).toEqual([
      {
        kind: 'attrs',
        changes: [
          { key: '__proto__', before: { x: 1 }, after: { x: 2 } },
          { key: 'constructor', after: 'c' },
        ],
      },
    ]);
    const viaJSON = JSON.parse(JSON.stringify(d.delta));
    expect(hashGraph(applyDelta(d.before, viaJSON))).toBe(hashGraph(d.after));
    expect(hashGraph(applyDelta(d.after, invertDelta(viaJSON)))).toBe(hashGraph(d.before));
  });

  it('never reads inherited members as attributes', () => {
    const d = diff(
      { nodes: [{ id: 'a' }], edges: [] },
      { nodes: [{ id: 'a', attrs: { constructor: 'x', toString: 'y' } }], edges: [] },
    );
    expect(d.nodes[0]?.facets).toEqual([
      {
        kind: 'attrs',
        changes: [
          { key: 'constructor', after: 'x' },
          { key: 'toString', after: 'y' },
        ],
      },
    ]);
    expect(hashGraph(applyDelta(d.after, invertDelta(d.delta)))).toBe(hashGraph(d.before));
  });

  it('turns non-JSON values into JSON and reports what it drops', () => {
    const fn = (): void => undefined;
    const g = normalize({
      nodes: [
        {
          id: 'a',
          attrs: {
            nan: Number.NaN,
            inf: Number.POSITIVE_INFINITY,
            ninf: Number.NEGATIVE_INFINITY,
            big: 12n as unknown as number,
            when: new Date(Date.UTC(2026, 0, 2)) as unknown as string,
            fn: fn as unknown as string,
            sym: Symbol('s') as unknown as string,
            undef: undefined as unknown as string,
            list: [1, fn as unknown as number, 3],
          },
        },
      ],
      edges: [],
    });
    expect(g.nodes.get('a')?.attrs).toEqual({
      nan: 'NaN',
      inf: 'Infinity',
      ninf: '-Infinity',
      big: '12',
      when: '2026-01-02T00:00:00.000Z',
      list: [1, null, 3],
    });
    expect(g.issues).toEqual([expect.objectContaining({ code: 'invalid-attr', ref: 'a' })]);
  });

  it('rejects attribute values nested too deeply, and cyclic ones', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 1500; i++) deep = [deep];
    expect(() =>
      normalize({ nodes: [{ id: 'a', attrs: { deep } as never }], edges: [] }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      normalize({ nodes: [{ id: 'a', attrs: cyclic as never }], edges: [] }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  });
});

describe('normalize: order independence and text normalization', () => {
  it('merges duplicate declarations the same way whatever their order', () => {
    const first = {
      id: 'a',
      label: 'First',
      type: 'A',
      attrs: { k: 1, x: 'p' },
      deprecated: false,
    };
    const second = { id: 'a', label: 'Second', type: 'B', attrs: { k: 2 }, deprecated: true };
    const forward = normalize({ nodes: [first, second], edges: [] });
    const backward = normalize({ nodes: [second, first], edges: [] });
    expect(backward.nodes.get('a')).toEqual(forward.nodes.get('a'));
    expect(forward.nodes.get('a')).toMatchObject({
      label: 'Second',
      types: ['A', 'B'],
      attrs: { k: 2, x: 'p' },
      deprecated: true,
    });
  });

  it('merges repeated edge ids the same way whatever their order', () => {
    const e1 = { id: 'e', source: 'a', target: 'b', predicate: 'p', attrs: { w: 1 } };
    const e2 = { id: 'e', source: 'a', target: 'a', predicate: 'q', attrs: { w: 2, z: 0 } };
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const forward = normalize({ nodes, edges: [e1, e2] }, { edgeIdentity: 'id' });
    const backward = normalize({ nodes, edges: [e2, e1] }, { edgeIdentity: 'id' });
    expect([...backward.edges.values()]).toEqual([...forward.edges.values()]);
  });

  it('keeps edge ids and structural keys apart under id identity', () => {
    const lookalike = { id: '["a","p","b"]', source: 'a', target: 'b', predicate: 'q', label: 'X' };
    const structural = { source: 'a', target: 'b', predicate: 'p', label: 'Y' };
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const forward = normalize({ nodes, edges: [lookalike, structural] }, { edgeIdentity: 'id' });
    const backward = normalize({ nodes, edges: [structural, lookalike] }, { edgeIdentity: 'id' });
    expect(forward.edges.size).toBe(2);
    expect(forward.edges.get('["a","p","b"]')?.label).toBe('X');
    expect(new Set(backward.edges.keys())).toEqual(new Set(forward.edges.keys()));
    expect(hashGraph(backward)).toBe(hashGraph(forward));
  });

  it('composes labels, aliases and types to NFC, but not ids', () => {
    const composed = 'Café';
    const decomposed = 'Café';
    const d = diff(
      { nodes: [{ id: 'x', label: composed, aliases: [composed], type: composed }], edges: [] },
      {
        nodes: [{ id: 'x', label: decomposed, aliases: [decomposed], type: decomposed }],
        edges: [],
      },
    );
    expect(d.stats.identical).toBe(true);
    expect(normalize({ nodes: [{ id: decomposed }], edges: [] }).nodes.has(decomposed)).toBe(true);
  });
});
