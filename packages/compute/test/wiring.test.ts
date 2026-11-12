/**
 * How `@kgdiff/core`, `@kgdiff/formats` and `@kgdiff/layout` run on this package since 0.11:
 *
 * - their asynchronous functions give what the TypeScript engine they replace gave (until it is
 *   deleted), and what the `*Sync` functions here give;
 * - the trusted path: a diff the engine has just written is read back without `diffFromJSON`'s
 *   checks, and the object is the one `diffFromJSON` builds;
 * - node positions survive the read-back, so a diff of graphs with positions is laid out
 *   anchored on them (the corpus case `json-dialects-c`, AntV G6 nodes with x / y).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type DiffOptions,
  type DiffResult,
  diff,
  diffFromJSON,
  diffToJSON,
  type GraphInput,
  matchNodes,
  normalize,
  textSimilarity,
} from '@kgdiff/core';
import { readComputedDiff } from '@kgdiff/core/computed';
import { compactIri, detectFormat, parseGraph } from '@kgdiff/formats';
import {
  extendLayout,
  layoutAfter,
  layoutDiff,
  layoutDiffOn,
  layoutGraph,
  layoutToJSON,
} from '@kgdiff/layout';
import { beforeAll, describe, expect, it } from 'vitest';
import * as engineTS from '../../core/src/sync.js';
import * as parsersTS from '../../formats/src/sync.js';
import {
  compactIriSync,
  detectFormatSync,
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
  parseGraphSync,
  textSimilaritySync,
} from '../src/index.js';
import { enabled } from './support.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

const CASES = (JSON.parse(read('conformance/manifest.json')) as { cases: { id: string }[] }).cases;

function caseOf(id: string): { before: string; after: string; options: DiffOptions } {
  const graph = (side: string) =>
    JSON.stringify(
      (
        JSON.parse(read(`conformance/cases/${id}/expected/parse.${side}.json`)) as {
          graph: unknown;
        }
      ).graph,
    );
  const spec = JSON.parse(read(`conformance/cases/${id}/case.json`)) as { options?: DiffOptions };
  return { before: graph('before'), after: graph('after'), options: spec.options ?? {} };
}

/** A `DiffResult` without its index (an object of closures, compared through lookups). */
function plain(result: DiffResult): Omit<DiffResult, 'index'> {
  const { index: _, ...rest } = result;
  return rest;
}

function expectSameIndex(a: DiffResult, b: DiffResult): void {
  for (const n of a.nodes) {
    expect(b.index.node(n.id)).toEqual(a.index.node(n.id));
    expect(b.index.edgesOf(n.id).map((e) => e.id)).toEqual(a.index.edgesOf(n.id).map((e) => e.id));
  }
  for (const h of a.hunks) expect(b.index.hunk(h.id)).toEqual(a.index.hunk(h.id));
}

const layoutText = (layout: Parameters<typeof layoutToJSON>[0]) =>
  JSON.stringify(layoutToJSON(layout));

describe.runIf(enabled)('the TypeScript packages on @kgdiff/compute', () => {
  beforeAll(() => init());

  describe.each(CASES.map((c) => c.id))('%s', (id) => {
    const { before, after, options } = caseOf(id);

    it('trusted path: the object diffFromJSON reads, without its checks', () => {
      const text = json.diff(before, after, options);
      const checked = diffFromJSON(JSON.parse(text));
      // Graphs given as text without "position": nothing is put back, only the checks differ.
      const trusted = readComputedDiff(text, '{}', '{}');
      expect(plain(trusted)).toEqual(plain(checked));
      expectSameIndex(checked, trusted);
      expect(JSON.stringify(diffToJSON(trusted))).toBe(text);
    });

    it('diff of @kgdiff/core: the TypeScript engine’s result, positions included', async () => {
      const [b, a] = [JSON.parse(before) as GraphInput, JSON.parse(after) as GraphInput];
      const result = await diff(b, a, options);
      const ts = engineTS.diff(b, a, options);
      expect(JSON.stringify(diffToJSON(result))).toBe(JSON.stringify(diffToJSON(ts)));
      // Every node as the TypeScript engine had it, its position included (the graphs' maps are
      // in the document's order, as `diffFromJSON` reads them).
      for (const side of ['before', 'after'] as const) {
        expect(result[side].nodes.size).toBe(ts[side].nodes.size);
        for (const node of ts[side].nodes.values()) {
          expect(result[side].nodes.get(node.id)).toEqual(node);
        }
      }
      // And from normalized graphs, as `load()` with a KGraph passes them.
      const fromGraphs = await diff(normalize(b), normalize(a), options);
      expect(plain(fromGraphs)).toEqual(plain(diffSync(normalize(b), normalize(a), options)));
    });

    it('layoutDiff of @kgdiff/layout lays out what the engine lays out with the diff', async () => {
      const result = diffSync(before, after, options);
      const { layout } = diffAndLayoutSync(before, after, options);
      // Positions read back: the same layout as the one computed on the engine's own diff.
      expect(layoutText(await layoutDiff(result))).toBe(layoutText(layout));
      expect(layoutText(layoutDiffSync(result))).toBe(layoutText(layout));
    });
  });

  it('keeps node positions: json-dialects-c is laid out anchored, as in 0.10', async () => {
    const { before, after, options } = caseOf('json-dialects-c');
    const ts = engineTS.diff(JSON.parse(before), JSON.parse(after), options);
    const result = await diff(JSON.parse(before), JSON.parse(after), options);
    // Its after version has positions (G6 x / y), its before version none.
    expect([...ts.after.nodes.values()].some((n) => n.position)).toBe(true);
    for (const side of ['before', 'after'] as const) {
      for (const node of ts[side].nodes.values()) {
        expect(result[side].nodes.get(node.id)?.position).toEqual(node.position);
      }
    }
    const layout = await layoutDiff(result);
    expect(layout.stats.strategy).toBe('anchored');
    // A diff read from its document (a report) has no positions: laid out from scratch.
    expect(
      layoutDiffSync(diffFromJSON(JSON.parse(json.diff(before, after, options)))).stats.strategy,
    ).toBe('union');
    // Graphs given as text keep them too.
    expect(diffSync(before, after, options).after.nodes).toEqual(result.after.nodes);
  });

  it('a node stored once in the document gets each version’s own position', () => {
    const before = { nodes: [{ id: 'a', label: 'A', position: { x: 1, y: 2 } }], edges: [] };
    const after = { nodes: [{ id: 'a', label: 'A', position: { x: 5, y: 6 } }], edges: [] };
    const result = diffSync(before, after);
    expect(result.before.nodes.get('a')?.position).toEqual({ x: 1, y: 2 });
    expect(result.after.nodes.get('a')?.position).toEqual({ x: 5, y: 6 });
    expect(result.stats.identical).toBe(true);
    expect(JSON.stringify(diffToJSON(result))).toBe(json.diff(before, after));
  });

  it('the parsers, matching, similarity and the other layouts', async () => {
    const text = read('examples/datasets/enterprise-kg/before.json');
    expect(await parseGraph(text, { filename: 'before.json' })).toEqual(
      parseGraphSync(text, { filename: 'before.json' }),
    );
    expect(await parseGraph(text, { filename: 'before.json' })).toEqual(
      parsersTS.parseGraph(text, { filename: 'before.json' }),
    );
    expect(await detectFormat('@prefix ex: <http://e.x/> .')).toBe(
      detectFormatSync('@prefix ex: <http://e.x/> .'),
    );
    const iri = 'http://purl.obolibrary.org/obo/GO_0008150';
    expect(await compactIri(iri)).toBe(compactIriSync(iri));
    expect(await compactIri(iri)).toBe(parsersTS.compactIri(iri));
    expect(await textSimilarity('Ada Lovelace', 'Lovelace, Ada')).toBe(
      textSimilaritySync('Ada Lovelace', 'Lovelace, Ada'),
    );
    expect(await textSimilarity('Ada Lovelace', 'Lovelace, Ada')).toBe(
      engineTS.textSimilarity('Ada Lovelace', 'Lovelace, Ada'),
    );

    const { before, after, options } = caseOf('json-dialects-c');
    const [b, a] = [normalize(JSON.parse(before)), normalize(JSON.parse(after))];
    expect(await matchNodes(b, a, options.match)).toEqual(engineTS.matchNodes(b, a, options.match));
    expect(await matchNodes(b, a, options.match)).toEqual(matchNodesSync(b, a, options.match));

    const result = diffSync(before, after, options);
    const previous = await layoutGraph(b);
    expect(layoutText(previous)).toBe(layoutText(layoutGraphSync(b)));
    expect(layoutText(await layoutGraph(JSON.parse(before)))).toBe(layoutText(previous));
    const on = await layoutDiffOn(result, previous);
    expect(layoutText(on)).toBe(layoutText(layoutDiffOnSync(result, previous)));
    expect(layoutText(await layoutAfter(result, on))).toBe(layoutText(layoutAfterSync(result, on)));
    const focused = layoutDiffSync(result, { scope: 'changes', contextHops: 0 });
    const missing = result.nodes.map((n) => n.id).filter((n) => !focused.positions.has(n));
    expect(layoutText(await extendLayout(result, focused, missing))).toBe(
      layoutText(extendLayoutSync(result, focused, missing)),
    );
  });
});
