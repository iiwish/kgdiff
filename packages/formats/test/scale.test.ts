import { hashGraph, normalize } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import type { FormatId } from '../src/index.js';
import { parseGraph } from '../src/sync.js';

/**
 * Large inputs in every RDF syntax. These assert results, not speed: wall-clock budgets live
 * in performance.test.ts, and timings here are only logged so regressions stay visible.
 */
const TRIPLES = 50_000;
const TRIPLES_PER_CLASS = 11;
const CLASSES = Math.ceil(TRIPLES / TRIPLES_PER_CLASS);

const OBO = 'http://purl.obolibrary.org/obo/';
const EX = 'https://example.org/onto/';
const id = (i: number) => `EX_${String(i).padStart(7, '0')}`;

/** One OWL-flavoured class: labels in two languages, typed literals, hierarchy, a restriction. */
interface ClassModel {
  readonly id: string;
  readonly index: number;
  readonly parent: string;
  readonly related: string;
  readonly filler: string;
}

const model: readonly ClassModel[] = Array.from({ length: CLASSES }, (_, i) => ({
  id: `${OBO}${id(i)}`,
  index: i,
  parent: i === 0 ? 'http://www.w3.org/2002/07/owl#Thing' : `${OBO}${id(Math.floor((i - 1) / 4))}`,
  related: `${OBO}${id((i * 7919) % CLASSES)}`,
  filler: `${OBO}${id((i * 31) % CLASSES)}`,
}));

function turtle(): string {
  const lines = [
    `@prefix ex: <${EX}> .`,
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  ];
  for (const c of model) {
    lines.push(
      `<${c.id}> a owl:Class ; rdfs:label "class ${c.index}"@en, "类 ${c.index}"@zh ;`,
      `  ex:score ${c.index % 97} ; ex:flag ${c.index % 2 === 0} ; rdfs:subClassOf <${c.parent}> ;`,
      `  ex:related <${c.related}> ;`,
      `  rdfs:subClassOf [ a owl:Restriction ; owl:onProperty <${OBO}BFO_0000050> ; owl:someValuesFrom <${c.filler}> ] .`,
    );
  }
  return lines.join('\n');
}

function rdfXml(): string {
  const lines = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE rdf:RDF [ <!ENTITY xsd "http://www.w3.org/2001/XMLSchema#"> ]>',
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#" xmlns:ex="${EX}">`,
  ];
  for (const c of model) {
    lines.push(
      `  <owl:Class rdf:about="${c.id}">`,
      `    <rdfs:label xml:lang="en">class ${c.index}</rdfs:label>`,
      `    <rdfs:label xml:lang="zh">类 ${c.index}</rdfs:label>`,
      `    <ex:score rdf:datatype="&xsd;integer">${c.index % 97}</ex:score>`,
      `    <ex:flag rdf:datatype="&xsd;boolean">${c.index % 2 === 0}</ex:flag>`,
      `    <rdfs:subClassOf rdf:resource="${c.parent}"/>`,
      `    <ex:related rdf:resource="${c.related}"/>`,
      '    <rdfs:subClassOf>',
      `      <owl:Restriction><owl:onProperty rdf:resource="${OBO}BFO_0000050"/><owl:someValuesFrom rdf:resource="${c.filler}"/></owl:Restriction>`,
      '    </rdfs:subClassOf>',
      '  </owl:Class>',
    );
  }
  lines.push('</rdf:RDF>');
  return lines.join('\n');
}

function jsonLd(): string {
  return JSON.stringify({
    '@context': {
      ex: EX,
      obo: OBO,
      owl: 'http://www.w3.org/2002/07/owl#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      label: { '@id': 'rdfs:label', '@container': '@language' },
      subClassOf: { '@id': 'rdfs:subClassOf', '@type': '@id' },
    },
    '@graph': model.map((c) => ({
      '@id': c.id,
      '@type': 'owl:Class',
      label: { en: `class ${c.index}`, zh: `类 ${c.index}` },
      'ex:score': c.index % 97,
      'ex:flag': c.index % 2 === 0,
      subClassOf: [
        c.parent,
        {
          '@type': 'owl:Restriction',
          'owl:onProperty': { '@id': `${OBO}BFO_0000050` },
          'owl:someValuesFrom': { '@id': c.filler },
        },
      ],
      'ex:related': { '@id': c.related },
    })),
  });
}

function timed(format: FormatId, text: string) {
  const start = performance.now();
  const result = parseGraph(text, { format });
  const ms = performance.now() - start;
  console.info(
    `[formats] ${format}: ${CLASSES * TRIPLES_PER_CLASS} triples (${(text.length / 1e6).toFixed(1)} MB) → ${result.graph.nodes.length} nodes in ${ms.toFixed(0)} ms`,
  );
  return result;
}

describe('large RDF inputs', () => {
  it(`parses ~${TRIPLES / 1000}k triples to the same graph in Turtle, RDF/XML and JSON-LD`, () => {
    const results = [
      timed('turtle', turtle()),
      timed('rdfxml', rdfXml()),
      timed('jsonld', jsonLd()),
    ];
    const [reference] = results;
    // Every class is a node; restrictions became edges, so no blank nodes are left.
    expect(reference?.graph.nodes).toHaveLength(CLASSES);
    expect(reference?.graph.edges).toHaveLength(CLASSES * 3);
    const hashes = results.map((result) => hashGraph(normalize(result.graph)));
    expect(new Set(hashes).size).toBe(1);
    for (const result of results) {
      expect(result.warnings).toEqual([]);
      expect(JSON.stringify(result.graph)).toBe(JSON.stringify(reference?.graph));
    }
  });

  it('de-duplicates values of one subject in linear time, in every syntax', () => {
    const values = 20_000;
    const lines = Array.from({ length: values }, (_, i) => `"v${i % (values / 2)}"`);
    const ttl = parseGraph(`<${EX}a> <${EX}v> ${lines.join(', ')} .`, { format: 'turtle' });
    const xml = parseGraph(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="${EX}"><rdf:Description rdf:about="${EX}a">${lines
        .map((value) => `<ex:v>${value.slice(1, -1)}</ex:v>`)
        .join('')}</rdf:Description></rdf:RDF>`,
      { format: 'rdfxml' },
    );
    const json = parseGraph(
      JSON.stringify({ '@id': `${EX}a`, [`${EX}v`]: lines.map((value) => value.slice(1, -1)) }),
      { format: 'jsonld' },
    );
    for (const result of [ttl, xml, json]) {
      expect(result.graph.nodes[0]?.attrs?.[`${EX}v`]).toHaveLength(values / 2);
    }
    expect(JSON.stringify(xml.graph)).toBe(JSON.stringify(ttl.graph));
    expect(JSON.stringify(json.graph)).toBe(JSON.stringify(ttl.graph));
  });
});
