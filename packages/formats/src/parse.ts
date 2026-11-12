/**
 * The TypeScript parsers behind `@kgdiff/formats` up to 0.10, synchronous. Since 0.11 the
 * package's `parseGraph`, `detectFormat` and `compactIri` run kgdiff's parsers through
 * `@kgdiff/compute`; this file is kept for the TypeScript corpus generator (`sync.ts`) until it
 * moves to Rust, and is deleted with the rest of the package's TypeScript code.
 */
import type { GraphInput } from '@kgdiff/core';
import { detect, FORMAT_EXTENSIONS, isJsonLd } from './detect.js';
import type { FormatId, JsonDialect, ParseOptions, ParseResult } from './index.js';
import { parseJson, parseJsonText } from './json.js';
import { readJsonLd } from './jsonld.js';
import { parseObo } from './obo.js';
import { tableFor, WELL_KNOWN_PREFIXES } from './prefixes.js';
import { mapRdf, readN3 } from './rdf.js';
import { readRdfXml } from './rdfxml.js';
import { assertNever, invalidInput, isRecord, makeMeta, Warnings } from './shared.js';

const FORMAT_IDS: ReadonlySet<string> = new Set(Object.keys(FORMAT_EXTENSIONS));

/**
 * Parse graph text in any supported format. Throws `KgdiffError('invalid-input')` with line
 * info on syntax errors.
 *
 * - `format` defaults to `auto` (`detectFormat(text, filename)`).
 * - `meta.source` is set to `filename` when given.
 * - Every RDF syntax (Turtle, N-Triples, N-Quads, TriG, RDF/XML, JSON-LD) maps through the same
 *   conventions, so one graph gives the same `GraphInput` in any of them.
 * - Synchronous and offline: JSON-LD remote contexts come only from `jsonld.documentLoader`.
 * - Recoverable oddities (named graphs merged, unsupported OBO stanzas, d3 index ids, …) are
 *   reported in `warnings` instead of failing.
 *
 * Linear in the input size (plus sorting the output); 50k triples parse in well under a second.
 */
export function parseGraph(text: string, options: ParseOptions = {}): ParseResult {
  if (typeof text !== 'string')
    throw invalidInput('parseGraph expects the file content as a string.');
  const requested = options.format ?? 'auto';
  if (requested !== 'auto' && !FORMAT_IDS.has(requested)) {
    throw invalidInput(
      `Unknown format "${String(requested)}". Expected auto, ${[...FORMAT_IDS].join(', ')}.`,
    );
  }
  let format = requested === 'auto' ? detectFormat(text, options.filename) : requested;
  const warnings = new Warnings();
  let parsed: {
    readonly graph: GraphInput;
    readonly prefixes?: Readonly<Record<string, string>>;
    readonly predicateLabels: Readonly<Record<string, string>>;
    readonly dialect?: JsonDialect;
  };
  switch (format) {
    case 'json':
    case 'jsonld': {
      const data = parseJsonText(text);
      // JSON-LD is RDF, also when it arrives as plain `.json`.
      if (format === 'jsonld' || isJsonLd(data)) {
        format = 'jsonld';
        const jsonld = { ...options.jsonld, baseIRI: options.baseIRI };
        parsed = mapRdf(readJsonLd(data, jsonld, warnings), options.rdf, warnings);
      } else parsed = parseJson(data, options.json, warnings);
      break;
    }
    case 'obo':
      parsed = parseObo(text, warnings);
      break;
    case 'turtle':
    case 'ntriples':
    case 'nquads':
    case 'trig':
      parsed = mapRdf(readN3(text, format, options.baseIRI), options.rdf, warnings);
      break;
    case 'rdfxml':
      parsed = mapRdf(readRdfXml(text, options.baseIRI), options.rdf, warnings);
      break;
    default:
      return assertNever(format);
  }
  let { graph } = parsed;
  const { predicateLabels, dialect, prefixes = WELL_KNOWN_PREFIXES } = parsed;
  const hasLabels = Object.keys(predicateLabels).length > 0;
  if (options.filename !== undefined || hasLabels) {
    const meta = makeMeta({
      ...(isRecord(graph.meta) ? graph.meta : {}),
      ...(hasLabels ? { predicateLabels } : {}),
      ...(options.filename !== undefined ? { source: options.filename } : {}),
    });
    graph = { ...graph, ...(meta ? { meta } : {}) };
  }
  return {
    graph,
    format,
    ...(dialect !== undefined ? { dialect } : {}),
    prefixes,
    predicateLabels,
    warnings: warnings.finish(),
  };
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
 */
export function detectFormat(text: string, filename?: string): FormatId {
  return detect(text, filename);
}

/**
 * Compact an IRI with a prefix map: `http://purl.obolibrary.org/obo/GO_0008150` → `GO:0008150`.
 *
 * Uses the well-known prefixes (rdf, rdfs, owl, xsd, skos, schema, dcterms, dc, foaf, prov,
 * oboInOwl, obo) overlaid with `prefixes`; OBO PURLs follow the OBO rule unless `prefixes`
 * binds that id space elsewhere. The longest matching namespace wins; when several names share
 * one namespace, names from `prefixes` win over well-known ones. Returns `iri` unchanged when
 * nothing matches. For display only: node ids keep full IRIs.
 */
export function compactIri(iri: string, prefixes?: Readonly<Record<string, string>>): string {
  return tableFor(prefixes).compact(iri);
}
