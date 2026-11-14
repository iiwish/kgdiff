/**
 * `@kgdiff/core` exports the parsers' functions and types, and `@kgdiff/compute` runs them:
 *
 * - the same names, the same types and the same `FORMAT_EXTENSIONS` object (defined by core,
 *   re-exported by compute), and no WebAssembly in core: its entry loads `@kgdiff/compute` with a
 *   dynamic `import()` only;
 * - `parseGraph`, `detectFormat` and `compactIri` of core give, byte for byte, what the `*Sync`
 *   functions of compute give, on every file of the example datasets and every input of the
 *   conformance corpus, errors included.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Core from '@kgdiff/core';
import * as core from '@kgdiff/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as Compute from '../src/index.js';
import * as compute from '../src/index.js';
import { enabled } from './support.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The graph files of a directory tree: every `before.*` and `after.*` that is not a document. */
function inputs(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .map((f) => f.split('\\').join('/'))
    .filter((f) => /^(before|after)\.[a-z]+$/.test(basename(f)))
    .filter((f) => !f.split('/').includes('expected'))
    .map((f) => `${dir}/${f}`)
    .sort();
}

const FILES = [...inputs('examples/datasets'), ...inputs('conformance/cases')];

/** What a call gives, as text: its result, or the error it throws (name, code and message). */
async function outcome(run: () => unknown): Promise<string> {
  try {
    return JSON.stringify({ result: await run() });
  } catch (error) {
    const { name, message } = error as Error;
    return JSON.stringify({ error: { name, code: (error as { code?: unknown }).code, message } });
  }
}

describe('@kgdiff/core and @kgdiff/compute export the parsers', () => {
  it('every name, with the same types and the same FORMAT_EXTENSIONS', () => {
    const coreNames = new Set(Object.keys(core));
    for (const name of ['FORMAT_EXTENSIONS', 'compactIri', 'detectFormat', 'parseGraph']) {
      expect(coreNames.has(name)).toBe(true);
    }
    expect(core.FORMAT_EXTENSIONS).toBe(compute.FORMAT_EXTENSIONS);

    expectTypeOf<Core.FormatId>().toEqualTypeOf<Compute.FormatId>();
    expectTypeOf<Core.JsonDialect>().toEqualTypeOf<Compute.JsonDialect>();
    expectTypeOf<Core.ParseWarningCode>().toEqualTypeOf<Compute.ParseWarningCode>();
    expectTypeOf<Core.RdfOptions>().toEqualTypeOf<Compute.RdfOptions>();
    expectTypeOf<Core.JsonOptions>().toEqualTypeOf<Compute.JsonOptions>();
    expectTypeOf<Core.JsonLdOptions>().toEqualTypeOf<Compute.JsonLdOptions>();
    expectTypeOf<Core.ParseOptions>().toEqualTypeOf<Compute.ParseOptions>();
    expectTypeOf<Core.ParseWarning>().toEqualTypeOf<Compute.ParseWarning>();
    expectTypeOf<Core.ParseResult>().toEqualTypeOf<Compute.ParseResult>();
    expectTypeOf(core.FORMAT_EXTENSIONS).toEqualTypeOf(compute.FORMAT_EXTENSIONS);
    expectTypeOf(core.parseGraph).toEqualTypeOf(compute.parseGraph);
    expectTypeOf(core.detectFormat).toEqualTypeOf(compute.detectFormat);
    expectTypeOf(core.compactIri).toEqualTypeOf(compute.compactIri);
  });

  it('core loads no WebAssembly itself: its entry imports @kgdiff/compute dynamically only', () => {
    const source = readFileSync(join(ROOT, 'packages/core/src/index.ts'), 'utf8');
    expect(source).not.toMatch(/^(?:import|export)\b[^;]*from\s+'@kgdiff\/compute[^']*';/m);
    expect(source).toMatch(/import\('@kgdiff\/compute'\)/);
    const formatsSource = readFileSync(join(ROOT, 'packages/core/src/formats.ts'), 'utf8');
    expect(formatsSource).not.toMatch(/from\s+'(?!\.\/types\.js')/);
  });

  describe.runIf(enabled)('the same results, byte for byte', () => {
    it('finds the example datasets and the corpus', () => {
      expect(FILES.filter((f) => f.startsWith('examples/')).length).toBeGreaterThanOrEqual(12);
      expect(FILES.length).toBeGreaterThan(50);
    });

    it.each(FILES)('%s', async (file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const filename = basename(file);
      for (const options of [{ filename }, {}, { filename, rdf: { compactWith: 'declared' } }]) {
        const opts = options as Core.ParseOptions;
        expect(await outcome(() => core.parseGraph(text, opts))).toBe(
          await outcome(() => compute.parseGraphSync(text, opts)),
        );
      }
      expect(await outcome(() => core.detectFormat(text, filename))).toBe(
        await outcome(() => compute.detectFormatSync(text, filename)),
      );
      expect(await outcome(() => core.detectFormat(text))).toBe(
        await outcome(() => compute.detectFormatSync(text)),
      );
    });

    it('compactIri, and the errors of unreadable text', async () => {
      const prefixes = { go: 'http://purl.obolibrary.org/obo/GO_', ex: 'http://e.x/' };
      for (const iri of [
        'http://purl.obolibrary.org/obo/GO_0008150',
        'http://www.w3.org/2000/01/rdf-schema#label',
        'http://e.x/a',
        'urn:x',
        '',
      ]) {
        expect(await core.compactIri(iri)).toBe(await compute.compactIriSync(iri));
        expect(await core.compactIri(iri, prefixes)).toBe(
          await compute.compactIriSync(iri, prefixes),
        );
      }
      for (const [text, filename] of [
        ['<Ontology xmlns="http://www.w3.org/2002/07/owl#"/>', 'a.owl'],
        ['not a graph', undefined],
        ['{ "nodes": [', 'a.json'],
      ] as const) {
        const failure = await outcome(() => core.parseGraph(text, { filename }));
        expect(failure).toContain('"error"');
        expect(failure).toBe(await outcome(() => compute.parseGraphSync(text, { filename })));
        expect(await outcome(() => core.detectFormat(text, filename))).toBe(
          await outcome(() => compute.detectFormatSync(text, filename)),
        );
      }
    });
  });
});
