/**
 * `@kgdiff/compute`: kgdiff's Rust engine (`kgdiff-core`) compiled to WebAssembly. It is a
 * preview of RFC 0002, phase 2, and covers the core only: diffs, node matching and text
 * similarity. Its results are the same bytes as the kgdiff CLI's, in every JavaScript engine.
 *
 * ```ts
 * import { init, diffSync } from '@kgdiff/compute';
 * await init(); // once; idempotent
 * const result = diffSync(before, after, options); // a DiffResult of @kgdiff/core
 * ```
 *
 * Graphs and options are passed to the engine as JSON text. A graph given as an object is
 * written with `JSON.stringify`, so values that JSON cannot hold (NaN, ±Infinity) arrive as
 * `null`.
 */
import {
  type DiffOptions,
  type DiffResult,
  diffFromJSON,
  type GraphInput,
  KgdiffError,
  type KgdiffErrorCode,
  type MatchOptions,
  type MatchResult,
} from '@kgdiff/core';
import type * as Glue from '../wasm/kgdiff_compute.js';

/** Where the WebAssembly module comes from: a URL or path to fetch, its bytes, or a module. */
export type InitSource = Glue.InitInput;

type Engine = typeof Glue;

let engine: Engine | undefined;
let loading: Promise<Engine> | undefined;

/**
 * Loads and compiles the engine. Call it once before any other function; later calls return at
 * once. In Node the module is read from this package's `wasm/` directory; elsewhere it is fetched
 * from there, relative to this file, unless `source` says otherwise.
 */
export async function init(source?: InitSource): Promise<void> {
  if (engine !== undefined) return;
  loading ??= load(source).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  engine = await loading;
}

async function load(source: InitSource | undefined): Promise<Engine> {
  const glue = await import('../wasm/kgdiff_compute.js');
  let input: InitSource = source ?? new URL('../wasm/kgdiff_compute_bg.wasm', import.meta.url);
  if (input instanceof URL && input.protocol === 'file:') {
    // Node's fetch does not read files.
    const { readFile } = await import('node:fs/promises');
    input = await readFile(input);
  }
  await glue.default({ module_or_path: input });
  return glue;
}

function ready(): Engine {
  if (engine === undefined) {
    throw new Error('@kgdiff/compute is not initialized: await init() first');
  }
  return engine;
}

/** A failure of the engine, thrown as `{ code, message, details }` text, as a KgdiffError. */
function failure(error: unknown): unknown {
  if (typeof error !== 'string') return error;
  try {
    const { code, message, details } = JSON.parse(error) as {
      code: KgdiffErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };
    return new KgdiffError(code, message, details);
  } catch {
    return new Error(error);
  }
}

function call<T>(run: (engine: Engine) => T): T {
  const e = ready();
  try {
    return run(e);
  } catch (error) {
    throw failure(error);
  }
}

/** JSON text as given, or a value written with `JSON.stringify`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Options as JSON text; none is the empty text. */
function optionsText(options: object | string | undefined): string {
  return options === undefined ? '' : text(options);
}

/** The engine's version, the version of the kgdiff crates it was built from. */
export function version(): string {
  return call((e) => e.version());
}

/**
 * The `kgdiff.diff` document of two graphs, as `kgdiff --json` writes it: `diff` and
 * `diffToJSON` of `@kgdiff/core`, in one call.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function diffJSON(
  before: GraphInput | string,
  after: GraphInput | string,
  options?: DiffOptions | string,
): string {
  return call((e) => e.diffJSON(text(before), text(after), optionsText(options)));
}

/**
 * `diff` of `@kgdiff/core`, computed by the engine: the `kgdiff.diff` document read with
 * `diffFromJSON`, every consistency check included.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function diffSync(
  before: GraphInput | string,
  after: GraphInput | string,
  options?: DiffOptions,
): DiffResult {
  return diffFromJSON(JSON.parse(diffJSON(before, after, options)));
}

/**
 * `matchNodes` of `@kgdiff/core` on the two graphs, each normalized with the default options.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function matchNodesSync(
  before: GraphInput | string,
  after: GraphInput | string,
  options?: MatchOptions,
): MatchResult {
  return JSON.parse(
    call((e) => e.matchNodesJSON(text(before), text(after), optionsText(options))),
  ) as MatchResult;
}

/** `textSimilarity` of `@kgdiff/core`. */
export function textSimilaritySync(a: string, b: string): number {
  return call((e) => e.textSimilarity(a, b));
}

/**
 * The engine's other entry points, on JSON text, as the kgdiff CLI writes it. `@kgdiff/core`
 * keeps the TypeScript versions of these synchronous functions. These exist to check that the
 * WebAssembly build gives the same bytes (`test/corpus.test.ts` runs the conformance corpus with
 * them).
 */
export const json = {
  /** `graphToJSON(normalize(graph, options))`. */
  normalize: (graph: GraphInput | string, options?: object | string): string =>
    call((e) => e.normalizeJSON(text(graph), optionsText(options))),
  /** `normalize(graph, options).issues`, as JSON text. */
  issues: (graph: GraphInput | string, options?: object | string): string =>
    call((e) => e.graphIssuesJSON(text(graph), optionsText(options))),
  /** `hashGraph(normalize(graph, options))`. */
  hashGraph: (graph: GraphInput | string, options?: object | string): string =>
    call((e) => e.hashGraphJSON(text(graph), optionsText(options))),
  /** A `kgdiff.diff` document read with `diffFromJSON` and written again. */
  readDiff: (document: string): string => call((e) => e.readDiffJSON(document)),
  /** `packDiffJSON`. */
  packDiff: (document: string): string => call((e) => e.packDiffJSON(document)),
  /** `unpackDiffJSON`. */
  unpackDiff: (packed: string): string => call((e) => e.unpackDiffJSON(packed)),
  /** The `kgdiff.delta` document of a `kgdiff.diff` document. */
  deltaOfDiff: (document: string): string => call((e) => e.deltaOfDiffJSON(document)),
  /** `invertDelta`. */
  invertDelta: (delta: string): string => call((e) => e.invertDeltaJSON(delta)),
  /**
   * `applyDelta(normalize(graph), delta, options)`: `{ graph, skipped }`, the graph as a
   * `kgdiff.graph` document and the ops skipped (`strict: false` only).
   */
  applyDelta: (
    graph: GraphInput | string,
    delta: string,
    options?: { readonly strict?: boolean },
  ): string => call((e) => e.applyDeltaJSON(text(graph), delta, optionsText(options))),
  /** `formatHunk` of every hunk of a `kgdiff.diff` document: `[{ id, title, subtitle }]`. */
  hunkTitles: (document: string, locale: 'en' | 'zh-CN' = 'en'): string =>
    call((e) => e.hunkTitlesJSON(document, locale)),
  /** `predicateLabel`. */
  predicateLabel: (predicate: string): string => call((e) => e.predicateLabel(predicate)),
  /** `facetLabel`; `undefined` for an unknown kind. */
  facetLabel: (kind: string, locale: 'en' | 'zh-CN' = 'en'): string | undefined =>
    call((e) => e.facetLabel(kind, locale)),
  /** `JSON.stringify(JSON.parse(text))`, or with `pretty`, indented by 2. */
  reformat: (source: string, pretty = false): string => call((e) => e.reformatJSON(source, pretty)),
} as const;
