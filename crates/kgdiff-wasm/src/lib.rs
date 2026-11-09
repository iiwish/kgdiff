//! The WebAssembly build of kgdiff-core that npm's `@kgdiff/compute` loads (RFC 0002, §1 and
//! §6): the JSON-text functions of [`api`], exported with wasm-bindgen. A failure is thrown as the
//! JSON text of `{ code, message, details }`, which `packages/compute` turns into a
//! `KgdiffError`.
//!
//! Built by `pnpm --filter @kgdiff/compute build:wasm` (wasm-bindgen, then `wasm-opt -Oz`).

pub mod api;

use wasm_bindgen::prelude::*;

fn thrown(result: api::Result<String>) -> Result<String, JsValue> {
    result.map_err(|failure| JsValue::from_str(&failure.to_json()))
}

/// The version of the engine (the version of the kgdiff crates).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[wasm_bindgen(js_name = diffJSON)]
pub fn diff_json(before: &str, after: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::diff_json(before, after, options))
}

#[wasm_bindgen(js_name = matchNodesJSON)]
pub fn match_nodes_json(before: &str, after: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::match_nodes_json(before, after, options))
}

#[wasm_bindgen(js_name = textSimilarity)]
pub fn text_similarity(a: &str, b: &str) -> f64 {
    api::text_similarity(a, b)
}

#[wasm_bindgen(js_name = normalizeJSON)]
pub fn normalize_json(graph: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::normalize_json(graph, options))
}

#[wasm_bindgen(js_name = graphIssuesJSON)]
pub fn graph_issues_json(graph: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::graph_issues_json(graph, options))
}

#[wasm_bindgen(js_name = hashGraphJSON)]
pub fn hash_graph_json(graph: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::hash_graph_json(graph, options))
}

#[wasm_bindgen(js_name = readDiffJSON)]
pub fn read_diff_json(document: &str) -> Result<String, JsValue> {
    thrown(api::read_diff_json(document))
}

#[wasm_bindgen(js_name = packDiffJSON)]
pub fn pack_diff_json(document: &str) -> Result<String, JsValue> {
    thrown(api::pack_diff(document))
}

#[wasm_bindgen(js_name = unpackDiffJSON)]
pub fn unpack_diff_json(packed: &str) -> Result<String, JsValue> {
    thrown(api::unpack_diff(packed))
}

#[wasm_bindgen(js_name = deltaOfDiffJSON)]
pub fn delta_of_diff_json(document: &str) -> Result<String, JsValue> {
    thrown(api::delta_of_diff(document))
}

#[wasm_bindgen(js_name = invertDeltaJSON)]
pub fn invert_delta_json(delta: &str) -> Result<String, JsValue> {
    thrown(api::invert_delta_json(delta))
}

#[wasm_bindgen(js_name = applyDeltaJSON)]
pub fn apply_delta_json(graph: &str, delta: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::apply_delta_json(graph, delta, options))
}

#[wasm_bindgen(js_name = hunkTitlesJSON)]
pub fn hunk_titles_json(document: &str, locale: &str) -> Result<String, JsValue> {
    thrown(api::hunk_titles_json(document, locale))
}

#[wasm_bindgen(js_name = predicateLabel)]
pub fn predicate_label(predicate: &str) -> String {
    api::predicate_label(predicate)
}

#[wasm_bindgen(js_name = facetLabel)]
pub fn facet_label(kind: &str, locale: &str) -> Option<String> {
    api::facet_label_of(kind, locale)
}

#[wasm_bindgen(js_name = reformatJSON)]
pub fn reformat_json(text: &str, pretty: bool) -> Result<String, JsValue> {
    thrown(api::reformat_json(text, pretty))
}
