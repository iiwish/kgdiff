//! What JavaScript does implicitly, done explicitly (RFC 0002, §4).
//!
//! The TypeScript implementation's results depend on JavaScript's built-ins: how numbers become
//! text, how strings order, which keys an object enumerates first, what `trim` removes, how
//! `Math.round` rounds. This module reproduces each of them, and nothing else in the Rust code
//! formats numbers, compares strings or orders object keys on its own:
//!
//! | JavaScript                                    | Here                                       |
//! | --------------------------------------------- | ------------------------------------------ |
//! | `a < b`, `.sort()` on strings (J-11)          | [`JsStr`] (its `Ord`), [`cmp_utf16`]       |
//! | `.length` (J-12)                              | [`utf16_len`]                              |
//! | `trim`, `\s` (J-17)                           | [`trim`], [`is_whitespace`]                |
//! | `String(x)`, `toFixed`, `toExponential` (J-01, J-03, J-06) | [`number_to_string`], [`to_fixed`], [`to_exponential`] |
//! | `Number(text)` (J-07)                         | [`number_from_str`]                        |
//! | `x >>> 0`, `x \| 0` (J-35)                    | [`to_uint32`], [`to_int32`]                |
//! | `Math.round`, `min`, `max`, kgdiff's `log2` (J-31, J-34, J-36) | [`math`]                  |
//! | object key order (J-21, J-23, J-24)           | [`Object`]                                 |
//! | `JSON.parse`, `JSON.stringify` (J-02, J-04, J-05) | [`json`], [`Value`]                    |
//! | `Map` / `Set` lookups (§3 rule 1)             | [`Lookup`]                                 |

pub mod json;
mod lookup;
pub mod math;
mod number;
mod object;
mod string;
mod value;

pub use lookup::Lookup;
pub use number::{
    number_from_str, number_to_string, push_number, to_exponential, to_fixed, to_int32, to_uint32,
};
pub use object::{Object, array_index};
pub use string::{JsStr, cmp_utf16, is_whitespace, trim, trim_end, trim_start, utf16_len};
pub use value::Value;
