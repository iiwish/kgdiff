//! `kgdiff_core::unpack_diff_json`: the packed form of a diff document.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(value) = kgdiff_core::js::json::parse(text) {
        if let Ok(unpacked) = kgdiff_core::unpack_diff_json(&value) {
            let _ = kgdiff_core::diff_from_json(&unpacked);
        }
    }
});
