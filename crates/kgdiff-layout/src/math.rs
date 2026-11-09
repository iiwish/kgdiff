//! Deterministic arithmetic (`math.ts`, RFC 0002 J-32).
//!
//! Every result is built from `+ − × ÷ √`, comparisons and conversions, which IEEE 754 rounds
//! exactly on every target; no transcendental function and no fused multiply-add reach a
//! position. Rounding, minimum and maximum follow JavaScript ([`js::math`]).

use std::cmp::Ordering;

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

/// bⁿ for an integer n ≥ 0 by repeated squaring (a fixed sequence of exact operations).
pub(crate) fn pow_int(base: f64, exponent: u64) -> f64 {
    let mut result = 1.0;
    let mut b = base;
    let mut n = exponent;
    while n > 0 {
        if n & 1 == 1 {
            result *= b;
        }
        b *= b;
        n >>= 1;
    }
    result
}

/// The per-tick factor `r` with `r^ticks = ratio` (ratio ∈ (0, 1]), found by bisection over
/// [`pow_int`] so that it is the same everywhere. The alpha cooling schedule.
pub(crate) fn cooling_factor(ratio: f64, ticks: u64) -> f64 {
    if ticks == 0 || ratio >= 1.0 {
        return 1.0;
    }
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..64 {
        let mid = (lo + hi) / 2.0;
        if pow_int(mid, ticks) < ratio {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

/// A monotonic stand-in for the polar angle of (x, y), in [0, 4): sorting by it equals sorting
/// by `atan2`, without a transcendental function.
pub(crate) fn pseudo_angle(x: f64, y: f64) -> f64 {
    let d = x.abs() + y.abs();
    if d == 0.0 {
        return 0.0;
    }
    let p = x / d;
    if y >= 0.0 { 1.0 - p } else { 3.0 + p }
}

/// The shortest distance between two pseudo-angles on the [0, 4) circle.
pub(crate) fn pseudo_angle_distance(a: f64, b: f64) -> f64 {
    let d = (a - b).abs();
    if d > 2.0 { 4.0 - d } else { d }
}

/// The order a JavaScript comparator `a - b` gives two numbers: `Equal` when they are equal
/// (`0` and `-0` included) or either is NaN, so that a stable sort keeps them in place.
pub(crate) fn cmp_f64(a: f64, b: f64) -> Ordering {
    if a < b {
        Ordering::Less
    } else if a > b {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
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

    #[test]
    fn powers_and_cooling_are_exact_sequences() {
        assert_eq!(pow_int(2.0, 10), 1024.0);
        assert_eq!(pow_int(0.5, 0), 1.0);
        let r = cooling_factor(0.001, 300);
        assert!((pow_int(r, 300) - 0.001).abs() < 1e-15);
        assert_eq!(cooling_factor(0.5, 0), 1.0);
        assert_eq!(cooling_factor(1.0, 10), 1.0);
    }

    #[test]
    fn pseudo_angles_order_like_angles() {
        let points = [(1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)];
        let angles: Vec<f64> = points.iter().map(|&(x, y)| pseudo_angle(x, y)).collect();
        // Clockwise from +x in y-down screen space: 0 at (1, 0), increasing through +y.
        assert_eq!(angles, [0.0, 0.5, 1.0, 2.0, 3.0]);
        assert!((pseudo_angle_distance(0.1, 3.9) - 0.2).abs() < 1e-12);
        assert_eq!(pseudo_angle_distance(1.0, 2.5), 1.5);
    }
}
