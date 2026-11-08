//! Display text (`text.ts`): NFC and readable predicates.

use std::borrow::Cow;

use icu_normalizer::ComposingNormalizerBorrowed;

use crate::js::{self, JsStr};

/// True for printable ASCII only (`/^[\x20-\x7e]*$/`), which every normalization leaves as it is.
pub(crate) fn is_printable_ascii(text: &str) -> bool {
    text.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// Unicode NFC (canonical composition), with a fast path for printable ASCII (`nfc`). Labels,
/// aliases and types are read through it (J-25).
pub fn nfc(text: &str) -> Cow<'_, str> {
    if is_printable_ascii(text) {
        Cow::Borrowed(text)
    } else {
        ComposingNormalizerBorrowed::new_nfc().normalize(text)
    }
}

/// [`nfc`] of a [`JsStr`], without a copy when nothing changes.
pub(crate) fn nfc_str(text: &JsStr) -> JsStr {
    match nfc(text) {
        Cow::Borrowed(_) => text.clone(),
        Cow::Owned(s) => JsStr::from(s),
    }
}

/// Human-readable form of a predicate (`predicateLabel`): the local part after the last `#`, `/`
/// or `:` (trailing separators ignored), percent-decoded, `_` → space, NFC. Local parts made only
/// of digits keep the whole predicate; opaque OBO PURLs read like their CURIE
/// (`…/obo/RO_0002131` → `RO:0002131`).
pub fn predicate_label(predicate: &str) -> JsStr {
    let raw = raw_predicate_label(predicate);
    nfc_str(&raw)
}

/// [`predicate_label`] without its NFC step (`rawPredicateLabel`): what an edge snapshot without
/// a label of its own stands for in kgdiff JSON.
pub fn raw_predicate_label(predicate: &str) -> JsStr {
    if let Some((prefix, number)) = obo_purl(predicate) {
        return JsStr::from(format!("{prefix}:{number}"));
    }
    let trimmed = predicate.trim_end_matches(['#', '/', ':']);
    let local = match trimmed.rfind(['#', '/', ':']) {
        Some(cut) => &trimmed[cut + 1..],
        None => trimmed,
    };
    if local.is_empty() || local.bytes().all(|b| b.is_ascii_digit()) {
        return JsStr::from(predicate);
    }
    let decoded = decode_uri_component(local);
    let spaced = decoded.replace('_', " ");
    let readable = collapse_whitespace(&spaced);
    if readable.is_empty() {
        JsStr::from(predicate)
    } else {
        JsStr::from(readable)
    }
}

/// `text.replace(/\s+/g, ' ').trim()`.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if js::is_whitespace(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// `^https?://purl\.obolibrary\.org/obo/([A-Za-z][A-Za-z0-9]*)_(\d+)$`.
fn obo_purl(predicate: &str) -> Option<(&str, &str)> {
    let rest = predicate
        .strip_prefix("https://")
        .or_else(|| predicate.strip_prefix("http://"))?
        .strip_prefix("purl.obolibrary.org/obo/")?;
    let (prefix, number) = rest.split_once('_')?;
    let mut letters = prefix.bytes();
    let first_ok = letters.next().is_some_and(|b| b.is_ascii_alphabetic());
    if first_ok
        && letters.all(|b| b.is_ascii_alphanumeric())
        && !number.is_empty()
        && number.bytes().all(|b| b.is_ascii_digit())
    {
        Some((prefix, number))
    } else {
        None
    }
}

/// `decodeURIComponent(text)`, or `text` itself when it throws (`safeDecode`, J-19): every
/// `%XX` decodes as UTF-8, and a malformed escape or an invalid UTF-8 sequence anywhere leaves
/// the whole text as it is.
pub(crate) fn decode_uri_component(text: &str) -> Cow<'_, str> {
    if !text.contains('%') {
        return Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let hex = |at: usize| -> Option<u8> {
        let digits = bytes.get(at..at + 2)?;
        let value = |d: u8| char::from(d).to_digit(16);
        u8::try_from(value(digits[0])? << 4 | value(digits[1])?).ok()
    };
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let Some(first) = hex(i + 1) else {
            return Cow::Borrowed(text);
        };
        i += 3;
        let continuation = match first {
            0x00..=0x7F => 0,
            0xC0..=0xDF => 1,
            0xE0..=0xEF => 2,
            0xF0..=0xF7 => 3,
            _ => return Cow::Borrowed(text),
        };
        let mut sequence = vec![first];
        for _ in 0..continuation {
            if bytes.get(i) != Some(&b'%') {
                return Cow::Borrowed(text);
            }
            match hex(i + 1) {
                Some(b) if b & 0xC0 == 0x80 => sequence.push(b),
                _ => return Cow::Borrowed(text),
            }
            i += 3;
        }
        // Overlong forms, surrogates and code points beyond U+10FFFF are errors, as in UTF-8.
        if std::str::from_utf8(&sequence).is_err() {
            return Cow::Borrowed(text);
        }
        out.extend_from_slice(&sequence);
    }
    match String::from_utf8(out) {
        Ok(decoded) => Cow::Owned(decoded),
        Err(_) => Cow::Borrowed(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_predicates() {
        assert_eq!(
            predicate_label("http://purl.obolibrary.org/obo/RO_0002131").as_str(),
            "RO:0002131"
        );
        assert_eq!(
            predicate_label("http://ex.org/has_part/").as_str(),
            "has part"
        );
        assert_eq!(predicate_label("ex:12").as_str(), "ex:12");
        assert_eq!(predicate_label("ex:caf%C3%A9").as_str(), "café");
        assert_eq!(predicate_label("ex:bad%E9").as_str(), "bad%E9");
        assert_eq!(predicate_label("ex:a__b").as_str(), "a b");
        assert_eq!(predicate_label("").as_str(), "");
        assert_eq!(predicate_label("ex:_").as_str(), "ex:_");
    }
}
