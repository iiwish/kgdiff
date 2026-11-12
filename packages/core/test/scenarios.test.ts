/**
 * End-to-end scenarios that read like the specification: realistic change sets, the
 * semantic diff kgdiff should report, and the hunk titles a reviewer would see.
 */
import { applyDelta, type DiffResult, formatHunk, hashGraph, invertDelta } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { parseGraph } from '../../formats/src/sync.js';
import { diff } from '../src/sync.js';
import {
  employmentAfter,
  employmentBefore,
  enterpriseAfter,
  enterpriseBefore,
  extractionAfter,
  extractionBefore,
  oboAfter,
  oboBefore,
  partyAfter,
  partyBefore,
  taxonomyAfter,
  taxonomyBefore,
} from './support/fixtures.js';

const statusOf = (d: DiffResult) => Object.fromEntries(d.nodes.map((n) => [n.id, n.status]));
const review = (d: DiffResult, locale: 'en' | 'zh-CN' = 'en') =>
  d.hunks.map((h) => [h.kind, formatHunk(h, d, locale).title]);
const roundTrips = (d: DiffResult) => {
  expect(hashGraph(applyDelta(d.before, d.delta))).toBe(hashGraph(d.after));
  expect(hashGraph(applyDelta(d.after, invertDelta(d.delta)))).toBe(hashGraph(d.before));
};

describe('scenario 1: an enterprise knowledge graph is restructured', () => {
  describe.each(['hint', 'heuristic'] as const)('with the merge %s', (variant) => {
    const d = diff(enterpriseBefore, enterpriseAfter(variant));

    it('classifies every node', () => {
      expect(statusOf(d)).toEqual({
        BeneficialOwner: 'added',
        Enterprise: 'modified',
        ExecutivePosition: 'modified',
        LegalRep: 'removed',
        LegalRepresentative: 'modified',
        ListedCompany: 'unchanged',
        Person: 'unchanged',
        SpotCheck: 'removed',
        TopTenShareholders: 'unchanged',
      });
    });

    it('merges 法人代表 into 法定代表人', () => {
      expect(d.index.node('LegalRep')?.facets).toEqual([
        { kind: 'mergedInto', target: 'LegalRepresentative', confidence: 1, via: variant },
      ]);
      expect(d.index.node('LegalRepresentative')?.facets[0]).toEqual({
        kind: 'mergeTarget',
        sources: ['LegalRep'],
      });
      const carried = d.index.edge(JSON.stringify(['Person', 'kg:担任', 'LegalRepresentative']));
      expect(carried).toMatchObject({ status: 'modified', targetBefore: 'LegalRep' });
      const collapsed = d.index.edge(JSON.stringify(['LegalRep', 'kg:任职于', 'Enterprise']));
      expect(collapsed?.facets).toEqual([
        {
          kind: 'collapsed',
          into: JSON.stringify(['LegalRepresentative', 'kg:任职于', 'Enterprise']),
        },
      ]);
    });

    it('retargets 十大股东 –持股→ from 企业 to 上市公司', () => {
      const holds = d.index.edge(
        JSON.stringify(['TopTenShareholders', 'kg:持股', 'ListedCompany']),
      );
      expect(holds).toMatchObject({
        status: 'modified',
        target: 'ListedCompany',
        targetBefore: 'Enterprise',
      });
      expect(holds?.facets).toEqual([
        { kind: 'retarget', end: 'target', from: 'Enterprise', to: 'ListedCompany', cause: 'edit' },
      ]);
    });

    it('reports the rename and the attribute changes', () => {
      expect(d.index.node('ExecutivePosition')?.facets).toEqual([
        { kind: 'rename', from: '高管任职', to: '董监高任职' },
      ]);
      expect(d.index.node('Enterprise')?.facets).toEqual([
        {
          kind: 'attrs',
          changes: [
            { key: '实缴资本', after: 'decimal' },
            { key: '注册地址', before: 'string' },
            { key: '经营范围', after: 'string' },
          ],
        },
      ]);
    });

    it('presents six hunks in review order, in English', () => {
      expect(review(d)).toEqual([
        ['remove', 'Removed “抽查检查” and 1 relation'],
        ['merge', 'Merged “法人代表” into “法定代表人”'],
        ['relations', '“十大股东”: 持股 now points to “上市公司” (was “企业”)'],
        ['modify', 'Updated attributes of “企业”'],
        ['modify', 'Renamed “高管任职” → “董监高任职”'],
        ['add', 'Added “受益所有人” and 2 relations'],
      ]);
      expect(formatHunk(d.hunks[3] as DiffResult['hunks'][number], d).subtitle).toBe(
        '+2 −1 attributes',
      );
      expect(formatHunk(d.hunks[5] as DiffResult['hunks'][number], d).subtitle).toBe(
        'type Role · linked to “企业” and “自然人”',
      );
    });

    it('presents the same hunks in Chinese', () => {
      expect(review(d, 'zh-CN')).toEqual([
        ['remove', '删除「抽查检查」及 1 条关系'],
        ['merge', '「法人代表」合并入「法定代表人」'],
        ['relations', '「十大股东」的「持股」改为指向「上市公司」（原为「企业」）'],
        ['modify', '修改「企业」的属性'],
        ['modify', '「高管任职」改名为「董监高任职」'],
        ['add', '新增「受益所有人」及 2 条关系'],
      ]);
      expect(formatHunk(d.hunks[1] as DiffResult['hunks'][number], d, 'zh-CN').subtitle).toBe(
        variant === 'hint'
          ? '依据替代声明 · 迁移 1 条关系 · 合并 1 条重复关系'
          : '推断 · 置信度 100% · 迁移 1 条关系 · 合并 1 条重复关系 · 别名 +1',
      );
    });

    it('produces a delta that round-trips', () => roundTrips(d));
  });
});

describe('scenario 2: an OBO term is obsoleted with replaced_by', () => {
  const d = diff(oboBefore, oboAfter);

  it('merges the obsolete term into its replacement and keeps it as deprecated', () => {
    const obsolete = d.index.node('GO:0006917');
    expect(obsolete?.status).toBe('modified');
    // Losing its parent is part of the obsoletion, not a move.
    expect(obsolete?.facets.map((f) => f.kind)).toEqual([
      'rename',
      'mergedInto',
      'deprecate',
      'replacement',
    ]);
    expect(obsolete?.facets[1]).toEqual({
      kind: 'mergedInto',
      target: 'GO:0006915',
      confidence: 1,
      via: 'hint',
    });
    expect(d.index.node('GO:0006915')?.facets).toEqual([
      { kind: 'mergeTarget', sources: ['GO:0006917'] },
    ]);
  });

  it('collapses the obsolete is_a into the replacement’s identical edge', () => {
    expect(d.edges.filter((e) => e.status !== 'unchanged')).toEqual([
      expect.objectContaining({
        facets: [{ kind: 'collapsed', into: JSON.stringify(['GO:0006915', 'is_a', 'GO:0012501']) }],
      }),
    ]);
  });

  it('is one merge hunk named after the term as it was known', () => {
    expect(review(d)).toEqual([
      ['merge', 'Merged “induction of apoptosis” into “apoptotic process”'],
    ]);
    expect(formatHunk(d.hunks[0] as DiffResult['hunks'][number], d).subtitle).toBe(
      'via replacement hint · 1 duplicate collapsed · kept as deprecated',
    );
  });

  it('produces a delta that round-trips', () => roundTrips(d));
});

describe('scenario 3: a class moves in the hierarchy', () => {
  const d = diff(taxonomyBefore, taxonomyAfter);

  it('reports a move and the retargeted subClassOf edge', () => {
    expect(d.index.node('Whale')?.facets).toEqual([
      { kind: 'move', predicate: 'rdfs:subClassOf', from: ['Fish'], to: ['Mammal'] },
    ]);
    expect(d.edges.filter((e) => e.status !== 'unchanged')).toEqual([
      expect.objectContaining({
        hierarchical: true,
        facets: [expect.objectContaining({ kind: 'retarget', cause: 'move' })],
      }),
    ]);
  });

  it('is a restructuring hunk with both parents as context', () => {
    expect(d.hunks).toEqual([
      expect.objectContaining({
        kind: 'modify',
        phase: 'restructure',
        context: ['Fish', 'Mammal'],
      }),
    ]);
    expect(formatHunk(d.hunks[0] as DiffResult['hunks'][number], d)).toEqual({
      title: 'Moved “Whale” under “Mammal”',
      subtitle: 'from “Fish”',
    });
    expect(formatHunk(d.hunks[0] as DiffResult['hunks'][number], d, 'zh-CN')).toEqual({
      title: '「Whale」移至「Mammal」下',
      subtitle: '原属「Fish」',
    });
  });

  it('produces a delta that round-trips', () => roundTrips(d));
});

describe('scenario 4: an LLM re-extracts a graph with fresh random ids', () => {
  const d = diff(extractionBefore, extractionAfter, { match: { strategy: 'similarity' } });

  it('matches entities by name, type and neighbourhood', () => {
    expect(d.matches.map((m) => [m.before, m.after])).toEqual([
      ['e_91f2', 'n1'],
      ['e_03aa', 'n2'],
      ['e_7c1d', 'n3'],
      ['e_55b0', 'n4'],
    ]);
    const marie = d.matches[0];
    expect(marie?.evidence?.label).toBe(0.8);
    expect(marie?.score).toBeGreaterThanOrEqual(0.82);
    expect(d.matches[2]?.evidence?.label).toBeCloseTo(0.966667, 6);
  });

  it('reports renames of matched entities, but not their meaningless id changes', () => {
    expect(d.index.node('n1')).toMatchObject({
      beforeId: 'e_91f2',
      afterId: 'n1',
      facets: [{ kind: 'rename', from: 'Marie Curie', to: 'Marie Skłodowska-Curie' }],
    });
    expect(d.index.node('n3')?.facets.map((f) => f.kind)).toEqual(['rename']);
    expect(d.index.node('n2')).toMatchObject({
      beforeId: 'e_03aa',
      status: 'unchanged',
      facets: [],
    });
    expect(d.stats.facets.rekey).toBe(0);
  });

  it('reviews only what changed, in an order that respects dependencies', () => {
    expect(review(d)).toEqual([
      ['modify', 'Renamed “Univ. of Paris” → “University of Paris”'],
      ['add', 'Added “Nobel Prize”'],
      ['modify', 'Renamed “Marie Curie” → “Marie Skłodowska-Curie”'],
      ['remove', 'Removed “Nobel Prize in Physics”'],
      ['add', 'Added “Polonium” and 1 relation'],
    ]);
    // Marie's “won” edge now points to the new prize node (a retarget reviewed with Marie): her
    // hunk needs the new prize, and the old prize can only go once nothing points to it.
    expect(d.hunks.map((h) => [h.id, h.requires])).toEqual([
      ['modify:n3', []],
      ['add:n6', []],
      ['modify:n1', ['add:n6']],
      ['remove:e_e812', ['modify:n1']],
      ['add:n5', ['modify:n1']],
    ]);
    expect(formatHunk(d.hunks[2] as DiffResult['hunks'][number], d).subtitle).toBe('~1 relation');
  });

  it('suggests “Nobel Prize in Physics” ≈ “Nobel Prize” without applying it', () => {
    expect(d.suggestions).toEqual([
      {
        before: 'e_e812',
        after: 'n6',
        score: expect.closeTo(0.7963, 3),
        evidence: { label: 0.666667, neighbors: 1, types: 1, attrs: 0 },
        reason: 'below-threshold',
      },
    ]);
    expect(statusOf(d)).toMatchObject({ e_e812: 'removed', n6: 'added', n5: 'added' });
  });

  it('produces a delta that round-trips', () => roundTrips(d));
});

describe('scenario 5: a relation changes its predicate', () => {
  const d = diff(employmentBefore, employmentAfter);

  it('pairs the edges and reports the predicate change', () => {
    expect(d.edges).toEqual([
      expect.objectContaining({
        status: 'modified',
        predicate: 'schema:employedBy',
        predicateBefore: 'schema:worksFor',
        facets: [{ kind: 'predicate', from: 'schema:worksFor', to: 'schema:employedBy' }],
      }),
    ]);
  });

  it('reads as one relation change', () => {
    expect(review(d)).toEqual([['relations', '“Alice” → “ACME Corp”: worksFor is now employedBy']]);
    expect(review(d, 'zh-CN')).toEqual([
      ['relations', '「Alice」→「ACME Corp」的关系由「worksFor」改为「employedBy」'],
    ]);
  });

  it('produces a delta that round-trips', () => roundTrips(d));
});

describe('scenario 6: a class is split via replaces hints', () => {
  const d = diff(partyBefore, partyAfter);

  it('splits Party into two new classes that carry its edges', () => {
    expect(d.index.node('Party')).toMatchObject({
      status: 'removed',
      facets: [{ kind: 'splitInto', targets: ['LegalEntity', 'NaturalPerson'] }],
    });
    for (const id of ['LegalEntity', 'NaturalPerson']) {
      expect(d.index.node(id)).toMatchObject({
        status: 'added',
        facets: [{ kind: 'splitFrom', source: 'Party', confidence: 1, via: 'hint' }],
      });
    }
    const carried = d.edges.filter((e) =>
      e.facets.some((f) => f.kind === 'retarget' && f.cause === 'split'),
    );
    expect(carried.map((e) => e.id)).toEqual([
      JSON.stringify(['LegalEntity', 'hasAddress', 'Address']),
      JSON.stringify(['LegalEntity', 'signs', 'Contract']),
    ]);
  });

  it('is one split hunk', () => {
    expect(review(d)).toEqual([
      ['split', 'Split “Party” into “Legal entity” and “Natural person”'],
    ]);
    expect(review(d, 'zh-CN')).toEqual([
      ['split', '「Party」拆分为「Legal entity」和「Natural person」'],
    ]);
    expect(formatHunk(d.hunks[0] as DiffResult['hunks'][number], d).subtitle).toBe(
      'via replacement hint · 2 relations carried over · +1 relation',
    );
  });

  it('produces a delta that round-trips', () => roundTrips(d));
});

describe('scenario 7: an OBO term changes its id and keeps the old one as alt_id', () => {
  const obo = (stanzas: string) =>
    parseGraph(`format-version: 1.2\nontology: demo\n\n${stanzas}`, { format: 'obo' }).graph;
  const before = obo(
    '[Term]\nid: DEMO:0000001\nname: disease\n\n[Term]\nid: DEMO:0000002\nname: steatosis\nis_a: DEMO:0000001 ! disease\n',
  );
  const after = obo(
    '[Term]\nid: DEMO:0000001\nname: disease\n\n[Term]\nid: DEMO:0000009\nname: steatotic liver disease\nalt_id: DEMO:0000002\nis_a: DEMO:0000001 ! disease\n',
  );
  const d = diff(before, after);

  it('matches the term to its new id instead of removing and adding it', () => {
    expect(d.matches).toEqual([
      { before: 'DEMO:0000002', after: 'DEMO:0000009', method: 'hint', score: 1 },
    ]);
    // The OBO parser also keeps alt_id as an attribute.
    expect(d.index.node('DEMO:0000009')?.facets.map((f) => f.kind)).toEqual([
      'rekey',
      'rename',
      'replacement',
      'attrs',
    ]);
    expect(d.edges.map((e) => e.status)).toEqual(['unchanged']);
  });

  it('reads as one rename', () => {
    expect(review(d)).toEqual([['modify', 'Renamed “steatosis” → “steatotic liver disease”']]);
    expect(formatHunk(d.hunks[0] as DiffResult['hunks'][number], d).subtitle).toBe(
      'DEMO:0000002 → DEMO:0000009 · +1 attribute · replaces “steatosis”',
    );
  });

  it('produces a delta that round-trips', () => roundTrips(d));
});
