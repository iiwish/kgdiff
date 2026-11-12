//! What JavaScript does implicitly, done explicitly.
//!
//! kgdiff's documents and hashes are the same in Rust and in the npm packages, so they depend on
//! JavaScript's built-ins: how numbers become text, how strings order, which keys an object
//! enumerates first, what `trim` removes, how `Math.round` rounds. This module reproduces each of
//! them, and nothing else in the Rust code formats numbers, compares strings or orders object
//! keys on its own.
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
///
/// Its algorithm is the engine's choice and may change in any release; the type itself is
/// kgdiff's, so that the public [`IndexMap`] and [`IndexSet`] do not name a dependency's type.
#[derive(Clone, Debug, Default)]
pub struct BuildHasher(foldhash::fast::RandomState);

impl std::hash::BuildHasher for BuildHasher {
    type Hasher = Hasher;

    #[inline]
    fn build_hasher(&self) -> Hasher {
        Hasher(self.0.build_hasher())
    }
}

/// The hasher [`BuildHasher`] builds.
#[derive(Clone)]
pub struct Hasher(foldhash::fast::FoldHasher<'static>);

impl std::fmt::Debug for Hasher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Hasher")
    }
}

impl std::hash::Hasher for Hasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0.finish()
    }
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        self.0.write(bytes);
    }
    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.0.write_u8(i);
    }
    #[inline]
    fn write_u16(&mut self, i: u16) {
        self.0.write_u16(i);
    }
    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.0.write_u32(i);
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.0.write_u64(i);
    }
    #[inline]
    fn write_u128(&mut self, i: u128) {
        self.0.write_u128(i);
    }
    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.0.write_usize(i);
    }
}
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
