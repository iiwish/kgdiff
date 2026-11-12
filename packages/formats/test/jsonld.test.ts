import { type GraphInput, hashGraph, type NodeInput, normalize } from '@kgdiff/core';
import { describe, expect, it, vi } from 'vitest';
import type { ParseOptions } from '../src/index.js';
import { parseGraph } from '../src/sync.js';
import { catchError, deepFreeze, parseFixture } from './helpers.js';

const EX = 'https://example.org/';
const CONTEXT = { ex: EX, rdfs: 'http://www.w3.org/2000/01/rdf-schema#' };

/** Inline JSON-LD with `ex:` also passed as a user prefix (as in the Turtle tests). */
const jsonld = (document: unknown, extra: ParseOptions = {}) =>
  parseGraph(JSON.stringify(document), {
    format: 'jsonld',
    ...extra,
    rdf: { prefixes: { ex: EX }, ...extra.rdf },
  });

const ttl = (body: string) =>
  parseGraph(
    `@prefix ex: <${EX}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n${body}`,
    { format: 'turtle', rdf: { prefixes: { ex: EX } } },
  );

const nodeById = (graph: GraphInput, id: string): NodeInput => {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};

const attrsOf = (graph: GraphInput, id: string) => nodeById(graph, id).attrs;
const triples = (graph: GraphInput) =>
  graph.edges.map((edge) => [edge.source, edge.predicate, edge.target]);
const graphHash = (graph: GraphInput) => hashGraph(normalize(graph));

describe('JSON-LD fixtures', () => {
  it('people.jsonld (@graph, @reverse, @list, language maps) is the people.ttl graph', () => {
    const result = parseFixture('people.jsonld');
    const turtle = parseFixture('people.ttl');
    expect(result.format).toBe('jsonld');
    expect(result.warnings).toEqual([]);
    expect(result.graph.nodes).toEqual(turtle.graph.nodes);
    expect(result.graph.edges).toEqual(turtle.graph.edges);
    expect(graphHash(result.graph)).toBe(graphHash(turtle.graph));
  });

  it('go-mini.jsonld (OWL restrictions, axioms, an intersection list) is the go-mini.ttl graph', () => {
    const result = parseFixture('go-mini.jsonld');
    const turtle = parseFixture('go-mini.ttl');
    expect(result.warnings).toEqual([]);
    expect(graphHash(result.graph)).toBe(graphHash(turtle.graph));
    expect(result.predicateLabels).toEqual(turtle.predicateLabels);
  });

  it('reports prefix-like context terms as prefixes, for display only', () => {
    const { prefixes } = parseFixture('people.jsonld');
    expect(prefixes.ex).toBe('https://example.org/people/');
    expect(prefixes).not.toHaveProperty('name');
  });
});

describe('JSON-LD keywords', () => {
  it('merges @graph objects with an @id into one graph, with a warning', () => {
    const result = jsonld({
      '@context': CONTEXT,
      '@id': 'ex:g',
      '@graph': [{ '@id': 'ex:a', 'ex:p': { '@id': 'ex:b' } }],
    });
    expect(triples(result.graph)).toEqual([[`${EX}a`, 'ex:p', `${EX}b`]]);
    expect(result.warnings).toEqual([
      { code: 'named-graphs', message: 'Merged 1 named graph into one graph.' },
    ]);
  });

  it('reads @reverse properties and reverse terms', () => {
    const { graph } = jsonld({
      '@context': { ...CONTEXT, parentOf: { '@reverse': 'ex:childOf', '@type': '@id' } },
      '@id': 'ex:a',
      parentOf: ['ex:b', 'ex:c'],
      '@reverse': { 'ex:knows': { '@id': 'ex:d' } },
    });
    expect(triples(graph)).toEqual([
      [`${EX}b`, 'ex:childOf', `${EX}a`],
      [`${EX}c`, 'ex:childOf', `${EX}a`],
      [`${EX}d`, 'ex:knows', `${EX}a`],
    ]);
  });

  it('reads @list as RDF lists: literals keep their order, resources become edges', () => {
    const result = jsonld({
      '@context': { ...CONTEXT, seq: { '@id': 'ex:seq', '@container': '@list' } },
      '@id': 'ex:a',
      seq: ['z', 1, 'a'],
      'ex:none': { '@list': [] },
      'ex:members': { '@list': [{ '@id': 'ex:b' }, { '@id': 'ex:c' }] },
    });
    expect(result.graph).toEqual(
      ttl('ex:a ex:seq ( "z" 1 "a" ) ; ex:none () ; ex:members ( ex:b ex:c ) .').graph,
    );
    expect(attrsOf(result.graph, `${EX}a`)).toEqual({ 'ex:none': [], 'ex:seq': ['z', 1, 'a'] });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['rdf-list-resources']);
  });

  it('expands @vocab, compact IRIs, @type coercion and the default language', () => {
    const a = jsonld(
      {
        '@context': {
          '@vocab': EX,
          '@language': 'en',
          rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
          friend: { '@type': '@id' },
          kind: { '@id': 'ex:kind', '@type': '@vocab' },
          code: { '@id': 'ex:code', '@language': null },
        },
        '@id': 'a',
        '@type': 'Person',
        'rdfs:label': 'Anne',
        friend: 'b',
        kind: 'Gold',
        code: 'X1',
      },
      { baseIRI: EX },
    ).graph;
    expect(a).toEqual(
      ttl(
        'ex:a a ex:Person ; rdfs:label "Anne"@en ; ex:friend ex:b ; ex:kind ex:Gold ; ex:code "X1" .',
      ).graph,
    );
  });

  it('maps native numbers, booleans and typed values to the XSD literals Turtle uses', () => {
    const a = jsonld({
      '@context': { ...CONTEXT, xsd: 'http://www.w3.org/2001/XMLSchema#' },
      '@id': 'ex:a',
      'ex:int': 42,
      'ex:big': 1e21,
      'ex:dec': 1.5,
      'ex:yes': true,
      'ex:date': { '@value': '2024-01-17', '@type': 'xsd:date' },
    }).graph;
    expect(attrsOf(a, `${EX}a`)).toEqual({
      'ex:big': 1e21,
      'ex:date': '2024-01-17',
      'ex:dec': 1.5,
      'ex:int': 42,
      'ex:yes': true,
    });
    expect(a).toEqual(
      ttl(
        'ex:a ex:int 42 ; ex:big 1.0E21 ; ex:dec 1.5E0 ; ex:yes true ; ex:date "2024-01-17"^^<http://www.w3.org/2001/XMLSchema#date> .',
      ).graph,
    );
  });

  it('reads language maps, index maps and id maps', () => {
    const { graph } = jsonld({
      '@context': {
        ...CONTEXT,
        label: { '@id': 'rdfs:label', '@container': '@language' },
        byIndex: { '@id': 'ex:item', '@container': '@index' },
        byId: { '@id': 'ex:member', '@container': '@id' },
      },
      '@id': 'ex:a',
      label: { en: 'Apple', zh: ['苹果', '林檎'], '@none': 'untagged' },
      byIndex: { first: { '@id': 'ex:i1' }, second: 'text' },
      byId: { 'ex:m1': { 'ex:v': 1 } },
    });
    const a = nodeById(graph, `${EX}a`);
    expect(a.label).toBe('untagged');
    expect(a.aliases).toEqual(['Apple', '林檎', '苹果']);
    expect(a.attrs).toEqual({ 'ex:item': 'text' });
    expect(triples(graph)).toEqual([
      [`${EX}a`, 'ex:item', `${EX}i1`],
      [`${EX}a`, 'ex:member', `${EX}m1`],
    ]);
    expect(attrsOf(graph, `${EX}m1`)).toEqual({ 'ex:v': 1 });
  });

  it('reads @json literals as canonical JSON', () => {
    const { graph } = jsonld({
      '@context': { ...CONTEXT, data: { '@id': 'ex:data', '@type': '@json' } },
      '@id': 'ex:a',
      data: { b: [1, 2.5, null], a: 'x' },
    });
    expect(attrsOf(graph, `${EX}a`)).toEqual({ 'ex:data': '{"a":"x","b":[1,2.5,null]}' });
  });

  it('reads @nest, @included, property-scoped and type-scoped contexts', () => {
    const { graph } = jsonld({
      '@context': {
        ...CONTEXT,
        details: '@nest',
        Book: { '@id': 'ex:Book', '@context': { title: 'ex:bookTitle' } },
        author: { '@id': 'ex:author', '@context': { name: 'ex:authorName' } },
      },
      '@id': 'ex:b1',
      '@type': 'Book',
      details: { title: 'Dune' },
      author: { '@id': 'ex:frank', name: 'Frank' },
      '@included': [{ '@id': 'ex:other', 'ex:v': 'x' }],
    });
    expect(attrsOf(graph, `${EX}b1`)).toEqual({ 'ex:bookTitle': 'Dune' });
    expect(attrsOf(graph, `${EX}frank`)).toEqual({ 'ex:authorName': 'Frank' });
    expect(attrsOf(graph, `${EX}other`)).toEqual({ 'ex:v': 'x' });
  });

  it('identifies blank nodes by content and context, whatever their labels', () => {
    const a = jsonld({
      '@context': CONTEXT,
      '@graph': [
        { '@id': 'ex:a', 'ex:p': { '@id': '_:x' } },
        { '@id': '_:x', 'ex:v': 'shared' },
        { '@id': 'ex:b', 'ex:p': { 'ex:v': 'own' } },
      ],
    }).graph;
    expect(a).toEqual(ttl('ex:a ex:p _:y . _:y ex:v "shared" . ex:b ex:p [ ex:v "own" ] .').graph);
  });

  it('counts a node described in several places once', () => {
    const { graph } = jsonld({
      '@context': CONTEXT,
      '@graph': [
        { '@id': 'ex:a', 'ex:p': { '@id': 'ex:b', 'ex:name': 'B' } },
        { '@id': 'ex:b', 'ex:name': 'B' },
      ],
    });
    expect(attrsOf(graph, `${EX}b`)).toEqual({ 'ex:name': 'B' });
  });
});

describe('JSON-LD IRIs and contexts', () => {
  it('resolves relative IRIs against @base or ParseOptions.baseIRI, and keeps them without one', () => {
    const document = { '@context': CONTEXT, '@id': 'doc#a', 'ex:p': { '@id': '../b' } };
    expect(triples(jsonld(document, { baseIRI: 'http://ex.org/x/y' }).graph)).toEqual([
      ['http://ex.org/x/doc#a', 'ex:p', 'http://ex.org/b'],
    ]);
    expect(
      triples(jsonld({ ...document, '@context': { ...CONTEXT, '@base': 'http://ex.org/' } }).graph),
    ).toEqual([['http://ex.org/doc#a', 'ex:p', 'http://ex.org/b']]);
    expect(triples(jsonld(document).graph)).toEqual([['doc#a', 'ex:p', '../b']]);
  });

  it('drops keys that map to no IRI, with one warning that names them', () => {
    const result = jsonld({ '@context': CONTEXT, '@id': 'ex:a', name: 'A', nodes: [], 'ex:ok': 1 });
    expect(attrsOf(result.graph, `${EX}a`)).toEqual({ 'ex:ok': 1 });
    expect(result.warnings).toEqual([
      {
        code: 'jsonld-unmapped-terms',
        message:
          'Dropped 2 JSON-LD keys that map to no IRI (no @context term or @vocab): "name", "nodes".',
      },
    ]);
  });

  it('never fetches remote contexts: without a documentLoader they are an error', () => {
    const caught = catchError(() =>
      jsonld({ '@context': 'https://schema.org/', '@id': 'ex:a', name: 'A' }),
    );
    expect(caught.code).toBe('invalid-input');
    expect(caught.message).toBe(
      'Invalid JSON-LD: loading remote context failed: "https://schema.org/" was not loaded, as kgdiff never fetches documents; inline the context, or pass ParseOptions.jsonld.documentLoader.',
    );
    expect(caught.details).toEqual({ format: 'jsonld', code: 'loading remote context failed' });
  });

  it('takes remote contexts from a synchronous documentLoader, once per URL', () => {
    const documentLoader = vi.fn((url: string) =>
      url === 'https://example.org/context.jsonld'
        ? JSON.stringify({ '@context': { '@vocab': EX } })
        : url === 'https://example.org/prefixes.jsonld'
          ? { '@context': { ex: EX } }
          : undefined,
    );
    const { graph } = jsonld(
      {
        '@context': ['https://example.org/context.jsonld', 'https://example.org/prefixes.jsonld'],
        '@graph': [
          { '@context': 'https://example.org/context.jsonld', '@id': 'ex:a', name: 'A' },
          { '@id': 'ex:b', name: 'B' },
        ],
      },
      { jsonld: { documentLoader } },
    );
    expect(attrsOf(graph, `${EX}a`)).toEqual({ 'ex:name': 'A' });
    expect(attrsOf(graph, `${EX}b`)).toEqual({ 'ex:name': 'B' });
    expect(documentLoader.mock.calls.map(([url]) => url)).toEqual([
      'https://example.org/context.jsonld',
      'https://example.org/prefixes.jsonld',
    ]);
  });

  it('rejects asynchronous loaders and missing remote documents with a clear message', () => {
    const run = (documentLoader: (url: string) => unknown) =>
      catchError(() =>
        jsonld(
          { '@context': 'https://example.org/c', '@id': 'ex:a' },
          { jsonld: { documentLoader } },
        ),
      ).message;
    expect(run(() => Promise.resolve({}))).toMatch(/documentLoader returned a Promise/);
    expect(run(() => '{"@context":{"ex":"\\ud83d"}}')).toBe(
      'Invalid JSON-LD: loading remote context failed: "https://example.org/c": the escape \\ud83d is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept.',
    );
    expect(run(() => undefined)).toMatch(
      /documentLoader has no document for "https:\/\/example\.org\/c"/,
    );
    expect(run(() => ({ notAContext: true }))).toMatch(/invalid remote context/);
    expect(
      run(() => {
        throw new Error('offline');
      }),
    ).toMatch(/"https:\/\/example\.org\/c": offline/);
  });

  it('enforces @protected terms and reports JSON-LD error codes', () => {
    const codeOf = (document: unknown) => catchError(() => jsonld(document)).details?.code;
    expect(
      codeOf({
        '@context': [{ '@protected': true, name: 'ex:name' }, { name: 'ex:other' }],
        name: 'x',
      }),
    ).toBe('protected term redefinition');
    expect(codeOf({ '@context': { term: { '@id': 42 } } })).toBe('invalid IRI mapping');
    expect(codeOf({ '@context': { '@id': 'ex:x' } })).toBe('keyword redefinition');
    expect(
      codeOf({ '@id': 'ex:a', 'ex:p': { '@value': 'x', '@language': 'en', '@type': 'ex:t' } }),
    ).toBe('invalid value object');
    expect(codeOf({ '@context': { a: 'b:c', b: 'a:d' }, a: 1 })).toBe('cyclic IRI mapping');
  });

  it('does not mutate the parsed document or frozen options', () => {
    const document = deepFreeze({ '@context': CONTEXT, '@id': 'ex:a', 'ex:p': [{ 'ex:q': 1 }] });
    const options = deepFreeze({ format: 'jsonld' as const, rdf: { languages: ['en'] } });
    expect(() => parseGraph(JSON.stringify(document), options)).not.toThrow();
  });
});

describe('JSON-LD input handling', () => {
  it('reads JSON-LD given as json (by extension or format), reporting jsonld', () => {
    const text = JSON.stringify({ '@context': CONTEXT, '@id': 'ex:a', 'ex:p': 1 });
    expect(parseGraph(text, { filename: 'data.json' }).format).toBe('jsonld');
    expect(parseGraph(text, { format: 'json' }).format).toBe('jsonld');
    expect(parseGraph(text).format).toBe('jsonld');
  });

  it('reports invalid JSON with its line and column', () => {
    const caught = catchError(() => parseGraph('{\n  "@id": "ex:a",\n}', { format: 'jsonld' }));
    expect(caught.message).toMatch(/^Invalid JSON on line 3, column 1/);
  });

  it('reads nesting up to the limit and rejects deeper documents', () => {
    // Written as text: JSON.stringify recurses, and on small stacks (CI runners) it overflows on
    // 5,000 levels before kgdiff sees the document. JSON.parse, which kgdiff uses, does not.
    const nested = (levels: number) =>
      parseGraph(
        `{"@context":${JSON.stringify(CONTEXT)},"ex:p":${'{"ex:p":'.repeat(levels - 1)}` +
          `{"ex:v":1}${'}'.repeat(levels - 1)}}`,
        { format: 'jsonld', rdf: { prefixes: { ex: EX } } },
      );
    expect(nested(190).graph.edges).toHaveLength(190);
    const caught = catchError(() => nested(5000));
    expect(caught.message).toBe('JSON-LD nested deeper than 200 levels is not supported.');
    expect(caught.details).toEqual({ format: 'jsonld' });
  });

  it('parses an empty document to an empty graph', () => {
    expect(jsonld({}).graph).toEqual({ nodes: [], edges: [] });
    expect(jsonld([]).graph).toEqual({ nodes: [], edges: [] });
  });
});
