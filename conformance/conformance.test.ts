/**
 * The TypeScript read path against the conformance corpus (RFC 0002, §9, "Corpus ownership",
 * phase 5). The corpus is generated in Rust (`cargo xtask conformance`); TypeScript keeps only
 * what reads and presents a diff, and this checks that part against the files, starting from
 * the parsed graphs and the recorded documents rather than computing a diff:
 *
 * - `normalize` and `graphToJSON` of `parse.<side>.json`'s graph give `graph.<side>.json`, with
 *   `issues.json`'s issues, and `hashGraph` gives `hashes.json`;
 * - `diffFromJSON` then `diffToJSON` give `diff.json` back, `packDiffJSON` gives
 *   `diff.packed.json` and `unpackDiffJSON` undoes it;
 * - the diff's delta is `delta.json`, `invertDelta` gives `delta.inverse.json` and back, and
 *   `applyDelta` of it to the before graph gives `apply.json`;
 * - `formatHunk` of every hunk gives `titles.json`;
 * - the vectors of `predicateLabel`, `estimateLabelWidth`, `nodeRadius` and `facetLabel`.
 *
 * Every recorded document also validates against its JSON Schema in `packages/core/schema/`,
 * and so does the report payload: `report.json` with the packed diff it was recorded without.
 *
 * It imports only the read path (`tests/read-path.ts`, `keep`, through the packages' entries),
 * never the compute code or `@kgdiff/formats`. Whether the corpus is up to date with the Rust
 * implementation is checked by `cargo xtask conformance --check` and `cargo test`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDelta,
  type Delta,
  type DiffJSON,
  diffFromJSON,
  diffToJSON,
  type EdgeIdentity,
  type FacetKind,
  facetLabel,
  formatHunk,
  type GraphInput,
  graphToJSON,
  hashGraph,
  invertDelta,
  type Locale,
  normalize,
  type PackedDiffJSON,
  packDiffJSON,
  predicateLabel,
  unpackDiffJSON,
} from '@kgdiff/core';
import { estimateLabelWidth, nodeRadius } from '@kgdiff/layout';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(ROOT, '..');

/** Files operating systems drop into directories (Finder, Explorer): never part of the corpus. */
const OS_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

interface Manifest {
  readonly format: string;
  readonly version: number;
  readonly cases: readonly { readonly id: string }[];
  readonly primitives: readonly string[];
}

interface CaseRecord {
  readonly resolvedOptions: { readonly edgeIdentity: EdgeIdentity };
}

const readText = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readJson = <T = unknown>(path: string): T => JSON.parse(readText(path)) as T;
/** What kgdiff writes: compact JSON and a newline. */
const compact = (value: unknown): string => `${JSON.stringify(value)}\n`;

const SCHEMA_BASE = 'https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/';
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: true });
for (const file of [
  'graph.v1',
  'delta.v1',
  'diff.v1',
  'diff-packed.v1',
  'layout.v2',
  'report.v1',
]) {
  ajv.addSchema(
    JSON.parse(readFileSync(join(REPO, 'packages/core/schema', `${file}.json`), 'utf8')),
  );
}

function schemaOf(name: string) {
  const validate = ajv.getSchema(`${SCHEMA_BASE}${name}.v1.json`);
  if (!validate) throw new Error(`${name}.v1.json is not registered`);
  return validate;
}

/** The JSON Schema of each recorded document, by path below `expected/`. */
const SCHEMA_OF: Readonly<Record<string, string>> = {
  'graph.before.json': 'graph',
  'graph.after.json': 'graph',
  'apply.json': 'graph',
  'cli/apply.stdin.json': 'graph',
  'cli/apply.lenient.json': 'graph',
  'diff.json': 'diff',
  'cli/diff.pretty.json': 'diff',
  'diff.packed.json': 'diff-packed',
  'delta.json': 'delta',
  'delta.inverse.json': 'delta',
};

const manifest = readJson<Manifest>('manifest.json');
const CASE_IDS = manifest.cases.map((c) => c.id);

/** `actual` is the file's text, or the message says where they first differ. */
function expectFile(actual: string, path: string): void {
  const expected = readText(path);
  if (actual === expected) return;
  let at = 0;
  while (at < actual.length && actual[at] === expected[at]) at++;
  const clip = (s: string) => JSON.stringify(s.slice(Math.max(0, at - 60), at + 120));
  expect.fail(
    `${path} differs at character ${at}\n  computed: ${clip(actual)}\n  on disk:  ${clip(expected)}`,
  );
}

/** One case's files, read once. */
function caseFiles(id: string) {
  const file = (name: string) => `cases/${id}/${name}`;
  const record = readJson<CaseRecord>(file('case.json'));
  const parsed = (side: 'before' | 'after') =>
    readJson<{ graph: GraphInput }>(file(`expected/parse.${side}.json`)).graph;
  const diffText = readText(file('expected/diff.json'));
  return {
    file,
    edgeIdentity: record.resolvedOptions.edgeIdentity,
    parsed,
    diffJson: JSON.parse(diffText) as DiffJSON,
    delta: readJson<Delta>(file('expected/delta.json')),
  };
}

describe('the TypeScript read path against the conformance corpus', () => {
  it('reads a version 1 corpus with one directory per case', () => {
    expect(manifest.format).toBe('kgdiff.conformance');
    expect(manifest.version).toBe(1);
    const dirs = readdirSync(join(ROOT, 'cases'))
      .filter((name) => !OS_FILES.has(name))
      .sort();
    expect(dirs).toEqual([...CASE_IDS].sort());
    for (const vector of manifest.primitives) expect(existsSync(join(ROOT, vector))).toBe(true);
  });

  describe.each(CASE_IDS)('case %s', (id) => {
    const c = caseFiles(id);

    it('normalize and graphToJSON give the graphs, their issues and their hashes', () => {
      const graphs = {
        before: normalize(c.parsed('before'), { edgeIdentity: c.edgeIdentity }),
        after: normalize(c.parsed('after'), { edgeIdentity: c.edgeIdentity }),
      };
      expectFile(compact(graphToJSON(graphs.before)), c.file('expected/graph.before.json'));
      expectFile(compact(graphToJSON(graphs.after)), c.file('expected/graph.after.json'));
      expect({ before: graphs.before.issues, after: graphs.after.issues }).toEqual(
        readJson(c.file('expected/issues.json')),
      );
      expect({ before: hashGraph(graphs.before), after: hashGraph(graphs.after) }).toEqual(
        readJson(c.file('expected/hashes.json')),
      );
    });

    it('diffFromJSON and diffToJSON give the diff back; packDiffJSON packs it', () => {
      const diffPath = c.file('expected/diff.json');
      const packedPath = c.file('expected/diff.packed.json');
      expectFile(compact(diffToJSON(diffFromJSON(c.diffJson))), diffPath);
      expectFile(compact(packDiffJSON(c.diffJson)), packedPath);
      const packed = readJson<PackedDiffJSON>(packedPath);
      expectFile(compact(unpackDiffJSON(packed)), diffPath);
      expectFile(compact(diffToJSON(diffFromJSON(unpackDiffJSON(packed)))), diffPath);
    });

    it('the delta, its inverse and applyDelta', () => {
      const deltaPath = c.file('expected/delta.json');
      const inversePath = c.file('expected/delta.inverse.json');
      expectFile(compact(diffFromJSON(c.diffJson).delta), deltaPath);
      const inverse = invertDelta(c.delta);
      expectFile(compact(inverse), inversePath);
      expectFile(compact(invertDelta(inverse)), deltaPath);
      // `kgdiff apply <before> expected/delta.json`: kgdiff JSON without `meta.source`.
      const before = normalize(c.parsed('before'), { edgeIdentity: c.delta.edgeIdentity });
      const applied: { meta?: Record<string, unknown> } = graphToJSON(applyDelta(before, c.delta));
      if (applied.meta) {
        const { source: _, ...meta } = applied.meta;
        if (Object.keys(meta).length > 0) applied.meta = meta;
        else delete applied.meta;
      }
      expectFile(compact(applied), c.file('expected/apply.json'));
      // And the inverse takes the after graph back to the before graph.
      const after = normalize(c.parsed('after'), { edgeIdentity: c.delta.edgeIdentity });
      expect(hashGraph(applyDelta(after, inverse))).toBe(
        readJson<{ before: string }>(c.file('expected/hashes.json')).before,
      );
    });

    it('formatHunk gives the titles', () => {
      const result = diffFromJSON(c.diffJson);
      const titles: Record<string, unknown[]> = {};
      for (const locale of ['en', 'zh-CN'] as const) {
        titles[locale] = result.hunks.map((hunk) => ({
          id: hunk.id,
          ...formatHunk(hunk, result, locale),
        }));
      }
      expect(titles).toEqual(readJson(c.file('expected/titles.json')));
    });

    it('its documents validate against their schemas', () => {
      const errors: string[] = [];
      for (const [file, schema] of Object.entries(SCHEMA_OF)) {
        const path = c.file(`expected/${file}`);
        if (!existsSync(join(ROOT, path))) continue;
        const validate = schemaOf(schema);
        if (!validate(readJson(path))) errors.push(`${file}: ${ajv.errorsText(validate.errors)}`);
      }
      // `report.json` is the payload without its diff and layout: with the packed diff put back
      // it is a report without a layout, which `report.v1.json` describes too.
      const validate = schemaOf('report');
      const report = readJson<object>(c.file('expected/report.json'));
      if (!validate({ ...report, diff: readJson(c.file('expected/diff.packed.json')) })) {
        errors.push(`report.json: ${ajv.errorsText(validate.errors)}`);
      }
      expect(errors).toEqual([]);
    });
  });

  describe('primitive vectors', () => {
    it('predicateLabel', () => {
      const { pairs } = readJson<{ pairs: [string, string][] }>('primitives/predicate-label.json');
      expect(pairs.length).toBeGreaterThan(0);
      for (const [predicate, label] of pairs)
        expect([predicate, predicateLabel(predicate)]).toEqual([predicate, label]);
    });

    it('estimateLabelWidth and nodeRadius', () => {
      const vector = readJson<{
        labelWidth: [string, number, number][];
        nodeRadius: [number, number][];
      }>('primitives/label-width.json');
      expect(vector.labelWidth.length).toBeGreaterThan(0);
      for (const [text, size, width] of vector.labelWidth) {
        expect([text, size, estimateLabelWidth(text, size)]).toEqual([text, size, width]);
      }
      for (const [degree, radius] of vector.nodeRadius) {
        expect([degree, nodeRadius(degree)]).toEqual([degree, radius]);
      }
    });

    it('facetLabel', () => {
      const { labels } = readJson<{ labels: Record<Locale, Record<FacetKind, string>> }>(
        'primitives/facet-labels.json',
      );
      for (const locale of ['en', 'zh-CN'] as const) {
        const kinds = Object.keys(labels[locale]) as FacetKind[];
        expect(kinds.length).toBeGreaterThan(0);
        for (const kind of kinds) {
          expect([kind, facetLabel(kind, locale)]).toEqual([kind, labels[locale][kind]]);
        }
      }
    });
  });
});
