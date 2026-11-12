import { predicateLabel } from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tripleKey } from '../src/canonical.js';
import { blockKeys, jaroWinkler, normalizeText, textProfile } from '../src/similarity.js';
import { textSimilarity } from '../src/sync.js';

describe('normalizeText', () => {
  it('applies NFKC, lowercases, turns punctuation into spaces and collapses whitespace', () => {
    expect(normalizeText('  Hello,​ World!  ÄÖ — ＡＢＣ_def/ghi  ')).toBe(
      'hello world äö abc def ghi',
    );
  });

  it('treats CJK punctuation as separators', () => {
    expect(normalizeText('「法定代表人」、企业。')).toBe('法定代表人 企业');
  });
});

describe('textSimilarity', () => {
  it('is 1 for strings that are equal after normalization', () => {
    expect(textSimilarity('Data_Base', 'data-base')).toBe(1);
    expect(textSimilarity('ＡＢＣ', 'abc')).toBe(1);
    expect(textSimilarity('法定代表人', ' 法定代表人 ')).toBe(1);
  });

  it('ignores word order', () => {
    expect(textSimilarity('New York', 'york, new')).toBe(1);
  });

  it('scores a name with an inserted middle part by its shared tokens', () => {
    expect(textSimilarity('Marie Curie', 'Marie Skłodowska-Curie')).toBe(0.8);
  });

  it('understands abbreviations written with a period', () => {
    expect(textSimilarity('Univ. of Paris', 'University of Paris')).toBeCloseTo(0.966667, 6);
    // Without the period "univ" is just another word.
    expect(textSimilarity('Univ of Paris', 'University of Paris')).toBeLessThan(0.7);
  });

  it('compares CJK text by character bigrams', () => {
    expect(textSimilarity('法人代表', '法定代表人')).toBeCloseTo(2 / 7, 6);
    expect(textSimilarity('高管任职', '董监高任职')).toBeCloseTo(2 / 7, 6);
  });

  it('uses Jaro–Winkler for strings shorter than four characters', () => {
    expect(textSimilarity('IBM', 'IBM Corp')).toBeCloseTo(0.809524, 6);
    expect(textSimilarity('GO', 'G0')).toBeCloseTo(0.666667, 6);
  });

  it('does not let a shared prefix make a short string look like a long one', () => {
    // Plain Jaro, without the Winkler prefix bonus (which made it 0.8).
    expect(textSimilarity('AB', 'ABCDEFGH')).toBe(0.75);
  });

  it('caps texts that mention different numbers', () => {
    for (const [a, b] of [
      ['Type 1 diabetes mellitus', 'Type 2 diabetes mellitus'],
      ['Vitamin B1', 'Vitamin B12'],
      ['Windows 10', 'Windows 11'],
      ['Patient 001', 'Patient 002'],
      ['IL2', 'IL21'],
    ]) {
      expect(textSimilarity(a as string, b as string), `${a} ~ ${b}`).toBeLessThanOrEqual(0.5);
    }
    // Same numbers (leading zeros aside), or a number on one side only: no cap.
    expect(textSimilarity('Patient 007', 'patient 7')).toBeGreaterThan(0.5);
    expect(textSimilarity('stg_orders', 'stg_orders_v2')).toBeGreaterThan(0.8);
  });

  it('is 0 for unrelated strings', () => {
    expect(textSimilarity('Apple', 'Orange')).toBe(0);
    expect(textSimilarity('a', 'b')).toBe(0);
    expect(textSimilarity('', 'abc')).toBe(0);
  });

  it('compares strings made only of punctuation as written', () => {
    expect(textSimilarity('…', '…')).toBe(1);
    expect(textSimilarity('…', '!!!')).toBe(0);
    expect(textSimilarity('', '')).toBe(1);
  });

  it('rounds to 1e-6', () => {
    const s = textSimilarity('Nobel Prize in Physics', 'Nobel Prize');
    expect(s).toBe(Math.round(s * 1e6) / 1e6);
  });

  it('counts astral characters as one character', () => {
    expect(textSimilarity('😀😀😀😀', '😀😀😀😀')).toBe(1);
    expect(textSimilarity('a😀bc', 'a😀bd')).toBeGreaterThan(0.6);
  });
});

describe('jaroWinkler', () => {
  it('matches the reference values', () => {
    expect(jaroWinkler([...'martha'], [...'marhta'])).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler([...'dwayne'], [...'duane'])).toBeCloseTo(0.84, 4);
    // No prefix bonus when the lengths differ too much (5 vs 8): plain Jaro.
    expect(jaroWinkler([...'dixon'], [...'dicksonx'])).toBeCloseTo(0.7667, 4);
    expect(jaroWinkler([...'ab'], [...'abcdefgh'])).toBeCloseTo(0.75, 4);
  });

  it('handles empty inputs', () => {
    expect(jaroWinkler([], [])).toBe(1);
    expect(jaroWinkler([], ['a'])).toBe(0);
  });
});

describe('blocking keys', () => {
  const keys = (text: string): string[] => {
    const out = new Set<string>();
    blockKeys(textProfile(text), out);
    return [...out].sort();
  };

  it('index the full string, informative words and word prefixes', () => {
    expect(keys('University of Paris')).toEqual([
      'f:university of paris',
      'p:pari',
      'p:univ',
      'w:paris',
      'w:university',
    ]);
  });

  it('index CJK text by character bigrams', () => {
    expect(keys('法定代表人')).toEqual(
      expect.arrayContaining(['b:法定', 'b:定代', 'b:代表', 'b:表人', 'f:法定代表人']),
    );
    expect(keys('法人代表')).toContain('b:代表');
  });

  it('keep text made only of punctuation searchable', () => {
    expect(keys('…')).toEqual(['r:...']); // NFKC folds the ellipsis
    expect(keys('')).toEqual([]);
  });
});

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
