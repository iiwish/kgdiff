//! Text as JavaScript sees it: UTF-16 code-unit order (J-11), lengths in code units (J-12) and
//! JavaScript's whitespace (J-17).

use std::borrow::Borrow;
use std::cmp::Ordering;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::sync::Arc;

/// Compares two strings by UTF-16 code units, the order of JavaScript's `<` and of
/// `Array.prototype.sort` without a comparator (J-11).
///
/// UTF-8 byte order is code point order, which agrees with UTF-16 order except where a
/// supplementary character (U+10000 and up, a surrogate pair D800–DBFF DC00–DFFF in UTF-16) meets
/// a character in U+E000–U+FFFF: in UTF-16 the supplementary one sorts first.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let Some(at) = x.iter().zip(y).position(|(p, q)| p != q) else {
        return x.len().cmp(&y.len());
    };
    // `at` is inside the first differing character of both strings, which starts at the same
    // offset in both (they agree on everything before `at`).
    let start = (0..=at).rev().find(|&i| a.is_char_boundary(i)).unwrap_or(0);
    let (p, q) = (first_char(&a[start..]), first_char(&b[start..]));
    let supplementary = |c: u32| c >= 0x1_0000;
    let upper_bmp = |c: u32| (0xE000..=0xFFFF).contains(&c);
    if supplementary(p) && upper_bmp(q) {
        Ordering::Less
    } else if upper_bmp(p) && supplementary(q) {
        Ordering::Greater
    } else {
        p.cmp(&q)
    }
}

fn first_char(s: &str) -> u32 {
    s.chars().next().map_or(0, u32::from)
}

/// The length of a string in UTF-16 code units (JavaScript's `.length`).
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JavaScript's WhiteSpace and LineTerminator (what `String.prototype.trim` removes and `\s`
/// matches, J-17): unlike Unicode White_Space it includes U+FEFF and excludes U+0085.
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_whitespace)
}

/// `String.prototype.trimStart`.
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_whitespace)
}

/// `String.prototype.trimEnd`.
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_whitespace)
}

/// Text that the engine compares: an immutable, cheaply cloned string whose `Ord` is JavaScript's
/// (UTF-16 code units, [`cmp_utf16`]), so that `sort()`, `BTreeMap` and `<` order it as the
/// TypeScript implementation does ([RFC 0002, §3, Enforcement]). Equality and hashing are those of
/// the text.
///
/// [RFC 0002, §3, Enforcement]: https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md#enforcement
#[derive(Clone, PartialEq, Eq, Default)]
pub struct JsStr(Arc<str>);

impl JsStr {
    pub fn new(s: &str) -> JsStr {
        JsStr(Arc::from(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The length in UTF-16 code units (JavaScript's `.length`).
    pub fn utf16_len(&self) -> usize {
        utf16_len(&self.0)
    }
}

impl Deref for JsStr {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for JsStr {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl Borrow<str> for JsStr {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl Hash for JsStr {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // As `str` hashes, so that `Borrow<str>` lookups work.
        self.0.as_ref().hash(state);
    }
}

impl Ord for JsStr {
    fn cmp(&self, other: &JsStr) -> Ordering {
        cmp_utf16(&self.0, &other.0)
    }
}

impl PartialOrd for JsStr {
    fn partial_cmp(&self, other: &JsStr) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq<str> for JsStr {
    fn eq(&self, other: &str) -> bool {
        &*self.0 == other
    }
}

impl PartialEq<&str> for JsStr {
    fn eq(&self, other: &&str) -> bool {
        &*self.0 == *other
    }
}

impl From<&str> for JsStr {
    fn from(s: &str) -> JsStr {
        JsStr::new(s)
    }
}

impl From<String> for JsStr {
    fn from(s: String) -> JsStr {
        JsStr(Arc::from(s))
    }
}

impl From<&String> for JsStr {
    fn from(s: &String) -> JsStr {
        JsStr::new(s)
    }
}

impl fmt::Debug for JsStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&*self.0, f)
    }
}

impl fmt::Display for JsStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&*self.0, f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_supplementary_characters_before_the_top_of_the_bmp() {
        let mut v: Vec<JsStr> = ["\u{FF5E}", "\u{1F600}", "\u{E000}", "a"]
            .map(JsStr::from)
            .into();
        v.sort();
        let sorted: Vec<&str> = v.iter().map(JsStr::as_str).collect();
        assert_eq!(sorted, ["a", "\u{1F600}", "\u{E000}", "\u{FF5E}"]);
        assert_eq!(cmp_utf16("ab", "abc"), Ordering::Less);
        assert_eq!(cmp_utf16("\u{D7FF}", "\u{10000}"), Ordering::Less);
        assert_eq!(cmp_utf16("x\u{10FFFF}", "x\u{FFFF}"), Ordering::Less);
        assert_eq!(cmp_utf16("é", "e\u{301}"), Ordering::Greater);
    }

    #[test]
    fn trims_javascript_whitespace() {
        assert_eq!(trim("\u{FEFF}\u{A0} a b\u{3000}\n"), "a b");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
        assert_eq!(trim_start("  a "), "a ");
        assert_eq!(trim_end("  a "), "  a");
        assert_eq!(utf16_len("a😀é"), 4);
    }
}
