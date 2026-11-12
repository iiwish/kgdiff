/**
 * @kgdiff/core: semantic diff engine for knowledge graphs.
 *
 * Signatures and documented behaviour are final (docs/architecture.md). Since 0.11 `diff`,
 * `matchNodes` and `textSimilarity` run kgdiff's engine compiled to WebAssembly
 * (`@kgdiff/compute`, loaded with a dynamic `import()` on first use, so a bundle that only reads
 * diffs never contains it) and are asynchronous, and so are the parsers, `parseGraph`, `detectFormat`
 * and `compactIri` (since 0.11.1, the same functions as `@kgdiff/formats`, deprecated). What stays
 * in TypeScript is the model and the read path, synchronous, in dedicated modules
 * (`tests/read-path.ts` lists them):
 *
 *   options.ts       defaults and validation
 *   normalize.ts     GraphInput → KGraph (§1)
 *   text.ts          predicateLabel
 *   delta.ts         delta application and inversion (§8)
 *   stats.ts         statistics (§9)
 *   graph-json.ts    compact JSON of graphs, content hash
 *   json.ts          DiffJSON transport
 *   consistency.ts   checks of diffs read from JSON
 *   packed.ts        PackedDiffJSON, the packed transport of reports
 *   i18n.ts          formatHunk, facetLabel
 *   formats.ts       the parsers' types and FORMAT_EXTENSIONS
 *   computed.ts      reading back what @kgdiff/compute computed (`@kgdiff/core/computed`)
 *
 * The rule: the model packages (`@kgdiff/core`, `@kgdiff/layout`) give asynchronous entries that
 * load the engine on the first call. For the synchronous API (`init()` and the `*Sync`
 * functions), for choosing where the `.wasm` files are loaded from, or for the low-level JSON
 * functions, use `@kgdiff/compute`.
 */

import { applyDelta as apply, invertDelta as invert } from './delta.js';
import type { FormatId, ParseOptions, ParseResult } from './formats.js';
import { hashGraph as hash, graphToJSON as toGraphJSON } from './graph-json.js';
import { formatHunk as format, facetLabel as labelOfFacet } from './i18n.js';
import { diffFromJSON as fromJSON, diffToJSON as toJSON } from './json.js';
import { isKGraph as isGraph, normalize as normalizeGraph } from './normalize.js';
import { resolveOptions as resolve } from './options.js';
import { packDiffJSON as pack, unpackDiffJSON as unpack } from './packed.js';
import { predicateLabel as labelOfPredicate } from './text.js';
import type {
  ApplyOptions,
  Delta,
  DiffJSON,
  DiffOptions,
  DiffResult,
  FacetKind,
  GraphInput,
  GraphJSON,
  Hunk,
  KGraph,
  Locale,
  MatchOptions,
  MatchResult,
  NormalizeOptions,
  PackedDiffJSON,
  ResolvedDiffOptions,
} from './types.js';

export { KgdiffError } from './errors.js';
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
export { DEFAULT_HIERARCHY_PREDICATES } from './options.js';
export * from './types.js';

/** What this package calls in `@kgdiff/compute` (checked against it by compute's tests). */
interface CoreEngine {
  diff(
    before: GraphInput | KGraph,
    after: GraphInput | KGraph,
    options?: DiffOptions,
  ): Promise<DiffResult>;
  matchNodes(before: KGraph, after: KGraph, options?: MatchOptions): Promise<MatchResult>;
  textSimilarity(a: string, b: string): Promise<number>;
  parseGraph(source: string, options?: ParseOptions): Promise<ParseResult>;
  detectFormat(source: string, filename?: string): Promise<FormatId>;
  compactIri(iri: string, prefixes?: Readonly<Record<string, string>>): Promise<string>;
}

let engine: Promise<CoreEngine> | undefined;

/** `@kgdiff/compute`, imported on first use. */
function compute(): Promise<CoreEngine> {
  engine ??= (import('@kgdiff/compute') as Promise<unknown> as Promise<CoreEngine>).catch(
    (error: unknown) => {
      engine = undefined;
      throw error;
    },
  );
  return engine;
}

/**
 * Fill every option with its documented default: `match` = `{ strategy: 'auto',
 * threshold: 0.82, suggestThreshold: 0.6, maxCandidates: 8 }`, `edgeIdentity` =
 * `'structure'`, `hierarchyPredicates` = `DEFAULT_HIERARCHY_PREDICATES`, `detectMerges` /
 * `detectSplits` = `true`, `ignoreAttrs` = `[]` (sorted).
 *
 * @throws KgdiffError `invalid-input` for out-of-range or ill-typed options.
 */
export function resolveOptions(options?: DiffOptions): ResolvedDiffOptions {
  return resolve(options);
}

/**
 * Validate and index a graph. Pure; never mutates `input`. O(N + E).
 *
 * Labels default to ids; sets are sorted and de-duplicated; duplicate nodes are merged;
 * parallel edges are keyed `#2`, `#3`… in content order; dangling endpoints follow
 * `danglingEdges` (default `create`). Problems are reported in `issues`. The kgdiff JSON
 * marker (`format: 'kgdiff.graph'`, `version: 1`) is optional.
 *
 * @throws KgdiffError `invalid-input` for malformed input, `dangling-edge` (policy `error`),
 *   `unsupported-version` for another kgdiff format or graph version.
 */
export function normalize(input: GraphInput, options?: NormalizeOptions): KGraph {
  return normalizeGraph(input, options);
}

/** Type guard distinguishing a normalized `KGraph` from a raw `GraphInput`. */
export function isKGraph(value: unknown): value is KGraph {
  return isGraph(value);
}

/**
 * Align the nodes of two versions (exact ids, then 1:1 replacement hints, then similarity).
 * Matches are sorted by `after`. Similarity matching uses blocking on both sides, so it never
 * compares all pairs.
 *
 * Asynchronous since 0.11: kgdiff's engine runs it (`@kgdiff/compute`, loaded and compiled on
 * the first call). After `await init()` of `@kgdiff/compute`, its `matchNodesSync` gives the
 * same result synchronously.
 *
 * @throws KgdiffError `invalid-input` for invalid options.
 */
export async function matchNodes(
  before: KGraph,
  after: KGraph,
  options?: MatchOptions,
): Promise<MatchResult> {
  return (await compute()).matchNodes(before, after, options);
}

/**
 * Compute the semantic diff between two graph versions: union graph with statuses and
 * facets, hunks, an invertible delta and stats. Deterministic: shuffling the input nodes or
 * edges does not change `diffToJSON` output. Inputs may be raw `GraphInput`s or normalized
 * `KGraph`s; when both are `KGraph`s with the same edge identity and no `edgeIdentity` option is
 * given, theirs is used. Otherwise the option (default `structure`) is, and a `KGraph` of the
 * other edge identity is re-keyed to it.
 *
 * Asynchronous since 0.11: kgdiff's engine runs it (`@kgdiff/compute`, loaded and compiled on
 * the first call), so the result is the same, byte for byte in `diffToJSON`, as the kgdiff
 * CLI's. Node positions of the graphs are kept, so `layoutDiff` anchors on them as before. After
 * `await init()` of `@kgdiff/compute`, its `diffSync` gives the same result synchronously.
 *
 * @throws KgdiffError `invalid-input` for malformed input or options.
 */
export async function diff(
  before: GraphInput | KGraph,
  after: GraphInput | KGraph,
  options?: DiffOptions,
): Promise<DiffResult> {
  return (await compute()).diff(before, after, options);
}

/**
 * Apply a delta. With `strict` (default) verifies the base hash and every precondition;
 * otherwise skips the ops whose precondition fails and reports each to `onSkip`.
 *
 * @throws KgdiffError `delta-base-mismatch`, `delta-conflict` (`{ opIndex, op, reason }`),
 *   `unsupported-version`, `invalid-input`.
 */
export function applyDelta(graph: KGraph, delta: Delta, options?: ApplyOptions): KGraph {
  return apply(graph, delta, options);
}

/** The delta that undoes `delta`: `applyDelta(applyDelta(g, d), invertDelta(d)) ≅ g`. */
export function invertDelta(delta: Delta): Delta {
  return invert(delta);
}

/**
 * Stable content hash of a normalized graph, e.g. `c53:0f3a9c…`. Ignores positions, meta,
 * the `implicit` flag and element order. O(size); memoized per graph.
 */
export function hashGraph(graph: KGraph): string {
  return hash(graph);
}

/**
 * Canonical JSON form of a graph: kgdiff JSON with its `kgdiff.graph` version 1 marker, sorted,
 * defaults omitted. Accepted by `normalize`.
 */
export function graphToJSON(graph: KGraph): GraphJSON {
  return toGraphJSON(graph);
}

/** Lossless, deterministic serialization of a diff. */
export function diffToJSON(result: DiffResult): DiffJSON {
  return toJSON(result);
}

/**
 * Inverse of `diffToJSON`. Rebuilds both graphs and the index, and checks that the document is
 * consistent: every element has the versions its status implies and lies in the hunk it names,
 * edges join union nodes, hunks own disjoint delta ops, the delta goes from the before to the
 * after graph (by content hash) and the counts match. Linear in the size of the diff. Labels,
 * aliases and types are read as written, not normalized again, so a document opens the same way
 * whatever Unicode version the runtime has.
 *
 * @throws KgdiffError `unsupported-version` for another format or version, `invalid-input` for a
 *   malformed or inconsistent document (the message names the first contradiction).
 */
export function diffFromJSON(json: DiffJSON): DiffResult {
  return fromJSON(json);
}

/**
 * Packs the unchanged elements of a diff document into string-indexed tables (edges with a label
 * or attributes of their own stay as they are). A large, mostly unchanged diff shrinks to about a
 * third, a little under half once gzipped. Lossless and deterministic.
 */
export function packDiffJSON(json: DiffJSON): PackedDiffJSON {
  return pack(json);
}

/**
 * Inverse of `packDiffJSON`: `unpackDiffJSON(packDiffJSON(j))` is `j`, byte for byte, for what
 * `diffToJSON` writes. Read the result with `diffFromJSON`.
 *
 * @throws KgdiffError `unsupported-version`, `invalid-input` for malformed tables.
 */
export function unpackDiffJSON(packed: PackedDiffJSON): DiffJSON {
  return unpack(packed);
}

/**
 * Similarity of two display strings in [0, 1]; robust to case, punctuation, word order and CJK.
 *
 * Asynchronous since 0.11, like `diff`; `textSimilaritySync` of `@kgdiff/compute` after its
 * `init()` for a loop over many pairs.
 */
export async function textSimilarity(a: string, b: string): Promise<number> {
  return (await compute()).textSimilarity(a, b);
}

/** Human-readable form of a predicate: `rdfs:subClassOf` → `subClassOf`, `…/part_of` → `part of`. */
export function predicateLabel(predicate: string): string {
  return labelOfPredicate(predicate);
}

/** Localized one-line title and subtitle for a hunk, e.g. “Merged “A” into “B”” / “+3 relations”. */
export function formatHunk(
  hunk: Hunk,
  diff: DiffResult,
  locale?: Locale,
): { readonly title: string; readonly subtitle: string } {
  return format(hunk, diff, locale);
}

/** Localized short name of a facet kind, e.g. `rename` → “Renamed” / “改名”. */
export function facetLabel(kind: FacetKind, locale?: Locale): string {
  return labelOfFacet(kind, locale);
}

/**
 * Parse graph text in any supported format. Throws `KgdiffError('invalid-input')` with line
 * info on syntax errors.
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
 * Output is deterministic: the same text and options always give an identical result, with
 * nodes sorted by id, edges by (source, predicate, target), attribute keys sorted and
 * multi-valued fields as sorted arrays. Linear in the input size (plus sorting the output).
 *
 * Asynchronous: kgdiff's parsers run it (`@kgdiff/compute`'s `formats` module, loaded and
 * compiled on the first call), so the result is the kgdiff CLI's. Since 0.11.1; the same function
 * as `parseGraph` of `@kgdiff/formats` (deprecated). After `await init()` of `@kgdiff/compute`,
 * its `parseGraphSync` gives the same result synchronously.
 */
export async function parseGraph(text: string, options: ParseOptions = {}): Promise<ParseResult> {
  return (await compute()).parseGraph(text, options);
}

/**
 * Best-effort format detection from file name and content sniffing.
 *
 * The extension wins when it is known (`FORMAT_EXTENSIONS`, case-insensitive; query strings
 * are ignored), with two refinements: `.json` holding JSON-LD is `jsonld`, and `.owl` — which
 * Protégé also uses for Turtle, OWL/XML and Functional Syntax — is decided by its content
 * (RDF/XML when that cannot tell). Otherwise: `{` (or a JSON array) → json, or jsonld when a
 * top-level key is `@context`, `@graph`, `@id`, `@type`…; XML → rdfxml for an `rdf:RDF` root
 * (or a root using the RDF namespace); `format-version:` or a `[Term]` / `[Typedef]` /
 * `[Instance]` line → obo; Turtle directives → turtle, or trig when a `{ … }` graph block
 * appears; line-based statements → ntriples (3 terms) or nquads (4 terms). Empty input is an
 * (empty) Turtle graph. Throws `KgdiffError('invalid-input')` with a conversion hint for
 * recognisably unsupported formats (OWL/XML, OWL Functional / Manchester Syntax, GraphML,
 * GEXF, other XML) and for unrecognisable text.
 *
 * Asynchronous, like `parseGraph` (since 0.11.1; the same function as `detectFormat` of
 * `@kgdiff/formats`). `detectFormatSync` of `@kgdiff/compute` after its `init()`.
 */
export async function detectFormat(text: string, filename?: string): Promise<FormatId> {
  return (await compute()).detectFormat(text, filename);
}

/**
 * Compact an IRI with a prefix map: `http://purl.obolibrary.org/obo/GO_0008150` → `GO:0008150`.
 *
 * Uses the well-known prefixes (rdf, rdfs, owl, xsd, skos, schema, dcterms, dc, foaf, prov,
 * oboInOwl, obo) overlaid with `prefixes`; OBO PURLs follow the OBO rule unless `prefixes`
 * binds that id space elsewhere. The longest matching namespace wins; when several names share
 * one namespace, names from `prefixes` win over well-known ones. Returns `iri` unchanged when
 * nothing matches. For display only: node ids keep full IRIs.
 *
 * Asynchronous, like `parseGraph` (since 0.11.1; the same function as `compactIri` of
 * `@kgdiff/formats`). `compactIriSync` of `@kgdiff/compute` after its `init()`.
 */
export async function compactIri(
  iri: string,
  prefixes?: Readonly<Record<string, string>>,
): Promise<string> {
  return (await compute()).compactIri(iri, prefixes);
}
