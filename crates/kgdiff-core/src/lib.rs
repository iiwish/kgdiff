//! The diff engine of [kgdiff](https://github.com/iiwish/kgdiff): a byte-for-byte port of the
//! TypeScript package `@kgdiff/core` (RFC 0002, phase 2).
//!
//! What the crate computes is specified by the conformance corpus in the repository's
//! `conformance/` directory; `cargo test -p kgdiff-core --test conformance` reports which of its
//! parts pass.

pub mod js;
