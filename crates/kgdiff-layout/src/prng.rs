//! Seeded randomness (`prng.ts`, RFC 0002 §3 rule 4, J-13, J-35, J-37).
//!
//! The layout never reads a clock or the operating system's randomness: every random choice
//! comes from a mulberry32 stream, and per-node choices from a stream seeded by a hash of the
//! node id, so that they do not depend on processing order. The arithmetic is TypeScript's,
//! bit for bit: `u32` wrapping operations (`Math.imul`, `>>> 0`) over UTF-16 code units.

use kgdiff_core::js::{number_to_string, to_uint32};

/// FNV-1a over the UTF-16 code units of `text`, mixed with `salt`, then murmur3's fmix32 so that
/// similar ids give unrelated streams.
pub(crate) fn hash_string(text: &str, salt: u32) -> u32 {
    let mut hash = 0x811c_9dc5 ^ salt;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85eb_ca6b);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(0xc2b2_ae35);
    hash ^= hash >> 16;
    hash
}

/// The 32-bit state of a finite seed: an integer maps by `ToUint32` (`-1` → 4294967295), any
/// other number by the hash of its JavaScript text (`0.5` → `hash_string("0.5")`).
pub(crate) fn seed_state(seed: f64) -> u32 {
    if seed.is_finite() && seed.trunc() == seed {
        to_uint32(seed)
    } else {
        hash_string(&number_to_string(seed), 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values computed with `packages/layout/src/prng.ts` in Node.
    #[test]
    fn matches_the_typescript_streams() {
        assert_eq!(hash_string("", 0), 2_872_998_923);
        assert_eq!(hash_string("t0001", 1), 4_068_949_415);
        assert_eq!(hash_string("😀中", 7), 4_219_183_475);
        assert_eq!(seed_state(-1.0), 4_294_967_295);
        assert_eq!(seed_state(1e20), 1_661_992_960);
        assert_eq!(seed_state(0.5), hash_string("0.5", 0));
        assert_eq!(seed_state(0.5), 579_616_613);
    }
}
