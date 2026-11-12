import type { GraphInput } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import type { ParseOptions } from '../src/index.js';
import { parseGraph } from '../src/sync.js';
import { parseFixture } from './helpers.js';

const PREFIXES = [
  '@prefix ex: <https://example.org/> .',
  '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix obo: <http://purl.obolibrary.org/obo/> .',
  '@prefix oboInOwl: <http://www.geneontology.org/formats/oboInOwl#> .',
  '@prefix dcterms: <http://purl.org/dc/terms/> .',
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

const triples = (graph: GraphInput) =>
  graph.edges.map((edge) => [edge.source, edge.predicate, edge.target]);

const PART_OF = 'obo:BFO_0000050 rdfs:label "part of" .\n';
const someValuesFrom = (filler: string, property = 'obo:BFO_0000050') =>
  `[ a owl:Restriction ; owl:onProperty ${property} ; owl:someValuesFrom ${filler} ]`;

describe('OWL fixture (GO excerpt in Turtle)', () => {
  const result = parseFixture('go-mini.ttl');

  it('reads the ontology header into meta instead of a node', () => {
    expect(result.graph.meta).toEqual({
      name: 'http://purl.obolibrary.org/obo/go.owl',
      version: '2024-01-17',
      predicateLabels: { 'BFO:0000050': 'part of', 'IAO:0000115': 'definition' },
      source: 'go-mini.ttl',
    });
    expect(result.predicateLabels).toEqual({
      'BFO:0000050': 'part of',
      'IAO:0000115': 'definition',
    });
    expect(result.graph.nodes.map((node) => node.id)).not.toContain(
      'http://purl.obolibrary.org/obo/go.owl',
    );
    expect(result.warnings).toEqual([]);
  });

  it('maps classes, properties and annotations', () => {
    expect(result.graph.nodes).toEqual([
      {
        id: 'BFO:0000050',
        label: 'part of',
        type: 'owl:ObjectProperty',
        attrs: { 'oboInOwl:shorthand': 'part_of' },
      },
      {
        id: 'GO:0000005',
        label: 'obsolete ribosomal chaperone activity',
        type: 'owl:Class',
        attrs: { 'oboInOwl:consider': ['GO:0042254', 'GO:0044183'] },
        deprecated: true,
        replacedBy: ['GO:0042254'],
      },
      { id: 'GO:0005739', label: 'mitochondrion', type: 'owl:Class' },
      {
        id: 'GO:0008150',
        label: 'biological_process',
        type: 'owl:Class',
        aliases: ['biological process', 'physiological process'],
        attrs: {
          'IAO:0000115':
            'A biological process is the execution of a genetically-encoded biological module or program.',
          'IAO:0000115/oboInOwl:hasDbXref': 'GOC:pdt',
          'oboInOwl:hasAlternativeId': ['GO:0000004', 'GO:0007582'],
          'oboInOwl:hasOBONamespace': 'biological_process',
          'rdfs:isDefinedBy': 'http://purl.obolibrary.org/obo/go.owl',
        },
      },
      { id: 'GO:0031966', label: 'mitochondrial membrane', type: 'owl:Class' },
      { id: 'IAO:0000115', label: 'definition', type: 'owl:AnnotationProperty' },
    ]);
  });

  it('turns restrictions and logical definitions into labelled edges', () => {
    expect(result.graph.edges).toEqual([
      {
        source: 'GO:0005739',
        target: 'GO:0005737',
        predicate: 'BFO:0000050',
        label: 'BFO:0000050',
        attrs: { 'oboInOwl:source': 'GOC:mah' },
      },
      {
        source: 'GO:0005739',
        target: 'GO:0043231',
        predicate: 'rdfs:subClassOf',
        label: 'subClassOf',
      },
      {
        source: 'GO:0008150',
        target: 'http://purl.obolibrary.org/obo/go#goslim_generic',
        predicate: 'oboInOwl:inSubset',
        label: 'inSubset',
      },
      {
        source: 'GO:0031966',
        target: 'GO:0005740',
        predicate: 'BFO:0000050',
        label: 'BFO:0000050',
      },
      {
        source: 'GO:0031966',
        target: 'GO:0016020',
        predicate: 'owl:intersectionOf',
        label: 'intersectionOf',
      },
      {
        source: 'GO:0031966',
        target: 'GO:0031090',
        predicate: 'rdfs:subClassOf',
        label: 'subClassOf',
      },
    ]);
  });
});

describe('OWL existential restrictions', () => {
  it('map C ⊑ ∃R.D to an edge C –R→ D, reporting the property label separately', () => {
    const { graph, predicateLabels } = ttl(
      `${PART_OF}obo:GO_1 rdfs:subClassOf ${someValuesFrom('obo:GO_2')} .`,
    );
    expect(predicateLabels).toEqual({ 'BFO:0000050': 'part of' });
    expect(graph.edges).toEqual([
      { source: 'GO:1', target: 'GO:2', predicate: 'BFO:0000050', label: 'BFO:0000050' },
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(['BFO:0000050', 'GO:1']);
  });

  it('use the readable property name when the file does not label it', () => {
    const { graph } = ttl(`ex:A rdfs:subClassOf ${someValuesFrom('ex:B', 'ex:has_part')} .`);
    expect(graph.edges).toEqual([
      {
        source: 'https://example.org/A',
        target: 'https://example.org/B',
        predicate: 'ex:has_part',
        label: 'has part',
      },
    ]);
  });

  it('stay blank nodes when owlRestrictions is false', () => {
    const { graph } = ttl(`obo:GO_1 rdfs:subClassOf ${someValuesFrom('obo:GO_2')} .`, {
      rdf: { owlRestrictions: false },
    });
    const restriction = graph.nodes.find((node) => node.id.startsWith('_:b'));
    expect(restriction).toEqual({ id: expect.stringMatching(/^_:b/), type: 'owl:Restriction' });
    expect(triples(graph)).toEqual([
      ['GO:1', 'rdfs:subClassOf', restriction?.id],
      [restriction?.id, 'owl:onProperty', 'BFO:0000050'],
      [restriction?.id, 'owl:someValuesFrom', 'GO:2'],
    ]);
  });

  it('leave other restrictions as content-addressed blank nodes', () => {
    const { graph } = ttl(`
      ex:A rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:allValuesFrom ex:B ] ,
        [ a owl:Restriction ; owl:onProperty ex:p ; owl:someValuesFrom [ owl:unionOf ( ex:C ex:D ) ] ] ,
        [ a owl:Restriction ; owl:onProperty ex:p ; owl:qualifiedCardinality 2 ; owl:onClass ex:E ] .`);
    const blanks = graph.nodes.filter((node) => node.id.startsWith('_:b'));
    expect(blanks).toHaveLength(4);
    expect(graph.edges.filter((edge) => edge.source === 'https://example.org/A')).toHaveLength(3);
    expect(blanks.some((node) => node.attrs?.['owl:qualifiedCardinality'] === 2)).toBe(true);
  });

  it('are converted for every class that uses the same restriction shape', () => {
    const { graph } = ttl(
      `ex:A rdfs:subClassOf ${someValuesFrom('ex:C', 'ex:p')} . ex:B rdfs:subClassOf ${someValuesFrom('ex:C', 'ex:p')} .`,
    );
    expect(triples(graph)).toEqual([
      ['https://example.org/A', 'ex:p', 'https://example.org/C'],
      ['https://example.org/B', 'ex:p', 'https://example.org/C'],
    ]);
  });
});

describe('OWL class expressions under owl:equivalentClass', () => {
  it('keep named members of an intersection and its existential parts as edges', () => {
    const { graph } = ttl(
      `${PART_OF}obo:GO_3 owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( obo:GO_1 ${someValuesFrom('obo:GO_2')} ) ] .`,
    );
    expect(graph.edges).toEqual([
      { source: 'GO:3', target: 'GO:2', predicate: 'BFO:0000050', label: 'BFO:0000050' },
      { source: 'GO:3', target: 'GO:1', predicate: 'owl:intersectionOf', label: 'intersectionOf' },
    ]);
  });

  it('keep named members of a union', () => {
    const { graph } = ttl('ex:A owl:equivalentClass [ owl:unionOf ( ex:B ex:C ) ] .');
    expect(triples(graph)).toEqual([
      ['https://example.org/A', 'owl:unionOf', 'https://example.org/B'],
      ['https://example.org/A', 'owl:unionOf', 'https://example.org/C'],
    ]);
  });

  it('map an equivalent existential to an edge and a named equivalent class to owl:equivalentClass', () => {
    const { graph } = ttl(`ex:A owl:equivalentClass ${someValuesFrom('ex:B', 'ex:p')} , ex:Z .`);
    expect(triples(graph)).toEqual([
      ['https://example.org/A', 'ex:p', 'https://example.org/B'],
      ['https://example.org/A', 'owl:equivalentClass', 'https://example.org/Z'],
    ]);
  });

  it('keep other expressions whole as blank nodes', () => {
    const { graph, warnings } = ttl(
      'ex:A owl:equivalentClass [ owl:intersectionOf ( ex:B [ owl:complementOf ex:C ] ) ] .',
    );
    const expression = graph.edges.find((edge) => edge.source === 'https://example.org/A');
    expect(expression).toMatchObject({
      source: 'https://example.org/A',
      predicate: 'owl:equivalentClass',
    });
    expect(expression?.target).toMatch(/^_:b/);
    expect(graph.edges.some((edge) => edge.predicate === 'owl:complementOf')).toBe(true);
    expect(warnings.map((warning) => warning.code)).toEqual(['rdf-list-resources']);
  });
});

describe('statement annotations', () => {
  it('fold owl:Axiom annotations of a literal into node attrs keyed property/annotation', () => {
    const { graph } = ttl(
      `
      obo:GO_1 obo:IAO_0000115 "A definition." ; oboInOwl:hasExactSynonym "syn" .
      [] a owl:Axiom ; owl:annotatedSource obo:GO_1 ; owl:annotatedProperty obo:IAO_0000115 ;
         owl:annotatedTarget "A definition." ; oboInOwl:hasDbXref "PMID:2", "PMID:1" .
      [] a owl:Axiom ; owl:annotatedSource obo:GO_1 ; owl:annotatedProperty oboInOwl:hasExactSynonym ;
         owl:annotatedTarget "syn" ; oboInOwl:hasSynonymType obo:go#systematic_synonym .`.replace(
        'obo:go#systematic_synonym',
        '<http://purl.obolibrary.org/obo/go#systematic_synonym>',
      ),
    );
    expect(graph.nodes).toEqual([
      {
        id: 'GO:1',
        aliases: ['syn'],
        attrs: {
          'IAO:0000115': 'A definition.',
          'IAO:0000115/oboInOwl:hasDbXref': ['PMID:1', 'PMID:2'],
          'oboInOwl:hasExactSynonym/oboInOwl:hasSynonymType':
            'http://purl.obolibrary.org/obo/go#systematic_synonym',
        },
      },
    ]);
    expect(graph.edges).toEqual([]);
  });

  it('fold annotations of an edge into the edge attrs', () => {
    const { graph } = ttl(`
      ex:A rdfs:subClassOf ex:B .
      [] a owl:Axiom ; owl:annotatedSource ex:A ; owl:annotatedProperty rdfs:subClassOf ;
         owl:annotatedTarget ex:B ; rdfs:comment "asserted by curator" ; ex:confidence 0.9 .`);
    expect(graph.edges).toEqual([
      {
        source: 'https://example.org/A',
        target: 'https://example.org/B',
        predicate: 'rdfs:subClassOf',
        label: 'subClassOf',
        attrs: { 'ex:confidence': 0.9, 'rdfs:comment': 'asserted by curator' },
      },
    ]);
  });

  it('fold rdf:Statement reifications of asserted triples', () => {
    const { graph } = ttl(`
      ex:a ex:knows ex:b .
      [] a rdf:Statement ; rdf:subject ex:a ; rdf:predicate ex:knows ; rdf:object ex:b ; ex:since 2020 .`);
    expect(graph.edges).toEqual([
      {
        source: 'https://example.org/a',
        target: 'https://example.org/b',
        predicate: 'ex:knows',
        label: 'knows',
        attrs: { 'ex:since': 2020 },
      },
    ]);
    expect(graph.nodes).toHaveLength(1);
  });

  it('fold RDF 1.2 annotation syntax into edge attrs', () => {
    const { graph, warnings } = ttl(
      'ex:a ex:knows ex:b {| ex:since 2020 ; ex:source "survey" |} .',
    );
    expect(graph.edges).toEqual([
      {
        source: 'https://example.org/a',
        target: 'https://example.org/b',
        predicate: 'ex:knows',
        label: 'knows',
        attrs: { 'ex:since': 2020, 'ex:source': 'survey' },
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it('keep reifications of triples that are not asserted as nodes', () => {
    const { graph } = ttl(
      '[] a rdf:Statement ; rdf:subject ex:a ; rdf:predicate ex:knows ; rdf:object ex:b ; ex:claimedBy ex:c .',
    );
    expect(graph.nodes).toEqual([{ id: expect.stringMatching(/^_:b/), type: 'rdf:Statement' }]);
    expect(graph.edges.map((edge) => edge.predicate)).toEqual([
      'ex:claimedBy',
      'rdf:object',
      'rdf:predicate',
      'rdf:subject',
    ]);
  });

  it('fold annotations of edges between blank nodes', () => {
    const { graph } = ttl(`
      ex:A ex:p _:x . _:x ex:q _:y . _:y ex:v 1 .
      [] a owl:Axiom ; owl:annotatedSource _:x ; owl:annotatedProperty ex:q ;
         owl:annotatedTarget _:y ; rdfs:comment "between blanks" .`);
    const annotated = graph.edges.find((edge) => edge.predicate === 'ex:q');
    expect(annotated?.attrs).toEqual({ 'rdfs:comment': 'between blanks' });
    expect(graph.nodes).toHaveLength(3);
  });

  it('keep annotations as nodes when they cannot be folded', () => {
    const { graph } = ttl(`
      ex:A ex:note "asserted" .
      [] a owl:Axiom ; owl:annotatedSource ex:A ; owl:annotatedProperty ex:note ;
         owl:annotatedTarget "not asserted" ; rdfs:comment "orphan" .
      [] a owl:Axiom ; owl:annotatedSource ex:A ; owl:annotatedProperty ex:note ;
         owl:annotatedTarget "asserted" ; ex:evidence [ ex:code "IDA" ] .
      [] a owl:Axiom ; owl:annotatedSource [ ex:unused 1 ] ; owl:annotatedProperty ex:p ;
         owl:annotatedTarget ex:B ; rdfs:comment "blank source" .`);
    const axioms = graph.nodes.filter((node) => node.type === 'owl:Axiom');
    expect(axioms).toHaveLength(3);
    expect(graph.nodes.find((node) => node.id === 'https://example.org/A')?.attrs).toEqual({
      'ex:note': 'asserted',
    });
  });

  it('stay blank nodes when foldAnnotations is false', () => {
    const { graph } = ttl(
      `ex:A rdfs:subClassOf ex:B .
       [] a owl:Axiom ; owl:annotatedSource ex:A ; owl:annotatedProperty rdfs:subClassOf ;
          owl:annotatedTarget ex:B ; rdfs:comment "kept apart" .`,
      { rdf: { foldAnnotations: false } },
    );
    const axiom = graph.nodes.find((node) => node.type === 'owl:Axiom');
    expect(axiom).toMatchObject({
      id: expect.stringMatching(/^_:b/),
      attrs: { 'rdfs:comment': 'kept apart' },
    });
    expect(graph.edges.find((edge) => edge.source === 'https://example.org/A')).toEqual({
      source: 'https://example.org/A',
      target: 'https://example.org/B',
      predicate: 'rdfs:subClassOf',
      label: 'subClassOf',
    });
  });

  it('skip triple terms used outside reification, with a warning', () => {
    const { graph, warnings } = ttl('ex:a ex:says <<( ex:b ex:c ex:d )>> ; ex:p ex:q .');
    expect(triples(graph)).toEqual([['https://example.org/a', 'ex:p', 'https://example.org/q']]);
    expect(warnings).toEqual([
      {
        code: 'triple-terms',
        message: 'Skipped 1 triple with RDF 1.2 triple terms (not representable as edges).',
      },
    ]);
  });
});

describe('owl:Ontology header', () => {
  it('names the graph by label or title and versions it by versionInfo or versionIRI', () => {
    expect(
      ttl(
        '<http://ex.org/o> a owl:Ontology ; dcterms:title "My ontology" ; owl:versionIRI <http://ex.org/o/1.0> .',
      ).graph.meta,
    ).toEqual({
      name: 'My ontology',
      version: 'http://ex.org/o/1.0',
    });
    expect(
      ttl('<http://ex.org/o> a owl:Ontology ; rdfs:label "Label"@en ; owl:versionInfo "2", "1" .')
        .graph.meta,
    ).toEqual({
      name: 'Label',
      version: '1',
    });
  });

  it('prefers the importing ontology when several headers are present', () => {
    const result = ttl(`
      <http://ex.org/imported> a owl:Ontology ; owl:versionInfo "9" .
      <http://ex.org/main> a owl:Ontology ; owl:imports <http://ex.org/imported> ; owl:versionInfo "1" .`);
    expect(result.graph).toEqual({
      nodes: [],
      edges: [],
      meta: { name: 'http://ex.org/main', version: '1' },
    });
    expect(result.warnings).toEqual([
      {
        code: 'multiple-ontologies',
        message: 'Found 2 owl:Ontology headers; using http://ex.org/main for name and version.',
      },
    ]);
  });
});
