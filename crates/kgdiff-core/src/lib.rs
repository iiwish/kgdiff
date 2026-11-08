//! The diff engine of [kgdiff](https://github.com/iiwish/kgdiff): a byte-for-byte port of the
//! TypeScript package `@kgdiff/core` (RFC 0002, phase 2).
//!
//! What the crate computes is specified by the conformance corpus in the repository's
//! `conformance/` directory; `cargo test -p kgdiff-core --test conformance` reports which of its
//! parts pass.

pub mod canonical;
mod classify;
pub mod delta;
mod edges;
pub mod error;
mod graph_json;
mod hunks;
pub mod i18n;
mod index;
pub mod js;
mod matching;
mod merge_split;
pub mod model;
mod normalize;
pub mod options;
mod order;
mod pipeline;
mod stats;
pub mod text;
mod transport;
pub mod util;

pub use delta::{Delta, DeltaOp, NodeField};
pub use error::{ErrorCode, KgdiffError, Result};
pub use graph_json::{edge_to_json, graph_to_json, hash_graph, node_content_equals, node_to_json};
pub use i18n::{Locale, facet_label, format_hunk};
pub use index::DiffIndex;
pub use matching::match_nodes;
pub use model::{EdgeIdentity, GraphIssue, GraphIssueCode, KGEdge, KGNode, KGraph, Point};
pub use normalize::normalize;
pub use options::{DiffOptions, MatchOptions, MatchStrategy, NormalizeOptions, resolve_options};
pub use pipeline::{DiffResult, diff, diff_graphs};
pub use transport::{diff_to_json, union_edge_to_json, union_node_to_json};
