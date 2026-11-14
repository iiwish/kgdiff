/**
 * The parsers' types and `FORMAT_EXTENSIONS` are exported by this package since 0.11.1 (the
 * declarations of `@kgdiff/core`, which `core-formats.test.ts` compares with the `*Sync` functions):
 *
 * - the types are `@kgdiff/core`'s, and `FORMAT_EXTENSIONS` is its object;
 * - `types/compute-stub.d.ts`, which the workspace's type-checks see as `@kgdiff/compute`,
 *   declares what this package exports (type-level: `pnpm typecheck` compiles this file).
 */
import type * as Core from '@kgdiff/core';
import * as core from '@kgdiff/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as Stub from '../../../types/compute-stub.js';
import type * as Compute from '../src/index.js';
import * as compute from '../src/index.js';

describe('the parsers’ types and FORMAT_EXTENSIONS', () => {
  it('this package exports them, with the declarations of @kgdiff/core', () => {
    expect(compute.FORMAT_EXTENSIONS).toBe(core.FORMAT_EXTENSIONS);
    expect(compute.FORMAT_EXTENSIONS.rdfxml).toEqual(['.rdf', '.owl']);

    expectTypeOf<Core.FormatId>().toEqualTypeOf<Compute.FormatId>();
    expectTypeOf<Core.JsonDialect>().toEqualTypeOf<Compute.JsonDialect>();
    expectTypeOf<Core.ParseWarningCode>().toEqualTypeOf<Compute.ParseWarningCode>();
    expectTypeOf<Core.RdfOptions>().toEqualTypeOf<Compute.RdfOptions>();
    expectTypeOf<Core.JsonOptions>().toEqualTypeOf<Compute.JsonOptions>();
    expectTypeOf<Core.JsonLdOptions>().toEqualTypeOf<Compute.JsonLdOptions>();
    expectTypeOf<Core.ParseOptions>().toEqualTypeOf<Compute.ParseOptions>();
    expectTypeOf<Core.ParseWarning>().toEqualTypeOf<Compute.ParseWarning>();
    expectTypeOf<Core.ParseResult>().toEqualTypeOf<Compute.ParseResult>();
    expectTypeOf(compute.FORMAT_EXTENSIONS).toEqualTypeOf(core.FORMAT_EXTENSIONS);
    expectTypeOf(compute.parseGraph).parameters.toEqualTypeOf<
      [text: string, options?: Compute.ParseOptions]
    >();
    expectTypeOf(compute.parseGraph).returns.toEqualTypeOf<Promise<Compute.ParseResult>>();
    expectTypeOf(compute.detectFormat).toEqualTypeOf<
      (text: string, filename?: string) => Promise<Compute.FormatId>
    >();
    expectTypeOf(compute.compactIri).toEqualTypeOf<
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
