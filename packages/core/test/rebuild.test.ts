/**
 * `diffFromJSON` reads canonical snapshots straight into graphs (`canonicalGraphs`) and
 * re-normalizes only documents it cannot (`normalizedGraphs`). The fast path must either give up
 * or build exactly what normalizing builds: same maps, same order, same objects field by field.
 */
import {
  type DiffJSON,
  type DiffOptions,
  diff,
  diffFromJSON,
  diffToJSON,
  type KGraph,
  packDiffJSON,
  unpackDiffJSON,
} from '@kgdiff/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalGraphs, normalizedGraphs } from '../src/json.js';
import { versionPairArb } from './support/arbitraries.js';
import { editGraph, syntheticGraph } from './support/synthetic.js';

const RUNS = Number(process.env.KGDIFF_PROPERTY_RUNS ?? 300);

/** Everything about a graph, in order: maps as entry lists, frozen objects marked. */
function dump(g: KGraph): string {
  const graph = {
    meta: g.meta,
    nodes: [...g.nodes],
    edges: [...g.edges],
    outgoing: [...g.outgoing],
    incoming: [...g.incoming],
    edgeIdentity: g.edgeIdentity,
    issues: g.issues,
  };
  return JSON.stringify(graph, (_, v: unknown) =>
    typeof v === 'object' && v !== null && Object.isFrozen(v)
      ? { frozen: Array.isArray(v) ? [...v] : { ...v } }
      : v,
  );
}

/**
 * Rebuilds `json` both ways; when the fast path does not give up, both must agree (and the
 * reference must not throw). Returns which path a reader takes.
 */
function expectSameGraphs(json: DiffJSON): 'fast' | 'normalized' {
  const mode = json.options.edgeIdentity;
  const fast = canonicalGraphs(json, mode);
  if (!fast) return 'normalized';
  const reference = normalizedGraphs(json, mode);
  expect(dump(fast.before)).toBe(dump(reference.before));
  expect(dump(fast.after)).toBe(dump(reference.after));
  json.edges.forEach((e, i) => {
    for (const side of ['before', 'after'] as const) {
      const edge = side === 'before' ? fast.beforeEdge(e, i) : fast.afterEdge(e, i);
      const expected = side === 'before' ? reference.beforeEdge(e, i) : reference.afterEdge(e, i);
      expect(JSON.stringify(edge)).toBe(JSON.stringify(expected));
      if (edge) expect(fast[side].edges.get(edge.key)).toBe(edge);
    }
  });
  return 'fast';
}

const VARIANTS: readonly [string, DiffOptions][] = [
  ['default options', {}],
  ['id edge identity', { edgeIdentity: 'id' }],
  ['similarity matching', { match: { strategy: 'similarity' } }],
];

// biome-ignore lint/suspicious/noExplicitAny: snapshots are damaged field by field
type Doc = Record<string, any>;

/** Damage to one node snapshot (`s`) of a union node (`n`). */
const NODE_DAMAGE: Record<string, (s: Doc, n: Doc) => void> = {
  'label = id': (s) => {
    s.label = s.id;
  },
  'empty label': (s) => {
    s.label = '';
  },
  'numeric label': (s) => {
    s.label = 1;
  },
  'decomposed label': (s) => {
    s.label = 'Café';
  },
  'unsorted types': (s) => {
    s.types = ['b', 'a'];
  },
  'repeated type': (s) => {
    s.types = ['a', 'a'];
  },
  'empty type': (s) => {
    s.types = [''];
  },
  'no types': (s) => {
    s.types = [];
  },
  'types as a string': (s) => {
    s.types = 'a';
  },
  'a type field': (s) => {
    s.type = 'X';
  },
  'alias = label': (s) => {
    s.aliases = [s.label ?? s.id];
  },
  'decomposed alias': (s) => {
    s.aliases = ['Café'];
  },
  'string deprecated': (s) => {
    s.deprecated = 'yes';
  },
  'null deprecated': (s) => {
    s.deprecated = null;
  },
  'false deprecated': (s) => {
    s.deprecated = false;
  },
  'unsorted replaces': (s) => {
    s.replaces = ['z', 'a'];
  },
  'attrs array': (s) => {
    s.attrs = [1];
  },
  'null attrs': (s) => {
    s.attrs = null;
  },
  'empty attrs': (s) => {
    s.attrs = {};
  },
  'undefined attr': (s) => {
    s.attrs = { k: undefined };
  },
  'non-finite attr': (s) => {
    s.attrs = { k: Number.NaN, __proto__: 1 };
  },
  'deep attrs': (s) => {
    let deep: Doc = {};
    for (let i = 0; i < 1001; i++) deep = { d: deep };
    s.attrs = deep;
  },
  'numeric id': (s) => {
    s.id = 7;
  },
  'empty id': (s) => {
    s.id = '';
  },
  'a position': (s) => {
    s.position = { x: 1, y: 2 };
  },
  'string implicit': (s) => {
    s.implicit = 'true';
  },
  'another before id': (_, n) => {
    n.beforeId = 'elsewhere';
  },
  'numeric before id': (_, n) => {
    n.beforeId = 3;
  },
  'a string before': (_, n) => {
    n.before = 'x';
  },
  'a copy as before': (s, n) => {
    n.before = { ...s };
  },
};

/** Damage to one edge snapshot (`s`) of a union edge (`e`), given another snapshot (`other`). */
const EDGE_DAMAGE: Record<string, (s: Doc, e: Doc, other: Doc) => void> = {
  'null predicate': (s) => {
    s.predicate = null;
  },
  'numeric predicate': (s) => {
    s.predicate = 3;
  },
  'null label': (s) => {
    s.label = null;
  },
  'empty label': (s) => {
    s.label = '';
  },
  'decomposed label': (s) => {
    s.label = 'Café';
  },
  'numeric label': (s) => {
    s.label = 2;
  },
  'empty id': (s) => {
    s.id = '';
  },
  'null id': (s) => {
    s.id = null;
  },
  'numeric id': (s) => {
    s.id = 5;
  },
  'an id': (s) => {
    s.id = 'E1';
  },
  'undefined attr': (s) => {
    s.attrs = { k: undefined };
  },
  'non-finite attr': (s) => {
    s.attrs = { k: Number.POSITIVE_INFINITY };
  },
  'date attr': (s) => {
    s.attrs = { k: new Date(0) };
  },
  'empty attrs': (s) => {
    s.attrs = {};
  },
  'empty source': (s) => {
    s.source = '';
  },
  'numeric source': (s) => {
    s.source = 5;
  },
  'null source': (s) => {
    s.source = null;
  },
  'dangling target': (s) => {
    s.target = 'nowhere';
  },
  'a copy of another edge': (s, _, other) => {
    for (const key of Object.keys(s)) delete s[key];
    Object.assign(s, structuredClone(other));
  },
  'a separate before': (s, e) => {
    if (e.status !== 'added' && e.status !== 'removed') e.before = { ...s };
  },
};

describe('diffFromJSON reads canonical snapshots directly', () => {
  it.each(VARIANTS)('builds what normalizing builds (%s)', (_name, options) => {
    const taken = { fast: 0, normalized: 0 };
    fc.assert(
      fc.property(versionPairArb(), ([a, b]) => {
        const json = JSON.parse(JSON.stringify(diffToJSON(diff(a, b, options)))) as DiffJSON;
        taken[expectSameGraphs(json)]++;
        taken[expectSameGraphs(unpackDiffJSON(packDiffJSON(json)))]++;
      }),
      { numRuns: RUNS / 2 },
    );
    // Both paths ran (parallel edges, for one, take the normalizing path).
    expect(taken.fast).toBeGreaterThan(0);
    expect(taken.normalized).toBeGreaterThan(0);
  });

  it.each(VARIANTS)('gives up on or agrees about damaged snapshots (%s)', (_name, options) => {
    const damage = fc.oneof(
      fc.tuple(fc.constant('node' as const), fc.constantFrom(...Object.keys(NODE_DAMAGE))),
      fc.tuple(fc.constant('edge' as const), fc.constantFrom(...Object.keys(EDGE_DAMAGE))),
    );
    fc.assert(
      fc.property(
        versionPairArb(),
        damage,
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        ([a, b], [kind, name], i, j, before) => {
          const json = JSON.parse(JSON.stringify(diffToJSON(diff(a, b, options)))) as Doc;
          if (kind === 'node') {
            const n = json.nodes[i % Math.max(json.nodes.length, 1)];
            const s = n && (before ? (n.before ?? n.after) : (n.after ?? n.before));
            if (!s) return;
            NODE_DAMAGE[name]?.(s, n);
          } else {
            const e = json.edges[i % Math.max(json.edges.length, 1)];
            const other = json.edges[j % json.edges.length];
            const s = e && (before ? (e.before ?? e.after) : (e.after ?? e.before));
            if (!s || !other) return;
            EDGE_DAMAGE[name]?.(s, e, other.after ?? other.before);
          }
          expectSameGraphs(json as DiffJSON);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('takes the fast path for what kgdiff writes, packed or not', () => {
    const before = syntheticGraph(300, 900);
    for (const options of [{}, { edgeIdentity: 'id' } as const]) {
      const d = diff(before, editGraph(before), options);
      const json = JSON.parse(JSON.stringify(diffToJSON(d))) as DiffJSON;
      expect(expectSameGraphs(json)).toBe('fast');
      expect(expectSameGraphs(unpackDiffJSON(packDiffJSON(json)))).toBe('fast');
      expect(JSON.stringify(diffToJSON(diffFromJSON(json)))).toBe(JSON.stringify(json));
    }
  });

  it('normalizes graphs with parallel edges', () => {
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b', predicate: 'p', attrs: { w: 1 } },
        { source: 'a', target: 'b', predicate: 'p', attrs: { w: 2 } },
      ],
    };
    const json = diffToJSON(diff(graph, graph));
    expect(expectSameGraphs(json)).toBe('normalized');
    const back = diffFromJSON(json);
    expect([...back.after.edges.keys()]).toEqual(['["a","p","b"]', '["a","p","b"]#2']);
    expect(JSON.stringify(diffToJSON(back))).toBe(JSON.stringify(json));
  });
});
