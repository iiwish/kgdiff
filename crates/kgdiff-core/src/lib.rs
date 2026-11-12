//! The diff engine of [kgdiff](https://github.com/iiwish/kgdiff): a semantic, reviewable diff of
//! two versions of a knowledge graph, and the invertible delta between them. A byte-for-byte port
//! of the TypeScript package `@kgdiff/core` (RFC 0002, phase 2): the same input gives the same
//! `kgdiff.diff`, `kgdiff.diff.packed`, `kgdiff.delta` and `kgdiff.graph` documents, byte for
//! byte, the same content hashes and the same hunk titles.
//!
//! What the crate computes is specified by the conformance corpus in the repository's
//! `conformance/` directory; `cargo test -p kgdiff-core --test conformance` checks every case.
//! Everything JavaScript does implicitly (number formatting, UTF-16 string order, object key
//! order, `JSON.parse`) lives in [`js`].
//!
//! # Diffing two graphs
//!
//! Graphs are given as kgdiff JSON (`{ nodes: [...], edges: [...] }`, read with [`js::json`]);
//! [`diff`] normalizes both and compares them.
//!
//! ```
//! use kgdiff_core::js::json;
//! use kgdiff_core::{DiffOptions, Locale, diff, format_hunk};
//!
//! let before = json::parse(r#"{"nodes":[{"id":"a","label":"Ada"},{"id":"b"}],
//!     "edges":[{"source":"a","target":"b","predicate":"knows"}]}"#)?;
//! let after = json::parse(r#"{"nodes":[{"id":"a","label":"Ada Lovelace"},{"id":"b"}],
//!     "edges":[{"source":"a","target":"b","predicate":"knows"}]}"#)?;
//! let result = diff(&before, &after, &DiffOptions::default())?;
//!
//! assert_eq!(result.stats.nodes.modified, 1);
//! let (title, _subtitle) = format_hunk(&result.hunks[0], &result, Locale::En)?;
//! assert_eq!(title, "Renamed “Ada” → “Ada Lovelace”");
//!
//! // The kgdiff.diff document, as `kgdiff --json` writes it.
//! let document = json::to_string(&kgdiff_core::diff_to_json(&result));
//! assert!(document.starts_with(r#"{"format":"kgdiff.diff","version":1"#));
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Checking a delta with `apply_delta`
//!
//! Every diff carries a delta: applying it to the before graph gives the after graph, and its
//! inverse undoes it. [`apply_delta`] verifies the base graph's hash and each operation's
//! precondition (or, leniently, skips and reports what does not fit).
//!
//! ```
//! use kgdiff_core::js::json;
//! use kgdiff_core::{ApplyOptions, Delta, DiffOptions, apply_delta, diff, hash_graph, invert_delta};
//!
//! let before = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[]}"#)?;
//! let after = json::parse(r#"{"nodes":[{"id":"a"},{"id":"c"}],
//!     "edges":[{"source":"a","target":"c","predicate":"p"}]}"#)?;
//! let result = diff(&before, &after, &DiffOptions::default())?;
//!
//! // A delta as `kgdiff --delta` writes it, read back.
//! let text = json::to_string(&result.delta.to_value());
//! let delta = Delta::from_value(&json::parse(&text)?)?;
//!
//! let (patched, skipped) = apply_delta(&result.before, &delta, ApplyOptions::default())?;
//! assert!(skipped.is_empty());
//! assert_eq!(hash_graph(&patched), hash_graph(&result.after));
//!
//! let (restored, _) = apply_delta(&patched, &invert_delta(&delta), ApplyOptions::default())?;
//! assert_eq!(hash_graph(&restored), hash_graph(&result.before));
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Reading a `diff.v1` document
//!
//! [`diff_from_json`] rebuilds a [`DiffResult`] from a `kgdiff.diff` document and checks that
//! its parts agree (union elements, hunks, delta, stats); [`unpack_diff_json`] reads the packed
//! form HTML reports embed.
//!
//! ```
//! use kgdiff_core::js::json;
//! use kgdiff_core::{DiffOptions, Locale, diff, diff_from_json, diff_to_json, format_hunk};
//!
//! # let before = json::parse(r#"{"nodes":[{"id":"x","label":"Old"}],"edges":[]}"#)?;
//! # let after = json::parse(r#"{"nodes":[{"id":"x","label":"New"},{"id":"y"}],"edges":[]}"#)?;
//! # let text = json::to_string(&diff_to_json(&diff(&before, &after, &DiffOptions::default())?));
//! // `text` is a kgdiff.diff document, as `kgdiff --json` writes it.
//! let result = diff_from_json(&json::parse(&text)?)?;
//! for hunk in &result.hunks {
//!     let (title, subtitle) = format_hunk(hunk, &result, Locale::ZhCn)?;
//!     println!("{title} · {subtitle}");
//! }
//! assert_eq!(json::to_string(&diff_to_json(&result)), text);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

#[doc(hidden)]
pub mod canonical;
mod classify;
pub mod delta;
mod edges;
pub mod error;
mod graph;
mod graph_json;
mod hunks;
pub mod i18n;
mod index;
mod input;
pub mod js;
mod matching;
mod merge_split;
pub mod model;
mod normalize;
pub mod options;
mod order;
mod packed;
mod pipeline;
mod reader;
mod stats;
#[doc(hidden)]
pub mod text;
mod transport;
#[doc(hidden)]
pub mod util;

pub use delta::{
    ApplyOptions, Delta, DeltaOp, NodeField, SkippedOp, apply_delta, invert_delta,
    with_edge_identity,
};
pub use error::{ErrorCode, KgdiffError, Result};
pub use graph_json::{edge_to_json, graph_to_json, hash_graph, node_content_equals, node_to_json};
pub use i18n::{Locale, facet_label, format_hunk};
pub use input::{EdgeInput, GraphInput, NodeInput};
pub use matching::match_nodes;
pub use model::{EdgeIdentity, EdgeRef, GraphIssue, GraphIssueCode, KGEdge, KGNode, KGraph, Point};
pub use normalize::{normalize, normalize_input, normalize_json};
pub use options::{DiffOptions, MatchOptions, MatchStrategy, NormalizeOptions, resolve_options};
pub use packed::{pack_diff_json, unpack_diff_json};
pub use pipeline::{DiffResult, diff, diff_graphs};
pub use reader::diff_from_json;
pub use transport::{diff_to_json, union_edge_to_json, union_node_to_json};
