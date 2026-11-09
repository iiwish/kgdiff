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

mod components;
mod contract;
mod geometry;
mod graph;
mod math;
mod options;
mod pipeline;
mod prng;
mod result;
mod scope;
mod text_metrics;
mod union;

use kgdiff_core::DiffResult;
use kgdiff_core::model::{UnionEdge, UnionNode};

#[doc(hidden)]
pub use contract::layout_contract;
pub use options::{LayoutOptions, LayoutScope, LayoutStrategy};
pub use result::{LayoutComponent, LayoutResult, LayoutStats, Rect};

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
