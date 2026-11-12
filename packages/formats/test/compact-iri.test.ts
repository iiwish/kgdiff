import { describe, expect, it } from 'vitest';
import { compactIri } from '../src/sync.js';

describe('compactIri', () => {
  it.each([
    ['http://purl.obolibrary.org/obo/GO_0008150', 'GO:0008150'],
    ['http://purl.obolibrary.org/obo/BFO_0000050', 'BFO:0000050'],
    ['http://purl.obolibrary.org/obo/NCBITaxon_9606', 'NCBITaxon:9606'],
    ['http://purl.obolibrary.org/obo/NCBITaxon_Union_0000001', 'NCBITaxon:Union_0000001'],
    ['http://purl.obolibrary.org/obo/go.owl', 'obo:go.owl'],
    ['http://purl.obolibrary.org/obo/go#part_of', 'obo:go#part_of'],
    ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'rdf:type'],
    ['http://www.w3.org/2000/01/rdf-schema#subClassOf', 'rdfs:subClassOf'],
    ['http://www.w3.org/2002/07/owl#Class', 'owl:Class'],
    ['http://www.w3.org/2001/XMLSchema#integer', 'xsd:integer'],
    ['http://www.w3.org/2004/02/skos/core#prefLabel', 'skos:prefLabel'],
    ['https://schema.org/name', 'schema:name'],
    ['http://schema.org/name', 'schema:name'],
    ['http://purl.org/dc/terms/title', 'dcterms:title'],
    ['http://purl.org/dc/elements/1.1/title', 'dc:title'],
    ['http://xmlns.com/foaf/0.1/name', 'foaf:name'],
    ['http://www.w3.org/ns/prov#wasDerivedFrom', 'prov:wasDerivedFrom'],
    ['http://www.geneontology.org/formats/oboInOwl#hasExactSynonym', 'oboInOwl:hasExactSynonym'],
  ])('%s → %s', (iri, compact) => {
    expect(compactIri(iri)).toBe(compact);
  });

  it('returns unknown IRIs unchanged', () => {
    expect(compactIri('https://example.org/people/alice')).toBe('https://example.org/people/alice');
    expect(compactIri('urn:isbn:0451450523')).toBe('urn:isbn:0451450523');
    expect(compactIri('')).toBe('');
  });

  it('uses extra prefixes, longest namespace first', () => {
    const prefixes = { ex: 'https://example.org/', people: 'https://example.org/people/' };
    expect(compactIri('https://example.org/people/alice', prefixes)).toBe('people:alice');
    expect(compactIri('https://example.org/org/acme', prefixes)).toBe('ex:org/acme');
  });

  it('supports the empty prefix', () => {
    expect(compactIri('https://example.org/a', { '': 'https://example.org/' })).toBe(':a');
  });

  it('prefers names from the prefix map over well-known names for the same namespace', () => {
    expect(compactIri('https://schema.org/name', { sdo: 'https://schema.org/' })).toBe('sdo:name');
  });

  it('lets the prefix map rebind a well-known name', () => {
    const prefixes = { schema: 'https://example.org/schema/' };
    expect(compactIri('https://example.org/schema/Thing', prefixes)).toBe('schema:Thing');
    expect(compactIri('https://schema.org/Thing', prefixes)).toBe('https://schema.org/Thing');
  });

  it('applies the OBO rule unless the id space is bound to another namespace', () => {
    const iri = 'http://purl.obolibrary.org/obo/GO_0008150';
    expect(compactIri(iri, { GO: 'http://purl.obolibrary.org/obo/GO_' })).toBe('GO:0008150');
    expect(compactIri(iri, { GO: 'http://example.org/go/' })).toBe('obo:GO_0008150');
  });

  it('is pure: the same prefix object gives the same answers', () => {
    const prefixes = Object.freeze({ ex: 'https://example.org/' });
    expect(compactIri('https://example.org/a', prefixes)).toBe('ex:a');
    expect(compactIri('https://example.org/a', prefixes)).toBe('ex:a');
    expect(compactIri('https://example.org/a')).toBe('https://example.org/a');
  });
});
