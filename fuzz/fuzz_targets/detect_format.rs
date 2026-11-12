//! `kgdiff_formats::detect_format`: content sniffing, without and with a file name.
#![no_main]

use kgdiff_formats::{FORMAT_EXTENSIONS, detect_format};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&selector, rest)) = data.split_first() else {
        return;
    };
    let Ok(text) = std::str::from_utf8(rest) else {
        return;
    };
    let _ = detect_format(text, None);
    let extensions: Vec<&str> = FORMAT_EXTENSIONS
        .iter()
        .flat_map(|(_, extensions)| extensions.iter().copied())
        .chain(["", ".bin", ".gz", ".json.gz"])
        .collect();
    let extension = extensions[usize::from(selector) % extensions.len()];
    let _ = detect_format(text, Some(&format!("graph{extension}")));
});
