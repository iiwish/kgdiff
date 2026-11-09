//! Seeded randomness (`prng.ts`, RFC 0002 §3 rule 4, J-13, J-35, J-37).
//!
//! The layout never reads a clock or the operating system's randomness: every random choice
//! comes from a mulberry32 stream, and per-node choices from a stream seeded by a hash of the
//! node id, so that they do not depend on processing order. The arithmetic is TypeScript's,
//! bit for bit: `u32` wrapping operations (`Math.imul`, `>>> 0`) over UTF-16 code units.

use kgdiff_core::js::{number_to_string, to_uint32};

/// mulberry32: uniform doubles in [0, 1) from a 32-bit state.
#[derive(Clone, Debug)]
pub(crate) struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub(crate) fn new(seed: u32) -> Mulberry32 {
        Mulberry32 { state: seed }
    }

    /// The next double in [0, 1), a multiple of 2⁻³².
    pub(crate) fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

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

/// A stream that depends only on the layout seed and one node id.
pub(crate) fn node_random(seed: u32, id: &str) -> Mulberry32 {
    Mulberry32::new(hash_string(id, seed))
}

/// A uniformly random unit vector without trigonometry (rejection sampling in the unit disc).
pub(crate) fn random_direction(random: &mut Mulberry32) -> (f64, f64) {
    for _ in 0..32 {
        let x = random.next_f64() * 2.0 - 1.0;
        let y = random.next_f64() * 2.0 - 1.0;
        let d2 = x * x + y * y;
        if d2 > 1e-4 && d2 <= 1.0 {
            let d = d2.sqrt();
            return (x / d, y / d);
        }
    }
    (1.0, 0.0)
}

/// d3-force's `jiggle`: a tiny random offset for coincident points.
pub(crate) fn jiggle(random: &mut Mulberry32) -> f64 {
    (random.next_f64() - 0.5) * 1e-6
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values computed with `packages/layout/src/prng.ts` in Node.
    #[test]
    fn matches_the_typescript_streams() {
        let mut random = Mulberry32::new(1);
        let first: Vec<f64> = (0..3).map(|_| random.next_f64()).collect();
        assert_eq!(
            first,
            [
                0.627_073_940_588_161_3,
                0.002_735_721_180_215_478,
                0.527_447_039_959_952_2
            ]
        );
        assert_eq!(hash_string("", 0), 2_872_998_923);
        assert_eq!(hash_string("t0001", 1), 4_068_949_415);
        assert_eq!(hash_string("😀中", 7), 4_219_183_475);
        assert_eq!(seed_state(-1.0), 4_294_967_295);
        assert_eq!(seed_state(1e20), 1_661_992_960);
        assert_eq!(seed_state(0.5), hash_string("0.5", 0));
        assert_eq!(seed_state(0.5), 579_616_613);
    }
}
