//! `kgdiff_core::diff_from_json`: reads a `--json` diff document (what the viewer and the report
//! renderers are handed).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(value) = kgdiff_core::js::json::parse(text) {
        let _ = kgdiff_core::diff_from_json(&value);
    }
});
