/**
 * @kgdiff/formats: turn real-world graph files into kgdiff `GraphInput`s.
 *
 * @deprecated Since 0.11 this package is a thin asynchronous layer over `@kgdiff/compute`,
 * which runs kgdiff's Rust parsers compiled to WebAssembly. Since 0.11.1 `@kgdiff/core` exports
 * everything it does, with the same signatures and results: import from `@kgdiff/core` instead
 * (or use `init()` and the `*Sync` forms of `@kgdiff/compute`). Its types and `FORMAT_EXTENSIONS`
 * are `@kgdiff/compute`'s, re-exported here until the package is removed in 2.0.
 *
 * Isomorphic (browser + Node), no file-system or network access: callers pass text. Every parser
 * maps its source into the same `GraphInput` conventions (docs/architecture.md §Formats) so
 * diffs across formats behave identically.
 *
 * Output is deterministic: the same text and options always give an identical result, with
 * nodes sorted by id, edges by (source, predicate, target), attribute keys sorted and
 * multi-valued fields as sorted arrays.
 */
import {
  compactIri as computeCompactIri,
  detectFormat as computeDetectFormat,
  parseGraph as computeParseGraph,
  type FormatId,
  type ParseOptions,
  type ParseResult,
} from '@kgdiff/compute';

// Defined by `@kgdiff/core` since 0.11.1; `@kgdiff/compute` exports the same declarations.
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
} from '@kgdiff/compute';

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
 * Linear in the input size (plus sorting the output); 50k triples parse in well under a second.
 *
 * Asynchronous since 0.11: kgdiff's parsers run it (`@kgdiff/compute`'s `formats` module, loaded
 * and compiled on the first call), so the result is the kgdiff CLI's.
 *
 * @deprecated Use `parseGraph` of `@kgdiff/core` (the same function), or `parseGraphSync` of
 * `@kgdiff/compute` after its `init()`.
 */
export async function parseGraph(text: string, options: ParseOptions = {}): Promise<ParseResult> {
  return computeParseGraph(text, options);
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
 * Asynchronous since 0.11: kgdiff's parsers run it (`@kgdiff/compute`'s `formats` module, loaded
 * and compiled on the first call), so the result is the kgdiff CLI's.
 *
 * @deprecated Use `detectFormat` of `@kgdiff/core` (the same function), or `detectFormatSync` of
 * `@kgdiff/compute` after its `init()`.
 */
export async function detectFormat(text: string, filename?: string): Promise<FormatId> {
  return computeDetectFormat(text, filename);
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
 * Asynchronous since 0.11: kgdiff's parsers run it (`@kgdiff/compute`'s `formats` module, loaded
 * and compiled on the first call), so the result is the kgdiff CLI's.
 *
 * @deprecated Use `compactIri` of `@kgdiff/core` (the same function), or `compactIriSync` of
 * `@kgdiff/compute` after its `init()`.
 */
export async function compactIri(
  iri: string,
  prefixes?: Readonly<Record<string, string>>,
): Promise<string> {
  return computeCompactIri(iri, prefixes);
}
