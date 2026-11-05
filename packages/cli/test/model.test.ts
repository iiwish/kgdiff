import type { DiffResult, HunkKind } from '@kgdiff/core';
import { diff, normalize } from '@kgdiff/core';
import { hunkFamily as sceneHunkFamily } from '@kgdiff/scene';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatInt,
  hunkFamily,
  hunkGlyph,
  KIND_FAMILY,
  matchLocale,
  nameStatus,
  overview,
  resolveLocale,
} from '../src/index.js';
import { apportion, percent, possibleMatches } from '../src/model.js';

const KINDS: readonly HunkKind[] = ['add', 'remove', 'merge', 'split', 'modify', 'relations'];

describe('hunk families', () => {
  it('match @kgdiff/scene hunkFamily for every hunk kind', () => {
    for (const kind of KINDS) expect(KIND_FAMILY[kind]).toBe(sceneHunkFamily(kind));
  });

  const before = normalize({
    nodes: [
      { id: 'thing', label: 'Thing' },
      { id: 'animal', label: 'Animal' },
      { id: 'plant', label: 'Plant' },
      { id: 'cat', label: 'Cat' },
      { id: 'dog', label: 'Dog' },
      { id: 'tree', label: 'Tree' },
      { id: 'gone', label: 'Gone' },
    ],
    edges: [
      { source: 'animal', target: 'thing', predicate: 'is_a' },
      { source: 'plant', target: 'thing', predicate: 'is_a' },
      { source: 'cat', target: 'animal', predicate: 'is_a' },
      { source: 'dog', target: 'animal', predicate: 'is_a' },
      { source: 'tree', target: 'animal', predicate: 'is_a' },
      { source: 'gone', target: 'thing', predicate: 'is_a' },
      { source: 'cat', target: 'dog', predicate: 'chases' },
    ],
  });
  const after = normalize({
    nodes: [
      { id: 'thing', label: 'Thing' },
      { id: 'animal', label: 'Animal' },
      { id: 'plant', label: 'Plant' },
      { id: 'cat', label: 'House cat' },
      { id: 'dog', label: 'Dog' },
      { id: 'tree', label: 'Tree' },
      { id: 'new', label: 'New' },
    ],
    edges: [
      { source: 'animal', target: 'thing', predicate: 'is_a' },
      { source: 'plant', target: 'thing', predicate: 'is_a' },
      { source: 'cat', target: 'animal', predicate: 'is_a' },
      { source: 'dog', target: 'animal', predicate: 'is_a' },
      { source: 'tree', target: 'plant', predicate: 'is_a' },
      { source: 'new', target: 'thing', predicate: 'is_a' },
      { source: 'dog', target: 'cat', predicate: 'chases' },
    ],
  });
  const result = diff(before, after, { match: { strategy: 'id' }, hierarchyPredicates: ['is_a'] });
  const byAnchor = (anchor: string, kind?: HunkKind) => {
    const hunk = result.hunks.find((h) => h.anchor === anchor && (!kind || h.kind === kind));
    if (!hunk)
      throw new Error(`no hunk for ${anchor}: ${result.hunks.map((h) => h.id).join(', ')}`);
    return hunk;
  };

  it('shows pure hierarchy moves as structure', () => {
    const move = byAnchor('tree');
    expect(move.kind).toBe('modify');
    expect(move.phase).toBe('restructure');
    expect(hunkFamily(move)).toBe('structure');
    expect(hunkGlyph(move)).toBe('⇄');
    expect(nameStatus(move, result)).toBe('V');
  });

  it('names renames, additions and removals', () => {
    const rename = byAnchor('cat');
    expect(hunkFamily(rename)).toBe('content');
    expect(hunkGlyph(rename)).toBe('~');
    expect(nameStatus(rename, result)).toBe('R');
    expect(nameStatus(byAnchor('new', 'add'), result)).toBe('A');
    expect(hunkGlyph(byAnchor('new', 'add'))).toBe('+');
    expect(nameStatus(byAnchor('gone', 'remove'), result)).toBe('D');
    expect(hunkGlyph(byAnchor('gone', 'remove'))).toBe('−');
    const relations = result.hunks.find((h) => h.kind === 'relations');
    if (relations) {
      expect(nameStatus(relations, result)).toBe('E');
      expect(hunkFamily(relations)).toBe('structure');
    }
  });

  it('counts hunks and changed elements per phase', () => {
    const ov = overview(result);
    expect(ov.hunks).toBe(result.hunks.length);
    const changed =
      result.nodes.filter((n) => n.status !== 'unchanged').length +
      result.edges.filter((e) => e.status !== 'unchanged').length;
    expect(ov.changes).toBe(changed);
    expect(Object.values(ov.phases).reduce((a, p) => a + p.hunks, 0)).toBe(ov.hunks);
  });
});

describe('apportion', () => {
  it('splits proportionally', () => {
    expect(apportion([1, 1, 2], 8)).toEqual([2, 2, 4]);
    expect(apportion([0, 3, 0], 5)).toEqual([0, 5, 0]);
    expect(apportion([], 5)).toEqual([]);
    expect(apportion([1, 2], 0)).toEqual([0, 0]);
  });

  it('gives every non-zero weight a cell and fills exactly the total (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 60 }),
        (weights, total) => {
          const cells = apportion(weights, total);
          const positive = weights.filter((w) => w > 0).length;
          if (positive === 0) return;
          expect(cells.reduce((a, b) => a + b, 0)).toBe(total);
          if (total >= positive) {
            weights.forEach((w, i) => {
              if (w > 0) expect(cells[i]).toBeGreaterThanOrEqual(1);
              else expect(cells[i]).toBe(0);
            });
          }
        },
      ),
    );
  });
});

describe('possibleMatches', () => {
  const evidence = { label: 0.5, neighbors: 1, types: 1, attrs: 0 };
  const node = (status: string, label: string, side?: 'before' | 'after', own?: string) => ({
    status,
    label,
    ...(side ? { [side]: { label: own ?? label } } : {}),
  });
  const before: Record<string, object> = {
    gone: node('removed', 'Gone', 'before', 'Gone (old name)'),
    kept: node('modified', 'Kept'),
    long: node('removed', 'L'.repeat(45), 'before'),
  };
  const after: Record<string, object> = {
    fresh: node('added', 'Fresh', 'after'),
    same: node('unchanged', 'Same'),
  };
  const fake = (suggestions: readonly object[]): DiffResult =>
    ({
      suggestions,
      index: { nodeByBefore: (id: string) => before[id], nodeByAfter: (id: string) => after[id] },
    }) as unknown as DiffResult;
  const s = (b: string, a: string, score: number) => ({
    before: b,
    after: a,
    score,
    evidence,
    reason: 'below-threshold',
  });

  it('keeps pairings with a removed or an added side, highest score first, then by ids', () => {
    const list = possibleMatches(
      fake([
        s('kept', 'same', 0.95),
        s('gone', 'same', 0.7),
        s('kept', 'fresh', 0.8),
        s('gone', 'fresh', 0.7),
      ]),
    );
    expect(list.map((p) => [p.before.id, p.after.id, p.score])).toEqual([
      ['kept', 'fresh', 0.8],
      ['gone', 'fresh', 0.7],
      ['gone', 'same', 0.7],
    ]);
  });

  it('names each side as it was in its own version, shortened to 40 characters', () => {
    const [gone, long] = possibleMatches(fake([s('gone', 'fresh', 0.9), s('long', 'fresh', 0.8)]));
    expect(gone?.before.name).toBe('Gone (old name)');
    expect(gone?.after.name).toBe('Fresh');
    expect(long?.before.name).toBe(`${'L'.repeat(39)}…`);
    expect(gone?.label).toBe(0.5);
    expect(gone?.neighbors).toBe(1);
  });

  it('formats scores as whole percentages', () => {
    expect(percent(0.796297)).toBe('80%');
    expect(percent(0.82)).toBe('82%');
    expect(percent(1)).toBe('100%');
  });
});

describe('locale', () => {
  it('maps tags and POSIX locales', () => {
    expect(matchLocale('zh_CN.UTF-8')).toBe('zh-CN');
    expect(matchLocale('zh-Hant-TW')).toBe('zh-CN');
    expect(matchLocale('ZH')).toBe('zh-CN');
    expect(matchLocale('en_GB.UTF-8')).toBe('en');
    expect(matchLocale('C')).toBe('en');
    expect(matchLocale('fr_FR')).toBeUndefined();
  });

  it('prefers the flag, then LC_ALL, LC_MESSAGES and LANG', () => {
    expect(resolveLocale('en', { LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveLocale(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(resolveLocale(undefined, { LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveLocale(undefined, { LC_MESSAGES: 'zh_TW', LANG: 'en_US' })).toBe('zh-CN');
    expect(resolveLocale(undefined, { LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(resolveLocale(undefined, {})).toBe('en');
  });

  it('formats integers with thousands separators', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(1234567)).toBe('1,234,567');
  });
});
