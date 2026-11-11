//! The WebAssembly builds that npm's `@kgdiff/compute` loads (RFC 0002, §1, §6 and §7): one build
//! of this crate per module, selected by feature, each exporting its functions with wasm-bindgen.
//!
//! - `engine` (`compute.wasm`): core and layout on JSON text ([`api`]);
//! - `layout` (`layout.wasm`): the layout on typed arrays ([`tables`]), without a JSON reader or
//!   Unicode normalization, to be inlined in HTML reports;
//! - `parsers` (`formats.wasm`): the graph file parsers.
//!
//! A failure is thrown as the JSON text of `{ code, message, details }`, which `packages/compute`
//! turns into a `KgdiffError`.
//!
//! Built by `pnpm --filter @kgdiff/compute build:wasm` (wasm-bindgen, then `wasm-opt -Oz`).

#[cfg(feature = "engine")]
pub mod api;
#[cfg(feature = "engine")]
mod engine;
pub mod failure;
#[cfg(feature = "parsers")]
pub mod parsers;
#[cfg(feature = "layout")]
pub mod tables;

use wasm_bindgen::prelude::*;

/// The version of the engine (the version of the kgdiff crates).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
