//! Terminal display width of text and the helpers built on it: sanitizing untrusted
//! labels, truncating with an ellipsis, padding and wrapping.
//!
//! CJK, fullwidth and emoji-presentation characters take two columns, combining marks, joiners
//! and variation selectors none, East Asian "ambiguous" characters one. Text is measured per
//! grapheme cluster (UAX #29, `icu_segmenter`, as `Intl.Segmenter`); the East Asian width table
//! is a fixed Unicode 16 table, as it is (RFC 0002, J-16).

use icu_properties::props::{Emoji, EmojiPresentation, GeneralCategory, RegionalIndicator};
use icu_properties::{CodePointMapDataBorrowed, CodePointSetDataBorrowed};
use icu_segmenter::GraphemeClusterSegmenter;
use kgdiff_core::js;

/// East Asian Width W and F ranges (Unicode 16), as inclusive pairs, sorted (`WIDE_RANGES`).
const WIDE_RANGES: &[(u32, u32)] = &[
    (0x1100, 0x115f),
    (0x231a, 0x231b),
    (0x2329, 0x232a),
    (0x23e9, 0x23ec),
    (0x23f0, 0x23f0),
    (0x23f3, 0x23f3),
    (0x25fd, 0x25fe),
    (0x2614, 0x2615),
    (0x2630, 0x2637),
    (0x2648, 0x2653),
    (0x267f, 0x267f),
    (0x268a, 0x268f),
    (0x2693, 0x2693),
    (0x26a1, 0x26a1),
    (0x26aa, 0x26ab),
    (0x26bd, 0x26be),
    (0x26c4, 0x26c5),
    (0x26ce, 0x26ce),
    (0x26d4, 0x26d4),
    (0x26ea, 0x26ea),
    (0x26f2, 0x26f3),
    (0x26f5, 0x26f5),
    (0x26fa, 0x26fa),
    (0x26fd, 0x26fd),
    (0x2705, 0x2705),
    (0x270a, 0x270b),
    (0x2728, 0x2728),
    (0x274c, 0x274c),
    (0x274e, 0x274e),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2795, 0x2797),
    (0x27b0, 0x27b0),
    (0x27bf, 0x27bf),
    (0x2b1b, 0x2b1c),
    (0x2b50, 0x2b50),
    (0x2b55, 0x2b55),
    (0x2e80, 0x2e99),
    (0x2e9b, 0x2ef3),
    (0x2f00, 0x2fd5),
    (0x2ff0, 0x303e),
    (0x3041, 0x3096),
    (0x3099, 0x30ff),
    (0x3105, 0x312f),
    (0x3131, 0x318e),
    (0x3190, 0x31e5),
    (0x31ef, 0x321e),
    (0x3220, 0x3247),
    (0x3250, 0xa48c),
    (0xa490, 0xa4c6),
    (0xa960, 0xa97c),
    (0xac00, 0xd7a3),
    (0xf900, 0xfaff),
    (0xfe10, 0xfe19),
    (0xfe30, 0xfe52),
    (0xfe54, 0xfe66),
    (0xfe68, 0xfe6b),
    (0xff01, 0xff60),
    (0xffe0, 0xffe6),
    (0x16fe0, 0x16fe4),
    (0x16ff0, 0x16ff1),
    (0x17000, 0x187f7),
    (0x18800, 0x18cd5),
    (0x18d00, 0x18d08),
    (0x1aff0, 0x1aff3),
    (0x1aff5, 0x1affb),
    (0x1affd, 0x1affe),
    (0x1b000, 0x1b122),
    (0x1b132, 0x1b132),
    (0x1b150, 0x1b152),
    (0x1b155, 0x1b155),
    (0x1b164, 0x1b167),
    (0x1b170, 0x1b2fb),
    (0x1d300, 0x1d356),
    (0x1d360, 0x1d376),
    (0x1f004, 0x1f004),
    (0x1f0cf, 0x1f0cf),
    (0x1f18e, 0x1f18e),
    (0x1f191, 0x1f19a),
    (0x1f200, 0x1f202),
    (0x1f210, 0x1f23b),
    (0x1f240, 0x1f248),
    (0x1f250, 0x1f251),
    (0x1f260, 0x1f265),
    (0x1f300, 0x1f320),
    (0x1f32d, 0x1f335),
    (0x1f337, 0x1f37c),
    (0x1f37e, 0x1f393),
    (0x1f3a0, 0x1f3ca),
    (0x1f3cf, 0x1f3d3),
    (0x1f3e0, 0x1f3f0),
    (0x1f3f4, 0x1f3f4),
    (0x1f3f8, 0x1f43e),
    (0x1f440, 0x1f440),
    (0x1f442, 0x1f4fc),
    (0x1f4ff, 0x1f53d),
    (0x1f54b, 0x1f54e),
    (0x1f550, 0x1f567),
    (0x1f57a, 0x1f57a),
    (0x1f595, 0x1f596),
    (0x1f5a4, 0x1f5a4),
    (0x1f5fb, 0x1f64f),
    (0x1f680, 0x1f6c5),
    (0x1f6cc, 0x1f6cc),
    (0x1f6d0, 0x1f6d2),
    (0x1f6d5, 0x1f6d7),
    (0x1f6dc, 0x1f6df),
    (0x1f6eb, 0x1f6ec),
    (0x1f6f4, 0x1f6fc),
    (0x1f7e0, 0x1f7eb),
    (0x1f7f0, 0x1f7f0),
    (0x1f90c, 0x1f93a),
    (0x1f93c, 0x1f945),
    (0x1f947, 0x1f9ff),
    (0x1fa70, 0x1fa7c),
    (0x1fa80, 0x1fa89),
    (0x1fa8f, 0x1fac6),
    (0x1face, 0x1fadc),
    (0x1fadf, 0x1fae9),
    (0x1faf0, 0x1faf8),
    (0x20000, 0x2fffd),
    (0x30000, 0x3fffd),
];

/// Whether the code point is East Asian Wide or Fullwidth.
pub fn is_wide_code_point(cp: u32) -> bool {
    if cp < 0x1100 {
        return false;
    }
    WIDE_RANGES
        .binary_search_by(|&(start, end)| {
            if cp < start {
                std::cmp::Ordering::Greater
            } else if cp > end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_zero_width(c: char) -> bool {
    matches!(
        CodePointMapDataBorrowed::<GeneralCategory>::new().get(c),
        GeneralCategory::NonspacingMark | GeneralCategory::EnclosingMark | GeneralCategory::Format
    )
}

fn is_emoji_presentation(c: char) -> bool {
    CodePointSetDataBorrowed::new::<EmojiPresentation>().contains(c)
}

fn is_emoji(c: char) -> bool {
    CodePointSetDataBorrowed::new::<Emoji>().contains(c)
}

fn is_regional_indicator(c: char) -> bool {
    CodePointSetDataBorrowed::new::<RegionalIndicator>().contains(c)
}

/// The display width of one grapheme cluster: 0, 1 or 2 columns.
pub fn grapheme_width(grapheme: &str) -> usize {
    let Some(first) = grapheme.chars().next() else {
        return 0;
    };
    let cp = u32::from(first);
    if cp < 0x20 || (0x7f..0xa0).contains(&cp) {
        return 0;
    }
    // `grapheme.length` counts UTF-16 units.
    let units = js::utf16_len(grapheme);
    if cp < 0x7f && units == 1 {
        return 1; // ASCII fast path
    }
    if units > 1 {
        // Emoji sequences: presentation selector, ZWJ sequences, flags, keycaps, skin tones.
        if grapheme.contains('\u{FE0F}') && grapheme.chars().any(is_emoji) {
            return 2;
        }
        if grapheme.contains('\u{200D}') && grapheme.chars().any(is_emoji_presentation) {
            return 2;
        }
        if grapheme.chars().any(is_regional_indicator) {
            return 2;
        }
    }
    if is_zero_width(first) {
        return 0;
    }
    if grapheme.contains('\u{FE0E}') {
        return 1; // text presentation selector
    }
    if is_wide_code_point(cp) || is_emoji_presentation(first) {
        return 2;
    }
    1
}

/// The grapheme clusters of `text` (`graphemes`).
pub fn graphemes(text: &str) -> Vec<&str> {
    let breaks: Vec<usize> = GraphemeClusterSegmenter::new().segment_str(text).collect();
    breaks.windows(2).map(|w| &text[w[0]..w[1]]).collect()
}

/// The byte index of UTF-16 offset `units` (clamped to the end; inside a pair, the pair's start).
pub fn byte_at_utf16(text: &str, units: usize) -> usize {
    let mut count = 0;
    for (i, c) in text.char_indices() {
        if count >= units || count + c.len_utf16() > units {
            return i;
        }
        count += c.len_utf16();
    }
    text.len()
}

/// The display width of `text` in terminal columns.
pub fn string_width(text: &str) -> usize {
    if text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return text.len();
    }
    graphemes(text).into_iter().map(grapheme_width).sum()
}

/// `⟨U+202E⟩` for a code point.
fn visible(c: char) -> String {
    format!("⟨U+{:04X}⟩", u32::from(c))
}

/// Characters that can disguise text ("Trojan Source"): bidirectional controls, zero-width
/// and invisible format characters, and tag characters outside emoji flag sequences.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{061C}' | '\u{180E}' | '\u{200B}' | '\u{200E}' | '\u{200F}'
        | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// `revealInvisible`: invisible and bidirectional control characters as a visible
/// `⟨U+202E⟩`. A tag character (U+E0000–U+E007F) stays when a black flag (U+1F3F4) and only
/// tag characters U+E0020–U+E007E precede it, as in an emoji flag sequence.
pub fn reveal_invisible(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if is_invisible(c) {
            out.push_str(&visible(c));
        } else if ('\u{E0000}'..='\u{E007F}').contains(&c) {
            let mut j = i;
            while j > 0 && ('\u{E0020}'..='\u{E007E}').contains(&chars[j - 1]) {
                j -= 1;
            }
            let in_flag = j > 0 && chars[j - 1] == '\u{1F3F4}';
            if in_flag {
                out.push(c);
            } else {
                out.push_str(&visible(c));
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// `sanitize`: untrusted text safe to print on one terminal line. Tabs and line breaks become
/// spaces, other C0 controls control pictures (`␛`), C1 controls U+FFFD, and invisible or
/// bidirectional controls a visible `⟨U+202E⟩`.
pub fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let cp = u32::from(c);
        match cp {
            0x09 | 0x0a | 0x0d | 0x2028 | 0x2029 => out.push(' '),
            0x00..=0x1f => out.push(char::from_u32(0x2400 + cp).unwrap_or('\u{FFFD}')),
            0x7f => out.push('\u{2421}'),
            0x80..=0x9f => out.push('\u{FFFD}'),
            _ => out.push(c),
        }
    }
    reveal_invisible(&out)
}

/// `sanitize` line by line, keeping line breaks (`sanitizeLines`: split on `\r?\n`).
pub fn sanitize_lines(text: &str) -> String {
    text.split('\n')
        .map(|line| sanitize(line.strip_suffix('\r').unwrap_or(line)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `truncate`: at most `max` columns, ending with `…` when something was cut. Never splits a
/// grapheme; a wide character that does not fit is dropped whole.
pub fn truncate(text: &str, max: usize) -> String {
    truncate_with(text, max, "…")
}

/// `truncate` with another ellipsis.
pub fn truncate_with(text: &str, max: usize, ellipsis: &str) -> String {
    if max == 0 {
        return String::new();
    }
    if string_width(text) <= max {
        return text.to_owned();
    }
    let Some(room) = max.checked_sub(string_width(ellipsis)) else {
        return String::new();
    };
    let mut width = 0;
    let mut out = String::new();
    for g in graphemes(text) {
        let w = grapheme_width(g);
        if width + w > room {
            break;
        }
        out.push_str(g);
        width += w;
    }
    let mut out = js::trim_end(&out).to_owned();
    out.push_str(ellipsis);
    out
}

/// `truncate` with a width that may be negative (JavaScript arithmetic): '' for `max` ≤ 0.
pub fn truncate_signed(text: &str, max: i64) -> String {
    match usize::try_from(max) {
        Ok(max) => truncate(text, max),
        Err(_) => String::new(),
    }
}

/// `padEnd`: spaces on the right to `width` columns.
pub fn pad_end(text: &str, width: usize) -> String {
    let gap = width.saturating_sub(string_width(text));
    format!("{text}{}", " ".repeat(gap))
}

/// `padStart`: spaces on the left to `width` columns.
pub fn pad_start(text: &str, width: usize) -> String {
    let gap = width.saturating_sub(string_width(text));
    format!("{}{text}", " ".repeat(gap))
}

/// `wrap`: greedy word wrap to `width` columns, breaking at spaces, and between graphemes in
/// text without spaces.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    if width == 0 || string_width(text) <= width {
        return vec![text.to_owned()];
    }
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut line_width = 0;
    let flush = |line: &mut String, line_width: &mut usize, lines: &mut Vec<String>| {
        lines.push(js::trim_end(line).to_owned());
        line.clear();
        *line_width = 0;
    };
    // `text.split(/(?<= )/)`: pieces that end after each space.
    let mut words = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if c == ' ' {
            words.push(&text[start..=i]);
            start = i + 1;
        }
    }
    if start < text.len() || words.is_empty() {
        words.push(&text[start..]);
    }
    for word in words {
        let w = string_width(word);
        if line_width + string_width(js::trim_end(word)) <= width {
            line.push_str(word);
            line_width += w;
            continue;
        }
        if line_width > 0 {
            flush(&mut line, &mut line_width, &mut lines);
        }
        if string_width(js::trim_end(word)) <= width {
            line = word.to_owned();
            line_width = w;
            continue;
        }
        for g in graphemes(word) {
            let gw = grapheme_width(g);
            if line_width + gw > width && line_width > 0 {
                flush(&mut line, &mut line_width, &mut lines);
            }
            line.push_str(g);
            line_width += gw;
        }
    }
    if !js::trim(&line).is_empty() {
        lines.push(js::trim_end(&line).to_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_as_terminals_render() {
        assert_eq!(string_width("abc"), 3);
        assert_eq!(string_width("中文"), 4);
        assert_eq!(string_width("e\u{301}"), 1);
        assert_eq!(string_width("👨‍👩‍👧"), 2);
        assert_eq!(string_width("🇨🇳"), 2);
        assert_eq!(string_width("→·…"), 3);
        assert_eq!(string_width("\u{200B}"), 0);
    }

    #[test]
    fn sanitizes_and_truncates() {
        assert_eq!(
            sanitize("a\tb\u{1b}c\u{85}d\u{202E}e"),
            "a b␛c\u{FFFD}d⟨U+202E⟩e"
        );
        assert_eq!(
            reveal_invisible("\u{1F3F4}\u{E0067}\u{E0062}\u{E007F} x\u{E0067}"),
            "\u{1F3F4}\u{E0067}\u{E0062}\u{E007F} x⟨U+E0067⟩"
        );
        assert_eq!(truncate("abcdef", 4), "abc…");
        assert_eq!(truncate("中文中文", 5), "中文…");
        assert_eq!(truncate("ab cd", 4), "ab…");
        assert_eq!(wrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
        assert_eq!(wrap("中文中文中文", 4), ["中文", "中文", "中文"]);
    }
}
