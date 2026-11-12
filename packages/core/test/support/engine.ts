/**
 * kgdiff's engine for the tests of the read path: `@kgdiff/compute`'s WebAssembly modules,
 * initialized once, and their synchronous functions. The TypeScript engine is gone since 0.11, so
 * these tests compute the diffs and layouts they read, write and check with the engine that the
 * public `diff`, `layoutDiff` and `parseGraph` call (`diffSync` is what `diff` of `@kgdiff/core`
 * returns, without the `await`).
 *
 * The modules are a build product (`pnpm --filter @kgdiff/compute build:wasm`, CONTRIBUTING.md).
 * Without them this module throws, and every test file that imports it fails with that message:
 * nothing is skipped, locally or in CI.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DiffOptions, DiffResult, GraphInput, KGraph } from '@kgdiff/core';
import type { ParseOptions, ParseResult } from '@kgdiff/formats';
import type { LayoutOptions, LayoutResult } from '@kgdiff/layout';

type GraphSource = GraphInput | KGraph | string;

/** What these tests call in `@kgdiff/compute`. */
interface Engine {
  init(): Promise<void>;
  diffSync(before: GraphSource, after: GraphSource, options?: DiffOptions): DiffResult;
  parseGraphSync(source: string, options?: ParseOptions): ParseResult;
  layoutDiffSync(diff: DiffResult, options?: LayoutOptions): LayoutResult;
}

const wasm = fileURLToPath(new URL('../../../compute/wasm/', import.meta.url));
const missing = ['compute', 'formats', 'layout'].filter(
  (name) => !existsSync(`${wasm}${name}.wasm`),
);
if (missing.length > 0) {
  throw new Error(
    `These tests run kgdiff's engine, whose WebAssembly build is missing ` +
      `(${missing.map((name) => `packages/compute/wasm/${name}.wasm`).join(', ')}). ` +
      'Build it once with `pnpm --filter @kgdiff/compute build:wasm` (CONTRIBUTING.md).',
  );
}

const engine = (await (import('@kgdiff/compute') as Promise<unknown>)) as Engine;
await engine.init();

export const diff = engine.diffSync;
export const parseGraph = engine.parseGraphSync;
export const layoutDiff = engine.layoutDiffSync;
