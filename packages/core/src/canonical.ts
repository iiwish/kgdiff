/**
 * Canonical values: key-order-insensitive equality, canonical JSON, structural edge
 * keys and the cyrb53 hash. Everything here is allocation-conscious because it sits
 * on the hot path of `normalize` and `diff`.
 */
import type { Attrs, AttrValue } from './types.js';

// ─── Structural keys ─────────────────────────────────────────────────────────

/**
 * Structural edge key: `JSON.stringify([source, predicate, target])` (docs/algorithms.md §1).
 *
 * Keys are kept for the lifetime of a graph (map keys, `KGEdge.key`, union edge ids), so they
 * must be flat strings. Concatenating the parts instead (`[${a},${b},${c}]`) yields the same
 * text as a V8 rope (a tree of cons strings) that stays allocated behind the key: about 2.7× the
 * memory of the flat string, nearly a third of a whole graph's heap, and slower to hash.
 */
export function tripleKey(source: string, predicate: string, target: string): string {
  return JSON.stringify([source, predicate, target]);
}

/** True when a structural key carries a parallel-edge suffix (`#2`, `#3`…). */
export function hasParallelSuffix(key: string): boolean {
  return key.charCodeAt(key.length - 1) !== 0x5d;
}

/**
 * Splits a structural key into its triple part and its parallel-edge suffix (`#2`, `#3`…).
 * Structural keys always end with `]` before the suffix, so the last `#` after the last
 * `]` starts the suffix.
 */
export function splitStructuralKey(key: string): {
  readonly base: string;
  readonly suffix: string;
} {
  if (key.charCodeAt(key.length - 1) === 0x5d) return { base: key, suffix: '' };
  const at = key.lastIndexOf('#');
  return at < 0 ? { base: key, suffix: '' } : { base: key.slice(0, at), suffix: key.slice(at) };
}

// ─── Attribute values ────────────────────────────────────────────────────────

function isArrayValue(value: AttrValue): value is readonly AttrValue[] {
  return Array.isArray(value);
}

/** Deep, key-order-insensitive equality of JSON values (canonical JSON equality). */
export function attrValueEquals(a: AttrValue | undefined, b: AttrValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (isArrayValue(a)) {
    if (!isArrayValue(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!attrValueEquals(a[i], b[i])) return false;
    return true;
  }
  if (isArrayValue(b)) return false;
  return attrsEqual(a as Attrs, b as Attrs);
}

// Attribute maps come from user data: keys such as `__proto__` or `constructor` are ordinary
// data. Maps are written through `setAttr` (so `__proto__` becomes an own key, never the
// prototype) and every read goes through `ownAttr` (so inherited members are never mistaken
// for data). Plain objects are kept rather than null-prototype ones, which V8 stores slowly.

/** A new, empty attribute map. Write it with `setAttr`. */
export function emptyAttrMap(): Record<string, AttrValue> {
  return {};
}

/** Sets an own data property — also for the key `__proto__`, which `=` would not create. */
export function setAttr(attrs: Record<string, AttrValue>, key: string, value: AttrValue): void {
  if (key === '__proto__') {
    Object.defineProperty(attrs, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    attrs[key] = value;
  }
}

/** The own value of `key`, or undefined — never an inherited member such as `constructor`. */
export function ownAttr(attrs: Attrs, key: string): AttrValue | undefined {
  return Object.hasOwn(attrs, key) ? attrs[key] : undefined;
}

/** Own keys whose value is defined. */
function definedKeys(attrs: Attrs): string[] {
  return Object.keys(attrs).filter((key) => attrs[key] !== undefined);
}

/**
 * Equality of two attribute maps, ignoring key order, keys whose value is `undefined`
 * and the keys in `ignore`.
 */
export function attrsEqual(a: Attrs, b: Attrs, ignore?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  let countA = 0;
  for (const key of Object.keys(a)) {
    const value = a[key];
    if (value === undefined || ignore?.has(key)) continue;
    countA++;
    if (!attrValueEquals(value, ownAttr(b, key))) return false;
  }
  let countB = 0;
  for (const key of Object.keys(b)) {
    if (b[key] !== undefined && !ignore?.has(key)) countB++;
  }
  return countA === countB;
}

/** Sorted own keys of an attribute map whose value is defined. */
export function attrKeys(attrs: Attrs): string[] {
  return definedKeys(attrs).sort();
}

/** True when the map has no defined value. */
export function isEmptyAttrs(attrs: Attrs): boolean {
  for (const key of Object.keys(attrs)) if (attrs[key] !== undefined) return false;
  return true;
}

/** Deep copy with object keys sorted and `undefined` members dropped. */
export function canonicalize(value: AttrValue): AttrValue {
  if (value === null || typeof value !== 'object') return value;
  if (isArrayValue(value)) return value.map(canonicalize);
  return canonicalAttrs(value as Attrs);
}

/** `canonicalize` for an attribute map (`__proto__` stays an own key). */
export function canonicalAttrs(attrs: Attrs): Attrs {
  const out = emptyAttrMap();
  for (const key of attrKeys(attrs)) setAttr(out, key, canonicalize(attrs[key] as AttrValue));
  return out;
}

/** Canonical JSON of a JSON value: object keys sorted, arrays in order. */
export function canonicalJSON(value: AttrValue): string {
  return JSON.stringify(canonicalize(value));
}

// ─── cyrb53 ──────────────────────────────────────────────────────────────────

/**
 * Streaming cyrb53 (bryc, public domain): a fast, well-mixed, non-cryptographic 53-bit
 * hash over UTF-16 code units. Feeding strings one after another hashes their
 * concatenation, so nothing has to be built in memory.
 */
export class Cyrb53 {
  private h1 = 0;
  private h2 = 0;

  constructor(private readonly seed = 0) {
    this.reset();
  }

  reset(): this {
    this.h1 = 0xdeadbeef ^ this.seed;
    this.h2 = 0x41c6ce57 ^ this.seed;
    return this;
  }

  /** Feeds one UTF-16 code unit (used for unambiguous framing such as lengths and tags). */
  code(unit: number): this {
    this.h1 = Math.imul(this.h1 ^ unit, 2654435761);
    this.h2 = Math.imul(this.h2 ^ unit, 1597334677);
    return this;
  }

  update(text: string): this {
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ unit, 2654435761);
      h2 = Math.imul(h2 ^ unit, 1597334677);
    }
    this.h1 = h1;
    this.h2 = h2;
    return this;
  }

  /** Length-prefixed string: makes a sequence of strings injective. */
  string(text: string): this {
    return this.code(text.length & 0xffff)
      .code(text.length >>> 16)
      .update(text);
  }

  /** Tagged, length-prefixed, key-sorted encoding of a JSON value. */
  value(value: AttrValue | undefined): this {
    if (value === undefined) return this.code(0x75); // u
    if (value === null) return this.code(0x6e); // n
    switch (typeof value) {
      case 'boolean':
        return this.code(value ? 0x74 : 0x66); // t / f
      case 'number':
        return this.code(0x64).string(String(value)); // d
      case 'string':
        return this.code(0x73).string(value); // s
      default:
        break;
    }
    if (isArrayValue(value)) {
      this.code(0x61)
        .code(value.length & 0xffff)
        .code(value.length >>> 16); // a
      for (const item of value) this.value(item);
      return this;
    }
    const own = Object.keys(value);
    // Common cases first: no attributes, or one — no filtering or sorting needed.
    if (own.length === 0) return this.code(0x6f).code(0).code(0);
    const keys =
      own.length === 1 && (value as Attrs)[own[0] as string] !== undefined
        ? own
        : attrKeys(value as Attrs);
    this.code(0x6f)
      .code(keys.length & 0xffff)
      .code(keys.length >>> 16); // o
    for (const key of keys) this.string(key).value((value as Attrs)[key]);
    return this;
  }

  /** Both finalized 32-bit halves (64 bits of state) without resetting. */
  digestPair(): [number, number] {
    let h1 = this.h1;
    let h2 = this.h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return [h1 >>> 0, h2 >>> 0];
  }

  /** The 53-bit cyrb53 digest. */
  digest(): number {
    const [h1, h2] = this.digestPair();
    return 4294967296 * (2097151 & h2) + h1;
  }
}

/** One-shot cyrb53 of a string. */
export function cyrb53(text: string, seed = 0): number {
  return new Cyrb53(seed).update(text).digest();
}
