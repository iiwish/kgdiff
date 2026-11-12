/**
 * `diffFromJSON` must open a document the same way whatever Unicode version the runtime's ICU
 * has (RFC 0002 §11): a report made with Node 24 (Unicode 17) is opened in browsers with older
 * tables, and later by a reader whose writer is Rust. So it takes the text of the snapshots as
 * its writer normalized it, and the content hashes in the delta check that text, instead of
 * composing it to NFC again.
 *
 * A runtime whose NFC differs is simulated by stubbing `String.prototype.normalize`: its NFC is
 * the real NFD, an exaggeration of the few characters whose composition changes between Unicode
 * versions.
 */
import {
  type DiffJSON,
  diffFromJSON,
  diffToJSON,
  type GraphInput,
  graphToJSON,
  hashGraph,
  normalize,
  packDiffJSON,
  unpackDiffJSON,
} from '@kgdiff/core';
import { describe, expect, it, vi } from 'vitest';
import { canonicalGraphs } from '../src/json.js';
import { diff } from '../src/sync.js';

const nativeNormalize = String.prototype.normalize;

/** `String.prototype.normalize` of the simulated runtime: its NFC is the real NFD. */
function otherNormalize(this: string, form?: string): string {
  return nativeNormalize.call(this, form === undefined || form === 'NFC' ? 'NFD' : form);
}

/** Runs `run` on the simulated runtime; counts the NFC it asks for. */
function onOtherUnicode<T>(run: () => T): { result: T; nfcCalls: number } {
  const spy = vi.spyOn(String.prototype, 'normalize').mockImplementation(otherNormalize);
  try {
    const result = run();
    const nfcCalls = spy.mock.calls.filter(([form]) => form === undefined || form === 'NFC');
    return { result, nfcCalls: nfcCalls.length };
  } finally {
    spy.mockRestore();
  }
}

/** Text that NFC and NFD write differently: accents, Hangul syllables, ligature-free Latin. */
const before: GraphInput = {
  nodes: [
    { id: 'cafe', label: 'Café', aliases: ['Crème', 'Kaffeehaus'], type: ['Établissement'] },
    { id: 'seoul', label: '서울', type: ['도시'] },
    { id: 'zurich', label: 'Zürich' },
    { id: 'geneve', label: 'Genève' },
  ],
  edges: [
    // No label of its own: it is the predicate's, `situé à`.
    { source: 'cafe', target: 'zurich', predicate: 'http://example.org/situé_à' },
    { source: 'seoul', target: 'zurich', predicate: 'ex:twin', label: 'jumelée avec' },
    { source: 'geneve', target: 'zurich', predicate: 'ex:près_de' },
  ],
};
const after: GraphInput = {
  nodes: [
    { id: 'cafe', label: 'Café Zürich', aliases: ['Crème brûlée'], type: ['Établissement'] },
    { id: 'seoul', label: '서울특별시', type: ['도시'] },
    { id: 'zurich', label: 'Zürich' },
    { id: 'geneve', label: 'Genève' },
    { id: 'lausanne', label: 'Lausanne – Ouchy', type: ['Ville'] },
  ],
  edges: [
    { source: 'cafe', target: 'geneve', predicate: 'http://example.org/situé_à' },
    { source: 'seoul', target: 'zurich', predicate: 'ex:twin', label: 'jumelée avec Séoul' },
    { source: 'geneve', target: 'zurich', predicate: 'ex:près_de' },
    { source: 'lausanne', target: 'geneve', predicate: 'ex:près_de', label: 'tout près de' },
  ],
};
/** The same, with parallel edges: `diffFromJSON` normalizes it instead of reading it directly. */
const parallel = (g: GraphInput): GraphInput => ({
  ...g,
  edges: [
    ...(g.edges ?? []),
    { source: 'zurich', target: 'geneve', predicate: 'ex:liée_à', attrs: { voie: 'A1' } },
    { source: 'zurich', target: 'geneve', predicate: 'ex:liée_à', attrs: { voie: 'Léman' } },
  ],
});

const CASES = [
  ['read directly', before, after, true],
  ['normalized again (parallel edges)', parallel(before), parallel(after), false],
] as const;

const written = (b: GraphInput, a: GraphInput): DiffJSON =>
  JSON.parse(JSON.stringify(diffToJSON(diff(b, a)))) as DiffJSON;

describe('the simulated runtime', () => {
  it('composes text differently, and normalize uses it for API input', () => {
    const { result } = onOtherUnicode(() => ({
      text: 'Café'.normalize('NFC'),
      label: normalize({ nodes: [{ id: 'x', label: 'Café' }], edges: [] }).nodes.get('x')?.label,
    }));
    expect(result.text).not.toBe('Café');
    expect(result.text).toBe(nativeNormalize.call('Café', 'NFD'));
    expect(result.label).toBe(result.text);
  });
});

describe.each(CASES)('diffFromJSON on another Unicode version: %s', (_name, b, a, direct) => {
  const d = diff(b, a);
  const json = written(b, a);
  const text = JSON.stringify(json);

  it('takes the expected path', () => {
    expect(canonicalGraphs(json, json.options.edgeIdentity) !== undefined).toBe(direct);
  });

  it('opens what kgdiff wrote, never asking for NFC, and hashes as before', () => {
    const { result, nfcCalls } = onOtherUnicode(() => {
      const back = diffFromJSON(JSON.parse(text) as DiffJSON);
      return {
        back,
        hashes: [hashGraph(back.before), hashGraph(back.after)],
        again: JSON.stringify(diffToJSON(back)),
      };
    });
    expect(nfcCalls).toBe(0);
    expect(result.hashes).toEqual([hashGraph(d.before), hashGraph(d.after)]);
    expect(result.hashes).toEqual([json.delta.base.hash, json.delta.target.hash]);
    expect(result.back.after.nodes.get('cafe')?.label).toBe('Café Zürich');
    expect(result.again).toBe(text);
  });

  it('opens the packed form of a report the same way', () => {
    const packed = JSON.stringify(packDiffJSON(json));
    const { result, nfcCalls } = onOtherUnicode(() =>
      JSON.stringify(diffToJSON(diffFromJSON(unpackDiffJSON(JSON.parse(packed))))),
    );
    expect(nfcCalls).toBe(0);
    expect(result).toBe(text);
  });

  it('opens what a runtime with other tables wrote', () => {
    // Written where NFC is the real NFD, read here: the text stays as that writer made it.
    const { result: there } = onOtherUnicode(() => {
      const other = diff(b, a);
      return { json: JSON.stringify(diffToJSON(other)), hash: hashGraph(other.after) };
    });
    const back = diffFromJSON(JSON.parse(there.json) as DiffJSON);
    expect(hashGraph(back.after)).toBe(there.hash);
    expect(back.after.nodes.get('cafe')?.label).toBe(nativeNormalize.call('Café Zürich', 'NFD'));
    expect(JSON.stringify(diffToJSON(back))).toBe(there.json);
  });
});

describe('diffFromJSON: snapshot text is checked by content hash', () => {
  // biome-ignore lint/suspicious/noExplicitAny: documents are damaged field by field
  type Doc = Record<string, any>;
  const nfd = (s: string): string => nativeNormalize.call(s, 'NFD');
  const node = (j: Doc, id: string): Doc => j.nodes.find((n: Doc) => n.id === id).after;
  const edge = (j: Doc, test: (s: Doc) => boolean): Doc =>
    j.edges.map((e: Doc) => e.after ?? e.before).find(test);

  it.each<[string, (j: Doc) => void]>([
    ['a label not in NFC', (j) => (node(j, 'zurich').label = nfd('Zürich'))],
    ['an alias not in NFC', (j) => (node(j, 'cafe').aliases = [nfd('Crème brûlée')])],
    ['a type not in NFC', (j) => (node(j, 'seoul').types = [nfd('도시')])],
    ['an edited label', (j) => (node(j, 'geneve').label = 'Geneva')],
    [
      'an edge label not in NFC',
      (j) => (edge(j, (s) => s.label === 'tout près de').label = nfd('tout près de')),
    ],
    ['an edge label left out', (j) => delete edge(j, (s) => s.label === 'tout près de').label],
    [
      'an edge label written out in NFD',
      (j) => (edge(j, (s) => s.predicate === 'ex:près_de' && !s.label).label = nfd('près de')),
    ],
  ])('rejects %s, on any runtime', (_name, damage) => {
    for (const [, b, a] of CASES) {
      const j = written(b, a) as Doc;
      damage(j);
      const rejection = expect.objectContaining({
        code: 'invalid-input',
        message: expect.stringMatching(/delta\.(base|target) is another graph/),
      });
      expect(() => diffFromJSON(j as DiffJSON)).toThrowError(rejection);
      const { result } = onOtherUnicode(() => {
        try {
          diffFromJSON(j as DiffJSON);
          return undefined;
        } catch (error) {
          return error;
        }
      });
      expect(result).toEqual(rejection);
    }
  });
});

describe('edge labels left out of kgdiff JSON', () => {
  // `predicateLabel` composes the readable part of a predicate to NFC; written decomposed, its
  // label differs from that part as written, so the writer keeps it.
  const decomposed = 'http://example.org/Cafe\u0301_cre\u0300me';
  const graph: GraphInput = {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [
      { source: 'a', target: 'b', predicate: decomposed },
      { source: 'b', target: 'a', predicate: 'http://example.org/Café_crème' },
    ],
  };
  const g = normalize(graph);

  it('are those a reader restores without NFC', () => {
    const edges = graphToJSON(g).edges;
    expect(edges.find((e) => e.predicate === decomposed)?.label).toBe('Café crème');
    expect(edges.find((e) => e.predicate !== decomposed)).not.toHaveProperty('label');
    expect(hashGraph(normalize(graphToJSON(g)))).toBe(hashGraph(g));
  });

  it('read back on another Unicode version', () => {
    const json = JSON.stringify(diffToJSON(diff(graph, { ...graph, nodes: [{ id: 'a' }] })));
    const { result, nfcCalls } = onOtherUnicode(() =>
      JSON.stringify(diffToJSON(diffFromJSON(JSON.parse(json) as DiffJSON))),
    );
    expect(nfcCalls).toBe(0);
    expect(result).toBe(json);
  });
});
