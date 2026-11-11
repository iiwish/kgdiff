import { diff, type GraphInput, matchNodes, normalize } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { combineEvidence, generateCandidates } from '../src/match.js';
import { ProfileCache } from '../src/similarity.js';
import { shuffleGraph } from './support/arbitraries.js';

const graph = (nodes: GraphInput['nodes'], edges: GraphInput['edges'] = []) =>
  normalize({ nodes, edges });

describe('matchNodes: strategies', () => {
  const before = graph([
    { id: 'a', label: 'Alpha Corp' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ]);
  const after = graph([
    { id: 'b', label: 'Beta' },
    { id: 'x', label: 'Alpha Corp.' },
    { id: 'c', label: 'Delta' },
  ]);

  it('`id` matches equal ids only', () => {
    const { matches, suggestions } = matchNodes(before, after, { strategy: 'id' });
    expect(matches).toEqual([
      { before: 'b', after: 'b', method: 'id', score: 1 },
      { before: 'c', after: 'c', method: 'id', score: 1 },
    ]);
    expect(suggestions).toEqual([]);
  });

  it('`auto` (default) matches equal ids, then the leftovers by similarity', () => {
    const { matches } = matchNodes(before, after);
    expect(matches.map((m) => [m.before, m.after, m.method])).toEqual([
      ['b', 'b', 'id'],
      ['c', 'c', 'id'],
      ['a', 'x', 'similarity'],
    ]);
    const similar = matches[2];
    expect(similar?.score).toBe(1);
    expect(similar?.evidence).toEqual({ label: 1, neighbors: 0, types: 0, attrs: 0 });
  });

  it('`similarity` ignores ids entirely', () => {
    const b = graph([
      { id: 'k1', label: 'Foo' },
      { id: 'k2', label: 'Bar' },
    ]);
    const a = graph([
      { id: 'k1', label: 'Bar' },
      { id: 'k2', label: 'Foo' },
    ]);
    const { matches } = matchNodes(b, a, { strategy: 'similarity' });
    expect(matches.map((m) => [m.before, m.after])).toEqual([
      ['k2', 'k1'],
      ['k1', 'k2'],
    ]);
  });

  it('handles empty graphs', () => {
    expect(matchNodes(graph([]), graph([]))).toEqual({ matches: [], suggestions: [] });
    expect(matchNodes(graph([{ id: 'a' }]), graph([]), { strategy: 'similarity' })).toEqual({
      matches: [],
      suggestions: [],
    });
  });
});

describe('matchNodes: evidence', () => {
  it('weights label 0.55, neighbours 0.25, types 0.1, attrs 0.1 over the present signals', () => {
    expect(combineEvidence(0.8, undefined, 1, undefined)).toBeCloseTo((0.55 * 0.8 + 0.1) / 0.65, 6);
    expect(combineEvidence(1, 0.5, 0, 1)).toBeCloseTo((0.55 + 0.125 + 0.1) / 1, 6);
  });

  it('caps the score at 0.5 when the names are unrelated', () => {
    expect(combineEvidence(0.45, 1, 1, 1)).toBe(0.5);
  });

  it('propagates through neighbours: a match unlocks its neighbours in the next round', () => {
    const b = graph(
      [
        { id: 'm1', label: 'Marie Curie', type: 'Person' },
        { id: 'u1', label: 'Univ of Paris', type: 'Org', attrs: { city: 'Paris' } },
      ],
      [{ source: 'm1', target: 'u1', predicate: 'worked at' }],
    );
    const a = graph(
      [
        { id: 'm2', label: 'Marie Curie', type: 'Person' },
        { id: 'u2', label: 'University of Paris', type: 'Org', attrs: { city: 'Paris' } },
      ],
      [{ source: 'm2', target: 'u2', predicate: 'worked at' }],
    );
    const { matches } = matchNodes(b, a);
    const university = matches.find((m) => m.before === 'u1');
    expect(university?.after).toBe('u2');
    expect(university?.evidence).toMatchObject({ neighbors: 1, types: 1, attrs: 1 });
    expect(university?.score).toBeGreaterThanOrEqual(0.82);
  });

  it('respects a custom threshold', () => {
    const b = graph([{ id: 'u1', label: 'Univ of Paris' }]);
    const a = graph([{ id: 'u2', label: 'University of Paris' }]);
    expect(matchNodes(b, a).matches).toEqual([]);
    expect(matchNodes(b, a, { threshold: 0.5 }).matches.map((m) => m.after)).toEqual(['u2']);
  });
});

describe('matchNodes: ambiguity and suggestions', () => {
  it('never picks between equally good candidates and reports them as ambiguous', () => {
    const b = graph([{ id: 'r', label: 'John Smith', type: 'Person' }]);
    const a = graph([
      { id: 'a1', label: 'John Smith', type: 'Person' },
      { id: 'a2', label: 'John Smith', type: 'Person' },
    ]);
    const { matches, suggestions } = matchNodes(b, a);
    expect(matches).toEqual([]);
    expect(suggestions.map((s) => [s.before, s.after, s.reason])).toEqual([
      ['r', 'a1', 'ambiguous'],
      ['r', 'a2', 'ambiguous'],
    ]);
  });

  it('prefers a perfect candidate over a near one', () => {
    const b = graph([{ id: 'r', label: 'John Smith', type: 'Person' }]);
    const a = graph([
      { id: 'a1', label: 'John Smith', type: 'Person' },
      { id: 'a2', label: 'John Smith' },
    ]);
    expect(matchNodes(b, a).matches.map((m) => m.after)).toEqual(['a1']);
  });

  it('suggests the best pair below the threshold', () => {
    const b = graph([{ id: 'r', label: 'Nobel Prize in Physics', type: 'Award' }]);
    const a = graph([{ id: 'a', label: 'Nobel Prize', type: 'Award' }]);
    const { matches, suggestions } = matchNodes(b, a);
    expect(matches).toEqual([]);
    expect(suggestions).toEqual([
      {
        before: 'r',
        after: 'a',
        score: expect.closeTo((0.55 * 0.666667 + 0.1) / 0.65, 5),
        evidence: { label: 0.666667, neighbors: 0, types: 1, attrs: 0 },
        reason: 'below-threshold',
      },
    ]);
    expect(matchNodes(b, a, { suggestThreshold: 0.9 }).suggestions).toEqual([]);
  });

  it('generates candidates from CJK character bigrams', () => {
    const b = graph([{ id: 'r', label: '工商银行', type: 'Bank' }]);
    const a = graph([{ id: 'a', label: '中国工商银行', type: 'Bank' }]);
    const [suggestion] = matchNodes(b, a).suggestions;
    expect(suggestion).toMatchObject({ before: 'r', after: 'a', reason: 'below-threshold' });
    expect(suggestion?.evidence.label).toBe(0.75);
  });

  it('collects the best maxCandidates of every node on both sides', () => {
    const nodes = (prefix: string) => [
      ...graph(
        Array.from({ length: 10 }, (_, i) => ({ id: `${prefix}${i}`, label: 'Acme' })),
      ).nodes.values(),
    ];
    const pairs = generateCandidates(nodes('r'), nodes('a'), 3, true, new ProfileCache());
    // Each r keeps a0–a2 and each a keeps r0–r2: 30 + 30 − 9 distinct pairs.
    expect(pairs).toHaveLength(51);
    expect(pairs.every((p) => p.r < 3 || p.a < 3)).toBe(true);
  });

  it('reports every equally good rival of an ambiguous pair', () => {
    const b = graph([{ id: 'r', label: 'Acme' }]);
    const a = graph(Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, label: 'Acme' })));
    const { matches, suggestions } = matchNodes(b, a, { maxCandidates: 3 });
    expect(matches).toEqual([]);
    expect(suggestions).toHaveLength(30);
    expect(suggestions.every((s) => s.reason === 'ambiguous')).toBe(true);
  });
});

describe('matchNodes: determinism', () => {
  it('gives the same result for shuffled inputs', () => {
    const before: GraphInput = {
      nodes: ['Acme Inc', 'Acme Corp', 'Beta Labs', 'Gamma Group', 'Delta'].map((label, i) => ({
        id: `b${i}`,
        label,
      })),
      edges: [{ source: 'b0', target: 'b2', predicate: 'owns' }],
    };
    const after: GraphInput = {
      nodes: ['Acme Inc.', 'ACME Corporation', 'Beta Labs', 'Gamma Grp', 'Delta'].map(
        (label, i) => ({ id: `a${i}`, label }),
      ),
      edges: [{ source: 'a0', target: 'a2', predicate: 'owns' }],
    };
    const reference = matchNodes(normalize(before), normalize(after));
    for (let seed = 1; seed < 20; seed++) {
      expect(
        matchNodes(normalize(shuffleGraph(before, seed)), normalize(shuffleGraph(after, seed + 9))),
      ).toEqual(reference);
    }
  });

  it('only reports similarity matches in the diff result', () => {
    const d = diff(
      {
        nodes: [
          { id: 'a', label: 'Alpha' },
          { id: 'k', label: 'Kept' },
        ],
        edges: [],
      },
      {
        nodes: [
          { id: 'b', label: 'Alpha' },
          { id: 'k', label: 'Kept' },
        ],
        edges: [],
      },
    );
    expect(d.matches).toEqual([
      expect.objectContaining({ before: 'a', after: 'b', method: 'similarity', score: 1 }),
    ]);
  });
});

describe('matchNodes: 1:1 replacement hints', () => {
  const before = graph([
    { id: 'old', label: 'Alpha' },
    { id: 'keep', label: 'Keep' },
  ]);

  it('matches a vanished id to the new node that replaces it', () => {
    const after = graph([
      { id: 'new', label: 'Something else', replaces: ['old'] },
      { id: 'keep', label: 'Keep' },
    ]);
    expect(matchNodes(before, after).matches).toEqual([
      { before: 'keep', after: 'keep', method: 'id', score: 1 },
      { before: 'old', after: 'new', method: 'hint', score: 1 },
    ]);
  });

  it('reads replacedBy on the vanished node as well, under every strategy', () => {
    const b = graph([{ id: 'old', label: 'Alpha', replacedBy: ['new'] }]);
    const a = graph([{ id: 'new', label: 'Omega' }]);
    for (const strategy of ['id', 'auto', 'similarity'] as const) {
      expect(matchNodes(b, a, { strategy }).matches).toEqual([
        { before: 'old', after: 'new', method: 'hint', score: 1 },
      ]);
    }
  });

  it('leaves several sources to merge detection and several targets to split detection', () => {
    const two = graph([{ id: 'o1' }, { id: 'o2' }]);
    expect(matchNodes(two, graph([{ id: 'n', replaces: ['o1', 'o2'] }])).matches).toEqual([]);
    const one = graph([{ id: 'o', replacedBy: ['n1', 'n2'] }]);
    expect(matchNodes(one, graph([{ id: 'n1' }, { id: 'n2' }])).matches).toEqual([]);
  });

  it('ignores hints between ids that exist in both versions', () => {
    const b = graph([{ id: 'x', deprecated: true, replacedBy: ['y'] }, { id: 'y' }]);
    expect(matchNodes(b, b, { strategy: 'similarity' }).matches.map((m) => m.method)).toEqual([
      'similarity',
      'similarity',
    ]);
  });

  it('reports the hint match as a rekey and lists it among the diff matches', () => {
    const d = diff(
      {
        nodes: [{ id: 'old', label: 'Alpha' }, { id: 'n' }],
        edges: [{ source: 'old', target: 'n', predicate: 'p' }],
      },
      {
        nodes: [{ id: 'new', label: 'Alpha', replaces: ['old'] }, { id: 'n' }],
        edges: [{ source: 'new', target: 'n', predicate: 'p' }],
      },
    );
    expect(d.matches).toEqual([{ before: 'old', after: 'new', method: 'hint', score: 1 }]);
    expect(d.index.node('new')?.facets).toEqual([
      { kind: 'rekey', from: 'old', to: 'new', score: 1 },
      {
        kind: 'replacement',
        replaces: { added: ['old'], removed: [] },
        replacedBy: { added: [], removed: [] },
      },
    ]);
    expect(d.edges.map((e) => e.status)).toEqual(['unchanged']);
  });
});

describe('matchNodes: many identical names', () => {
  it('keeps every node matched to itself under similarity, beyond any posting truncation', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({
      id: `n${String(i).padStart(4, '0')}`,
      label: 'Same label',
    }));
    const d = diff(
      { nodes, edges: [] },
      { nodes: [...nodes].reverse(), edges: [] },
      { match: { strategy: 'similarity' } },
    );
    expect(d.stats.identical).toBe(true);
    expect(d.delta.ops).toEqual([]);
  });
});

describe('matchNodes: same name, conflicting types', () => {
  // Mercury the planet orbits the Sun; Mercury the element has the symbol Hg. Fresh ids, so
  // under `similarity` nothing is matched when the two are first compared.
  const before = graph(
    [
      { id: 'm1', label: 'Mercury', type: 'Planet' },
      { id: 'sun', label: 'Sun', type: 'Star' },
    ],
    [{ source: 'm1', target: 'sun', predicate: 'orbits' }],
  );
  const after = graph(
    [
      { id: 'x1', label: 'Mercury', type: 'Element' },
      { id: 'sun', label: 'Sun', type: 'Star' },
      { id: 'hg', label: 'Hg', type: 'Symbol' },
    ],
    [{ source: 'x1', target: 'hg', predicate: 'symbol' }],
  );
  const planetToElement = {
    before: 'm1',
    after: 'x1',
    score: expect.closeTo(0.55 / 0.9, 5),
    evidence: { label: 1, neighbors: 0, types: 0, attrs: 0 },
    reason: 'below-threshold',
  };

  it('waits for the neighbour evidence before pairing them under `similarity`', () => {
    const { matches, suggestions } = matchNodes(before, after, { strategy: 'similarity' });
    expect(matches.map((m) => [m.before, m.after])).toEqual([['sun', 'sun']]);
    expect(suggestions).toEqual([planetToElement]);
  });

  it('agrees with `auto`, where the shared neighbour is matched by id first', () => {
    const { matches, suggestions } = matchNodes(before, after);
    expect(matches.map((m) => [m.before, m.after, m.method])).toEqual([['sun', 'sun', 'id']]);
    expect(suggestions).toEqual([planetToElement]);
  });

  it('still matches a type change that the neighbours confirm', () => {
    const renamedType = graph(
      [
        { id: 'p1', label: 'Mercury', type: 'Terrestrial planet' },
        { id: 'sun', label: 'Sun', type: 'Star' },
      ],
      [{ source: 'p1', target: 'sun', predicate: 'orbits' }],
    );
    const { matches } = matchNodes(before, renamedType, { strategy: 'similarity' });
    expect(matches.find((m) => m.before === 'm1')).toEqual({
      before: 'm1',
      after: 'p1',
      method: 'similarity',
      score: expect.closeTo(0.8 / 0.9, 5),
      evidence: { label: 1, neighbors: 1, types: 0, attrs: 0 },
    });
  });

  it('does not wait when an attribute agrees, since the label is then not the only support', () => {
    const withAttr = (g: typeof before) =>
      graph(
        [...g.nodes.values()].map((n) =>
          n.label === 'Mercury' ? { ...n, attrs: { known: 'antiquity' } } : n,
        ),
        [...g.edges.values()],
      );
    const { matches } = matchNodes(withAttr(before), withAttr(after), { strategy: 'similarity' });
    expect(matches.find((m) => m.before === 'm1')).toEqual({
      before: 'm1',
      after: 'x1',
      method: 'similarity',
      score: expect.closeTo(0.65 / 0.75, 5),
      evidence: { label: 1, neighbors: 0, types: 0, attrs: 1 },
    });
  });

  it('decides on the label once no neighbour evidence can arrive', () => {
    // Nothing else can be matched, so waiting gains nothing: the pair is scored as before.
    const lone = (id: string, type: string, other: string) =>
      graph(
        [
          { id, label: 'Mercury', type },
          { id: other, label: other === 'sol' ? 'Sol' : 'Hg' },
        ],
        [{ source: id, target: other, predicate: 'linked to' }],
      );
    for (const strategy of ['similarity', 'auto'] as const) {
      const { matches } = matchNodes(lone('m1', 'Planet', 'sol'), lone('x1', 'Element', 'hg'), {
        strategy,
      });
      expect(matches).toEqual([
        expect.objectContaining({
          before: 'm1',
          after: 'x1',
          score: expect.closeTo(0.55 / 0.65, 5),
        }),
      ]);
    }
    const isolated = matchNodes(
      graph([{ id: 'm1', label: 'Mercury', type: 'Planet' }]),
      graph([{ id: 'x1', label: 'Mercury', type: 'Element' }]),
      { strategy: 'similarity' },
    );
    expect(isolated.matches.map((m) => [m.before, m.after])).toEqual([['m1', 'x1']]);
  });
});
