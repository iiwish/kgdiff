import type { GraphInput, NodeInput } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import type { ParseOptions } from '../src/index.js';
import { parseGraph } from '../src/sync.js';
import { catchError, deepFreeze, fixture, parseFixture } from './helpers.js';

const PREFIXES = [
  '@prefix ex: <https://example.org/> .',
  '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix obo: <http://purl.obolibrary.org/obo/> .',
  '',
].join('\n');

/**
 * Inline Turtle with `ex:` also passed as a user prefix: user prefixes compact identities
 * (file declarations alone do not, see `RdfOptions.compactWith`), which keeps expectations short.
 */
const ttl = (body: string, options: ParseOptions = {}) =>
  parseGraph(PREFIXES + body, {
    format: 'turtle',
    ...options,
    rdf: { prefixes: { ex: 'https://example.org/' }, ...options.rdf },
  });

const nodeById = (graph: GraphInput, id: string): NodeInput => {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};

const withoutSource = (graph: GraphInput): GraphInput => {
  const { source: _source, ...meta } = graph.meta ?? {};
  return Object.keys(meta).length > 0
    ? { ...graph, meta }
    : { nodes: graph.nodes, edges: graph.edges };
};

const PEOPLE = 'https://example.org/people/';

describe('Turtle fixture (people)', () => {
  const result = parseFixture('people.ttl');
  const address = result.graph.nodes[0]?.id ?? '';

  it('maps resources, literals, types, labels and edges', () => {
    expect(result.format).toBe('turtle');
    expect(result.warnings).toEqual([]);
    expect(address).toMatch(/^_:b[0-9a-f]{14}$/);
    expect(result.graph).toEqual({
      nodes: [
        {
          id: address,
          attrs: { 'schema:addressCountry': 'GB', 'schema:addressLocality': 'Oxford' },
        },
        {
          id: 'http://schema.org/worksFor',
          label: 'works for',
        },
        {
          id: `${PEOPLE}alice`,
          label: 'Alice Liddell',
          type: ['foaf:Person', 'schema:Person'],
          aliases: ['Al', 'Alice', 'Alicia', '爱丽丝'],
          attrs: {
            'https://example.org/people/age': 27,
            'https://example.org/people/favouriteNumbers': [3, 7, 42],
            'https://example.org/people/nickname': 'Ally@en-gb',
            'https://example.org/people/verified': true,
            'schema:birthDate': '1852-05-04',
            'schema:height': 1.62,
          },
        },
        {
          id: `${PEOPLE}bob`,
          label: 'Bob',
          type: 'schema:Person',
          attrs: { 'https://example.org/people/score': '9007199254740993' },
        },
        { id: `${PEOPLE}carol`, label: 'Carol', aliases: ['卡罗尔'] },
      ],
      edges: [
        {
          source: `${PEOPLE}alice`,
          target: address,
          predicate: 'schema:address',
          label: 'address',
        },
        {
          source: `${PEOPLE}alice`,
          target: `${PEOPLE}bob`,
          predicate: 'schema:knows',
          label: 'knows',
        },
        {
          source: `${PEOPLE}alice`,
          target: `${PEOPLE}carol`,
          predicate: 'schema:knows',
          label: 'knows',
        },
        {
          source: `${PEOPLE}bob`,
          target: `${PEOPLE}alice`,
          predicate: 'schema:knows',
          label: 'knows',
        },
        {
          source: `${PEOPLE}carol`,
          target: 'https://example.org/org/acme',
          predicate: 'schema:worksFor',
          label: 'worksFor',
        },
      ],
      meta: { predicateLabels: { 'schema:worksFor': 'works for' }, source: 'people.ttl' },
    });
  });

  it('reports declared and well-known prefixes', () => {
    expect(result.prefixes).toMatchObject({
      ex: PEOPLE,
      schema: 'http://schema.org/',
      owl: 'http://www.w3.org/2002/07/owl#',
    });
    expect(Object.keys(result.prefixes)).toEqual([...Object.keys(result.prefixes)].sort());
  });
});

describe('RDF serializations', () => {
  const turtle = parseFixture('people.ttl').graph;

  it('N-Triples gives the same graph as Turtle (statement order does not matter)', () => {
    const result = parseFixture('people.nt');
    expect(result.format).toBe('ntriples');
    expect(result.warnings).toEqual([]);
    expect(withoutSource(result.graph)).toEqual(withoutSource(turtle));
  });

  it('N-Quads merges named graphs into the same graph, with a warning', () => {
    const result = parseFixture('people.nq');
    expect(result.format).toBe('nquads');
    expect(withoutSource(result.graph)).toEqual(withoutSource(turtle));
    expect(result.warnings).toEqual([
      { code: 'named-graphs', message: 'Merged 2 named graphs into one graph.' },
    ]);
  });

  it('TriG merges default and named graphs into the same graph, with a warning', () => {
    const result = parseFixture('people.trig');
    expect(result.format).toBe('trig');
    expect(withoutSource(result.graph)).toEqual(withoutSource(turtle));
    expect(result.warnings.map((warning) => warning.code)).toEqual(['named-graphs']);
  });

  it('uses prefixes declared in the file for display only, unless compactWith is declared', () => {
    const result = parseFixture('people.ttl');
    expect(result.prefixes.ex).toBe(PEOPLE);
    expect(nodeById(result.graph, `${PEOPLE}alice`).attrs).toHaveProperty([`${PEOPLE}age`], 27);
    const declared = parseFixture('people.ttl', { rdf: { compactWith: 'declared' } });
    expect(nodeById(declared.graph, `${PEOPLE}alice`).attrs).toHaveProperty(['ex:age'], 27);
    expect(parseFixture('people.nt', { rdf: { prefixes: { ex: PEOPLE } } }).graph.nodes).toEqual(
      declared.graph.nodes,
    );
  });

  it('compacts predicates with well-known prefixes even without declarations', () => {
    const result = parseFixture('people.nt');
    expect(result.graph.edges.map((edge) => edge.predicate)).toContain('schema:knows');
    expect(nodeById(result.graph, `${PEOPLE}alice`).attrs).toHaveProperty([`${PEOPLE}age`], 27);
  });
});

describe('RDF literals', () => {
  it('types XSD numbers and booleans, keeping unparseable or unsafe lexical forms as text', () => {
    const { graph } = ttl(`
      ex:a ex:int 42 ; ex:neg "-7"^^xsd:int ; ex:dec 1.50 ; ex:dbl 1.5e3 ; ex:float "2.5"^^xsd:float ;
        ex:yes true ; ex:no "0"^^xsd:boolean ; ex:big "123456789012345678901"^^xsd:integer ;
        ex:inf "INF"^^xsd:double ; ex:bad "abc"^^xsd:integer ; ex:date "2024-01-17"^^xsd:date ;
        ex:custom "x"^^ex:myType ; ex:text "plain" ; ex:typed "typed"^^xsd:string ; ex:empty "" .`);
    expect(nodeById(graph, 'https://example.org/a').attrs).toEqual({
      'ex:bad': 'abc',
      'ex:big': '123456789012345678901',
      'ex:custom': 'x',
      'ex:date': '2024-01-17',
      'ex:dbl': 1500,
      'ex:dec': 1.5,
      'ex:empty': '',
      'ex:float': 2.5,
      'ex:inf': 'INF',
      'ex:int': 42,
      'ex:neg': -7,
      'ex:no': false,
      'ex:text': 'plain',
      'ex:typed': 'typed',
      'ex:yes': true,
    });
  });

  it('writes language-tagged values as "text@lang"', () => {
    const { graph } = ttl('ex:a ex:note "bonjour"@fr, "hello"@en-US, "salut"@fr-CA--rtl .');
    expect(nodeById(graph, 'https://example.org/a').attrs).toEqual({
      'ex:note': ['bonjour@fr', 'hello@en-us', 'salut@fr-ca'],
    });
  });

  it('collects repeated values into a sorted, de-duplicated array', () => {
    const { graph } = ttl('ex:a ex:v "b", "a", 10, 9, true, "c", "a", "01"^^xsd:integer, 1 .');
    expect(nodeById(graph, 'https://example.org/a').attrs).toEqual({
      'ex:v': [true, 1, 9, 10, 'a', 'b', 'c'],
    });
  });

  it('keeps unicode, very long and multi-line strings intact', () => {
    const long = 'x'.repeat(10_000);
    const { graph } = ttl(
      `ex:a rdfs:label "投资 🧬" ; ex:long "${long}" ; ex:multi """line 1\nline "2" end""" .`,
    );
    expect(nodeById(graph, 'https://example.org/a')).toEqual({
      id: 'https://example.org/a',
      label: '投资 🧬',
      attrs: { 'ex:long': long, 'ex:multi': 'line 1\nline "2" end' },
    });
  });
});

describe('RDF labels and aliases', () => {
  const multilingual = `
    ex:heart rdfs:label "Herz"@de, "heart"@en, "心脏"@zh-Hans, "Heart"@en-GB ;
      skos:prefLabel "cardiac organ" ;
      skos:altLabel "cor"@la, "ticker" .`;

  it('prefers untagged, then English, then any language; the rest become aliases', () => {
    const node = nodeById(ttl(multilingual).graph, 'https://example.org/heart');
    expect(node.label).toBe('cardiac organ');
    expect(node.aliases).toEqual(['Heart', 'Herz', 'cor', 'heart', 'ticker', '心脏']);
  });

  it('prefers exact language tags over subtags, then predicate priority', () => {
    const node = nodeById(
      ttl('ex:a rdfs:label "UK"@en-GB, "US"@en ; skos:prefLabel "Pref"@en .').graph,
      'https://example.org/a',
    );
    expect(node.label).toBe('US');
  });

  it('follows RdfOptions.languages, with subtag matching', () => {
    const zh = nodeById(
      ttl(multilingual, { rdf: { languages: ['zh', 'en'] } }).graph,
      'https://example.org/heart',
    );
    expect(zh.label).toBe('心脏');
    const de = nodeById(
      ttl(multilingual, { rdf: { languages: ['DE'] } }).graph,
      'https://example.org/heart',
    );
    expect(de.label).toBe('Herz');
    const fr = nodeById(
      ttl(multilingual, { rdf: { languages: ['fr'] } }).graph,
      'https://example.org/heart',
    );
    expect(fr.label).toBe('cardiac organ');
    const enFirst = nodeById(
      ttl(multilingual, { rdf: { languages: ['en', ''] } }).graph,
      'https://example.org/heart',
    );
    expect(enFirst.label).toBe('heart');
  });

  it('breaks ties lexicographically, independent of statement order', () => {
    const a = ttl('ex:a rdfs:label "beta", "alpha" .').graph;
    const b = ttl('ex:a rdfs:label "alpha", "beta" .').graph;
    expect(nodeById(a, 'https://example.org/a')).toEqual({
      id: 'https://example.org/a',
      label: 'alpha',
      aliases: ['beta'],
    });
    expect(a).toEqual(b);
  });

  it('falls back to the compact IRI, or the id itself, when there is no label', () => {
    const { graph } = ttl(
      'ex:a ex:p <http://other.org/b> . <http://other.org/b> ex:p obo:GO_1 . obo:GO_1 ex:p ex:a .',
    );
    expect(graph.nodes).toEqual([
      { id: 'GO:1' },
      { id: 'http://other.org/b' },
      { id: 'https://example.org/a', label: 'ex:a' },
    ]);
  });

  it('accepts custom label and alias predicates as CURIEs or IRIs', () => {
    const { graph } = ttl('ex:a ex:title "Title" ; rdfs:label "Label" ; ex:aka "AKA" .', {
      rdf: {
        labelPredicates: ['ex:title', 'http://www.w3.org/2000/01/rdf-schema#label'],
        aliasPredicates: ['ex:aka'],
      },
    });
    expect(nodeById(graph, 'https://example.org/a')).toEqual({
      id: 'https://example.org/a',
      label: 'Title',
      aliases: ['AKA', 'Label'],
    });
  });

  it('expands undeclared OBO-style CURIEs in options to OBO PURLs', () => {
    const { graph } = ttl('obo:GO_1 obo:IAO_0000118 "alternative" ; rdfs:label "label" .', {
      rdf: { labelPredicates: ['IAO:0000118'] },
    });
    // rdfs:label is no longer a label predicate here, so it is an ordinary attribute.
    expect(graph.nodes).toEqual([
      { id: 'GO:1', label: 'alternative', attrs: { 'rdfs:label': 'label' } },
    ]);
  });

  it('keeps edge labels independent of property declarations', () => {
    const plain = ttl('ex:a ex:part_of ex:b .');
    const declared = ttl('ex:a ex:part_of ex:b . ex:part_of rdfs:label "is part of"@en .');
    expect(declared.graph.edges).toEqual(plain.graph.edges);
    expect(plain.graph.edges[0]?.label).toBe('part of');
    expect(declared.predicateLabels).toEqual({ 'ex:part_of': 'is part of' });
    expect(declared.graph.meta).toEqual({ predicateLabels: { 'ex:part_of': 'is part of' } });
    expect(plain.predicateLabels).toEqual({});
  });

  it('treats prototype-named prefixes and id spaces as ordinary names', () => {
    // `constructor` is inherited by every object; it must not count as a declared prefix.
    expect(ttl('ex:a obo:constructor_1 ex:b .').graph.edges[0]?.predicate).toBe('constructor:1');
    const prefixes = JSON.parse('{"__proto__": "https://example.org/"}') as Record<string, string>;
    const result = parseGraph('<https://example.org/a> <https://example.org/p> "v" .', {
      format: 'ntriples',
      rdf: { prefixes },
    });
    expect(result.graph.nodes[0]?.attrs).toEqual(JSON.parse('{"__proto__:p": "v"}'));
    expect(Object.hasOwn(result.prefixes, '__proto__')).toBe(true);
  });

  it('treats http and https schema.org names alike', () => {
    const { graph } = ttl(
      'ex:a <http://schema.org/name> "http" . ex:b <https://schema.org/name> "https" .',
    );
    expect(graph.nodes.map((node) => node.label)).toEqual(['http', 'https']);
  });

  it('never turns label or alias predicates into attrs or edges', () => {
    const { graph } = ttl('ex:a rdfs:label ex:b ; skos:altLabel ex:c ; rdfs:label "A" .');
    expect(graph).toEqual({ nodes: [{ id: 'https://example.org/a', label: 'A' }], edges: [] });
  });
});

describe('RDF types, deprecation and replacements', () => {
  it('maps rdf:type to compact types, not edges, unless typeEdges is set', () => {
    const body = 'ex:a a owl:Class, ex:Gene ; rdf:type ex:Gene .';
    expect(ttl(body).graph).toEqual({
      nodes: [{ id: 'https://example.org/a', label: 'ex:a', type: ['ex:Gene', 'owl:Class'] }],
      edges: [],
    });
    expect(ttl(body, { rdf: { typeEdges: true } }).graph.edges).toEqual([
      {
        source: 'https://example.org/a',
        target: 'http://www.w3.org/2002/07/owl#Class',
        predicate: 'rdf:type',
        label: 'type',
      },
      {
        source: 'https://example.org/a',
        target: 'https://example.org/Gene',
        predicate: 'rdf:type',
        label: 'type',
      },
    ]);
  });

  it('reads owl:deprecated and IAO:0100001 (term replaced by), as IRI or string', () => {
    const { graph } = ttl(`
      obo:GO_1 owl:deprecated true ; obo:IAO_0100001 obo:GO_2 .
      obo:GO_3 owl:deprecated "true"^^xsd:boolean ; obo:IAO_0100001 "GO:4", "http://purl.obolibrary.org/obo/GO_5" .
      obo:GO_6 owl:deprecated false .`);
    expect(graph.nodes).toEqual([
      { id: 'GO:1', deprecated: true, replacedBy: ['GO:2'] },
      { id: 'GO:3', deprecated: true, replacedBy: ['GO:4', 'GO:5'] },
      { id: 'GO:6' },
    ]);
    expect(graph.edges).toEqual([]);
  });
});

describe('RDF lists', () => {
  it('collapses literal lists into ordered attr arrays (rdf:nil is an empty list)', () => {
    const { graph } = ttl('ex:a ex:seq ( "z" 1 "a" ) ; ex:none () .');
    expect(nodeById(graph, 'https://example.org/a').attrs).toEqual({
      'ex:none': [],
      'ex:seq': ['z', 1, 'a'],
    });
    expect(graph.nodes).toHaveLength(1);
  });

  it('sorts multi-valued lists and mixed values canonically', () => {
    const { graph } = ttl('ex:a ex:p (3) , (1 2) ; ex:b false, true, "x", 2 .');
    expect(nodeById(graph, 'https://example.org/a').attrs).toEqual({
      'ex:b': [false, true, 2, 'x'],
      'ex:p': [[1, 2], [3]],
    });
  });

  it('maps lists of resources to unordered edges, with one warning', () => {
    const result = ttl('ex:a ex:members ( ex:b ex:c ) . ex:d ex:members ( ex:e "lit" ) .');
    expect(result.graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ['https://example.org/a', 'https://example.org/b'],
      ['https://example.org/a', 'https://example.org/c'],
      ['https://example.org/d', 'https://example.org/e'],
    ]);
    expect(nodeById(result.graph, 'https://example.org/d').attrs).toEqual({ 'ex:members': 'lit' });
    expect(result.warnings).toEqual([
      {
        code: 'rdf-list-resources',
        message: '2 RDF lists of resources mapped to unordered edges (item order is not kept).',
      },
    ]);
  });
});

describe('RDF blank nodes', () => {
  const idOf = (graph: GraphInput) => graph.edges.find((edge) => edge.predicate === 'ex:p')?.target;

  it('gets content-hashed ids that do not depend on blank node labels or parser state', () => {
    const a = ttl('ex:a ex:p _:x . _:x ex:q "v" .').graph;
    const b = ttl('ex:a ex:p _:other . _:other ex:q "v" .').graph;
    const c = ttl('ex:a ex:p [ ex:q "v" ] .').graph;
    expect(idOf(a)).toMatch(/^_:b[0-9a-f]{14}$/);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('gets different ids for different content, recursively', () => {
    const id = (inner: string) => idOf(ttl(`ex:a ex:p [ ex:q [ ex:r "${inner}" ] ] .`).graph);
    expect(id('one')).not.toBe(id('two'));
    expect(id('one')).toBe(id('one'));
  });

  it('hashes cyclic blank structures deterministically', () => {
    const cycle = (first: string, second: string) =>
      ttl(
        `ex:a ex:p _:${first} . _:${first} ex:next _:${second} ; ex:v 1 . _:${second} ex:next _:${first} ; ex:v 2 .`,
      ).graph;
    const a = cycle('x', 'y');
    expect(a).toEqual(cycle('m', 'n'));
    expect(a.nodes.filter((node) => node.id.startsWith('_:b'))).toHaveLength(2);
    expect(ttl('ex:a ex:p _:s . _:s ex:self _:s .').graph.edges).toHaveLength(2);
  });

  it('keeps blank node cycles that nothing else points to', () => {
    const { graph } = ttl('_:a ex:next _:b ; ex:v 1 . _:b ex:next _:a ; ex:v 2 .');
    expect(graph.nodes.map((node) => node.attrs)).toEqual(
      expect.arrayContaining([{ 'ex:v': 1 }, { 'ex:v': 2 }]),
    );
    expect(graph.edges).toHaveLength(2);
  });

  it('emits unreferenced blank nodes as nodes of their own', () => {
    const { graph } = ttl('[] a ex:Note ; rdfs:label "a note" .');
    expect(graph.nodes).toEqual([
      { id: expect.stringMatching(/^_:b/), label: 'a note', type: 'ex:Note' },
    ]);
  });

  it('hashes long lists inside blank nodes without deep recursion', () => {
    const items = Array.from({ length: 20_000 }, (_, i) => `ex:item${i}`).join(' ');
    const { graph } = ttl(`ex:a ex:p [ ex:members ( ${items} ) ] .`);
    expect(graph.edges).toHaveLength(20_001);
  });

  it('hashes deeply nested blank nodes without recursion limits', () => {
    const nested = (depth: number) =>
      `ex:a ex:p ${'[ ex:q '.repeat(depth)}"leaf"${' ]'.repeat(depth)} .`;
    const { graph } = ttl(nested(20_000));
    expect(graph.nodes).toHaveLength(20_001);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(20_001);
  });

  it('identifies tree-shaped blank nodes by their context, not just their content', () => {
    const { graph } = ttl(
      'ex:alice ex:knows [] . ex:bob ex:knows [] . ex:carol ex:knows [ ex:v 1 ] .',
    );
    const targets = graph.edges.map((edge) => edge.target);
    expect(new Set(targets).size).toBe(3);
    expect(graph.nodes.filter((node) => node.id.startsWith('_:b'))).toHaveLength(3);
    // Same parent, predicate and content in another file → same id.
    const again = ttl('ex:bob ex:knows [] .').graph.edges[0]?.target;
    expect(targets).toContain(again);
  });

  it('identifies shared blank nodes by content alone', () => {
    const shared = ttl('ex:a ex:p _:x . ex:b ex:p _:x . _:x ex:v 1 .').graph;
    const alone = ttl('ex:c ex:q _:y . ex:d ex:q _:y . _:y ex:v 1 .').graph;
    const id = (graph: GraphInput) => graph.nodes.find((node) => node.id.startsWith('_:b'))?.id;
    expect(id(shared)).toBe(id(alone));
    expect(shared.edges.map((edge) => edge.target)).toEqual([id(shared), id(shared)]);
  });

  it('merges structurally identical blank nodes under the same parent and predicate', () => {
    const { graph } = ttl('ex:a ex:p [ ex:q ex:b ] , [ ex:q ex:b ] .');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
  });
});

describe('RDF options and input handling', () => {
  it('resolves relative IRIs against baseIRI and @base', () => {
    expect(
      parseGraph('<a> <p> <b> .', { format: 'turtle', baseIRI: 'http://ex.org/x/' }).graph.edges,
    ).toEqual([
      {
        source: 'http://ex.org/x/a',
        target: 'http://ex.org/x/b',
        predicate: 'http://ex.org/x/p',
        label: 'p',
      },
    ]);
    expect(parseGraph('@base <http://ex.org/> .\n<a> <p> <b> .').graph.edges[0]?.source).toBe(
      'http://ex.org/a',
    );
  });

  it('uses RdfOptions.prefixes for identities and display, ahead of declared names', () => {
    const result = ttl('ex:a ex:p ex:b .', { rdf: { prefixes: { my: 'https://example.org/' } } });
    expect(result.graph.edges).toEqual([
      {
        source: 'https://example.org/a',
        target: 'https://example.org/b',
        predicate: 'my:p',
        label: 'p',
      },
    ]);
    expect(result.prefixes.my).toBe('https://example.org/');
  });

  it('keeps well-known names when a file declares a namespace under another name', () => {
    const result = parseGraph(
      '@prefix s: <http://www.w3.org/2000/01/rdf-schema#> .\n<http://a> s:subClassOf <http://b> .',
    );
    expect(result.graph.edges[0]?.predicate).toBe('rdfs:subClassOf');
  });

  it('handles self-loops, parallel predicates and the owl:Ontology reference as a value', () => {
    const { graph } = ttl(`
      <http://ex.org/onto> a owl:Ontology .
      ex:a ex:p ex:a ; ex:q ex:a ; rdfs:isDefinedBy <http://ex.org/onto> .`);
    expect(graph.edges.map((edge) => [edge.source, edge.predicate, edge.target])).toEqual([
      ['https://example.org/a', 'ex:p', 'https://example.org/a'],
      ['https://example.org/a', 'ex:q', 'https://example.org/a'],
    ]);
    expect(nodeById(graph, 'https://example.org/a').attrs).toEqual({
      'rdfs:isDefinedBy': 'http://ex.org/onto',
    });
  });

  it('de-duplicates repeated triples', () => {
    const { graph } = ttl('ex:a ex:p ex:b , ex:b ; ex:v 1, 1 .\nex:a ex:p ex:b .');
    expect(graph.edges).toHaveLength(1);
    expect(nodeById(graph, 'https://example.org/a').attrs).toEqual({ 'ex:v': 1 });
  });

  it('reads repeated triples as one before recognising structures (a graph is a set)', () => {
    const restriction =
      '_:r a owl:Restriction ; owl:onProperty obo:BFO_0000050 ; owl:someValuesFrom ex:d .';
    const once = ttl(`ex:c rdfs:subClassOf _:r . ${restriction}`).graph;
    const twice = ttl(`ex:c rdfs:subClassOf _:r . ${restriction} ${restriction}`).graph;
    expect(twice).toEqual(once);
    expect(once.edges).toEqual([
      {
        source: 'https://example.org/c',
        target: 'https://example.org/d',
        predicate: 'BFO:0000050',
        label: 'BFO:0000050',
      },
    ]);
    const values = Array.from({ length: 40 }, (_, i) => `"v${i % 20}"`).join(', ');
    expect(
      nodeById(ttl(`ex:a ex:v ${values} .`).graph, 'https://example.org/a').attrs?.['ex:v'],
    ).toHaveLength(20);
  });

  it('parses an empty document to an empty graph', () => {
    expect(parseGraph('', { format: 'ntriples' }).graph).toEqual({ nodes: [], edges: [] });
    expect(parseGraph('# only a comment\n', { format: 'turtle' }).graph).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it('does not mutate frozen options', () => {
    const options = deepFreeze({
      format: 'turtle' as const,
      rdf: {
        languages: ['en'],
        labelPredicates: ['rdfs:label'],
        prefixes: { e: 'https://example.org/' },
      },
    });
    expect(parseGraph(`${PREFIXES}ex:a rdfs:label "A"@en .`, options).graph.nodes).toEqual([
      { id: 'https://example.org/a', label: 'A' },
    ]);
  });
});

describe('RDF syntax errors', () => {
  it('report the format and line', () => {
    const error = catchError(() =>
      parseGraph('@prefix ex: <http://ex.org/> .\n\nex:a ex:b .\n', { format: 'turtle' }),
    );
    expect(error.code).toBe('invalid-input');
    expect(error.message).toBe('Invalid Turtle: Expected entity but got . on line 3.');
    expect(error.details).toEqual({ format: 'turtle', line: 3 });
  });

  it('report lexer errors with their line', () => {
    const error = catchError(() =>
      parseGraph('<http://a> <http://b> <http://c> .\n<http://a> <http://b> "unterminated .\n', {
        format: 'ntriples',
      }),
    );
    expect(error.message).toMatch(/^Invalid N-Triples: .* on line 2\.$/);
    expect(error.details).toMatchObject({ line: 2 });
  });

  it('reject prefixed names in N-Triples and graphs in Turtle with a hint', () => {
    expect(
      catchError(() => parseGraph(fixture('people.ttl'), { format: 'ntriples' })).message,
    ).toMatch(/^Invalid N-Triples: .*line \d+\.$/);
    expect(
      catchError(() => parseGraph(fixture('people.trig'), { format: 'turtle' })).message,
    ).toMatch(/Named graphs need TriG/);
  });

  it('reject unknown format ids', () => {
    expect(catchError(() => parseGraph('', { format: 'owlxml' as never })).message).toBe(
      'Unknown format "owlxml". Expected auto, json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo.',
    );
  });
});
