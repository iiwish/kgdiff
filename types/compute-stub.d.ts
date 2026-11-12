/**
 * What the workspace's type-checks see of `@kgdiff/compute` (`tsconfig.base.json`): the parsers'
 * types and `FORMAT_EXTENSIONS` (`packages/compute/src/formats.ts`, which imports no WebAssembly
 * glue and no DOM types) and the asynchronous parser functions, which `@kgdiff/formats` and
 * `@kgdiff/viewer` call. `@kgdiff/core` and `@kgdiff/layout` import the package with a dynamic
 * `import()` typed by an interface of their own and are built against `compute-stub-build.d.ts`.
 * So no program but compute's own includes its sources (written for the DOM's `fetch` types).
 * Vitest, Vite and every bundler resolve the real package; `packages/compute/test/stub.test.ts`
 * checks these declarations against it, and compute's other tests check that it provides each
 * package's interface.
 */
import type { FormatId, ParseOptions, ParseResult } from '../packages/compute/src/formats.js';

export * from '../packages/compute/src/formats.js';

export declare function parseGraph(source: string, options?: ParseOptions): Promise<ParseResult>;
export declare function detectFormat(source: string, filename?: string): Promise<FormatId>;
export declare function compactIri(
  iri: string,
  prefixes?: Readonly<Record<string, string>>,
): Promise<string>;
