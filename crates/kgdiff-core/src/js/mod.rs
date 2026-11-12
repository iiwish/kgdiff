//! What JavaScript does implicitly, done explicitly (RFC 0002, §4).
//!
//! The TypeScript implementation's results depend on JavaScript's built-ins: how numbers become
//! text, how strings order, which keys an object enumerates first, what `trim` removes, how
//! `Math.round` rounds. This module reproduces each of them, and nothing else in the Rust code
//! formats numbers, compares strings or orders object keys on its own.
//!
//! The part a host uses is the JSON data kgdiff reads and writes:
//!
//! | JavaScript                                        | Here                    |
//! | ------------------------------------------------- | ----------------------- |
//! | a JSON value                                      | [`Value`]               |
//! | object key order (J-21, J-23, J-24)               | [`Object`]              |
//! | strings, ordered as `a < b` orders them (J-11)    | [`JsStr`]               |
//! | `JSON.parse`, `JSON.stringify` (J-02, J-04, J-05) | [`json`]                |
//! | `Map`, `Set` in insertion order                   | [`IndexMap`], [`IndexSet`] |
//!
//! The other items (number formatting, UTF-16 string functions, `Math`, lookups) are the
//! engine's own and hidden from the documentation: the other kgdiff crates use them, and they
//! are not covered by semantic versioning (docs/versioning.md).

pub mod json;
mod lookup;
#[doc(hidden)]
pub mod math;
mod number;
mod object;
mod ordered;
mod string;
mod value;

#[doc(hidden)]
pub use lookup::Lookup;

/// The hasher of every map and set in the engine: fast, seeded per process. No result depends on
/// it: `IndexMap` and `IndexSet` iterate in insertion order, and `Lookup` cannot be iterated.
pub type BuildHasher = foldhash::fast::RandomState;
/// An insertion-ordered map (JavaScript's `Map` without deletion).
pub type IndexMap<K, V> = indexmap::IndexMap<K, V, BuildHasher>;
/// An insertion-ordered set (JavaScript's `Set` without deletion).
pub type IndexSet<K> = indexmap::IndexSet<K, BuildHasher>;
#[doc(hidden)]
pub use number::{
    NumberText, number_from_str, number_to_string, push_number, to_exponential, to_fixed, to_int32,
    to_uint32,
};
pub use object::Object;
#[doc(hidden)]
pub use object::array_index;
#[doc(hidden)]
pub use ordered::OrderedMap;
pub use string::JsStr;
#[doc(hidden)]
pub use string::{
    KeySorted, cmp_utf16, is_whitespace, sort_by_js_key, trim, trim_end, trim_start, utf16_len,
};
pub use value::Value;
