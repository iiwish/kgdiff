/**
 * Normalized graphs (`KGraph`s) given to the engine. They are passed as `graphToJSON` writes them,
 * and a `kgdiff.graph` document leaves out three things a `KGraph` has: its edge identity, the
 * issues its normalization found and its nodes' positions. Each must reach the result as it does
 * for the graphs as input (the corpus' expected files, written by the native engine) and as `diff`
 * of 0.10 kept it. Nodes' `implicit` flag is in the document.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '@kgdiff/core';
import {
  type DiffOptions,
  type DiffResult,
  diffToJSON,
  type EdgeIdentity,
  type GraphInput,
  graphToJSON,
  type KGraph,
  normalize,
} from '@kgdiff/core';
import * as layoutPackage from '@kgdiff/layout';
import { type LayoutOptions, type LayoutResult, layoutToJSON } from '@kgdiff/layout';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  diffAndLayoutSync,
  diffSync,
  extendLayoutSync,
  init,
  json,
  layoutAfterSync,
  layoutDiffOnSync,
  layoutDiffSync,
  layoutGraphSync,
  matchNodesSync,
} from '../src/index.js';
import { enabled } from './support.js';

const CORPUS = fileURLToPath(new URL('../../../conformance/', import.meta.url));
const read = (path: string) => readFileSync(`${CORPUS}${path}`, 'utf8');
const readJSON = <T>(path: string) => JSON.parse(read(path)) as T;

interface CaseSpec {
  readonly options?: DiffOptions;
  readonly layoutOptions?: LayoutOptions;
}

const cases = readJSON<{ cases: { id: string }[] }>('manifest.json').cases.map((c) => c.id);
const other = (mode: EdgeIdentity): EdgeIdentity => (mode === 'id' ? 'structure' : 'id');
const text = (result: DiffResult) => `${JSON.stringify(diffToJSON(result))}\n`;
const layoutText = (layout: LayoutResult) => JSON.stringify(layoutToJSON(layout));

/** Edges without an option, and with: `KGraph`s with the same edge identity bring theirs. */
function withoutIdentity(options: DiffOptions): DiffOptions {
  const { edgeIdentity: _, ...rest } = options;
  return rest;
}

describe.runIf(enabled)('normalized graphs given to the engine', () => {
  beforeAll(() => init());

  it('the corpus has cases of both edge identities', () => {
    const modes = cases.map(
      (id) => readJSON<CaseSpec>(`cases/${id}/case.json`).options?.edgeIdentity,
    );
    expect(modes).toContain('id');
    expect(modes.filter((m) => m !== 'id').length).toBeGreaterThan(0);
  });

  describe.each(cases)('%s', (id) => {
    const dir = `cases/${id}/`;
    const spec = readJSON<CaseSpec>(`${dir}case.json`);
    const options = spec.options ?? {};
    const mode = options.edgeIdentity ?? 'structure';
    const input = (side: string) =>
      readJSON<{ graph: GraphInput }>(`${dir}expected/parse.${side}.json`).graph;
    const [rawBefore, rawAfter] = [input('before'), input('after')];
    const graphs = (edgeIdentity: EdgeIdentity): [KGraph, KGraph] => [
      normalize(rawBefore, { edgeIdentity }),
      normalize(rawAfter, { edgeIdentity }),
    ];
    const expected = read(`${dir}expected/diff.json`);
    const issues = readJSON<Record<'before' | 'after', unknown>>(`${dir}expected/issues.json`);

    it('diff: the graphs’ edge identity when the options name none', () => {
      const [before, after] = graphs(mode);
      const rest = withoutIdentity(options);
      expect(text(diffSync(before, after, rest))).toBe(expected);
      expect(`${json.diff(before, after, rest)}\n`).toBe(expected);
      expect(`${json.diff(before, after, JSON.stringify(rest))}\n`).toBe(expected);
      expect(text(diffAndLayoutSync(before, after, rest, spec.layoutOptions).diff)).toBe(expected);
    });

    it('diff: the option’s edge identity over the graphs’ (re-keyed, as in 0.10)', () => {
      const [before, after] = graphs(other(mode));
      expect(text(diffSync(before, after, { ...options, edgeIdentity: mode }))).toBe(expected);
      expect(`${json.diff(before, after, { ...options, edgeIdentity: mode })}\n`).toBe(expected);
    });

    it('diff: the issues of normalizing each graph', () => {
      const result = diffSync(JSON.stringify(rawBefore), JSON.stringify(rawAfter), options);
      expect({ before: result.before.issues, after: result.after.issues }).toEqual(issues);
      const [before, after] = graphs(mode);
      const computed = diffSync(before, after, withoutIdentity(options));
      expect(computed.before.issues).toBe(before.issues);
      expect(computed.after.issues).toBe(after.issues);
      const both = diffAndLayoutSync(rawBefore, rawAfter, options).diff;
      expect({ before: both.before.issues, after: both.after.issues }).toEqual(issues);
    });

    it('diffAndLayout: the layout of the graphs as input', () => {
      const [before, after] = graphs(mode);
      const given = spec.layoutOptions ?? {};
      const { layout } = diffAndLayoutSync(before, after, withoutIdentity(options), given);
      const native = diffAndLayoutSync(rawBefore, rawAfter, options, given).layout;
      expect(layoutText(layout)).toBe(layoutText(native));
      expect(
        layoutText(layoutDiffSync(diffSync(before, after, withoutIdentity(options)), given)),
      ).toBe(layoutText(layoutDiffSync(diffSync(rawBefore, rawAfter, options), given)));
    });

    it('matchNodes: each graph with its own edge identity', () => {
      const [before, after] = graphs(mode);
      const matched = matchNodesSync(before, after, options.match);
      // `diff` aligns the nodes the same way (no attribute is ignored in matching); its matches
      // are the ones not implied by equal ids.
      if ((options.ignoreAttrs ?? []).length === 0) {
        const result = core.diffFromJSON(JSON.parse(expected));
        expect(matched.matches.filter((m) => m.method !== 'id')).toEqual(result.matches);
      }
      expect(json.matchNodes(before, after, options.match)).toBe(JSON.stringify(matched));
    });

    it('layoutGraph: the layout of the graph normalized natively with its edge identity', () => {
      for (const raw of [rawBefore, rawAfter]) {
        for (const edgeIdentity of ['structure', 'id'] as const) {
          const graph = normalize(raw, { edgeIdentity });
          expect(layoutText(layoutGraphSync(graph))).toBe(
            json.layoutGraph(JSON.stringify(raw), {}, { edgeIdentity }),
          );
        }
      }
    });

    it('the layouts of a diff of normalized graphs: those of the diff of the graphs as input', () => {
      const [before, after] = graphs(mode);
      const ofGraphs = diffSync(before, after, withoutIdentity(options));
      const ofInput = diffSync(rawBefore, rawAfter, options);
      const previous = layoutGraphSync(before);
      const same = (f: (d: DiffResult) => LayoutResult) =>
        expect(layoutText(f(ofGraphs))).toBe(layoutText(f(ofInput)));
      same((d) => layoutDiffOnSync(d, previous));
      same((d) => layoutAfterSync(d, layoutDiffSync(d)));
      same((d) => {
        const focused = layoutDiffSync(d, { scope: 'changes' });
        return extendLayoutSync(d, focused, [...focused.hidden.keys()]);
      });
    });
  });

  // Edges that share a triple and their content but not their id: two edges with `id`, one with
  // `structure` (the copies are collapsed), so the degrees and neighbourhoods matching reads differ.
  const parallel = (label: string, many: 'p' | 'q'): GraphInput => ({
    nodes: [{ id: label === 'Alpha Beta' ? 'x' : 'y', label }, { id: 'h' }, { id: 'k' }],
    edges: [
      { id: `${label}1`, source: label === 'Alpha Beta' ? 'x' : 'y', target: 'h', predicate: 'p' },
      { id: `${label}2`, source: label === 'Alpha Beta' ? 'x' : 'y', target: 'k', predicate: 'q' },
      {
        id: `${label}3`,
        source: label === 'Alpha Beta' ? 'x' : 'y',
        target: many === 'p' ? 'h' : 'k',
        predicate: many,
      },
    ],
  });
  const before = parallel('Alpha Beta', 'p');
  const after = parallel('Alpha Betas', 'q');

  it('matchNodes counts the parallel edges of an `id` graph, as the diff of the graphs does', async () => {
    const structure = matchNodesSync(normalize(before), normalize(after));
    const [b, a] = [
      normalize(before, { edgeIdentity: 'id' }),
      normalize(after, { edgeIdentity: 'id' }),
    ];
    const id = matchNodesSync(b, a);
    expect(id).not.toEqual(structure);
    const native = diffSync(before, after, { edgeIdentity: 'id' });
    expect(id.matches.filter((m) => m.method !== 'id')).toEqual(native.matches);
    for (const s of id.suggestions) expect(native.suggestions).toContainEqual(s);
    expect(await core.matchNodes(b, a)).toEqual(id);
  });

  it('diff of `@kgdiff/core` and the asynchronous functions take the graphs’ edge identity', async () => {
    const [b, a] = [
      normalize(before, { edgeIdentity: 'id' }),
      normalize(after, { edgeIdentity: 'id' }),
    ];
    const expected = text(diffSync(before, after, { edgeIdentity: 'id' }));
    expect(text(diffSync(b, a))).toBe(expected);
    expect(text(diffSync(b, a, {}))).toBe(expected);
    expect(text(await core.diff(b, a))).toBe(expected);
    expect(`${json.diff(b, a, '')}\n`).toBe(expected);
    expect(`${json.diff(b, a, 'null')}\n`).toBe(expected);
    expect(`${json.diff(b, a, '{"edgeIdentity":null}')}\n`).toBe(expected);
    const layout = diffAndLayoutSync(b, a);
    expect(text(layout.diff)).toBe(expected);
    expect(layoutText(await layoutPackage.layoutGraph(b))).toBe(layoutText(layoutGraphSync(b)));
  });

  it('two graphs of different edge identities, or one graph as input: the default', () => {
    const b = normalize(before, { edgeIdentity: 'id' });
    const expected = text(diffSync(before, after));
    expect(text(diffSync(b, normalize(after)))).toBe(expected);
    expect(text(diffSync(b, after))).toBe(expected);
    expect(diffSync(b, after).options.edgeIdentity).toBe('structure');
  });

  it('a re-keyed graph has the issues of its re-normalization, as in 0.10', () => {
    const b = normalize(before, { edgeIdentity: 'id' });
    const result = diffSync(b, b, { edgeIdentity: 'structure' });
    expect(b.issues).toEqual([]);
    expect(result.before.issues).toEqual(normalize(graphToJSON(b)).issues);
    expect(result.before.issues.map((i) => i.code)).toEqual(['duplicate-edge']);
  });

  it('implicit nodes stay implicit', () => {
    const raw: GraphInput = { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'b' }] };
    const graph = normalize(raw);
    const result = diffSync(graph, graph);
    expect(result.before.nodes.get('b')?.implicit).toBe(true);
    expect(text(result)).toBe(text(diffSync(raw, raw)));
    expect(result.before.issues).toBe(graph.issues);
  });
});
