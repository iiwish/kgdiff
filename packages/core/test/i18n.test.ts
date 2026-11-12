import { type FacetKind, facetLabel, formatHunk, type GraphInput, type Locale } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff } from './support/engine.js';

const FACETS: readonly FacetKind[] = [
  'rekey', 'rename', 'mergedInto', 'mergeTarget', 'splitFrom', 'splitInto', 'move', 'deprecate',
  'replacement', 'types', 'aliases', 'attrs', 'retarget', 'predicate', 'label', 'collapsed',
]; // biome-ignore format: compact list

/** Titles and subtitles of every hunk, in review order. */
function titles(before: GraphInput, after: GraphInput, locale: Locale = 'en'): [string, string][] {
  const d = diff(before, after);
  return d.hunks.map((h) => {
    const { title, subtitle } = formatHunk(h, d, locale);
    return [title, subtitle];
  });
}

const named = (ids: string[]) => ids.map((id) => ({ id, label: id.toUpperCase() }));

describe('facetLabel', () => {
  it.each(['en', 'zh-CN'] as const)('names every facet kind in %s', (locale) => {
    const labels = FACETS.map((kind) => facetLabel(kind, locale));
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(FACETS.length);
  });

  it('defaults to English', () => {
    expect(facetLabel('rename')).toBe('Renamed');
    expect(facetLabel('rename', 'zh-CN')).toBe('改名');
    expect(facetLabel('move', 'zh-CN')).toBe('移动');
  });

  it('rejects unknown kinds', () => {
    expect(() => facetLabel('teleport' as FacetKind)).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});

describe('formatHunk: additions and removals', () => {
  it('names the anchor and counts the rest', () => {
    const base = { nodes: named(['h']), edges: [] };
    expect(titles(base, { nodes: named(['h', 'a']), edges: [] })).toEqual([
      ['Added “A”', 'standalone'],
    ]);
    expect(
      titles(base, { nodes: named(['h', 'a', 'b']), edges: [{ source: 'a', target: 'b' }] }),
    ).toEqual([['Added “A”, “B” and 1 relation', 'standalone']]);
    const three = {
      nodes: named(['h', 'a', 'b', 'c']),
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'a', target: 'h' },
      ],
    };
    expect(titles(base, three)).toEqual([
      ['Added “A”, 2 more nodes and 3 relations', 'linked to “H”'],
    ]);
    expect(titles(base, three, 'zh-CN')).toEqual([
      ['新增「A」等 3 个节点及 3 条关系', '关联「H」'],
    ]);
    expect(titles(three, base)).toEqual([
      ['Removed “A”, 2 more nodes and 3 relations', 'was linked to “H”'],
    ]);
    expect(titles(three, base, 'zh-CN')).toEqual([
      ['删除「A」等 3 个节点及 3 条关系', '原关联「H」'],
    ]);
  });
});

describe('formatHunk: node edits', () => {
  it('describes the most telling change first', () => {
    const before: GraphInput = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', deprecated: true },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
        { id: 'e', label: 'E' },
        { id: 'f', label: 'F', attrs: { k: 1 } },
      ],
      edges: [],
    };
    const after: GraphInput = {
      nodes: [
        { id: 'a', label: 'A', deprecated: true, replacedBy: ['n'] },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C', type: 'T' },
        { id: 'd', label: 'D', aliases: ['Dee', 'Di'] },
        { id: 'e', label: 'E', type: 'T', attrs: { k: 1 } },
        { id: 'f', label: 'F2', attrs: { k: 2 } },
        { id: 'n', label: 'Next' },
      ],
      edges: [],
    };
    // “A” is replaced by a brand-new node: a deprecation, not a merge.
    expect(titles(before, after)).toEqual([
      ['Deprecated “A”', 'replaced by “Next”'],
      ['Restored “B”', ''],
      ['Changed the type of “C”', '+1 type'],
      ['Updated synonyms of “D”', '+2 synonyms'],
      ['Edited “E”', '+1 attribute · +1 type'],
      ['Renamed “F” → “F2”', '~1 attribute'],
      ['Added “Next”', 'standalone'],
    ]);
    expect(titles(before, after, 'zh-CN')).toEqual([
      ['弃用「A」', '由「Next」替代'],
      ['恢复「B」', ''],
      ['修改「C」的类型', '类型 +1'],
      ['修改「D」的别名', '别名 +2'],
      ['修改「E」', '属性 +1 · 类型 +1'],
      ['「F」改名为「F2」', '属性 ~1'],
      ['新增「Next」', '无外部关联'],
    ]);
  });

  it('describes changed replacement links', () => {
    const before: GraphInput = {
      nodes: [
        { id: 'a', label: 'A', deprecated: true, replacedBy: ['b'] },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      edges: [],
    };
    const after: GraphInput = {
      nodes: [
        { id: 'a', label: 'A', deprecated: true, replacedBy: ['c'] },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      edges: [],
    };
    expect(titles(before, after)).toEqual([
      ['Merged “A” into “C”', 'via replacement hint · kept as deprecated'],
    ]);
    const unlinked: GraphInput = {
      ...after,
      nodes: [{ id: 'a', label: 'A', deprecated: true }, ...after.nodes.slice(1)],
    };
    expect(titles(before, unlinked)).toEqual([
      ['Updated replacement links of “A”', 'no longer replaced'],
    ]);
    expect(titles(before, unlinked, 'zh-CN')).toEqual([['修改「A」的替代关系', '不再有替代项']]);
    expect(facetLabel('replacement')).toBe('Replacement links');
    expect(facetLabel('replacement', 'zh-CN')).toBe('替代关系');
  });

  it('summarizes a move with its other changes', () => {
    const before: GraphInput = {
      nodes: [
        { id: 'x', label: 'X', attrs: { a: 1 } },
        { id: 'p', label: 'P' },
        { id: 'q', label: 'Q' },
      ],
      edges: [{ source: 'x', target: 'p', predicate: 'is_a' }],
    };
    const after: GraphInput = {
      nodes: [
        { id: 'x', label: 'X', attrs: { b: 1, c: 2 } },
        { id: 'p', label: 'P' },
        { id: 'q', label: 'Q' },
      ],
      edges: [{ source: 'x', target: 'q', predicate: 'is_a' }],
    };
    expect(titles(before, after)).toEqual([['Moved “X” under “Q”', '+2 −1 attributes · from “P”']]);
    expect(titles(before, after, 'zh-CN')).toEqual([
      ['「X」移至「Q」下', '属性 +2 −1 · 原属「P」'],
    ]);
    expect(titles(before, { ...after, edges: [] })).toEqual([
      ['Detached “X” from “P”', '+2 −1 attributes'],
    ]);
  });

  it('shortens long names', () => {
    const long = 'A very long label that keeps going and going beyond forty characters';
    const [[title]] = titles(
      { nodes: [{ id: 'x', label: long }], edges: [] },
      { nodes: [{ id: 'x', label: 'Short' }], edges: [] },
    ) as [[string, string]];
    expect(title).toBe('Renamed “A very long label that keeps going and …” → “Short”');
  });
});

describe('formatHunk: relations', () => {
  it('reads single relation changes as sentences', () => {
    const before: GraphInput = {
      nodes: named(['s', 't', 'u']),
      edges: [
        { source: 's', target: 't', predicate: 'p' },
        { source: 't', target: 'u', predicate: 'q', attrs: { w: 1 } },
      ],
    };
    const after: GraphInput = {
      nodes: named(['s', 't', 'u']),
      edges: [
        { source: 'u', target: 's', predicate: 'r' },
        { source: 't', target: 'u', predicate: 'q', label: 'Q', attrs: { w: 2 } },
      ],
    };
    expect(titles(before, after)).toEqual([
      ['Removed “S” —p→ “T”', 'relation removed'],
      ['Edited “T” —Q→ “U”', 'label “q” → “Q” · ~1 attribute'],
      ['Added “U” —r→ “S”', 'new relation'],
    ]);
    expect(titles(before, after, 'zh-CN')).toEqual([
      ['删除关系「S」—p→「T」', '关系已删除'],
      ['修改关系「T」—Q→「U」', '标签「q」→「Q」 · 属性 ~1'],
      ['新增关系「U」—r→「S」', '新关系'],
    ]);
  });

  it('describes a retargeted source end', () => {
    const before: GraphInput = {
      nodes: named(['s', 't', 'u']),
      edges: [{ source: 's', target: 't', predicate: 'holds' }],
    };
    const after: GraphInput = {
      nodes: named(['s', 't', 'u']),
      edges: [{ source: 'u', target: 't', predicate: 'holds' }],
    };
    expect(titles(before, after)).toEqual([
      ['“T”: holds now comes from “U” (was “S”)', 'relation moved to another subject'],
    ]);
    expect(titles(before, after, 'zh-CN')).toEqual([
      ['「T」的「holds」改为来自「U」（原为「S」）', '关系改为来自新节点'],
    ]);
  });

  it('counts several relation changes of one node', () => {
    const before: GraphInput = {
      nodes: named(['s', 't', 'u', 'v']),
      edges: [{ source: 's', target: 'v', predicate: 'x' }],
    };
    const after: GraphInput = {
      nodes: named(['s', 't', 'u', 'v']),
      edges: [
        { source: 's', target: 't', predicate: 'p' },
        { source: 's', target: 'u', predicate: 'q' },
      ],
    };
    expect(titles(before, after)).toEqual([['Updated 3 relations of “S”', '+2 −1 relations']]);
    expect(titles(before, after, 'zh-CN')).toEqual([['修改「S」的 3 条关系', '关系 +2 −1']]);
    expect(titles({ ...before, edges: [] }, after)).toEqual([
      ['Added 2 relations to “S”', '+2 relations'],
    ]);
    expect(titles(after, { ...after, edges: [] }, 'zh-CN')).toEqual([
      ['删除「S」的 2 条关系', '关系 −2'],
    ]);
  });
});

describe('formatHunk: merges and splits', () => {
  it('lists several sources', () => {
    const before: GraphInput = { nodes: named(['a', 'b', 'c', 't']), edges: [] };
    expect(
      titles(before, { nodes: [{ id: 't', label: 'T', replaces: ['a', 'b', 'c'] }], edges: [] }),
    ).toEqual([['Merged “A”, “B” and 1 more into “T”', 'via replacement hint']]);
    expect(
      titles(
        before,
        { nodes: [{ id: 't', label: 'T', replaces: ['a', 'b', 'c'] }], edges: [] },
        'zh-CN',
      ),
    ).toEqual([['「A」、「B」等 3 个节点合并入「T」', '依据替代声明']]);
  });

  it('lists the nodes a source split into, and says what became of the source', () => {
    const before: GraphInput = { nodes: [{ id: 'x', label: 'X' }], edges: [] };
    const kept: GraphInput = {
      nodes: [
        { id: 'x', label: 'X' },
        { id: 't', label: 'T', replaces: ['x'] },
        { id: 'u', label: 'U', replaces: ['x'] },
      ],
      edges: [],
    };
    expect(titles(before, kept)).toEqual([
      ['Split “X” into “T” and “U”', 'via replacement hint · source kept'],
    ]);
    expect(titles(before, kept, 'zh-CN')).toEqual([
      ['「X」拆分为「T」和「U」', '依据替代声明 · 源节点保留'],
    ]);
    // Deprecated and renamed, as OBO obsoletes a split term: named as it was, never as a target.
    const obsoleted: GraphInput = {
      nodes: [
        { id: 'x', label: 'obsolete X', deprecated: true, replacedBy: ['t', 'u'] },
        { id: 't', label: 'T' },
        { id: 'u', label: 'U' },
      ],
      edges: [],
    };
    expect(titles(before, obsoleted)).toEqual([
      ['Split “X” into “T” and “U”', 'via replacement hint · source kept as deprecated'],
    ]);
    expect(titles(before, obsoleted, 'zh-CN')).toEqual([
      ['「X」拆分为「T」和「U」', '依据替代声明 · 源节点保留为已弃用'],
    ]);
  });
});

describe('formatHunk: equally named nodes', () => {
  it('appends ids when the names involved are the same', () => {
    const before: GraphInput = {
      nodes: [
        { id: 'T', label: 'Heart' },
        { id: 'Y', label: 'Heart' },
      ],
      edges: [],
    };
    const after: GraphInput = { nodes: [{ id: 'T', label: 'Heart', replaces: ['Y'] }], edges: [] };
    expect(titles(before, after)[0]?.[0]).toBe('Merged “Heart” (Y) into “Heart” (T)');
    expect(titles(before, after, 'zh-CN')[0]?.[0]).toBe('「Heart」（Y）合并入「Heart」（T）');
  });

  it('leaves distinct names alone', () => {
    const before: GraphInput = {
      nodes: [
        { id: 'T', label: 'Heart' },
        { id: 'Y', label: 'Cardiac organ' },
      ],
      edges: [],
    };
    const after: GraphInput = { nodes: [{ id: 'T', label: 'Heart', replaces: ['Y'] }], edges: [] };
    expect(titles(before, after)[0]?.[0]).toBe('Merged “Cardiac organ” into “Heart”');
  });
});

describe('formatHunk: contract', () => {
  it('defaults to English and rejects hunks of another diff', () => {
    const d = diff(
      { nodes: [{ id: 'a' }], edges: [] },
      { nodes: [{ id: 'b' }], edges: [] },
      { match: { strategy: 'id' } },
    );
    const other = diff({ nodes: [], edges: [] }, { nodes: [{ id: 'zz' }], edges: [] });
    const [hunk] = d.hunks;
    if (!hunk) throw new Error('expected a hunk');
    expect(formatHunk(hunk, d)).toEqual(formatHunk(hunk, d, 'en'));
    const [foreign] = other.hunks;
    if (!foreign) throw new Error('expected a hunk');
    expect(() => formatHunk(foreign, d)).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});
