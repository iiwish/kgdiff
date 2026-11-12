//! Reading a delta (`Delta::from_value`), inverting it and applying it, strictly and leniently,
//! to a small graph. The input is delta JSON text.
#![no_main]

use kgdiff_core::{
    ApplyOptions, Delta, NormalizeOptions, apply_delta, invert_delta, normalize_json,
};
use libfuzzer_sys::fuzz_target;

const BASE: &str = r#"{"nodes":[{"id":"a","label":"A","type":"t"},{"id":"b","label":"B"},{"id":"c"}],"edges":[{"source":"a","target":"b","predicate":"p"},{"source":"b","target":"c","predicate":"q"}]}"#;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(value) = kgdiff_core::js::json::parse(text) else {
        return;
    };
    let Ok(delta) = Delta::from_value(&value) else {
        return;
    };
    let _ = invert_delta(&delta);
    let Ok(graph) = normalize_json(BASE, NormalizeOptions::default()) else {
        return;
    };
    let _ = apply_delta(&graph, &delta, ApplyOptions::default());
    let mut lenient = ApplyOptions::default();
    lenient.strict = false;
    let _ = apply_delta(&graph, &delta, lenient);
});
