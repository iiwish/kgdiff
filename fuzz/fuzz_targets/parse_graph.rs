//! `kgdiff_formats::parse_graph` for every `FormatId` (and auto-detection). The first byte picks
//! the format, so one corpus serves all of them; seeds are the corpus files prefixed with it.
#![no_main]

use kgdiff_formats::{FormatId, ParseOptions, parse_graph};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&selector, rest)) = data.split_first() else {
        return;
    };
    let Ok(text) = std::str::from_utf8(rest) else {
        return;
    };
    // 0..8 are the formats, 8 is auto-detection.
    let mut options = ParseOptions::default();
    options.format = FormatId::ALL.get(usize::from(selector) % 9).copied();
    options.base_iri = Some("http://example.org/base/".into());
    if let Ok(result) = parse_graph(text, &options) {
        // Serialising the result is part of reading it.
        let _ = result.to_value();
    }
});
