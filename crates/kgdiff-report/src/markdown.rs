//! The GitHub-flavoured Markdown summary (`markdown.ts`): title, diffstat table, family legend,
//! the hunks that change a watched attribute, the hunk list grouped by phase and the possible
//! matches, in `<details>` blocks.

use icu_properties::CodePointMapDataBorrowed;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use kgdiff_core::model::{Hunk, SuggestionReason};
use kgdiff_core::{DiffResult, KgdiffError, Locale, js};

use crate::locale::{format_int, messages, watch_labels};
use crate::model::{
    ChangeFamily, DEFAULT_WATCH_ATTRS, group_by_phase, hunk_family, hunk_glyph, overview, percent,
    possible_matches, watched_changes, watched_of,
};
use crate::summary::totals_text;
use crate::width::reveal_invisible;

/// Hunks listed before "…and N more".
pub const MARKDOWN_HUNK_LIMIT: usize = 100;
/// Groups start expanded when the whole list is at most this long.
const OPEN_THRESHOLD: usize = 30;
/// Hunks listed under "Review first" before "…and N more".
pub const MARKDOWN_REVIEW_LIMIT: usize = 20;
/// Possible matches listed before "…and N more".
pub const MARKDOWN_POSSIBLE_LIMIT: usize = 20;
/// The possible matches start expanded when there are at most this many.
const POSSIBLE_OPEN_THRESHOLD: usize = 10;

/// Zero-width space: invisible, but enough to stop GitHub's autolinkers and filters.
const ZWSP: char = '\u{200B}';

fn family_square(family: ChangeFamily) -> &'static str {
    match family {
        ChangeFamily::Added => "🟩",
        ChangeFamily::Removed => "🟥",
        ChangeFamily::Content => "🟨",
        ChangeFamily::Structure => "🟦",
        ChangeFamily::Identity => "🟪",
    }
}

/// `\w` of a regular expression without the `u` flag.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b` before position `i`, where `chars[i]` is a word character.
fn boundary_before(chars: &[char], i: usize) -> bool {
    i == 0 || !is_word(chars[i - 1])
}

fn starts_with_ci(chars: &[char], i: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    chars.len() >= i + w.len()
        && chars[i..i + w.len()]
            .iter()
            .zip(&w)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// `escapeMarkdown`: untrusted text escaped for inline GFM.
pub fn escape_markdown(text: &str) -> String {
    let revealed = reveal_invisible(text);
    // `/[\u0000-\u001f\u2028\u2029]+/g` → one space; `/[\u007f-\u009f]/g` → nothing.
    let mut step: Vec<char> = Vec::with_capacity(revealed.len());
    let mut in_run = false;
    for c in revealed.chars() {
        let control = c <= '\u{1f}' || c == '\u{2028}' || c == '\u{2029}';
        if control {
            if !in_run {
                step.push(' ');
            }
            in_run = true;
            continue;
        }
        in_run = false;
        if ('\u{7f}'..='\u{9f}').contains(&c) {
            continue;
        }
        step.push(c);
    }
    // `/:([a-z0-9_+-]+):/gi` → `:\u200B$1:` (`:shortcode:` emoji).
    let chars = step;
    let mut step = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ':' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || "_+-".contains(chars[j]))
            {
                j += 1;
            }
            if j > i + 1 && chars.get(j) == Some(&':') {
                step.push(':');
                step.push(ZWSP);
                step.extend_from_slice(&chars[i + 1..j]);
                step.push(':');
                i = j + 1;
                continue;
            }
        }
        step.push(chars[i]);
        i += 1;
    }
    // `/\b(GH)-(?=\d)/gi` → `$1\u200B-`.
    let chars = step;
    let mut step = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if starts_with_ci(&chars, i, "gh")
            && boundary_before(&chars, i)
            && chars.get(i + 2) == Some(&'-')
            && chars.get(i + 3).is_some_and(char::is_ascii_digit)
        {
            step.extend_from_slice(&chars[i..i + 2]);
            step.push(ZWSP);
            step.push('-');
            i += 3;
            continue;
        }
        step.push(chars[i]);
        i += 1;
    }
    // `/([@#])(?=[\p{L}\p{N}_])/gu` → `$1\u200B` (mentions and references).
    let chars = step;
    let mut step = Vec::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        step.push(c);
        if (c == '@' || c == '#')
            && chars.get(i + 1).is_some_and(|&n| {
                let category = CodePointMapDataBorrowed::<GeneralCategory>::new().get(n);
                n == '_'
                    || GeneralCategoryGroup::Letter.contains(category)
                    || GeneralCategoryGroup::Number.contains(category)
            })
        {
            step.push(ZWSP);
        }
    }
    // `/:\/\//g` → `://\u200B`.
    let chars = step;
    let mut step = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ':' && chars.get(i + 1) == Some(&'/') && chars.get(i + 2) == Some(&'/') {
            step.extend_from_slice(&[':', '/', '/', ZWSP]);
            i += 3;
            continue;
        }
        step.push(chars[i]);
        i += 1;
    }
    // `/\b(www)\./gi` → `$1\u200B.`.
    let chars = step;
    let mut step = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if starts_with_ci(&chars, i, "www")
            && boundary_before(&chars, i)
            && chars.get(i + 3) == Some(&'.')
        {
            step.extend_from_slice(&chars[i..i + 3]);
            step.push(ZWSP);
            step.push('.');
            i += 4;
            continue;
        }
        step.push(chars[i]);
        i += 1;
    }
    // Markdown punctuation, then entities.
    let mut out = String::with_capacity(step.len() + 8);
    for c in step {
        match c {
            '\\' | '`' | '*' | '_' | '[' | ']' | '|' | '~' | '#' | '$' => {
                out.push('\\');
                out.push(c);
            }
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    js::trim(&out).to_owned()
}

/// `MarkdownOptions`.
pub struct MarkdownOptions<'a> {
    pub locale: Locale,
    pub title: &'a str,
    /// e.g. `kgdiff 0.1.0`.
    pub generator: &'a str,
    /// Watched attribute keys; `None` for the default definitions.
    pub watch: Option<&'a [String]>,
}

/// `renderMarkdown`. Deterministic: no timestamps.
pub fn render_markdown(
    diff: &DiffResult,
    options: &MarkdownOptions<'_>,
) -> Result<String, KgdiffError> {
    let m = messages(options.locale);
    let ov = overview(diff);
    let mut out: Vec<String> = vec![
        format!("## kgdiff · {}", escape_markdown(options.title)),
        String::new(),
    ];
    let totals = escape_markdown(&totals_text(diff, m));
    if ov.hunks == 0 {
        let detail = m.identical_detail(diff.stats.after.0, diff.stats.after.1);
        out.push(format!(
            "✅ **{}.** {}",
            m.identical(),
            escape_markdown(&detail)
        ));
        out.push(String::new());
    } else {
        out.push(format!(
            "**{}** · {totals}",
            escape_markdown(&m.changes(ov.changes, ov.hunks))
        ));
        out.push(String::new());
        // Table cells are sentence-cased (a no-op for Chinese).
        let cap = |v: &str| -> String {
            let mut chars = v.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        };
        let t = m.table();
        let s = &diff.stats;
        let pair = |b: usize, a: usize| format!("{} → {}", format_int(b), format_int(a));
        out.push(format!(
            "| | {} | {} | {} | {} | {} |",
            cap(t.added),
            cap(t.removed),
            cap(t.modified),
            cap(t.unchanged),
            cap(t.total)
        ));
        out.push("| :-- | --: | --: | --: | --: | --: |".to_owned());
        for (label, counts, (before, after)) in [
            (t.nodes, s.nodes, (s.before.0, s.after.0)),
            (t.edges, s.edges, (s.before.1, s.after.1)),
        ] {
            out.push(format!(
                "| **{}** | {} | {} | {} | {} | {} |",
                cap(label),
                format_int(counts.added),
                format_int(counts.removed),
                format_int(counts.modified),
                format_int(counts.unchanged),
                pair(before, after)
            ));
        }
        out.push(String::new());
        out.push(m.markdown_legend().to_owned());
        out.push(String::new());
        let default_watch: Vec<String> = DEFAULT_WATCH_ATTRS
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let watch = options.watch.unwrap_or(&default_watch);
        let watched = watched_changes(diff, watch);
        let item =
            |hunk: &Hunk| hunk_item(hunk, diff, options.locale, watched_of(&watched, &hunk.id));
        out.extend(review_first_section(
            diff,
            &watched,
            watch,
            options.locale,
            &item,
        )?);
        let mut budget = MARKDOWN_HUNK_LIMIT;
        let open = if ov.hunks <= OPEN_THRESHOLD {
            " open"
        } else {
            ""
        };
        for (phase, hunks) in group_by_phase(&diff.hunks) {
            if budget == 0 {
                break;
            }
            let listed = &hunks[..budget.min(hunks.len())];
            budget -= listed.len();
            out.push(format!("<details{open}>"));
            out.push(format!(
                "<summary>{} ({})</summary>",
                m.phase(phase),
                format_int(hunks.len())
            ));
            out.push(String::new());
            for hunk in listed {
                out.push(item(hunk)?);
            }
            out.push(String::new());
            out.push("</details>".to_owned());
            out.push(String::new());
        }
        if ov.hunks > MARKDOWN_HUNK_LIMIT {
            out.push(format!(
                "*{}*",
                escape_markdown(&m.markdown_more(ov.hunks - MARKDOWN_HUNK_LIMIT))
            ));
            out.push(String::new());
        }
        out.extend(possible_section(diff, options.locale));
    }
    out.push(format!(
        "*{}*",
        escape_markdown(&m.generated_by(options.generator))
    ));
    Ok(format!("{}\n", out.join("\n")))
}

/// A hunk as a list item (`hunkItem`).
fn hunk_item(
    hunk: &Hunk,
    diff: &DiffResult,
    locale: Locale,
    watched_keys: Option<&[String]>,
) -> Result<String, KgdiffError> {
    let m = messages(locale);
    let (title, subtitle) = kgdiff_core::format_hunk(hunk, diff, locale)?;
    let glyph = if hunk_glyph(hunk) == "~" {
        "\\~"
    } else {
        hunk_glyph(hunk)
    };
    let flag = watched_keys.map_or_else(String::new, |keys| {
        format!("⚑ {}", m.watch_marker(&watch_labels(keys, m)))
    });
    let note: Vec<&str> = [flag.as_str(), subtitle.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let note = note.join(" · ");
    Ok(format!(
        "- {} {glyph} {}{}",
        family_square(hunk_family(hunk)),
        escape_markdown(&title),
        if note.is_empty() {
            String::new()
        } else {
            format!(" — *{}*", escape_markdown(&note))
        }
    ))
}

type Watched = Vec<(String, Vec<String>)>;

fn review_first_section(
    diff: &DiffResult,
    watched: &Watched,
    watch: &[String],
    locale: Locale,
    item: &dyn Fn(&Hunk) -> Result<String, KgdiffError>,
) -> Result<Vec<String>, KgdiffError> {
    if watched.is_empty() {
        return Ok(Vec::new());
    }
    let m = messages(locale);
    let keys: Vec<&String> = watched.iter().flat_map(|(_, list)| list).collect();
    let order: Vec<String> = watch.iter().filter(|k| keys.contains(k)).cloned().collect();
    let labels = watch_labels(&order, m);
    let flagged: Vec<&Hunk> = group_by_phase(&diff.hunks)
        .into_iter()
        .flat_map(|(_, hunks)| hunks)
        .filter(|h| watched_of(watched, &h.id).is_some())
        .collect();
    let mut out = vec![
        "<details open>".to_owned(),
        format!(
            "<summary>⚑ {} ({})</summary>",
            m.markdown_review_first(),
            format_int(flagged.len())
        ),
        String::new(),
        format!(
            "*{}*",
            escape_markdown(&m.markdown_review_first_hint(&labels))
        ),
        String::new(),
    ];
    for hunk in flagged.iter().take(MARKDOWN_REVIEW_LIMIT) {
        out.push(item(hunk)?);
    }
    if flagged.len() > MARKDOWN_REVIEW_LIMIT {
        out.push(String::new());
        out.push(format!(
            "*{}*",
            escape_markdown(&m.markdown_review_first_more(flagged.len() - MARKDOWN_REVIEW_LIMIT))
        ));
    }
    out.push(String::new());
    out.push("</details>".to_owned());
    out.push(String::new());
    Ok(out)
}

fn possible_section(diff: &DiffResult, locale: Locale) -> Vec<String> {
    let possible = possible_matches(diff);
    if possible.is_empty() {
        return Vec::new();
    }
    let m = messages(locale);
    let threshold = percent(diff.options.r#match.threshold);
    let open = if possible.len() <= POSSIBLE_OPEN_THRESHOLD {
        " open"
    } else {
        ""
    };
    let mut out = vec![
        format!("<details{open}>"),
        format!(
            "<summary>{} ({})</summary>",
            m.possible_heading(),
            format_int(possible.len())
        ),
        String::new(),
        format!("*{}*", m.markdown_possible_hint()),
        String::new(),
    ];
    for p in possible.iter().take(MARKDOWN_POSSIBLE_LIMIT) {
        let reason = match p.reason {
            SuggestionReason::Ambiguous => m.possible_ambiguous().to_owned(),
            SuggestionReason::BelowThreshold => m.possible_below_threshold(&threshold),
        };
        let note = [
            percent(p.score),
            reason,
            m.possible_evidence(&percent(p.label), &percent(p.neighbors)),
        ]
        .join(" · ");
        out.push(format!(
            "- ≈ {} — *{note}*",
            escape_markdown(&m.possible_title(&p.before, &p.after))
        ));
    }
    if possible.len() > MARKDOWN_POSSIBLE_LIMIT {
        out.push(String::new());
        out.push(format!(
            "*{}*",
            escape_markdown(&m.markdown_possible_more(possible.len() - MARKDOWN_POSSIBLE_LIMIT))
        ));
    }
    out.push(String::new());
    out.push("</details>".to_owned());
    out.push(String::new());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_as_typescript() {
        assert_eq!(
            escape_markdown(" a *b* :smile: @x #1 GH-12 http://x www.y <i>&\u{202E} "),
            "a \\*b\\* :\u{200B}smile: @\u{200B}x \\#\u{200B}1 GH\u{200B}-12 http://\u{200B}x www\u{200B}.y &lt;i&gt;&amp;⟨U+202E⟩"
        );
        // Expectations computed with the TypeScript escapeMarkdown.
        let cases = [
            ("a\u{0}\u{1}b\u{85}c\u{9f}d", "a bcd"),
            (
                "ab:c:d :e: :_x: x:y:",
                "ab:\u{200B}c:d :\u{200B}e: :\u{200B}\\_x: x:\u{200B}y:",
            ),
            (
                "x_y __init__ ~a~ `c` |t| [l](u) !img > q",
                "x\\_y \\_\\_init\\_\\_ \\~a\\~ \\`c\\` \\|t\\| \\[l\\](u) !img &gt; q",
            ),
            (
                "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} \u{E0041}",
                "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} ⟨U+E0041⟩",
            ),
            (
                "1. list\n- item\n+ x\r\nnext\ttab",
                "1. list - item + x next tab",
            ),
            (
                "awww.x gh-1 GH-x @ # @@a #\u{4e2d}",
                "awww.x gh\u{200B}-1 GH-x @ \\# @@\u{200B}a \\#\u{200B}\u{4e2d}",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(escape_markdown(input), expected, "{input:?}");
        }
    }
}
