import { type DiffResult, diffToJSON, hashGraph, normalize } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from '../../core/src/sync.js';
import { parseGraph } from '../src/sync.js';
import { fixture } from './helpers.js';

const facetsOf = (result: DiffResult, id: string) =>
  result.index.node(id)?.facets.map((facet) => facet.kind) ?? [];

const changed = (result: DiffResult) =>
  result.nodes.filter((node) => node.status !== 'unchanged').map((node) => [node.id, node.status]);

describe('formats → core.diff', () => {
  it('sees no change between serializations of the same RDF graph', () => {
    const turtle = parseGraph(fixture('people.ttl')).graph;
    for (const name of ['people.nt', 'people.trig', 'people.rdf', 'people.jsonld']) {
      const other = parseGraph(fixture(name), { filename: name }).graph;
      expect(diff(turtle, other).stats.identical, name).toBe(true);
      expect(hashGraph(normalize(other)), name).toBe(hashGraph(normalize(turtle)));
    }
    const owl = parseGraph(fixture('go-mini.ttl')).graph;
    for (const name of ['go-mini.owl', 'go-mini.jsonld']) {
      const other = parseGraph(fixture(name), { filename: name }).graph;
      expect(diff(owl, other).stats.identical, name).toBe(true);
      expect(hashGraph(normalize(other)), name).toBe(hashGraph(normalize(owl)));
    }
  });

  it('gives a byte-identical diff for the same ontology change in Turtle, RDF/XML and JSON-LD', () => {
    // No file names, so nothing but the graphs can tell the syntaxes apart.
    const diffOf = (name: string, edits: readonly (readonly [string, string])[]) => {
      const v1 = fixture(name);
      const v2 = edits.reduce((text, [from, to]) => text.replaceAll(from, to), v1);
      expect(v2, name).not.toBe(v1);
      return JSON.stringify(diffToJSON(diff(parseGraph(v1).graph, parseGraph(v2).graph)));
    };
    const PURL = 'http://purl.obolibrary.org/obo/';
    const turtle = diffOf('go-mini.ttl', [
      ['rdfs:subClassOf obo:GO_0031090', 'rdfs:subClassOf obo:GO_0019866'],
      ['owl:someValuesFrom obo:GO_0005737', 'owl:someValuesFrom obo:GO_0005829'],
      ['"mitochondrion"@en', '"mitochondrion (organelle)"@en'],
    ]);
    const rdfxml = diffOf('go-mini.owl', [
      [
        `subClassOf rdf:resource="${PURL}GO_0031090"`,
        `subClassOf rdf:resource="${PURL}GO_0019866"`,
      ],
      [
        `someValuesFrom rdf:resource="${PURL}GO_0005737"`,
        `someValuesFrom rdf:resource="${PURL}GO_0005829"`,
      ],
      ['>mitochondrion<', '>mitochondrion (organelle)<'],
    ]);
    const jsonld = diffOf('go-mini.jsonld', [
      ['"subClassOf": "obo:GO_0031090"', '"subClassOf": "obo:GO_0019866"'],
      ['"someValuesFrom": "obo:GO_0005737"', '"someValuesFrom": "obo:GO_0005829"'],
      ['"mitochondrion"', '"mitochondrion (organelle)"'],
    ]);
    expect(JSON.parse(turtle).hunks.length).toBeGreaterThan(1);
    expect(rdfxml).toBe(turtle);
    expect(jsonld).toBe(turtle);
  });

  it('sees no change between a Turtle file with a custom prefix and the same N-Triples', () => {
    const turtle = parseGraph(
      [
        '@prefix ex: <https://example.org/kg/> .',
        'ex:alice a ex:Person ; ex:knows ex:bob ; ex:age 42 .',
        'ex:bob a ex:Person .',
      ].join('\n'),
      { filename: 'v1.ttl' },
    );
    const nTriples = parseGraph(
      [
        '<https://example.org/kg/bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://example.org/kg/Person> .',
        '<https://example.org/kg/alice> <https://example.org/kg/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .',
        '<https://example.org/kg/alice> <https://example.org/kg/knows> <https://example.org/kg/bob> .',
        '<https://example.org/kg/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://example.org/kg/Person> .',
      ].join('\n'),
      { filename: 'v2.nt' },
    );
    expect(turtle.prefixes.ex).toBe('https://example.org/kg/');
    expect(diff(turtle.graph, nTriples.graph).stats.identical).toBe(true);
  });

  it('turns an OBO release into renames, a hinted merge, a move and additions', () => {
    const v1 = fixture('go-mini.obo');
    const v2 = `${v1
      .replace('name: mitochondrion inheritance', 'name: mitochondrial inheritance')
      .replace(
        'is_a: GO:0031090 ! organelle membrane',
        'is_a: GO:0019866 ! organelle inner membrane',
      )
      .replace(/\[Term\]\nid: GO:0000005[\s\S]*?\n\n/, '')
      .replace('alt_id: GO:0007582', 'alt_id: GO:0007582\nalt_id: GO:0000005')}
[Term]
id: GO:0099999
name: brand new process
is_a: GO:0008150
`;
    const result = diff(
      parseGraph(v1, { format: 'obo' }).graph,
      parseGraph(v2, { format: 'obo' }).graph,
    );
    expect(facetsOf(result, 'GO:0000001')).toContain('rename');
    expect(result.index.node('GO:0000005')?.facets).toContainEqual({
      kind: 'mergedInto',
      target: 'GO:0008150',
      confidence: 1,
      via: 'hint',
    });
    expect(result.index.node('GO:0031966')?.facets).toContainEqual({
      kind: 'move',
      predicate: 'is_a',
      from: ['GO:0031090'],
      to: ['GO:0019866'],
    });
    expect(result.index.node('GO:0099999')?.status).toBe('added');
  });

  it('turns OWL hierarchy and restriction changes into moves and retargeted edges', () => {
    const v1 = fixture('go-mini.ttl');
    const v2 = v1
      .replace('rdfs:subClassOf obo:GO_0031090', 'rdfs:subClassOf obo:GO_0019866')
      .replaceAll('owl:someValuesFrom obo:GO_0005737', 'owl:someValuesFrom obo:GO_0005829');
    const result = diff(parseGraph(v1).graph, parseGraph(v2).graph);
    expect(result.index.node('GO:0031966')?.facets).toContainEqual({
      kind: 'move',
      predicate: 'rdfs:subClassOf',
      from: ['GO:0031090'],
      to: ['GO:0019866'],
    });
    const partOf = result.edges.find(
      (edge) => edge.source === 'GO:0005739' && edge.predicate === 'BFO:0000050',
    );
    expect(partOf?.status).toBe('modified');
    expect(partOf?.facets[0]).toMatchObject({ kind: 'retarget', end: 'target', to: 'GO:0005829' });
    // No blank-node noise: restrictions and axioms map to the same ids in both versions.
    expect(changed(result).every(([id]) => !String(id).startsWith('_:'))).toBe(true);
  });

  it('diffs JSON dialects against each other by meaning, not by shape', () => {
    const cytoscape = parseGraph(
      JSON.stringify({
        elements: [
          { data: { id: 'a', label: 'A' } },
          { data: { id: 'b', label: 'B' } },
          { data: { source: 'a', target: 'b', interaction: 'knows' } },
        ],
      }),
    ).graph;
    const g6 = parseGraph(
      JSON.stringify({
        nodes: [
          { id: 'a', data: { label: 'A' }, style: { x: 1 } },
          { id: 'b', data: { label: 'B' } },
        ],
        edges: [{ source: 'a', target: 'b', data: { relation: 'knows' } }],
      }),
    ).graph;
    expect(diff(cytoscape, g6).stats.identical).toBe(true);
  });
});
