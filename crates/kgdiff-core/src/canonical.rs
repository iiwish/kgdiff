//! Canonical values (`canonical.ts`): key-order-insensitive equality, canonical JSON, structural
//! edge keys and the cyrb53 hash.

use crate::js::{self, JsStr, Lookup, Object, Value, json};
use crate::model::Attrs;

// ─── Structural keys ─────────────────────────────────────────────────────────

/// Structural edge key: `JSON.stringify([source, predicate, target])`.
pub fn triple_key(source: &str, predicate: &str, target: &str) -> JsStr {
    let mut out = String::with_capacity(source.len() + predicate.len() + target.len() + 8);
    out.push('[');
    json::push_string(&mut out, source);
    out.push(',');
    json::push_string(&mut out, predicate);
    out.push(',');
    json::push_string(&mut out, target);
    out.push(']');
    JsStr::from(out)
}

/// Writes [`triple_key`] in `buffer`, replacing what it held.
pub(crate) fn write_triple_key(buffer: &mut String, source: &str, predicate: &str, target: &str) {
    buffer.clear();
    buffer.push('[');
    json::push_string(buffer, source);
    buffer.push(',');
    json::push_string(buffer, predicate);
    buffer.push(',');
    json::push_string(buffer, target);
    buffer.push(']');
}

/// [`triple_key`] built in a reusable buffer, so that only the key itself is allocated.
pub(crate) fn triple_key_in(
    buffer: &mut String,
    source: &str,
    predicate: &str,
    target: &str,
) -> JsStr {
    write_triple_key(buffer, source, predicate, target);
    JsStr::new(buffer)
}

/// True when a structural key carries a parallel-edge suffix (`#2`, `#3`…).
pub fn has_parallel_suffix(key: &str) -> bool {
    !key.ends_with(']')
}

/// A structural key's triple part and its parallel-edge suffix (`#2`, `#3`…): the last `#` after
/// the last `]` starts the suffix.
pub fn split_structural_key(key: &str) -> (&str, &str) {
    if key.ends_with(']') {
        return (key, "");
    }
    match key.rfind('#') {
        None => (key, ""),
        Some(at) => (&key[..at], &key[at..]),
    }
}

// ─── Attribute values ────────────────────────────────────────────────────────

/// Deep, key-order-insensitive equality of JSON values (`attrValueEquals`): numbers by `===`
/// (so `0` equals `-0`), NaN equal to NaN; `None` (undefined) equals only `None`.
pub fn attr_value_equals(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => value_equals(a, b),
        _ => false,
    }
}

fn value_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x == y || (x.is_nan() && y.is_nan()),
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| value_equals(x, y))
        }
        (Value::Object(x), Value::Object(y)) => attrs_equal(x, y, None),
        _ => false,
    }
}

/// Equality of two attribute maps, ignoring key order and the keys in `ignore` (`attrsEqual`).
pub fn attrs_equal(a: &Attrs, b: &Attrs, ignore: Option<&Lookup<JsStr, ()>>) -> bool {
    let ignored = |key: &JsStr| ignore.is_some_and(|set| set.contains_key(key));
    let mut count_a = 0;
    for (key, value) in a {
        if ignored(key) {
            continue;
        }
        count_a += 1;
        if !attr_value_equals(Some(value), b.get(key)) {
            return false;
        }
    }
    let count_b = b.keys().filter(|key| !ignored(key)).count();
    count_a == count_b
}

/// The keys of an attribute map, sorted by UTF-16 code units (`attrKeys`).
pub fn attr_keys(attrs: &Attrs) -> Vec<JsStr> {
    let mut keys: Vec<JsStr> = attrs.keys().cloned().collect();
    keys.sort();
    keys
}

/// Deep copy with object keys inserted in sorted order (`canonicalize`). An [`Object`] still
/// enumerates array-index keys first, as the JavaScript object does.
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(attrs) => Value::Object(canonical_attrs(attrs)),
        other => other.clone(),
    }
}

/// [`canonicalize`] for an attribute map (`canonicalAttrs`).
pub fn canonical_attrs(attrs: &Attrs) -> Attrs {
    let mut out = Object::with_capacity(attrs.len());
    for key in attr_keys(attrs) {
        let value = canonicalize(attrs.get(&key).unwrap_or(&Value::Null));
        out.insert(key, value);
    }
    out
}

/// Canonical JSON of a JSON value: object keys sorted, arrays in order (`canonicalJSON`).
pub fn canonical_json(value: &Value) -> String {
    json::to_string(&canonicalize(value))
}

// ─── cyrb53 ──────────────────────────────────────────────────────────────────

/// Streaming cyrb53 (bryc, public domain) over UTF-16 code units (J-13), as `Cyrb53` of
/// `canonical.ts`: feeding strings one after another hashes their concatenation.
#[derive(Clone, Debug)]
pub struct Cyrb53 {
    h1: u32,
    h2: u32,
    seed: u32,
}

impl Default for Cyrb53 {
    fn default() -> Cyrb53 {
        Cyrb53::new(0)
    }
}

impl Cyrb53 {
    pub fn new(seed: u32) -> Cyrb53 {
        let mut h = Cyrb53 { h1: 0, h2: 0, seed };
        h.reset();
        h
    }

    pub fn reset(&mut self) -> &mut Cyrb53 {
        self.h1 = 0xdead_beef ^ self.seed;
        self.h2 = 0x41c6_ce57 ^ self.seed;
        self
    }

    /// Feeds one UTF-16 code unit (framing: lengths and tags).
    pub fn code(&mut self, unit: u32) -> &mut Cyrb53 {
        self.h1 = (self.h1 ^ unit).wrapping_mul(2_654_435_761);
        self.h2 = (self.h2 ^ unit).wrapping_mul(1_597_334_677);
        self
    }

    /// Feeds the UTF-16 code units of `text`.
    pub fn update(&mut self, text: &str) -> &mut Cyrb53 {
        let (mut h1, mut h2) = (self.h1, self.h2);
        if text.is_ascii() {
            // ASCII bytes are their own UTF-16 code units.
            for &byte in text.as_bytes() {
                let unit = u32::from(byte);
                h1 = (h1 ^ unit).wrapping_mul(2_654_435_761);
                h2 = (h2 ^ unit).wrapping_mul(1_597_334_677);
            }
        } else {
            for unit in text.encode_utf16() {
                let unit = u32::from(unit);
                h1 = (h1 ^ unit).wrapping_mul(2_654_435_761);
                h2 = (h2 ^ unit).wrapping_mul(1_597_334_677);
            }
        }
        self.h1 = h1;
        self.h2 = h2;
        self
    }

    /// Length-prefixed string: makes a sequence of strings injective.
    pub fn string(&mut self, text: &str) -> &mut Cyrb53 {
        let len = length32(if text.is_ascii() {
            text.len()
        } else {
            js::utf16_len(text)
        });
        self.code(len & 0xffff).code(len >> 16).update(text)
    }

    /// Tagged, length-prefixed, key-sorted encoding of a JSON value; `None` is `undefined`.
    pub fn value(&mut self, value: Option<&Value>) -> &mut Cyrb53 {
        let Some(value) = value else {
            return self.code(0x75);
        }; // u
        match value {
            Value::Null => self.code(0x6e),                            // n
            Value::Bool(b) => self.code(if *b { 0x74 } else { 0x66 }), // t / f
            Value::Number(x) => {
                let mut text = js::NumberText::new();
                self.code(0x64).string(text.format(*x)) // d
            }
            Value::String(s) => self.code(0x73).string(s), // s
            Value::Array(items) => {
                let len = length32(items.len());
                self.code(0x61).code(len & 0xffff).code(len >> 16); // a
                for item in items {
                    self.value(Some(item));
                }
                self
            }
            Value::Object(attrs) => self.attrs(attrs),
        }
    }

    /// [`Cyrb53::value`] of an attribute map.
    pub fn attrs(&mut self, attrs: &Attrs) -> &mut Cyrb53 {
        let len = length32(attrs.len());
        self.code(0x6f).code(len & 0xffff).code(len >> 16); // o
        if attrs.len() <= SMALL_SORT {
            // Sorted on the stack: most attribute maps have a few members.
            let mut members: [Option<(&JsStr, &Value)>; SMALL_SORT] = [None; SMALL_SORT];
            for (slot, member) in members.iter_mut().zip(attrs.iter()) {
                *slot = Some(member);
            }
            let members = &mut members[..attrs.len()];
            members.sort_by(|a, b| match (a, b) {
                (Some(a), Some(b)) => a.0.cmp(b.0),
                _ => std::cmp::Ordering::Equal,
            });
            for (key, value) in members.iter().flatten() {
                self.string(key).value(Some(value));
            }
        } else {
            for key in attr_keys(attrs) {
                self.string(&key).value(attrs.get(&key));
            }
        }
        self
    }

    /// Both finalized 32-bit halves, without resetting.
    pub fn digest_pair(&self) -> (u32, u32) {
        let (mut h1, mut h2) = (self.h1, self.h2);
        h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507);
        h1 ^= (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
        h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507);
        h2 ^= (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);
        (h1, h2)
    }

    /// The 53-bit cyrb53 digest.
    pub fn digest(&self) -> u64 {
        let (h1, h2) = self.digest_pair();
        (u64::from(h2 & 0x1f_ffff) << 32) + u64::from(h1)
    }
}

/// Attribute maps up to this size are sorted on the stack when hashed.
const SMALL_SORT: usize = 16;

/// A length as JavaScript's `>>> 0` sees it (lengths stay far below 2³²).
fn length32(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

/// One-shot cyrb53 of a string.
pub fn cyrb53(text: &str, seed: u32) -> u64 {
    Cyrb53::new(seed).update(text).digest()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_suffixes() {
        let key = triple_key("a", "p\"", "b");
        assert_eq!(key.as_str(), r#"["a","p\"","b"]"#);
        assert!(!has_parallel_suffix(&key));
        assert_eq!(
            split_structural_key(r#"["a#","p","b"]#2"#),
            (r#"["a#","p","b"]"#, "#2")
        );
    }

    #[test]
    fn canonical_json_sorts_keys_with_indices_first() {
        let value = json::parse(r#"{"b":1,"10":{"z":[{"y":1,"x":2}],"a":0},"2":3,"a":4}"#).unwrap();
        assert_eq!(
            canonical_json(&value),
            r#"{"2":3,"10":{"a":0,"z":[{"x":2,"y":1}]},"a":4,"b":1}"#
        );
        let other = json::parse(r#"{"a":4,"2":3,"b":1,"10":{"a":0,"z":[{"x":2,"y":1}]}}"#).unwrap();
        assert!(attr_value_equals(Some(&value), Some(&other)));
    }

    #[test]
    fn cyrb53_matches_the_reference() {
        // cyrb53('a') and cyrb53('') of bryc's reference implementation.
        assert_eq!(cyrb53("a", 0), 7_929_297_801_672_961);
        assert_eq!(cyrb53("", 0), 3_338_908_027_751_811);
        assert_eq!(cyrb53("😀é", 0), 6_696_017_539_269_570);
    }
}
