//! `kgdiff_core::js::json::parse`, `JSON.parse` as kgdiff reads it, and the deep reader of
//! kgdiff-formats (any depth, lone surrogates refused).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let _ = kgdiff_core::js::json::parse(text);
    let _ = kgdiff_formats::parse_deep_json(text);
});
