//! The single-file HTML report: the standalone viewer bundle and the
//! report payload inlined in one accessible document that works offline.
//!
//! The payload (`kgdiff.report` version 1, `packages/core/schema/report.v1.json`) carries the
//! diff and its layout from kgdiff-layout, a layout document of version 2 (RFC 0002, phase 4), so
//! the report opens without laying anything out. [`report_payload`] and [`build_report_html`]
//! compute that layout with the default options; [`report_payload_with`] and
//! [`build_report_html_with`] take a [`ReportLayout`] instead: the default one, the caller's, or
//! none (RFC 0003, part 2). The viewer's compute add-on is inlined only where the browser may
//! still have to lay out: when the layout covers just the changes (large graphs), whose collapsed
//! groups the reader can expand, or when there is no layout ([`needs_compute`]). Deterministic
//! apart from `generatedAt`; the gzip stream of a large payload is this encoder's
//! (RFC 0002 does not require it to match any other encoder's).

use std::io::Write as _;

use base64::Engine as _;
use flate2::{Compression, GzBuilder};
use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{DiffResult, KgdiffError, Locale, Result};
use kgdiff_layout::{LayoutOptions, LayoutResult, LayoutScope, layout_diff, layout_to_json};

use crate::locale::messages;
use crate::model::overview;
use crate::summary::totals_text;
use crate::width::sanitize;

/// The MIME type of the payload script.
pub const PAYLOAD_TYPE: &str = "application/kgdiff+json";

/// Payloads larger than this (UTF-8 bytes of the JSON) are embedded gzip + base64.
pub const GZIP_THRESHOLD: usize = 512 * 1024;

const VIEWER_ID: &str = "kgdiff";

/// `escapeHtml`: text for element content and double-quoted attribute values.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// `scriptSafeJson`: `<` as `\u003c`, U+2028 / U+2029 escaped; still valid JSON.
pub fn script_safe_json(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        match c {
            '<' => out.push_str("\\u003c"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out
}

/// `scriptSafeJs`: `</script` (any case) as `<\/script`, `<!--` as `\x3C!--`.
pub fn script_safe_js(code: &str) -> String {
    let b = code.as_bytes();
    let mut out = String::with_capacity(code.len());
    let mut last = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' {
            if b.len() >= i + 8
                && b[i + 1] == b'/'
                && b[i + 2..i + 8].eq_ignore_ascii_case(b"script")
            {
                out.push_str(&code[last..i]);
                out.push_str("<\\/");
                out.push_str(&code[i + 2..i + 8]);
                i += 8;
                last = i;
                continue;
            }
            if code[i..].starts_with("<!--") {
                out.push_str(&code[last..i]);
                out.push_str("\\x3C!--");
                i += 4;
                last = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&code[last..]);
    out
}

/// One side of the report (`meta.before`, `meta.after`).
#[derive(Clone, Debug, PartialEq)]
pub struct ReportSide {
    pub name: String,
    pub format: Option<String>,
}

/// What a report says about itself and how the viewer starts (`ReportInfo`).
#[derive(Clone, Debug, PartialEq)]
pub struct ReportInfo {
    pub title: String,
    /// e.g. `kgdiff 0.1.0`.
    pub generator: String,
    /// ISO timestamp; `None` for reproducible reports.
    pub generated_at: Option<String>,
    pub before: ReportSide,
    pub after: ReportSide,
    pub mode: Option<String>,
    pub scope: Option<String>,
    pub theme: Option<String>,
    pub locale: Locale,
    /// `view.panels`: region and state, in the order given.
    pub panels: Option<Vec<(String, String)>>,
}

fn side_value(side: &ReportSide) -> Value {
    let mut out = Object::new();
    out.insert("name", side.name.as_str());
    if let Some(format) = &side.format {
        out.insert("format", format.as_str());
    }
    Value::Object(out)
}

/// What the layout of a report is ([`report_payload_with`], [`build_report_html_with`]).
#[derive(Clone, Copy, Debug)]
pub enum ReportLayout<'a> {
    /// `layout_diff` with the default options: what [`report_payload`] and
    /// [`build_report_html`] do.
    Default,
    /// The caller's layout of this diff: one it has already (cached, read from a layout
    /// document) or computed with other options. It is checked against the diff.
    Given(&'a LayoutResult),
    /// No layout: the payload has no `layout` member, and the viewer lays the diff out when the
    /// report opens, with its compute add-on (RFC 0002, D-5).
    None,
}

/// The layout document of the default layout, `None` if it fails. The default options cannot be
/// invalid; were the layout to fail anyway, the report would still open, laid out by the viewer.
fn default_layout(diff: &DiffResult) -> Option<Value> {
    layout_diff(diff, &LayoutOptions::default())
        .ok()
        .map(|layout| layout_to_json(&layout))
}

/// Whether `layout` is a layout of `diff`: every position belongs to a union node, and with
/// scope `all` every union node has a position. The scene skips a node without a position, so
/// the layout of another diff would open as a graph with holes and say nothing.
fn check_layout(diff: &DiffResult, layout: &LayoutResult) -> Result<()> {
    let fail = |id: &kgdiff_core::model::UnionId, message: String| {
        let mut details = Object::new();
        details.insert("node", id.clone());
        Err(KgdiffError::invalid_input(message).with_details(details))
    };
    for id in layout.positions.keys() {
        if diff.node(id.as_str()).is_none() {
            return fail(
                id,
                format!(
                    "The report's layout has a position for \"{id}\", which is not a node of the diff."
                ),
            );
        }
    }
    if layout.scope == LayoutScope::All {
        for node in &diff.nodes {
            if !layout.positions.contains_key(node.id.as_str()) {
                return fail(
                    &node.id,
                    format!(
                        "The report's layout has scope \"all\" but no position for node \"{}\" of the diff.",
                        node.id
                    ),
                );
            }
        }
    }
    Ok(())
}

/// The payload of a diff, a layout document (or none) and what the report says about itself.
fn payload(diff: &DiffResult, layout: Option<Value>, info: &ReportInfo) -> Value {
    let mut meta = Object::new();
    meta.insert("title", info.title.as_str());
    meta.insert("generator", info.generator.as_str());
    if let Some(at) = &info.generated_at {
        meta.insert("generatedAt", at.as_str());
    }
    meta.insert("before", side_value(&info.before));
    meta.insert("after", side_value(&info.after));
    let mut view = Object::new();
    if let Some(mode) = &info.mode {
        view.insert("mode", mode.as_str());
    }
    if let Some(scope) = &info.scope {
        view.insert("scope", scope.as_str());
    }
    if let Some(theme) = &info.theme {
        view.insert("theme", theme.as_str());
    }
    view.insert("locale", info.locale.as_str());
    if let Some(panels) = &info.panels {
        let panels: Object = panels
            .iter()
            .map(|(region, state)| (region.as_str(), state.as_str()))
            .collect();
        view.insert("panels", Value::Object(panels));
    }
    let mut payload = Object::new();
    payload.insert("format", "kgdiff.report");
    payload.insert("version", 1);
    payload.insert(
        "diff",
        kgdiff_core::pack_diff_json(&kgdiff_core::diff_to_json(diff)),
    );
    if let Some(layout) = layout {
        payload.insert("layout", layout);
    }
    payload.insert("meta", Value::Object(meta));
    payload.insert("view", Value::Object(view));
    Value::Object(payload)
}

/// The report payload (`buildReportPayload`, `ReportPayload` version 1): format, version, the
/// packed diff, the layout (`layout_diff` with the default options, as a version 2 layout
/// document), meta and view. [`report_payload_with`] with [`ReportLayout::Default`].
pub fn report_payload(diff: &DiffResult, info: &ReportInfo) -> Value {
    payload(diff, default_layout(diff), info)
}

/// The report payload with the layout the caller chooses: [`report_payload`]'s
/// ([`ReportLayout::Default`]), the caller's own, written with `layout_to_json`
/// ([`ReportLayout::Given`]), or none ([`ReportLayout::None`]).
///
/// A layout computed with `layout_diff` keeps a known position exactly; the layout document
/// rounds coordinates to 0.01, so the payload carries the given positions on that grid.
///
/// # Errors
///
/// `invalid-input` when a given layout is not a layout of `diff`: it has a position for an id
/// that is no union node, or its scope is `all` and a union node has no position.
pub fn report_payload_with(
    diff: &DiffResult,
    layout: ReportLayout<'_>,
    info: &ReportInfo,
) -> Result<Value> {
    let layout = match layout {
        ReportLayout::Default => default_layout(diff),
        ReportLayout::Given(layout) => {
            check_layout(diff, layout)?;
            Some(layout_to_json(layout))
        }
        ReportLayout::None => None,
    };
    Ok(payload(diff, layout, info))
}

/// Deterministic gzip (level 9), with the header's OS byte 255 ("unknown").
pub fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .operating_system(255)
        .write(Vec::new(), Compression::best());
    // Writing to a vector cannot fail.
    let _ = encoder.write_all(data);
    encoder.finish().unwrap_or_default()
}

/// The payload as embedded text and its `data-encoding`.
pub fn encode_payload(payload: &Value, threshold: usize) -> (String, Option<&'static str>) {
    let json = json::to_string(payload);
    if json.len() <= threshold {
        return (script_safe_json(&json), None);
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(gzip(json.as_bytes()));
    (encoded, Some("gzip-base64"))
}

fn theme_style(theme: &str) -> String {
    const DARK: (&str, &str) = ("#0B0E14", "#E7EBF3");
    const LIGHT: (&str, &str) = ("#F7F8FA", "#0F172A");
    let rule = |(background, text): (&str, &str)| {
        format!("html,body{{background:{background};color:{text}}}")
    };
    match theme {
        "dark" => format!(":root{{color-scheme:dark}}{}", rule(DARK)),
        "light" => format!(":root{{color-scheme:light}}{}", rule(LIGHT)),
        _ => format!(
            ":root{{color-scheme:dark light}}{}@media (prefers-color-scheme:light){{{}}}",
            rule(DARK),
            rule(LIGHT)
        ),
    }
}

/// The viewer's JavaScript the report inlines.
#[derive(Clone, Copy, Debug)]
pub struct ViewerBundles<'a> {
    /// The standalone viewer bundle (an IIFE).
    pub main: &'a str,
    /// The compute add-on (an IIFE that sets `globalThis.KgdiffCompute`).
    pub compute: Option<&'a str>,
}

/// The viewer bundles compiled into this crate: with feature `embed-viewer`, the files
/// `pnpm build:viewer-assets` copies into `crates/kgdiff-report/assets/`. `None` without the
/// feature, or when the build found no assets (it warns then); [`MISSING_VIEWER_HINT`] names
/// the step.
pub fn embedded_viewer() -> Option<ViewerBundles<'static>> {
    #[cfg(kgdiff_viewer)]
    {
        Some(ViewerBundles {
            main: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/kgdiff-viewer.js"
            )),
            compute: Some(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/kgdiff-viewer-compute.js"
            ))),
        })
    }
    #[cfg(not(kgdiff_viewer))]
    {
        None
    }
}

/// How to get a build with the viewer bundles, for the error a report without them gives.
pub const MISSING_VIEWER_HINT: &str = "Run `pnpm build:viewer-assets` and build with the `embed-viewer` feature (development), or reinstall kgdiff.";

/// `renderReportHtml`: the report document for a payload.
pub fn render_report_html(
    payload: &Value,
    bundles: ViewerBundles<'_>,
    description: &str,
    threshold: usize,
) -> String {
    let get = |path: &[&str]| -> Option<String> {
        let mut v = payload;
        for key in path {
            v = v.get(key)?;
        }
        v.as_str().map(str::to_owned)
    };
    let theme = get(&["view", "theme"]).unwrap_or_else(|| "auto".to_owned());
    let locale = get(&["view", "locale"]).unwrap_or_else(|| "en".to_owned());
    // Titles come from graph metadata: no control or bidi characters in the tab title.
    let title = sanitize(&get(&["meta", "title"]).unwrap_or_else(|| {
        format!(
            "{} → {}",
            get(&["meta", "before", "name"]).unwrap_or_default(),
            get(&["meta", "after", "name"]).unwrap_or_default()
        )
    }));
    let description = sanitize(description);
    let (text, encoding) = encode_payload(payload, threshold);
    let mut attrs = vec![format!("id=\"{VIEWER_ID}\""), "global-shortcuts".to_owned()];
    if let Some(mode) = get(&["view", "mode"]) {
        attrs.push(format!("mode=\"{}\"", escape_html(&mode)));
    }
    if let Some(scope) = get(&["view", "scope"]) {
        attrs.push(format!("scope=\"{}\"", escape_html(&scope)));
    }
    let encoding_attr = encoding.map_or_else(String::new, |e| format!(" data-encoding=\"{e}\""));
    let style = format!(
        "{}html,body{{margin:0;height:100%;overflow:hidden}}\
         kgdiff-viewer{{display:block;position:fixed;inset:0;width:100%;height:100%}}\
         .kgdiff-sr{{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;\
         clip:rect(0 0 0 0);white-space:nowrap;border:0}}\
         noscript p{{font:15px/1.5 system-ui,sans-serif;margin:2rem;max-width:40rem}}",
        theme_style(&theme)
    );
    let generator = get(&["meta", "generator"]).unwrap_or_default();
    let mut lines = vec![
        "<!doctype html>".to_owned(),
        format!("<html lang=\"{}\">", escape_html(&locale)),
        "<head>".to_owned(),
        "<meta charset=\"utf-8\">".to_owned(),
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">".to_owned(),
        format!(
            "<meta name=\"generator\" content=\"{}\">",
            escape_html(&generator)
        ),
        format!(
            "<meta name=\"description\" content=\"{}\">",
            escape_html(&description)
        ),
        format!("<title>{} · kgdiff</title>", escape_html(&title)),
        format!("<style>{style}</style>"),
        "</head>".to_owned(),
        "<body>".to_owned(),
        "<main>".to_owned(),
        format!("<h1 class=\"kgdiff-sr\">{}</h1>", escape_html(&title)),
        format!("<kgdiff-viewer {}></kgdiff-viewer>", attrs.join(" ")),
        format!(
            "<noscript><p>{}. This interactive report needs JavaScript.</p></noscript>",
            escape_html(&description)
        ),
        "</main>".to_owned(),
        format!(
            "<script type=\"{PAYLOAD_TYPE}\" data-for=\"{VIEWER_ID}\"{encoding_attr}>{text}</script>"
        ),
        format!("<script>{}</script>", script_safe_js(bundles.main)),
    ];
    if let Some(compute) = bundles.compute {
        lines.push(format!("<script>{}</script>", script_safe_js(compute)));
    }
    lines.push("</body>".to_owned());
    lines.push("</html>".to_owned());
    lines.push(String::new());
    lines.join("\n")
}

/// `describeDiff`: the short description of a report (meta description and `<noscript>`).
pub fn describe_diff(diff: &DiffResult, locale: Locale) -> String {
    let m = messages(locale);
    let ov = overview(diff);
    let totals = totals_text(diff, m);
    if ov.hunks == 0 {
        format!("{} · {totals}", m.identical())
    } else {
        format!("{} · {totals}", m.changes(ov.changes, ov.hunks))
    }
}

/// Whether a report inlines the compute add-on: when its layout covers only the
/// changes (large graphs), where the viewer may lay out the collapsed groups the reader expands,
/// or when it has no layout at all. A full layout needs nothing computed in the browser.
pub fn needs_compute(payload: &Value) -> bool {
    match payload.get("layout") {
        None => true,
        Some(layout) => layout.get("scope").and_then(Value::as_str) == Some("changes"),
    }
}

/// The report document of a payload of `diff`: the compute add-on of `bundles` is inlined only
/// when [`needs_compute`].
fn report_html(
    diff: &DiffResult,
    payload: &Value,
    info: &ReportInfo,
    bundles: ViewerBundles<'_>,
) -> String {
    let bundles = ViewerBundles {
        compute: bundles.compute.filter(|_| needs_compute(payload)),
        ..bundles
    };
    render_report_html(
        payload,
        bundles,
        &describe_diff(diff, info.locale),
        GZIP_THRESHOLD,
    )
}

/// The whole report document for a diff, with the default layout
/// ([`report_payload`]): the compute add-on of `bundles` is inlined only when [`needs_compute`].
pub fn build_report_html(
    diff: &DiffResult,
    info: &ReportInfo,
    bundles: ViewerBundles<'_>,
) -> String {
    report_html(diff, &report_payload(diff, info), info, bundles)
}

/// The whole report document for a diff with the layout the caller chooses
/// ([`report_payload_with`]). The compute add-on of `bundles` is inlined only when
/// [`needs_compute`]: for a layout of scope `changes`, and for [`ReportLayout::None`].
///
/// # Errors
///
/// `invalid-input` when a given layout is not a layout of `diff` ([`report_payload_with`]).
pub fn build_report_html_with(
    diff: &DiffResult,
    layout: ReportLayout<'_>,
    info: &ReportInfo,
    bundles: ViewerBundles<'_>,
) -> Result<String> {
    let payload = report_payload_with(diff, layout, info)?;
    Ok(report_html(diff, &payload, info, bundles))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_for_html_and_scripts() {
        assert_eq!(
            escape_html("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
        assert_eq!(
            script_safe_json("{\"a\":\"</script>\u{2028}\"}"),
            "{\"a\":\"\\u003c/script>\\u2028\"}"
        );
        assert_eq!(
            script_safe_js("x='</SCRIPT>'+'<!--'"),
            "x='<\\/SCRIPT>'+'\\x3C!--'"
        );
    }

    #[test]
    fn gzips_deterministically() {
        let a = gzip(b"hello hello hello");
        assert_eq!(&a[..10], &[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]);
        assert_eq!(a, gzip(b"hello hello hello"));
    }
}
