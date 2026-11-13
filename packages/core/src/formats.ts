/**
 * The types of kgdiff's parsers, and the file extensions `detectFormat` knows. Values: only the
 * `FORMAT_EXTENSIONS` constant, so the package's entry exports it without loading the parsers
 * (`parseGraph`, `detectFormat` and `compactIri` load `@kgdiff/compute` on the first call).
 * `@kgdiff/compute` re-exports these declarations: both packages have the same types and the same
 * `FORMAT_EXTENSIONS` object.
 */
import type { GraphInput } from './types.js';

export type FormatId =
  /** kgdiff native JSON and the common JSON graph shapes (auto-detected). */
  | 'json'
  /** JSON-LD 1.1, with inline contexts or contexts from `JsonLdOptions.documentLoader`. */
  | 'jsonld'
  | 'turtle'
  | 'ntriples'
  | 'nquads'
  | 'trig'
  /** RDF/XML, including OWL ontologies saved by Protégé, the OWL API or ROBOT (`.owl`). */
  | 'rdfxml'
  | 'obo';

/** File extensions understood by `detectFormat` (matched case-insensitively, longest first). */
export const FORMAT_EXTENSIONS: Readonly<Record<FormatId, readonly string[]>> = {
  json: ['.json', '.kgdiff.json'],
  jsonld: ['.jsonld'],
  turtle: ['.ttl', '.turtle'],
  ntriples: ['.nt'],
  nquads: ['.nq'],
  trig: ['.trig'],
  rdfxml: ['.rdf', '.owl'],
  obo: ['.obo'],
};

/** JSON graph shapes recognised by the `json` format (reported as `ParseResult.dialect`). */
export type JsonDialect = 'kgdiff' | 'd3' | 'cytoscape' | 'g6' | 'graphology' | 'vis';

/** Stable codes of recoverable parse warnings. */
export type ParseWarningCode =
  /** RDF: quads from named graphs were merged into one graph. */
  | 'named-graphs'
  /** RDF: triples with RDF 1.2 triple terms outside reification were skipped. */
  | 'triple-terms'
  /** RDF: lists of resources became unordered edges. */
  | 'rdf-list-resources'
  /** RDF: several owl:Ontology headers; one was used for `meta`. */
  | 'multiple-ontologies'
  /** JSON (d3): nodes without ids got their array index as id. */
  | 'json-index-ids'
  /** JSON: element fields that are not part of the graph (rendering state, shape types…) were dropped. */
  | 'json-ignored-fields'
  /** JSON: numbers beyond the range of a double (`1e400`) were kept as `"Infinity"` / `"-Infinity"`. */
  | 'json-non-finite'
  /** JSON-LD: keys that expand to no IRI (no `@context` term, no `@vocab`) were dropped. */
  | 'jsonld-unmapped-terms'
  /** OBO: a stanza type other than Term / Typedef / Instance was skipped. */
  | 'obo-unknown-stanza'
  /** OBO: stanzas with the same id were merged. */
  | 'obo-duplicate-id'
  /** OBO: a term has several names; extra ones became aliases. */
  | 'obo-multiple-names'
  /** OBO: a `relationship` without relation or target was skipped. */
  | 'obo-invalid-relationship'
  /** OBO: a tag without a value was skipped. */
  | 'obo-missing-value'
  /** OBO: a `def` without quotes was kept verbatim. */
  | 'obo-unquoted-def'
  /** OBO: an `idspace` header without prefix or IRI was skipped. */
  | 'obo-invalid-idspace';

export interface RdfOptions {
  /**
   * Predicates used for node labels, in priority order (full IRIs or CURIEs with a known
   * prefix). Default rdfs:label, skos:prefLabel, schema:name, dcterms:title, foaf:name.
   * Language preference outranks predicate priority; unchosen label values become aliases.
   */
  readonly labelPredicates?: readonly string[];
  /** Predicates used for aliases. Default skos:altLabel and the oboInOwl synonym predicates. */
  readonly aliasPredicates?: readonly string[];
  /** Keep `rdf:type` as edges too (default false: types only become `node.type`). */
  readonly typeEdges?: boolean;
  /** Turn `C rdfs:subClassOf [ owl:onProperty R ; owl:someValuesFrom D ]` into an edge C –R→ D. Default true. */
  readonly owlRestrictions?: boolean;
  /**
   * Language preference for labels, e.g. ['zh', 'en']. Default: untagged, then 'en', then any.
   * A tag also matches its subtags (`en` matches `en-GB`, exact tags first); untagged labels
   * come after the listed languages unless `''` is listed explicitly. Ties break
   * lexicographically.
   */
  readonly languages?: readonly string[];
  /**
   * Extra prefixes used to compact IRIs (they win over declared prefixes). Unlike prefixes
   * declared in the file, they also apply to identities, so pass the same map for every
   * version you diff.
   */
  readonly prefixes?: Readonly<Record<string, string>>;
  /**
   * Which prefixes compact identities: edge predicates, attribute keys, types and fallback
   * labels. Default `well-known`: only the well-known prefixes, the OBO PURL rule and
   * `prefixes`, so the same graph gets the same identities whether a file declares
   * `@prefix ex:` or spells IRIs out (Turtle vs N-Triples). `declared` also uses the file's
   * own `@prefix` declarations (prettier, but a renamed prefix then reads as a change).
   * Declared prefixes are always returned in `ParseResult.prefixes` for display.
   */
  readonly compactWith?: 'well-known' | 'declared';
  /**
   * Fold statement annotations (`owl:Axiom`, `rdf:Statement`, RDF 1.2 `{| … |}` reifiers)
   * into the attrs of the annotated edge, or of the node as `<property>/<annotation>` for
   * literal-valued statements. Default true; false keeps every annotation as a blank node.
   */
  readonly foldAnnotations?: boolean;
}

export interface JsonOptions {
  /**
   * Override field detection for custom shapes. Values are keys or dotted paths, looked up in
   * the element's property record (`data` for Cytoscape / G6, `attributes` for graphology,
   * the element itself otherwise), then in the raw element.
   */
  readonly fields?: {
    readonly id?: string;
    readonly label?: string;
    readonly type?: string;
    readonly source?: string;
    readonly target?: string;
    readonly predicate?: string;
  };
}

export interface JsonLdOptions {
  /**
   * Provides remote JSON-LD contexts (`"@context": "https://…"`, `@import`): called once per
   * URL, it returns the context document — parsed JSON or JSON text — or `undefined` when it
   * has none. Must be synchronous; load what a document needs beforehand. Default: none, as
   * kgdiff never fetches anything (for safety and reproducible diffs), so a remote context
   * without a loader is an `invalid-input` error. Inline contexts need no loader.
   */
  readonly documentLoader?: (url: string) => unknown;
}

export interface ParseOptions {
  /** Default `auto`: detect from `filename` and content. */
  readonly format?: FormatId | 'auto';
  /** Used for format detection and as `meta.source`. */
  readonly filename?: string;
  /**
   * Base IRI for relative IRIs in RDF (Turtle, RDF/XML, JSON-LD). Without one, relative IRIs
   * stay relative.
   */
  readonly baseIRI?: string;
  /** Mapping options for every RDF syntax (Turtle family, RDF/XML, JSON-LD). */
  readonly rdf?: RdfOptions;
  readonly json?: JsonOptions;
  readonly jsonld?: JsonLdOptions;
}

export interface ParseWarning {
  readonly code: ParseWarningCode;
  readonly message: string;
  /** 1-based line, when known. */
  readonly line?: number;
}

export interface ParseResult {
  readonly graph: GraphInput;
  /**
   * The format that was read: the requested or detected one (a JSON-LD document read as
   * `json` reports `jsonld`).
   */
  readonly format: FormatId;
  /** Detected JSON dialect (json format only). */
  readonly dialect?: JsonDialect;
  /** Prefix map (declared + well-known) for compact display of IRIs. */
  readonly prefixes: Readonly<Record<string, string>>;
  /**
   * Display names the source gives its relations, by edge predicate: an RDF property's own
   * label (`BFO:0000050` → “part of”), an OBO `[Typedef]` name, or kgdiff JSON
   * `meta.predicateLabels`. Edge `label`s derive from the predicate alone, so declarations
   * coming and going never relabel edges. Also stored as `graph.meta.predicateLabels`.
   */
  readonly predicateLabels: Readonly<Record<string, string>>;
  readonly warnings: readonly ParseWarning[];
}
