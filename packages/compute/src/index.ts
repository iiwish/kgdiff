/**
 * `@kgdiff/compute`: kgdiff's Rust engine compiled to WebAssembly. Its results are the same bytes
 * as the kgdiff CLI's, in every JavaScript engine.
 *
 * ```ts
 * import { init, diffSync } from '@kgdiff/compute';
 * await init(); // once; idempotent
 * const result = diffSync(before, after, options); // a DiffResult of @kgdiff/core
 * ```
 *
 * There are three modules, each loaded only when asked for: `compute` (diff and matching),
 * `formats` (the parsers) and `layout`. `init()` loads all three; `init({ modules: ['layout'] })`
 * loads the ones named. Every `*Sync` function needs its module loaded and throws otherwise; the
 * asynchronous functions (`diff`, `parseGraph`, `layoutDiff`, …) load what they need themselves.
 *
 * Graphs and options are passed to the engine as JSON text. A graph given as an object is
 * written with `JSON.stringify` (a normalized `KGraph` with `graphToJSON`), so values that JSON
 * cannot hold (NaN, ±Infinity) arrive as `null`.
 *
 * `@kgdiff/core`'s `diff`, `matchNodes` and `textSimilarity`, `@kgdiff/formats`' parsers and
 * `@kgdiff/layout`'s layouts call the asynchronous functions of this package.
 */
import {
  type DiffJSON,
  type DiffOptions,
  type DiffResult,
  diffFromJSON,
  type GraphInput,
  graphToJSON,
  isKGraph,
  type KGraph,
  type MatchOptions,
  type MatchResult,
  type NormalizeOptions,
  normalize,
  type UnionId,
} from '@kgdiff/core';
import { readComputedDiff } from '@kgdiff/core/computed';
import type { FormatId, ParseOptions, ParseResult } from '@kgdiff/formats';
import {
  type LayoutJSON,
  type LayoutOptions,
  type LayoutResult,
  layoutFromJSON,
  layoutToJSON,
} from '@kgdiff/layout';
import type * as ComputeGlue from '../wasm/compute.js';
import type * as FormatsGlue from '../wasm/formats.js';
import {
  estimateLabelWidthSync,
  extendLayoutSync,
  layoutAfterSync,
  layoutDiffOnSync,
  layoutDiffSync,
  layoutGraphSync as layoutKGraphSync,
  layoutModule,
  nodeRadiusSync,
} from './layout.js';
import { type InitSource, Module } from './loader.js';

export type { InitSource };
export {
  estimateLabelWidthSync,
  extendLayoutSync,
  layoutAfterSync,
  layoutDiffOnSync,
  layoutDiffSync,
  nodeRadiusSync,
};

/** The modules of this package. */
export type ModuleName = 'compute' | 'formats' | 'layout';

const computeModule = new Module<typeof ComputeGlue>(
  'compute',
  () => import('../wasm/compute.js'),
  () => new URL('../wasm/compute.wasm', import.meta.url),
);
const formatsModule = new Module<typeof FormatsGlue>(
  'formats',
  () => import('../wasm/formats.js'),
  () => new URL('../wasm/formats.wasm', import.meta.url),
);
const ALL: readonly ModuleName[] = ['compute', 'formats', 'layout'];

export interface InitOptions {
  /** The modules to load. Default: all three. */
  readonly modules?: readonly ModuleName[];
  /** Where each module comes from, instead of this package's `wasm/` directory. */
  readonly sources?: Partial<Record<ModuleName, InitSource>>;
}

/**
 * Loads and compiles modules. Later calls return at once for what is already loaded. In Node the
 * modules are read from this package's `wasm/` directory; elsewhere they are fetched from there,
 * relative to this file, unless `sources` says otherwise.
 */
export async function init(options: InitOptions = {}): Promise<void> {
  const modules = { compute: computeModule, formats: formatsModule, layout: layoutModule };
  await Promise.all(
    (options.modules ?? ALL).map((name) => modules[name].init(options.sources?.[name])),
  );
}

/** A graph as the engine takes it: JSON text, a graph as input, or a normalized `KGraph`. */
export type GraphSource = GraphInput | KGraph | string;

/** JSON text as given, a `KGraph` as `graphToJSON` writes it, else `JSON.stringify`. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(isKGraph(value) ? graphToJSON(value) : value);
}

/** Options as JSON text; none is the empty text. */
function optionsText(options: object | string | undefined): string {
  return options === undefined ? '' : text(options);
}

/** `LayoutOptions` as JSON text: `pinned` is a `Map` and becomes an object of points. */
function layoutOptionsText(options: LayoutOptions | undefined): string {
  if (options === undefined) return '';
  const { pinned, ...rest } = options;
  return JSON.stringify(pinned ? { ...rest, pinned: Object.fromEntries(pinned) } : rest);
}

/** The engine's version, the version of the kgdiff crates it was built from. */
export function version(): string {
  if (computeModule.loaded) return computeModule.call((e) => e.version());
  if (formatsModule.loaded) return formatsModule.call((e) => e.version());
  return layoutModule.call((e) => e.version());
}

/**
 * The `kgdiff.diff` document of two graphs, as `kgdiff --json` writes it (`json.diff`).
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function diffJSON(
  before: GraphSource,
  after: GraphSource,
  options?: DiffOptions | string,
): string {
  return json.diff(before, after, options);
}

/**
 * `diff` of `@kgdiff/core`, computed by the engine: the `kgdiff.diff` document it writes, read
 * back as a `DiffResult`. That document was just written by this build's engine, so it is read
 * without `diffFromJSON`'s consistency checks (the result is the same object), and the graphs'
 * node positions, which a diff document does not carry, are put back on its nodes: `layoutDiff`
 * anchors on them as it does for the diff of the graphs.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function diffSync(
  before: GraphSource,
  after: GraphSource,
  options?: DiffOptions,
): DiffResult {
  return readComputedDiff(json.diff(before, after, options), before, after);
}

/**
 * `matchNodes` of `@kgdiff/core` on the two graphs, each normalized with the default options (a
 * `KGraph` is passed as `graphToJSON` writes it, which normalizes to itself).
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function matchNodesSync(
  before: GraphSource,
  after: GraphSource,
  options?: MatchOptions,
): MatchResult {
  return JSON.parse(json.matchNodes(before, after, options)) as MatchResult;
}

/** `textSimilarity` of `@kgdiff/core`. */
export function textSimilaritySync(a: string, b: string): number {
  return computeModule.call((e) => e.textSimilarity(a, b));
}

/**
 * `parseGraph` of `@kgdiff/formats`.
 *
 * @throws KgdiffError `invalid-input` with line information on syntax errors.
 */
export function parseGraphSync(source: string, options?: ParseOptions): ParseResult {
  return JSON.parse(json.parseGraph(source, options)) as ParseResult;
}

/**
 * `detectFormat` of `@kgdiff/formats`.
 *
 * @throws KgdiffError `invalid-input` when the format cannot be detected.
 */
export function detectFormatSync(source: string, filename?: string): FormatId {
  return formatsModule.call((e) => e.detectFormat(source, filename)) as FormatId;
}

/** `compactIri` of `@kgdiff/formats`. */
export function compactIriSync(iri: string, prefixes?: Readonly<Record<string, string>>): string {
  return formatsModule.call((e) => e.compactIri(iri, optionsText(prefixes)));
}

/**
 * The layout of one graph, given as input or normalized: `layout_graph` of `kgdiff-layout`.
 *
 * @throws KgdiffError `invalid-input` for malformed input, scope `changes` or invalid options.
 */
export function layoutGraphSync(graph: KGraph | GraphInput, options?: LayoutOptions): LayoutResult {
  return layoutKGraphSync(
    graph.nodes instanceof Map ? (graph as KGraph) : normalize(graph as GraphInput),
    options,
  );
}

/**
 * `diff` and `layoutDiff` in one call on the `compute` module alone: for an application that
 * starts from graphs and does not want a second module.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function diffAndLayoutSync(
  before: GraphSource,
  after: GraphSource,
  options?: DiffOptions,
  layoutOptions?: LayoutOptions,
): { readonly diff: DiffResult; readonly layout: LayoutResult } {
  const { diff, layout } = JSON.parse(json.diffLayout(before, after, options, layoutOptions)) as {
    diff: unknown;
    layout: LayoutJSON;
  };
  return {
    diff: readComputedDiff(diff as DiffJSON, before, after),
    layout: layoutFromJSON(layout),
  };
}

/** Awaits one module and runs `use`. */
async function using<R>(names: readonly ModuleName[], use: () => R): Promise<R> {
  await init({ modules: names });
  return use();
}

/** `diffSync`, loading the `compute` module first. */
export function diff(
  before: GraphSource,
  after: GraphSource,
  options?: DiffOptions,
): Promise<DiffResult> {
  return using(['compute'], () => diffSync(before, after, options));
}

/** `matchNodesSync`, loading the `compute` module first. */
export function matchNodes(
  before: GraphSource,
  after: GraphSource,
  options?: MatchOptions,
): Promise<MatchResult> {
  return using(['compute'], () => matchNodesSync(before, after, options));
}

/** `textSimilaritySync`, loading the `compute` module first. */
export function textSimilarity(a: string, b: string): Promise<number> {
  return using(['compute'], () => textSimilaritySync(a, b));
}

/** `parseGraphSync`, loading the `formats` module first. */
export function parseGraph(source: string, options?: ParseOptions): Promise<ParseResult> {
  return using(['formats'], () => parseGraphSync(source, options));
}

/** `detectFormatSync`, loading the `formats` module first. */
export function detectFormat(source: string, filename?: string): Promise<FormatId> {
  return using(['formats'], () => detectFormatSync(source, filename));
}

/** `compactIriSync`, loading the `formats` module first. */
export function compactIri(
  iri: string,
  prefixes?: Readonly<Record<string, string>>,
): Promise<string> {
  return using(['formats'], () => compactIriSync(iri, prefixes));
}

/** `layoutDiffSync`, loading the `layout` module first. */
export function layoutDiff(diff: DiffResult, options?: LayoutOptions): Promise<LayoutResult> {
  return using(['layout'], () => layoutDiffSync(diff, options));
}

/** `extendLayoutSync`, loading the `layout` module first. */
export function extendLayout(
  diff: DiffResult,
  layout: LayoutResult,
  nodes: readonly UnionId[],
  options?: LayoutOptions,
): Promise<LayoutResult> {
  return using(['layout'], () => extendLayoutSync(diff, layout, nodes, options));
}

/** `layoutGraphSync`, loading the `layout` module first. */
export function layoutGraph(
  graph: KGraph | GraphInput,
  options?: LayoutOptions,
): Promise<LayoutResult> {
  return using(['layout'], () => layoutGraphSync(graph, options));
}

/** `layoutDiffOnSync`, loading the `layout` module first. */
export function layoutDiffOn(
  diff: DiffResult,
  previous: LayoutResult,
  options?: LayoutOptions,
): Promise<LayoutResult> {
  return using(['layout'], () => layoutDiffOnSync(diff, previous, options));
}

/** `layoutAfterSync`, loading the `layout` module first. */
export function layoutAfter(
  diff: DiffResult,
  layout: LayoutResult,
  options?: LayoutOptions,
): Promise<LayoutResult> {
  return using(['layout'], () => layoutAfterSync(diff, layout, options));
}

/** `diffAndLayoutSync`, loading the `compute` module first. */
export function diffAndLayout(
  before: GraphSource,
  after: GraphSource,
  options?: DiffOptions,
  layoutOptions?: LayoutOptions,
): Promise<{ readonly diff: DiffResult; readonly layout: LayoutResult }> {
  return using(['compute'], () => diffAndLayoutSync(before, after, options, layoutOptions));
}

/**
 * The low-level interface: kgdiff JSON as text in and out, the same bytes as the kgdiff CLI
 * writes. Each function needs its module loaded (`compute`, `formats` or, for the layouts of an
 * existing diff, `layout`).
 */
export const json = {
  /** `diffToJSON(diff(before, after, options))`: the `kgdiff.diff` document (`compute`). */
  diff: (before: GraphSource, after: GraphSource, options?: DiffOptions | string): string =>
    computeModule.call((e) => e.diffJSON(text(before), text(after), optionsText(options))),
  /** `matchNodes` on the two graphs: `{ matches, suggestions }` (`compute`). */
  matchNodes: (before: GraphSource, after: GraphSource, options?: MatchOptions | string): string =>
    computeModule.call((e) => e.matchNodesJSON(text(before), text(after), optionsText(options))),
  /** `graphToJSON(normalize(graph, options))` (`compute`). */
  normalize: (graph: GraphInput | string, options?: object | string): string =>
    computeModule.call((e) => e.normalizeJSON(text(graph), optionsText(options))),
  /** `normalize(graph, options).issues`, as JSON text (`compute`). */
  issues: (graph: GraphInput | string, options?: object | string): string =>
    computeModule.call((e) => e.graphIssuesJSON(text(graph), optionsText(options))),
  /** `hashGraph(normalize(graph, options))` (`compute`). */
  hashGraph: (graph: GraphInput | string, options?: object | string): string =>
    computeModule.call((e) => e.hashGraphJSON(text(graph), optionsText(options))),
  /** `{ diff, layout }`, the two documents of the graphs (`compute`). */
  diffLayout: (
    before: GraphSource,
    after: GraphSource,
    options?: DiffOptions | string,
    layoutOptions?: LayoutOptions,
  ): string =>
    computeModule.call((e) =>
      e.diffLayoutJSON(
        text(before),
        text(after),
        optionsText(options),
        layoutOptionsText(layoutOptions),
      ),
    ),
  /** The `kgdiff.layout` document of one graph, normalized with `normalizeOptions` (`compute`). */
  layoutGraph: (
    graph: GraphInput | string,
    options?: LayoutOptions,
    normalizeOptions?: NormalizeOptions,
  ): string =>
    computeModule.call((e) =>
      e.layoutGraphJSON(text(graph), layoutOptionsText(options), optionsText(normalizeOptions)),
    ),
  /** `ParseResult` as JSON text (`formats`). A `jsonld.documentLoader` is called as usual. */
  parseGraph: (source: string, options?: ParseOptions): string => {
    const { jsonld, ...rest } = options ?? {};
    const load = jsonld?.documentLoader;
    const loader = load
      ? (url: string): string | undefined => {
          const document = load(url);
          return document === undefined || typeof document === 'string'
            ? document
            : JSON.stringify(document);
        }
      : undefined;
    return formatsModule.call((e) => e.parseGraphJSON(source, JSON.stringify(rest), loader));
  },
  /** The `kgdiff.layout` document of a `kgdiff.diff` document (`layout`). */
  layoutDiff: (document: string, options?: LayoutOptions): string =>
    written(layoutDiffSync(read(document), options)),
  /** `extendLayout` on documents (`layout`). */
  extendLayout: (
    document: string,
    layout: string,
    nodes: readonly UnionId[],
    options?: LayoutOptions,
  ): string => written(extendLayoutSync(read(document), readLayout(layout), nodes, options)),
  /** `layout_diff_on` on documents (`layout`). */
  layoutDiffOn: (document: string, previous: string, options?: LayoutOptions): string =>
    written(layoutDiffOnSync(read(document), readLayout(previous), options)),
  /** `layout_after` on documents (`layout`). */
  layoutAfter: (document: string, layout: string, options?: LayoutOptions): string =>
    written(layoutAfterSync(read(document), readLayout(layout), options)),
} as const;

function read(document: string): DiffResult {
  return diffFromJSON(JSON.parse(document));
}

function readLayout(document: string): LayoutResult {
  return layoutFromJSON(JSON.parse(document) as LayoutJSON);
}

function written(layout: LayoutResult): string {
  return JSON.stringify(layoutToJSON(layout));
}
