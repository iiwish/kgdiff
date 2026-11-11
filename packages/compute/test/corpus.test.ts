/**
 * The WebAssembly build against the conformance corpus (RFC 0002, §8, the `compute` job), in Node:
 *
 * - the parse results of every input (`formats`);
 * - every library output of every case (README, "Library outputs") and the primitive vectors of
 *   the core (`compute`; the read path, which stays TypeScript in the browser, through the corpus
 *   build);
 * - the layouts of every case, byte for byte the native ones (`kgdiff-layout`'s `corpus_hashes`):
 *   through `layout.wasm` and through `compute`; `primitives/label-width.json`.
 *
 * `crates/*\/tests/conformance` check the same parts natively.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type DiffOptions, type DiffResult, diffFromJSON, normalize } from '@kgdiff/core';
import { type FormatId, parseGraph as parseGraphTS } from '@kgdiff/formats';
import { type LayoutOptions, type LayoutResult, layoutToJSON } from '@kgdiff/layout';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeInput } from '../../../conformance/inputs.js';
import {
  estimateLabelWidthSync,
  extendLayoutSync,
  init,
  json,
  layoutAfterSync,
  layoutDiffOnSync,
  layoutDiffSync,
  layoutGraphSync,
  nodeRadiusSync,
  parseGraphSync,
  textSimilaritySync,
} from '../src/index.js';
import { type CorpusBuild, corpusBuild, enabled, nativeLayouts } from './support.js';

const CORPUS = fileURLToPath(new URL('../../../conformance/', import.meta.url));

function read(path: string): string {
  return readFileSync(`${CORPUS}${path}`, 'utf8');
}

function readJSON<T = unknown>(path: string): T {
  return JSON.parse(read(path)) as T;
}

const manifest = readJSON<{ cases: { id: string }[] }>('manifest.json');

interface ParseSpec {
  readonly format: FormatId | 'auto';
  readonly filename: string;
  readonly languages?: readonly string[];
  readonly allowEmpty: boolean;
}

interface CaseSpec {
  readonly inputs: Record<'before' | 'after', string>;
  readonly parse: Record<'before' | 'after', ParseSpec>;
  readonly options?: DiffOptions;
  readonly layoutOptions?: LayoutOptions;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const layoutText = (layout: LayoutResult) => JSON.stringify(layoutToJSON(layout));

/** The nodes `corpus_hashes` expands a changes-only layout with: the hidden neighbours. */
function hiddenNeighbours(diff: DiffResult, focused: LayoutResult): string[] {
  const expand: string[] = [];
  for (const id of focused.hidden.keys()) {
    for (const e of diff.index.edgesOf(id)) {
      for (const v of [e.source, e.target]) {
        if (!focused.positions.has(v) && !expand.includes(v)) expand.push(v);
      }
    }
  }
  return expand;
}

describe.runIf(enabled)('the WebAssembly build reproduces the corpus', () => {
  let corpus: CorpusBuild;
  let native: Map<string, string>;
  beforeAll(async () => {
    await init();
    corpus = await corpusBuild();
    native = await nativeLayouts();
  });

  describe.each(manifest.cases.map((c) => c.id))('%s', (id) => {
    const dir = `cases/${id}/`;
    const spec = readJSON<CaseSpec>(`${dir}case.json`);
    const options = spec.options ?? {};
    const graph = (side: string) =>
      JSON.stringify(readJSON<{ graph: unknown }>(`${dir}expected/parse.${side}.json`).graph);
    const [before, after] = [graph('before'), graph('after')];
    const normalizeOptions = { edgeIdentity: options.edgeIdentity ?? 'structure' };
    const expected = (file: string) => read(`${dir}expected/${file}`);
    const line = (text: string) => `${text}\n`;
    let diff = '';
    let result: DiffResult;

    beforeAll(() => {
      diff = json.diff(before, after, options);
      result = diffFromJSON(JSON.parse(diff));
    });

    it.each(['before', 'after'] as const)('parse.%s.json', (side) => {
      const input = readFileSync(`${CORPUS}${dir}${spec.inputs[side]}`);
      const { format, filename, languages, allowEmpty } = spec.parse[side];
      const text = decodeInput(input);
      const parseOptions = {
        format,
        filename,
        ...(languages ? { rdf: { languages } } : {}),
      };
      const parsed =
        allowEmpty && text.trim() === ''
          ? json.parseGraph('{"nodes":[],"edges":[]}', { ...parseOptions, format: 'json' })
          : json.parseGraph(text, parseOptions);
      // The corpus writes parse results indented; the engine's text, reindented, is that file.
      expect(line(JSON.stringify(JSON.parse(parsed), null, 2))).toBe(
        expected(`parse.${side}.json`),
      );
    });

    it('graph.before.json and graph.after.json', () => {
      expect(line(json.normalize(before, normalizeOptions))).toBe(expected('graph.before.json'));
      expect(line(json.normalize(after, normalizeOptions))).toBe(expected('graph.after.json'));
    });

    it('issues.json and hashes.json', () => {
      expect({
        before: JSON.parse(json.issues(before, normalizeOptions)),
        after: JSON.parse(json.issues(after, normalizeOptions)),
      }).toEqual(JSON.parse(expected('issues.json')));
      expect({
        before: json.hashGraph(before, normalizeOptions),
        after: json.hashGraph(after, normalizeOptions),
      }).toEqual(JSON.parse(expected('hashes.json')));
    });

    it('diff.json, read back by diffFromJSON', () => {
      expect(line(diff)).toBe(expected('diff.json'));
      expect(corpus.readDiffJSON(diff)).toBe(diff);
    });

    it('titles.json', () => {
      expect({
        en: JSON.parse(corpus.hunkTitlesJSON(diff, 'en')),
        'zh-CN': JSON.parse(corpus.hunkTitlesJSON(diff, 'zh-CN')),
      }).toEqual(JSON.parse(expected('titles.json')));
    });

    it('diff.packed.json, unpacked', () => {
      const packed = corpus.packDiffJSON(diff);
      expect(line(packed)).toBe(expected('diff.packed.json'));
      expect(corpus.unpackDiffJSON(packed)).toBe(diff);
    });

    it('delta.json and delta.inverse.json', () => {
      expect(line(corpus.deltaOfDiffJSON(diff))).toBe(expected('delta.json'));
      expect(line(corpus.invertDeltaJSON(expected('delta.json')))).toBe(
        expected('delta.inverse.json'),
      );
    });

    it('apply.json', () => {
      // `kgdiff apply <before> expected/delta.json`, written without `meta.source`.
      const { graph: applied } = JSON.parse(
        corpus.applyDeltaJSON(before, expected('delta.json'), '{"strict":true}'),
      ) as { graph: { meta?: Record<string, unknown> } };
      if (applied.meta) {
        delete applied.meta.source;
        if (Object.keys(applied.meta).length === 0) delete applied.meta;
      }
      expect(line(JSON.stringify(applied))).toBe(expected('apply.json'));
    });

    it('the layouts, byte for byte the native ones', () => {
      const given = spec.layoutOptions ?? {};
      // Computed from the graphs, as `corpus_hashes` does.
      const { layout: computed } = JSON.parse(json.diffLayout(before, after, options, given)) as {
        layout: unknown;
      };
      expect(sha256(JSON.stringify(computed))).toBe(native.get(id));

      // From the diff read back, through layout.wasm and through the corpus build's Rust reader.
      const layout = layoutDiffSync(result, given);
      expect(json.layoutDiff(diff, given)).toBe(layoutText(layout));
      expect(corpus.layoutDiffJSON(diff, JSON.stringify(given))).toBe(layoutText(layout));
      const focused = layoutDiffSync(result, { scope: 'changes' });
      const expand = hiddenNeighbours(result, focused);
      const grown = extendLayoutSync(result, focused, expand);
      expect(corpus.extendLayoutJSON(diff, layoutText(focused), JSON.stringify(expand), '')).toBe(
        layoutText(grown),
      );
      // A `kgdiff.diff` document carries no node `position`, so a diff read back lays out like
      // the computed one only when its graphs have none (all cases but json-dialects-c).
      if (layoutText(layout) === JSON.stringify(computed)) {
        expect(sha256(layoutText(focused))).toBe(native.get(`${id}/changes`));
        expect(sha256(layoutText(grown))).toBe(native.get(`${id}/extended`));
      } else {
        expect(id).toBe('json-dialects-c');
      }
    });

    it('the layouts of each version and of the diff on their map, as compute.wasm has them', () => {
      const previous = layoutGraphSync(normalize(JSON.parse(before), normalizeOptions));
      expect(layoutText(previous)).toBe(json.layoutGraph(before, undefined, normalizeOptions));
      const own = layoutGraphSync(JSON.parse(after));
      expect(layoutText(own)).toBe(json.layoutGraph(after));
      const on = layoutDiffOnSync(result, previous);
      expect(layoutText(on)).toBe(corpus.layoutDiffOnJSON(diff, layoutText(previous), ''));
      const next = layoutAfterSync(result, on);
      expect(layoutText(next)).toBe(corpus.layoutAfterJSON(diff, layoutText(on), ''));
    });
  });

  it('the other inputs of the parsers give what @kgdiff/formats gives', () => {
    for (const [text, options] of [
      ['@prefix ex: <http://e.x/> . ex:a ex:p ex:b .', { format: 'turtle' as const }],
      ['{"@context":{"@vocab":"http://e.x/"},"@id":"http://e.x/a","p":{"@id":"http://e.x/b"}}', {}],
    ] as const) {
      expect(parseGraphSync(text, options)).toEqual(
        JSON.parse(JSON.stringify(parseGraphTS(text, options))),
      );
    }
  });

  it('primitives/text-similarity.json', () => {
    const { pairs } = readJSON<{ pairs: [string, string, number][] }>(
      'primitives/text-similarity.json',
    );
    for (const [a, b, similarity] of pairs) {
      expect([a, b, textSimilaritySync(a, b)]).toEqual([a, b, similarity]);
    }
  });

  it('primitives/label-width.json', () => {
    const { labelWidth, nodeRadius } = readJSON<{
      labelWidth: [string, number, number][];
      nodeRadius: [number, number][];
    }>('primitives/label-width.json');
    for (const [text, size, width] of labelWidth) {
      expect([text, size, estimateLabelWidthSync(text, size)]).toEqual([text, size, width]);
    }
    for (const [degree, radius] of nodeRadius) {
      expect([degree, nodeRadiusSync(degree)]).toEqual([degree, radius]);
    }
  });

  it('primitives/predicate-label.json', () => {
    const { pairs } = readJSON<{ pairs: [string, string][] }>('primitives/predicate-label.json');
    for (const [predicate, label] of pairs) {
      expect([predicate, corpus.predicateLabel(predicate)]).toEqual([predicate, label]);
    }
  });

  it('primitives/json-roundtrip.json and number-to-string.json', () => {
    const { entries } = readJSON<{
      entries: { text: string; stringify: string | null; pretty: string | null }[];
    }>('primitives/json-roundtrip.json');
    const attempt = (run: () => string): string | null => {
      try {
        return run();
      } catch {
        return null;
      }
    };
    for (const { text, stringify, pretty } of entries) {
      expect([text, attempt(() => corpus.reformatJSON(text, false))]).toEqual([text, stringify]);
      expect([text, attempt(() => corpus.reformatJSON(text, true))]).toEqual([text, pretty]);
    }
    // Number → JSON text, through ryu-js's `small` tables (crates/kgdiff-wasm/Cargo.toml).
    const { entries: numbers } = readJSON<{ entries: { bits: string; json: string }[] }>(
      'primitives/number-to-string.json',
    );
    for (const { bits, json: text } of numbers) {
      if (text === 'null') continue;
      expect([bits, corpus.reformatJSON(`[${text}]`, false)]).toEqual([bits, `[${text}]`]);
    }
  });

  it('primitives/facet-labels.json', () => {
    const { labels } = readJSON<{ labels: Record<'en' | 'zh-CN', Record<string, string>> }>(
      'primitives/facet-labels.json',
    );
    for (const locale of ['en', 'zh-CN'] as const) {
      for (const [kind, label] of Object.entries(labels[locale])) {
        expect([kind, corpus.facetLabel(kind, locale)]).toEqual([kind, label]);
      }
    }
  });

  it('covers every case of the native layout hashes', () => {
    expect(existsSync(fileURLToPath(new URL('wasm/native-layouts.txt', import.meta.url)))).toBe(
      true,
    );
    for (const { id } of manifest.cases) expect(native.has(id)).toBe(true);
  });
});
