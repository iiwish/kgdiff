/**
 * The WebAssembly build against the conformance corpus (RFC 0002, §8, the `compute` job): every
 * library output of every case (README, "Library outputs") and the primitive vectors of the core,
 * computed in Node by the engine, equal to the files. `crates/kgdiff-core/tests/conformance` checks
 * the same parts natively.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DiffOptions } from '@kgdiff/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { diffJSON, init, json, textSimilaritySync } from '../src/index.js';
import { enabled } from './support.js';

const CORPUS = fileURLToPath(new URL('../../../conformance/', import.meta.url));

function read(path: string): string {
  return readFileSync(`${CORPUS}${path}`, 'utf8');
}

function readJSON<T = unknown>(path: string): T {
  return JSON.parse(read(path)) as T;
}

const manifest = readJSON<{ cases: { id: string }[] }>('manifest.json');

interface CaseSpec {
  readonly options?: DiffOptions;
}

describe.runIf(enabled)('the WebAssembly build reproduces the corpus', () => {
  beforeAll(() => init());

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

    beforeAll(() => {
      diff = diffJSON(before, after, options);
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
      expect(json.readDiff(diff)).toBe(diff);
    });

    it('titles.json', () => {
      expect({
        en: JSON.parse(json.hunkTitles(diff, 'en')),
        'zh-CN': JSON.parse(json.hunkTitles(diff, 'zh-CN')),
      }).toEqual(JSON.parse(expected('titles.json')));
    });

    it('diff.packed.json, unpacked', () => {
      const packed = json.packDiff(diff);
      expect(line(packed)).toBe(expected('diff.packed.json'));
      expect(json.unpackDiff(packed)).toBe(diff);
    });

    it('delta.json and delta.inverse.json', () => {
      expect(line(json.deltaOfDiff(diff))).toBe(expected('delta.json'));
      expect(line(json.invertDelta(expected('delta.json')))).toBe(expected('delta.inverse.json'));
    });

    it('apply.json', () => {
      // `kgdiff apply <before> expected/delta.json`, written without `meta.source`.
      const { graph: applied } = JSON.parse(
        json.applyDelta(before, expected('delta.json'), { strict: true }),
      ) as { graph: { meta?: Record<string, unknown> } };
      if (applied.meta) {
        delete applied.meta.source;
        if (Object.keys(applied.meta).length === 0) delete applied.meta;
      }
      expect(line(JSON.stringify(applied))).toBe(expected('apply.json'));
    });
  });

  it('primitives/text-similarity.json', () => {
    const { pairs } = readJSON<{ pairs: [string, string, number][] }>(
      'primitives/text-similarity.json',
    );
    for (const [a, b, similarity] of pairs) {
      expect([a, b, textSimilaritySync(a, b)]).toEqual([a, b, similarity]);
    }
  });

  it('primitives/predicate-label.json', () => {
    const { pairs } = readJSON<{ pairs: [string, string][] }>('primitives/predicate-label.json');
    for (const [predicate, label] of pairs) {
      expect([predicate, json.predicateLabel(predicate)]).toEqual([predicate, label]);
    }
  });

  it('primitives/json-roundtrip.json', () => {
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
      expect([text, attempt(() => json.reformat(text))]).toEqual([text, stringify]);
      expect([text, attempt(() => json.reformat(text, true))]).toEqual([text, pretty]);
    }
  });

  it('primitives/facet-labels.json', () => {
    const { labels } = readJSON<{ labels: Record<'en' | 'zh-CN', Record<string, string>> }>(
      'primitives/facet-labels.json',
    );
    for (const locale of ['en', 'zh-CN'] as const) {
      for (const [kind, label] of Object.entries(labels[locale])) {
        expect([kind, json.facetLabel(kind, locale)]).toEqual([kind, label]);
      }
    }
  });
});
