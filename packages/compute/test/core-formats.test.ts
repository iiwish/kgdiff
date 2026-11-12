/**
 * `@kgdiff/core` has, since 0.11.1, everything `@kgdiff/formats` (deprecated) exports, so moving
 * off formats means changing only the import path:
 *
 * - the same names, the same types and the same `FORMAT_EXTENSIONS` object (defined by core,
 *   re-exported by compute and formats), and no WebAssembly in core: its entry loads
 *   `@kgdiff/compute` with a dynamic `import()` only;
 * - `parseGraph`, `detectFormat` and `compactIri` give, byte for byte, what formats' give, on
 *   every file of the example datasets and every input of the conformance corpus, errors included.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Core from '@kgdiff/core';
import * as core from '@kgdiff/core';
import type * as Formats from '@kgdiff/formats';
import * as formats from '@kgdiff/formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
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
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify({ result: await run() });
  } catch (error) {
    const { name, message } = error as Error;
    return JSON.stringify({ error: { name, code: (error as { code?: unknown }).code, message } });
  }
}

describe('@kgdiff/core has what @kgdiff/formats exports', () => {
  it('every name, with the same types and the same FORMAT_EXTENSIONS', () => {
    const coreNames = new Set(Object.keys(core));
    expect(Object.keys(formats).filter((name) => !coreNames.has(name))).toEqual([]);
    expect(core.FORMAT_EXTENSIONS).toBe(formats.FORMAT_EXTENSIONS);
    expect(core.FORMAT_EXTENSIONS).toBe(compute.FORMAT_EXTENSIONS);

    expectTypeOf<Core.FormatId>().toEqualTypeOf<Formats.FormatId>();
    expectTypeOf<Core.JsonDialect>().toEqualTypeOf<Formats.JsonDialect>();
    expectTypeOf<Core.ParseWarningCode>().toEqualTypeOf<Formats.ParseWarningCode>();
    expectTypeOf<Core.RdfOptions>().toEqualTypeOf<Formats.RdfOptions>();
    expectTypeOf<Core.JsonOptions>().toEqualTypeOf<Formats.JsonOptions>();
    expectTypeOf<Core.JsonLdOptions>().toEqualTypeOf<Formats.JsonLdOptions>();
    expectTypeOf<Core.ParseOptions>().toEqualTypeOf<Formats.ParseOptions>();
    expectTypeOf<Core.ParseWarning>().toEqualTypeOf<Formats.ParseWarning>();
    expectTypeOf<Core.ParseResult>().toEqualTypeOf<Formats.ParseResult>();
    expectTypeOf(core.FORMAT_EXTENSIONS).toEqualTypeOf(formats.FORMAT_EXTENSIONS);
    expectTypeOf(core.parseGraph).toEqualTypeOf(formats.parseGraph);
    expectTypeOf(core.detectFormat).toEqualTypeOf(formats.detectFormat);
    expectTypeOf(core.compactIri).toEqualTypeOf(formats.compactIri);
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
          await outcome(() => formats.parseGraph(text, opts)),
        );
      }
      expect(await outcome(() => core.detectFormat(text, filename))).toBe(
        await outcome(() => formats.detectFormat(text, filename)),
      );
      expect(await outcome(() => core.detectFormat(text))).toBe(
        await outcome(() => formats.detectFormat(text)),
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
        expect(await core.compactIri(iri)).toBe(await formats.compactIri(iri));
        expect(await core.compactIri(iri, prefixes)).toBe(await formats.compactIri(iri, prefixes));
      }
      for (const [text, filename] of [
        ['<Ontology xmlns="http://www.w3.org/2002/07/owl#"/>', 'a.owl'],
        ['not a graph', undefined],
        ['{ "nodes": [', 'a.json'],
      ] as const) {
        const failure = await outcome(() => core.parseGraph(text, { filename }));
        expect(failure).toContain('"error"');
        expect(failure).toBe(await outcome(() => formats.parseGraph(text, { filename })));
        expect(await outcome(() => core.detectFormat(text, filename))).toBe(
          await outcome(() => formats.detectFormat(text, filename)),
        );
      }
    });
  });
});
