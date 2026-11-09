//! DOM-free text metrics (`text-metrics.ts`): label widths are estimated from per-character
//! advances, so that the layout reserves the boxes the scene draws, identically everywhere.
//! `estimate_label_width` must equal TypeScript's `estimateLabelWidth` exactly (the scene sizes
//! label boxes with it): `conformance/primitives/label-width.json` pins it.

use icu_properties::CodePointMapDataBorrowed;
use icu_properties::props::GeneralCategory;
use kgdiff_core::js::is_whitespace;

use crate::math::{max, min};

/// Advance widths in em.
const EM_WIDE: f64 = 1.0;
const EM_DIGIT: f64 = 0.6;
const EM_UPPER: f64 = 0.68;
const EM_OTHER: f64 = 0.56;
const EM_SPACE: f64 = 0.3;
/// One regional indicator is half of a flag emoji (a flag is a pair).
const EM_REGIONAL: f64 = 0.5;

/// Code point ranges rendered full-width: East Asian Wide / Fullwidth blocks (CJK, kana,
/// Hangul, full-width forms) and emoji. Sorted, inclusive, non-overlapping (binary searched).
const WIDE_RANGES: &[(u32, u32)] = &[
    (0x1100, 0x115f), // Hangul Jamo initials
    (0x231a, 0x231b),
    (0x2329, 0x232a),
    (0x23e9, 0x23ec),
    (0x23f0, 0x23f0),
    (0x23f3, 0x23f3),
    (0x25fd, 0x25fe),
    (0x2600, 0x27bf), // misc symbols, dingbats (mostly emoji presentation)
    (0x2b1b, 0x2b1c),
    (0x2b50, 0x2b50),
    (0x2b55, 0x2b55),
    (0x2e80, 0x303e), // CJK radicals, Kangxi, ideographic description, CJK symbols & punctuation
    (0x3041, 0x33ff), // kana, Bopomofo, Hangul compatibility, Kanbun, enclosed CJK, CJK compat
    (0x3400, 0x4dbf), // CJK Ext. A
    (0x4e00, 0x9fff), // CJK Unified Ideographs
    (0xa000, 0xa4cf), // Yi
    (0xa960, 0xa97f), // Hangul Jamo Ext. A
    (0xac00, 0xd7a3), // Hangul syllables
    (0xf900, 0xfaff), // CJK compatibility ideographs
    (0xfe10, 0xfe19), // vertical forms
    (0xfe30, 0xfe6f), // CJK compatibility forms, small forms
    (0xff00, 0xff60), // full-width forms
    (0xffe0, 0xffe6),
    (0x16fe0, 0x18aff), // Tangut, Khitan…
    (0x1b000, 0x1b2ff), // kana supplements
    (0x1f004, 0x1f004),
    (0x1f0cf, 0x1f0cf),
    (0x1f18e, 0x1f18e),
    (0x1f191, 0x1f19a),
    (0x1f200, 0x1f2ff), // enclosed ideographic supplement
    (0x1f300, 0x1f64f), // pictographs, emoticons
    (0x1f680, 0x1f6ff), // transport & map
    (0x1f7e0, 0x1f7eb),
    (0x1f900, 0x1f9ff), // supplemental symbols & pictographs
    (0x1fa70, 0x1faff),
    (0x20000, 0x2fffd), // CJK Ext. B–F, compatibility supplement
    (0x30000, 0x3fffd), // CJK Ext. G+
];

fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn ascii_advance(cp: u32) -> f64 {
    match cp {
        0x20 | 0x09 => EM_SPACE,
        0..0x20 | 0x7f => 0.0,
        0x30..=0x39 => EM_DIGIT,
        0x41..=0x5a => EM_UPPER,
        _ => EM_OTHER,
    }
}

/// The advance of one character, in em: combining marks, enclosing marks, format and control
/// characters (`\p{Mn}\p{Me}\p{Cf}\p{Cc}`) and emoji skin-tone modifiers draw none; regional
/// indicators half an em; wide characters one; then JavaScript whitespace (`\s`), decimal digits
/// (`\p{Nd}`) and uppercase letters (`\p{Lu}`).
fn char_advance(c: char) -> f64 {
    let cp = u32::from(c);
    if cp < 0x80 {
        return ascii_advance(cp);
    }
    let category = CodePointMapDataBorrowed::<GeneralCategory>::new().get(c);
    if matches!(
        category,
        GeneralCategory::NonspacingMark
            | GeneralCategory::EnclosingMark
            | GeneralCategory::Format
            | GeneralCategory::Control
    ) || (0x1f3fb..=0x1f3ff).contains(&cp)
    {
        return 0.0;
    }
    if (0x1f1e6..=0x1f1ff).contains(&cp) {
        return EM_REGIONAL;
    }
    if in_ranges(cp, WIDE_RANGES) {
        return EM_WIDE;
    }
    if is_whitespace(c) {
        return EM_SPACE;
    }
    match category {
        GeneralCategory::DecimalNumber => EM_DIGIT,
        GeneralCategory::UppercaseLetter => EM_UPPER,
        _ => EM_OTHER,
    }
}

/// The sum of per-character advances × `font_size` (the public [`crate::estimate_label_width`]).
pub(crate) fn label_width(text: &str, font_size: f64) -> f64 {
    let mut em = 0.0;
    for c in text.chars() {
        em += char_advance(c);
    }
    em * font_size
}

// ─── Label geometry (shared with bounds and collision) ───────────────────────────────────────

/// The gap between the node circle and the top of its label (world units).
pub(crate) const LABEL_GAP: f64 = 5.0;
/// The height of one label line in em (12 px text and its 3 px halo).
pub(crate) const LINE_HEIGHT_EM: f64 = 1.25;
/// Renamed nodes show the old name 14 px (at 12 px text) below the new one, at 11/12 size.
pub(crate) const SECONDARY_OFFSET_EM: f64 = 14.0 / 12.0;
pub(crate) const SECONDARY_SIZE_RATIO: f64 = 11.0 / 12.0;
/// The reserved label width is capped, so that a pathological label (a 300-character IRI)
/// cannot blow the layout up; renderers truncate long labels anyway. 32 em ≈ 55 Latin
/// characters.
pub(crate) const MAX_LABEL_EM: f64 = 32.0;

/// The block of text drawn centered below a node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LabelBox {
    /// Full width of the label block (world units).
    pub width: f64,
    /// Full height of the block, all lines.
    pub height: f64,
}

/// The label of a node and, for renamed nodes, the struck old label on a second, slightly
/// smaller line.
pub(crate) fn label_box(label: &str, label_before: Option<&str>, font_size: f64) -> LabelBox {
    let cap = MAX_LABEL_EM * font_size;
    let mut width = min(cap, label_width(label, font_size));
    let mut height = LINE_HEIGHT_EM * font_size;
    if let Some(before) = label_before
        && before != label
    {
        let secondary = font_size * SECONDARY_SIZE_RATIO;
        width = max(width, min(cap, label_width(before, secondary)));
        height += SECONDARY_OFFSET_EM * font_size;
    }
    LabelBox { width, height }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_scripts_by_class() {
        assert_eq!(label_width("", 12.0), 0.0);
        assert_eq!(label_width("ab", 10.0), 11.200_000_000_000_001);
        assert_eq!(label_width("中文", 10.0), 20.0);
        // A flag is two regional indicators; a skin tone modifier and a joiner draw nothing.
        assert_eq!(label_width("🇨🇳", 10.0), 10.0);
        assert_eq!(label_width("👍🏽", 10.0), 10.0);
        assert_eq!(label_width("e\u{301}", 10.0), 5.600_000_000_000_000_5);
    }

    #[test]
    fn reserves_a_second_line_for_renames() {
        let one = label_box("New", None, 12.0);
        let two = label_box("New", Some("Old name"), 12.0);
        assert_eq!(one.height, 15.0);
        assert_eq!(two.height, 15.0 + 14.0);
        assert!(two.width > one.width);
        assert_eq!(
            label_box("Same", Some("Same"), 12.0),
            label_box("Same", None, 12.0)
        );
        assert_eq!(label_box(&"x".repeat(200), None, 12.0).width, 32.0 * 12.0);
    }
}
