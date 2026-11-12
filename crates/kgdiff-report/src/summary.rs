//! The terminal outputs: the default summary (header, counters, diffstat bar,
//! hunk list, possible matches), `--stat` and `--name-status`.
//!
//! Every line is laid out on plain text first (measured with `string_width`, truncated with an
//! ellipsis) and painted last. Widths are signed, as JavaScript computes them: a negative room
//! truncates to nothing.

use kgdiff_core::model::{CountDelta, Hunk};
use kgdiff_core::util::count_to_f64;
use kgdiff_core::{DiffResult, KgdiffError, Locale};

use crate::locale::{Messages, format_int, messages, watch_labels};
use crate::model::{
    COUNTER_PHASES, ChangeFamily, DEFAULT_WATCH_ATTRS, Overview, PossibleMatch, apportion,
    group_by_phase, hunk_family, hunk_glyph, name_status, overview, percent, phase_family,
    phase_glyph, possible_matches, watched_changes, watched_of,
};
use crate::paint::{Painter, Tone};
use crate::width::{byte_at_utf16, sanitize, string_width, wrap};

/// What the text outputs need to know.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct TextContext {
    /// Applies colors and text attributes; [`Painter::plain`] for none.
    pub paint: Painter,
    /// The language of the output.
    pub locale: Locale,
    /// Maximum line width in columns.
    pub width: usize,
    /// Maximum hunks listed in the summary; 0 lists all.
    pub limit: usize,
    /// Attribute keys whose changes are flagged ⚑ for review first; `None` for the default
    /// definitions, an empty list flags nothing.
    pub watch: Option<Vec<String>>,
}

impl TextContext {
    /// A context with the default width (80 columns), every hunk listed and the default watched
    /// attribute keys.
    pub fn new(paint: Painter, locale: Locale) -> TextContext {
        TextContext {
            paint,
            locale,
            width: 80,
            limit: 0,
            watch: None,
        }
    }

    fn watch(&self) -> Vec<String> {
        self.watch.clone().unwrap_or_else(|| {
            DEFAULT_WATCH_ATTRS
                .iter()
                .map(|s| (*s).to_owned())
                .collect()
        })
    }
}

const FLAG: &str = "⚑";
const INDENT: &str = "  ";
const BRAND: &str = "kgdiff";
const COMFORT_WIDTH: i64 = 72;
const MAX_BAR: i64 = 50;
const COLUMN_GAP: i64 = 3;
const MIN_TITLE: i64 = 16;
const MIN_SUMMARY: i64 = 22;
const COUNTER_GAP: &str = "   ";
/// Glyph of a possible match: “maybe the same”.
const POSSIBLE_GLYPH: &str = "≈";
/// Possible matches listed before "… and N more" (all with `--limit 0`).
pub const POSSIBLE_LIMIT: usize = 10;
const MAX_TYPE_ROWS: usize = 12;
const MAX_TYPE_NAME: i64 = 28;

fn sw(text: &str) -> i64 {
    i64::try_from(string_width(text)).unwrap_or(i64::MAX)
}

fn len(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// `truncate` with a JavaScript (possibly negative) width.
fn truncate(text: &str, max: i64) -> String {
    crate::width::truncate_signed(text, max)
}

fn spaces(n: i64) -> String {
    " ".repeat(usize::try_from(n).unwrap_or(0))
}

fn pad_end(text: &str, width: i64) -> String {
    let gap = width - sw(text);
    format!("{text}{}", spaces(gap))
}

fn pad_start(text: &str, width: i64) -> String {
    let gap = width - sw(text);
    format!("{}{text}", spaces(gap))
}

/// `text.slice(from, to)` in UTF-16 units (at character boundaries).
fn slice16(text: &str, from: usize, to: usize) -> &str {
    let byte = |units: usize| byte_at_utf16(text, units);
    let (a, b) = (byte(from), byte(to.max(from)));
    &text[a..b]
}

/// `179 → 184 nodes · 351 → 353 edges`.
pub fn totals_text(diff: &DiffResult, m: Messages) -> String {
    let (before, after) = (diff.stats.before, diff.stats.after);
    m.totals((before.0, after.0), (before.1, after.1))
}

struct Painted {
    plain: String,
    painted: String,
}

/// Left and right text on one line, right-aligned to `width`; wraps the right part if needed.
fn spread(left: &Painted, right: &Painted, width: i64) -> Vec<String> {
    let gap = width - sw(&left.plain) - sw(&right.plain);
    if right.plain.is_empty() {
        return vec![left.painted.clone()];
    }
    if gap >= COLUMN_GAP {
        return vec![format!("{}{}{}", left.painted, spaces(gap), right.painted)];
    }
    let room = width - len(INDENT.len());
    let shown = if sw(&right.plain) <= room {
        right.painted.clone()
    } else {
        truncate(&right.plain, room)
    };
    vec![left.painted.clone(), format!("{INDENT}{shown}")]
}

fn header_lines(diff: &DiffResult, title: &str, ctx: &TextContext, width: i64) -> Vec<String> {
    let m = messages(ctx.locale);
    let paint = &ctx.paint;
    let right = totals_text(diff, m);
    let fixed = len(BRAND.len()) + 2;
    let fits_beside = width - fixed - COLUMN_GAP - sw(&right) >= 12;
    let title_room = if fits_beside {
        width - fixed - COLUMN_GAP - sw(&right)
    } else {
        width - fixed
    };
    let shown = truncate(&sanitize(title), title_room);
    let left = Painted {
        plain: format!("{BRAND}  {shown}"),
        painted: format!(
            "{}  {}",
            paint.bold(&paint.tone(Tone::Accent, BRAND)),
            paint.bold(&shown)
        ),
    };
    spread(
        &left,
        &Painted {
            painted: paint.dim(&right),
            plain: right,
        },
        width,
    )
}

fn counter_items(ov: &Overview, m: Messages, paint: &Painter) -> Vec<Painted> {
    let mut items = Vec::new();
    for phase in COUNTER_PHASES {
        let n = ov.phase(phase).hunks;
        if n == 0 {
            continue;
        }
        let count = format!("{}{}", phase_glyph(phase), format_int(n));
        items.push(Painted {
            plain: format!("{count} {}", m.counter(phase)),
            painted: format!(
                "{} {}",
                paint.bold(&paint.tone(phase_family(phase).tone(), &count)),
                m.counter(phase)
            ),
        });
    }
    items
}

/// Counter items joined on one line, or wrapped over several lines to fit `room`.
fn counter_lines(items: Vec<Painted>, room: i64) -> Vec<Painted> {
    let mut lines: Vec<(Vec<String>, Vec<String>)> = Vec::new();
    for item in items {
        let fits = lines.last().is_some_and(|(plain, _)| {
            let width = sw(&plain.join(COUNTER_GAP)) + len(COUNTER_GAP.len());
            width + sw(&item.plain) <= room
        });
        match lines.last_mut() {
            Some((plain, painted)) if fits => {
                plain.push(item.plain);
                painted.push(item.painted);
            }
            _ => lines.push((vec![item.plain], vec![item.painted])),
        }
    }
    lines
        .into_iter()
        .map(|(plain, painted)| Painted {
            plain: plain.join(COUNTER_GAP),
            painted: painted.join(COUNTER_GAP),
        })
        .collect()
}

/// The proportional diffstat bar: one segment per phase, sized by changed elements.
pub fn diffstat_bar(ov: &Overview, width: usize, paint: &Painter) -> String {
    let width = len(width);
    let cap = (width - len(INDENT.len()) * 2).clamp(10, MAX_BAR);
    let total = usize::try_from(len(ov.changes).min(cap)).unwrap_or(0);
    let weights: Vec<usize> = COUNTER_PHASES
        .iter()
        .map(|&p| ov.phase(p).changes)
        .collect();
    let cells = apportion(&weights, total);
    COUNTER_PHASES
        .iter()
        .zip(cells)
        .map(|(&phase, n)| {
            if n == 0 {
                String::new()
            } else if paint.level == 0 {
                phase_glyph(phase).repeat(n)
            } else {
                paint.tone(phase_family(phase).tone(), &"█".repeat(n))
            }
        })
        .collect()
}

type Watched = Vec<(String, Vec<String>)>;

/// `⚑ Review first: definition changed in 10 hunks`; none without flags.
fn review_first_lines(watched: &Watched, ctx: &TextContext, width: i64) -> Vec<String> {
    if watched.is_empty() {
        return Vec::new();
    }
    let m = messages(ctx.locale);
    let keys: Vec<&String> = watched.iter().flat_map(|(_, list)| list).collect();
    let order: Vec<String> = ctx
        .watch()
        .into_iter()
        .filter(|k| keys.contains(&k))
        .collect();
    let text = m.watch_line(&watch_labels(&order, m), watched.len());
    let room = width - len(INDENT.len()) - sw(FLAG) - 1;
    vec![format!(
        "{INDENT}{} {}",
        ctx.paint.tone(Tone::Accent, FLAG),
        truncate(&sanitize(&text), room)
    )]
}

fn stat_lines(ov: &Overview, ctx: &TextContext, width: i64, watched: &Watched) -> Vec<String> {
    let m = messages(ctx.locale);
    let right = m.changes(ov.changes, ov.hunks);
    let mut rows = counter_lines(counter_items(ov, m, &ctx.paint), width - len(INDENT.len()));
    let last = rows.pop().unwrap_or(Painted {
        plain: String::new(),
        painted: String::new(),
    });
    let mut lines: Vec<String> = rows
        .into_iter()
        .map(|r| format!("{INDENT}{}", r.painted))
        .collect();
    lines.extend(spread(
        &Painted {
            plain: format!("{INDENT}{}", last.plain),
            painted: format!("{INDENT}{}", last.painted),
        },
        &Painted {
            painted: ctx.paint.dim(&right),
            plain: right,
        },
        width,
    ));
    lines.push(format!(
        "{INDENT}{}",
        diffstat_bar(ov, usize::try_from(width).unwrap_or(0), &ctx.paint)
    ));
    lines.extend(review_first_lines(watched, ctx, width));
    lines
}

fn identical_lines(diff: &DiffResult, ctx: &TextContext, width: i64) -> Vec<String> {
    let m = messages(ctx.locale);
    let paint = &ctx.paint;
    let detail = m.identical_detail(diff.stats.after.0, diff.stats.after.1);
    let head = format!("✓ {}", m.identical());
    let room = width - len(INDENT.len());
    let check = paint.tone(Tone::Added, "✓");
    if sw(&head) + 2 + sw(&detail) <= room {
        return vec![format!(
            "{INDENT}{check} {}  {}",
            paint.bold(m.identical()),
            paint.dim(&detail)
        )];
    }
    let mut lines = vec![format!("{INDENT}{check} {}", paint.bold(m.identical()))];
    for line in wrap(&detail, usize::try_from(room).unwrap_or(0)) {
        lines.push(format!("{INDENT}{}", paint.dim(&line)));
    }
    lines
}

/// A line of the hunk list (or of the possible matches).
struct Row {
    tone: Tone,
    glyph: &'static str,
    title: String,
    family: String,
    /// Watched attributes the hunk changes, shown as `⚑ definition`.
    flag: Option<String>,
    subtitle: String,
}

fn rows_of(
    diff: &DiffResult,
    hunks: &[&Hunk],
    ctx: &TextContext,
    watched: &Watched,
) -> Result<Vec<Row>, KgdiffError> {
    let m = messages(ctx.locale);
    hunks
        .iter()
        .map(|hunk| {
            let (title, subtitle) = kgdiff_core::format_hunk(hunk, diff, ctx.locale)?;
            let family: ChangeFamily = hunk_family(hunk);
            Ok(Row {
                tone: family.tone(),
                glyph: hunk_glyph(hunk),
                title: sanitize(&title),
                family: m.family(family).to_owned(),
                flag: watched_of(watched, &hunk.id)
                    .map(|keys| sanitize(&m.watch_marker(&watch_labels(keys, m)))),
                subtitle: sanitize(&subtitle),
            })
        })
        .collect()
}

/// What follows the family label: ` · ⚑ definition · <subtitle>`.
fn rest_text(row: &Row) -> String {
    let mut out = String::new();
    if let Some(flag) = &row.flag {
        out.push_str(&format!(" · {FLAG} {flag}"));
    }
    if !row.subtitle.is_empty() {
        out.push_str(&format!(" · {}", row.subtitle));
    }
    out
}

fn right_text(row: &Row) -> String {
    format!("{}{}", row.family, rest_text(row))
}

/// Possible match rows: both names, the score, why it was not applied and the evidence.
fn possible_rows(diff: &DiffResult, list: &[PossibleMatch], ctx: &TextContext) -> Vec<Row> {
    let m = messages(ctx.locale);
    let threshold = percent(diff.options.r#match.threshold);
    list.iter()
        .map(|p| {
            let reason = match p.reason {
                kgdiff_core::model::SuggestionReason::Ambiguous => {
                    m.possible_ambiguous().to_owned()
                }
                kgdiff_core::model::SuggestionReason::BelowThreshold => {
                    m.possible_below_threshold(&threshold)
                }
            };
            Row {
                tone: Tone::Identity,
                glyph: POSSIBLE_GLYPH,
                title: sanitize(&m.possible_title(&p.before, &p.after)),
                family: percent(p.score),
                flag: None,
                subtitle: sanitize(&format!(
                    "{reason} · {}",
                    m.possible_evidence(&percent(p.label), &percent(p.neighbors))
                )),
            }
        })
        .collect()
}

/// The natural width of a hunk list (before any truncation).
fn list_width(rows: &[&Row]) -> i64 {
    let title = rows.iter().map(|r| sw(&r.title)).max().unwrap_or(0);
    let right = rows.iter().map(|r| sw(&right_text(r))).max().unwrap_or(0);
    len(INDENT.len()) + 2 + title + COLUMN_GAP + right
}

#[derive(Clone, Copy)]
struct Columns {
    title: i64,
    right: i64,
}

/// Column widths for a hunk list.
fn list_columns(rows: &[&Row], width: i64) -> Columns {
    let room = width - len(INDENT.len()) - 2 - COLUMN_GAP;
    let max_title = rows.iter().map(|r| sw(&r.title)).max().unwrap_or(0);
    let max_right = rows.iter().map(|r| sw(&right_text(r))).max().unwrap_or(0);
    let max_family = rows.iter().map(|r| sw(&r.family)).max().unwrap_or(0);
    if max_title + max_right <= room {
        return Columns {
            title: max_title,
            right: max_right,
        };
    }
    if room - max_family < MIN_TITLE {
        return Columns {
            title: width - len(INDENT.len()) - 2,
            right: 0,
        };
    }
    let min_right = max_right.min(max_family + MIN_SUMMARY.min(room.div_euclid(4)));
    let title = MIN_TITLE.max(max_title.min(room - min_right));
    Columns {
        title,
        right: max_family.max(max_right.min(room - title)),
    }
}

fn render_row(row: &Row, cols: Columns, ctx: &TextContext) -> String {
    let paint = &ctx.paint;
    let glyph = paint.tone(row.tone, row.glyph);
    if cols.right == 0 {
        return format!("{INDENT}{glyph} {}", truncate(&row.title, cols.title));
    }
    let title = pad_end(&truncate(&row.title, cols.title), cols.title);
    let rest_room = cols.right - sw(&row.family);
    let full = rest_text(row);
    let rest = if !full.is_empty() && rest_room >= 6 {
        truncate(&full, rest_room)
    } else {
        String::new()
    };
    // The flag comes first, so it survives truncation, and keeps the accent colour.
    let flag = row
        .flag
        .as_ref()
        .map_or_else(String::new, |f| format!(" · {FLAG} {f}"));
    let rest_units = kgdiff_core::js::utf16_len(&rest);
    let flag_shown = if flag.is_empty() {
        ""
    } else {
        slice16(&rest, 0, rest_units.min(kgdiff_core::js::utf16_len(&flag)))
    };
    let painted = if flag_shown.is_empty() {
        String::new()
    } else {
        let units = kgdiff_core::js::utf16_len(flag_shown);
        format!(
            "{}{}",
            paint.dim(slice16(flag_shown, 0, 3)),
            paint.tone(Tone::Accent, slice16(flag_shown, 3.min(units), units))
        )
    };
    let after_flag = slice16(&rest, kgdiff_core::js::utf16_len(flag_shown), rest_units);
    format!(
        "{INDENT}{glyph} {title}{}{}{painted}{}",
        spaces(COLUMN_GAP),
        paint.tone(row.tone, &row.family),
        paint.dim(after_flag)
    )
}

/// The line width for a layout that naturally needs `natural` columns.
fn layout_width(natural: i64, available: i64) -> i64 {
    available.min(natural.max(COMFORT_WIDTH))
}

fn header_natural(diff: &DiffResult, title: &str, ctx: &TextContext, ov: &Overview) -> i64 {
    let m = messages(ctx.locale);
    let header = len(BRAND.len()) + 2 + sw(&sanitize(title)) + COLUMN_GAP;
    let plain: Vec<String> = counter_items(ov, m, &ctx.paint)
        .into_iter()
        .map(|i| i.plain)
        .collect();
    let counters = len(INDENT.len()) + sw(&plain.join(COUNTER_GAP)) + COLUMN_GAP;
    (header + sw(&totals_text(diff, m))).max(counters + sw(&m.changes(ov.changes, ov.hunks)))
}

/// The default terminal output.
///
/// # Errors
///
/// Returns an `invalid-input` error when `diff` is inconsistent, for example when a hunk does not belong to it.
pub fn render_summary(
    diff: &DiffResult,
    title: &str,
    ctx: &TextContext,
) -> Result<String, KgdiffError> {
    let ov = overview(diff);
    let available = len(ctx.width);
    if ov.hunks == 0 {
        let width = layout_width(header_natural(diff, title, ctx, &ov), available);
        let mut lines = header_lines(diff, title, ctx, width);
        lines.push(String::new());
        lines.extend(identical_lines(diff, ctx, width));
        return Ok(format!("{}\n", lines.join("\n")));
    }
    let watched = watched_changes(diff, &ctx.watch());
    let m = messages(ctx.locale);
    let paint = &ctx.paint;
    let groups = group_by_phase(&diff.hunks);
    let mut shown = 0;
    let budget = if ctx.limit > 0 { ctx.limit } else { usize::MAX };
    let mut listed = Vec::new();
    for (phase, hunks) in &groups {
        let take = budget.saturating_sub(shown).min(hunks.len());
        shown += take;
        listed.push((
            *phase,
            hunks.len(),
            rows_of(diff, &hunks[..take], ctx, &watched)?,
        ));
    }
    let possible = possible_matches(diff);
    let possible_count = if ctx.limit > 0 {
        ctx.limit.min(POSSIBLE_LIMIT).min(possible.len())
    } else {
        possible.len()
    };
    let possible_list = possible_rows(diff, &possible[..possible_count], ctx);
    let all_rows: Vec<&Row> = listed.iter().flat_map(|(_, _, rows)| rows).collect();
    let possible_refs: Vec<&Row> = possible_list.iter().collect();
    let width = layout_width(
        header_natural(diff, title, ctx, &ov)
            .max(list_width(&all_rows))
            .max(list_width(&possible_refs)),
        available,
    );
    let cols = list_columns(&all_rows, width);
    // Columns of their own: the reason and evidence matter more here than lining up with the
    // hunks above (the section has its own heading).
    let possible_cols = list_columns(&possible_refs, width);
    let mut lines = header_lines(diff, title, ctx, width);
    lines.push(String::new());
    lines.extend(stat_lines(&ov, ctx, width, &watched));
    lines.push(String::new());
    for (phase, total, rows) in &listed {
        if rows.is_empty() {
            continue;
        }
        lines.push(format!(
            "{INDENT}{} {}",
            paint.bold(m.phase(*phase)),
            paint.dim(&format_int(*total))
        ));
        for row in rows {
            lines.push(render_row(row, cols, ctx));
        }
    }
    let hidden = ov.hunks - shown;
    if hidden > 0 {
        let more = format!("{} · {}", m.more(hidden), m.more_hint());
        lines.push(format!(
            "{INDENT}{}",
            paint.dim(&truncate(&more, width - len(INDENT.len())))
        ));
    }
    if !possible.is_empty() {
        lines.push(String::new());
        lines.push(format!(
            "{INDENT}{} {}",
            paint.bold(m.possible_heading()),
            paint.dim(&format_int(possible.len()))
        ));
        for row in &possible_list {
            lines.push(render_row(row, possible_cols, ctx));
        }
        let not_listed = possible.len() - possible_count;
        if not_listed > 0 {
            lines.push(format!(
                "{INDENT}{}",
                paint.dim(&truncate(
                    &m.possible_more(not_listed),
                    width - len(INDENT.len())
                ))
            ));
        }
        for line in wrap(
            m.possible_hint(),
            usize::try_from(width - len(INDENT.len())).unwrap_or(0),
        ) {
            lines.push(format!("{INDENT}{}", paint.dim(&line)));
        }
    }
    Ok(format!("{}\n", lines.join("\n")))
}

/// `--stat`: header, counters and bar, the counts table and the per-type lines.
pub fn render_stat(diff: &DiffResult, title: &str, ctx: &TextContext) -> String {
    let ov = overview(diff);
    let width = layout_width(header_natural(diff, title, ctx, &ov), len(ctx.width));
    let mut lines = header_lines(diff, title, ctx, width);
    lines.push(String::new());
    if ov.hunks == 0 {
        lines.extend(identical_lines(diff, ctx, width));
        return format!("{}\n", lines.join("\n"));
    }
    let watched = watched_changes(diff, &ctx.watch());
    lines.extend(stat_lines(&ov, ctx, width, &watched));
    lines.push(String::new());
    lines.extend(counts_table(diff, ctx, width));
    lines.push(String::new());
    lines.extend(type_lines(diff, ctx, width));
    format!("{}\n", lines.join("\n"))
}

/// A column of the counts table: its heading, the count it shows and its colour.
type Column<'a> = (&'a str, fn(&CountDelta) -> usize, Option<Tone>);

/// Node / edge counts; columns are dropped from the right when the line is too narrow.
fn counts_table(diff: &DiffResult, ctx: &TextContext, width: i64) -> Vec<String> {
    let m = messages(ctx.locale);
    let paint = &ctx.paint;
    let t = m.table();
    let pick: [Column<'_>; 4] = [
        (t.added, |c| c.added, Some(Tone::Added)),
        (t.removed, |c| c.removed, Some(Tone::Removed)),
        (t.modified, |c| c.modified, Some(Tone::Content)),
        (t.unchanged, |c| c.unchanged, None),
    ];
    let rows = [(t.nodes, diff.stats.nodes), (t.edges, diff.stats.edges)];
    let label_width = rows.iter().map(|(l, _)| sw(l)).max().unwrap_or(0);
    let width_of = |c: &Column<'_>| {
        rows.iter()
            .map(|(_, counts)| len(format_int((c.1)(counts)).len()))
            .fold(sw(c.0), i64::max)
    };
    let mut columns: Vec<_> = pick.to_vec();
    while columns.len() > 1
        && len(INDENT.len()) + label_width + columns.iter().map(|c| 2 + width_of(c)).sum::<i64>()
            > width
    {
        columns.pop();
    }
    let widths: Vec<i64> = columns.iter().map(width_of).collect();
    let head: String = format!(
        "{INDENT}{}{}",
        spaces(label_width),
        columns
            .iter()
            .zip(&widths)
            .map(|(c, &w)| format!("  {}", pad_start(c.0, w)))
            .collect::<String>()
    );
    let mut out = vec![paint.dim(&head)];
    for (label, counts) in &rows {
        let cells: String = columns
            .iter()
            .zip(&widths)
            .map(|(c, &w)| {
                let n = (c.1)(counts);
                let cell = pad_start(&format_int(n), w);
                match c.2 {
                    Some(tone) if n > 0 => format!("  {}", paint.tone(tone, &cell)),
                    _ => format!("  {cell}"),
                }
            })
            .collect();
        out.push(format!("{INDENT}{}{cells}", pad_end(label, label_width)));
    }
    out
}

fn type_lines(diff: &DiffResult, ctx: &TextContext, width: i64) -> Vec<String> {
    let m = messages(ctx.locale);
    let paint = &ctx.paint;
    let changed: Vec<_> = diff
        .stats
        .by_type
        .iter()
        .filter(|t| t.counts.added + t.counts.removed + t.counts.modified > 0)
        .collect();
    if changed.is_empty() {
        return Vec::new();
    }
    let shown = &changed[..changed.len().min(MAX_TYPE_ROWS)];
    let totals: Vec<usize> = shown
        .iter()
        .map(|t| t.counts.added + t.counts.removed + t.counts.modified)
        .collect();
    let count_room = totals
        .iter()
        .map(|&n| len(format_int(n).len()))
        .max()
        .unwrap_or(0);
    // Names give way first on narrow lines.
    let name_room = 4.max(MAX_TYPE_NAME.min(width - len(INDENT.len()) - 2 - count_room - 1 - 4));
    let names: Vec<String> = shown
        .iter()
        .map(|t| {
            let name = sanitize(&t.r#type);
            truncate(if name.is_empty() { m.untyped() } else { &name }, name_room)
        })
        .collect();
    let name_width = names.iter().map(|n| sw(n)).max().unwrap_or(0);
    let count_width = count_room;
    let max_total = totals.iter().copied().max().unwrap_or(0);
    let bar_room = 1.max(30.min(width - len(INDENT.len()) - name_width - count_width - 3));
    let mut lines = vec![format!("{INDENT}{}", paint.bold(m.by_type()))];
    for ((t, name), &total) in shown.iter().zip(&names).zip(&totals) {
        let size = if len(max_total) <= bar_room {
            total
        } else {
            let scaled = kgdiff_core::js::math::round(
                (count_to_f64(total) / count_to_f64(max_total))
                    * count_to_f64(usize::try_from(bar_room).unwrap_or(0)),
            );
            kgdiff_core::util::f64_to_count(scaled).max(1)
        };
        let cells = apportion(&[t.counts.added, t.counts.removed, t.counts.modified], size);
        let bar = format!(
            "{}{}{}",
            paint.tone(Tone::Added, &"+".repeat(cells[0])),
            paint.tone(Tone::Removed, &"−".repeat(cells[1])),
            paint.tone(Tone::Content, &"~".repeat(cells[2]))
        );
        lines.push(format!(
            "{INDENT}{}  {} {bar}",
            pad_end(name, name_width),
            pad_start(&format_int(total), count_width)
        ));
    }
    if changed.len() > shown.len() {
        lines.push(format!(
            "{INDENT}{}",
            paint.dim(&truncate(
                &m.more_types(changed.len() - shown.len()),
                width - len(INDENT.len())
            ))
        ));
    }
    lines
}

/// `--name-status`: one line per hunk in review order. Tab-separated
/// unless `aligned`, which pads the columns for a terminal.
///
/// # Errors
///
/// Returns an `invalid-input` error when `diff` is inconsistent, for example when a hunk does not belong to it.
pub fn render_name_status(
    diff: &DiffResult,
    ctx: &TextContext,
    aligned: bool,
) -> Result<String, KgdiffError> {
    if diff.hunks.is_empty() {
        return Ok(String::new());
    }
    let paint = &ctx.paint;
    let mut rows = Vec::new();
    for hunk in &diff.hunks {
        let (title, _) = kgdiff_core::format_hunk(hunk, diff, ctx.locale)?;
        rows.push((
            hunk,
            name_status(hunk, diff),
            sanitize(&hunk.anchor),
            sanitize(&title),
        ));
    }
    if !aligned {
        let lines: Vec<String> = rows
            .iter()
            .map(|(hunk, letter, id, title)| {
                format!(
                    "{}\t{id}\t{title}",
                    paint.tone(hunk_family(hunk).tone(), letter)
                )
            })
            .collect();
        return Ok(format!("{}\n", lines.join("\n")));
    }
    let width = len(ctx.width);
    let id_width = rows
        .iter()
        .map(|(_, _, id, _)| sw(id))
        .max()
        .unwrap_or(0)
        .min(8.max(width.div_euclid(3)));
    let title_room = 1.max(width - 1 - 2 - id_width - 2);
    let lines: Vec<String> = rows
        .iter()
        .map(|(hunk, letter, id, title)| {
            let id = pad_end(&truncate(id, id_width), id_width);
            format!(
                "{}  {}  {}",
                paint.bold(&paint.tone(hunk_family(hunk).tone(), letter)),
                paint.dim(&id),
                truncate(title, title_room)
            )
        })
        .collect();
    Ok(format!("{}\n", lines.join("\n")))
}
