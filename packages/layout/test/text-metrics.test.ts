import { describe, expect, it } from 'vitest';
import { estimateLabelWidth, nodeRadius } from '../src/index.js';

const em = (text: string): number => estimateLabelWidth(text, 1);

describe('estimateLabelWidth', () => {
  it('sums per-character advances', () => {
    expect(em('')).toBe(0);
    expect(em('a')).toBeCloseTo(0.56);
    expect(em('A')).toBeCloseTo(0.68);
    expect(em('7')).toBeCloseTo(0.6);
    expect(em(' ')).toBeCloseTo(0.3);
    expect(em('Ab 1')).toBeCloseTo(0.68 + 0.56 + 0.3 + 0.6);
    expect(em('.,;-_')).toBeCloseTo(5 * 0.56);
  });

  it('scales linearly with the font size', () => {
    expect(estimateLabelWidth('Gene Ontology', 12)).toBeCloseTo(12 * em('Gene Ontology'));
  });

  it('counts CJK, kana, Hangul and full-width forms as 1em', () => {
    expect(em('知识图谱')).toBeCloseTo(4);
    expect(em('カタカナ')).toBeCloseTo(4);
    expect(em('한국어')).toBeCloseTo(3);
    expect(em('ＡＢ１')).toBeCloseTo(3);
    expect(em('，。')).toBeCloseTo(2);
    expect(em('　')).toBeCloseTo(1);
    expect(em('𠀀')).toBeCloseTo(1); // CJK Ext. B (surrogate pair)
    expect(em('投资 Invest')).toBeCloseTo(2 + 0.3 + 0.68 + 5 * 0.56);
  });

  it('counts emoji as 1em, ignoring joiners, variation selectors and skin tones', () => {
    expect(em('🚀')).toBeCloseTo(1);
    expect(em('👍🏽')).toBeCloseTo(1);
    expect(em('❤️')).toBeCloseTo(1);
    expect(em('👨‍👩‍👧')).toBeCloseTo(3);
    expect(em('🇫🇷')).toBeCloseTo(1);
  });

  it('treats other scripts by case', () => {
    expect(em('Ω')).toBeCloseTo(0.68);
    expect(em('ω')).toBeCloseTo(0.56);
    expect(em('Ж')).toBeCloseTo(0.68);
    expect(em('é')).toBeCloseTo(0.56);
    expect(em('é')).toBeCloseTo(0.56); // combining accent adds nothing
    expect(em('٣')).toBeCloseTo(0.6); // Arabic-Indic digit
    expect(em(' ')).toBeCloseTo(0.3);
  });

  it('is deterministic and monotonic in the text', () => {
    expect(em('abc')).toBe(em('abc'));
    expect(em('abcd')).toBeGreaterThan(em('abc'));
  });
});

describe('nodeRadius', () => {
  it('is clamp(4 + 2.2·√degree, 4, 14)', () => {
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(-3)).toBe(4);
    expect(nodeRadius(4)).toBeCloseTo(8.4);
    expect(nodeRadius(10_000)).toBe(14);
  });
});
