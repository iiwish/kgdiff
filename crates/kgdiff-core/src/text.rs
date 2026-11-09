//! Text (`text.ts`): NFC and readable predicates for display; normalized text, similarity and
//! blocking keys for matching (docs/algorithms.md §1–2).
//!
//! Unicode data (NFC / NFKC, case mapping, general categories, scripts) comes from ICU4X, one
//! pinned Unicode version for all of it (RFC 0002, J-25 … J-27).

use std::borrow::Cow;
use std::rc::Rc;

use crate::js::{IndexMap, IndexSet};
use icu_casemap::CaseMapperBorrowed;
use icu_locale_core::LanguageIdentifier;
use icu_normalizer::ComposingNormalizerBorrowed;
use icu_properties::CodePointMapDataBorrowed;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup, Script};

use crate::js::{self, JsStr, Lookup};
use crate::util::{clamp01, round6};

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

// ─── Normalization ───────────────────────────────────────────────────────────

fn general_category(c: char) -> GeneralCategory {
    CodePointMapDataBorrowed::<GeneralCategory>::new().get(c)
}

/// `\p{P}` (any punctuation).
fn is_punctuation(c: char) -> bool {
    GeneralCategoryGroup::Punctuation.contains(general_category(c))
}

/// `[\p{P}\s]`: what separates tokens.
fn is_separator(c: char) -> bool {
    is_punctuation(c) || js::is_whitespace(c)
}

/// `\p{Cc}` or `\p{Cf}`: invisible characters, removed when folding.
fn is_invisible(c: char) -> bool {
    matches!(
        general_category(c),
        GeneralCategory::Control | GeneralCategory::Format
    )
}

/// `\p{L}`.
fn is_letter(c: char) -> bool {
    GeneralCategoryGroup::Letter.contains(general_category(c))
}

/// `\p{Nd}`.
fn is_decimal_digit(c: char) -> bool {
    general_category(c) == GeneralCategory::DecimalNumber
}

/// `[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]`.
fn is_cjk(c: char) -> bool {
    let script = CodePointMapDataBorrowed::<Script>::new().get(c);
    script == Script::Han
        || script == Script::Hiragana
        || script == Script::Katakana
        || script == Script::Hangul
}

/// `toLowerCase()`: full, locale-independent case mapping (J-18).
pub fn to_lowercase(text: &str) -> Cow<'_, str> {
    if is_printable_ascii(text) {
        return if text.bytes().any(|b| b.is_ascii_uppercase()) {
            Cow::Owned(text.to_ascii_lowercase())
        } else {
            Cow::Borrowed(text)
        };
    }
    CaseMapperBorrowed::new().lowercase_to_string(text, &LanguageIdentifier::UNKNOWN)
}

/// NFKC, lowercase, invisible characters removed; printable ASCII needs only the lowercasing
/// (`fold`).
fn fold(text: &str) -> String {
    if is_printable_ascii(text) {
        return text.to_ascii_lowercase();
    }
    let compatible = ComposingNormalizerBorrowed::new_nfkc().normalize(text);
    let lowered =
        CaseMapperBorrowed::new().lowercase_to_string(&compatible, &LanguageIdentifier::UNKNOWN);
    lowered.chars().filter(|&c| !is_invisible(c)).collect()
}

/// `text.replace(/[\p{P}\s]+/gu, ' ').trim()`.
fn collapse_separators(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut separated = false;
    for c in text.chars() {
        if is_separator(c) {
            separated = true;
        } else {
            if separated && !out.is_empty() {
                out.push(' ');
            }
            separated = false;
            out.push(c);
        }
    }
    out
}

/// NFKC, lowercase, control and format characters removed, punctuation (`_-./` included) and
/// whitespace collapsed to single spaces, trimmed (`normalizeText`).
pub fn normalize_text(text: &str) -> String {
    collapse_separators(&fold(text))
}

/// Precomputed representation of a string for repeated similarity queries (`TextProfile`).
#[derive(Debug)]
pub struct TextProfile {
    /// NFKC, lowercased, invisible characters removed; punctuation kept.
    folded: String,
    normalized: String,
    /// Code points of the normalized text without spaces.
    chars: Vec<char>,
    /// Character-bigram multiset of `chars`.
    bigrams: IndexMap<(char, char), u32>,
    bigram_total: usize,
    /// Unique word tokens, sorted.
    tokens: Vec<JsStr>,
    /// Tokens written with a trailing period, letters only, ≥ 2 UTF-16 units.
    abbreviations: IndexSet<JsStr>,
    /// Digit runs as numbers, sorted, unique, joined.
    numbers: String,
}

/// Digit runs (`\p{Nd}+`) without leading zeros (one digit kept), sorted, unique, joined.
fn numbers_of(normalized: &str) -> String {
    let mut runs: IndexSet<String> = IndexSet::default();
    let mut run = String::new();
    let mut flush = |run: &mut String| {
        if !run.is_empty() {
            // `^0+(?=.)`: leading zeros, keeping the last character.
            let first_kept = run
                .char_indices()
                .find(|&(i, c)| c != '0' || i + c.len_utf8() == run.len());
            let start = first_kept.map_or(0, |(i, _)| i);
            runs.insert(run[start..].to_owned());
            run.clear();
        }
    };
    for c in normalized.chars() {
        if is_decimal_digit(c) {
            run.push(c);
        } else {
            flush(&mut run);
        }
    }
    flush(&mut run);
    let mut sorted: Vec<String> = runs.into_iter().collect();
    sorted.sort_by(|a, b| js::cmp_utf16(a, b));
    sorted.join(" ")
}

/// The profile of a text (`textProfile`).
pub fn text_profile(text: &str) -> TextProfile {
    let lowered = fold(text);
    let normalized = collapse_separators(&lowered);
    let mut token_set: IndexSet<JsStr> = IndexSet::default();
    let mut abbreviations: IndexSet<JsStr> = IndexSet::default();
    // `/[^\p{P}\s]+\.?/gu` over the folded text.
    let mut rest = lowered.as_str();
    while let Some(start) = rest.find(|c: char| !is_separator(c)) {
        let tail = &rest[start..];
        let end = tail.find(is_separator).unwrap_or(tail.len());
        let token = &tail[..end];
        let abbreviated = tail[end..].starts_with('.');
        token_set.insert(JsStr::from(token));
        if abbreviated && js::utf16_len(token) >= 2 && token.chars().all(is_letter) {
            abbreviations.insert(JsStr::from(token));
        }
        rest = &tail[end + usize::from(abbreviated)..];
    }
    let chars: Vec<char> = normalized.chars().filter(|&c| c != ' ').collect();
    let mut bigrams: IndexMap<(char, char), u32> = IndexMap::default();
    for pair in chars.windows(2) {
        *bigrams.entry((pair[0], pair[1])).or_insert(0) += 1;
    }
    let mut tokens: Vec<JsStr> = token_set.into_iter().collect();
    tokens.sort();
    TextProfile {
        numbers: numbers_of(&normalized),
        bigram_total: chars.len().saturating_sub(1),
        folded: lowered,
        normalized,
        chars,
        bigrams,
        tokens,
        abbreviations,
    }
}

/// Memoizes `text_profile` for the lifetime of one matching run (`ProfileCache`).
#[derive(Default)]
pub struct ProfileCache {
    cache: Lookup<JsStr, Rc<TextProfile>>,
}

impl ProfileCache {
    pub fn new() -> ProfileCache {
        ProfileCache::default()
    }

    pub fn get(&mut self, text: &JsStr) -> Rc<TextProfile> {
        self.cache
            .get_or_insert_with(text.clone(), || Rc::new(text_profile(text)))
            .clone()
    }
}

// ─── Similarity measures ─────────────────────────────────────────────────────

/// Sørensen–Dice coefficient of two bigram multisets.
fn bigram_dice(a: &TextProfile, b: &TextProfile) -> f64 {
    let total = a.bigram_total + b.bigram_total;
    if total == 0 {
        return 0.0;
    }
    let (small, large) = if a.bigrams.len() <= b.bigrams.len() {
        (a, b)
    } else {
        (b, a)
    };
    let mut shared = 0u32;
    for (gram, count) in &small.bigrams {
        if let Some(other) = large.bigrams.get(gram) {
            shared += (*count).min(*other);
        }
    }
    (2.0 * f64::from(shared)) / count_f64(total)
}

/// A count as a double (exact).
fn count_f64(n: usize) -> f64 {
    f64::from(u32::try_from(n).unwrap_or(u32::MAX))
}

/// Jaro–Winkler similarity (prefix scale 0.1, prefix ≤ 4) over code points (`jaroWinkler`).
pub fn jaro_winkler(a: &[char], b: &[char]) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let window = (a.len().max(b.len()) / 2).saturating_sub(1);
    let mut matched_a = vec![false; a.len()];
    let mut matched_b = vec![false; b.len()];
    let mut matches = 0usize;
    for i in 0..a.len() {
        let lo = i.saturating_sub(window);
        let hi = (i + window).min(b.len() - 1);
        for j in lo..=hi {
            if !matched_b[j] && a[i] == b[j] {
                matched_a[i] = true;
                matched_b[j] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let mut transpositions = 0usize;
    let mut k = 0;
    for i in 0..a.len() {
        if !matched_a[i] {
            continue;
        }
        while !matched_b[k] {
            k += 1;
        }
        if a[i] != b[k] {
            transpositions += 1;
        }
        k += 1;
    }
    let m = count_f64(matches);
    let (la, lb) = (count_f64(a.len()), count_f64(b.len()));
    let jaro = (m / la + m / lb + (m - count_f64(transpositions) / 2.0) / m) / 3.0;
    let shorter = a.len().min(b.len());
    if shorter < 4 || count_f64(shorter) / count_f64(a.len().max(b.len())) < 0.7 {
        return jaro;
    }
    let mut prefix = 0usize;
    while prefix < 4 && a[prefix] == b[prefix] {
        prefix += 1;
    }
    jaro + count_f64(prefix) * 0.1 * (1.0 - jaro)
}

/// Ceiling of the similarity of texts that both mention numbers, but different ones.
const NUMBER_MISMATCH_CAP: f64 = 0.5;
/// Weight of an abbreviation match relative to an exact token match.
const ABBREVIATION_WEIGHT: f64 = 0.9;

/// Dice over token sets, abbreviation-aware (`tokenSetDice`).
fn token_set_dice(a: &TextProfile, b: &TextProfile) -> f64 {
    let total = a.tokens.len() + b.tokens.len();
    if total == 0 {
        return 0.0;
    }
    let mut rest_a: Vec<JsStr> = Vec::new();
    let mut shared_count = 0usize;
    for token in &a.tokens {
        if b.tokens.binary_search(token).is_ok() {
            shared_count += 1;
        } else {
            rest_a.push(token.clone());
        }
    }
    let mut shared = count_f64(shared_count);
    if !a.abbreviations.is_empty() || !b.abbreviations.is_empty() {
        let mut rest_b: Vec<JsStr> = b
            .tokens
            .iter()
            .filter(|t| a.tokens.binary_search(t).is_err())
            .cloned()
            .collect();
        shared += ABBREVIATION_WEIGHT
            * count_f64(abbreviation_matches(
                &mut rest_a,
                &a.abbreviations,
                &mut rest_b,
            ));
        shared += ABBREVIATION_WEIGHT
            * count_f64(abbreviation_matches(
                &mut rest_b,
                &b.abbreviations,
                &mut rest_a,
            ));
    }
    js::math::min(1.0, (2.0 * shared) / count_f64(total))
}

/// Greedily pairs abbreviations of `from` with longer tokens of `into` they prefix, removing the
/// consumed tokens from both (`abbreviationMatches`).
fn abbreviation_matches(
    from: &mut Vec<JsStr>,
    abbreviations: &IndexSet<JsStr>,
    into: &mut Vec<JsStr>,
) -> usize {
    if abbreviations.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut i = 0;
    while i < from.len() {
        let abbr = &from[i];
        if !abbreviations.contains(abbr) {
            i += 1;
            continue;
        }
        let found = into.iter().position(|token| {
            token.utf16_len() > abbr.utf16_len() && token.starts_with(abbr.as_str())
        });
        let Some(j) = found else {
            i += 1;
            continue;
        };
        into.remove(j);
        from.remove(i);
        count += 1;
    }
    count
}

/// `textSimilarity` on precomputed profiles (`profileSimilarity`).
pub fn profile_similarity(x: &TextProfile, y: &TextProfile) -> f64 {
    if x.normalized.is_empty() || y.normalized.is_empty() {
        return if x.folded == y.folded { 1.0 } else { 0.0 };
    }
    if x.normalized == y.normalized {
        return 1.0;
    }
    // A canonical argument order makes the greedy steps exactly symmetric.
    let (a, b) = if js::cmp_utf16(&x.normalized, &y.normalized).is_lt() {
        (x, y)
    } else {
        (y, x)
    };
    let characters = if a.chars.len() < 4 || b.chars.len() < 4 {
        jaro_winkler(&a.chars, &b.chars)
    } else {
        bigram_dice(a, b)
    };
    let tokens = token_set_dice(a, b);
    let best = clamp01(js::math::max(characters, tokens));
    let numbers_differ = a.numbers != b.numbers && !a.numbers.is_empty() && !b.numbers.is_empty();
    round6(if numbers_differ {
        js::math::min(best, NUMBER_MISMATCH_CAP)
    } else {
        best
    })
}

/// Similarity of two display strings in [0, 1] (`textSimilarity`, docs/algorithms.md §2):
/// symmetric, 1 for strings equal after normalization, rounded to 1e-6.
pub fn text_similarity(a: &str, b: &str) -> f64 {
    profile_similarity(&text_profile(a), &text_profile(b))
}

// ─── Blocking keys ───────────────────────────────────────────────────────────

/// Function words that carry no identity on their own.
const STOP_WORDS: [&str; 33] = [
    "a", "an", "and", "as", "at", "by", "de", "der", "des", "di", "die", "du", "el", "en", "et",
    "for", "from", "in", "into", "is", "la", "le", "les", "of", "on", "or", "the", "to", "und",
    "van", "von", "with", "",
];

fn is_stop_word(token: &str) -> bool {
    !token.is_empty() && STOP_WORDS.contains(&token)
}

/// Inverted-index keys for candidate generation (`blockKeys`): `f:` the normalized text, `w:`
/// tokens of ≥ 2 characters that are not stop words, `p:` the first 4 characters of tokens of
/// ≥ 4, `b:` bigrams of CJK runs (single characters as unigrams), `r:` punctuation-only text.
pub fn block_keys(profile: &TextProfile, into: &mut IndexSet<String>) {
    if profile.normalized.is_empty() {
        if !profile.folded.is_empty() {
            into.insert(format!("r:{}", profile.folded));
        }
        return;
    }
    into.insert(format!("f:{}", profile.normalized));
    for token in &profile.tokens {
        let chars: Vec<char> = token.chars().collect();
        if chars.len() >= 2 && !is_stop_word(token) {
            into.insert(format!("w:{token}"));
        }
        if chars.len() >= 4 {
            into.insert(format!("p:{}", chars[..4].iter().collect::<String>()));
        }
        let mut run: Vec<char> = Vec::new();
        let flush = |run: &mut Vec<char>, into: &mut IndexSet<String>| {
            if run.len() == 1 {
                into.insert(format!("b:{}", run[0]));
            }
            for pair in run.windows(2) {
                into.insert(format!("b:{}{}", pair[0], pair[1]));
            }
            run.clear();
        };
        for &c in &chars {
            if is_cjk(c) {
                run.push(c);
            } else {
                flush(&mut run, into);
            }
        }
        flush(&mut run, into);
    }
}

/// A name key (`nameKeys`): UTF-16 code units, since `p:` keys take the first four units of a
/// token and may end in half a surrogate pair, which compares as in JavaScript (J-12).
pub type NameKey = Vec<u16>;

/// Keys for finding near-identical names (`nameKeys`): the normalized text, informative words
/// (≥ 2 UTF-16 units, not stop words) and their first four UTF-16 units.
pub fn name_keys(texts: &[&str]) -> Vec<NameKey> {
    let mut keys: IndexSet<NameKey> = IndexSet::default();
    let key = |prefix: &str, units: &[u16]| -> NameKey {
        prefix.encode_utf16().chain(units.iter().copied()).collect()
    };
    for text in texts {
        let normalized = normalize_text(text);
        if normalized.is_empty() {
            continue;
        }
        let units: Vec<u16> = normalized.encode_utf16().collect();
        keys.insert(key("f:", &units));
        for token in normalized.split(' ') {
            let units: Vec<u16> = token.encode_utf16().collect();
            if units.len() >= 2 && !is_stop_word(token) {
                keys.insert(key("w:", &units));
            }
            if units.len() >= 4 {
                keys.insert(key("p:", &units[..4]));
            }
        }
    }
    keys.into_iter().collect()
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
