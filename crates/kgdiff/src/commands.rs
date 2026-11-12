//! The two commands: `kgdiff <before> <after>` reads, parses and diffs, then
//! writes every requested output; `kgdiff apply <graph> <delta>` applies a
//! delta and writes the patched graph as kgdiff JSON.

use kgdiff_core::js::{self, Object, Value, json};
use kgdiff_core::{
    ApplyOptions, Delta, DiffResult, EdgeIdentity, ErrorCode, KGraph, NormalizeOptions,
    apply_delta, diff_to_json, graph_to_json, hash_graph, normalize, resolve_options,
};
use kgdiff_formats::{JsonTextError, ParseResult, ParseWarning, parse_deep_json};
use kgdiff_report::html::{GZIP_THRESHOLD, render_report_html, report_payload};
use kgdiff_report::width::sanitize;
use kgdiff_report::{
    MarkdownOptions, ReportInfo, ReportSide, TextContext, ViewerBundles, describe_diff, format_int,
    needs_compute, render_markdown, render_name_status, render_stat, render_summary,
};

use crate::VERSION;
use crate::args::{ApplyCommandOptions, DiffCommandOptions, STDIO};
use crate::errors::{CliError, CliErrorCode, CliResult, Failure, format_warning};
use crate::inputs::{
    GraphParseOptions, RawInput, ReadOptions, parse_input, read_pair, resolve_path,
};
use crate::io::{CliIo, ViewerBundle};
use crate::output::{OutputContext, PathRole, check_no_overwrite, write_output_file};
use crate::paths;
use crate::v8_json;

/// The widest layout, however wide the terminal.
const MAX_WIDTH: f64 = 120.0;
/// The narrowest layout: below it, lines are laid out for 40 columns (and wrap in the terminal).
pub const MIN_WIDTH: f64 = 40.0;
/// The width assumed when stdout is not a terminal and `COLUMNS` is unset.
const PIPE_WIDTH: f64 = 120.0;

/// The columns of text output: the terminal's width on a terminal (else
/// `COLUMNS`, else 80), `COLUMNS` or 120 otherwise; clamped to 40–120.
pub fn output_width(io: &dyn CliIo) -> usize {
    let from_env = io
        .var("COLUMNS")
        .map_or(f64::NAN, |c| js::number_from_str(&c));
    let env = (from_env.is_finite() && from_env > 0.0).then_some(from_env);
    let terminal = io.columns().filter(|&c| c > 0.0);
    let columns = if io.is_tty() {
        terminal.or(env).unwrap_or(80.0)
    } else {
        env.unwrap_or(PIPE_WIDTH)
    };
    kgdiff_core::util::f64_to_count(js::math::max(
        MIN_WIDTH,
        js::math::min(MAX_WIDTH, columns.floor()),
    ))
}

/// A non-blank string member of graph meta, trimmed.
fn meta_text(meta: Option<&Object>, key: &str) -> Option<String> {
    let value = meta?.get(key)?.as_str()?;
    let trimmed = js::trim(value);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// One side's display name: `name version` from the graph's meta, else the
/// input as given.
pub fn graph_label(meta: Option<&Object>, input: &RawInput) -> String {
    match (meta_text(meta, "name"), meta_text(meta, "version")) {
        (Some(name), Some(version)) => format!("{name} {version}"),
        (Some(name), None) => name,
        _ => input.display.clone(),
    }
}

/// The default title: `name v1 → v2` when both sides share a name, the two
/// labels when they differ, else the inputs as given (`a/g.json → b/g.json`).
pub fn default_title(
    before: (Option<&Object>, &RawInput),
    after: (Option<&Object>, &RawInput),
) -> String {
    let lb = graph_label(before.0, before.1);
    let la = graph_label(after.0, after.1);
    fn raw<'a>(meta: Option<&'a Object>, key: &str) -> Option<&'a str> {
        meta.and_then(|m| m.get(key)).and_then(Value::as_str)
    }
    let (nb, na) = (raw(before.0, "name"), raw(after.0, "name"));
    let (vb, va) = (raw(before.0, "version"), raw(after.0, "version"));
    if let (Some(nb), Some(vb), Some(va)) = (nb, vb, va)
        && !js::trim(nb).is_empty()
        && Some(nb) == na
        && !js::trim(vb).is_empty()
        && !js::trim(va).is_empty()
        && vb != va
    {
        return format!("{} {} → {}", js::trim(nb), js::trim(vb), js::trim(va));
    }
    if lb == la {
        format!("{} → {}", before.1.display, after.1.display)
    } else {
        format!("{lb} → {la}")
    }
}

/// Warnings and issues grouped by code, in order of first appearance, each with its count.
fn grouped<T, K: PartialEq>(items: &[T], key: impl Fn(&T) -> K) -> Vec<(&T, usize)> {
    let mut groups: Vec<(K, &T, usize)> = Vec::new();
    for item in items {
        let k = key(item);
        match groups.iter_mut().find(|(g, _, _)| *g == k) {
            Some(group) => group.2 += 1,
            None => groups.push((k, item, 1)),
        }
    }
    groups.into_iter().map(|(_, first, n)| (first, n)).collect()
}

fn more(n: usize) -> String {
    if n > 1 {
        format!(" (and {} more like this)", n - 1)
    } else {
        String::new()
    }
}

fn report_parse_warnings(
    ctx: &OutputContext,
    io: &mut dyn CliIo,
    input: &RawInput,
    warnings: &[ParseWarning],
) {
    for (first, n) in grouped(warnings, |w| w.code) {
        let place = match first.line {
            Some(line) => format!("{}:{line}", input.display),
            None => input.display.clone(),
        };
        let text = format_warning(
            &format!("{place}: {}{}", sanitize(&first.message), more(n)),
            &ctx.err_paint,
        );
        ctx.notice(io, &text);
    }
}

fn report_issues(ctx: &OutputContext, io: &mut dyn CliIo, input: &RawInput, graph: &KGraph) {
    for (first, n) in grouped(graph.issues(), |i| i.code) {
        let text = format_warning(
            &format!("{}: {}{}", input.display, sanitize(&first.message), more(n)),
            &ctx.err_paint,
        );
        ctx.notice(io, &text);
    }
}

/// `JSON.stringify(value, null, pretty ? 2 : undefined)` and a newline.
fn json_text(value: &Value, pretty: bool) -> String {
    let mut text = if pretty {
        json::to_string_pretty(value)
    } else {
        json::to_string(value)
    };
    text.push('\n');
    text
}

fn run_diff_engine(before: Value, after: Value, options: &Value) -> CliResult<DiffResult> {
    let result =
        resolve_options(Some(options)).and_then(|o| kgdiff_core::diff(&before, &after, &o));
    result.map_err(|error| {
        if error.code == ErrorCode::InvalidInput {
            let message = error.message.clone();
            CliError::new(
                CliErrorCode::Input,
                message,
                Some("Check the diff options. Run `kgdiff --help` for usage.".to_owned()),
            )
            .caused_by(error.into())
            .into()
        } else {
            Failure::from(error)
        }
    })
}

/// The format flag of one side, for hints.
fn format_flag(o: &DiffCommandOptions, side: &'static str) -> &'static str {
    if o.before_format == o.after_format {
        "--format"
    } else {
        side
    }
}

/// The viewer's compute add-on for a report laid out around its changes (`loadCompute`), unless
/// `--no-compute`. A missing add-on costs only the expansion of collapsed groups: a warning, not
/// an error.
fn load_compute(o: &DiffCommandOptions, io: &mut dyn CliIo, ctx: &OutputContext) -> Option<String> {
    if !o.compute {
        return None;
    }
    match io.viewer_bundle(ViewerBundle::Compute) {
        Ok(source) => Some(source.into_owned()),
        Err(failure) => {
            let (message, _) = crate::errors::describe(&failure, None);
            let text = format_warning(
                &format!(
                    "{message} The report is written without it: collapsed groups cannot be expanded. Pass --no-compute to skip it."
                ),
                &ctx.err_paint,
            );
            ctx.notice(io, &text);
            None
        }
    }
}

/// Runs the diff command; the exit code.
pub fn run_diff(o: &DiffCommandOptions, io: &mut dyn CliIo) -> CliResult<u8> {
    let ctx = OutputContext::new(io, &o.common);
    check_no_overwrite(
        io,
        &[
            PathRole {
                role: "<before>",
                path: Some(&o.before),
            },
            PathRole {
                role: "<after>",
                path: Some(&o.after),
            },
        ],
        &[
            PathRole {
                role: "--json",
                path: o.json.as_deref(),
            },
            PathRole {
                role: "--delta",
                path: o.delta.as_deref(),
            },
            PathRole {
                role: "--markdown",
                path: o.markdown.as_deref(),
            },
            PathRole {
                role: "--html",
                path: o.html.as_deref(),
            },
        ],
    )?;
    let wants_html = o.html.is_some() || o.open;
    // Fail fast, before any parsing, when the report cannot be built.
    let bundle = if wants_html {
        Some(io.viewer_bundle(ViewerBundle::Main)?)
    } else {
        None
    };

    let read = ReadOptions {
        allow_empty: o.allow_empty,
        empty_hint: None,
    };
    let (before_input, after_input) = read_pair(
        io,
        (&o.before, "<before>", read),
        (&o.after, "<after>", read),
    )?;
    let languages = o.languages.as_deref();
    let before = parse_input(
        &before_input,
        &GraphParseOptions {
            format: o.before_format,
            languages,
            format_flag: format_flag(o, "--before-format"),
        },
    )?;
    let after = parse_input(
        &after_input,
        &GraphParseOptions {
            format: o.after_format,
            languages,
            format_flag: format_flag(o, "--after-format"),
        },
    )?;
    report_parse_warnings(&ctx, io, &before_input, &before.warnings);
    report_parse_warnings(&ctx, io, &after_input, &after.warnings);

    let meta = |r: &ParseResult| r.graph.get("meta").and_then(Value::as_object).cloned();
    let (before_meta, after_meta) = (meta(&before), meta(&after));
    let (before_format, after_format) = (before.format, after.format);
    let result = run_diff_engine(
        Value::Object(before.graph),
        Value::Object(after.graph),
        &o.diff,
    )?;
    report_issues(&ctx, io, &before_input, &result.before);
    report_issues(&ctx, io, &after_input, &result.after);

    let title = o.title.clone().unwrap_or_else(|| {
        default_title(
            (before_meta.as_ref(), &before_input),
            (after_meta.as_ref(), &after_input),
        )
    });
    let generator = format!("kgdiff {VERSION}");

    // HTML: written to -o, or to a temporary file when only --open was given.
    let mut html_path = o.html.clone();
    if html_path.is_none() && o.open {
        // A fresh private directory: no predictable path another user could create first.
        html_path = Some(paths::join(&io.make_temp_dir()?, "kgdiff-report.html"));
    }
    let mut files: Vec<(String, String, String)> = Vec::new();
    let mut stdout_text: Option<String> = None;
    if let Some(path) = o.json.as_deref().filter(|p| *p != STDIO) {
        files.push((
            path.to_owned(),
            json_text(&diff_to_json(&result), o.pretty),
            "diff".to_owned(),
        ));
    }
    if let Some(path) = o.delta.as_deref().filter(|p| *p != STDIO) {
        files.push((
            path.to_owned(),
            json_text(&result.delta.to_value(), o.pretty),
            "delta".to_owned(),
        ));
    }
    if let Some(path) = &o.markdown {
        let mut markdown = MarkdownOptions::new(ctx.locale, &title, &generator);
        markdown.watch = o.watch_attrs.as_deref();
        let md = render_markdown(&result, &markdown)?;
        if path == STDIO {
            stdout_text = Some(md);
        } else {
            files.push((path.clone(), md, "Markdown summary".to_owned()));
        }
    }
    if let (Some(bundle), Some(path)) = (&bundle, &html_path) {
        let generated_at = if o.reproducible {
            None
        } else {
            Some(io.now()?)
        };
        let side = |meta: Option<&Object>, input: &RawInput, format: kgdiff_formats::FormatId| {
            ReportSide::new(graph_label(meta, input), Some(format.id().to_owned()))
        };
        let mut info = ReportInfo::new(
            title.clone(),
            generator.clone(),
            side(before_meta.as_ref(), &before_input, before_format),
            side(after_meta.as_ref(), &after_input, after_format),
        );
        info.generated_at = generated_at;
        info.mode = o.mode.clone();
        info.scope = o.scope.clone();
        info.theme = o.theme.clone();
        info.locale = ctx.locale;
        info.panels = o.panels.clone();
        let payload = report_payload(&result, &info);
        let compute = if needs_compute(&payload) {
            load_compute(o, io, &ctx)
        } else {
            None
        };
        let html = render_report_html(
            &payload,
            ViewerBundles::new(bundle, compute.as_deref()),
            &describe_diff(&result, ctx.locale),
            GZIP_THRESHOLD,
        );
        files.push((path.clone(), html, "report".to_owned()));
    }

    for (path, content, label) in &files {
        write_output_file(&ctx, io, path, content, label)?;
    }

    if o.open
        && let Some(path) = &html_path
    {
        let absolute = resolve_path(io, path);
        if let Err(error) = io.open_file(&absolute) {
            let text = format_warning(
                &format!(
                    "Could not open the report ({error}). Open {} manually.",
                    sanitize(path)
                ),
                &ctx.err_paint,
            );
            ctx.notice(io, &text);
        }
    }

    if stdout_text.is_none() && !o.common.quiet {
        let mut text = TextContext::new(ctx.paint.clone(), ctx.locale);
        text.width = output_width(io);
        text.limit = o.limit;
        text.watch = o.watch_attrs.clone();
        stdout_text = Some(if o.json.as_deref() == Some(STDIO) {
            json_text(&diff_to_json(&result), o.pretty)
        } else if o.delta.as_deref() == Some(STDIO) {
            json_text(&result.delta.to_value(), o.pretty)
        } else if o.stat || o.name_status {
            let mut parts = Vec::new();
            if o.stat {
                parts.push(render_stat(&result, &title, &text));
            }
            if o.name_status {
                parts.push(render_name_status(&result, &text, io.is_tty())?);
            }
            parts
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            render_summary(&result, &title, &text)?
        });
    }
    if let Some(text) = stdout_text {
        ctx.stdout(io, &text);
    }
    Ok(u8::from(o.exit_code && !result.stats.identical))
}

// ─── apply ───────────────────────────────────────────────────────────────────

const DELTA_HINT: &str = "Create a delta with `kgdiff <before> <after> --delta <file>`.";

/// Reads a delta from JSON text: a `kgdiff.delta` document, or a `kgdiff.diff`
/// document (`--json` output), whose delta is used. Its shape and version are checked when it
/// is applied.
pub fn read_delta(input: &RawInput) -> CliResult<Value> {
    let place = if input.display == "stdin" {
        "stdin".to_owned()
    } else {
        format!("\"{}\"", input.display)
    };
    let invalid = |reason: String| -> Failure {
        CliError::new(
            CliErrorCode::Input,
            format!("{place} is not valid JSON: {reason}."),
            Some(DELTA_HINT.to_owned()),
        )
        .into()
    };
    if let Some(message) = v8_json::parse_error(&input.text) {
        return Err(invalid(message));
    }
    let value = match parse_deep_json(&input.text) {
        Ok(value) => value,
        Err(JsonTextError::LoneSurrogate { offset, escape, .. }) => {
            // Lines end at `\n` only here, and columns count UTF-16 units from 1.
            let before: Vec<u16> = input.text.encode_utf16().take(offset).collect();
            let line = 1 + before.iter().filter(|&&u| u == 0x0a).count();
            let column = offset - before.iter().rposition(|&u| u == 0x0a).map_or(0, |i| i + 1) + 1;
            return Err(invalid(format!(
                "on line {line}, column {column}, the escape {escape} is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept"
            )));
        }
        Err(JsonTextError::Syntax { message, .. }) => return Err(invalid(message)),
    };
    let record = |v: &Value| v.as_object().is_some();
    let format = value.get("format").and_then(Value::as_str);
    if record(&value)
        && format == Some("kgdiff.diff")
        && let Some(delta) = value.get("delta").filter(|d| record(d))
    {
        return Ok(delta.clone());
    }
    if !record(&value) || format != Some("kgdiff.delta") {
        return Err(CliError::new(
            CliErrorCode::Input,
            format!("{place} is not a kgdiff delta (expected \"format\": \"kgdiff.delta\")."),
            Some("Create one with `kgdiff <before> <after> --delta <file>`. Is the order <graph> <delta>?".to_owned()),
        )
        .into());
    }
    Ok(value)
}

/// The patched graph as kgdiff JSON: `name` and `version` of the delta's
/// target; `source` names the output file, or is left out on stdout, so the result never
/// claims to be the input file.
pub fn graph_output_json(graph: &KGraph, source: Option<&str>) -> Value {
    let Value::Object(full) = graph_to_json(graph) else {
        return Value::Null;
    };
    let mut meta = full
        .get("meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    meta.remove("source");
    if let Some(source) = source {
        meta.insert("source", source);
    }
    let mut out = Object::new();
    for key in ["format", "version"] {
        if let Some(v) = full.get(key) {
            out.insert(key, v.clone());
        }
    }
    if !meta.is_empty() {
        out.insert("meta", meta);
    }
    for key in ["nodes", "edges"] {
        if let Some(v) = full.get(key) {
            out.insert(key, v.clone());
        }
    }
    Value::Object(out)
}

const PARSE_OPTIONS_HINT: &str = "If it is the same graph, parse it as when the delta was made: --format and --lang must match the options given to `kgdiff … --delta` (they change what the graph contains).";

fn operations(n: usize) -> &'static str {
    if n == 1 { "operation" } else { "operations" }
}

/// Runs the apply command; the exit code.
pub fn run_apply(o: &ApplyCommandOptions, io: &mut dyn CliIo) -> CliResult<u8> {
    let ctx = OutputContext::new(io, &o.common);
    check_no_overwrite(
        io,
        &[
            PathRole {
                role: "<graph>",
                path: Some(&o.graph),
            },
            PathRole {
                role: "<delta>",
                path: Some(&o.delta),
            },
        ],
        &[PathRole {
            role: "-o",
            path: Some(&o.output),
        }],
    )?;
    let (graph_input, delta_input) = read_pair(
        io,
        (
            &o.graph,
            "<graph>",
            ReadOptions {
                allow_empty: o.allow_empty,
                empty_hint: None,
            },
        ),
        (
            &o.delta,
            "<delta>",
            ReadOptions {
                allow_empty: false,
                empty_hint: Some(DELTA_HINT),
            },
        ),
    )?;
    let delta_value = read_delta(&delta_input)?;
    let parsed = parse_input(
        &graph_input,
        &GraphParseOptions {
            format: o.format,
            languages: o.languages.as_deref(),
            format_flag: "--format",
        },
    )?;
    let edge_identity = delta_value
        .get("edgeIdentity")
        .and_then(Value::as_str)
        .and_then(EdgeIdentity::from_name)
        .unwrap_or_default();
    let mut normalize_options = NormalizeOptions::default();
    normalize_options.edge_identity = edge_identity;
    let graph = normalize(&Value::Object(parsed.graph), normalize_options)?;
    let delta = Delta::from_value(&delta_value)?;
    let mut apply_options = ApplyOptions::default();
    apply_options.strict = o.strict;

    let (result, skipped) = if o.strict {
        match apply_delta(&graph, &delta, apply_options) {
            Ok(applied) => applied,
            Err(error) if error.code == ErrorCode::DeltaBaseMismatch => {
                let detail = |key: &str| {
                    error
                        .details
                        .as_ref()
                        .and_then(|d| d.get(key))
                        .map_or_else(|| "undefined".to_owned(), Value::to_js_string)
                };
                let place = if o.graph == STDIO {
                    "<graph> (stdin)".to_owned()
                } else {
                    format!("<graph> \"{}\"", o.graph)
                };
                let message = format!(
                    "{place} is not the base of this delta (graph {}, delta base {}).",
                    detail("actual"),
                    detail("expected")
                );
                let hint = format!(
                    "{PARSE_OPTIONS_HINT} Otherwise --no-strict applies what fits and reports the rest."
                );
                return Err(CliError::new(CliErrorCode::Input, message, Some(hint))
                    .caused_by(error.into())
                    .into());
            }
            Err(error) if error.code == ErrorCode::DeltaConflict => {
                let hint = format!(
                    "The graph differs from the delta's base. --no-strict applies the operations that fit and reports the others. {PARSE_OPTIONS_HINT}"
                );
                let message = error.message.clone();
                return Err(CliError::new(CliErrorCode::Input, message, Some(hint))
                    .caused_by(error.into())
                    .into());
            }
            Err(error) => return Err(error.into()),
        }
    } else {
        let (result, skipped) = apply_delta(&graph, &delta, apply_options)?;
        if !skipped.is_empty() {
            let total = delta.ops.len();
            let tail = if o.verbose {
                ":"
            } else {
                " (--verbose lists them)."
            };
            let text = format_warning(
                &format!(
                    "Skipped {} of {} {} that do not fit this graph{tail}",
                    format_int(skipped.len()),
                    format_int(total),
                    operations(total)
                ),
                &ctx.err_paint,
            );
            ctx.notice(io, &text);
            if o.verbose {
                for s in &skipped {
                    ctx.notice(
                        io,
                        &format!(
                            "  #{} {}: {}\n",
                            s.index,
                            sanitize(s.op.name()),
                            sanitize(&s.reason)
                        ),
                    );
                }
            }
        }
        (result, skipped)
    };

    let hash = hash_graph(&result).to_owned();
    let target = delta
        .target
        .as_ref()
        .and_then(|t| t.get("hash"))
        .and_then(Value::as_str);
    if let Some(target) = target
        && hash != target
        && skipped.is_empty()
    {
        let text = format_warning(
            &format!("The result ({hash}) differs from the delta's target ({target})."),
            &ctx.err_paint,
        );
        ctx.notice(io, &text);
    }
    let source = (o.output != STDIO).then(|| paths::basename(&o.output));
    let text = json_text(&graph_output_json(&result, source), o.pretty);
    if o.output == STDIO {
        ctx.stdout(io, &text);
    } else {
        let ops = delta.ops.len() - skipped.len();
        let label = format!(
            "patched graph ({} {} applied, {hash})",
            format_int(ops),
            operations(ops)
        );
        write_output_file(&ctx, io, &o.output, &text, &label)?;
    }
    Ok(0)
}
