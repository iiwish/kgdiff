//! The text outputs and HTML reports of [kgdiff](https://github.com/iiwish/kgdiff): a port of the
//! rendering half of the TypeScript CLI `@kgdiff/cli` (RFC 0002, phase 3). Given a
//! [`kgdiff_core::DiffResult`], it writes what `kgdiff` prints — the terminal summary, `--stat`,
//! `--name-status` and the Markdown summary, in English or Simplified Chinese, laid out for a
//! width in terminal columns — and assembles the single-file HTML report. It does no I/O, so an
//! application that embeds the engine renders the same summary as the CLI without depending on
//! it.
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

pub mod html;
pub mod locale;
pub mod markdown;
pub mod model;
mod paint;
pub mod summary;
pub mod width;

pub use html::{
    MISSING_VIEWER_HINT, ReportInfo, ReportSide, ViewerBundles, build_report_html, describe_diff,
    embedded_viewer, needs_compute,
};
pub use locale::{format_int, match_locale, messages, resolve_locale};
pub use markdown::{MarkdownOptions, escape_markdown, render_markdown};
pub use paint::{ColorLevel, Painter, Tone, ansi256, strip_ansi};
pub use summary::{TextContext, render_name_status, render_stat, render_summary, totals_text};
