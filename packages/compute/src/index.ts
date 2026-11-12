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
 * written with `JSON.stringify` (a normalized `KGraph` with `graphToJSON` and its nodes'
 * positions), so values that JSON cannot hold (NaN, ±Infinity) arrive as `null`. A
 * `kgdiff.graph` document carries no edge
 * identity, so a `KGraph`'s is passed with the options: the diff functions take it when both
 * graphs are `KGraph`s with the same edge identity and the options name none (as `diff` of
 * `@kgdiff/core` 0.10 did), and the matching functions normalize each `KGraph` with its own.
 *
 * `@kgdiff/core`'s `diff`, `matchNodes`, `textSimilarity`, `parseGraph`, `detectFormat` and
 * `compactIri` and `@kgdiff/layout`'s layouts call the asynchronous functions of this package. The
 * parsers' types (`ParseOptions`, `ParseResult`, `FormatId`, …) and `FORMAT_EXTENSIONS` are
 * exported here (`@kgdiff/core`'s declarations); `@kgdiff/formats` (deprecated) re-exports them
 * and its functions call this package's.
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
import { type GraphIssues, readComputedDiff } from '@kgdiff/core/computed';
import {
  type LayoutJSON,
  type LayoutOptions,
  type LayoutResult,
  layoutFromJSON,
  layoutToJSON,
} from '@kgdiff/layout';
import type * as ComputeGlue from '../wasm/compute.js';
import type * as FormatsGlue from '../wasm/formats.js';
import type { FormatId, ParseOptions, ParseResult } from './formats.js';
import {
  estimateLabelWidthSync,
  extendLayoutSync,
  layoutAfterSync,
  layoutDiffOnSync,
  layoutDiffSync,
  layoutGraphSync as layoutKGraphSync,
  nodeRadiusSync,
} from './layout.js';
import { layoutModule } from './layout-module.js';
import { type InitSource, Module } from './loader.js';

export {
  FORMAT_EXTENSIONS,
  type FormatId,
  type JsonDialect,
  type JsonLdOptions,
  type JsonOptions,
  type ParseOptions,
  type ParseResult,
  type ParseWarning,
  type ParseWarningCode,
  type RdfOptions,
} from './formats.js';
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

/** JSON text as given, a `KGraph` as `graphText` writes it, else `JSON.stringify`. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(isKGraph(value) ? graphText(value) : value);
}

/**
 * A `KGraph` as `graphToJSON` writes it, with its nodes' positions, which `graphToJSON` leaves out
 * and a `kgdiff.graph` document may carry: the engine anchors the layout of `diffAndLayout` on
 * them, as it does for the graphs as input.
 */
function graphText(graph: KGraph): object {
  const json = graphToJSON(graph);
  if (![...graph.nodes.values()].some((node) => node.position)) return json;
  const nodes = json.nodes.map((node) => {
    const position = graph.nodes.get(node.id)?.position;
    return position ? { ...node, position } : node;
  });
  return { ...json, nodes };
}

/**
 * The options of a diff of `before` and `after`: when both are `KGraph`s with the same edge
 * identity and the options name none, the options with that edge identity (0.10's rule). An
 * `edgeIdentity` of the options wins: the engine normalizes the graphs' JSON with it, which
 * re-keys a graph of the other identity as `diff` of 0.10 did.
 */
function diffOptions(
  before: GraphSource,
  after: GraphSource,
  options: DiffOptions | string | undefined,
): DiffOptions | string | undefined {
  if (!isKGraph(before) || !isKGraph(after) || before.edgeIdentity !== after.edgeIdentity) {
    return options;
  }
  const edgeIdentity = before.edgeIdentity;
  if (typeof options !== 'string') {
    return options?.edgeIdentity === undefined ? { ...options, edgeIdentity } : options;
  }
  // Options as text: completed when they are an object (or none) without an edge identity; text
  // the engine would reject is passed as it is, for the engine's error.
  if (options.trim() === '') return { edgeIdentity };
  let given: unknown;
  try {
    given = JSON.parse(options);
  } catch {
    return options;
  }
  if (given === null) return { edgeIdentity };
  if (typeof given !== 'object' || Array.isArray(given)) return options;
  const record = given as Record<string, unknown>;
  return record.edgeIdentity === undefined || record.edgeIdentity === null
    ? JSON.stringify({ ...record, edgeIdentity })
    : options;
}

/** The normalize options the engine reads a graph's JSON with: a `KGraph`'s edge identity. */
function graphOptions(graph: GraphSource): string {
  return isKGraph(graph) ? JSON.stringify({ edgeIdentity: graph.edgeIdentity }) : '';
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
 * anchors on them as it does for the diff of the graphs. When both graphs are `KGraph`s with the
 * same edge identity and `options` names none, theirs is used.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export function diffSync(
  before: GraphSource,
  after: GraphSource,
  options?: DiffOptions,
): DiffResult {
  const { diff, issues } = computed(before, after, options, undefined, false);
  return readComputedDiff(diff, before, after, issues);
}

/**
 * `computedDiffJSON` of the engine: the `kgdiff.diff` document, the issues of normalizing the
 * graphs (which the document does not carry) and, `withLayout`, the `kgdiff.layout` document.
 */
function computed(
  before: GraphSource,
  after: GraphSource,
  options: DiffOptions | undefined,
  layoutOptions: LayoutOptions | undefined,
  withLayout: boolean,
): { diff: DiffJSON; issues: GraphIssues; layout?: LayoutJSON } {
  return JSON.parse(
    computeModule.call((e) =>
      e.computedDiffJSON(
        text(before),
        text(after),
        optionsText(diffOptions(before, after, options)),
        layoutOptionsText(layoutOptions),
        withLayout,
      ),
    ),
  ) as { diff: DiffJSON; issues: GraphIssues; layout?: LayoutJSON };
}

/**
 * `matchNodes` of `@kgdiff/core` on the two graphs. A `KGraph` is passed as `graphToJSON` writes
 * it and normalized with its own edge identity, which gives it back; a graph as input is
 * normalized with the default options.
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
 * Parse graph text in any supported format.
 *
 * - `format` defaults to `auto` (`detectFormat(text, filename)`).
 * - `meta.source` is set to `filename` when given.
 * - Every RDF syntax (Turtle, N-Triples, N-Quads, TriG, RDF/XML, JSON-LD) maps through the same
 *   conventions, so one graph gives the same `GraphInput` in any of them.
 * - Offline: JSON-LD remote contexts come only from `jsonld.documentLoader` (called
 *   synchronously).
 * - Recoverable oddities (named graphs merged, unsupported OBO stanzas, d3 index ids, …) are
 *   reported in `warnings` instead of failing.
 *
 * Output is deterministic: nodes sorted by id, edges by (source, predicate, target), attribute
 * keys sorted and multi-valued fields as sorted arrays.
 *
 * @throws KgdiffError `invalid-input` with line information on syntax errors.
 */
export function parseGraphSync(source: string, options?: ParseOptions): ParseResult {
  return JSON.parse(json.parseGraph(source, options)) as ParseResult;
}

/**
 * Best-effort format detection from file name and content sniffing.
 *
 * The extension wins when it is known (`FORMAT_EXTENSIONS`, case-insensitive; query strings
 * are ignored), with two refinements: `.json` holding JSON-LD is `jsonld`, and `.owl` — which
 * Protégé also uses for Turtle, OWL/XML and Functional Syntax — is decided by its content
 * (RDF/XML when that cannot tell). Otherwise the content decides: JSON → json, or jsonld when a
 * top-level key is a JSON-LD keyword; XML with an `rdf:RDF` root → rdfxml; OBO headers or
 * stanzas → obo; Turtle directives → turtle, or trig with a graph block; line-based statements
 * → ntriples or nquads. Empty input is an (empty) Turtle graph.
 *
 * @throws KgdiffError `invalid-input`, with a conversion hint for recognisably unsupported
 *   formats (OWL/XML, OWL Functional / Manchester Syntax, GraphML, GEXF, other XML), when the
 *   format cannot be detected.
 */
export function detectFormatSync(source: string, filename?: string): FormatId {
  return formatsModule.call((e) => e.detectFormat(source, filename)) as FormatId;
}

/**
 * Compact an IRI with a prefix map: `http://purl.obolibrary.org/obo/GO_0008150` → `GO:0008150`.
 * Uses the well-known prefixes overlaid with `prefixes`; returns `iri` unchanged when nothing
 * matches. For display only: node ids keep full IRIs.
 */
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
  const { diff, issues, layout } = computed(before, after, options, layoutOptions, true);
  return {
    diff: readComputedDiff(diff, before, after, issues),
    layout: layoutFromJSON(layout as LayoutJSON),
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
  /**
   * `diffToJSON(diff(before, after, options))`: the `kgdiff.diff` document (`compute`). Two
   * `KGraph`s with one edge identity bring it when the options name none.
   */
  diff: (before: GraphSource, after: GraphSource, options?: DiffOptions | string): string =>
    computeModule.call((e) =>
      e.diffJSON(text(before), text(after), optionsText(diffOptions(before, after, options))),
    ),
  /** `matchNodes` on the two graphs, a `KGraph` with its edge identity: `{ matches, suggestions }` (`compute`). */
  matchNodes: (before: GraphSource, after: GraphSource, options?: MatchOptions | string): string =>
    computeModule.call((e) =>
      e.matchNodesJSON(
        text(before),
        text(after),
        optionsText(options),
        graphOptions(before),
        graphOptions(after),
      ),
    ),
  /** `graphToJSON(normalize(graph, options))` (`compute`). */
  normalize: (graph: GraphInput | string, options?: object | string): string =>
    computeModule.call((e) => e.normalizeJSON(text(graph), optionsText(options))),
  /** `normalize(graph, options).issues`, as JSON text (`compute`). */
  issues: (graph: GraphInput | string, options?: object | string): string =>
    computeModule.call((e) => e.graphIssuesJSON(text(graph), optionsText(options))),
  /** `hashGraph(normalize(graph, options))` (`compute`). */
  hashGraph: (graph: GraphInput | string, options?: object | string): string =>
    computeModule.call((e) => e.hashGraphJSON(text(graph), optionsText(options))),
  /** `{ diff, layout }`, the two documents of the graphs; options as for `diff` (`compute`). */
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
        optionsText(diffOptions(before, after, options)),
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
