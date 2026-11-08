//! The diff engine of [kgdiff](https://github.com/iiwish/kgdiff): a byte-for-byte port of the
//! TypeScript package `@kgdiff/core` (RFC 0002, phase 2).
//!
//! What the crate computes is specified by the conformance corpus in the repository's
//! `conformance/` directory; `cargo test -p kgdiff-core --test conformance` reports which of its
//! parts pass.

pub mod canonical;
pub mod error;
mod graph_json;
pub mod js;
pub mod model;
mod normalize;
pub mod options;
pub mod text;
pub mod util;

pub use error::{ErrorCode, KgdiffError, Result};
pub use graph_json::{edge_to_json, graph_to_json, hash_graph, node_content_equals, node_to_json};
pub use model::{EdgeIdentity, GraphIssue, GraphIssueCode, KGEdge, KGNode, KGraph, Point};
pub use normalize::normalize;
pub use options::{DiffOptions, MatchOptions, MatchStrategy, NormalizeOptions, resolve_options};
