import { diff, diffToJSON, type GraphInput, graphToJSON, hashGraph, normalize } from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseGraph } from '../src/index.js';
import { catchError, deepFreeze, parseFixture } from './helpers.js';

const json = (value: unknown, options: Parameters<typeof parseGraph>[1] = {}) =>
  parseGraph(JSON.stringify(value), { format: 'json', ...options });

describe('kgdiff native JSON', () => {
  it('maps every NodeInput / EdgeInput field and folds loose fields into attrs', () => {
    const result = parseFixture('kgdiff.json');
    expect(result.format).toBe('json');
    expect(result.dialect).toBe('kgdiff');
    expect(result.warnings).toEqual([]);
    expect(result.graph).toEqual({
      nodes: [
        {
          id: 'acme',
          label: 'ACME',
          type: 'Organization',
          attrs: { founded: 1999, hq: { city: 'Paris', country: 'FR' }, tags: ['b', 'a'] },
          replaces: ['old-acme'],
        },
        {
          id: 'alice',
          label: 'Alice',
          type: 'Person',
          aliases: ['Ally'],
          attrs: { age: 27 },
          position: { x: 1, y: 2 },
        },
        {
          id: 'bob',
          label: 'Bob',
          type: ['Employee', 'Person'],
          attrs: { email: 'bob@example.org' },
        },
        { id: 'old-acme', label: 'ACME Inc.', deprecated: true, replacedBy: ['acme'] },
      ],
      edges: [
        { source: 'alice', target: 'bob', predicate: 'knows', attrs: { since: 2020 } },
        { source: 'alice', target: 'alice', predicate: 'likes' },
        { id: 'e2', source: 'bob', target: 'acme', predicate: 'worksFor', label: 'works for' },
      ],
      meta: { name: 'tiny-kg', source: 'kgdiff.json', version: '2' },
    });
  });

  it('takes the label from label, then name, then title; the others stay attrs', () => {
    const { graph } = json({
      nodes: [
        { id: 'a', name: 'Name', title: 'Title' },
        { id: 'b', title: 'Only title' },
        { id: 'c', label: 'Label', name: 'Name' },
        { id: 'd', label: 42 },
      ],
      edges: [],
    });
    expect(graph.nodes).toEqual([
      { id: 'a', label: 'Name', attrs: { title: 'Title' } },
      { id: 'b', label: 'Only title' },
      { id: 'c', label: 'Label', attrs: { name: 'Name' } },
      { id: 'd', label: '42' },
    ]);
  });

  it('takes types from type, category or labels (Neo4j style) and aliases from aliases or synonyms', () => {
    const { graph } = json({
      nodes: [
        { id: 'a', labels: ['Person', 'Author', 'Person'] },
        { id: 'b', category: 'Gene', synonyms: ['TP53', 'p53'] },
        { id: 'c', type: { not: 'a type' } },
      ],
    });
    expect(graph.nodes).toEqual([
      { id: 'a', type: ['Author', 'Person'] },
      { id: 'b', type: 'Gene', aliases: ['TP53', 'p53'] },
      { id: 'c', attrs: { type: { not: 'a type' } } },
    ]);
  });

  it('lets explicit attrs win over loose fields with the same key', () => {
    const { graph } = json({ nodes: [{ id: 'a', color: 'red', attrs: { color: 'blue' } }] });
    expect(graph.nodes).toEqual([{ id: 'a', attrs: { color: 'blue' } }]);
  });

  it('keeps numeric ids as strings and never reads a label as the predicate', () => {
    const { graph } = json({
      nodes: [{ id: 1 }, { id: 2 }],
      edges: [{ id: 7, source: 1, target: 2, label: 'cites' }],
    });
    expect(graph.nodes).toEqual([{ id: '1' }, { id: '2' }]);
    expect(graph.edges).toEqual([{ id: '7', source: '1', target: '2', label: 'cites' }]);
  });

  it('accepts nodes without edges, empty graphs and unicode ids', () => {
    expect(json({ nodes: [] }).graph).toEqual({ nodes: [], edges: [] });
    expect(json({ nodes: [{ id: '投资|"a b"', label: '投资' }] }).graph.nodes).toEqual([
      { id: '投资|"a b"', label: '投资' },
    ]);
  });

  it('stays native when nodes carry a `data` attribute next to a top-level label', () => {
    const result = json({ nodes: [{ id: 'a', label: 'A', data: { raw: true } }] });
    expect(result.dialect).toBe('kgdiff');
    expect(result.graph.nodes).toEqual([{ id: 'a', label: 'A', attrs: { data: { raw: true } } }]);
  });

  it('keeps parallel edges and dangling endpoints for core to judge', () => {
    const { graph } = json({
      nodes: [{ id: 'a' }],
      edges: [
        { source: 'a', target: 'zz', predicate: 'p' },
        { source: 'a', target: 'zz', predicate: 'p' },
      ],
    });
    expect(graph.edges).toHaveLength(2);
  });
});

describe('d3 / NetworkX node-link JSON', () => {
  it('resolves link ends given as ids or as simulation node objects and drops simulation state', () => {
    const result = parseFixture('d3.json');
    expect(result.dialect).toBe('d3');
    expect(result.graph).toEqual({
      nodes: [
        { id: 'Mlle.Baptistine', attrs: { group: 1 } },
        { id: 'Myriel', attrs: { group: 1 } },
        { id: 'Napoleon', attrs: { group: 1 } },
        { id: 'Valjean', attrs: { group: 2 } },
      ],
      edges: [
        { source: 'Mlle.Baptistine', target: 'Myriel', attrs: { value: 8 } },
        { source: 'Napoleon', target: 'Myriel', attrs: { value: 1 } },
        { source: 'Valjean', target: 'Myriel', attrs: { value: 5 } },
      ],
      meta: { source: 'd3.json' },
    });
  });

  it('uses array indices as ids for d3 v3 data without ids, with a warning', () => {
    const result = parseFixture('d3-index.json');
    expect(result.graph.nodes).toEqual([
      { id: '0', label: 'Myriel', attrs: { group: 1 } },
      { id: '1', label: 'Napoleon', attrs: { group: 1 } },
      { id: '2', label: 'Mlle.Baptistine', attrs: { group: 1 } },
    ]);
    expect(result.graph.edges).toEqual([
      { source: '1', target: '0', attrs: { value: 1 } },
      { source: '2', target: '0', attrs: { value: 8 } },
    ]);
    expect(result.warnings).toEqual([
      {
        code: 'json-index-ids',
        message: '3 nodes without an id: using the array index as id (d3 index links).',
      },
    ]);
  });

  it('prefers numeric node ids over indices (NetworkX) and reads the graph name', () => {
    const result = parseFixture('networkx.json');
    expect(result.graph).toEqual({
      nodes: [
        { id: '0', attrs: { club: 'Mr. Hi' } },
        { id: '1', attrs: { club: 'Mr. Hi' } },
        { id: '33', attrs: { club: 'Officer' } },
      ],
      edges: [
        { source: '0', target: '1', attrs: { weight: 4 } },
        { source: '1', target: '33', attrs: { weight: 2 } },
      ],
      meta: { name: "Zachary's Karate Club", source: 'networkx.json' },
    });
  });

  it('resolves an index that is not a node id', () => {
    const { graph } = json({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 1, target: 0 }],
    });
    expect(graph.edges).toEqual([{ source: 'b', target: 'a' }]);
  });
});

describe('Cytoscape.js JSON', () => {
  it('reads cy.json() exports: data records, compound parents and the interaction type', () => {
    const result = parseFixture('cytoscape.json');
    expect(result.dialect).toBe('cytoscape');
    expect(result.graph).toEqual({
      nodes: [
        { id: 'complex', label: 'p53 complex' },
        { id: 'n1', label: 'TP53', type: 'protein', attrs: { score: 0.93 } },
        { id: 'n2', label: 'MDM2' },
      ],
      edges: [
        { id: 'e1', source: 'n2', target: 'n1', predicate: 'inhibits', attrs: { weight: 2 } },
        { source: 'n2', target: 'complex', predicate: 'parent' },
      ],
      meta: { name: 'Protein interactions', source: 'cytoscape.json' },
    });
  });

  it('reads element arrays with or without a group', () => {
    const result = parseFixture('cytoscape-elements.json');
    expect(result.dialect).toBe('cytoscape');
    expect(result.graph).toEqual({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ id: 'ab', source: 'a', target: 'b', predicate: 'links to', label: 'links to' }],
      meta: { source: 'cytoscape-elements.json' },
    });
    expect(
      json({ elements: [{ data: { id: 'x' } }, { data: { source: 'x', target: 'x' } }] }).graph,
    ).toEqual({ nodes: [{ id: 'x' }], edges: [{ source: 'x', target: 'x' }] });
  });

  it('recognises { nodes: [{ data }] } without the elements wrapper', () => {
    const result = json({
      nodes: [{ data: { id: 'a' } }, { data: { id: 'b' } }],
      edges: [{ data: { source: 'a', target: 'b' } }],
    });
    expect(result.dialect).toBe('cytoscape');
    expect(result.graph.edges).toEqual([{ source: 'a', target: 'b' }]);
  });
});

describe('AntV G6 v5 JSON', () => {
  it('reads data records, ignores shape types and styles, and maps combos to parent edges', () => {
    const result = parseFixture('g6.json');
    expect(result.dialect).toBe('g6');
    expect(result.graph).toEqual({
      nodes: [
        { id: 'edge-tier', label: 'Edge tier' },
        { id: 'gateway', label: 'API gateway', type: 'service', attrs: { cpu: 0.7 } },
        { id: 'orders', label: 'Orders' },
      ],
      edges: [
        {
          id: 'gateway->orders',
          source: 'gateway',
          target: 'orders',
          predicate: 'calls',
          attrs: { qps: 120 },
        },
        { source: 'gateway', target: 'edge-tier', predicate: 'parent' },
      ],
      meta: { source: 'g6.json' },
    });
  });
});

describe('graphology JSON', () => {
  it('keeps attributes that share a name with the edge ends', () => {
    const result = json({
      nodes: [{ key: 'a' }],
      edges: [{ source: 'a', target: 'a', attributes: { source: 'crossref' } }],
    });
    expect(result.graph.edges).toEqual([
      { source: 'a', target: 'a', attrs: { source: 'crossref' } },
    ]);
  });

  it('reads keys and attributes, drops sigma rendering attributes and keeps undirected edges', () => {
    const result = parseFixture('graphology.json');
    expect(result.dialect).toBe('graphology');
    expect(result.graph).toEqual({
      nodes: [
        { id: 'p1', label: 'Paper 1', attrs: { year: 2019 } },
        { id: 'p2', label: 'Paper 2', attrs: { year: 2021 } },
        { id: 'p3' },
      ],
      edges: [
        { id: 'c1', source: 'p2', target: 'p1', predicate: 'cites', attrs: { weight: 1 } },
        { source: 'p3', target: 'p1', attrs: { undirected: true } },
      ],
      meta: { name: 'Citations', source: 'graphology.json' },
    });
  });
});

describe('vis-network JSON', () => {
  it('reads from / to, uses group as type and drops visual options', () => {
    const result = parseFixture('vis.json');
    expect(result.dialect).toBe('vis');
    expect(result.graph).toEqual({
      nodes: [
        { id: '1', label: 'Server', type: 'infra', attrs: { title: '<b>Primary</b>' } },
        { id: '2', label: 'Client', type: 'app' },
      ],
      edges: [{ id: 'e1', source: '2', target: '1', predicate: 'requests', label: 'requests' }],
      meta: { source: 'vis.json' },
    });
  });
});

describe('JsonOptions.fields', () => {
  it('overrides id, label, type, source, target and predicate detection', () => {
    const result = json(
      {
        nodes: [
          { uid: 'u1', props: { displayName: 'One', kind: 'A' } },
          { uid: 'u2', props: { displayName: 'Two', kind: 'B' } },
        ],
        edges: [{ from_uid: 'u1', to_uid: 'u2', verb: 'follows', since: 2021 }],
      },
      {
        json: {
          fields: {
            id: 'uid',
            label: 'props.displayName',
            type: 'props.kind',
            source: 'from_uid',
            target: 'to_uid',
            predicate: 'verb',
          },
        },
      },
    );
    expect(result.graph).toEqual({
      nodes: [
        { id: 'u1', label: 'One', type: 'A', attrs: { props: { displayName: 'One', kind: 'A' } } },
        { id: 'u2', label: 'Two', type: 'B', attrs: { props: { displayName: 'Two', kind: 'B' } } },
      ],
      edges: [{ source: 'u1', target: 'u2', predicate: 'follows', attrs: { since: 2021 } }],
    });
  });

  it('looks fields up in the dialect record first (Cytoscape data)', () => {
    const result = json(
      { elements: { nodes: [{ data: { id: 'a', uid: 'A1' } }], edges: [] } },
      { json: { fields: { id: 'uid' } } },
    );
    expect(result.graph.nodes).toEqual([{ id: 'A1', attrs: { id: 'a' } }]);
  });
});

describe('JSON errors', () => {
  it('reports syntax errors with line and column', () => {
    const error = catchError(() =>
      parseGraph('{\n  "nodes": [\n    { "id": "a" },\n  ]\n}', { format: 'json' }),
    );
    expect(error.code).toBe('invalid-input');
    expect(error.message).toBe('Invalid JSON on line 4, column 3: expected a value, found "]".');
    expect(error.details).toEqual({ line: 4, column: 3 });
  });

  it('reports truncated input at its end', () => {
    const error = catchError(() => parseGraph('{"nodes": [', { format: 'json' }));
    expect(error.message).toBe(
      'Invalid JSON on line 1, column 12: expected a value, found end of input.',
    );
  });

  it.each([
    ['{"a" 1}', 1, 6, "expected ':'"],
    ["{'a': 1}", 1, 2, 'expected a property name in double quotes'],
    ['{"a": 1 "b": 2}', 1, 9, "expected ',' or '}'"],
    ['[1 2]', 1, 4, "expected ',' or ']'"],
    ['{"a": "tab\there"}', 1, 11, 'expected an escaped control character'],
    ['{"a": "\\x"}', 1, 9, 'expected an escape sequence'],
    ['{"a": "open', 1, 12, 'expected a closing quote'],
    ['{"a": tru}', 1, 7, 'expected a value'],
    ['{} {}', 1, 4, 'expected end of input'],
    ['\n\n  {"a": 01}', 3, 10, "expected ',' or '}'"],
  ])('locates %j at %i:%i', (text, line, column, expected) => {
    const error = catchError(() => parseGraph(text, { format: 'json' }));
    expect(error.message).toContain(`line ${line}, column ${column}: ${expected}`);
    expect(error.details).toEqual({ line, column });
  });

  it('explains which shapes are understood', () => {
    expect(catchError(() => json({ vertices: [] })).message).toMatch(
      /no `nodes` array; expected \{ nodes, edges \}.*\{ nodes, links \}.*\{ elements \}/,
    );
    expect(catchError(() => json([1, 2])).message).toMatch(/got an array/);
    expect(catchError(() => json('a string')).message).toMatch(/Unrecognized JSON graph/);
    expect(catchError(() => json({ nodes: {} })).message).toMatch(/`nodes` is not an array/);
    expect(catchError(() => json({ nodes: [], edges: {} })).message).toMatch(
      /`edges` must be an array/,
    );
  });

  it('hands JSON-LD to the JSON-LD reader', () => {
    const result = json({
      '@context': { ex: 'https://example.org/' },
      '@graph': [{ '@id': 'ex:a', 'ex:p': 1 }],
    });
    expect(result.format).toBe('jsonld');
    expect(result.dialect).toBeUndefined();
    expect(result.graph.nodes).toEqual([
      { id: 'https://example.org/a', attrs: { 'https://example.org/p': 1 } },
    ]);
  });

  it('names the element that has no id, source or target', () => {
    expect(catchError(() => json({ nodes: [{ id: 'a' }, { label: 'b' }] })).message).toBe(
      'nodes[1] has no id (expected `id` as a string or number).',
    );
    expect(catchError(() => json({ nodes: [{ id: true }] })).message).toMatch(
      /nodes\[0\] has no id/,
    );
    expect(catchError(() => json({ nodes: [], edges: [{ target: 'a' }] })).message).toBe(
      'edges[0] has no source (expected `source` as a node id).',
    );
    expect(catchError(() => json({ nodes: [], edges: [{ from: 'a', to: null }] })).message).toBe(
      'edges[0] has no target (expected `to` as a node id).',
    );
    expect(
      catchError(() => json({ elements: { nodes: [{ data: { label: 'x' } }] } })).message,
    ).toBe('elements.nodes[0] has no id (expected `data.id` as a string or number).');
    expect(catchError(() => json({ nodes: [{ attributes: {} }, { key: 'k' }] })).message).toMatch(
      /expected `key`/,
    );
    expect(catchError(() => json({ nodes: ['a'] })).message).toBe('nodes[0] is not an object.');
  });
});

describe('lone surrogates (RFC 0002, D-2)', () => {
  const reason = (written: string) =>
    `the escape ${written} is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept.`;

  it.each([
    ['{"nodes":[{"id":"\\ud800"}]}', 1, 18, '\\ud800'],
    ['{"nodes":[{"id":"\\udc00\\ud800"}]}', 1, 18, '\\udc00'],
    ['{"nodes":[{"id":"😀\\uD83D\\uDE00\\uD83D"}]}', 1, 32, '\\uD83D'],
    ['{"nodes":[{"id":"a","\\udfff":1}]}', 1, 22, '\\udfff'],
    ['{"nodes":[{"id":"\\ud83d\\u0041"}]}', 1, 18, '\\ud83d'],
    ['{"nodes":[{"id":"\\ud83d\\\\ude00"}]}', 1, 18, '\\ud83d'],
    ['{\n  "nodes": [\n    {"id": "x \\ud83d"}\n  ]\n}', 3, 15, '\\ud83d'],
  ])('rejects %j at %i:%i', (text, line, column, written) => {
    const error = catchError(() => parseGraph(text, { format: 'json' }));
    expect(error.code).toBe('invalid-input');
    expect(error.message).toBe(
      `Invalid JSON on line ${line}, column ${column}: ${reason(written)}`,
    );
    expect(error.details).toEqual({ line, column });
  });

  it('reports a lone surrogate before a later syntax error, and a syntax error before a later one', () => {
    expect(catchError(() => parseGraph('["\\ud83d", 1,]', { format: 'json' })).message).toBe(
      `Invalid JSON on line 1, column 3: ${reason('\\ud83d')}`,
    );
    expect(catchError(() => parseGraph('[1,, "\\ud83d"]', { format: 'json' })).message).toBe(
      'Invalid JSON on line 1, column 4: expected a value, found ",".',
    );
  });

  it('reads escaped surrogate pairs, as JSON.parse does', () => {
    const result = parseGraph('{"nodes":[{"id":"\\ud83d\\ude00","label":"\\uD83D\\uDE00 x"}]}');
    expect(result.graph.nodes).toEqual([{ id: '😀', label: '😀 x' }]);
  });

  it('rejects them in JSON-LD too', () => {
    const error = catchError(() =>
      parseGraph('{"@id":"https://example.org/a","https://example.org/p":"\\ud800"}'),
    );
    expect(error.message).toBe(`Invalid JSON on line 1, column 57: ${reason('\\ud800')}`);
  });
});

describe('numbers beyond the double range (RFC 0002, D-11)', () => {
  const warning = (count: number) => ({
    code: 'json-non-finite',
    message: `Kept ${count} ${count === 1 ? 'number' : 'numbers'} beyond the range of a double (such as 1e400) as the string "Infinity" or "-Infinity".`,
  });

  it('keeps them as "Infinity" / "-Infinity" in attrs, arrays and meta, with one warning', () => {
    const result = parseGraph(
      '{"meta":{"name":"g","big":1e400},"nodes":[{"id":"a","attrs":{"x":1e400,"y":[1,-1e400,{"z":2e999}]},"w":-1e309}],"edges":[{"source":"a","target":"a","attrs":{"e":1e400}}]}',
    );
    expect(result.graph.meta).toEqual({ big: 'Infinity', name: 'g' });
    expect(result.graph.nodes).toEqual([
      { id: 'a', attrs: { w: '-Infinity', x: 'Infinity', y: [1, '-Infinity', { z: 'Infinity' }] } },
    ]);
    expect(result.graph.edges).toEqual([{ source: 'a', target: 'a', attrs: { e: 'Infinity' } }]);
    expect(result.warnings).toEqual([warning(6)]);
  });

  it('warns about one with the singular, in every dialect', () => {
    const d3 = parseGraph('{"nodes":[{"id":"a","x":1,"weight":1e400}],"links":[]}');
    expect(d3.dialect).toBe('d3');
    expect(d3.graph.nodes).toEqual([{ id: 'a', attrs: { weight: 'Infinity' } }]);
    expect(d3.warnings).toContainEqual(warning(1));
  });

  it('leaves numbers that round to a finite double alone', () => {
    const result = parseGraph(
      '{"nodes":[{"id":"a","attrs":{"max":1.7976931348623157e308,"tiny":1e-400}}]}',
    );
    expect(result.graph.nodes).toEqual([
      { id: 'a', attrs: { max: 1.7976931348623157e308, tiny: 0 } },
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe('JSON input handling', () => {
  it('accepts a byte order mark', () => {
    expect(parseGraph('﻿{"nodes":[{"id":"a"}]}').graph.nodes).toEqual([{ id: 'a' }]);
  });

  it('does not mutate frozen options', () => {
    const options = deepFreeze({ format: 'json' as const, json: { fields: { id: 'key' } } });
    expect(parseGraph('{"nodes":[{"key":"a"}]}', options).graph.nodes).toEqual([{ id: 'a' }]);
  });

  it('sorts nested attribute object keys so key order in the file does not matter', () => {
    const a = json({ nodes: [{ id: 'x', meta: { b: 1, a: { d: 1, c: 2 } } }] });
    const b = json({ nodes: [{ meta: { a: { c: 2, d: 1 }, b: 1 }, id: 'x' }] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('kgdiff JSON round-trips core graphs', () => {
  /** Builds an object with own properties only, `__proto__` included. */
  const record = (entries: readonly (readonly [string, unknown])[]) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  const ids = ['a', 'b', 'c', 'x|y', '投资', 'with space', '"q"', '__proto__', 'http://ex.org/a'];
  const id = fc.constantFrom(...ids);
  const text = fc.constantFrom('A', 'B', 'label', 'a', '投资', '');
  const attrs = fc
    .array(
      fc.tuple(
        fc.constantFrom('k', 'name', 'type', 'label', '__proto__', 'constructor', '', 'é'),
        fc.jsonValue({ maxDepth: 3 }),
      ),
      { maxLength: 4 },
    )
    .map(record);
  const node = fc.record(
    {
      id,
      label: text,
      type: fc.array(fc.constantFrom('T', 'U', 'Person'), { maxLength: 3 }),
      aliases: fc.array(text, { maxLength: 3 }),
      attrs,
      deprecated: fc.boolean(),
      replaces: fc.array(id, { maxLength: 2 }),
      replacedBy: fc.array(id, { maxLength: 2 }),
    },
    { requiredKeys: ['id'] },
  );
  const edge = fc.record(
    {
      id: fc.constantFrom('e1', 'e2'),
      source: fc.oneof(id, fc.constant('dangling')),
      target: fc.oneof(id, fc.constant('dangling')),
      predicate: fc.constantFrom('', 'p', 'is_a', 'rdfs:subClassOf', 'part_of'),
      label: text,
      attrs,
    },
    { requiredKeys: ['source', 'target'] },
  );
  const graphs = fc.record({
    nodes: fc.array(node, { maxLength: 6 }),
    edges: fc.array(edge, { maxLength: 8 }),
  });

  it('reads graphToJSON output back to the same graph (hashGraph is preserved)', () => {
    fc.assert(
      fc.property(graphs, (input) => {
        const graph = normalize(input as GraphInput);
        const parsed = parseGraph(JSON.stringify(graphToJSON(graph)));
        expect(parsed.dialect).toBe('kgdiff');
        expect(hashGraph(normalize(parsed.graph))).toBe(hashGraph(graph));
      }),
      { numRuns: 300 },
    );
  });

  it('accepts types, implicit nodes and label-only edges as core writes them', () => {
    const graph = normalize({
      nodes: [
        { id: 'a', type: ['T', 'U'] },
        { id: 'b', type: 'T' },
      ],
      edges: [
        { source: 'a', target: 'b', label: 'holds' },
        { source: 'a', target: 'b', predicate: 'p' },
        { source: 'a', target: 'ghost', predicate: 'p' },
      ],
    });
    const json = graphToJSON(graph);
    expect(json.nodes).toContainEqual({ id: 'ghost', implicit: true });
    const { graph: parsed } = parseGraph(JSON.stringify(json));
    expect(parsed.nodes).toEqual([
      { id: 'a', type: ['T', 'U'] },
      { id: 'b', type: 'T' },
    ]);
    expect(parsed.edges).toContainEqual({ source: 'a', target: 'b', label: 'holds' });
    expect(hashGraph(normalize(parsed))).toBe(hashGraph(graph));
  });
});

describe('JSON prototype-named keys', () => {
  it('keeps __proto__ and constructor as ordinary attributes and meta keys', () => {
    const result = parseGraph(
      '{"meta":{"__proto__":{"m":1}},"nodes":[{"id":"a","__proto__":{"isAdmin":true},' +
        '"constructor":"c"},{"id":"b","attrs":{"__proto__":{"polluted":1}}}],"edges":[]}',
    );
    const [a, b] = result.graph.nodes;
    expect(Object.keys(a?.attrs ?? {})).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(a?.attrs)).toBe(Object.prototype);
    expect(JSON.stringify(a?.attrs)).toBe('{"__proto__":{"isAdmin":true},"constructor":"c"}');
    expect(JSON.stringify(b?.attrs)).toBe('{"__proto__":{"polluted":1}}');
    expect(Object.keys(result.graph.meta ?? {})).toContain('__proto__');
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it('never resolves field paths to inherited properties', () => {
    const result = json({ nodes: [{ id: 'a' }] }, { json: { fields: { label: 'constructor' } } });
    expect(result.graph.nodes).toEqual([{ id: 'a' }]);
  });
});

describe('JSON dialect detection', () => {
  it('reads kgdiff JSON with a `data` attribute as kgdiff, not G6', () => {
    const result = json({
      nodes: [
        { id: 'a', type: 'Person', data: { age: 3 } },
        { id: 'b', type: 'Org' },
      ],
      edges: [{ source: 'a', target: 'b', predicate: 'worksAt' }],
    });
    expect(result.dialect).toBe('kgdiff');
    expect(result.graph).toEqual({
      nodes: [
        { id: 'a', type: 'Person', attrs: { data: { age: 3 } } },
        { id: 'b', type: 'Org' },
      ],
      edges: [{ source: 'a', target: 'b', predicate: 'worksAt' }],
    });
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['d3.json', 'd3', 'index (2), vx (1), vy (1), x (1), y (1)'],
    ['cytoscape.json', 'cytoscape', 'SUID (1), classes (1), position (1), selected (1)'],
    ['g6.json', 'g6', 'style (2), type (2)'],
    ['graphology.json', 'graphology', 'color (1), size (1), x (1), y (1)'],
    ['vis.json', 'vis', 'arrows (1), color (1), dashes (1), shape (1), width (1), x (1), y (1)'],
  ])('%s reports the fields it drops', (name, dialect, fields) => {
    expect(parseFixture(name).warnings).toEqual([
      {
        code: 'json-ignored-fields',
        message: `Ignored ${dialect} fields that are not part of the graph: ${fields}.`,
      },
    ]);
  });

  it('reports nothing for dialects that map every field', () => {
    for (const name of ['kgdiff.json', 'networkx.json', 'cytoscape-elements.json']) {
      expect(parseFixture(name).warnings).toEqual([]);
    }
  });
});

describe('the kgdiff JSON marker', () => {
  const marker = { format: 'kgdiff.graph', version: 1 } as const;

  it('makes a graph kgdiff JSON even when its elements look like AntV G6', () => {
    const g6Like = { nodes: [{ id: 'a', data: { label: 'A' } }], edges: [] };
    expect(json(g6Like).dialect).toBe('g6');
    const result = json({ ...marker, ...g6Like });
    expect(result.dialect).toBe('kgdiff');
    expect(result.graph.nodes).toEqual([{ id: 'a', attrs: { data: { label: 'A' } } }]);
    expect(result.warnings).toEqual([]);
  });

  it('reads neither the marker nor $schema into the graph', () => {
    const schema = 'https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/graph.v1.json';
    const result = json({ $schema: schema, ...marker, nodes: [{ id: 'a' }], edges: [] });
    expect(result.graph).toEqual({ nodes: [{ id: 'a' }], edges: [] });
    expect(result.warnings).toEqual([]);
  });

  it('is recognised from the content alone', () => {
    const result = parseGraph(JSON.stringify({ ...marker, nodes: [{ id: 'a' }] }));
    expect(result).toMatchObject({ format: 'json', dialect: 'kgdiff' });
  });

  it.each([
    [
      { ...marker, version: 2 },
      'Unsupported kgdiff graph version 2; this reader supports version 1.',
    ],
    [
      { format: 'kgdiff.graph' },
      'Unsupported kgdiff graph version undefined; this reader supports version 1.',
    ],
    [
      { format: 'kgdiff.diff', version: 1 },
      'This is a kgdiff diff (format "kgdiff.diff", as `kgdiff --json` writes it), not a graph.',
    ],
    [
      { format: 'kgdiff.delta', version: 1 },
      'This is a kgdiff delta (format "kgdiff.delta"), not a graph: apply it to a graph with `kgdiff apply`.',
    ],
    [
      { format: 'kgdiff.patch', version: 1 },
      'Unknown kgdiff format "kgdiff.patch"; expected "kgdiff.graph".',
    ],
  ])('rejects %j', (envelope, message) => {
    const error = catchError(() => json({ ...envelope, nodes: [], edges: [] }));
    expect(error.code).toBe('unsupported-version');
    expect(error.message).toBe(message);
  });

  it('rejects the diffs and deltas kgdiff writes when they are read as a graph', () => {
    const result = diff({ nodes: [{ id: 'a' }], edges: [] }, { nodes: [{ id: 'b' }], edges: [] });
    for (const document of [diffToJSON(result), result.delta]) {
      const error = catchError(() => parseGraph(JSON.stringify(document)));
      expect(error.code).toBe('unsupported-version');
    }
  });

  it('needs a nodes array', () => {
    expect(catchError(() => json(marker)).code).toBe('invalid-input');
  });

  it("leaves a format field that is not kgdiff's to shape detection", () => {
    const result = json({ format: 'graphml', version: 3, nodes: [{ id: 'a' }], edges: [] });
    expect(result.dialect).toBe('kgdiff');
    expect(result.graph).toEqual({ nodes: [{ id: 'a' }], edges: [] });
  });
});

describe('JSON nesting', () => {
  const nested = (depth: number, close = true) =>
    `{"nodes":[{"id":"a","attrs":{"x":${'['.repeat(depth)}${close ? ']'.repeat(depth) : ''}}}]}`;

  it('accepts values nested up to 1000 levels', () => {
    expect(parseGraph(nested(990)).graph.nodes).toHaveLength(1);
  });

  it('rejects deeper values with a KgdiffError instead of overflowing the stack', () => {
    const valid = catchError(() => parseGraph(nested(20_000)));
    expect(valid.code).toBe('invalid-input');
    expect(valid.message).toBe('Values nested deeper than 1000 levels are not supported.');
    const invalid = catchError(() => parseGraph(nested(20_000, false)));
    expect(invalid.message).toBe(
      'Invalid JSON on line 1, column 1030: nested deeper than 1000 levels.',
    );
    expect(invalid.details).toEqual({ line: 1, column: 1030 });
  });
});
