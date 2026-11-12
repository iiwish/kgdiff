//! The exports of `compute.wasm`: core and layout on JSON text, the functions of [`api`].

use wasm_bindgen::prelude::*;

use crate::api;
use crate::failure::thrown;

#[wasm_bindgen(js_name = diffJSON)]
pub fn diff_json(before: &str, after: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::diff_json(before, after, options))
}

#[wasm_bindgen(js_name = matchNodesJSON)]
pub fn match_nodes_json(
    before: &str,
    after: &str,
    options: &str,
    before_normalize: &str,
    after_normalize: &str,
) -> Result<String, JsValue> {
    thrown(api::match_nodes_json(
        before,
        after,
        options,
        before_normalize,
        after_normalize,
    ))
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

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = readDiffJSON)]
pub fn read_diff_json(document: &str) -> Result<String, JsValue> {
    thrown(api::read_diff_json(document))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = packDiffJSON)]
pub fn pack_diff_json(document: &str) -> Result<String, JsValue> {
    thrown(api::pack_diff(document))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = unpackDiffJSON)]
pub fn unpack_diff_json(packed: &str) -> Result<String, JsValue> {
    thrown(api::unpack_diff(packed))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = deltaOfDiffJSON)]
pub fn delta_of_diff_json(document: &str) -> Result<String, JsValue> {
    thrown(api::delta_of_diff(document))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = invertDeltaJSON)]
pub fn invert_delta_json(delta: &str) -> Result<String, JsValue> {
    thrown(api::invert_delta_json(delta))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = applyDeltaJSON)]
pub fn apply_delta_json(graph: &str, delta: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::apply_delta_json(graph, delta, options))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = hunkTitlesJSON)]
pub fn hunk_titles_json(document: &str, locale: &str) -> Result<String, JsValue> {
    thrown(api::hunk_titles_json(document, locale))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = predicateLabel)]
pub fn predicate_label(predicate: &str) -> String {
    api::predicate_label(predicate)
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = facetLabel)]
pub fn facet_label(kind: &str, locale: &str) -> Option<String> {
    api::facet_label_of(kind, locale)
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = reformatJSON)]
pub fn reformat_json(text: &str, pretty: bool) -> Result<String, JsValue> {
    thrown(api::reformat_json(text, pretty))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = layoutDiffJSON)]
pub fn layout_diff_json(document: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::layout_diff_json(document, options))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = extendLayoutJSON)]
pub fn extend_layout_json(
    document: &str,
    layout: &str,
    nodes: &str,
    options: &str,
) -> Result<String, JsValue> {
    thrown(api::extend_layout_json(document, layout, nodes, options))
}

#[wasm_bindgen(js_name = diffLayoutJSON)]
pub fn diff_layout_json(
    before: &str,
    after: &str,
    diff_options: &str,
    layout_options: &str,
) -> Result<String, JsValue> {
    thrown(api::diff_layout_json(
        before,
        after,
        diff_options,
        layout_options,
    ))
}

#[wasm_bindgen(js_name = computedDiffJSON)]
pub fn computed_diff_json(
    before: &str,
    after: &str,
    diff_options: &str,
    layout_options: &str,
    with_layout: bool,
) -> Result<String, JsValue> {
    thrown(api::computed_diff_json(
        before,
        after,
        diff_options,
        layout_options,
        with_layout,
    ))
}

#[wasm_bindgen(js_name = layoutGraphJSON)]
pub fn layout_graph_json(graph: &str, options: &str, normalize: &str) -> Result<String, JsValue> {
    thrown(api::layout_graph_json(graph, options, normalize))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = layoutDiffOnJSON)]
pub fn layout_diff_on_json(
    document: &str,
    previous: &str,
    options: &str,
) -> Result<String, JsValue> {
    thrown(api::layout_diff_on_json(document, previous, options))
}

#[cfg(feature = "corpus")]
#[wasm_bindgen(js_name = layoutAfterJSON)]
pub fn layout_after_json(document: &str, layout: &str, options: &str) -> Result<String, JsValue> {
    thrown(api::layout_after_json(document, layout, options))
}
