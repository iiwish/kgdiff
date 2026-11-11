/**
 * DOM-free text metrics: label widths are estimated from per-character advances so the layout
 * is identical in Node and in every browser (docs/algorithms.md §12 `estimateLabelWidth`).
 */

/** Advance widths in em. */
const EM_WIDE = 1;
const EM_DIGIT = 0.6;
const EM_UPPER = 0.68;
const EM_OTHER = 0.56;
const EM_SPACE = 0.3;
/** One regional indicator is half of a flag emoji (a flag is a pair). */
const EM_REGIONAL = 0.5;

/**
 * Code point ranges rendered full-width: East Asian Wide / Fullwidth blocks (CJK, kana, Hangul,
 * full-width forms) and emoji. Sorted, inclusive, non-overlapping (binary searched).
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initials
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2600, 0x27bf], // misc symbols, dingbats (mostly emoji presentation)
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, ideographic description, CJK symbols & punctuation
  [0x3041, 0x33ff], // kana, Bopomofo, Hangul compatibility, Kanbun, enclosed CJK, CJK compat
  [0x3400, 0x4dbf], // CJK Ext. A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Ext. A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small forms
  [0xff00, 0xff60], // full-width forms
  [0xffe0, 0xffe6],
  [0x16fe0, 0x18aff], // Tangut, Khitan…
  [0x1b000, 0x1b2ff], // kana supplements
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x1f300, 0x1f64f], // pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport & map
  [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff], // supplemental symbols & pictographs
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK Ext. B–F, compatibility supplement
  [0x30000, 0x3fffd], // CJK Ext. G+
];

const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}]/u;
const SPACE = /\s/u;
const DIGIT = /\p{Nd}/u;
const UPPER = /\p{Lu}/u;

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid];
    if (range === undefined) return false;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function asciiAdvance(cp: number): number {
  if (cp === 0x20 || cp === 0x09) return EM_SPACE;
  if (cp < 0x20 || cp === 0x7f) return 0;
  if (cp >= 0x30 && cp <= 0x39) return EM_DIGIT;
  if (cp >= 0x41 && cp <= 0x5a) return EM_UPPER;
  return EM_OTHER;
}

/** Advance of one code point, in em. */
function charAdvance(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (cp < 0x80) return asciiAdvance(cp);
  // Combining marks, joiners, variation selectors, emoji skin-tone modifiers draw no advance.
  if (ZERO_WIDTH.test(char) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 0;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return EM_REGIONAL;
  if (inRanges(cp, WIDE_RANGES)) return EM_WIDE;
  if (SPACE.test(char)) return EM_SPACE;
  if (DIGIT.test(char)) return EM_DIGIT;
  if (UPPER.test(char)) return EM_UPPER;
  return EM_OTHER;
}

/** Sum of per-character advances × font size. See the public `estimateLabelWidth`. */
export function labelWidth(text: string, fontSize: number): number {
  let em = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      em += asciiAdvance(unit);
      continue;
    }
    const cp = text.codePointAt(i) ?? unit;
    const char = String.fromCodePoint(cp);
    if (cp > 0xffff) i++;
    em += charAdvance(char);
  }
  return em * fontSize;
}

// ─── Label geometry (shared with bounds and collision) ───────────────────────

/** Gap between the node circle and the top of its label (world units, visual-language §Typography). */
export const LABEL_GAP = 5;
/** Height of one label line in em (12 px text + its 3 px halo). */
export const LINE_HEIGHT_EM = 1.25;
/** Renamed nodes show the old name 14 px (at 12 px text) below the new one, at 11/12 size. */
export const SECONDARY_OFFSET_EM = 14 / 12;
export const SECONDARY_SIZE_RATIO = 11 / 12;
/**
 * Reserved label width is capped so a pathological label (a 300-character IRI) cannot blow up
 * the layout; renderers truncate long labels anyway. 32 em ≈ 55 Latin characters.
 */
export const MAX_LABEL_EM = 32;

export interface LabelBox {
  /** Full width of the label block (world units). */
  readonly width: number;
  /** Full height of the label block, all lines. */
  readonly height: number;
}

/**
 * The block of text drawn centered below a node: its label and, for renamed nodes, the struck
 * old label on a second, slightly smaller line.
 */
export function labelBox(
  label: string,
  labelBefore: string | undefined,
  fontSize: number,
): LabelBox {
  const max = MAX_LABEL_EM * fontSize;
  let width = Math.min(max, labelWidth(label, fontSize));
  let height = LINE_HEIGHT_EM * fontSize;
  if (labelBefore !== undefined && labelBefore !== label) {
    const secondary = fontSize * SECONDARY_SIZE_RATIO;
    width = Math.max(width, Math.min(max, labelWidth(labelBefore, secondary)));
    height += SECONDARY_OFFSET_EM * fontSize;
  }
  return { width, height };
}
