//! The layout of [kgdiff](https://github.com/iiwish/kgdiff): one stable, deterministic,
//! label-aware set of coordinates for both versions of a knowledge-graph diff (the union
//! layout), so that nothing jumps when a viewer switches between before, after, overlay and
//! replay. A port of the TypeScript package `@kgdiff/layout` (RFC 0002, phase 4).
//!
//! What the port must reproduce exactly is everything that does not depend on floating-point
//! simulation: which nodes are laid out (the scope), their radii, the `hidden` counts, the
//! strategy, the tick counts of union layouts, component membership and order, and the label
//! widths the scene shares ([`estimate_label_width`], [`node_radius`]). The conformance corpus
//! pins them (`layout-contract.json`, `label-width.json`). Positions do not have to equal
//! TypeScript's (RFC 0002, "Layout decision"); they must be good, deterministic and identical on
//! every target, WebAssembly included: results use only `+ − × ÷ √`, comparisons and
//! conversions, and a seeded PRNG.
//!
//! # Laying out a diff
//!
//! ```
//! use kgdiff_core::js::json;
//! use kgdiff_core::{DiffOptions, diff};
//! use kgdiff_layout::{GENERATOR, LayoutOptions, layout_diff, layout_from_json, layout_to_json};
//!
//! let before = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b"}],
//!     "edges":[{"source":"a","target":"b","predicate":"p"}]}"#)?;
//! let after = json::parse(r#"{"nodes":[{"id":"a"},{"id":"c"}],
//!     "edges":[{"source":"a","target":"c","predicate":"p"}]}"#)?;
//! let result = diff(&before, &after, &DiffOptions::default())?;
//! let layout = layout_diff(&result, &LayoutOptions::default())?;
//! assert_eq!(layout.positions.len(), 3);
//!
//! // The kgdiff.layout document (version 2), and back.
//! let text = json::to_string(&layout_to_json(&layout));
//! assert!(text.starts_with(r#"{"format":"kgdiff.layout","version":2,"generator":"kgdiff-layout/1""#));
//! let read = layout_from_json(&json::parse(&text)?)?;
//! assert_eq!(read.generator.as_deref(), Some(GENERATOR));
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Expanding a changes-only layout
//!
//! [`extend_layout`] adds nodes without moving any node already placed:
//!
//! ```
//! use kgdiff_core::js::json;
//! use kgdiff_core::{DiffOptions, diff};
//! use kgdiff_layout::{LayoutOptions, LayoutScope, extend_layout, layout_diff};
//!
//! let before = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],
//!     "edges":[{"source":"a","target":"b","predicate":"p"},
//!              {"source":"b","target":"c","predicate":"p"}]}"#)?;
//! let after = json::parse(r#"{"nodes":[{"id":"a","label":"A"},{"id":"b"},{"id":"c"}],
//!     "edges":[{"source":"a","target":"b","predicate":"p"},
//!              {"source":"b","target":"c","predicate":"p"}]}"#)?;
//! let result = diff(&before, &after, &DiffOptions::default())?;
//! let options = LayoutOptions { scope: Some(LayoutScope::Changes), ..LayoutOptions::default() };
//! let focused = layout_diff(&result, &options)?;
//! assert_eq!(focused.hidden["b"], 1); // c is left out
//!
//! let expanded = extend_layout(&result, &focused, &["c".into()], &LayoutOptions::default())?;
//! assert_eq!(expanded.positions["a"], focused.positions["a"]);
//! assert_eq!(expanded.positions["b"], focused.positions["b"]);
//! assert!(expanded.hidden.is_empty());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

mod components;
mod engine;
mod extend;
mod forces;
mod geometry;
mod graph;
mod init;
mod json;
mod math;
mod options;
mod pack;
mod pipeline;
mod prng;
mod quadtree;
mod result;
mod scope;
mod simulate;
mod text_metrics;
mod union;

use kgdiff_core::model::{UnionEdge, UnionId, UnionNode};
use kgdiff_core::{DiffResult, Result, js::Value};

pub use json::FORMAT;
pub use options::{LayoutOptions, LayoutScope, LayoutStrategy};
pub use result::{LayoutComponent, LayoutResult, LayoutStats, Rect};

/// The engine generation of this crate's layouts, written as `generator` in layout documents
/// (version 2). It changes whenever an algorithm change moves positions for the same input, so
/// that caches can tell layout generations apart (RFC 0002, §2).
pub const GENERATOR: &str = "kgdiff-layout/1";

/// The union graph a layout is computed from: the nodes and edges of a [`DiffResult`] (in any
/// order; they are sorted by id).
#[derive(Clone, Copy, Debug)]
pub struct LayoutInput<'a> {
    pub nodes: &'a [UnionNode],
    pub edges: &'a [UnionEdge],
}

impl<'a> From<&'a DiffResult> for LayoutInput<'a> {
    fn from(diff: &'a DiffResult) -> LayoutInput<'a> {
        LayoutInput {
            nodes: &diff.nodes,
            edges: &diff.edges,
        }
    }
}

/// A node's radius in world units from its degree: `clamp(4 + 2.2·√degree, 4, 14)`. Shared by
/// every renderer (`nodeRadius` of `@kgdiff/layout`).
pub fn node_radius(degree: f64) -> f64 {
    use math::{max, min};
    min(14.0, max(4.0, 4.0 + 2.2 * max(0.0, degree).sqrt()))
}

/// A deterministic label width estimate without a font engine (`estimateLabelWidth` of
/// `@kgdiff/layout`, which the scene sizes label boxes with).
///
/// The sum of per-character advances × `font_size`: CJK, full-width and emoji 1 em, digits
/// 0.6 em, uppercase letters 0.68 em, spaces 0.3 em, other characters 0.56 em; combining marks,
/// joiners and variation selectors 0 em; a regional-indicator pair (a flag) 1 em. O(length).
pub fn estimate_label_width(text: &str, font_size: f64) -> f64 {
    text_metrics::label_width(text, font_size)
}

/// Computes the shared layout of a diff: deterministic, the same diff and options give the same
/// [`layout_to_json`] bytes on every platform and in WebAssembly.
///
/// Steps: select the scope (`Changes` above `large_graph_threshold` nodes), pick the strategy
/// (`Anchored` when any position is known), lay out every connected component with a seeded
/// force simulation (BFS phyllotaxis start, degree-aware links, many-body, label-aware
/// rectangle collision, weak merge / split springs), pack the components to ~16:10 (isolated
/// nodes in a compact table last), center at the origin (union only) and round to 0.01.
///
/// - The graph laid out has one link per node pair connected in either version (retargeted and
///   carried edges contribute their before form too), so that neither version is favoured.
/// - Scope `Changes` keeps changed nodes, both endpoints of changed edges (either version) and
///   the nodes within `context_hops` of a changed node, never expanding from hubs (degree >
///   `hub_degree`); `hidden` lists the visible nodes with hidden neighbours.
/// - Known positions (`pinned`, then the before node's `position`, then the after node's) are
///   kept exactly (unrounded) in `Anchored` mode; `Union` ignores them. Nothing is centered
///   when anchored, and components without a known node are packed beside the anchored region.
/// - Label boxes: centered below the node (`r + 5` below its center), [`estimate_label_width`]
///   wide (capped at 32 em), one line of 1.25 em, plus the struck old name of renamed nodes.
///   Without `label_aware` only node circles collide, but the bounds still include the labels.
///
/// Ticks per simulation (one per connected component, or the window around new nodes):
/// `clamp(300 − 25·log₂(N), 120, 300)` up to 2000 nodes, then `max(30, 120 · 2000 / N)`
/// (`iterations` overrides both; `stats.iterations` reports the largest simulation's).
/// O(I · N log N) for I ticks (Barnes–Hut charge, quadtree collision).
///
/// # Errors
///
/// `invalid-input` for invalid options (negative distances, a non-finite pin, …).
pub fn layout_diff<'a>(
    input: impl Into<LayoutInput<'a>>,
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    pipeline::layout(input.into(), options)
}

/// Adds `nodes` (currently outside the layout) next to their placed neighbours without moving
/// any node already placed: what a viewer does when a collapsed group of a changes-only layout is
/// expanded.
///
/// Ids already placed are ignored (the layout comes back unchanged when nothing is new). New
/// nodes without a path to a placed node are laid out on their own and packed beside the existing
/// bounds. `hidden` is recounted for scope `Changes`; `stats.strategy` and `stats.iterations` are
/// kept from `layout`.
///
/// # Errors
///
/// `invalid-input` when an id is not a node of the diff, or for invalid options.
pub fn extend_layout<'a>(
    input: impl Into<LayoutInput<'a>>,
    layout: &LayoutResult,
    nodes: &[UnionId],
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    extend::extend(input.into(), layout, nodes, options)
}

/// The `kgdiff.layout` document of a layout: version 2 with its `generator` (version 1 for a
/// version 1 document read back), keys sorted by id, coordinates and radii rounded to 0.01.
/// Write it with [`kgdiff_core::js::json::to_string`];
/// `layout_to_json(&layout_from_json(&document)?)` reproduces the document.
pub fn layout_to_json(layout: &LayoutResult) -> Value {
    json::to_json(layout)
}

/// Reads a `kgdiff.layout` document of version 1 or 2.
///
/// # Errors
///
/// `invalid-input` for a malformed document, `unsupported-version` for another version.
pub fn layout_from_json(document: &Value) -> Result<LayoutResult> {
    json::from_json(document)
}
