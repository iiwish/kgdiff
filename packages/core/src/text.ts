/**
 * Text similarity and display helpers (docs/algorithms.md §1–2).
 *
 * `textSimilarity` = max(character similarity, token-set similarity) on normalized text:
 *  - character similarity: Sørensen–Dice over character bigrams of the whitespace-free
 *    strings, or Jaro–Winkler when either string is shorter than 4 code points;
 *  - token-set similarity: Dice over the sets of word tokens (order-insensitive), where a
 *    token written as an abbreviation (`Univ.`) also matches a longer token it prefixes
 *    (`University`) with weight 0.9.
 *
 * All character work is done on code points, so astral characters (emoji, rare CJK)
 * count as one character.
 */
import { clamp01, round6 } from './util.js';

// ─── Normalization ───────────────────────────────────────────────────────────

const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
const SEPARATORS = /[\p{P}\s]+/gu;
/** Runs of token characters, optionally followed by an abbreviation period. */
const TOKEN = /[^\p{P}\s]+\.?/gu;
const LETTERS = /^\p{L}+$/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

const ASCII = /^[\x20-\x7e]*$/;

/**
 * Unicode NFC (canonical composition), with a fast path for printable ASCII. Applied to
 * labels, aliases and types so that "Café" written precomposed or decomposed is the same text.
 */
export function nfc(text: string): string {
  return ASCII.test(text) ? text : text.normalize('NFC');
}

/**
 * Unicode NFKC, lowercase, control / format characters removed, punctuation (including
 * `_-./`) and whitespace collapsed to single spaces, trimmed.
 */
export function normalizeText(text: string): string {
  return fold(text).replace(SEPARATORS, ' ').trim();
}

/** NFKC, lowercase, invisible characters removed; printable ASCII needs only the lowercasing. */
function fold(text: string): string {
  return ASCII.test(text)
    ? text.toLowerCase()
    : text.normalize('NFKC').toLowerCase().replace(INVISIBLE, '');
}

/** Precomputed representation of a string for repeated similarity queries. */
export interface TextProfile {
  /** NFKC, lowercased, invisible characters removed; punctuation kept. */
  readonly folded: string;
  readonly normalized: string;
  /** Code points of the normalized string without spaces. */
  readonly chars: readonly string[];
  /** Character-bigram multiset of `chars`. */
  readonly bigrams: ReadonlyMap<string, number>;
  readonly bigramTotal: number;
  /** Unique word tokens, sorted. */
  readonly tokens: readonly string[];
  /** Tokens written with a trailing period (`univ.`), letters only, ≥ 2 characters. */
  readonly abbreviations: ReadonlySet<string>;
  /** Numbers written in the text (digit runs, leading zeros dropped), sorted, unique. */
  readonly numbers: string;
}

const DIGITS = /\p{Nd}+/gu;

/** Digit runs as numbers ("007" → "7"), sorted and unique, joined: a cheap identity of the numbers. */
function numbersOf(normalized: string): string {
  const runs = normalized.match(DIGITS);
  if (!runs) return '';
  return [...new Set(runs.map((r) => r.replace(/^0+(?=.)/u, '')))].sort().join(' ');
}

const NO_ABBREVIATIONS: ReadonlySet<string> = new Set();

export function textProfile(text: string): TextProfile {
  const lowered = fold(text);
  const normalized = lowered.replace(SEPARATORS, ' ').trim();
  const tokenSet = new Set<string>();
  let abbreviations: Set<string> | undefined;
  for (const match of lowered.matchAll(TOKEN)) {
    const raw = match[0];
    const isAbbreviation = raw.endsWith('.');
    const token = isAbbreviation ? raw.slice(0, -1) : raw;
    tokenSet.add(token);
    if (isAbbreviation && token.length >= 2 && LETTERS.test(token)) {
      abbreviations ??= new Set();
      abbreviations.add(token);
    }
  }
  const chars = Array.from(normalized.replaceAll(' ', ''));
  const bigrams = new Map<string, number>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = (chars[i] as string) + (chars[i + 1] as string);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  return {
    folded: lowered,
    normalized,
    chars,
    bigrams,
    bigramTotal: Math.max(0, chars.length - 1),
    tokens: [...tokenSet].sort(),
    abbreviations: abbreviations ?? NO_ABBREVIATIONS,
    numbers: numbersOf(normalized),
  };
}

/** Memoizes `textProfile` for the lifetime of one matching run. */
export class ProfileCache {
  private readonly cache = new Map<string, TextProfile>();

  get(text: string): TextProfile {
    let profile = this.cache.get(text);
    if (!profile) {
      profile = textProfile(text);
      this.cache.set(text, profile);
    }
    return profile;
  }
}

// ─── Similarity measures ─────────────────────────────────────────────────────

/** Sørensen–Dice coefficient of two bigram multisets. */
function bigramDice(a: TextProfile, b: TextProfile): number {
  const total = a.bigramTotal + b.bigramTotal;
  if (total === 0) return 0;
  const [small, large] = a.bigrams.size <= b.bigrams.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [gram, count] of small.bigrams) {
    const other = large.bigrams.get(gram);
    if (other !== undefined) shared += Math.min(count, other);
  }
  return (2 * shared) / total;
}

/** Jaro–Winkler similarity (prefix scale 0.1, prefix length ≤ 4) over code points. */
export function jaroWinkler(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = new Array<boolean>(a.length).fill(false);
  const matchedB = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!matchedB[j] && a[i] === b[j]) {
        matchedA[i] = true;
        matchedB[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!matchedA[i]) continue;
    while (!matchedB[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  // The Winkler prefix bonus rewards a shared start of comparable words; for very short or
  // very unequal strings ("AB" vs "ABCDEFGH") it would turn a mere prefix into a near match.
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4 || shorter / Math.max(a.length, b.length) < 0.7) return jaro;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Ceiling of the similarity of texts that both mention numbers, but different ones. */
const NUMBER_MISMATCH_CAP = 0.5;

/** Weight of an abbreviation match (`univ.` ~ `university`) relative to an exact token match. */
const ABBREVIATION_WEIGHT = 0.9;

/** Dice over token sets; abbreviation-aware (see module comment). */
function tokenSetDice(a: TextProfile, b: TextProfile): number {
  const total = a.tokens.length + b.tokens.length;
  if (total === 0) return 0;
  const inB = new Set(b.tokens);
  const restA: string[] = [];
  let shared = 0;
  for (const token of a.tokens) {
    if (inB.has(token)) shared++;
    else restA.push(token);
  }
  if (a.abbreviations.size > 0 || b.abbreviations.size > 0) {
    const inA = new Set(a.tokens);
    const restB = b.tokens.filter((token) => !inA.has(token));
    shared += ABBREVIATION_WEIGHT * abbreviationMatches(restA, a.abbreviations, restB);
    // Abbreviations on the other side match tokens of `a` not consumed above.
    shared += ABBREVIATION_WEIGHT * abbreviationMatches(restB, b.abbreviations, restA);
  }
  return Math.min(1, (2 * shared) / total);
}

/**
 * Greedily pairs abbreviations from `from` with longer tokens of `into` they prefix.
 * Consumed tokens are removed from both arrays so the reverse pass cannot reuse them.
 */
function abbreviationMatches(
  from: string[],
  abbreviations: ReadonlySet<string>,
  into: string[],
): number {
  if (abbreviations.size === 0) return 0;
  let count = 0;
  for (let i = 0; i < from.length; i++) {
    const abbr = from[i] as string;
    if (!abbreviations.has(abbr)) continue;
    const j = into.findIndex((token) => token.length > abbr.length && token.startsWith(abbr));
    if (j < 0) continue;
    into.splice(j, 1);
    from.splice(i, 1);
    i--;
    count++;
  }
  return count;
}

/** `textSimilarity` on precomputed profiles. */
export function profileSimilarity(x: TextProfile, y: TextProfile): number {
  // Strings made only of punctuation normalize to '' and are compared as written.
  if (x.normalized === '' || y.normalized === '') return x.folded === y.folded ? 1 : 0;
  if (x.normalized === y.normalized) return 1;
  // Greedy steps (Jaro matching, abbreviation pairing) depend on argument order; a canonical
  // order makes the measure exactly symmetric.
  const [a, b] = x.normalized < y.normalized ? [x, y] : [y, x];
  const characters =
    a.chars.length < 4 || b.chars.length < 4 ? jaroWinkler(a.chars, b.chars) : bigramDice(a, b);
  const tokens = tokenSetDice(a, b);
  const best = clamp01(Math.max(characters, tokens));
  // "Type 1 diabetes" and "Type 2 diabetes", "Windows 10" and "Windows 11" name different
  // things however similar they look: when both texts mention numbers and the numbers differ,
  // the similarity is capped. (A number on one side only — "stg_orders" → "stg_orders_v2" —
  // is an ordinary edit.)
  const numbersDiffer = a.numbers !== b.numbers && a.numbers !== '' && b.numbers !== '';
  return round6(numbersDiffer ? Math.min(best, NUMBER_MISMATCH_CAP) : best);
}

/**
 * Similarity of two display strings in [0, 1] (docs/algorithms.md §2). Symmetric;
 * 1 for strings equal after normalization; rounded to 1e-6. Strings made only of punctuation
 * (which normalize to nothing) are 1 when equal as written and 0 otherwise.
 */
export function textSimilarity(a: string, b: string): number {
  return profileSimilarity(textProfile(a), textProfile(b));
}

// ─── Blocking keys ───────────────────────────────────────────────────────────

/** Function words that carry no identity on their own. */
// biome-ignore format: compact word list
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'de', 'der', 'des', 'di', 'die', 'du', 'el', 'en', 'et',
  'for', 'from', 'in', 'into', 'is', 'la', 'le', 'les', 'of', 'on', 'or', 'the', 'to', 'und',
  'van', 'von', 'with',
]);

/**
 * Inverted-index keys for candidate generation (docs/algorithms.md §2, step 4):
 *  - `f:` the whole normalized string;
 *  - `w:` word tokens of ≥ 2 characters that are not stop-words;
 *  - `p:` the first 4 characters of tokens of ≥ 4 characters (catches abbreviations,
 *    inflections and typos late in a word);
 *  - `b:` character bigrams of CJK runs (single-character runs as unigrams);
 *  - `r:` the text as written, for strings made only of punctuation.
 */
export function blockKeys(profile: TextProfile, into: Set<string>): void {
  addKeys(profile.normalized, profile.folded, profile.tokens, into);
}

/**
 * Keys for finding near-identical names (similarity ≥ 0.9, synonyms): the exact normalized
 * text, informative words and their first four characters. Cheaper than `blockKeys` (no
 * profile, no CJK bigrams): a name that close shares its full text, a word or a word start.
 */
export function nameKeys(texts: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    const normalized = normalizeText(text);
    if (normalized === '') continue;
    keys.add(`f:${normalized}`);
    for (const token of normalized.split(' ')) {
      if (token.length >= 2 && !STOP_WORDS.has(token)) keys.add(`w:${token}`);
      if (token.length >= 4) keys.add(`p:${token.slice(0, 4)}`);
    }
  }
  return [...keys];
}

function addKeys(
  normalized: string,
  folded: string,
  tokens: readonly string[],
  into: Set<string>,
): void {
  if (normalized === '') {
    if (folded !== '') into.add(`r:${folded}`);
    return;
  }
  into.add(`f:${normalized}`);
  for (const token of tokens) {
    const chars = Array.from(token);
    if (chars.length >= 2 && !STOP_WORDS.has(token)) into.add(`w:${token}`);
    if (chars.length >= 4) into.add(`p:${chars.slice(0, 4).join('')}`);
    for (const match of token.matchAll(CJK_RUN)) {
      const run = Array.from(match[0]);
      if (run.length === 1) into.add(`b:${run[0]}`);
      for (let i = 0; i + 1 < run.length; i++) into.add(`b:${run[i]}${run[i + 1]}`);
    }
  }
}

// ─── Predicates ──────────────────────────────────────────────────────────────

const OPAQUE_LOCAL = /^\d+$/;

function safeDecode(text: string): string {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Human-readable form of a predicate (docs/algorithms.md §1): the local part after the
 * last `#`, `/` or `:` (trailing separators ignored), percent-decoded, `_` → space, NFC.
 * camelCase is kept; opaque local parts made only of digits keep the whole predicate, and
 * opaque OBO PURLs read like their CURIE (`…/obo/RO_0002131` → `RO:0002131`).
 */
export function predicateLabel(predicate: string): string {
  return memoized(labels, predicate, computePredicateLabel);
}

/**
 * `predicateLabel` without its NFC step: what an edge snapshot without a label of its own
 * stands for in kgdiff JSON. The writer leaves a label out only when it equals this, so a
 * reader restores it without the runtime's Unicode tables (`diffFromJSON`).
 */
export function rawPredicateLabel(predicate: string): string {
  return memoized(rawLabels, predicate, computeRawPredicateLabel);
}

/** Predicates repeat across thousands of edges; a small bounded memo keeps this O(1). */
const labels = new Map<string, string>();
const rawLabels = new Map<string, string>();
const MAX_MEMO = 4096;

function memoized(
  memo: Map<string, string>,
  predicate: string,
  compute: (predicate: string) => string,
): string {
  let label = memo.get(predicate);
  if (label === undefined) {
    if (memo.size >= MAX_MEMO) memo.clear();
    label = compute(predicate);
    memo.set(predicate, label);
  }
  return label;
}

const OBO_PURL = /^https?:\/\/purl\.obolibrary\.org\/obo\/([A-Za-z][A-Za-z0-9]*)_(\d+)$/;

function computePredicateLabel(predicate: string): string {
  return nfc(computeRawPredicateLabel(predicate));
}

function computeRawPredicateLabel(predicate: string): string {
  // An opaque OBO PURL reads like its CURIE: …/obo/RO_0002131 → RO:0002131.
  const obo = OBO_PURL.exec(predicate);
  if (obo) return `${obo[1]}:${obo[2]}`;
  let end = predicate.length;
  while (end > 0 && '#/:'.includes(predicate.charAt(end - 1))) end--;
  const trimmed = predicate.slice(0, end);
  const cut = Math.max(
    trimmed.lastIndexOf('#'),
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf(':'),
  );
  const local = trimmed.slice(cut + 1);
  if (local === '' || OPAQUE_LOCAL.test(local)) return predicate;
  const readable = safeDecode(local).replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
  return readable === '' ? predicate : readable;
}
