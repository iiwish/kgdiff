import { predicateLabel } from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tripleKey } from '../src/canonical.js';

describe('predicateLabel', () => {
  it.each([
    ['rdfs:subClassOf', 'subClassOf'],
    ['http://www.w3.org/2000/01/rdf-schema#subClassOf', 'subClassOf'],
    ['http://purl.obolibrary.org/obo/part_of', 'part of'],
    ['http://example.org/vocab#hasPart', 'hasPart'],
    ['schema:worksFor', 'worksFor'],
    ['BFO:0000050', 'BFO:0000050'],
    ['urn:isbn:123', 'urn:isbn:123'],
    ['投资', '投资'],
    ['kg:持股', '持股'],
    ['part%20of', 'part of'],
    ['http://ex.org/a/', 'a'],
    ['__x__', 'x'],
    ['http://purl.obolibrary.org/obo/RO_0002131', 'RO:0002131'],
    ['http://purl.obolibrary.org/obo/BFO_0000050', 'BFO:0000050'],
    ['http://purl.obolibrary.org/obo/part_of', 'part of'],
    ['', ''],
  ])('%j → %j', (predicate, label) => {
    expect(predicateLabel(predicate)).toBe(label);
  });

  it('survives malformed percent-encoding', () => {
    expect(predicateLabel('ex:bad%E0%A4%A')).toBe('bad%E0%A4%A');
  });
});

describe('structural keys', () => {
  it('equal JSON.stringify([source, predicate, target]) for any strings', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary' }),
        fc.string(),
        fc.string({ unit: 'binary' }),
        (s, p, t) => {
          expect(tripleKey(s, p, t)).toBe(JSON.stringify([s, p, t]));
        },
      ),
      { numRuns: 2000 },
    );
    expect(tripleKey('a"b', 'p\\q', '\ud800x')).toBe(JSON.stringify(['a"b', 'p\\q', '\ud800x']));
  });
});
