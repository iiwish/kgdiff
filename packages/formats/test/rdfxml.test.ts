import { type GraphInput, hashGraph, type NodeInput, normalize } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import type { ParseOptions } from '../src/index.js';
import { parseGraph } from '../src/sync.js';
import { catchError, fixture, parseFixture } from './helpers.js';

const NAMESPACES =
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
  'xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" ' +
  'xmlns:owl="http://www.w3.org/2002/07/owl#" ' +
  'xmlns:ex="https://example.org/"';

const options = (extra: ParseOptions = {}): ParseOptions => ({
  ...extra,
  rdf: { prefixes: { ex: 'https://example.org/' }, ...extra.rdf },
});

/** Inline RDF/XML inside an `rdf:RDF` root, with `ex:` as a user prefix (as in owl.test.ts). */
const xml = (body: string, extra: ParseOptions = {}, rootAttributes = '') =>
  parseGraph(
    `<?xml version="1.0"?>\n<rdf:RDF ${NAMESPACES}${rootAttributes}>\n${body}\n</rdf:RDF>`,
    {
      format: 'rdfxml',
      ...options(extra),
    },
  );

const ttl = (body: string, extra: ParseOptions = {}) =>
  parseGraph(
    [
      '@prefix ex: <https://example.org/> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      body,
    ].join('\n'),
    { format: 'turtle', ...options(extra) },
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

describe('RDF/XML fixtures', () => {
  it('people.rdf is the people.ttl graph (DTD entities, nodeID, parseType="Resource")', () => {
    const rdfxml = parseFixture('people.rdf');
    const turtle = parseFixture('people.ttl');
    expect(rdfxml.format).toBe('rdfxml');
    expect(rdfxml.warnings).toEqual([]);
    expect(rdfxml.graph.nodes).toEqual(turtle.graph.nodes);
    expect(rdfxml.graph.edges).toEqual(turtle.graph.edges);
    expect(graphHash(rdfxml.graph)).toBe(graphHash(turtle.graph));
  });

  it('go-mini.owl (OWL API output) is the go-mini.ttl graph', () => {
    const owl = parseFixture('go-mini.owl');
    const turtle = parseFixture('go-mini.ttl');
    expect(owl.format).toBe('rdfxml');
    expect(owl.warnings).toEqual([]);
    expect(graphHash(owl.graph)).toBe(graphHash(turtle.graph));
    const { source: _owl, ...owlMeta } = owl.graph.meta ?? {};
    const { source: _ttl, ...ttlMeta } = turtle.graph.meta ?? {};
    expect(owlMeta).toEqual(ttlMeta);
    expect(owl.predicateLabels).toEqual(turtle.predicateLabels);
  });

  it('reports namespace declarations as prefixes, for display only', () => {
    const { prefixes } = parseFixture('people.rdf');
    expect(prefixes.ex).toBe('https://example.org/people/');
    expect(prefixes.schema).toBe('http://schema.org/');
    expect(parseFixture('go-mini.owl').prefixes['']).toBe('http://purl.obolibrary.org/obo/go.owl#');
  });
});

describe('RDF/XML node and property elements', () => {
  it('reads typed node elements, rdf:type and property attributes', () => {
    const a = xml(
      `<ex:Person rdf:about="https://example.org/a" ex:nick="Al" rdf:type="https://example.org/Agent">
         <rdf:type rdf:resource="https://example.org/Thing"/>
         <ex:knows><ex:Person rdf:about="https://example.org/b"/></ex:knows>
       </ex:Person>`,
    ).graph;
    const b = ttl(
      'ex:a a ex:Person, ex:Agent, ex:Thing ; ex:nick "Al" ; ex:knows ex:b . ex:b a ex:Person .',
    ).graph;
    expect(a).toEqual(b);
    expect(nodeById(a, 'https://example.org/a').type).toEqual([
      'ex:Agent',
      'ex:Person',
      'ex:Thing',
    ]);
  });

  it('reads a single node element as the whole document', () => {
    const result = parseGraph(
      `<ex:Thing xmlns:ex="https://example.org/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" rdf:about="https://example.org/a"><ex:p>v</ex:p></ex:Thing>`,
      options({ format: 'rdfxml' }),
    );
    expect(result.graph.nodes).toEqual([
      { id: 'https://example.org/a', label: 'ex:a', type: 'ex:Thing', attrs: { 'ex:p': 'v' } },
    ]);
  });

  it('numbers rdf:li per node element', () => {
    const { graph } = xml(
      `<rdf:Seq rdf:about="https://example.org/s"><rdf:li>a</rdf:li><rdf:li>b</rdf:li></rdf:Seq>
       <rdf:Bag rdf:about="https://example.org/t"><rdf:li>c</rdf:li></rdf:Bag>`,
    );
    expect(attrsOf(graph, 'https://example.org/s')).toEqual({ 'rdf:_1': 'a', 'rdf:_2': 'b' });
    expect(attrsOf(graph, 'https://example.org/t')).toEqual({ 'rdf:_1': 'c' });
  });

  it('reads rdf:parseType="Collection" as an RDF list, like Turtle ( … )', () => {
    const a = xml(
      `<owl:Class rdf:about="https://example.org/c">
         <owl:unionOf rdf:parseType="Collection">
           <owl:Class rdf:about="https://example.org/x"/>
           <rdf:Description rdf:about="https://example.org/y"/>
         </owl:unionOf>
         <ex:none rdf:parseType="Collection"/>
       </owl:Class>`,
    );
    const b = ttl('ex:c a owl:Class ; owl:unionOf ( ex:x ex:y ) ; ex:none () . ex:x a owl:Class .');
    expect(a.graph).toEqual(b.graph);
    expect(triples(a.graph)).toContainEqual([
      'https://example.org/c',
      'owl:unionOf',
      'https://example.org/y',
    ]);
    expect(attrsOf(a.graph, 'https://example.org/c')).toEqual({ 'ex:none': [] });
  });

  it('reads rdf:parseType="Resource" as a blank node, like Turtle [ … ]', () => {
    const a = xml(
      `<rdf:Description rdf:about="https://example.org/a">
         <ex:address rdf:parseType="Resource"><ex:city>Oxford</ex:city></ex:address>
       </rdf:Description>`,
    ).graph;
    expect(a).toEqual(ttl('ex:a ex:address [ ex:city "Oxford" ] .').graph);
  });

  it('shares rdf:nodeID blank nodes and gives anonymous ones fresh identities', () => {
    const a = xml(
      `<rdf:Description rdf:about="https://example.org/a"><ex:p rdf:nodeID="x"/><ex:q rdf:nodeID="x"/></rdf:Description>
       <rdf:Description rdf:nodeID="x"><ex:v>1</ex:v></rdf:Description>
       <rdf:Description rdf:about="https://example.org/b"><ex:p><rdf:Description><ex:v>1</ex:v></rdf:Description></ex:p></rdf:Description>`,
    ).graph;
    const b = ttl('ex:a ex:p _:x ; ex:q _:x . _:x ex:v "1" . ex:b ex:p [ ex:v "1" ] .').graph;
    expect(a).toEqual(b);
    expect(a.nodes.filter((node) => node.id.startsWith('_:b'))).toHaveLength(2);
  });

  it('keeps rdf:parseType="Literal" content as an exclusive-canonical XML literal', () => {
    const { graph } = xml(
      `<rdf:Description rdf:about="https://example.org/a">
         <ex:note rdf:parseType="Literal"><b xmlns:x="urn:x" x:z="2" a="&quot;1&quot;">x &amp; y<!-- c --><x:i/></b> tail</ex:note>
       </rdf:Description>`,
    );
    expect(attrsOf(graph, 'https://example.org/a')).toEqual({
      'ex:note':
        '<b xmlns:x="urn:x" a="&quot;1&quot;" x:z="2">x &amp; y<!-- c --><x:i></x:i></b> tail',
    });
  });

  it('reifies a statement with rdf:ID on a property element', () => {
    const { graph } = xml(
      '<rdf:Description rdf:about="https://example.org/a"><ex:p rdf:ID="s1" rdf:resource="https://example.org/b"/></rdf:Description>',
      {},
      ' xml:base="https://example.org/doc"',
    );
    expect(triples(graph)).toEqual([
      ['https://example.org/a', 'ex:p', 'https://example.org/b'],
      ['https://example.org/doc#s1', 'rdf:object', 'https://example.org/b'],
      ['https://example.org/doc#s1', 'rdf:predicate', 'https://example.org/p'],
      ['https://example.org/doc#s1', 'rdf:subject', 'https://example.org/a'],
    ]);
    expect(nodeById(graph, 'https://example.org/doc#s1').type).toBe('rdf:Statement');
  });

  it('reads empty, whitespace-only and typed literal property elements', () => {
    const { graph } = xml(
      `<rdf:Description rdf:about="https://example.org/a">
         <ex:empty/><ex:closed></ex:closed><ex:space>  </ex:space>
         <ex:n rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">42</ex:n>
         <ex:blank rdf:datatype="http://www.w3.org/2001/XMLSchema#string"/>
       </rdf:Description>`,
    );
    expect(attrsOf(graph, 'https://example.org/a')).toEqual({
      'ex:blank': '',
      'ex:closed': '',
      'ex:empty': '',
      'ex:n': 42,
      'ex:space': '  ',
    });
  });

  it('turns an empty property element with property attributes into a blank node', () => {
    const a = xml(
      '<rdf:Description rdf:about="https://example.org/a"><ex:p ex:q="v" rdf:type="https://example.org/T"/></rdf:Description>',
    ).graph;
    expect(a).toEqual(ttl('ex:a ex:p [ a ex:T ; ex:q "v" ] .').graph);
  });

  it('reads CDATA, character references and predefined entities in text', () => {
    const { graph } = xml(
      '<rdf:Description rdf:about="https://example.org/a"><ex:p><![CDATA[<b>]]> &#x4E2D;&#25991; &lt;&amp;&gt;</ex:p></rdf:Description>',
    );
    expect(attrsOf(graph, 'https://example.org/a')).toEqual({ 'ex:p': '<b> 中文 <&>' });
  });

  it('accepts the legacy unqualified about, resource and type attributes', () => {
    const a = xml(
      '<rdf:Description about="https://example.org/a" type="https://example.org/T"><ex:p resource="https://example.org/b"/></rdf:Description>',
    ).graph;
    expect(a).toEqual(ttl('ex:a a ex:T ; ex:p ex:b .').graph);
  });

  it('ignores attributes reserved by XML', () => {
    const { graph } = xml(
      '<rdf:Description rdf:about="https://example.org/a" xml:space="preserve" xmlfoo="1"><ex:p xml:id="x">v</ex:p></rdf:Description>',
    );
    expect(attrsOf(graph, 'https://example.org/a')).toEqual({ 'ex:p': 'v' });
  });
});

describe('RDF/XML scoping', () => {
  it('inherits xml:lang, including into property attributes, and resets it with ""', () => {
    const { graph } = xml(
      `<rdf:Description rdf:about="https://example.org/a" ex:attr="Hi">
         <ex:p>Hello</ex:p>
         <ex:q xml:lang="de">Hallo</ex:q>
         <ex:r xml:lang="">plain</ex:r>
         <ex:s rdf:datatype="http://www.w3.org/2001/XMLSchema#string">typed</ex:s>
       </rdf:Description>`,
      {},
      ' xml:lang="en-GB"',
    );
    expect(attrsOf(graph, 'https://example.org/a')).toEqual({
      'ex:attr': 'Hi@en-gb',
      'ex:p': 'Hello@en-gb',
      'ex:q': 'Hallo@de',
      'ex:r': 'plain',
      'ex:s': 'typed',
    });
  });

  it('prefers labels by language as in Turtle', () => {
    const a = xml(
      `<rdf:Description rdf:about="https://example.org/a">
         <rdfs:label xml:lang="zh">苹果</rdfs:label><rdfs:label xml:lang="en">apple</rdfs:label>
       </rdf:Description>`,
      { rdf: { languages: ['zh'] } },
    );
    expect(nodeById(a.graph, 'https://example.org/a')).toEqual({
      id: 'https://example.org/a',
      label: '苹果',
      aliases: ['apple'],
    });
  });

  it('resolves rdf:about, rdf:resource, rdf:ID and rdf:datatype against nested xml:base', () => {
    const { graph } = xml(
      `<rdf:Description rdf:about="a"><ex:p rdf:resource="#b"/></rdf:Description>
       <rdf:Description xml:base="sub/" rdf:ID="c"><ex:q rdf:resource="../d"/></rdf:Description>
       <rdf:Description rdf:about=""><ex:v rdf:datatype="types#t">1</ex:v></rdf:Description>`,
      {},
      ' xml:base="https://example.org/dir/doc"',
    );
    expect(triples(graph)).toEqual([
      ['https://example.org/dir/a', 'ex:p', 'https://example.org/dir/doc#b'],
      ['https://example.org/dir/sub/#c', 'ex:q', 'https://example.org/dir/d'],
    ]);
    expect(attrsOf(graph, 'https://example.org/dir/doc')).toEqual({ 'ex:v': '1' });
  });

  it('resolves relative IRIs against ParseOptions.baseIRI, and keeps them without one', () => {
    const body = '<rdf:Description rdf:about="a"><ex:p rdf:resource="b"/></rdf:Description>';
    expect(triples(xml(body, { baseIRI: 'http://ex.org/x/' }).graph)).toEqual([
      ['http://ex.org/x/a', 'ex:p', 'http://ex.org/x/b'],
    ]);
    expect(triples(xml(body).graph)).toEqual([['a', 'ex:p', 'b']]);
  });
});

describe('RDF/XML documents', () => {
  it('expands entities declared in the DTD, in attributes and text', () => {
    const { graph } = parseGraph(
      `<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [
  <!ENTITY ex "https://example.org/" >
  <!ENTITY rdf 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' >
  <!ENTITY greeting "hello &amp; &ex;" >
  <!ENTITY % ignored "parameter entities are skipped" >
  <!ELEMENT rdf:RDF ANY>
]>
<rdf:RDF xmlns:rdf="&rdf;" xmlns:ex="&ex;">
  <rdf:Description rdf:about="&ex;a"><ex:p>&greeting;</ex:p></rdf:Description>
</rdf:RDF>`,
      options({ format: 'rdfxml' }),
    );
    expect(attrsOf(graph, 'https://example.org/a')).toEqual({
      'ex:p': 'hello & https://example.org/',
    });
  });

  it('accepts CRLF line breaks, a byte order mark and trailing comments', () => {
    const text = `﻿<?xml version="1.0"?>\r\n<rdf:RDF ${NAMESPACES}>\r\n<rdf:Description rdf:about="https://example.org/a"><ex:p>one\r\ntwo</ex:p></rdf:Description>\r\n</rdf:RDF>\r\n<!-- generated -->\r\n`;
    const { graph } = parseGraph(text, options({ format: 'rdfxml' }));
    expect(attrsOf(graph, 'https://example.org/a')).toEqual({ 'ex:p': 'one\ntwo' });
  });

  it('reads whitespace-only input as an empty graph', () => {
    expect(parseGraph(' \n', { format: 'rdfxml' }).graph).toEqual({ nodes: [], edges: [] });
    const empty = parseGraph('', { filename: 'empty.owl' });
    expect(empty.format).toBe('rdfxml');
    expect(empty.graph).toEqual({ nodes: [], edges: [], meta: { source: 'empty.owl' } });
  });

  it('handles deeply nested node elements without recursion limits', () => {
    const depth = 5000;
    const body =
      '<rdf:Description rdf:about="https://example.org/a">' +
      '<ex:p rdf:parseType="Resource">'.repeat(depth) +
      '<ex:v>leaf</ex:v>' +
      '</ex:p>'.repeat(depth) +
      '</rdf:Description>';
    const { graph } = xml(body);
    expect(graph.nodes).toHaveLength(depth + 1);
    expect(graph.edges).toHaveLength(depth);
  });
});

describe('RDF/XML errors', () => {
  const error = (text: string) => catchError(() => parseGraph(text, { format: 'rdfxml' }));
  const inRoot = (body: string) => `<rdf:RDF ${NAMESPACES}>\n${body}\n</rdf:RDF>`;

  it('report XML that is not well-formed with its line', () => {
    const mismatched = error(inRoot('<rdf:Description>\n<ex:p>x</ex:q>\n</rdf:Description>'));
    expect(mismatched.code).toBe('invalid-input');
    expect(mismatched.message).toBe('Invalid RDF/XML: Expected </ex:p>, found </ex:q> on line 3.');
    expect(mismatched.details).toEqual({ format: 'rdfxml', line: 3 });
    expect(error(`<rdf:RDF ${NAMESPACES}>\n<rdf:Description>`).message).toMatch(
      /<rdf:Description> is never closed on line 2/,
    );
    expect(error(inRoot('<nope:x/>')).message).toMatch(/Undeclared namespace prefix "nope"/);
    expect(error(inRoot('<ex:a b="1" b="2"/>')).message).toMatch(/Duplicate attribute b/);
    expect(error(inRoot('&unknown;')).message).toMatch(/Undeclared entity "&unknown;"/);
    expect(error(`${inRoot('')}\n<rdf:RDF/>`).message).toMatch(/Only one root element/);
    expect(error('just text').message).toMatch(/Text before the root element on line 1/);
  });

  it('report RDF/XML grammar violations with the line of the element', () => {
    const cases: [string, RegExp][] = [
      [
        '<rdf:Description rdf:about="a" rdf:nodeID="b"/>',
        /only one of rdf:about, rdf:ID and rdf:nodeID/,
      ],
      ['<rdf:Description rdf:li="x"/>', /rdf:li cannot be used as an attribute/],
      ['<rdf:Description rdf:bagID="x"/>', /rdf:bagID is not allowed on a node element/],
      ['<rdf:li/>', /rdf:li cannot be used as a node element/],
      [
        '<rdf:Description><rdf:Description/></rdf:Description>',
        /rdf:Description cannot be used as a property element/,
      ],
      ['<rdf:Description rdf:ID="x"/><rdf:Description rdf:ID="x"/>', /rdf:ID "x" is used twice/],
      ['<rdf:Description rdf:nodeID="1x"/>', /rdf:nodeID "1x" is not an XML name/],
      [
        '<rdf:Description><ex:p rdf:resource="a" rdf:nodeID="b"/></rdf:Description>',
        /only one of rdf:resource, rdf:nodeID and rdf:datatype/,
      ],
      [
        '<rdf:Description><ex:p>text<rdf:Description/></ex:p></rdf:Description>',
        /cannot mix text and a node element/,
      ],
      [
        '<rdf:Description><ex:p rdf:resource="a">text</ex:p></rdf:Description>',
        /cannot contain text/,
      ],
      [
        '<rdf:Description><ex:p rdf:parseType="Resource" rdf:resource="a"/></rdf:Description>',
        /rdf:parseType cannot be combined/,
      ],
      ['<rdf:Description about="a" foo="b"/>', /Attribute "foo" is in no namespace/],
      ['<rdf:Description>stray text</rdf:Description>', /Unexpected text "stray text"/],
    ];
    for (const [body, message] of cases) {
      const caught = error(inRoot(body));
      expect(caught.message, body).toMatch(message);
      expect(caught.message, body).toMatch(/^Invalid RDF\/XML: .* on line 2\.$/);
    }
  });

  it('never loads external entities', () => {
    const caught = error(
      `<!DOCTYPE rdf:RDF [<!ENTITY secret SYSTEM "file:///etc/passwd">]>\n${inRoot('<rdf:Description rdf:about="https://example.org/a"><ex:p>&secret;</ex:p></rdf:Description>')}`,
    );
    expect(caught.message).toMatch(
      /External entity "&secret;" is not loaded \(external resources are never fetched\)/,
    );
  });

  it('stops exponential entity expansion ("billion laughs") early', () => {
    const levels = ['<!ENTITY l0 "lol">'];
    for (let i = 1; i <= 9; i++) levels.push(`<!ENTITY l${i} "${`&l${i - 1};`.repeat(10)}">`);
    const caught = error(
      `<!DOCTYPE rdf:RDF [${levels.join('\n')}]>\n${inRoot('<rdf:Description rdf:about="https://example.org/a"><ex:p>&l9;</ex:p></rdf:Description>')}`,
    );
    expect(caught.message).toMatch(/Entity expansion exceeds the size limit/);
  });

  it('rejects OWL/XML and GraphML read as RDF/XML with a conversion hint', () => {
    expect(
      error('<Ontology xmlns="http://www.w3.org/2002/07/owl#" ontologyIRI="http://ex.org/o"/>')
        .message,
    ).toMatch(
      /^OWL\/XML is not supported\. Convert it to RDF\/XML or Turtle first \(e\.g\. `robot convert/,
    );
    expect(error('<graphml xmlns="http://graphml.graphdrawing.org/xmlns"/>').message).toMatch(
      /^GraphML is not supported\. Export it as JSON first/,
    );
    // OWL API writes OWL/XML with an xmlns:rdf declaration, but never with rdf: attributes.
    expect(
      error(
        '<Ontology xmlns="http://www.w3.org/2002/07/owl#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ontologyIRI="http://ex.org/o"><Declaration/></Ontology>',
      ).message,
    ).toMatch(/^OWL\/XML is not supported/);
  });

  it('reads any root node element when RDF/XML is asked for, as the spec allows', () => {
    const { graph } = parseGraph(
      '<Book xmlns="http://example.org/terms#"><title>Dogs in Hats</title></Book>',
      { format: 'rdfxml' },
    );
    expect(graph.nodes).toEqual([
      {
        id: expect.stringMatching(/^_:b/),
        type: 'http://example.org/terms#Book',
        attrs: { 'http://example.org/terms#title': 'Dogs in Hats' },
      },
    ]);
  });

  it('report an unterminated document', () => {
    expect(error(fixture('people.rdf').slice(0, 900)).message).toMatch(
      /^Invalid RDF\/XML: .* on line \d+\.$/,
    );
  });
});
