//! Numbers to text and back as JavaScript converts them (J-01, J-03, J-06, J-07, J-35).

use super::string::trim;

/// `Number::toString(x)` (ECMAScript), what `String(x)`, template literals and `JSON.stringify`
/// write: the shortest digits that round-trip, plain notation for 1e-7 ≤ |x| < 1e21 (`1`, not
/// `1.0`; `100000000000000000000`; `0.000001`), exponents otherwise (`1e+21`, `1e-7`), `0` for
/// `-0`, and `NaN`, `Infinity`, `-Infinity`.
pub fn number_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_owned()
}

/// A buffer for [`number_to_string`] without an allocation per number.
pub struct NumberText(ryu_js::Buffer);

impl NumberText {
    pub fn new() -> NumberText {
        NumberText(ryu_js::Buffer::new())
    }

    /// `Number::toString(x)`, in the buffer.
    pub fn format(&mut self, x: f64) -> &str {
        self.0.format(x)
    }
}

impl Default for NumberText {
    fn default() -> NumberText {
        NumberText::new()
    }
}

/// Appends [`number_to_string`] of `x` to `out`.
pub fn push_number(out: &mut String, x: f64) {
    out.push_str(ryu_js::Buffer::new().format(x));
}

/// `x.toFixed(digits)` for `digits` in 0…100 (ECMAScript `Number.prototype.toFixed`): the digits
/// of the exact binary value, a tie rounded away from zero (`(0.25).toFixed(1)` is `0.3`,
/// `(1.005).toFixed(2)` is `1.00`), `-0` written `0`, and `Number::toString` from 1e21 on.
///
/// # Panics
///
/// When `digits` is greater than 100, where JavaScript throws a `RangeError`.
pub fn to_fixed(x: f64, digits: u8) -> String {
    assert!(digits <= 100, "toFixed() digits must be between 0 and 100");
    ryu_js::Buffer::new().format_to_fixed(x, digits).to_owned()
}

/// `x.toExponential()` without an argument: the shortest digits that round-trip, one before
/// the point, and an exponent with its sign (`1.1e+0`, `1e-7`, `0e+0`).
pub fn to_exponential(x: f64) -> String {
    if !x.is_finite() {
        return number_to_string(x);
    }
    // The shortest digits are those of Number::toString; only their layout differs.
    let text = number_to_string(x);
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.as_str()),
    };
    let (mantissa, exponent) = match text.split_once('e') {
        Some((m, e)) => (m, e.parse::<i32>().unwrap_or(0)),
        None => (text, 0),
    };
    // Digits of the mantissa without the point, and where the point was.
    let (int_part, frac_part) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits: String = format!("{int_part}{frac_part}");
    let mut point = i32::try_from(int_part.len()).unwrap_or(i32::MAX);
    let leading = digits.len() - digits.trim_start_matches('0').len();
    if leading == digits.len() {
        // Zero (Number::toString writes -0 as 0, and so does toExponential).
        return "0e+0".to_owned();
    }
    digits.drain(..leading);
    point -= i32::try_from(leading).unwrap_or(i32::MAX);
    let trailing = digits.len() - digits.trim_end_matches('0').len();
    digits.truncate(digits.len() - trailing);
    let e = exponent + point - 1;
    let mut out = String::with_capacity(digits.len() + 8);
    if negative {
        out.push('-');
    }
    out.push_str(&digits[..1]);
    if digits.len() > 1 {
        out.push('.');
        out.push_str(&digits[1..]);
    }
    out.push('e');
    out.push(if e < 0 { '-' } else { '+' });
    out.push_str(&e.unsigned_abs().to_string());
    out
}

/// `Number(text)`: ECMAScript's StringToNumber (J-07). JavaScript whitespace around the number is
/// ignored, empty text is 0, `0x` / `0o` / `0b` prefixes read integers in base 16, 8 and 2,
/// `Infinity` may carry a sign, and everything else that is not a decimal literal is NaN
/// (`inf`, `1_0`, `1,5`, fullwidth digits).
pub fn number_from_str(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let bytes = text.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return non_decimal_integer(&text[2..], radix);
        }
    }
    let (sign, unsigned) = match bytes[0] {
        b'+' => (1.0, &text[1..]),
        b'-' => (-1.0, &text[1..]),
        _ => (1.0, text),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(unsigned.as_bytes()) {
        return f64::NAN;
    }
    // A valid StrUnsignedDecimalLiteral is a literal Rust's correctly rounded parser accepts.
    unsigned.parse::<f64>().map_or(f64::NAN, |x| sign * x)
}

/// StrUnsignedDecimalLiteral without `Infinity`: `1`, `1.`, `.5`, `1.5e-3`, `1E3`.
fn is_decimal_literal(s: &[u8]) -> bool {
    let digits = |s: &[u8], at: usize| s[at..].iter().take_while(|b| b.is_ascii_digit()).count();
    let mut at = digits(s, 0);
    let mut any = at > 0;
    if s.get(at) == Some(&b'.') {
        let frac = digits(s, at + 1);
        any |= frac > 0;
        at += 1 + frac;
    }
    if !any {
        return false;
    }
    if matches!(s.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(s.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exp = digits(s, at);
        if exp == 0 {
            return false;
        }
        at += exp;
    }
    at == s.len()
}

/// The mathematical value of digits in base 2, 8 or 16, rounded to the nearest double (ties to
/// even); NaN when there is no digit or a character is not a digit of the base.
fn non_decimal_integer(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    // The value as a bit string, most significant first.
    let bits_per_digit = radix.trailing_zeros();
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * 4);
    for c in digits.chars() {
        let Some(d) = c.to_digit(radix) else {
            return f64::NAN;
        };
        for i in (0..bits_per_digit).rev() {
            bits.push((d >> i) & 1 == 1);
        }
    }
    let first = match bits.iter().position(|&b| b) {
        Some(first) => first,
        None => return 0.0,
    };
    let bits = &bits[first..];
    if bits.len() > 1024 {
        return f64::INFINITY;
    }
    if bits.len() <= 53 {
        let mut value = 0u64;
        for &b in bits {
            value = value << 1 | u64::from(b);
        }
        return u53_to_f64(value);
    }
    // Keep 53 significant bits, round to nearest, ties to even.
    let mut mantissa = 0u64;
    for &b in &bits[..53] {
        mantissa = mantissa << 1 | u64::from(b);
    }
    let half = bits[53];
    let sticky = bits[54..].iter().any(|&b| b);
    if half && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let mut exponent = i32::try_from(bits.len() - 53).unwrap_or(i32::MAX);
    if mantissa == 1 << 53 {
        mantissa >>= 1;
        exponent += 1;
    }
    let mut x = u53_to_f64(mantissa);
    // Scaling by two is exact.
    for _ in 0..exponent {
        x *= 2.0;
    }
    x
}

/// An integer below 2⁵³ as a double (exact).
#[allow(clippy::cast_precision_loss, reason = "the value has at most 53 bits")]
fn u53_to_f64(value: u64) -> f64 {
    debug_assert!(value < 1 << 53);
    value as f64
}

/// `ToUint32(x)`, what `x >>> 0` computes (J-35): NaN and ±∞ are 0, other values are truncated
/// towards zero and wrapped modulo 2³² (`-1` → 4294967295, `1e20` → 1661992960). `as u32`
/// saturates instead.
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    // Both steps are exact: trunc of a double, and the remainder of an integer-valued double.
    let wrapped = x.trunc().rem_euclid(4_294_967_296.0);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "wrapped is an integer in [0, 2^32)"
    )]
    let value = wrapped as u32;
    value
}

/// `ToInt32(x)`, what `x | 0` computes (J-35): [`to_uint32`] read as two's complement.
pub fn to_int32(x: f64) -> i32 {
    i32::from_ne_bytes(to_uint32(x).to_ne_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_as_javascript() {
        assert_eq!(number_to_string(1.0), "1");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1e20), "100000000000000000000");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(0.000_001), "0.000001");
        assert_eq!(to_exponential(1.1), "1.1e+0");
        assert_eq!(to_exponential(-0.0), "0e+0");
        assert_eq!(to_exponential(1e-7), "1e-7");
        assert_eq!(to_exponential(123_000.0), "1.23e+5");
        assert_eq!(to_exponential(0.001_25), "1.25e-3");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(-0.000_1, 2), "-0.00");
    }

    #[test]
    fn reads_numbers_as_javascript() {
        assert_eq!(number_from_str(" 0x1F "), 31.0);
        assert_eq!(number_from_str("-Infinity"), f64::NEG_INFINITY);
        assert!(number_from_str("-0x1").is_nan());
        assert!(number_from_str("inf").is_nan());
        assert!(number_from_str("1e").is_nan());
        assert_eq!(number_from_str("0x20000000000001"), 9_007_199_254_740_992.0);
        assert_eq!(number_from_str("0x20000000000003"), 9_007_199_254_740_996.0);
        assert_eq!(to_uint32(-1.0), u32::MAX);
        assert_eq!(to_uint32(1e20), 1_661_992_960);
        assert_eq!(to_int32(4_294_967_295.0), -1);
    }
}
