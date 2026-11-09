/**
 * JSON-LD 1.1 → RDF quads, synchronously: context processing, expansion and deserialization to
 * RDF (JSON-LD 1.1 Processing Algorithms and API §4, §5, §8). The quads go through the same
 * mapping as Turtle (`rdf.ts`), so a graph diffs identically in either syntax.
 *
 *  - Contexts are inline, or come from the caller's synchronous `documentLoader` (remote
 *    `@context` URLs, `@import`). Nothing is ever fetched: results never depend on the network.
 *  - Without a base IRI, relative IRIs stay relative (as in Turtle without `@base`) instead of
 *    being dropped; IRIs with characters RDF forbids are dropped, as the spec says.
 *  - Keys that expand to no IRI (no term, no `@vocab`) are dropped and reported together.
 *  - `@direction` is not represented (`rdfDirection: null`); named graphs are merged like
 *    N-Quads graphs; `@json` literals use JCS canonical JSON.
 *  - Errors carry the JSON-LD error code (`invalid IRI mapping`, `protected term redefinition`…).
 */
import { BlankNode, DataFactory, type Literal, NamedNode, type Quad } from 'n3';
import type { JsonLdOptions } from './index.js';
import { isAbsoluteIri, resolveIri } from './iri.js';
import { loneSurrogateEscape, loneSurrogateReason } from './json.js';
import { RDF_NS, XSD_NS } from './prefixes.js';
import type { RdfDocument } from './rdf.js';
import { compareStrings, invalidInput, plural, setOwn, type Warnings } from './shared.js';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonMap;
type JsonMap = { [key: string]: JsonValue };

type Direction = 'ltr' | 'rtl';

interface TermDefinition {
  /** IRI mapping: an IRI, a blank node id, a keyword, or null for a term that maps to nothing. */
  iri: string | null;
  prefix: boolean;
  protected: boolean;
  reverse: boolean;
  type?: string;
  language?: string | null;
  direction?: Direction | null;
  /** Container mapping, sorted. */
  container: readonly string[];
  index?: string;
  nest?: string;
  /** Scoped context and the base URL it was defined with. */
  context?: JsonValue;
  baseUrl?: string | undefined;
}

interface Context {
  readonly terms: ReadonlyMap<string, TermDefinition>;
  readonly base: string | undefined;
  readonly originalBase: string | undefined;
  readonly vocab: string | undefined;
  readonly language: string | undefined;
  readonly direction: Direction | undefined;
  /** The context to return to on new node objects, set by non-propagated contexts. */
  readonly previous: Context | undefined;
}

type MutableContext = { -readonly [K in keyof Context]: Context[K] } & {
  terms: Map<string, TermDefinition>;
};

/** Where term definitions are being created: the local context and its processing state. */
interface Definitions {
  readonly local: JsonMap;
  readonly defined: Map<string, boolean>;
  readonly baseUrl: string | undefined;
  readonly overrideProtected: boolean;
  readonly remote: readonly string[];
  readonly validateScoped: boolean;
}

/** A JSON-LD error (code from the spec, plus what it concerns); never escapes this module. */
class JsonLdError {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {}
}

/** Offending JSON values are quoted in messages up to this length. */
const DETAIL_LENGTH = 120;

/** `detail` is an explanation, or a JSON value quoted (and cut) as found. */
const fail = (code: string, detail: unknown): JsonLdError => {
  if (typeof detail === 'string') return new JsonLdError(code, detail);
  const text = JSON.stringify(detail) ?? String(detail);
  return new JsonLdError(
    code,
    text.length > DETAIL_LENGTH ? `${text.slice(0, DETAIL_LENGTH)}…` : text,
  );
};

const KEYWORDS: ReadonlySet<string> = new Set([
  '@base',
  '@container',
  '@context',
  '@direction',
  '@graph',
  '@id',
  '@import',
  '@included',
  '@index',
  '@json',
  '@language',
  '@list',
  '@nest',
  '@none',
  '@prefix',
  '@propagate',
  '@protected',
  '@reverse',
  '@set',
  '@type',
  '@value',
  '@version',
  '@vocab',
]);

/** Context entries that are not term definitions. */
const CONTEXT_KEYWORDS: ReadonlySet<string> = new Set([
  '@base',
  '@direction',
  '@import',
  '@language',
  '@propagate',
  '@protected',
  '@version',
  '@vocab',
]);

const TERM_DEFINITION_KEYS: ReadonlySet<string> = new Set([
  '@id',
  '@reverse',
  '@container',
  '@context',
  '@direction',
  '@index',
  '@language',
  '@nest',
  '@prefix',
  '@protected',
  '@type',
]);

const CONTAINERS: ReadonlySet<string> = new Set([
  '@graph',
  '@id',
  '@index',
  '@language',
  '@list',
  '@set',
  '@type',
]);

const VALUE_KEYS: ReadonlySet<string> = new Set([
  '@direction',
  '@index',
  '@language',
  '@type',
  '@value',
]);

/** Reserved for future keywords: ignored, never expanded (JSON-LD 1.1 §3.3). */
const KEYWORD_FORM = /^@[a-zA-Z]+$/;
/** An IRI ending like this can serve as a prefix (gen-delims, RFC 3986). */
const GEN_DELIM_END = /[:/?#[\]@]$/;
/** Characters an RDF IRI cannot contain besides controls and the space (RFC 3987). */
const ILLEGAL_IRI_CHARACTERS = '<>"{}|\\^`';
const LANGUAGE_TAG = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;
/** More remote contexts than this in one chain is a `context overflow`. */
const MAX_REMOTE_CONTEXTS = 32;
/**
 * Deepest nesting accepted. Expansion recurses (about three stack frames per level), so this
 * stays far below what small engine stacks allow; real documents nest a few levels.
 */
export const MAX_JSON_LD_NESTING = 200;

const RDF_TYPE = `${RDF_NS}type`;
const RDF_FIRST = `${RDF_NS}first`;
const RDF_REST = `${RDF_NS}rest`;
const RDF_NIL = `${RDF_NS}nil`;
const RDF_JSON = `${RDF_NS}JSON`;
const RDF_LANG_STRING = `${RDF_NS}langString`;
const XSD_BOOLEAN = `${XSD_NS}boolean`;
const XSD_DOUBLE = `${XSD_NS}double`;
const XSD_INTEGER = `${XSD_NS}integer`;

const isMap = (value: JsonValue | undefined): value is JsonMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (map: JsonMap, key: string): boolean => Object.hasOwn(map, key);
const arrayify = (value: JsonValue): JsonValue[] => (Array.isArray(value) ? value : [value]);
const isScalar = (value: JsonValue): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
const isValueObject = (value: JsonValue): boolean => isMap(value) && has(value, '@value');
const isListObject = (value: JsonValue): boolean => isMap(value) && has(value, '@list');
const isGraphObject = (value: JsonValue): boolean =>
  isMap(value) &&
  has(value, '@graph') &&
  Object.keys(value).every((key) => key === '@graph' || key === '@id' || key === '@index');
const isNodeObject = (value: JsonValue): boolean =>
  isMap(value) && !has(value, '@value') && !has(value, '@list') && !has(value, '@set');

/** Appends values to `map[key]`, which always holds an array. */
function addValues(map: JsonMap, key: string, values: readonly JsonValue[]): void {
  const existing = map[key];
  if (Array.isArray(existing)) for (const value of values) existing.push(value);
  else setOwn(map, key, existing === undefined ? [...values] : [existing, ...values]);
}

/** Container mappings JSON-LD 1.1 allows (§4.2.2, step 21.1). */
function validContainer(container: readonly string[]): boolean {
  const set = new Set(container);
  if (set.size !== container.length || !container.every((value) => CONTAINERS.has(value))) {
    return false;
  }
  if (container.length === 1) return true;
  if (set.has('@list')) return false;
  if (set.has('@graph') && (set.has('@id') || set.has('@index'))) {
    return (
      !(set.has('@id') && set.has('@index')) &&
      container.every((value) => value !== '@type' && value !== '@language')
    );
  }
  return set.has('@set') && container.length === 2;
}

const isThenable = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Reads a parsed JSON-LD document into quads. Throws `KgdiffError('invalid-input')` with the
 * JSON-LD error code for invalid documents and for remote contexts no loader provides.
 */
export function readJsonLd(
  document: unknown,
  options: JsonLdOptions & { readonly baseIRI?: string | undefined },
  warnings: Warnings,
): RdfDocument {
  const reader = new JsonLdReader(options.baseIRI, options.documentLoader);
  try {
    reader.read(document as JsonValue);
  } catch (error) {
    if (!(error instanceof JsonLdError)) throw error;
    throw invalidInput(`Invalid JSON-LD: ${error.code}: ${error.detail}.`, {
      format: 'jsonld',
      code: error.code,
    });
  }
  if (reader.unmapped.size > 0) {
    const keys = [...reader.unmapped].sort(compareStrings);
    const shown = keys.slice(0, 5).map((key) => JSON.stringify(key));
    warnings.add(
      'jsonld-unmapped-terms',
      `Dropped ${plural(keys.length, 'JSON-LD key')} that map to no IRI (no @context term or @vocab): ${shown.join(', ')}${keys.length > shown.length ? ', …' : ''}.`,
    );
  }
  return { quads: reader.quads, prefixes: reader.prefixes };
}

class JsonLdReader {
  readonly quads: Quad[] = [];
  readonly prefixes: Record<string, string> = {};
  /** Keys dropped because they expand to no IRI. */
  readonly unmapped = new Set<string>();
  /** `@context` of every remote document, by URL (loaded once per parse). */
  private readonly loaded = new Map<string, JsonValue>();
  private readonly scoped = new WeakMap<Context, Map<JsonValue, Map<string, Context>>>();
  private readonly iris = new Map<string, NamedNode>();
  private readonly defaultGraph = DataFactory.defaultGraph();
  private blanks = 0;

  constructor(
    private readonly baseIRI: string | undefined,
    private readonly documentLoader: ((url: string) => unknown) | undefined,
  ) {}

  read(document: JsonValue): void {
    const initial: Context = {
      terms: new Map(),
      base: this.baseIRI,
      originalBase: this.baseIRI,
      vocab: undefined,
      language: undefined,
      direction: undefined,
      previous: undefined,
    };
    let expanded = this.expand(initial, null, document, this.baseIRI, false, 0);
    if (isMap(expanded) && Object.keys(expanded).length === 1 && has(expanded, '@graph')) {
      expanded = expanded['@graph'] ?? null;
    }
    for (const node of arrayify(expanded)) {
      if (isMap(node)) this.emitNode(node, this.defaultGraph);
    }
  }

  // ─── Context processing (§4.1) ──────────────────────────────────────────

  private processContext(
    active: Context,
    localContext: JsonValue,
    baseUrl: string | undefined,
    remote: readonly string[],
    overrideProtected: boolean,
    propagateDefault: boolean,
    validateScoped: boolean,
  ): MutableContext {
    let result: MutableContext = { ...active, terms: new Map(active.terms) };
    let propagate = propagateDefault;
    if (isMap(localContext) && has(localContext, '@propagate')) {
      const value = localContext['@propagate'];
      if (typeof value !== 'boolean') throw fail('invalid @propagate value', value ?? null);
      propagate = value;
    }
    if (!propagate && result.previous === undefined) result.previous = active;
    for (const context of arrayify(localContext)) {
      if (context === null) {
        if (!overrideProtected && [...result.terms.values()].some((term) => term.protected)) {
          throw fail('invalid context nullification', 'a context with protected terms');
        }
        const previous = result;
        result = {
          terms: new Map(),
          base: active.originalBase,
          originalBase: active.originalBase,
          vocab: undefined,
          language: undefined,
          direction: undefined,
          previous: propagate ? undefined : previous,
        };
        continue;
      }
      if (typeof context === 'string') {
        const url = resolveIri(context, baseUrl);
        if (!validateScoped && remote.includes(url)) continue;
        if (remote.length >= MAX_REMOTE_CONTEXTS) throw fail('context overflow', url);
        const loaded = this.remoteContext(url);
        result = this.processContext(
          result,
          loaded,
          url,
          [...remote, url],
          false,
          true,
          validateScoped,
        );
        continue;
      }
      if (!isMap(context)) throw fail('invalid local context', context);
      let map = context;
      if (has(map, '@version') && map['@version'] !== 1.1) {
        throw fail('invalid @version value', map['@version'] ?? null);
      }
      if (has(map, '@import')) {
        const value = map['@import'];
        if (typeof value !== 'string') throw fail('invalid @import value', value ?? null);
        const imported = this.remoteContext(resolveIri(value, baseUrl));
        if (!isMap(imported)) throw fail('invalid remote context', value);
        if (has(imported, '@import')) throw fail('invalid context entry', `${value} has @import`);
        map = { ...imported, ...map };
      }
      if (has(map, '@base') && remote.length === 0) {
        const value = map['@base'];
        if (value === null) result.base = undefined;
        else if (typeof value === 'string') {
          // Lenient where the spec errs: a relative @base without a base stays relative.
          result.base =
            isAbsoluteIri(value) || result.base === undefined
              ? value
              : resolveIri(value, result.base);
        } else throw fail('invalid base IRI', value ?? null);
      }
      if (has(map, '@vocab')) {
        const value = map['@vocab'];
        if (value === null) result.vocab = undefined;
        else if (typeof value === 'string') {
          const vocab = this.expandIri(result, value, { vocab: true, documentRelative: true });
          if (vocab === null || KEYWORDS.has(vocab)) throw fail('invalid vocab mapping', value);
          result.vocab = vocab;
        } else throw fail('invalid vocab mapping', value ?? null);
      }
      if (has(map, '@language')) {
        const value = map['@language'];
        if (value === null) result.language = undefined;
        else if (typeof value === 'string') result.language = value.toLowerCase();
        else throw fail('invalid default language', value ?? null);
      }
      if (has(map, '@direction')) {
        const value = map['@direction'];
        if (value === null) result.direction = undefined;
        else if (value === 'ltr' || value === 'rtl') result.direction = value;
        else throw fail('invalid base direction', value ?? null);
      }
      if (has(map, '@protected') && typeof map['@protected'] !== 'boolean') {
        throw fail('invalid @protected value', map['@protected'] ?? null);
      }
      const definitions: Definitions = {
        local: map,
        defined: new Map(),
        baseUrl,
        overrideProtected,
        remote,
        validateScoped,
      };
      for (const term of Object.keys(map)) {
        if (!CONTEXT_KEYWORDS.has(term)) this.createTermDefinition(result, term, definitions);
      }
    }
    return result;
  }

  /** Context processing for property-, type- and map-scoped contexts, memoized per context. */
  private scopedContext(
    active: Context,
    local: JsonValue,
    baseUrl: string | undefined,
    overrideProtected: boolean,
    propagate: boolean,
  ): Context {
    let byLocal = this.scoped.get(active);
    if (!byLocal) {
      byLocal = new Map();
      this.scoped.set(active, byLocal);
    }
    let byFlags = byLocal.get(local);
    if (!byFlags) {
      byFlags = new Map();
      byLocal.set(local, byFlags);
    }
    const key = `${overrideProtected}|${propagate}|${baseUrl ?? ''}`;
    let context = byFlags.get(key);
    if (!context) {
      context = this.processContext(active, local, baseUrl, [], overrideProtected, propagate, true);
      byFlags.set(key, context);
    }
    return context;
  }

  /** The `@context` of a remote document, from the caller's loader (never the network). */
  private remoteContext(url: string): JsonValue {
    const cached = this.loaded.get(url);
    if (cached !== undefined) return cached;
    if (!this.documentLoader) {
      throw fail(
        'loading remote context failed',
        `"${url}" was not loaded, as kgdiff never fetches documents; inline the context, or pass ParseOptions.jsonld.documentLoader`,
      );
    }
    let document: unknown;
    try {
      document = this.documentLoader(url);
    } catch (error) {
      throw fail(
        'loading remote context failed',
        `"${url}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (isThenable(document)) {
      throw fail(
        'loading remote context failed',
        `documentLoader returned a Promise for "${url}"; it must return the document itself (load contexts beforehand)`,
      );
    }
    if (typeof document === 'string') {
      const text = document;
      try {
        document = JSON.parse(text);
      } catch {
        throw fail('loading remote context failed', `"${url}" is not JSON`);
      }
      // RFC 0002, D-2: as for the document itself (`parseJsonText`).
      const lone = loneSurrogateEscape(text);
      if (lone !== -1) {
        throw fail('loading remote context failed', `"${url}": ${loneSurrogateReason(text, lone)}`);
      }
    }
    if (document === undefined || document === null) {
      throw fail('loading remote context failed', `documentLoader has no document for "${url}"`);
    }
    if (!isMap(document as JsonValue) || !has(document as JsonMap, '@context')) {
      throw fail('invalid remote context', url);
    }
    const context = (document as JsonMap)['@context'] ?? null;
    this.loaded.set(url, context);
    return context;
  }

  // ─── Term definitions (§4.2) ────────────────────────────────────────────

  private createTermDefinition(active: MutableContext, term: string, scope: Definitions): void {
    const { local, defined } = scope;
    const state = defined.get(term);
    if (state === true) return;
    if (state === false) throw fail('cyclic IRI mapping', term);
    if (term === '') throw fail('invalid term definition', 'an empty term');
    defined.set(term, false);
    const raw = local[term] ?? null;
    if (term === '@type' && isMap(raw)) {
      const keys = Object.keys(raw);
      const valid =
        keys.length > 0 && keys.every((key) => key === '@container' || key === '@protected');
      if (!valid || (has(raw, '@container') && raw['@container'] !== '@set')) {
        throw fail('keyword redefinition', term);
      }
    } else if (KEYWORDS.has(term)) throw fail('keyword redefinition', term);
    else if (KEYWORD_FORM.test(term)) {
      defined.set(term, true);
      return;
    }
    const previous = active.terms.get(term);
    active.terms.delete(term);
    let value: JsonMap;
    let simpleTerm = false;
    if (raw === null) value = { '@id': null };
    else if (typeof raw === 'string') {
      value = { '@id': raw };
      simpleTerm = true;
    } else if (isMap(raw)) value = raw;
    else throw fail('invalid term definition', term);

    const protectedDefault = local['@protected'] === true;
    const definition: TermDefinition = {
      iri: null,
      prefix: false,
      protected: protectedDefault,
      reverse: false,
      container: [],
    };
    if (has(value, '@protected')) {
      const flag = value['@protected'];
      if (typeof flag !== 'boolean') throw fail('invalid @protected value', term);
      definition.protected = flag;
    }
    if (has(value, '@type')) {
      const type = value['@type'];
      if (typeof type !== 'string') throw fail('invalid type mapping', term);
      const expanded = this.expandIri(active, type, { vocab: true, definitions: scope });
      const keywordType =
        expanded === '@id' || expanded === '@json' || expanded === '@none' || expanded === '@vocab';
      if (
        expanded === null ||
        (!keywordType && (KEYWORDS.has(expanded) || !isAbsoluteIri(expanded)))
      ) {
        throw fail('invalid type mapping', term);
      }
      definition.type = expanded;
    }
    if (has(value, '@reverse')) {
      if (has(value, '@id') || has(value, '@nest')) throw fail('invalid reverse property', term);
      const reverse = value['@reverse'];
      if (typeof reverse !== 'string') throw fail('invalid IRI mapping', term);
      if (KEYWORD_FORM.test(reverse) && !KEYWORDS.has(reverse)) {
        defined.set(term, true);
        return;
      }
      const iri = this.expandIri(active, reverse, { vocab: true, definitions: scope });
      if (iri === null || !iri.includes(':')) throw fail('invalid IRI mapping', term);
      definition.iri = iri;
      if (has(value, '@container')) {
        const container = value['@container'];
        if (container !== null && container !== '@set' && container !== '@index') {
          throw fail('invalid reverse property', term);
        }
        definition.container = container === null ? [] : [container];
      }
      definition.reverse = true;
      active.terms.set(term, definition);
      defined.set(term, true);
      return;
    }
    if (has(value, '@id') && value['@id'] !== term) {
      const id = value['@id'];
      if (id !== null) {
        if (typeof id !== 'string') throw fail('invalid IRI mapping', term);
        if (KEYWORD_FORM.test(id) && !KEYWORDS.has(id)) {
          defined.set(term, true);
          return;
        }
        const iri = this.expandIri(active, id, { vocab: true, definitions: scope });
        if (iri === null || (!KEYWORDS.has(iri) && !iri.includes(':'))) {
          throw fail('invalid IRI mapping', term);
        }
        if (iri === '@context') throw fail('invalid keyword alias', term);
        definition.iri = iri;
        const colon = term.indexOf(':', 1);
        if ((colon > 0 && colon < term.length - 1) || term.includes('/')) {
          defined.set(term, true);
          const expandedTerm = this.expandIri(active, term, { vocab: true, definitions: scope });
          if (expandedTerm !== iri)
            throw fail('invalid IRI mapping', `${term} does not expand to its @id`);
        }
        if (
          !term.includes(':') &&
          !term.includes('/') &&
          simpleTerm &&
          (GEN_DELIM_END.test(iri) || iri.startsWith('_:'))
        ) {
          definition.prefix = true;
        }
      }
    } else if (term.indexOf(':', 1) > 0) {
      const colon = term.indexOf(':', 1);
      const prefix = term.slice(0, colon);
      if (has(local, prefix)) this.createTermDefinition(active, prefix, scope);
      const prefixIri = active.terms.get(prefix)?.iri;
      definition.iri =
        prefixIri !== undefined && prefixIri !== null ? prefixIri + term.slice(colon + 1) : term;
    } else if (term.includes('/')) {
      const iri = this.expandIri(active, term, { vocab: true });
      if (iri === null || !isAbsoluteIri(iri)) throw fail('invalid IRI mapping', term);
      definition.iri = iri;
    } else if (term === '@type') {
      definition.iri = '@type';
    } else if (active.vocab !== undefined) {
      definition.iri = active.vocab + term;
    } else {
      throw fail('invalid IRI mapping', `${term} (no @id and no @vocab)`);
    }
    if (has(value, '@container')) {
      const raw = value['@container'];
      const container = Array.isArray(raw) ? raw : [raw];
      if (
        !container.every((item): item is string => typeof item === 'string') ||
        !validContainer(container)
      ) {
        throw fail('invalid container mapping', term);
      }
      definition.container = [...container].sort(compareStrings);
      if (container.includes('@type')) {
        if (definition.type === undefined) definition.type = '@id';
        else if (definition.type !== '@id' && definition.type !== '@vocab') {
          throw fail('invalid type mapping', term);
        }
      }
    }
    if (has(value, '@index')) {
      const index = value['@index'];
      if (!definition.container.includes('@index') || typeof index !== 'string') {
        throw fail('invalid term definition', term);
      }
      const expanded = this.expandIri(active, index, { vocab: true });
      if (expanded === null || KEYWORDS.has(expanded) || !isAbsoluteIri(expanded)) {
        throw fail('invalid term definition', term);
      }
      definition.index = index;
    }
    if (has(value, '@context')) {
      const context = value['@context'] ?? null;
      try {
        this.processContext(active, context, scope.baseUrl, scope.remote, true, true, false);
      } catch (error) {
        if (error instanceof JsonLdError) throw fail('invalid scoped context', term);
        throw error;
      }
      definition.context = context;
      definition.baseUrl = scope.baseUrl;
    }
    if (has(value, '@language') && !has(value, '@type')) {
      const language = value['@language'];
      if (language !== null && typeof language !== 'string') {
        throw fail('invalid language mapping', term);
      }
      definition.language = language === null ? null : language.toLowerCase();
    }
    if (has(value, '@direction') && !has(value, '@type')) {
      const direction = value['@direction'];
      if (direction !== null && direction !== 'ltr' && direction !== 'rtl') {
        throw fail('invalid base direction', term);
      }
      definition.direction = direction;
    }
    if (has(value, '@nest')) {
      const nest = value['@nest'];
      if (typeof nest !== 'string' || (KEYWORDS.has(nest) && nest !== '@nest')) {
        throw fail('invalid @nest value', term);
      }
      definition.nest = nest;
    }
    if (has(value, '@prefix')) {
      const prefix = value['@prefix'];
      if (term.includes(':') || term.includes('/')) throw fail('invalid term definition', term);
      if (typeof prefix !== 'boolean') throw fail('invalid @prefix value', term);
      if (prefix && definition.iri !== null && KEYWORDS.has(definition.iri)) {
        throw fail('invalid term definition', term);
      }
      definition.prefix = prefix;
    }
    for (const key of Object.keys(value)) {
      if (!TERM_DEFINITION_KEYS.has(key)) throw fail('invalid term definition', `${term}: ${key}`);
    }
    if (!scope.overrideProtected && previous?.protected) {
      if (!sameDefinition(previous, definition)) throw fail('protected term redefinition', term);
      active.terms.set(term, previous);
    } else active.terms.set(term, definition);
    defined.set(term, true);
  }

  // ─── IRI expansion (§5.2) ───────────────────────────────────────────────

  private expandIri(
    active: Context,
    value: string,
    options: {
      readonly vocab?: boolean;
      readonly documentRelative?: boolean;
      readonly definitions?: Definitions;
    },
  ): string | null {
    if (KEYWORDS.has(value)) return value;
    if (KEYWORD_FORM.test(value)) return null;
    const scope = options.definitions;
    if (scope && has(scope.local, value) && scope.defined.get(value) !== true) {
      this.createTermDefinition(active as MutableContext, value, scope);
    }
    const definition = active.terms.get(value);
    if (definition?.iri != null && KEYWORDS.has(definition.iri)) return definition.iri;
    if (options.vocab && definition !== undefined) return definition.iri;
    const colon = value.indexOf(':', 1);
    if (colon > 0) {
      const prefix = value.slice(0, colon);
      const suffix = value.slice(colon + 1);
      if (prefix === '_' || suffix.startsWith('//')) return value;
      if (scope && has(scope.local, prefix) && scope.defined.get(prefix) !== true) {
        this.createTermDefinition(active as MutableContext, prefix, scope);
      }
      const prefixDefinition = active.terms.get(prefix);
      if (prefixDefinition?.iri != null && prefixDefinition.prefix) {
        return prefixDefinition.iri + suffix;
      }
      if (isAbsoluteIri(value)) return value;
    }
    if (options.vocab && active.vocab !== undefined) return active.vocab + value;
    if (options.documentRelative) return resolveIri(value, active.base);
    return value;
  }

  // ─── Expansion (§5.1) ───────────────────────────────────────────────────

  private expand(
    active: Context,
    activeProperty: string | null,
    element: JsonValue,
    baseUrl: string | undefined,
    fromMap: boolean,
    depth: number,
  ): JsonValue {
    if (depth > MAX_JSON_LD_NESTING) {
      throw invalidInput(
        `JSON-LD nested deeper than ${MAX_JSON_LD_NESTING} levels is not supported.`,
        {
          format: 'jsonld',
        },
      );
    }
    if (element === null) return null;
    const definition = activeProperty === null ? undefined : active.terms.get(activeProperty);
    if (isScalar(element)) {
      if (activeProperty === null || activeProperty === '@graph') return null;
      const context =
        definition?.context !== undefined
          ? this.scopedContext(active, definition.context, definition.baseUrl, false, true)
          : active;
      return this.expandValue(context, activeProperty, element);
    }
    if (Array.isArray(element)) {
      const result: JsonValue[] = [];
      const list = definition?.container.includes('@list') ?? false;
      for (const item of element) {
        let expanded = this.expand(active, activeProperty, item, baseUrl, fromMap, depth + 1);
        if (list && Array.isArray(expanded)) expanded = { '@list': expanded };
        if (Array.isArray(expanded)) for (const value of expanded) result.push(value);
        else if (expanded !== null) result.push(expanded);
      }
      return result;
    }
    return this.expandObject(active, activeProperty, definition, element, baseUrl, fromMap, depth);
  }

  private expandObject(
    active: Context,
    activeProperty: string | null,
    definition: TermDefinition | undefined,
    element: JsonMap,
    baseUrl: string | undefined,
    fromMap: boolean,
    depth: number,
  ): JsonValue {
    let context = active;
    const keys = Object.keys(element);
    if (context.previous !== undefined && !fromMap) {
      const keeps = keys.some((key) => {
        const expanded = this.expandIri(context, key, { vocab: true });
        return expanded === '@value' || (expanded === '@id' && keys.length === 1);
      });
      if (!keeps) context = context.previous;
    }
    if (definition?.context !== undefined) {
      context = this.scopedContext(context, definition.context, definition.baseUrl, true, true);
    }
    if (has(element, '@context')) {
      context = this.processContext(
        context,
        element['@context'] ?? null,
        baseUrl,
        [],
        false,
        true,
        true,
      );
      if (activeProperty === null) this.collectPrefixes(context);
    }
    const typeScoped = context;
    let inputType: string | undefined;
    for (const key of [...keys].sort(compareStrings)) {
      if (this.expandIri(context, key, { vocab: true }) !== '@type') continue;
      const value = element[key] ?? null;
      const types = arrayify(value)
        .filter((type): type is string => typeof type === 'string')
        .sort(compareStrings);
      for (const type of types) {
        const typeDefinition = typeScoped.terms.get(type);
        if (typeDefinition?.context !== undefined) {
          context = this.scopedContext(
            context,
            typeDefinition.context,
            typeDefinition.baseUrl,
            false,
            false,
          );
        }
      }
      if (inputType === undefined) {
        const last = arrayify(value).at(-1);
        if (typeof last === 'string')
          inputType = this.expandIri(context, last, { vocab: true }) ?? undefined;
      }
    }
    const result: JsonMap = {};
    this.expandEntries(
      context,
      typeScoped,
      activeProperty,
      element,
      baseUrl,
      result,
      inputType,
      depth,
    );

    let output: JsonValue = result;
    if (has(result, '@value')) {
      const resultKeys = Object.keys(result);
      if (
        resultKeys.some((key) => !VALUE_KEYS.has(key)) ||
        (has(result, '@type') && (has(result, '@language') || has(result, '@direction')))
      ) {
        throw fail('invalid value object', resultKeys);
      }
      const type = result['@type'];
      const value = result['@value'];
      if (type === '@json') {
        // Any JSON value.
      } else if (value === null) return null;
      else if (typeof value !== 'string' && has(result, '@language')) {
        throw fail('invalid language-tagged value', value ?? null);
      } else if (
        has(result, '@type') &&
        (typeof type !== 'string' || !isAbsoluteIri(type) || !wellFormedIri(type))
      ) {
        throw fail('invalid typed value', type ?? null);
      }
    } else if (has(result, '@type') && !Array.isArray(result['@type'])) {
      result['@type'] = [result['@type'] ?? null];
    } else if (has(result, '@set') || has(result, '@list')) {
      const resultKeys = Object.keys(result);
      if (resultKeys.length > 2 || (resultKeys.length === 2 && !has(result, '@index'))) {
        throw fail('invalid set or list object', resultKeys);
      }
      if (has(result, '@set')) output = result['@set'] ?? null;
    }
    if (isMap(output) && Object.keys(output).length === 1 && has(output, '@language')) return null;
    if ((activeProperty === null || activeProperty === '@graph') && isMap(output)) {
      const outputKeys = Object.keys(output);
      if (outputKeys.length === 0 || has(output, '@value') || has(output, '@list')) return null;
      if (outputKeys.length === 1 && has(output, '@id')) return null;
    }
    return output;
  }

  /** Step 13 (and 14, nested properties) of the expansion algorithm. */
  private expandEntries(
    context: Context,
    typeScoped: Context,
    activeProperty: string | null,
    element: JsonMap,
    baseUrl: string | undefined,
    result: JsonMap,
    inputType: string | undefined,
    depth: number,
  ): void {
    const nests: string[] = [];
    // Keys in code unit order, as jsonld.js does: the result never depends on key order.
    for (const key of Object.keys(element).sort(compareStrings)) {
      if (key === '@context') continue;
      const value = element[key] ?? null;
      const property = this.expandIri(context, key, { vocab: true });
      if (property === null || (!property.includes(':') && !KEYWORDS.has(property))) {
        this.unmapped.add(key);
        continue;
      }
      if (KEYWORDS.has(property)) {
        if (activeProperty === '@reverse') throw fail('invalid reverse property map', key);
        if (has(result, property) && property !== '@included' && property !== '@type') {
          throw fail('colliding keywords', property);
        }
        let expanded: JsonValue;
        switch (property) {
          case '@id':
            if (typeof value !== 'string') throw fail('invalid @id value', value);
            expanded = this.expandIri(context, value, { documentRelative: true });
            break;
          case '@type': {
            const types = arrayify(value);
            if (!types.every((type): type is string => typeof type === 'string')) {
              throw fail('invalid type value', value);
            }
            const iris: JsonValue[] = [];
            for (const type of types) {
              const iri = this.expandIri(typeScoped, type, { vocab: true, documentRelative: true });
              if (iri !== null) iris.push(iri);
            }
            expanded = has(result, '@type')
              ? [...arrayify(result['@type'] ?? null), ...iris]
              : iris;
            if (!Array.isArray(value) && !has(result, '@type') && iris.length === 1) {
              expanded = iris[0] ?? null;
            }
            break;
          }
          case '@graph':
            expanded = arrayify(this.expand(context, '@graph', value, baseUrl, false, depth + 1));
            break;
          case '@included': {
            const included = arrayify(this.expand(context, null, value, baseUrl, false, depth + 1));
            if (!included.every(isNodeObject)) throw fail('invalid @included value', value);
            expanded = has(result, '@included')
              ? [...arrayify(result['@included'] ?? null), ...included]
              : included;
            break;
          }
          case '@value':
            if (inputType !== '@json' && value !== null && !isScalar(value)) {
              throw fail('invalid value object value', value);
            }
            expanded = value;
            break;
          case '@language':
            if (typeof value !== 'string') throw fail('invalid language-tagged string', value);
            expanded = value.toLowerCase();
            break;
          case '@direction':
            if (value !== 'ltr' && value !== 'rtl') throw fail('invalid base direction', value);
            expanded = value;
            break;
          case '@index':
            if (typeof value !== 'string') throw fail('invalid @index value', value);
            expanded = value;
            break;
          case '@list':
            if (activeProperty === null || activeProperty === '@graph') continue;
            expanded = arrayify(
              this.expand(context, activeProperty, value, baseUrl, false, depth + 1),
            );
            break;
          case '@set':
            expanded = this.expand(context, activeProperty, value, baseUrl, false, depth + 1);
            break;
          case '@reverse':
            this.expandReverse(context, value, baseUrl, result, depth);
            continue;
          case '@nest':
            nests.push(key);
            continue;
          default:
            continue;
        }
        // A null @value is kept: whether @type means a datatype depends on it.
        setOwn(result, property, expanded);
        continue;
      }

      const definition = context.terms.get(key);
      const container = definition?.container ?? [];
      let expanded: JsonValue;
      if (definition?.type === '@json') expanded = { '@value': value, '@type': '@json' };
      else if (container.includes('@language') && isMap(value)) {
        expanded = this.expandLanguageMap(context, definition, value);
      } else if (
        definition !== undefined &&
        (container.includes('@index') ||
          container.includes('@type') ||
          container.includes('@id')) &&
        isMap(value)
      ) {
        expanded = this.expandIndexMap(context, key, definition, value, baseUrl, depth);
      } else {
        expanded = this.expand(context, key, value, baseUrl, false, depth + 1);
      }
      if (expanded === null) continue;
      if (container.includes('@list') && !isListObject(expanded)) {
        expanded = { '@list': arrayify(expanded) };
      }
      if (
        container.includes('@graph') &&
        !container.includes('@id') &&
        !container.includes('@index')
      ) {
        expanded = arrayify(expanded).map((item): JsonValue => ({ '@graph': arrayify(item) }));
      }
      if (definition?.reverse) {
        const reverseMap = this.reverseMapOf(result);
        for (const item of arrayify(expanded)) {
          if (isValueObject(item) || isListObject(item)) {
            throw fail('invalid reverse property value', key);
          }
          addValues(reverseMap, property, [item]);
        }
      } else addValues(result, property, arrayify(expanded));
    }
    // Nested properties belong to the node, read with the nesting term's scoped context.
    for (const nest of nests.sort(compareStrings)) {
      const nestDefinition = context.terms.get(nest);
      const nestContext =
        nestDefinition?.context !== undefined
          ? this.scopedContext(context, nestDefinition.context, nestDefinition.baseUrl, true, true)
          : context;
      for (const nested of arrayify(element[nest] ?? null)) {
        if (
          !isMap(nested) ||
          Object.keys(nested).some(
            (key) => this.expandIri(nestContext, key, { vocab: true }) === '@value',
          )
        ) {
          throw fail('invalid @nest value', nested);
        }
        this.expandEntries(
          nestContext,
          typeScoped,
          nest,
          nested,
          baseUrl,
          result,
          inputType,
          depth + 1,
        );
      }
    }
  }

  private expandReverse(
    context: Context,
    value: JsonValue,
    baseUrl: string | undefined,
    result: JsonMap,
    depth: number,
  ): void {
    if (!isMap(value)) throw fail('invalid @reverse value', value);
    const expanded = this.expand(context, '@reverse', value, baseUrl, false, depth + 1);
    if (!isMap(expanded)) return;
    const doubled = expanded['@reverse'];
    if (isMap(doubled)) {
      for (const property of Object.keys(doubled)) {
        addValues(result, property, arrayify(doubled[property] ?? null));
      }
    }
    for (const property of Object.keys(expanded)) {
      if (property === '@reverse') continue;
      const reverseMap = this.reverseMapOf(result);
      for (const item of arrayify(expanded[property] ?? null)) {
        if (isValueObject(item) || isListObject(item)) {
          throw fail('invalid reverse property value', property);
        }
        addValues(reverseMap, property, [item]);
      }
    }
  }

  private reverseMapOf(result: JsonMap): JsonMap {
    const existing = result['@reverse'];
    if (isMap(existing)) return existing;
    const map: JsonMap = {};
    result['@reverse'] = map;
    return map;
  }

  private expandLanguageMap(
    context: Context,
    definition: TermDefinition | undefined,
    value: JsonMap,
  ): JsonValue[] {
    const out: JsonValue[] = [];
    const direction =
      definition?.direction !== undefined ? definition.direction : context.direction;
    for (const language of Object.keys(value).sort(compareStrings)) {
      const none = this.expandIri(context, language, { vocab: true }) === '@none';
      for (const item of arrayify(value[language] ?? null)) {
        if (item === null) continue;
        if (typeof item !== 'string') throw fail('invalid language map value', item);
        const expanded: JsonMap = { '@value': item };
        if (!none) expanded['@language'] = language.toLowerCase();
        if (direction) expanded['@direction'] = direction;
        out.push(expanded);
      }
    }
    return out;
  }

  /** Index, id and type maps (§5.1.2 step 13.8). */
  private expandIndexMap(
    context: Context,
    key: string,
    definition: TermDefinition,
    value: JsonMap,
    baseUrl: string | undefined,
    depth: number,
  ): JsonValue[] {
    const { container } = definition;
    const out: JsonValue[] = [];
    const indexKey = definition.index ?? '@index';
    const byIdOrType = container.includes('@id') || container.includes('@type');
    for (const index of Object.keys(value).sort(compareStrings)) {
      let mapContext = byIdOrType ? (context.previous ?? context) : context;
      const indexDefinition = mapContext.terms.get(index);
      if (container.includes('@type') && indexDefinition?.context !== undefined) {
        mapContext = this.scopedContext(
          mapContext,
          indexDefinition.context,
          indexDefinition.baseUrl,
          false,
          true,
        );
      }
      const expandedIndex = this.expandIri(context, index, { vocab: true });
      const items = arrayify(
        this.expand(mapContext, key, arrayify(value[index] ?? null), baseUrl, true, depth + 1),
      );
      for (let item of items) {
        if (container.includes('@graph') && !isGraphObject(item))
          item = { '@graph': arrayify(item) };
        if (!isMap(item)) continue;
        if (container.includes('@index') && indexKey !== '@index' && expandedIndex !== '@none') {
          if (isValueObject(item)) throw fail('invalid value object', item);
          const reExpanded = this.expandValue(context, indexKey, index);
          const indexProperty = this.expandIri(context, indexKey, { vocab: true });
          if (indexProperty !== null) {
            setOwn(item, indexProperty, [reExpanded, ...arrayify(item[indexProperty] ?? [])]);
          }
        } else if (
          container.includes('@index') &&
          !has(item, '@index') &&
          expandedIndex !== '@none'
        ) {
          item['@index'] = index;
        } else if (container.includes('@id') && !has(item, '@id') && expandedIndex !== '@none') {
          item['@id'] = this.expandIri(context, index, { documentRelative: true });
        } else if (container.includes('@type') && expandedIndex !== '@none') {
          item['@type'] = [expandedIndex, ...arrayify(item['@type'] ?? [])];
        }
        out.push(item);
      }
    }
    return out;
  }

  /** Value expansion (§5.3). */
  private expandValue(
    context: Context,
    activeProperty: string,
    value: string | number | boolean,
  ): JsonValue {
    const definition = context.terms.get(activeProperty);
    const type = definition?.type;
    if (type === '@id' && typeof value === 'string') {
      return { '@id': this.expandIri(context, value, { documentRelative: true }) };
    }
    if (type === '@vocab' && typeof value === 'string') {
      return { '@id': this.expandIri(context, value, { vocab: true, documentRelative: true }) };
    }
    const result: JsonMap = { '@value': value };
    if (type !== undefined && type !== '@id' && type !== '@vocab' && type !== '@none') {
      result['@type'] = type;
    } else if (typeof value === 'string') {
      const language = definition?.language !== undefined ? definition.language : context.language;
      const direction =
        definition?.direction !== undefined ? definition.direction : context.direction;
      if (language !== null && language !== undefined) result['@language'] = language;
      if (direction !== null && direction !== undefined) result['@direction'] = direction;
    }
    return result;
  }

  /** Prefix-capable terms of a top-level context, reported for display like `@prefix`. */
  private collectPrefixes(context: Context): void {
    for (const [term, definition] of context.terms) {
      const iri = definition.iri;
      if (!definition.prefix || iri === null || KEYWORDS.has(iri) || iri.startsWith('_:')) continue;
      if (!Object.hasOwn(this.prefixes, term)) setOwn(this.prefixes, term, iri);
    }
    if (context.vocab !== undefined && !Object.hasOwn(this.prefixes, '')) {
      setOwn(this.prefixes, '', context.vocab);
    }
  }

  // ─── Deserialization to RDF (§8) ────────────────────────────────────────

  /**
   * Emits the triples of a node object (and, recursively, of every node it embeds) and returns
   * its subject, or `undefined` when its id is not a usable IRI.
   */
  private emitNode(node: JsonMap, graph: Graph): Resource | undefined {
    const subject = this.resourceTerm(has(node, '@id') ? (node['@id'] ?? null) : undefined);
    for (const type of arrayify(node['@type'] ?? [])) {
      const object = typeof type === 'string' ? this.resourceTerm(type) : undefined;
      if (subject && object) this.emit(subject, this.iri(RDF_TYPE), object, graph);
    }
    for (const property of Object.keys(node)) {
      if (KEYWORDS.has(property)) continue;
      const predicate = this.predicateTerm(property);
      for (const item of arrayify(node[property] ?? null)) {
        const object = this.objectTerm(item, graph);
        if (subject && predicate && object) this.emit(subject, predicate, object, graph);
      }
    }
    const reverse = node['@reverse'];
    if (isMap(reverse)) {
      for (const property of Object.keys(reverse)) {
        const predicate = this.predicateTerm(property);
        for (const item of arrayify(reverse[property] ?? null)) {
          const object = isMap(item) ? this.emitNode(item, graph) : undefined;
          if (subject && predicate && object) this.emit(object, predicate, subject, graph);
        }
      }
    }
    // A graph whose name RDF cannot represent is dropped with its triples, as the spec says.
    if (has(node, '@graph') && subject) {
      for (const child of arrayify(node['@graph'] ?? null)) {
        if (isMap(child)) this.emitNode(child, subject);
      }
    }
    for (const child of arrayify(node['@included'] ?? [])) {
      if (isMap(child)) this.emitNode(child, graph);
    }
    return subject;
  }

  /** Object to RDF (§8.2): a resource, a literal, or a list head. */
  private objectTerm(item: JsonValue, graph: Graph): Value | undefined {
    if (!isMap(item)) return undefined;
    if (has(item, '@value')) return this.literalTerm(item);
    if (has(item, '@list')) return this.listTerm(arrayify(item['@list'] ?? null), graph);
    return this.emitNode(item, graph);
  }

  /** List to RDF (§8.3): cells are created even for items that produce no object. */
  private listTerm(items: readonly JsonValue[], graph: Graph): Resource {
    if (items.length === 0) return this.iri(RDF_NIL);
    const cells = items.map(() => this.blank());
    items.forEach((item, i) => {
      const cell = cells[i] as BlankNode;
      const object = this.objectTerm(item, graph);
      if (object) this.emit(cell, this.iri(RDF_FIRST), object, graph);
      this.emit(cell, this.iri(RDF_REST), cells[i + 1] ?? this.iri(RDF_NIL), graph);
    });
    return cells[0] as BlankNode;
  }

  private literalTerm(item: JsonMap): Literal | undefined {
    const value = item['@value'] ?? null;
    let datatype = typeof item['@type'] === 'string' ? item['@type'] : undefined;
    const language = typeof item['@language'] === 'string' ? item['@language'] : undefined;
    if (datatype !== undefined && datatype !== '@json' && !wellFormedIri(datatype))
      return undefined;
    if (language !== undefined && !LANGUAGE_TAG.test(language)) return undefined;
    let lexical: string;
    if (datatype === '@json') {
      lexical = canonicalJson(value);
      datatype = RDF_JSON;
    } else if (typeof value === 'boolean') {
      lexical = String(value);
      datatype ??= XSD_BOOLEAN;
    } else if (
      typeof value === 'number' &&
      (!Number.isInteger(value) || Math.abs(value) >= 1e21 || datatype === XSD_DOUBLE)
    ) {
      lexical = canonicalDouble(value);
      datatype ??= XSD_DOUBLE;
    } else if (typeof value === 'number') {
      lexical = value.toFixed(0);
      datatype ??= XSD_INTEGER;
    } else if (typeof value === 'string') {
      lexical = value;
    } else return undefined;
    if (language !== undefined && (datatype === undefined || datatype === RDF_LANG_STRING)) {
      return DataFactory.literal(lexical, language);
    }
    return datatype === undefined
      ? DataFactory.literal(lexical)
      : DataFactory.literal(lexical, this.iri(datatype));
  }

  /** A node id or type: blank node id, IRI, or nothing when RDF cannot represent it. */
  private resourceTerm(id: JsonValue | undefined): Resource | undefined {
    if (id === undefined) return this.blank();
    if (typeof id !== 'string') return undefined;
    if (id.startsWith('_:')) return new BlankNode(`j${id.slice(2)}`);
    return wellFormedIri(id) ? this.iri(id) : undefined;
  }

  /** Blank node predicates would be generalized RDF, which is not produced. */
  private predicateTerm(property: string): NamedNode | undefined {
    return !property.startsWith('_:') && wellFormedIri(property) ? this.iri(property) : undefined;
  }

  private blank(): BlankNode {
    return new BlankNode(`g${this.blanks++}`);
  }

  private iri(value: string): NamedNode {
    let node = this.iris.get(value);
    if (!node) {
      node = new NamedNode(value);
      this.iris.set(value, node);
    }
    return node;
  }

  private emit(subject: Resource, predicate: NamedNode, object: Value, graph: Graph): void {
    this.quads.push(DataFactory.quad(subject, predicate, object, graph));
  }
}

type Resource = NamedNode | BlankNode;
type Value = Resource | Literal;
type Graph = Resource | ReturnType<typeof DataFactory.defaultGraph>;

/** No characters RDF forbids, and at most one `#` (a fragment cannot contain another). */
function wellFormedIri(iri: string): boolean {
  if (iri === '' || iri.indexOf('#') !== iri.lastIndexOf('#')) return false;
  for (let i = 0; i < iri.length; i++) {
    if (iri.charCodeAt(i) <= 0x20 || ILLEGAL_IRI_CHARACTERS.includes(iri.charAt(i))) return false;
  }
  return true;
}

/** Term definitions are "the same" for `@protected` purposes when all but `protected` match. */
function sameDefinition(a: TermDefinition, b: TermDefinition): boolean {
  const comparable = ({ protected: _protected, baseUrl: _baseUrl, ...rest }: TermDefinition) =>
    rest;
  return canonicalJson(comparable(a)) === canonicalJson(comparable(b));
}

/**
 * JSON Canonicalization Scheme (RFC 8785): sorted keys, ECMAScript number and string forms.
 * Absent (`undefined`) entries are left out, as `JSON.stringify` does.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareStrings);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical xsd:double: `1.1E0`, `1.0E-4`, `-5.0E21` (shortest digits that round-trip). */
function canonicalDouble(value: number): string {
  const [mantissa = '0', exponent = '0'] = value.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}
