//! Terminal widths, sanitizing, truncation, padding
//! and wrapping. The fast-check property runs over seeded pseudo-random strings.

use kgdiff_report::width::{
    grapheme_width, pad_end, pad_start, sanitize, string_width, truncate, wrap,
};

#[test]
fn counts_ascii_one_column_per_character() {
    assert_eq!(string_width("kgdiff 0.1.0"), 12);
    assert_eq!(string_width(""), 0);
}

#[test]
fn counts_cjk_kana_hangul_and_fullwidth_forms_as_two_columns() {
    assert_eq!(string_width("法定代表人"), 10);
    assert_eq!(string_width("カタカナ"), 8);
    assert_eq!(string_width("한국어"), 6);
    assert_eq!(string_width("ＡＢＣ"), 6);
    assert_eq!(string_width("「企业」（原）"), 14);
}

#[test]
fn counts_ambiguous_punctuation_used_by_the_cli_as_one_column() {
    for ch in ["→", "·", "…", "−", "⇄", "⊕", "⑂", "█", "“", "”"] {
        assert_eq!(string_width(ch), 1, "{ch}");
    }
}

#[test]
fn gives_combining_marks_joiners_and_variation_selectors_no_width() {
    assert_eq!(string_width("e\u{301}"), 1);
    assert_eq!(string_width("a\u{200b}b"), 2);
    assert_eq!(string_width("\u{301}"), 0);
}

#[test]
fn measures_emoji_as_two_columns() {
    assert_eq!(string_width("😀"), 2);
    assert_eq!(string_width("\u{1f469}\u{200d}\u{1f4bb}"), 2);
    assert_eq!(string_width("\u{1f1e8}\u{1f1f3}"), 2);
    assert_eq!(string_width("1\u{fe0f}\u{20e3}"), 2);
    assert_eq!(string_width("\u{1f44d}\u{1f3fd}"), 2);
    assert_eq!(string_width("\u{2764}\u{fe0f}"), 2);
    assert_eq!(string_width("\u{2764}\u{fe0e}"), 1);
    assert_eq!(string_width("🟩🟥"), 4);
}

#[test]
fn measures_mixed_text() {
    assert_eq!(string_width("「法人代表」合并入「法定代表人」"), 32);
    assert_eq!(string_width("Merged “A” → 「甲」"), 19);
}

#[test]
fn gives_control_characters_no_width() {
    assert_eq!(grapheme_width("\u{1b}"), 0);
    assert_eq!(grapheme_width(""), 0);
}

#[test]
fn sanitizes() {
    assert_eq!(sanitize("a\tb\nc\r\nd"), "a b c  d");
    let safe = sanitize("\u{1b}[31mred\u{1b}[0m");
    assert_eq!(safe, "\u{241b}[31mred\u{241b}[0m");
    assert_eq!(sanitize("a\u{9b}b\u{7f}"), "a\u{fffd}b\u{2421}");
    assert_eq!(sanitize("「企业」 → “x” 😀"), "「企业」 → “x” 😀");
}

#[test]
fn truncates_to_the_width_without_splitting_characters_or_clusters() {
    assert_eq!(truncate("hello", 5), "hello");
    assert_eq!(truncate("法定", 4), "法定");
    assert_eq!(truncate("hello world", 8), "hello w…");
    assert_eq!(string_width(&truncate("hello world", 8)), 8);
    assert_eq!(truncate("法定代表人", 5), "法定…");
    assert_eq!(truncate("法定代表人", 6), "法定…");
    assert_eq!(string_width(&truncate("法定代表人", 6)), 5);
    let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
    assert_eq!(truncate(&family.repeat(3), 4), format!("{family}…"));
    assert_eq!(truncate("e\u{301}e\u{301}e\u{301}", 2), "e\u{301}…");
    assert_eq!(truncate("hello", 1), "…");
    assert_eq!(truncate("hello", 0), "");
}

/// Pieces strings are made of in the property: ASCII, CJK, emoji, combining marks, joiners.
const PIECES: [&str; 12] = [
    "a",
    "Z",
    " ",
    "法",
    "カ",
    "😀",
    "\u{1f469}\u{200d}\u{1f4bb}",
    "e\u{301}",
    "\u{200b}",
    "\u{1f1e8}\u{1f1f3}",
    "…",
    "\u{2764}\u{fe0f}",
];

#[test]
fn never_exceeds_the_width() {
    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        usize::try_from(seed % u64::try_from(n).unwrap()).unwrap()
    };
    for _ in 0..2000 {
        let len = next(31);
        let text: String = (0..len).map(|_| PIECES[next(PIECES.len())]).collect();
        let width = next(41);
        assert!(
            string_width(&truncate(&text, width)) <= width,
            "{text:?} {width}"
        );
    }
}

#[test]
fn pads_and_wraps_by_display_width() {
    assert_eq!(pad_end("企业", 6), "企业  ");
    assert_eq!(pad_start("企业", 6), "  企业");
    assert_eq!(pad_end("toolong", 3), "toolong");
    assert_eq!(wrap("one two three four", 9), ["one two", "three", "four"]);
    assert_eq!(
        wrap("企业信用知识图谱本体目录", 8),
        ["企业信用", "知识图谱", "本体目录"]
    );
    for line in wrap(
        "Hierarchy predicate (repeatable); replaces the defaults",
        20,
    ) {
        assert!(string_width(&line) <= 20);
    }
}
