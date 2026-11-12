/**
 * Text helpers of the read path: NFC and predicate labels (docs/algorithms.md §1). Similarity
 * and blocking keys, which only matching uses, are computed by kgdiff's engine (`kgdiff-core`).
 */

// ─── Normalization ───────────────────────────────────────────────────────────

/** Printable ASCII, which every Unicode normalization form leaves unchanged. */
export const ASCII = /^[\x20-\x7e]*$/;

/**
 * Unicode NFC (canonical composition), with a fast path for printable ASCII. Applied to
 * labels, aliases and types so that "Café" written precomposed or decomposed is the same text.
 */
export function nfc(text: string): string {
  return ASCII.test(text) ? text : text.normalize('NFC');
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
