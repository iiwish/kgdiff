import { describe, expect, it } from 'vitest';
import { FORMAT_EXTENSIONS, type FormatId } from '../src/index.js';
import { detectFormat, parseGraph } from '../src/sync.js';
import { catchError, fixture } from './helpers.js';

describe('detectFormat by file name', () => {
  it.each([
    ['graph.json', 'json'],
    ['graph.kgdiff.json', 'json'],
    ['people.ttl', 'turtle'],
    ['people.turtle', 'turtle'],
    ['people.nt', 'ntriples'],
    ['people.nq', 'nquads'],
    ['people.trig', 'trig'],
    ['go-basic.obo', 'obo'],
    ['GO-BASIC.OBO', 'obo'],
    ['https://example.org/data/go.obo?ref=main#top', 'obo'],
    ['nested/dir/v2.People.TTL', 'turtle'],
    ['people.rdf', 'rdfxml'],
    ['go.owl', 'rdfxml'],
    ['https://purl.obolibrary.org/obo/go.OWL?download', 'rdfxml'],
    ['people.jsonld', 'jsonld'],
  ] satisfies [string, FormatId][])('%s → %s', (filename, format) => {
    expect(detectFormat('', filename)).toBe(format);
  });

  it('trusts the extension over the content', () => {
    expect(detectFormat('{"nodes": []}', 'data.ttl')).toBe('turtle');
    expect(detectFormat(fixture('people.ttl'), 'people.rdf')).toBe('rdfxml');
  });

  it('falls back to content sniffing for unknown extensions', () => {
    expect(detectFormat(fixture('go-mini.obo'), 'go.txt')).toBe('obo');
    expect(detectFormat(fixture('go-mini.owl'), 'go.xml')).toBe('rdfxml');
  });

  it('lets the content decide for .owl, which Protégé uses for every OWL syntax', () => {
    expect(detectFormat(fixture('go-mini.owl'), 'go.owl')).toBe('rdfxml');
    expect(detectFormat(fixture('people.ttl'), 'people.owl')).toBe('turtle');
    expect(detectFormat('garbage that is no known syntax', 'broken.owl')).toBe('rdfxml');
    expect(
      catchError(() =>
        detectFormat('<Ontology xmlns="http://www.w3.org/2002/07/owl#"/>', 'pizza.owl'),
      ).message,
    ).toMatch(/^OWL\/XML is not supported \("pizza\.owl"\)\. Convert it to RDF\/XML or Turtle/);
    expect(
      catchError(() =>
        detectFormat('Prefix(:=<http://ex.org/>)\nOntology(<http://ex.org/o>)', 'f.owl'),
      ).message,
    ).toMatch(/OWL Functional Syntax is not supported/);
  });

  it('reads JSON-LD in a .json file as jsonld', () => {
    expect(detectFormat(fixture('people.jsonld'), 'people.json')).toBe('jsonld');
    expect(detectFormat(fixture('kgdiff.json'), 'graph.json')).toBe('json');
  });

  it('knows every format id', () => {
    expect(Object.keys(FORMAT_EXTENSIONS).sort()).toEqual(
      ['json', 'jsonld', 'nquads', 'ntriples', 'obo', 'rdfxml', 'trig', 'turtle'].sort(),
    );
  });
});

describe('detectFormat by content', () => {
  it.each([
    ['kgdiff.json', 'json'],
    ['cytoscape-elements.json', 'json'],
    ['go-mini.obo', 'obo'],
    ['people.ttl', 'turtle'],
    ['go-mini.ttl', 'turtle'],
    ['people.nt', 'ntriples'],
    ['people.nq', 'nquads'],
    ['people.trig', 'trig'],
    ['people.rdf', 'rdfxml'],
    ['go-mini.owl', 'rdfxml'],
    ['people.jsonld', 'jsonld'],
    ['go-mini.jsonld', 'jsonld'],
  ] satisfies [string, FormatId][])('%s → %s', (name, format) => {
    expect(detectFormat(fixture(name))).toBe(format);
  });

  it('recognises RDF/XML by its root element, with or without a prolog', () => {
    const rdf = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
    expect(detectFormat(`<rdf:RDF ${rdf}></rdf:RDF>`)).toBe('rdfxml');
    expect(
      detectFormat(`<!-- c -->\n<!DOCTYPE rdf:RDF [<!ENTITY a "b>">]>\n<rdf:RDF ${rdf}/>`),
    ).toBe('rdfxml');
    expect(detectFormat(`<ex:Thing xmlns:ex="urn:x" ${rdf} rdf:about="urn:a"/>`)).toBe('rdfxml');
    expect(
      detectFormat(
        `<owl:Ontology xmlns:owl="http://www.w3.org/2002/07/owl#" ${rdf} rdf:about=""/>`,
      ),
    ).toBe('rdfxml');
  });

  it('keeps Turtle and N-Triples that start with an IRI apart from XML', () => {
    expect(detectFormat('<http://a> <http://b> <http://c> .')).toBe('ntriples');
    expect(detectFormat('<a> <b> <c> .')).toBe('ntriples');
    expect(detectFormat('<a> <b> "x" ;\n  <c> "y" .')).toBe('turtle');
    expect(detectFormat('<urn:x:a> <urn:x:b> "v" ;\n <urn:x:c> 1 .')).toBe('turtle');
  });

  it('recognises JSON-LD by a top-level keyword, wherever it is', () => {
    expect(detectFormat('{"@context": {}, "@graph": []}')).toBe('jsonld');
    expect(detectFormat('{"name": "x", "nested": {"@id": "no"}, "@id": "http://ex.org/a"}')).toBe(
      'jsonld',
    );
    expect(detectFormat('[{"@id": "http://ex.org/a", "http://ex.org/p": 1}]')).toBe('jsonld');
    expect(detectFormat('{"nodes": [{"id": "@context"}], "edges": []}')).toBe('json');
  });

  it('recognises JSON after a byte order mark and whitespace', () => {
    expect(detectFormat('﻿ \n {"nodes": []}')).toBe('json');
    expect(detectFormat('[ {"data": {"id": "a"}} ]')).toBe('json');
    expect(detectFormat('[]')).toBe('json');
  });

  it('reads a leading [ as a Turtle blank node when no JSON value follows', () => {
    expect(detectFormat('[] a <http://example.org/Thing> .')).toBe('turtle');
    expect(detectFormat('[ <http://example.org/p> "x" ] .')).toBe('turtle');
  });

  it('recognises OBO by its header or by a stanza line', () => {
    expect(detectFormat('format-version: 1.4\n')).toBe('obo');
    expect(detectFormat('! comment\n[Term]\nid: X:1\n')).toBe('obo');
    expect(detectFormat('[Typedef]\r\nid: part_of\r\n')).toBe('obo');
  });

  it('recognises Turtle by @prefix / PREFIX / @base directives, in any case', () => {
    expect(detectFormat('@prefix ex: <http://ex.org/> .\nex:a ex:b ex:c .')).toBe('turtle');
    expect(detectFormat('PREFIX ex: <http://ex.org/>\nex:a ex:b ex:c .')).toBe('turtle');
    expect(detectFormat('prefix ex: <http://ex.org/>\nex:a ex:b ex:c .')).toBe('turtle');
    expect(detectFormat('@base <http://ex.org/> .\n<a> <b> <c> .')).toBe('turtle');
  });

  it('recognises Turtle without directives when statements are not line-based', () => {
    expect(detectFormat('<http://a> <http://b> "x" ;\n  <http://c> <http://d> .')).toBe('turtle');
    expect(detectFormat('ex:a ex:b ex:c .')).toBe('turtle');
  });

  it('tells N-Triples from N-Quads by the number of terms per statement', () => {
    const triple = '<http://a> <http://b> "x"@en-GB .';
    const quad = '<http://a> <http://b> _:c <http://g> .';
    expect(detectFormat(`# header\n${triple}\n\n${triple}\n`)).toBe('ntriples');
    expect(detectFormat(`${triple}\n${quad}\n`)).toBe('nquads');
    expect(detectFormat('<http://a> <http://b> "a \\"quoted\\" text"^^<http://t> .')).toBe(
      'ntriples',
    );
  });

  it('tells TriG from Turtle by a graph block, ignoring braces in strings, IRIs and comments', () => {
    expect(detectFormat('@prefix ex: <http://ex.org/> .\nex:g { ex:a ex:b ex:c . }')).toBe('trig');
    expect(detectFormat('PREFIX ex: <http://ex.org/>\nGRAPH ex:g {\n ex:a ex:b ex:c .\n}')).toBe(
      'trig',
    );
    expect(
      detectFormat(
        '@prefix ex: <http://ex.org/> .\n# {comment}\nex:a ex:b "{text}", """{long\n}""" .',
      ),
    ).toBe('turtle');
    expect(
      detectFormat('@prefix ex: <http://ex.org/> .\nex:a ex:b ex:c {| ex:since 2020 |} .'),
    ).toBe('turtle');
  });

  it('treats empty and comment-only input as an empty Turtle graph', () => {
    expect(detectFormat('')).toBe('turtle');
    expect(detectFormat('  \n# nothing here\n')).toBe('turtle');
    expect(parseGraph('').graph).toEqual({ nodes: [], edges: [] });
  });

  it('only samples the start of large N-Triples files', () => {
    const line = '<http://example.org/s> <http://example.org/p> "a value long enough to fill" .\n';
    const big = line.repeat(5000);
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect(detectFormat(big)).toBe('ntriples');
  });
});

describe('detectFormat errors', () => {
  it('rejects OWL/XML, GraphML, GEXF and other XML with a conversion hint', () => {
    const owlXml = catchError(() =>
      detectFormat(
        '<?xml version="1.0"?>\n<Ontology xmlns="http://www.w3.org/2002/07/owl#" ontologyIRI="http://ex.org/o">',
        'pizza.owx',
      ),
    );
    expect(owlXml.code).toBe('invalid-input');
    expect(owlXml.message).toBe(
      'OWL/XML is not supported ("pizza.owx"). Convert it to RDF/XML or Turtle first (e.g. `robot convert --input onto.owx --output onto.owl`).',
    );
    expect(owlXml.details).toEqual({ filename: 'pizza.owx' });
    expect(catchError(() => detectFormat('<Ontology xmlns="x">')).message).toMatch(/^OWL\/XML/);
    // OWL API declares xmlns:rdf in OWL/XML too; only rdf: attributes make a node element.
    expect(
      catchError(() =>
        detectFormat(
          '<Ontology xmlns="http://www.w3.org/2002/07/owl#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ontologyIRI="http://ex.org/o">',
        ),
      ).message,
    ).toMatch(/^OWL\/XML is not supported/);
    const graphml = catchError(() =>
      detectFormat(
        '<?xml version="1.0"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
      ),
    );
    expect(graphml.message).toMatch(/^GraphML is not supported\. Export it as JSON first/);
    expect(
      catchError(() => detectFormat('<gexf xmlns="http://gexf.net/1.3" version="1.3">')).message,
    ).toMatch(/^GEXF is not supported/);
    expect(
      catchError(() => detectFormat('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).message,
    ).toMatch(/^XML with root element <svg> is not supported\. kgdiff reads RDF\/XML/);
  });

  it('rejects OWL Functional and Manchester syntax', () => {
    expect(
      catchError(() => detectFormat('Prefix(:=<http://ex.org/>)\nOntology(<http://ex.org/o>)'))
        .message,
    ).toMatch(/OWL Functional Syntax is not supported/);
    expect(
      catchError(() => detectFormat('Prefix: : <http://ex.org/>\nOntology: <x>')).message,
    ).toMatch(/Manchester/);
  });

  it('asks for an explicit format when nothing matches', () => {
    const error = catchError(() => detectFormat('just some words', 'notes.txt'));
    expect(error.code).toBe('invalid-input');
    expect(error.message).toBe(
      'Could not detect the format of "notes.txt". Pass `format` explicitly (json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo).',
    );
    expect(error.details).toEqual({ filename: 'notes.txt' });
  });
});
