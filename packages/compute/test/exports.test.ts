/**
 * The parsers' types and `FORMAT_EXTENSIONS` are exported by this package since 0.11.1 (the
 * declarations of `@kgdiff/core`, which `core-formats.test.ts` compares with formats):
 *
 * - `@kgdiff/formats` (deprecated) re-exports exactly what it exported in 0.11.0, with the same
 *   types, and `FORMAT_EXTENSIONS` is this package's object;
 * - `types/compute-stub.d.ts`, which the workspace's type-checks see as `@kgdiff/compute`,
 *   declares what this package exports (type-level: `pnpm typecheck` compiles this file).
 */
import type * as Formats from '@kgdiff/formats';
import * as formats from '@kgdiff/formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as Stub from '../../../types/compute-stub.js';
import type * as Compute from '../src/index.js';
import * as compute from '../src/index.js';

describe('the parsers’ types and FORMAT_EXTENSIONS', () => {
  it('@kgdiff/formats re-exports them, and its functions are the same as 0.11.0', () => {
    expect(Object.keys(formats).sort()).toEqual([
      'FORMAT_EXTENSIONS',
      'compactIri',
      'detectFormat',
      'parseGraph',
    ]);
    expect(formats.FORMAT_EXTENSIONS).toBe(compute.FORMAT_EXTENSIONS);
    expect(compute.FORMAT_EXTENSIONS.rdfxml).toEqual(['.rdf', '.owl']);

    expectTypeOf<Formats.FormatId>().toEqualTypeOf<Compute.FormatId>();
    expectTypeOf<Formats.JsonDialect>().toEqualTypeOf<Compute.JsonDialect>();
    expectTypeOf<Formats.ParseWarningCode>().toEqualTypeOf<Compute.ParseWarningCode>();
    expectTypeOf<Formats.RdfOptions>().toEqualTypeOf<Compute.RdfOptions>();
    expectTypeOf<Formats.JsonOptions>().toEqualTypeOf<Compute.JsonOptions>();
    expectTypeOf<Formats.JsonLdOptions>().toEqualTypeOf<Compute.JsonLdOptions>();
    expectTypeOf<Formats.ParseOptions>().toEqualTypeOf<Compute.ParseOptions>();
    expectTypeOf<Formats.ParseWarning>().toEqualTypeOf<Compute.ParseWarning>();
    expectTypeOf<Formats.ParseResult>().toEqualTypeOf<Compute.ParseResult>();
    expectTypeOf(formats.FORMAT_EXTENSIONS).toEqualTypeOf(compute.FORMAT_EXTENSIONS);
    expectTypeOf(formats.parseGraph).parameters.toEqualTypeOf<
      [text: string, options?: Compute.ParseOptions]
    >();
    expectTypeOf(formats.parseGraph).returns.toEqualTypeOf<Promise<Compute.ParseResult>>();
    expectTypeOf(formats.detectFormat).toEqualTypeOf<
      (text: string, filename?: string) => Promise<Compute.FormatId>
    >();
    expectTypeOf(formats.compactIri).toEqualTypeOf<
      (iri: string, prefixes?: Readonly<Record<string, string>>) => Promise<string>
    >();
  });

  it('types/compute-stub.d.ts declares what this package exports', () => {
    expectTypeOf<Stub.FormatId>().toEqualTypeOf<Compute.FormatId>();
    expectTypeOf<Stub.ParseOptions>().toEqualTypeOf<Compute.ParseOptions>();
    expectTypeOf<Stub.ParseResult>().toEqualTypeOf<Compute.ParseResult>();
    expectTypeOf<typeof Stub.FORMAT_EXTENSIONS>().toEqualTypeOf<typeof Compute.FORMAT_EXTENSIONS>();
    expectTypeOf<typeof Stub.parseGraph>().toEqualTypeOf<typeof Compute.parseGraph>();
    expectTypeOf<typeof Stub.detectFormat>().toEqualTypeOf<typeof Compute.detectFormat>();
    expectTypeOf<typeof Stub.compactIri>().toEqualTypeOf<typeof Compute.compactIri>();
  });
});
