//! `kgdiff_core::diff` on two graph documents (the input is split at the first NUL byte, or
//! compared with itself). Matching, classification and hunk building on arbitrary graphs.
#![no_main]

use kgdiff_core::{DiffOptions, diff};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let (before, after) = text.split_once('\0').unwrap_or((text, text));
    let (Ok(before), Ok(after)) = (
        kgdiff_core::js::json::parse(before),
        kgdiff_core::js::json::parse(after),
    ) else {
        return;
    };
    let _ = diff(&before, &after, &DiffOptions::default());
});
