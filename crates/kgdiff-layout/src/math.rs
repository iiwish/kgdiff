//! Deterministic arithmetic (`math.ts`, RFC 0002 J-32).
//!
//! Every result is built from `+ − × ÷ √`, comparisons and conversions, which IEEE 754 rounds
//! exactly on every target; no transcendental function and no fused multiply-add reach a
//! position. Rounding, minimum and maximum follow JavaScript ([`js::math`]).

use kgdiff_core::js::math as js;

pub(crate) use kgdiff_core::js::math::{log2, max, min, round};

/// `Math.min(max, Math.max(min, value))`.
pub(crate) fn clamp(value: f64, lo: f64, hi: f64) -> f64 {
    js::min(hi, js::max(lo, value))
}

/// Round to 0.01 (the layout's output precision); never returns `-0`.
pub(crate) fn round2(value: f64) -> f64 {
    let rounded = js::round(value * 100.0) / 100.0;
    if rounded == 0.0 { 0.0 } else { rounded }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_to_hundredths_without_negative_zero() {
        assert_eq!(round2(1.234_5), 1.23);
        // Halves round up, as Math.round does (0.125 is exact in binary).
        assert_eq!(round2(0.125), 0.13);
        assert_eq!(round2(-0.125), -0.12);
        assert_eq!(round2(-0.001).to_bits(), 0.0f64.to_bits());
    }
}
