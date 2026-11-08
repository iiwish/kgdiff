//! `Math` functions with JavaScript's results (J-31, J-34, J-36).

/// `Math.round(x)` (J-34): rounds half up, towards +∞ (`-2.5` → `-2`, where `f64::round` gives
/// `-3`), keeps the sign of zero (`Math.round(-0.2)` is `-0`) and is exact for
/// 0.49999999999999994.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let floor = x.floor();
    // Exact: x and floor(x) are within 1 of each other and floor(x) is no finer than x.
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x < 0.0 {
        -0.0
    } else {
        rounded
    }
}

/// `Math.min(a, b)` (J-36): NaN if either is NaN, and `-0` below `0`.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)` (J-36): NaN if either is NaN, and `0` above `-0`.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// The double nearest to ln 2 (`Math.LN2`).
const LN2: f64 = std::f64::consts::LN_2;

/// log₂(x) from exactly rounded operations only, as `log2` of `@kgdiff/core` computes it
/// (`packages/core/src/math.ts`, J-31): the same operations in the same order, so the same bits on
/// every platform. Accurate to ~1e-15 but not correctly rounded; `f64::log2` calls the platform's
/// C library and is not used. -∞ for anything but x > 0 (NaN included), +∞ for +∞.
pub fn log2(x: f64) -> f64 {
    #[allow(
        clippy::neg_cmp_op_on_partial_ord,
        reason = "NaN must take this branch, as in TypeScript"
    )]
    if !(x > 0.0) {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return x;
    }
    // x = m·2^e with m ∈ [1, 2); scaling by 2 is exact.
    let mut m = x;
    let mut e = 0i32;
    while m >= 2.0 {
        m /= 2.0;
        e += 1;
    }
    while m < 1.0 {
        m *= 2.0;
        e -= 1;
    }
    // ln(m) = 2·atanh(s), s = (m − 1)/(m + 1) ∈ [0, 1/3).
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let mut term = s;
    let mut sum = 0.0;
    let mut k = 1.0;
    while k < 40.0 {
        sum += term / k;
        term *= s2;
        k += 2.0;
    }
    f64::from(e) + (2.0 * sum) / LN2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_half_up_and_keeps_negative_zero() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert!(round(-0.2).is_sign_negative());
        assert!(round(-0.5).is_sign_negative());
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(round(4_503_599_627_370_497.0), 4_503_599_627_370_497.0);
    }

    #[test]
    fn min_and_max_follow_javascript() {
        assert!(min(0.0, -0.0).is_sign_negative());
        assert!(min(-0.0, 0.0).is_sign_negative());
        assert!(max(-0.0, 0.0).is_sign_positive());
        assert!(max(0.0, -0.0).is_sign_positive());
        assert!(min(f64::NAN, 1.0).is_nan());
        assert!(max(1.0, f64::NAN).is_nan());
    }

    #[test]
    fn log2_of_powers_of_two_is_exact() {
        assert_eq!(log2(1.0), 0.0);
        assert_eq!(log2(1024.0), 10.0);
        assert_eq!(log2(0.5), -1.0);
        assert_eq!(log2(0.0), f64::NEG_INFINITY);
        assert_eq!(log2(f64::NAN), f64::NEG_INFINITY);
    }
}
