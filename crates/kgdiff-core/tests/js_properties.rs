//! Properties of `kgdiff_core::js`, beyond the corpus's primitive vectors: the UTF-16 order of
//! `JsStr`, number formatting checked against exact arithmetic, and the JSON reader fuzzed
//! against serde_json as an oracle (RFC 0002, §4.1: serde_json is a development dependency only).

use std::fmt::Write as _;

use kgdiff_core::js::{self, JsStr, json};
use proptest::prelude::*;

/// `cases` per property, or `PROPTEST_CASES` for a longer run
/// (`PROPTEST_CASES=200000 cargo test --release -p kgdiff-core --test js_properties`).
fn config(cases: u32) -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(cases);
    ProptestConfig {
        cases,
        ..ProptestConfig::default()
    }
}

/// Characters from the ranges where UTF-16 and code point order disagree, and around them.
fn interesting_char() -> impl Strategy<Value = char> {
    prop_oneof![
        prop::char::range('\u{0}', '\u{7F}'),
        prop::char::range('\u{80}', '\u{7FF}'),
        prop::char::range('\u{D000}', '\u{D7FF}'),
        prop::char::range('\u{E000}', '\u{FFFF}'),
        prop::char::range('\u{10000}', '\u{10FFFF}'),
        Just('\u{FEFF}'),
        Just('\u{2028}'),
    ]
}

fn interesting_string() -> impl Strategy<Value = String> {
    prop::collection::vec(interesting_char(), 0..6).prop_map(|chars| chars.into_iter().collect())
}

/// Finite doubles: arbitrary bit patterns, and decimal-looking ones.
fn finite_f64() -> impl Strategy<Value = f64> {
    prop_oneof![
        any::<u64>()
            .prop_map(f64::from_bits)
            .prop_filter("finite", |x| x.is_finite()),
        (0u64..1_000_000_000, -30i32..30).prop_map(|(m, e)| format!("{m}e{e}").parse().unwrap()),
        (-1_000_000i64..1_000_000).prop_map(|n| f64::from(i32::try_from(n).unwrap()) / 1000.0),
    ]
}

/// Doubles below 2⁶⁹ < 1e21 in magnitude (where `toFixed` writes digits rather than
/// `Number::toString`): any sign, biased exponent and fraction bits, and decimal-looking ones.
fn below_1e21() -> impl Strategy<Value = f64> {
    prop_oneof![
        (any::<bool>(), 0u64..1092, 0u64..1 << 52)
            .prop_map(|(sign, exp, frac)| f64::from_bits(u64::from(sign) << 63 | exp << 52 | frac)),
        (0u64..1_000_000_000, -30i32..12).prop_map(|(m, e)| format!("{m}e{e}").parse().unwrap()),
    ]
}

/// `x.toFixed(digits)` from exact integer arithmetic, for |x| < 1e21 and digits ≤ 2.
fn exact_to_fixed(x: f64, digits: u32) -> String {
    let negative = x < 0.0;
    let bits = x.abs().to_bits();
    let (exp_bits, frac) = (
        i32::try_from(bits >> 52).unwrap(),
        u128::from(bits & ((1 << 52) - 1)),
    );
    let (mantissa, exponent) = if exp_bits == 0 {
        (frac, -1074)
    } else {
        (frac | 1 << 52, exp_bits - 1075)
    };
    let scale = 10u128.pow(digits);
    // n = round_half_up(mantissa · 2^exponent · 10^digits)
    let n = if exponent >= 0 {
        (mantissa << exponent) * scale
    } else {
        let shift = u32::try_from(-exponent).unwrap();
        let num = mantissa * scale;
        if shift > 120 {
            0
        } else {
            (num + (1 << (shift - 1))) >> shift
        }
    };
    let mut text = n.to_string();
    let digits = usize::try_from(digits).unwrap();
    if digits > 0 {
        if text.len() <= digits {
            text = format!("{}{text}", "0".repeat(digits + 1 - text.len()));
        }
        text.insert(text.len() - digits, '.');
    }
    if negative { format!("-{text}") } else { text }
}

proptest! {
    #![proptest_config(config(2000))]

    #[test]
    fn jsstr_sorts_as_utf16_code_units(mut strings in prop::collection::vec(interesting_string(), 0..12)) {
        let mut by_units = strings.clone();
        by_units.sort_by_key(|s| s.encode_utf16().collect::<Vec<u16>>());
        let mut by_js: Vec<JsStr> = strings.drain(..).map(JsStr::from).collect();
        by_js.sort();
        let by_js: Vec<&str> = by_js.iter().map(JsStr::as_str).collect();
        prop_assert_eq!(by_js, by_units);
    }

    #[test]
    fn number_to_string_round_trips(x in finite_f64()) {
        let text = js::number_to_string(x);
        let back: f64 = text.parse().unwrap();
        prop_assert!(back == x, "{} → {} → {}", x, text, back);
        let exponential = js::to_exponential(x);
        prop_assert_eq!(exponential.parse::<f64>().unwrap(), x);
        prop_assert_eq!(js::number_from_str(&text), x);
    }

    #[test]
    fn to_fixed_is_exact(x in below_1e21(), digits in 0u8..=2) {
        prop_assert_eq!(js::to_fixed(x, digits), exact_to_fixed(x, u32::from(digits)));
    }

    #[test]
    fn to_uint32_wraps_integers(n in -(1i64 << 53) + 1..(1i64 << 53)) {
        // Exact: |n| < 2^53.
        #[allow(clippy::cast_precision_loss)]
        let x = n as f64;
        let expected = u32::try_from(n.rem_euclid(1 << 32)).unwrap();
        prop_assert_eq!(js::to_uint32(x), expected);
        prop_assert_eq!(js::to_int32(x), i32::from_ne_bytes(expected.to_ne_bytes()));
    }
}

// ─── JSON against serde_json ─────────────────────────────────────────────────

/// A JSON text built from a random tree, with random whitespace, escapes and number spellings.
fn json_text() -> impl Strategy<Value = String> {
    let leaf = prop_oneof![
        Just("null".to_owned()),
        Just("true".to_owned()),
        Just("false".to_owned()),
        finite_f64().prop_map(js::number_to_string),
        (any::<i64>(), 0u8..4).prop_map(|(n, style)| match style {
            0 => n.to_string(),
            1 => format!("{n}.0"),
            2 => format!("{n}e{}", n % 30),
            _ => format!("{}E+{}", n / 7, n.rem_euclid(5)),
        }),
        prop::collection::vec((interesting_char(), 0u8..3), 0..8).prop_map(|chars| {
            let mut s = String::from("\"");
            for (c, style) in chars {
                match (c, style) {
                    ('"' | '\\', _) => write!(s, "\\{c}").unwrap(),
                    (c, _) if u32::from(c) < 0x20 => write!(s, "\\u{:04x}", u32::from(c)).unwrap(),
                    (c, 0) => {
                        let mut units = [0; 2];
                        for unit in c.encode_utf16(&mut units) {
                            write!(s, "\\u{unit:04X}").unwrap();
                        }
                    }
                    (c, _) => s.push(c),
                }
            }
            s.push('"');
            s
        }),
    ];
    leaf.prop_recursive(5, 48, 6, |inner| {
        let space = prop::sample::select(vec!["", "", " ", "\n", "\t ", "\r\n"]);
        prop_oneof![
            (prop::collection::vec((inner.clone(), space.clone()), 0..6)).prop_map(|items| {
                let body: Vec<String> = items
                    .into_iter()
                    .map(|(v, s)| format!("{s}{v}{s}"))
                    .collect();
                format!("[{}]", body.join(","))
            }),
            (prop::collection::vec(
                (
                    prop::sample::select(vec!["a", "b", "10", "2", "__proto__", "01", ""]),
                    inner,
                    space
                ),
                0..6
            ))
            .prop_map(|members| {
                let body: Vec<String> = members
                    .into_iter()
                    .map(|(k, v, s)| format!("{s}\"{k}\"{s}:{v}"))
                    .collect();
                format!("{{{}}}", body.join(","))
            }),
        ]
    })
}

/// A JSON text with one random edit: what both readers must reject or accept alike.
fn mutated_text() -> impl Strategy<Value = String> {
    (
        json_text(),
        any::<prop::sample::Index>(),
        prop::sample::select(vec![
            "", "{", "}", "[", "]", ",", ":", "\"", "\\", "0", "-", "e", ".", " ", "\u{1}", "x",
        ]),
    )
        .prop_map(|(text, at, insert)| {
            let boundaries: Vec<usize> = (0..=text.len())
                .filter(|&i| text.is_char_boundary(i))
                .collect();
            let at = boundaries[at.index(boundaries.len())];
            let mut out = text[..at].to_owned();
            out.push_str(insert);
            // Replace the next character, or insert before it.
            let rest = &text[at..];
            let skip = if insert.is_empty() || insert == "x" {
                rest.chars().next().map_or(0, char::len_utf8)
            } else {
                0
            };
            out.push_str(&rest[skip..]);
            out
        })
}

/// Our value equals serde_json's (numbers numerically, object members by key).
fn same(ours: &js::Value, theirs: &serde_json::Value) -> bool {
    match (ours, theirs) {
        (js::Value::Null, serde_json::Value::Null) => true,
        (js::Value::Bool(a), serde_json::Value::Bool(b)) => a == b,
        (js::Value::Number(a), serde_json::Value::Number(b)) => b.as_f64() == Some(*a),
        (js::Value::String(a), serde_json::Value::String(b)) => a.as_str() == b,
        (js::Value::Array(a), serde_json::Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (js::Value::Object(a), serde_json::Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k.as_str()).is_some_and(|w| same(v, w)))
        }
        _ => false,
    }
}

/// What our reader accepts and serde_json rejects: numbers beyond the double range (serde_json
/// errors, `JSON.parse` gives ±∞, even when a duplicate key later drops the value) and nesting
/// beyond serde_json's limit of 128 levels.
fn beyond_serde_json(error: &serde_json::Error) -> bool {
    let message = error.to_string();
    message.contains("number out of range") || message.contains("recursion limit exceeded")
}

fn agree(text: &str) -> Result<(), TestCaseError> {
    let ours = json::parse(text);
    let theirs = serde_json::from_str::<serde_json::Value>(text);
    match (&ours, &theirs) {
        (Ok(a), Ok(b)) => {
            prop_assert!(same(a, b), "{:?}: {:?} vs {:?}", text, a, b);
            // What we write reads back as the same value, in both readers.
            let written = json::to_string(a);
            prop_assert_eq!(&json::parse(&written).unwrap(), a);
            let reread: serde_json::Value = serde_json::from_str(&written).unwrap();
            prop_assert!(same(a, &reread));
            let pretty = json::to_string_pretty(a);
            prop_assert_eq!(&json::parse(&pretty).unwrap(), a);
        }
        (Err(_), Err(_)) => {}
        (Ok(_), Err(e)) => prop_assert!(
            beyond_serde_json(e),
            "{:?}: accepted, serde_json: {}",
            text,
            e
        ),
        (Err(e), Ok(_)) => {
            prop_assert!(false, "{:?}: rejected ({}), serde_json accepts it", text, e)
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(config(3000))]

    #[test]
    fn json_reads_as_serde_json(text in json_text()) {
        agree(&text)?;
    }

    #[test]
    fn json_rejects_what_serde_json_rejects(text in mutated_text()) {
        agree(&text)?;
    }

    #[test]
    fn json_survives_arbitrary_text(text in "\\PC{0,24}") {
        agree(&text)?;
    }
}
