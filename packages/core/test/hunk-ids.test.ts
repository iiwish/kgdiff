/**
 * Hunk ids (docs/algorithms.md §7, "Hunk ids"): the rule, what leaves an id alone and what
 * moves it. Hosts store review progress under these ids, so the rule is a contract; the cases
 * are those of `crates/kgdiff-core/tests/hunk_ids.rs`.
 */
import type { DiffOptions, DiffResult, EdgeInput, GraphInput, NodeInput } from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diff } from '../src/sync.js';
import { shuffleGraph, versionPairArb } from './support/arbitraries.js';

/** Override with KGDIFF_PROPERTY_RUNS for a deeper soak run. */
const RUNS = Number(process.env.KGDIFF_PROPERTY_RUNS ?? 300);

const BY_ID: DiffOptions = { match: { strategy: 'id' } };
const BY_SIMILARITY: DiffOptions = { match: { strategy: 'similarity' } };

/** The variants of `properties.test.ts`. */
const VARIANTS: readonly [string, DiffOptions][] = [
  ['default options', {}],
  ['similarity matching', BY_SIMILARITY],
  ['id edge identity', { edgeIdentity: 'id' }],
  [
    'id matching without restructuring',
    { match: { strategy: 'id' }, detectMerges: false, detectSplits: false },
  ],
];

/** Matching by id: no edit changes how another node is matched. */
const ID_VARIANTS: readonly [string, DiffOptions][] = [
  ['id matching', BY_ID],
  ['id matching without restructuring', VARIANTS[3]?.[1] as DiffOptions],
];

/** Where equal ids are one node: `auto` and `id`. */
const SAME_ID_VARIANTS: readonly [string, DiffOptions][] = [
  ...VARIANTS.filter(([, options]) => options.match?.strategy !== 'similarity'),
  ['id matching', BY_ID],
];

function graph(text: string): GraphInput {
  return JSON.parse(text) as GraphInput;
}

/** The hunk ids of a diff, sorted: a set, without the review order. */
function ids(before: GraphInput, after: GraphInput, options: DiffOptions = {}): string[] {
  return diff(before, after, options)
    .hunks.map((h) => h.id)
    .sort();
}

function idsOf(before: string, after: string, options: DiffOptions = {}): string[] {
  return ids(graph(before), graph(after), options);
}

/** What `to` has and `from` has not (`+id`), and the reverse (`-id`). */
function changes(from: readonly string[], to: readonly string[]): string[] {
  return [
    ...from.filter((id) => !to.includes(id)).map((id) => `-${id}`),
    ...to.filter((id) => !from.includes(id)).map((id) => `+${id}`),
  ];
}

/** The ids of `from` that `to` has not, and the ids of `to` that `from` has not. */
function moved(from: DiffResult, to: DiffResult): { gone: string[]; fresh: string[] } {
  const before = from.hunks.map((h) => h.id);
  const after = to.hunks.map((h) => h.id);
  return {
    gone: before.filter((id) => !after.includes(id)),
    fresh: after.filter((id) => !before.includes(id)),
  };
}

/** The ids of the nodes that both versions have. */
function inBoth(a: GraphInput, b: GraphInput): string[] {
  return b.nodes.filter((node) => a.nodes.some((m) => m.id === node.id)).map((node) => node.id);
}

// One hunk of each kind: `m-curie` merges into `curie`, `physics` splits off `nuclear`, `lab`
// and `bench` are new, `old` and `older` are gone, `sorbonne` is renamed and `paris` gets an
// edge.
const KINDS_BEFORE = `{"nodes":[
  {"id":"paris","label":"Paris"},{"id":"curie","label":"Marie Curie"},
  {"id":"m-curie","label":"M. Curie"},{"id":"sorbonne","label":"Sorbonne"},
  {"id":"radium","label":"Radium"},{"id":"physics","label":"Physics"},
  {"id":"old","label":"Old"},{"id":"older","label":"Older"}],
"edges":[
  {"source":"curie","target":"paris","predicate":"livesIn"},
  {"source":"old","target":"older","predicate":"p"},
  {"source":"old","target":"paris","predicate":"p"},
  {"source":"physics","target":"radium","predicate":"studies"},
  {"source":"physics","target":"paris","predicate":"taughtIn"}]}`;
const KINDS_AFTER = `{"nodes":[
  {"id":"paris","label":"Paris"},{"id":"curie","label":"Marie Curie","replaces":["m-curie"]},
  {"id":"sorbonne","label":"Sorbonne University"},{"id":"radium","label":"Radium"},
  {"id":"physics","label":"Physics"},
  {"id":"nuclear","label":"Nuclear physics","replaces":["physics"]},
  {"id":"lab","label":"Lab"},{"id":"bench","label":"Bench"}],
"edges":[
  {"source":"curie","target":"paris","predicate":"livesIn"},
  {"source":"lab","target":"bench","predicate":"has"},
  {"source":"lab","target":"paris","predicate":"in"},
  {"source":"nuclear","target":"radium","predicate":"studies"},
  {"source":"physics","target":"paris","predicate":"taughtIn"},
  {"source":"paris","target":"radium","predicate":"exhibits"}]}`;

// A base and a head under review: `a` is renamed, `old` is gone, `n1` and `n2` are new and
// `c` gets an edge.
const BASE = `{"nodes":[
  {"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"},
  {"id":"d","label":"D"},{"id":"old","label":"Old"}],
"edges":[
  {"source":"a","target":"b","predicate":"p"},{"source":"old","target":"a","predicate":"p"}]}`;
const HEAD = `{"nodes":[
  {"id":"a","label":"A2"},{"id":"b","label":"B"},{"id":"c","label":"C"},
  {"id":"d","label":"D"},{"id":"n1"},{"id":"n2"}],
"edges":[
  {"source":"a","target":"b","predicate":"p"},{"source":"c","target":"d","predicate":"p"},
  {"source":"n1","target":"n2","predicate":"p"},{"source":"n1","target":"a","predicate":"p"}]}`;
const HEAD_IDS = ['add:n1', 'modify:a', 'relations:c', 'remove:old'];

/** `HEAD` with more nodes and edges, and `patch` merged into the nodes it names. */
function head(
  nodes: readonly NodeInput[],
  edges: readonly EdgeInput[],
  patch: Record<string, Partial<NodeInput>> = {},
): GraphInput {
  const g = graph(HEAD);
  return {
    nodes: [...g.nodes.map((n) => ({ ...n, ...patch[n.id] })), ...nodes],
    edges: [...g.edges, ...edges],
  };
}

function edge(source: string, target: string, predicate = 'p'): EdgeInput {
  return { source, target, predicate };
}

// A person whose id changes, with and without a hint.
const CURIE = `{"nodes":[
  {"id":"a","label":"Marie Curie","type":["Person"]},{"id":"b","label":"Paris"}],
"edges":[{"source":"a","target":"b","predicate":"livesIn"}]}`;
function curie(id: string, more = ''): string {
  return `{"nodes":[
    {"id":"${id}","label":"Marie Curie","type":["Person"]${more}},{"id":"b","label":"Paris"}],
  "edges":[{"source":"${id}","target":"b","predicate":"livesIn"}]}`;
}

describe('hunk ids: the rule', () => {
  it('names a hunk by its kind and its anchor', () => {
    const d = diff(graph(KINDS_BEFORE), graph(KINDS_AFTER));
    expect(d.hunks.map((h) => [h.id, h.kind, h.anchor]).sort()).toEqual([
      ['add:lab', 'add', 'lab'],
      ['merge:curie', 'merge', 'curie'],
      ['modify:sorbonne', 'modify', 'sorbonne'],
      ['relations:paris', 'relations', 'paris'],
      ['remove:old', 'remove', 'old'],
      ['split:physics', 'split', 'physics'],
    ]);
  });

  it('anchors a group of new or removed nodes at its best-connected node, then the smallest id', () => {
    const hub = '{"nodes":[{"id":"hub"}],"edges":[]}';
    const group = (first: EdgeInput): GraphInput => ({
      nodes: [{ id: 'hub' }, { id: 'k' }, { id: 'm' }, { id: 'z' }],
      edges: [edge('m', 'k'), first],
    });
    // k and m have one edge each: the smaller id. Then z, with two.
    expect(ids(graph(hub), group(edge('z', 'hub')))).toEqual(['add:k', 'add:z']);
    expect(ids(graph(hub), group(edge('z', 'm')))).toEqual(['add:m']);
    expect(ids(group(edge('z', 'hub')), graph(hub))).toEqual(['remove:k', 'remove:z']);
    expect(ids(group(edge('z', 'm')), graph(hub))).toEqual(['remove:m']);
  });

  it('names a node by its id in the after version, and a removed node by its old id', () => {
    expect(idsOf(CURIE, curie('a9'))).toEqual(['modify:a9']);
    expect(idsOf(CURIE, curie('a9', ',"replaces":["a"]'), BY_ID)).toEqual(['modify:a9']);
    expect(idsOf(curie('a9'), '{"nodes":[{"id":"b","label":"Paris"}],"edges":[]}')).toEqual([
      'remove:a9',
    ]);
  });

  it('adds @before to a removed node whose id another node took', () => {
    const before = '{"nodes":[{"id":"x","label":"Alpha","type":["Person"]},{"id":"k"}],"edges":[]}';
    const gone = '{"nodes":[{"id":"k"}],"edges":[]}';
    const taken = '{"nodes":[{"id":"k"},{"id":"x","label":"完全不同","type":["Org"]}],"edges":[]}';
    expect(idsOf(before, gone, BY_SIMILARITY)).toEqual(['remove:x']);
    expect(idsOf(before, taken, BY_SIMILARITY)).toEqual(['add:x', 'remove:x@before']);
    // Where ids decide, the same id is the same node.
    expect(idsOf(before, taken)).toEqual(['modify:x']);
  });

  describe.each(VARIANTS)('on random version pairs (%s)', (_name, options) => {
    it('is the kind and the anchor, and unique in a diff', () => {
      fc.assert(
        fc.property(versionPairArb(), ([a, b]) => {
          const { hunks } = diff(a, b, options);
          for (const h of hunks) expect(h.id).toBe(`${h.kind}:${h.anchor}`);
          expect(new Set(hunks.map((h) => h.id)).size).toBe(hunks.length);
        }),
        { numRuns: RUNS },
      );
    });
  });
});

describe('hunk ids: what leaves them alone', () => {
  it('the order of nodes and edges in the input', () => {
    const reversed = (text: string): GraphInput => {
      const g = graph(text);
      return { nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
    };
    expect(idsOf(BASE, HEAD)).toEqual(HEAD_IDS);
    expect(ids(reversed(BASE), reversed(HEAD))).toEqual(HEAD_IDS);
  });

  it('more changes in the same hunk', () => {
    // `a` also gets an attribute and an edge, the new group a third node, `c` a second edge.
    const grown = head([{ id: 'n3' }], [edge('a', 'd', 'q'), edge('c', 'b'), edge('n3', 'n1')], {
      a: { attrs: { k: 1 } },
    });
    expect(ids(graph(BASE), grown)).toEqual(HEAD_IDS);
  });

  it('changes elsewhere', () => {
    const more = head([{ id: 'zz' }], [edge('b', 'd', 'q')], { d: { attrs: { k: 1 } } });
    expect(ids(graph(BASE), more)).toEqual(
      [...HEAD_IDS, 'add:zz', 'modify:d', 'relations:b'].sort(),
    );
  });

  it('a base that takes some of the changes', () => {
    const base = graph(BASE);
    const caughtUp: GraphInput = {
      nodes: base.nodes
        .filter((n) => n.id !== 'old')
        .map((n) => (n.id === 'a' ? { ...n, label: 'A2' } : n)),
      edges: base.edges.filter((e) => e.source !== 'old'),
    };
    expect(ids(caughtUp, graph(HEAD))).toEqual(['add:n1', 'relations:c']);
  });

  describe.each(VARIANTS)('on random version pairs (%s)', (_name, options) => {
    it('the order of nodes and edges in the input', () => {
      fc.assert(
        fc.property(versionPairArb(), fc.integer({ min: 1, max: 1e6 }), ([a, b], seed) => {
          expect(ids(shuffleGraph(a, seed), shuffleGraph(b, seed + 1), options)).toEqual(
            ids(a, b, options),
          );
        }),
        { numRuns: RUNS },
      );
    });

    it('a new node that is connected to nothing and resembles nothing', () => {
      fc.assert(
        fc.property(versionPairArb(), ([a, b]) => {
          const more = {
            nodes: [...b.nodes, { id: 'fresh-node', label: 'Q7 zzyzx' }],
            edges: b.edges,
          };
          expect(changes(ids(a, b, options), ids(a, more, options))).toEqual(['+add:fresh-node']);
        }),
        { numRuns: RUNS },
      );
    });
  });

  // Not "at most modify:x appears": the hunk of `x` may be one that a dependency cycle merged,
  // and such a hunk has the id of its best-ranked member, which this change can make another.
  describe.each(SAME_ID_VARIANTS)('on random version pairs (%s)', (_name, options) => {
    it('a changed attribute of a node of both versions: every hunk without that node or its edges', () => {
      fc.assert(
        fc.property(versionPairArb(), fc.nat(), ([a, b], n) => {
          const both = inBoth(a, b);
          fc.pre(both.length > 0);
          const x = both[n % both.length] as string;
          const more = {
            nodes: b.nodes.map((node) =>
              node.id === x ? { ...node, attrs: { ...node.attrs, 'fresh-key': 1 } } : node,
            ),
            edges: b.edges,
          };
          const d1 = diff(a, b, options);
          const d2 = diff(a, more, options);
          // The hunks that held `x` or an edge change of `x`, and the hunk that holds `x` now.
          const held = [
            d1.index.node(x)?.hunk,
            ...d1.edges.filter((e) => e.source === x).map((e) => e.hunk),
          ];
          const holds = d2.index.node(x)?.hunk;
          expect(holds).toBeDefined();
          const { gone, fresh } = moved(d1, d2);
          expect(gone.filter((id) => !held.includes(id))).toEqual([]);
          expect(fresh.filter((id) => id !== holds)).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe.each(ID_VARIANTS)('on random version pairs (%s)', (_name, options) => {
    // An edge with a predicate of its own, between two nodes that no edge went from and to
    // before, is no predicate change and no retarget of another edge (docs/algorithms.md §5).
    it('a new edge that pairs with no other edge change: every hunk but the one that takes it', () => {
      fc.assert(
        fc.property(versionPairArb(), fc.nat(), fc.nat(), ([a, b], s, t) => {
          const both = inBoth(a, b);
          fc.pre(both.length > 0);
          const source = both[s % both.length] as string;
          const target = both[t % both.length] as string;
          fc.pre(!a.edges.some((e) => e.source === source && e.target === target));
          const more = {
            nodes: b.nodes,
            edges: [...b.edges, edge(source, target, 'fresh-predicate')],
          };
          const d1 = diff(a, b, options);
          const d2 = diff(a, more, options);
          // The hunk that takes the edge, and the hunks that held what it holds.
          const takes = d2.edges.find((e) => e.predicate === 'fresh-predicate')?.hunk;
          const hunk = d2.hunks.find((h) => h.id === takes);
          expect(hunk).toBeDefined();
          const held = [
            ...(hunk?.nodes ?? []).map((id) => d1.index.node(id)?.hunk),
            ...(hunk?.edges ?? []).map((id) => d1.index.edge(id)?.hunk),
          ];
          const { gone, fresh } = moved(d1, d2);
          expect(gone.filter((id) => !held.includes(id))).toEqual([]);
          expect(fresh.filter((id) => id !== takes)).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    });
  });
});

// Not guarantees: what the documentation says an id does not survive. A change to one of these
// is a change to docs/algorithms.md.
describe('hunk ids: what moves them', () => {
  it('a node with edge changes only, once it changes itself: relations becomes modify', () => {
    expect(ids(graph(BASE), head([], [], { c: { label: 'C2' } }))).toEqual(
      changed(HEAD_IDS, 'relations:c', 'modify:c'),
    );
  });

  it('a group of new nodes whose best-connected node changes, or that joins another group', () => {
    const n2Leads = head([], [edge('n2', 'b'), edge('n2', 'c'), edge('n2', 'd')]);
    expect(ids(graph(BASE), n2Leads)).toEqual(changed(HEAD_IDS, 'add:n1', 'add:n2'));

    const second = [edge('m1', 'm2'), edge('m1', 'b'), edge('m1', 'c'), edge('m1', 'd')];
    const apart = head([{ id: 'm1' }, { id: 'm2' }], second);
    expect(ids(graph(BASE), apart)).toEqual([...HEAD_IDS, 'add:m1'].sort());
    const joined = head([{ id: 'm1' }, { id: 'm2' }], [...second, edge('m2', 'n2')]);
    expect(ids(graph(BASE), joined)).toEqual(changed(HEAD_IDS, 'add:n1', 'add:m1'));
  });

  it('a node whose id changes again', () => {
    expect(idsOf(CURIE, curie('a9'))).toEqual(['modify:a9']);
    expect(idsOf(CURIE, curie('a10'))).toEqual(['modify:a10']);
  });

  it('a pair of nodes that is matched differently after another edit', () => {
    // Renamed and then rewritten: no longer the same node, so a removal and an addition.
    const rewritten = `{"nodes":[
      {"id":"a9","label":"Radium Institute","type":["Org"]},{"id":"b","label":"Paris"}],
    "edges":[]}`;
    expect(idsOf(CURIE, curie('a9'))).toEqual(['modify:a9']);
    expect(idsOf(CURIE, rewritten)).toEqual(['add:a9', 'remove:a']);
  });

  it('an edge change that pairs with another one: the changes are grouped again', () => {
    // `s` points at `v` instead of `t`, and `u` no longer points at `v`.
    const nodes = ['s', 't', 'u', 'v'].map((id) => ({ id }));
    const before = { nodes, edges: [edge('s', 't'), edge('u', 'v')] };
    const after = { nodes, edges: [edge('s', 'v')] };
    // A new edge from `s` to `t` is now the old one with another predicate. So the edge to `v`
    // is no longer that old edge with another target: it is the edge of `u` with another
    // source, and nothing is left under `u`. Found by CI with fast-check, seed -1797998617.
    const more = { nodes, edges: [edge('s', 'v'), edge('s', 't', 'q')] };
    for (const [, options] of VARIANTS) {
      expect(ids(before, after, options)).toEqual(['relations:s', 'relations:u']);
      expect(ids(before, more, options)).toEqual(['relations:s']);
    }
  });

  it('hunks merged for a cycle: another change makes another member the best-ranked one', () => {
    // Two copies of one statement: one gets another label, the other goes from `n` to `q`. The
    // hunks of `n` and of `q` change the same triple, so they require each other and are one.
    const nodes = [{ id: 'n' }, { id: 'q' }, { id: 'z' }];
    const cites = (source: string, label: string) => ({ ...edge(source, 'z', 'cites'), label });
    const before = { nodes, edges: [cites('n', 'first'), cites('n', 'second')] };
    const edges = [cites('n', 'first, revised'), cites('q', 'second')];
    for (const options of [{}, BY_ID]) {
      expect(ids(before, { nodes, edges }, options)).toEqual(['relations:n']);
      // One more edge under `q` makes its hunk the larger one.
      const larger = { nodes, edges: [...edges, edge('q', 'n', 'fresh-predicate')] };
      expect(ids(before, larger, options)).toEqual(['relations:q']);
      // An attribute on `n` puts `n` into the hunk, which is not `modify:n`.
      const changedNode = { nodes: [{ id: 'n', attrs: { k: 1 } }, nodes[1], nodes[2]], edges };
      const d = diff(before, changedNode as GraphInput, options);
      expect(d.hunks.map((h) => [h.id, h.nodes])).toEqual([['relations:q', ['n']]]);
    }
  });

  it('hunks that come to require each other: one takes the other in', () => {
    // `a9` replaces `a` and now lives in the new `n`: its hunk requires the hunk that adds `n`.
    const after = (edges: string) => `{"nodes":[
      {"id":"a9","label":"Marie Curie","type":["Person"],"replaces":["a"]},
      {"id":"b","label":"Paris"},{"id":"n","label":"Warsaw"}],
    "edges":[{"source":"a9","target":"n","predicate":"livesIn"}${edges}]}`;
    for (const options of [{}, BY_ID]) {
      expect(idsOf(CURIE, after(''), options)).toEqual(['add:n', 'modify:a9']);
      // An edge back makes adding `n` require the renamed `a9` as well.
      const back = ',{"source":"n","target":"a9","predicate":"birthplaceOf"}';
      const d = diff(graph(CURIE), graph(after(back)), options);
      expect(d.hunks.map((h) => [h.id, h.nodes])).toEqual([['modify:a9', ['a9', 'n']]]);
    }
  });
});

/** `list` with `from` replaced by `to`, sorted. */
function changed(list: readonly string[], from: string, to: string): string[] {
  return list.map((id) => (id === from ? to : id)).sort();
}
