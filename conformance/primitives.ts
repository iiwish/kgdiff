/**
 * Primitive vectors: the JavaScript built-ins and small public functions that the documents of
 * the corpus depend on, tested one value at a time so that an implementation can get them right
 * before it runs whole cases. Every vector is computed here, by the running JavaScript engine and
 * the TypeScript packages; inputs are curated edge cases plus seeded pseudo-random samples.
 * Doubles are written as the 16 hex digits of their IEEE 754 bits (big-endian), so that no
 * JSON number formatting is involved in checking JSON number formatting.
 */
import { createHash } from 'node:crypto';
import { facetLabel, log2, predicateLabel, textSimilarity } from '@kgdiff/core';
import { estimateLabelWidth, nodeRadius } from '@kgdiff/layout';
import { FACET_ORDER } from '../packages/core/src/model.js';

const view = new DataView(new ArrayBuffer(8));

/** IEEE 754 bits of a double, as 16 hex digits (big-endian). */
export function bitsOf(x: number): string {
  view.setFloat64(0, x);
  return (
    view.getUint32(0).toString(16).padStart(8, '0') +
    view.getUint32(4).toString(16).padStart(8, '0')
  );
}

function fromBits(hi: number, lo: number): number {
  view.setUint32(0, hi >>> 0);
  view.setUint32(4, lo >>> 0);
  return view.getFloat64(0);
}

/** mulberry32, the generator the layout and the synthetic graphs use. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** A JSON object with one array item per line: readable, and diffs stay small. */
function lines(record: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(record).map(([key, value]) => {
    const head = `  ${JSON.stringify(key)}: `;
    if (!Array.isArray(value) || value.length === 0) return head + JSON.stringify(value);
    return `${head}[\n${value.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

// biome-ignore format: compact list
const CURATED_NUMBERS: readonly number[] = [
  0, -0, 1, -1, 2, 10, 100, 0.1, 0.2, 0.3, 0.1 + 0.2, 0.1 + 0.7, 1 / 3, 2 / 3, 0.5, 1.5, 2.5, -2.5,
  0.25, 1.25, 0.125, 1.45, 8.345, -0.05, -0.5, 0.05, 1.2695, 99.95, 999.95,
  1.005, 4.35, 123.456, 1e15, 1e16, 1e17, 1e20, 1e21, 1.5e21, 1e22, 123456789012345680000,
  999999999999999900000, 1e-6, 1e-7, 1.5e-7, 0.000001, 0.0000012345, 0.00001, 1.2345e-7, 2.5e-8,
  1e100, 1e300, 1.7976931348623157e308, 2.2250738585072014e-308, 2.225073858507201e-308,
  4.9406564584124654e-324, 1e-323, 2 ** 31, 2 ** 32, 2 ** 32 - 1, -(2 ** 32), 2 ** 52, 2 ** 53 - 1,
  2 ** 53, 2 ** 53 + 2, 2 ** 64, 2 ** 70, Number('9007199254740993'), 299792458, 6.02214076e23,
  1.602176634e-19, Math.PI, Math.E, Math.LN2, Math.SQRT2, 0.857143, 0.666667, 0.82, 0.6,
  Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN,
];

function numberToString(): string {
  const random = mulberry32(0x6b67);
  const values = [...CURATED_NUMBERS];
  // Arbitrary bit patterns cover every exponent; decimal-looking ones the common cases.
  for (let i = 0; i < 600; i++) {
    const x = fromBits(random(), random());
    if (!Number.isNaN(x)) values.push(x);
  }
  for (let i = 0; i < 400; i++) {
    const digits = String(random() % 10 ** (1 + (random() % 9))).padStart(1, '0');
    const exponent = (random() % 61) - 30;
    values.push(Number(`${digits}e${exponent}`));
  }
  const seen = new Set<string>();
  const entries = [];
  for (const x of values) {
    const bits = bitsOf(x);
    if (seen.has(bits)) continue;
    seen.add(bits);
    entries.push({
      bits,
      string: String(x),
      json: JSON.stringify(x),
      exponential: x.toExponential(),
      fixed: [x.toFixed(0), x.toFixed(1), x.toFixed(2)],
    });
  }
  return lines({
    description:
      'Number → text. `string`: String(x), the ECMAScript Number::toString used by template literals and hashGraph. `json`: JSON.stringify(x) (non-finite → null). `exponential`: x.toExponential() (shortest digits), used for canonical xsd:double lexical forms. `fixed`: x.toFixed(0), x.toFixed(1), x.toFixed(2): digits of the exact binary value, a tie rounded away from zero, -0 → "0", String(x) from 1e21 on; used for JSON-LD integers and byte sizes in messages.',
    entries,
  });
}

// biome-ignore format: compact list
const CURATED_NUMBER_TEXTS: readonly string[] = [
  '0', '-0', '1', '1.0', '1.', '.5', '+5', '-5', '01', '1e3', '1E3', '1e+3', '1e-3', '1e', 'e3',
  '0.1', '0.30000000000000004', '123456789012345680000', '123456789012345678901234567890',
  '9007199254740993', '9007199254740992.5', '1e400', '-1e400', '1e-400', '2.2250738585072011e-308',
  '4.9406564584124654e-324', '2.4703282292062327e-324', '2.4703282292062328e-324',
  '1.7976931348623158e308', '1.7976931348623159e308', '0x1F', '0X1f', '0o17', '0b101', '0x',
  'Infinity', '-Infinity', '+Infinity', 'infinity', 'NaN', 'inf', '', ' ', ' 12 ', '\t12\n',
  '\u00a012\ufeff', '\u008512', '1_000', '1,5', '12abc', '٣', '１２',
];

function numberFromString(): string {
  const entries = CURATED_NUMBER_TEXTS.map((text) => {
    const n = Number(text);
    let json: string | null;
    try {
      const parsed: unknown = JSON.parse(text);
      json = typeof parsed === 'number' ? bitsOf(parsed) : null;
    } catch {
      json = null;
    }
    return { text, number: Number.isNaN(n) ? 'NaN' : bitsOf(n), json };
  });
  return lines({
    description:
      'Text → number. `number`: bits of Number(text) (ECMAScript StringToNumber: JavaScript whitespace trimmed, empty → 0, 0x / 0o / 0b prefixes, "Infinity"), or "NaN". `json`: bits of JSON.parse(text) when it is a number, else null (a syntax error).',
    entries,
  });
}

/**
 * The first 64 of the 439 integers in 1…2·10⁶ whose log₂ Apple's libm rounds differently from V8
 * (found by comparing the two; every C library has such inputs). Kept as hard inputs for a port
 * that calls a C library's log₂ instead of repeating `log2`'s operations.
 */
// biome-ignore format: compact list
const HARD_LOG2: readonly number[] = [
  1375, 2750, 3393, 5500, 5755, 6131, 6351, 6786, 7957, 11000, 11219, 11443, 11510, 12043, 12262,
  12702, 13572, 13735, 15914, 18817, 21099, 21703, 22000, 22438, 22886, 23020, 24086, 24524, 25309,
  25404, 27144, 27470, 31828, 37634, 39493, 42198, 43406, 44000, 44876, 45477, 45772, 46040, 46581,
  48172, 49048, 50618, 50808, 51651, 54288, 54940, 63656, 66683, 67359, 83743, 86015, 88424, 88632,
  89516, 90727, 90768, 92078, 96143, 103485, 104703,
];

/**
 * Inputs beyond the integers matching and the layout pass: the edges of the domain, subnormals and
 * the largest double (the scaling loops' longest runs), mantissas next to 1 and 2 (the series'
 * shortest and slowest cases) and a few fractions.
 */
// biome-ignore format: compact list
const SPECIAL_LOG2: readonly number[] = [
  0, -0, -1, Number.NEGATIVE_INFINITY, Number.NaN, Number.POSITIVE_INFINITY,
  Number.MIN_VALUE, 2 ** -1022, 2 ** -1022 * (2 - 2 ** -52), Number.MAX_VALUE,
  1 + 2 ** -52, 2 - 2 ** -52, 0.5, 0.75, 1.5, 1e-3, 0.1, 7.5, 123456.789, 2 ** 53 + 2, 1e300,
];

const LOG2_DIGEST_TO = 2 ** 22;

function log2Vector(): string {
  const explicit: [number, string][] = [];
  for (let n = 1; n <= 1024; n++) explicit.push([n, bitsOf(log2(n))]);
  for (const n of HARD_LOG2) explicit.push([n, bitsOf(log2(n))]);
  const special = SPECIAL_LOG2.map((x) => [bitsOf(x), bitsOf(log2(x))]);
  const buffer = new Uint8Array(8 * LOG2_DIGEST_TO);
  const data = new DataView(buffer.buffer);
  for (let n = 1; n <= LOG2_DIGEST_TO; n++) data.setFloat64(8 * (n - 1), log2(n), true);
  return lines({
    description:
      "log2 of @kgdiff/core, which core's matching uses on integers ≥ 1 (1 / log2(2 + degree), 1 / log2(1 + postings)) and the layout on integers ≥ 1 (iterations, link distances). It is built from exactly rounded operations, so it gives the same bits everywhere, but it is not correctly rounded: it differs from V8's Math.log2 by one ulp on 102,219 of the integers up to 2^22 (the first is 3), so only the same operations in the same order reproduce it. For x > 0 and finite: m = x, e = 0; while m >= 2 { m /= 2; e += 1 }; while m < 1 { m *= 2; e -= 1 }; s = (m - 1) / (m + 1); s2 = s * s; term = s; sum = 0; for k = 1, 3, 5, …, 39 { sum += term / k; term *= s2 }; result e + (2 * sum) / LN2, with LN2 the double 3fe62e42fefa39ef. Not x > 0 (0, -0, negative, NaN) → -Infinity; +Infinity → +Infinity. `explicit`: [n, bits]. `special`: [bits of x, bits of log2(x)]. `digest`: SHA-256 of the little-endian float64 values of log2(n) for n = from…to, concatenated.",
    explicit,
    special,
    digest: {
      from: 1,
      to: LOG2_DIGEST_TO,
      encoding: 'float64-le',
      sha256: createHash('sha256').update(buffer).digest('hex'),
    },
  });
}

/** Math.round, ToUint32 and ToInt32 on the values where Rust's defaults differ. */
function jsMath(): string {
  const roundInputs = [
    0,
    -0,
    0.4,
    0.5,
    0.49999999999999994,
    1.5,
    2.5,
    -0.2,
    -0.5,
    -0.5000000000000001,
    -1.5,
    -2.5,
    -2.6,
    4.5,
    2 ** 52 + 0.5,
    2 ** 53,
    1e21,
    -1e21,
    123.456 * 100,
    0.857142857 * 1e6,
    1.005 * 100,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  const conversionInputs = [
    0,
    -0,
    1,
    -1,
    1.9,
    -1.9,
    2 ** 31,
    2 ** 31 - 1,
    -(2 ** 31),
    2 ** 32,
    2 ** 32 + 5,
    2 ** 53,
    1e20,
    -1e20,
    4294967295.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  return lines({
    description:
      'Math.round (half up, keeps -0), ToUint32 (x >>> 0) and ToInt32 (x | 0) with JavaScript semantics. Inputs and Math.round results are bits; conversions are exact integers.',
    round: roundInputs.map((x) => [bitsOf(x), bitsOf(Math.round(x))]),
    toUint32: conversionInputs.map((x) => [bitsOf(x), x >>> 0]),
    toInt32: conversionInputs.map((x) => [bitsOf(x), x | 0]),
  });
}

// ─── Strings ─────────────────────────────────────────────────────────────────

// biome-ignore format: compact list
const ORDER_ALPHABET: readonly string[] = [
  '', 'a', 'A', 'z', '_', '~', '0', ' ', '\u0000', '\u007f', '\u0080', 'é', 'é', 'σ',
  '一', '\ud7ff', '\ue000', 'ﬁ', '～', '�', '\uffff', '\u{1d400}', '\u{1f600}',
  '\u{1f980}', '\u{20000}', '\u{10ffff}',
];

function stringOrder(): string {
  const random = mulberry32(0x0516);
  const set = new Set<string>(ORDER_ALPHABET);
  for (let i = 0; i < 400; i++) {
    const length = 1 + (random() % 4);
    let s = '';
    for (let k = 0; k < length; k++) s += ORDER_ALPHABET[random() % ORDER_ALPHABET.length];
    set.add(s);
  }
  return lines({
    description:
      "Strings in the order of JavaScript's default sort (UTF-16 code units), which every sort of ids, keys and labels in kgdiff uses. Astral characters (surrogates D800–DFFF) sort before U+E000–U+FFFF.",
    sorted: [...set].sort(),
  });
}

/** `textSimilarity` pairs: each feature of docs/algorithms.md §2 and the Unicode handling. */
const SIMILARITY_PAIRS: readonly (readonly [string, string])[] = [
  ['', ''],
  ['', 'a'],
  ['...', '...'],
  ['...', '!!!'],
  ['?', ''],
  ['a', 'a'],
  ['a', 'b'],
  ['AB', 'ABCDEFGH'],
  ['abc', 'abd'],
  ['Cat', 'cat'],
  ['Domestic cat', 'domestic_cat'],
  ['Domestic cat', 'cat, domestic'],
  ['University of Oxford', 'Univ. of Oxford'],
  ['Univ. Oxford', 'University Oxford'],
  ['Dept. of Health', 'Department of Health'],
  ['Type 1 diabetes', 'Type 2 diabetes'],
  ['Windows 10', 'Windows 11'],
  ['B1', 'B12'],
  ['Route 007', 'Route 7'],
  ['stg_orders', 'stg_orders_v2'],
  ['Marie Curie', 'Marie Skłodowska-Curie'],
  ['polonium (Po)', 'Polonium'],
  ['pitchblende', 'uraninite (pitchblende)'],
  ['Mercury', 'Mercury'],
  ['Lorry', 'Lorries'],
  ['color', 'colour'],
  ['organization', 'organisation'],
  ['Martha', 'Marhta'],
  ['Dwayne', 'Duane'],
  ['Dixon', 'Dicksonx'],
  ['法定代表人', '法人代表'],
  ['企业信用', '企业信用报告'],
  ['股权出质', '股权质押'],
  ['数据资产目录', '数据资产总目录'],
  ['データカタログ', 'データ・カタログ'],
  ['데이터 카탈로그', '데이터카탈로그'],
  ['Café', 'Café'],
  ['Café', 'Cafe'],
  ['\u{1d400}\u{1d429}\u{1d429}\u{1d425}\u{1d41e} pie', 'Apple pie'],
  ['ﬁle', 'file'],
  ['ＡＢＣ１２３', 'ABC123'],
  ['ΟΔΟΣ', 'οδος'],
  ['ΟΔΟΣ', 'οδοσ'],
  ['İstanbul', 'istanbul'],
  ['Straße', 'strasse'],
  ['Smile \u{1f600}', 'Smile \u{1f601}'],
  ['\u{1f469}\u200d\u{1f4bb} Developer', 'Developer'],
  ['\u{20000} rare', '\u{20001} rare'],
  ['Zero\u200bwidth', 'Zerowidth'],
  ['Soft\u00adhyphen', 'Softhyphen'],
  ['BOM\ufeffinside', 'BOMinside'],
  ['NBSP\u00a0space', 'NBSP space'],
  ['NEL\u0085line', 'NEL line'],
  ['Tab\there', 'Tab here'],
  ['a-b/c.d_e', 'a b c d e'],
  ['  padded  ', 'padded'],
  ['New York City', 'City New York'],
  ['the of and', 'and of the'],
  ['Order line', 'Order lines'],
  ['Customer', 'Client'],
  ['Revenue', 'Net revenue'],
];

function textSimilarityVector(): string {
  return lines({
    description:
      'textSimilarity(a, b) of @kgdiff/core: NFKC, lowercase, invisible characters removed, punctuation and whitespace collapsed; bigram Dice or Jaro–Winkler, token sets with abbreviations, the number cap; rounded to 1e-6. Exactly symmetric.',
    pairs: SIMILARITY_PAIRS.map(([a, b]) => [a, b, textSimilarity(a, b)]),
  });
}

const PREDICATES: readonly string[] = [
  'rdfs:subClassOf',
  'http://www.w3.org/2000/01/rdf-schema#subClassOf',
  'http://purl.obolibrary.org/obo/part_of',
  'http://purl.obolibrary.org/obo/RO_0002131',
  'http://purl.obolibrary.org/obo/BFO_0000050',
  'https://purl.obolibrary.org/obo/RO_0002131',
  'BFO:0000050',
  'part_of',
  'is_a',
  'has_part__of',
  'snake_case_name',
  'camelCaseName',
  'http://example.org/onto#hasTopping',
  'http://example.org/onto/',
  'http://example.org/onto#',
  'http://example.org/12345',
  'http://example.org/a%20b',
  'http://example.org/caf%C3%A9',
  'http://example.org/bad%E0%A4',
  'http://example.org/100%',
  'urn:isbn:0451450523',
  'ex:knows',
  'knows',
  '投资',
  'http://example.org/关联',
  'http://example.org/Café',
  'reports to',
  '  spaced  out  ',
  '_',
  '#',
  '',
  'a:b:c',
  'http://example.org/x_y_z',
  'http://example.org/\u{1f600}_rel',
];

function predicateLabelVector(): string {
  return lines({
    description:
      'predicateLabel(predicate) of @kgdiff/core: local part after the last #, / or :, percent-decoded, _ → space, NFC; opaque (digit-only) local parts keep the whole predicate; opaque OBO PURLs read as CURIEs.',
    pairs: PREDICATES.map((p) => [p, predicateLabel(p)]),
  });
}

const LABELS: readonly string[] = [
  '',
  'a',
  'Animal',
  'ANIMAL',
  'animal 42',
  '   ',
  '企业信用知识图谱',
  'ＡＢＣ',
  'データ',
  '데이터',
  'Smile \u{1f600}',
  '\u{1f469}\u200d\u{1f4bb}',
  '\u{1f1e8}\u{1f1f3}',
  '1️⃣',
  'é',
  'Ω≈ç√∫',
  'Ελληνικά',
  'Кириллица',
  'עברית',
  'العربية',
  'Mixed 中文 and English 123',
  '\u{20000}\u{20001}',
  'Tab\tand\nnewline',
  'x'.repeat(40),
  '中'.repeat(40),
];

function labelWidthVector(): string {
  const widths = [];
  for (const fontSize of [12, 10, 14.5]) {
    for (const text of LABELS) widths.push([text, fontSize, estimateLabelWidth(text, fontSize)]);
  }
  const degrees = [-1, 0, 1, 2, 3, 4, 5, 8, 9, 10, 16, 20, 21, 22, 25, 30, 40, 100, 1000];
  return lines({
    description:
      'estimateLabelWidth(text, fontSize) and nodeRadius(degree) of @kgdiff/layout. The scene sizes label boxes and nodes with these, so every implementation of the layout must agree with them exactly (a layout vector: RFC 0002, phase 4).',
    labelWidth: widths,
    nodeRadius: degrees.map((d) => [d, nodeRadius(d)]),
  });
}

const JSON_TEXTS: readonly string[] = [
  '{"b":1,"10":2,"2":3,"a":4}',
  '{"b":1,"a":2,"b":3}',
  '{"01":1,"1":2,"-1":3,"1.0":4,"4294967294":5,"4294967295":6,"0":7}',
  '{"__proto__":{"polluted":true},"constructor":1,"toString":2}',
  '{"nested":{"z":1,"3":3,"1":{"y":true,"0":false}}}',
  '[1,1.0,-0,0.0,1e21,1e-7,1E2,0.000001,100,1.5e300,5e-324]',
  '[12345678901234567890,9007199254740993,123456789012345680000]',
  '[1e400,-1e400,1e-400]',
  '["\\u0000\\u001f\\u007f\\u0080","\\u2028\\u2029","\\b\\f\\n\\r\\t\\/\\"\\\\"]',
  '["\\ud83d\\ude00","x\\u00e9\\u4E2D"]',
  '["é","e\\u0301","\\u00e9"]',
  '{}',
  '[]',
  '[{},[],[[]],{"a":{}}]',
  '  {"spaced" : [ 1 , 2 ] }  ',
  '"\\uFEFF bom-escape"',
  'null',
  'true',
  '{"a":1,}',
  '[01]',
  "{'a':1}",
  '[1e]',
  '[NaN]',
  '"\u0001"',
  // Lone surrogates: JSON.parse accepts them, kgdiff does not (RFC 0002, D-2).
  '"\\uD83D\\uDE00"',
  '"\\ud800"',
  '"\\udc00\\ud800"',
  '["\\ud83d\\ude00\\ud83d"]',
  '{"\\udfff":1}',
  '"\\ud83d\\u0041"',
  '"\\ud83d\\\\ude00"',
  '["\\ud83d", 1,]',
];

/** A UTF-16 unit that is half of a surrogate pair without its other half. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether every string in a parsed JSON value, object keys included, is well-formed UTF-16. */
function wellFormed(value: unknown): boolean {
  if (typeof value === 'string') return !LONE_SURROGATE.test(value);
  if (Array.isArray(value)) return value.every(wellFormed);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(([key, item]) => wellFormed(key) && wellFormed(item));
  }
  return true;
}

function jsonRoundtrip(): string {
  const entries = JSON_TEXTS.map((text) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { text, stringify: null, pretty: null };
    }
    return wellFormed(value)
      ? { text, stringify: JSON.stringify(value), pretty: JSON.stringify(value, null, 2) }
      : { text, stringify: null, pretty: null };
  });
  return lines({
    description:
      'JSON.stringify(JSON.parse(text)) and JSON.stringify(JSON.parse(text), null, 2) for kgdiff\'s JSON reader; null when the text is not JSON, or when it holds a lone surrogate escape (half of a surrogate pair, such as "\\ud800"), which JSON.parse accepts and kgdiff rejects (RFC 0002, D-2). Covers the order of object keys (array indices first), duplicate keys, number formatting and escapes.',
    entries,
  });
}

function facetLabels(): string {
  const labels: Record<string, Record<string, string>> = {};
  for (const locale of ['en', 'zh-CN'] as const) {
    labels[locale] = Object.fromEntries(
      FACET_ORDER.map((kind) => [kind, facetLabel(kind, locale)]),
    );
  }
  return `${JSON.stringify({ description: 'facetLabel(kind, locale) of @kgdiff/core for every facet kind, in canonical facet order.', labels }, null, 2)}\n`;
}

/** Every primitive vector, by file name. */
export function generatePrimitives(): Map<string, string> {
  return new Map([
    ['number-to-string.json', numberToString()],
    ['number-from-string.json', numberFromString()],
    ['js-math.json', jsMath()],
    ['log2.json', log2Vector()],
    ['string-order.json', stringOrder()],
    ['json-roundtrip.json', jsonRoundtrip()],
    ['text-similarity.json', textSimilarityVector()],
    ['predicate-label.json', predicateLabelVector()],
    ['label-width.json', labelWidthVector()],
    ['facet-labels.json', facetLabels()],
  ]);
}
