//! The text outputs and HTML reports of [kgdiff](https://github.com/iiwish/kgdiff), ported from
//! the rendering half of the TypeScript CLI (RFC 0002, phase 3), which they replaced. Given a
//! [`kgdiff_core::DiffResult`], it writes what `kgdiff` prints — the terminal summary, `--stat`,
//! `--name-status` and the Markdown summary, in English or Simplified Chinese, laid out for a
//! width in terminal columns — and assembles the single-file HTML report. It does no I/O, so an
//! application that embeds the engine renders the same summary as the CLI without depending on
//! it.
//!
//! A report carries the diff and its layout ([`report_payload`], [`build_report_html`]: the
//! layout of the default options). An application that has a layout already hands it over with
//! [`ReportLayout::Given`], or leaves the layout to the viewer with [`ReportLayout::None`]
//! ([`report_payload_with`], [`build_report_html_with`]; RFC 0003, part 2). The payload is a
//! `kgdiff.report` document of version 1, described by `packages/core/schema/report.v1.json`.
//!
//! ```
//! use kgdiff_core::js::json;
//! use kgdiff_core::{DiffOptions, Locale, diff};
//! use kgdiff_report::{Painter, TextContext, render_summary};
//!
//! let before = json::parse(r#"{"nodes":[{"id":"a","label":"Ada"}],"edges":[]}"#)?;
//! let after = json::parse(r#"{"nodes":[{"id":"a","label":"Ada Lovelace"}],"edges":[]}"#)?;
//! let result = diff(&before, &after, &DiffOptions::default())?;
//! let ctx = TextContext {
//!     paint: Painter::plain(),
//!     locale: Locale::En,
//!     width: 80,
//!     limit: 50,
//!     watch: None,
//! };
//! let text = render_summary(&result, "v1 → v2", &ctx)?;
//! assert!(text.starts_with("kgdiff  v1 → v2"));
//! assert!(text.contains("Renamed “Ada” → “Ada Lovelace”"));
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! A report with the caller's layout, here one computed with another seed:
//!
//! ```
//! use kgdiff_core::js::json;
//! use kgdiff_core::{DiffOptions, Locale, diff};
//! use kgdiff_layout::{LayoutOptions, layout_diff, layout_to_json};
//! use kgdiff_report::{ReportInfo, ReportLayout, ReportSide, needs_compute, report_payload_with};
//!
//! let before = json::parse(r#"{"nodes":[{"id":"a","label":"Ada"}],"edges":[]}"#)?;
//! let after = json::parse(r#"{"nodes":[{"id":"a","label":"Ada Lovelace"}],"edges":[]}"#)?;
//! let result = diff(&before, &after, &DiffOptions::default())?;
//! let options = LayoutOptions {
//!     seed: Some(7.0),
//!     ..LayoutOptions::default()
//! };
//! let layout = layout_diff(&result, &options)?;
//! let side = |name: &str| ReportSide {
//!     name: name.to_owned(),
//!     format: None,
//! };
//! let info = ReportInfo {
//!     title: "v1 → v2".to_owned(),
//!     generator: "my-app 1.0".to_owned(),
//!     generated_at: None,
//!     before: side("v1"),
//!     after: side("v2"),
//!     mode: None,
//!     scope: None,
//!     theme: None,
//!     locale: Locale::En,
//!     panels: None,
//! };
//! let payload = report_payload_with(&result, ReportLayout::Given(&layout), &info)?;
//! assert_eq!(payload.get("layout"), Some(&layout_to_json(&layout)));
//! // The layout places every node: the report needs nothing computed in the browser.
//! assert!(!needs_compute(&payload));
//!
//! // The layout of another diff is refused.
//! let unrelated = json::parse(r#"{"nodes":[{"id":"b"}],"edges":[]}"#)?;
//! let other = diff(&after, &unrelated, &DiffOptions::default())?;
//! assert!(report_payload_with(&other, ReportLayout::Given(&layout), &info).is_err());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

pub mod html;
pub mod locale;
pub mod markdown;
pub mod model;
mod paint;
pub mod summary;
pub mod width;

pub use html::{
    MISSING_VIEWER_HINT, ReportInfo, ReportLayout, ReportSide, ViewerBundles, build_report_html,
    build_report_html_with, describe_diff, embedded_viewer, needs_compute, report_payload,
    report_payload_with,
};
pub use locale::{format_int, match_locale, messages, resolve_locale};
pub use markdown::{MarkdownOptions, escape_markdown, render_markdown};
pub use paint::{ColorLevel, Painter, Tone, ansi256, strip_ansi};
pub use summary::{TextContext, render_name_status, render_stat, render_summary, totals_text};
