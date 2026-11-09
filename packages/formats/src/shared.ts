/**
 * Helpers shared by every parser: deterministic ordering, attribute bags, node / edge
 * builders, hashing and error construction. Nothing here knows about a concrete format.
 */
import type { Attrs, AttrValue, EdgeInput, GraphMeta, NodeInput, Point } from '@kgdiff/core';
import { KgdiffError } from '@kgdiff/core';
import type { ParseWarning, ParseWarningCode } from './index.js';

/** UTF-16 code unit order: locale-independent and identical in every runtime. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted, de-duplicated copy of `values` (code unit order). */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/** `true` for plain JSON objects (not arrays, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sets an own, enumerable property. Plain assignment of `__proto__` would replace the
 * prototype instead, silently dropping a legitimate data key (JSON allows it).
 */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else target[key] = value;
}

/** Own property value, ignoring anything inherited from `Object.prototype` (`constructor`, …). */
export function getOwn<T>(source: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

// ─── Attribute values ───────────────────────────────────────────────────────

/** Deepest nesting of arrays / objects accepted in attribute values. */
export const MAX_NESTING = 1000;

/**
 * Converts a parsed JSON value into an `AttrValue`, sorting object keys recursively. Throws
 * `KgdiffError('invalid-input')` for values nested deeper than `MAX_NESTING`.
 *
 * A number JSON can write but a double cannot hold (`1e400`, which `JSON.parse` reads as
 * `Infinity`) is kept as the string `"Infinity"` or `"-Infinity"`, as `normalize` keeps
 * non-finite numbers, and reported through `onNonFinite` (RFC 0002, D-11).
 */
export function toAttrValue(
  value: unknown,
  depth = 0,
  onNonFinite?: () => void,
): AttrValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    onNonFinite?.();
    return String(value);
  }
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_NESTING) {
    throw invalidInput(`Values nested deeper than ${MAX_NESTING} levels are not supported.`);
  }
  if (Array.isArray(value)) {
    const out: AttrValue[] = [];
    for (const item of value) {
      const converted = toAttrValue(item, depth + 1, onNonFinite);
      out.push(converted === undefined ? null : converted);
    }
    return out;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, AttrValue> = {};
  for (const key of Object.keys(record).sort(compareStrings)) {
    const converted = toAttrValue(record[key], depth + 1, onNonFinite);
    if (converted !== undefined) setOwn(out, key, converted);
  }
  return out;
}

/** Canonical JSON (object keys sorted) used to compare and de-duplicate attribute values. */
function canonicalJson(value: AttrValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: AttrValue };
    const keys = Object.keys(record).sort(compareStrings);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function valueRank(value: AttrValue): number {
  if (value === null) return 0;
  switch (typeof value) {
    case 'boolean':
      return 1;
    case 'number':
      return 2;
    case 'string':
      return 3;
    default:
      return Array.isArray(value) ? 4 : 5;
  }
}

/** Total order on attribute values: null < booleans < numbers < strings < arrays < objects. */
function compareAttrValues(a: AttrValue, b: AttrValue): number {
  const rank = valueRank(a) - valueRank(b);
  if (rank !== 0) return rank;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return compareStrings(canonicalJson(a), canonicalJson(b));
}

/**
 * Collects attribute values per key. `build` sorts keys, de-duplicates values and turns a
 * single value into a scalar (multi-values become a sorted array), unless the key is listed
 * as always-array.
 */
export class AttrBag {
  private readonly values = new Map<string, AttrValue[]>();

  add(key: string, value: AttrValue): void {
    const list = this.values.get(key);
    if (list) list.push(value);
    else this.values.set(key, [value]);
  }

  /** Replaces every value collected for `key`. */
  set(key: string, value: AttrValue): void {
    this.values.set(key, [value]);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  build(alwaysArray?: ReadonlySet<string>): Attrs | undefined {
    if (this.values.size === 0) return undefined;
    const out: Record<string, AttrValue> = {};
    for (const key of [...this.values.keys()].sort(compareStrings)) {
      const unique = new Map<string, AttrValue>();
      for (const value of this.values.get(key) ?? []) unique.set(canonicalJson(value), value);
      const sorted = [...unique.values()].sort(compareAttrValues);
      const [first] = sorted;
      const value =
        sorted.length === 1 && first !== undefined && !alwaysArray?.has(key) ? first : sorted;
      setOwn(out, key, value);
    }
    return out;
  }
}

// ─── Nodes and edges ────────────────────────────────────────────────────────

/** Mutable accumulator for one node; `build` emits a `NodeInput` without empty fields. */
export class NodeBuilder {
  label: string | undefined;
  readonly types = new Set<string>();
  readonly aliases = new Set<string>();
  readonly attrs = new AttrBag();
  deprecated = false;
  readonly replaces = new Set<string>();
  readonly replacedBy = new Set<string>();

  constructor(readonly id: string) {}

  build(alwaysArray?: ReadonlySet<string>): NodeInput {
    return makeNode({
      id: this.id,
      label: this.label,
      types: this.types,
      aliases: this.aliases,
      attrs: this.attrs.build(alwaysArray),
      deprecated: this.deprecated,
      replaces: this.replaces,
      replacedBy: this.replacedBy,
    });
  }
}

interface NodeFields {
  readonly id: string;
  readonly label?: string | undefined;
  readonly types?: Iterable<string>;
  readonly aliases?: Iterable<string>;
  readonly attrs?: Attrs | undefined;
  readonly deprecated?: boolean;
  readonly replaces?: Iterable<string>;
  readonly replacedBy?: Iterable<string>;
  readonly position?: Point | undefined;
}

/**
 * Builds a `NodeInput` with a fixed key order and no empty fields: one type becomes a string,
 * several a sorted array; aliases are sorted and never repeat the label; `deprecated` only
 * appears when true.
 */
export function makeNode(fields: NodeFields): NodeInput {
  const types = sortedUnique(fields.types ?? []);
  const label = fields.label ?? fields.id;
  const aliases = sortedUnique(fields.aliases ?? []).filter((alias) => alias !== label);
  const replaces = sortedUnique(fields.replaces ?? []);
  const replacedBy = sortedUnique(fields.replacedBy ?? []);
  const attrs = fields.attrs && Object.keys(fields.attrs).length > 0 ? fields.attrs : undefined;
  const [onlyType] = types;
  return {
    id: fields.id,
    ...(fields.label !== undefined && fields.label !== fields.id ? { label: fields.label } : {}),
    ...(types.length === 1 && onlyType !== undefined
      ? { type: onlyType }
      : types.length > 1
        ? { type: types }
        : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(attrs ? { attrs } : {}),
    ...(fields.deprecated ? { deprecated: true } : {}),
    ...(replaces.length > 0 ? { replaces } : {}),
    ...(replacedBy.length > 0 ? { replacedBy } : {}),
    ...(fields.position ? { position: fields.position } : {}),
  };
}

export interface EdgeFields {
  readonly id?: string | undefined;
  readonly source: string;
  readonly target: string;
  readonly predicate?: string | undefined;
  readonly label?: string | undefined;
  readonly attrs?: Attrs | undefined;
}

/** Builds an `EdgeInput` with a fixed key order and no empty fields. */
export function makeEdge(fields: EdgeFields): EdgeInput {
  const attrs = fields.attrs && Object.keys(fields.attrs).length > 0 ? fields.attrs : undefined;
  return {
    ...(fields.id !== undefined ? { id: fields.id } : {}),
    source: fields.source,
    target: fields.target,
    ...(fields.predicate !== undefined && fields.predicate !== ''
      ? { predicate: fields.predicate }
      : {}),
    // An empty label is kept: it differs from the default (the predicate's readable form).
    ...(fields.label !== undefined ? { label: fields.label } : {}),
    ...(attrs ? { attrs } : {}),
  };
}

const nodeTieBreak = (node: NodeInput): string => JSON.stringify(node);

/** Nodes sorted by id (ties, i.e. duplicate ids, by their canonical JSON). */
export function sortNodes(nodes: NodeInput[]): NodeInput[] {
  return nodes.sort(
    (a, b) => compareStrings(a.id, b.id) || compareStrings(nodeTieBreak(a), nodeTieBreak(b)),
  );
}

/** Edges sorted by (source, predicate, target, id, label, attrs). */
export function sortEdges(edges: EdgeInput[]): EdgeInput[] {
  return edges.sort(
    (a, b) =>
      compareStrings(a.source, b.source) ||
      compareStrings(a.predicate ?? '', b.predicate ?? '') ||
      compareStrings(a.target, b.target) ||
      compareStrings(a.id ?? '', b.id ?? '') ||
      compareStrings(a.label ?? '', b.label ?? '') ||
      compareStrings(a.attrs ? canonicalJson(a.attrs) : '', b.attrs ? canonicalJson(b.attrs) : ''),
  );
}

/** Meta with keys sorted and empty values dropped; `undefined` when nothing is left. */
export function makeMeta(meta: Record<string, unknown>): GraphMeta | undefined {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(meta).sort(compareStrings)) {
    const value = meta[key];
    if (value !== undefined && value !== '') setOwn(out, key, value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ─── Hashing ────────────────────────────────────────────────────────────────

/**
 * 53-bit string hash (cyrb53), as 14 hex digits. Not cryptographic; used for content-addressed
 * blank node ids where a collision would need ~10^8 distinct blank nodes to become likely.
 */
export function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = (h2 & 0x1fffff).toString(16).padStart(6, '0');
  const low = (h1 >>> 0).toString(16).padStart(8, '0');
  return high + low;
}

// ─── Warnings and errors ────────────────────────────────────────────────────

/** Collects warnings; counted warnings are reported once with their total. */
export class Warnings {
  private readonly list: ParseWarning[] = [];
  private readonly counts = new Map<
    ParseWarningCode,
    { count: number; message: (n: number) => string }
  >();

  add(code: ParseWarningCode, message: string, line?: number): void {
    this.list.push(line === undefined ? { code, message } : { code, message, line });
  }

  /** Counts an occurrence; `finish` emits one warning per code with `message(total)`. */
  count(code: ParseWarningCode, message: (count: number) => string, by = 1): void {
    const entry = this.counts.get(code);
    if (entry) entry.count += by;
    else this.counts.set(code, { count: by, message });
  }

  finish(): ParseWarning[] {
    const counted = [...this.counts.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([code, { count, message }]) => ({ code, message: message(count) }));
    return [...this.list, ...counted];
  }
}

export const plural = (count: number, word: string, many = `${word}s`): string =>
  `${count} ${count === 1 ? word : many}`;

/** A `KgdiffError('invalid-input')`; `line` (1-based) is appended to the message and details. */
export function invalidInput(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): KgdiffError {
  return new KgdiffError('invalid-input', message, details);
}

/** 1-based line and column of a UTF-16 offset. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Exhaustiveness guard for `switch` statements. */
export function assertNever(value: never): never {
  throw new KgdiffError('invalid-input', `Unexpected value: ${String(value)}`);
}

// ─── Typed literals ─────────────────────────────────────────────────────────

const XSD_INTEGERS = new Set([
  'integer',
  'int',
  'long',
  'short',
  'byte',
  'nonNegativeInteger',
  'positiveInteger',
  'negativeInteger',
  'nonPositiveInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
]);
const XSD_DECIMALS = new Set(['decimal', 'double', 'float']);
const INTEGER_LEXICAL = /^[+-]?\d+$/;
const DECIMAL_LEXICAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * JSON value of a literal with an XSD datatype (`xsdType` is the local name, e.g. `integer`):
 * numeric types become numbers (integers only when safe), `boolean` becomes a boolean, and
 * everything else — including lexical forms that do not parse — stays the lexical string.
 */
export function typedValue(lexical: string, xsdType: string | undefined): AttrValue {
  if (xsdType === undefined) return lexical;
  const trimmed = lexical.trim();
  if (XSD_INTEGERS.has(xsdType)) {
    if (!INTEGER_LEXICAL.test(trimmed)) return lexical;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : lexical;
  }
  if (XSD_DECIMALS.has(xsdType)) {
    if (!DECIMAL_LEXICAL.test(trimmed)) return lexical;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : lexical;
  }
  if (xsdType === 'boolean') {
    if (trimmed === 'true' || trimmed === '1') return true;
    if (trimmed === 'false' || trimmed === '0') return false;
  }
  return lexical;
}
