//! `kgdiff --help` and `kgdiff apply --help`: grouped options, defaults, examples
//! and exit codes, aligned and wrapped to the terminal width. The text is part of the
//! contract the conformance corpus pins, word for word.

use kgdiff_report::width::{pad_end, string_width, wrap};
use kgdiff_report::{Painter, Tone};

use crate::args::HelpTopic;

struct Entry {
    flags: &'static str,
    text: &'static str,
    default: Option<&'static str>,
}

struct Section {
    title: &'static str,
    note: Option<&'static str>,
    entries: &'static [Entry],
    /// Preformatted lines (usage, examples): a command and its comment.
    lines: &'static [(&'static str, Option<&'static str>)],
}

const fn e(flags: &'static str, text: &'static str) -> Entry {
    Entry {
        flags,
        text,
        default: None,
    }
}

const fn d(flags: &'static str, text: &'static str, default: &'static str) -> Entry {
    Entry {
        flags,
        text,
        default: Some(default),
    }
}

const MAIN: &[Section] = &[
    Section {
        title: "Usage",
        lines: &[
            ("kgdiff <before> <after> [options]", None),
            (
                "kgdiff apply <graph> <delta> [-o <file>] [--no-strict]",
                None,
            ),
        ],
        note: Some(
            "Graphs: JSON (.json), JSON-LD (.jsonld), Turtle (.ttl), N-Triples (.nt), N-Quads (.nq), \
             TriG (.trig), RDF/XML (.rdf, .owl), OBO (.obo); gzip-compressed files work too. \
             Use - to read one side from stdin.",
        ),
        entries: &[],
    },
    Section {
        title: "Output",
        note: Some(
            "Default: a summary on stdout. Outputs combine, e.g. -o report.html --markdown summary.md",
        ),
        entries: &[
            e(
                "--stat",
                "Diffstat only: counters, bar, node and edge counts, changes by type",
            ),
            e(
                "--name-status",
                "One line per hunk: A added, D removed, M modified, R renamed, V moved, G merged, S split, E relations",
            ),
            e("--json [file]", "Full machine-readable diff (DiffJSON)"),
            e("--delta [file]", "Invertible delta only, for kgdiff apply"),
            e(
                "--markdown [file]",
                "GitHub-flavoured Markdown for PR comments and job summaries",
            ),
            e(
                "-o, --html <file>",
                "Self-contained interactive HTML report (works offline)",
            ),
            e(
                "--open",
                "Open the HTML report in the browser (a temporary file without -o)",
            ),
            e("--pretty", "Indent JSON output"),
        ],
        lines: &[],
    },
    Section {
        title: "Diff",
        note: None,
        entries: &[
            d(
                "-f, --format <fmt>",
                "Input format: auto, json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo",
                "auto",
            ),
            e("--before-format <fmt>", "Format of <before> only"),
            e("--after-format <fmt>", "Format of <after> only"),
            d(
                "--match <strategy>",
                "Node matching: id, auto, similarity",
                "auto",
            ),
            d(
                "--threshold <n>",
                "Similarity acceptance threshold, 0–1",
                "0.82",
            ),
            d(
                "--edge-identity <mode>",
                "Edge identity: structure, id",
                "structure",
            ),
            e(
                "--hierarchy <predicate>",
                "Hierarchy predicate (repeatable); replaces the defaults when given",
            ),
            e(
                "--ignore-attr <key>",
                "Ignore an attribute when comparing (repeatable)",
            ),
            e("--no-merges", "Do not detect merges"),
            e("--no-splits", "Do not detect splits"),
            e(
                "--lang <tags>",
                "RDF label language preference, comma-separated, e.g. zh,en",
            ),
        ],
        lines: &[],
    },
    Section {
        title: "Report",
        note: None,
        entries: &[
            d(
                "--title <text>",
                "Title of the summary and report",
                "<before> → <after>",
            ),
            d(
                "--theme <theme>",
                "Initial theme: auto, light, dark",
                "auto",
            ),
            d(
                "--locale <locale>",
                "Language of hunk titles and the report: en, zh-CN",
                "from LANG, else en",
            ),
            e(
                "--mode <mode>",
                "Initial viewer mode: overlay, swipe, replay",
            ),
            d(
                "--scope <scope>",
                "Show the whole graph or only the changes (in any mode): all, changes",
                "changes for large graphs, else all",
            ),
            e(
                "--panels <spec>",
                "Initial panel states, e.g. \"detail:collapsed minimap:hidden\" (repeatable)",
            ),
            e(
                "--reproducible",
                "Omit the timestamp: byte-identical reports for identical input",
            ),
            e(
                "--no-compute",
                "Leave out the viewer compute add-on (by default inlined for large graphs laid out around their changes, so collapsed groups can be expanded)",
            ),
        ],
        lines: &[],
    },
    Section {
        title: "Behaviour",
        note: None,
        entries: &[
            e(
                "--exit-code",
                "Exit with 1 when the graphs differ, like git diff --exit-code",
            ),
            e(
                "--allow-empty",
                "Treat an empty input as an empty graph (otherwise an empty file or stdin is an error)",
            ),
            e(
                "-q, --quiet",
                "Print nothing on stdout (files are still written)",
            ),
            d(
                "--color <when>",
                "auto, always, never (auto honours NO_COLOR and FORCE_COLOR)",
                "auto",
            ),
            d(
                "--limit <n>",
                "Hunks listed in the summary; 0 lists all",
                "50",
            ),
            d(
                "--watch-attr <key>",
                "Flag changes to this attribute ⚑ for review first (repeatable); replaces the defaults",
                "definitions",
            ),
            e("-h, --help", "Show this help"),
            e("-v, --version", "Show the version"),
        ],
        lines: &[],
    },
    Section {
        title: "Examples",
        lines: &[
            ("kgdiff v12.json v13.json", Some("colored summary")),
            (
                "kgdiff old.obo new.obo -o report.html --open",
                Some("interactive report"),
            ),
            (
                "kgdiff a.ttl b.ttl --markdown >> \"$GITHUB_STEP_SUMMARY\"",
                Some("CI job summary"),
            ),
            (
                "kgdiff a.json b.json --exit-code -q",
                Some("fail when the graphs differ"),
            ),
            (
                "kgdiff a.json b.json --delta patch.json",
                Some("export a delta …"),
            ),
            (
                "kgdiff apply a.json patch.json -o b.json",
                Some("… and apply it"),
            ),
            (
                "curl -s https://example.org/latest.ttl | kgdiff pinned.ttl -",
                Some("compare with stdin"),
            ),
        ],
        note: None,
        entries: &[],
    },
    Section {
        title: "Environment",
        note: Some(
            "NO_COLOR, FORCE_COLOR (0–3) and COLORTERM control colors · LANG / LC_ALL the locale · \
             COLUMNS the width when piped · KGDIFF_MAX_INPUT the input size limit (default 1G, e.g. 4G) · \
             DEBUG=kgdiff prints stack traces",
        ),
        entries: &[],
        lines: &[],
    },
    Section {
        title: "Exit status",
        note: Some(
            "0 success (and no differences with --exit-code) · 1 differences with --exit-code · 2 usage or input error",
        ),
        entries: &[],
        lines: &[],
    },
];

const APPLY: &[Section] = &[
    Section {
        title: "Usage",
        lines: &[(
            "kgdiff apply <graph> <delta> [-o <file>] [--no-strict]",
            None,
        )],
        note: Some(
            "Applies a kgdiff delta (from --delta, or the delta inside --json output) to a graph and \
             writes the result as kgdiff JSON. Use - to read the graph or the delta from stdin.",
        ),
        entries: &[],
    },
    Section {
        title: "Options",
        note: None,
        entries: &[
            d(
                "-o, --output <file>",
                "Write the patched graph to a file",
                "stdout",
            ),
            e(
                "--no-strict",
                "Apply the operations that fit even if the graph is not the delta's base; reports how many were skipped",
            ),
            e("--verbose", "With --no-strict, list the skipped operations"),
            e("--allow-empty", "Treat an empty <graph> as an empty graph"),
            d("-f, --format <fmt>", "Format of <graph>", "auto"),
            e("--lang <tags>", "RDF label language preference, e.g. zh,en"),
            e("--pretty", "Indent the JSON output"),
            e("-q, --quiet", "Print nothing on stdout"),
            d("--color <when>", "auto, always, never", "auto"),
            e("-h, --help", "Show this help"),
        ],
        lines: &[],
    },
    Section {
        title: "Examples",
        lines: &[
            (
                "kgdiff v1.ttl v2.ttl --delta patch.json",
                Some("make a delta"),
            ),
            (
                "kgdiff apply v1.ttl patch.json -o v2.json",
                Some("apply it"),
            ),
        ],
        note: None,
        entries: &[],
    },
    Section {
        title: "Exit status",
        note: Some("0 applied · 2 the delta does not fit the graph, or another error"),
        entries: &[],
        lines: &[],
    },
];

const INDENT: &str = "  ";
const MAX_FLAGS: usize = 26;

/// Placeholders (`<file>`, `[file]`) dim, the rest in the accent colour.
fn paint_flags(flags: &str, paint: &Painter) -> String {
    let mut out = String::new();
    let mut plain = String::new();
    let mut rest = flags;
    while !rest.is_empty() {
        let close = match rest.as_bytes()[0] {
            b'<' => Some('>'),
            b'[' => Some(']'),
            _ => None,
        };
        // `<[^>]+>` or `\[[^\]]+\]`: at least one character inside.
        let end = close.and_then(|c| rest[1..].find(c).filter(|&i| i > 0).map(|i| i + 2));
        if let Some(end) = end {
            out.push_str(&paint.tone(Tone::Accent, &plain));
            plain.clear();
            out.push_str(&paint.dim(&rest[..end]));
            rest = &rest[end..];
        } else {
            let c = rest.chars().next().unwrap_or(' ');
            plain.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out.push_str(&paint.tone(Tone::Accent, &plain));
    out
}

fn sub(a: usize, b: usize) -> usize {
    a.saturating_sub(b)
}

/// The help text. `width` is the terminal's: descriptions wrap to it, and below
/// 60 columns they go under their flags.
pub fn render_help(topic: HelpTopic, version: &str, paint: &Painter, width: usize) -> String {
    let sections = if topic == HelpTopic::Apply {
        APPLY
    } else {
        MAIN
    };
    let w = width.clamp(40, 100);
    let widest = sections
        .iter()
        .flat_map(|s| s.entries.iter())
        .map(|e| string_width(e.flags))
        .max()
        .unwrap_or(0);
    let flag_width = (widest + 2).min(MAX_FLAGS);
    let stacked = w < 60;
    let mut out = vec![format!(
        "{} {version}  {}",
        paint.bold(&paint.tone(Tone::Accent, "kgdiff")),
        paint.dim(if topic == HelpTopic::Apply {
            "apply a delta to a graph"
        } else {
            "git diff for knowledge graphs"
        })
    )];
    for section in sections {
        out.push(String::new());
        out.push(paint.bold(section.title));
        for &(command, comment) in section.lines {
            let gap = sub(58, string_width(command)).max(2);
            if let Some(comment) = comment
                && string_width(command) + gap + string_width(comment) + 4 <= w
            {
                out.push(format!(
                    "{INDENT}{command}{}{}",
                    " ".repeat(gap),
                    paint.dim(&format!("# {comment}"))
                ));
                continue;
            }
            if let Some(comment) = comment {
                out.push(format!("{INDENT}{}", paint.dim(&format!("# {comment}"))));
            }
            // Long commands wrap with a hanging indent (narrow terminals).
            for (i, line) in wrap(command, sub(w, INDENT.len() + 4)).iter().enumerate() {
                out.push(format!("{INDENT}{}{line}", if i > 0 { "    " } else { "" }));
            }
        }
        if section.note.is_some() && !section.lines.is_empty() {
            out.push(String::new());
        }
        if let Some(note) = section.note {
            for line in wrap(note, sub(w, INDENT.len())) {
                out.push(format!("{INDENT}{}", paint.dim(&line)));
            }
        }
        for entry in section.entries {
            let room = if stacked {
                sub(w, INDENT.len() * 3)
            } else {
                sub(w, INDENT.len() + flag_width)
            };
            let default_text = entry
                .default
                .map(|d| format!("[default: {d}]"))
                .unwrap_or_default();
            let text = if default_text.is_empty() {
                entry.text.to_owned()
            } else {
                format!("{} {default_text}", entry.text)
            };
            let wrapped: Vec<String> = wrap(&text, room)
                .into_iter()
                .map(|line| match line.strip_suffix(default_text.as_str()) {
                    Some(head) if !default_text.is_empty() => {
                        format!("{head}{}", paint.dim(&default_text))
                    }
                    _ => line,
                })
                .collect();
            if stacked || string_width(entry.flags) >= flag_width {
                out.push(format!("{INDENT}{}", paint_flags(entry.flags, paint)));
                for line in wrapped {
                    let lead = if stacked {
                        INDENT.repeat(3)
                    } else {
                        format!("{INDENT}{}", " ".repeat(flag_width))
                    };
                    out.push(format!("{lead}{line}"));
                }
                continue;
            }
            for (i, line) in wrapped.iter().enumerate() {
                let lead = if i == 0 {
                    format!(
                        "{}{}",
                        paint_flags(entry.flags, paint),
                        " ".repeat(flag_width - string_width(entry.flags))
                    )
                } else {
                    pad_end("", flag_width)
                };
                out.push(format!("{INDENT}{lead}{line}"));
            }
        }
    }
    format!("{}\n", out.join("\n"))
}
