import { type DiffJSON, diff, diffFromJSON, diffToJSON, formatHunk, hashGraph } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { enterpriseAfter, enterpriseBefore } from './support/fixtures.js';

describe('diffToJSON', () => {
  const d = diff(enterpriseBefore, enterpriseAfter('hint'));
  const json = diffToJSON(d);

  it('is a versioned, self-describing document', () => {
    expect(json).toMatchObject({
      format: 'kgdiff.diff',
      version: 1,
      meta: {
        before: { name: 'enterprise-kg', version: '2026.09' },
        after: { name: 'enterprise-kg', version: '2026.10' },
      },
      options: d.options,
      hunks: d.hunks,
      delta: d.delta,
      stats: d.stats,
    });
    expect(json).not.toHaveProperty('index');
  });

  it('stores unchanged elements once and omits empty facets', () => {
    const person = json.nodes.find((n) => n.id === 'Person');
    expect(person).toEqual({
      id: 'Person',
      beforeId: 'Person',
      afterId: 'Person',
      after: { id: 'Person', label: '自然人', types: ['Class'] },
      status: 'unchanged',
    });
    const renamed = json.nodes.find((n) => n.id === 'ExecutivePosition');
    expect(renamed?.before).toEqual({
      id: 'ExecutivePosition',
      label: '高管任职',
      types: ['Relation'],
    });
    expect(renamed?.after?.label).toBe('董监高任职');
    const subclass = json.edges.find((e) => e.status === 'unchanged');
    expect(subclass?.before).toBeUndefined();
  });

  it('serializes to the same bytes every time', () => {
    const again = diffToJSON(diff(enterpriseBefore, enterpriseAfter('hint')));
    expect(JSON.stringify(again)).toBe(JSON.stringify(json));
  });
});

describe('diffFromJSON', () => {
  const d = diff(enterpriseBefore, enterpriseAfter('heuristic'));
  const text = JSON.stringify(diffToJSON(d));
  const back = diffFromJSON(JSON.parse(text) as DiffJSON);

  it('rebuilds both graphs, the union and the index', () => {
    expect(hashGraph(back.before)).toBe(hashGraph(d.before));
    expect(hashGraph(back.after)).toBe(hashGraph(d.after));
    expect(back.nodes).toEqual(d.nodes);
    expect(back.edges).toEqual(d.edges);
    expect(back.index.nodeByBefore('LegalRep')?.facets[0]?.kind).toBe('mergedInto');
    expect(back.index.edgesOf('Person').map((e) => e.id)).toEqual(
      d.index.edgesOf('Person').map((e) => e.id),
    );
  });

  it('round-trips byte for byte', () => {
    expect(JSON.stringify(diffToJSON(back))).toBe(text);
  });

  it('produces the same hunk titles', () => {
    for (const h of d.hunks)
      expect(formatHunk(h, back, 'zh-CN')).toEqual(formatHunk(h, d, 'zh-CN'));
  });

  it('rejects other formats and newer versions', () => {
    const json = JSON.parse(text) as DiffJSON;
    expect(() =>
      diffFromJSON({ ...json, format: 'kgdiff.delta' } as unknown as DiffJSON),
    ).toThrowError(expect.objectContaining({ code: 'unsupported-version' }));
    expect(() => diffFromJSON({ ...json, version: 2 } as unknown as DiffJSON)).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    );
    expect(() => diffFromJSON({ ...json, nodes: undefined } as unknown as DiffJSON)).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});

describe('diffFromJSON: validation', () => {
  const json = (): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(
        diffToJSON(diff({ nodes: [{ id: 'a' }], edges: [] }, { nodes: [{ id: 'b' }], edges: [] })),
      ),
    );

  it.each<[string, (j: Record<string, unknown>) => void]>([
    ['no meta', (j) => delete j.meta],
    ['no options', (j) => delete j.options],
    ['no delta', (j) => delete j.delta],
    [
      'an unknown node status',
      (j) =>
        (((j.nodes as Record<string, unknown>[])[0] as Record<string, unknown>).status = 'bogus'),
    ],
    ['an edge without endpoints', (j) => (j.edges = [{ id: 'e', status: 'added' }])],
  ])('rejects a document with %s as invalid-input', (_name, damage) => {
    const j = json();
    damage(j);
    expect(() => diffFromJSON(j as unknown as DiffJSON)).toThrowError(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});

describe('diffFromJSON: consistency', () => {
  // biome-ignore lint/suspicious/noExplicitAny: documents are damaged field by field
  type Doc = Record<string, any>;
  const text = JSON.stringify(diffToJSON(diff(enterpriseBefore, enterpriseAfter('heuristic'))));
  const find = (list: Doc[], test: (x: Doc) => boolean): Doc => {
    const found = list.find(test);
    if (!found) throw new Error('the fixture has no such element');
    return found;
  };
  const withNodes = (h: Doc): boolean => h.nodes.length > 0 && h.ops.length > 0;

  it.each<[string, (j: Doc) => void, RegExp]>([
    [
      'an added node with a before id',
      (j) => {
        find(j.nodes, (n) => n.status === 'added').beforeId = 'x';
      },
      /is added, so it must have only an after version/,
    ],
    [
      'a removed edge with an after snapshot',
      (j) => {
        const e = find(j.edges, (x) => x.status === 'removed');
        e.after = e.before;
      },
      /is removed, so it has no after snapshot/,
    ],
    [
      'an unchanged node with facets',
      (j) => {
        find(j.nodes, (n) => n.status === 'unchanged').facets = [
          { kind: 'rename', from: 'a', to: 'b' },
        ];
      },
      /is unchanged but has facets/,
    ],
    [
      'a modified node without facets',
      (j) => {
        delete find(j.nodes, (n) => n.status === 'modified').facets;
      },
      /is modified but has no facets/,
    ],
    ['a repeated node id', (j) => j.nodes.push(j.nodes[0]), /is used more than once/],
    [
      'an edge to an unknown node',
      (j) => {
        find(j.edges, (e) => e.status === 'added').source = 'nowhere';
      },
      /points to "nowhere", which is not a union node/,
    ],
    [
      'an unchanged edge with a changed source',
      (j) => {
        const e = find(j.edges, (x) => x.status === 'unchanged');
        e.sourceBefore = find(j.nodes, (n) => n.id !== e.source).id;
      },
      /sourceBefore needs another source and a source retarget facet/,
    ],
    [
      'an element of an unknown hunk',
      (j) => {
        find(j.nodes, (n) => n.status === 'modified').hunk = 'modify:nowhere';
      },
      /belongs to the hunk "modify:nowhere", which the diff does not have/,
    ],
    [
      'a node moved to another hunk',
      (j) => {
        const [a, b] = j.hunks.filter(withNodes);
        find(j.nodes, (n) => n.id === a.nodes[0]).hunk = b.id;
      },
      /lists the node "[^"]+", which is not one of its own/,
    ],
    [
      'ops shared by two hunks',
      (j) => {
        j.hunks[1].ops = [...j.hunks[0].ops];
      },
      /belongs to more than one hunk/,
    ],
    [
      'an op outside the delta',
      (j) => {
        j.hunks[0].ops = [j.delta.ops.length];
      },
      /ops must be ascending indices into delta.ops/,
    ],
    [
      'hunks out of review order',
      (j) => {
        [j.hunks[0], j.hunks[1]] = [j.hunks[1], j.hunks[0]];
      },
      /has order 1 but is listed at 0/,
    ],
    [
      'a wrong hunk summary',
      (j) => {
        find(j.hunks, withNodes).summary.nodes.modified += 1;
      },
      /its summary does not match its nodes and edges/,
    ],
    [
      'the delta of another graph',
      (j) => {
        j.delta.base.hash = 'c53:00000000000000';
      },
      /delta.base is another graph/,
    ],
    [
      'wrong stats',
      (j) => {
        j.stats.nodes.added += 1;
      },
      /diff.stats do not match/,
    ],
  ])('rejects %s', (_name, damage, message) => {
    const j = JSON.parse(text) as Doc;
    damage(j);
    expect(() => diffFromJSON(j as DiffJSON)).toThrowError(
      expect.objectContaining({ code: 'invalid-input', message: expect.stringMatching(message) }),
    );
  });

  it('accepts the undamaged document', () => {
    expect(() => diffFromJSON(JSON.parse(text) as DiffJSON)).not.toThrow();
  });
});
