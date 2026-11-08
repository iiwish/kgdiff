//! The primitive vectors (`conformance/primitives/`, README "Primitive vectors") against
//! `kgdiff_core::js`.

use kgdiff_core::js::{self, JsStr, json};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::corpus::{Corpus, read_json};

type Outcome = Result<usize, Vec<String>>;

/// A double from 16 hex digits of its IEEE 754 bits.
fn from_bits(bits: &Value) -> Result<f64, String> {
    let text = bits
        .as_str()
        .ok_or_else(|| format!("{bits} is not a bits string"))?;
    u64::from_str_radix(text, 16)
        .map(f64::from_bits)
        .map_err(|e| format!("{text}: {e}"))
}

fn bits(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

fn entries<'a>(vector: &'a Value, key: &str) -> Result<&'a [Value], Vec<String>> {
    vector[key]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| vec![format!("no {key:?} list")])
}

/// Runs `check` on every entry; `Ok` with the count when all pass.
fn each(items: &[Value], mut check: impl FnMut(&Value) -> Result<(), String>) -> Outcome {
    let failures: Vec<String> = items.iter().filter_map(|item| check(item).err()).collect();
    if failures.is_empty() {
        Ok(items.len())
    } else {
        Err(failures)
    }
}

fn expect_eq(what: &str, input: &str, actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "{what}({input}) = {actual:?}, expected {expected:?}"
        ))
    }
}

fn load(corpus: &Corpus, file: &str) -> Result<Value, Vec<String>> {
    read_json(&corpus.root.join(file)).map_err(|e| vec![e])
}

pub fn number_to_string(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    each(entries(&vector, "entries")?, |entry| {
        let x = from_bits(&entry["bits"])?;
        let input = entry["bits"].as_str().unwrap_or_default();
        expect_eq(
            "String",
            input,
            &js::number_to_string(x),
            entry["string"].as_str().unwrap_or_default(),
        )?;
        expect_eq(
            "JSON.stringify",
            input,
            &json::to_string(&js::Value::Number(x)),
            entry["json"].as_str().unwrap_or_default(),
        )?;
        expect_eq(
            "toExponential",
            input,
            &js::to_exponential(x),
            entry["exponential"].as_str().unwrap_or_default(),
        )?;
        for (digits, expected) in entry["fixed"].as_array().into_iter().flatten().enumerate() {
            let digits = u8::try_from(digits).unwrap_or(u8::MAX);
            expect_eq(
                &format!("toFixed[{digits}]"),
                input,
                &js::to_fixed(x, digits),
                expected.as_str().unwrap_or_default(),
            )?;
        }
        Ok(())
    })
}

pub fn number_from_string(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    each(entries(&vector, "entries")?, |entry| {
        let text = entry["text"].as_str().ok_or("an entry without text")?;
        let number = js::number_from_str(text);
        let expected = &entry["number"];
        let ok = if expected == "NaN" {
            number.is_nan()
        } else {
            number.to_bits() == from_bits(expected)?.to_bits()
        };
        if !ok {
            return Err(format!(
                "Number({text:?}) = {}, expected {expected}",
                bits(number)
            ));
        }
        let parsed = json::parse(text).ok().and_then(|v| v.as_f64());
        let expected = match &entry["json"] {
            Value::Null => None,
            b => Some(from_bits(b)?),
        };
        if parsed.map(f64::to_bits) != expected.map(f64::to_bits) {
            return Err(format!(
                "JSON.parse({text:?}) = {:?}, expected {:?}",
                parsed.map(bits),
                expected.map(bits)
            ));
        }
        Ok(())
    })
}

pub fn js_math(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    let mut count = 0;
    let mut failures = Vec::new();
    let mut tally = |outcome: Outcome| match outcome {
        Ok(n) => count += n,
        Err(f) => failures.extend(f),
    };
    tally(each(entries(&vector, "round")?, |pair| {
        let (x, expected) = (from_bits(&pair[0])?, from_bits(&pair[1])?);
        let actual = js::math::round(x);
        let same = actual.to_bits() == expected.to_bits() || (actual.is_nan() && expected.is_nan());
        if same {
            Ok(())
        } else {
            Err(format!(
                "Math.round({}) = {}, expected {}",
                bits(x),
                bits(actual),
                bits(expected)
            ))
        }
    }));
    for (key, convert) in [
        (
            "toUint32",
            (|x| f64::from(js::to_uint32(x))) as fn(f64) -> f64,
        ),
        ("toInt32", |x| f64::from(js::to_int32(x))),
    ] {
        tally(each(entries(&vector, key)?, |pair| {
            let x = from_bits(&pair[0])?;
            let expected = pair[1].as_f64().ok_or("not a number")?;
            let actual = convert(x);
            if actual == expected {
                Ok(())
            } else {
                Err(format!(
                    "{key}({}) = {actual}, expected {expected}",
                    bits(x)
                ))
            }
        }));
    }
    if failures.is_empty() {
        Ok(count)
    } else {
        Err(failures)
    }
}

pub fn log2(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    let mut failures = Vec::new();
    let explicit = entries(&vector, "explicit")?;
    let special = entries(&vector, "special")?;
    for pair in explicit {
        let n = pair[0].as_f64().unwrap_or(f64::NAN);
        match from_bits(&pair[1]) {
            Ok(expected) if js::math::log2(n).to_bits() == expected.to_bits() => {}
            Ok(expected) => failures.push(format!(
                "log2({n}) = {}, expected {}",
                bits(js::math::log2(n)),
                bits(expected)
            )),
            Err(e) => failures.push(e),
        }
    }
    for pair in special {
        match (from_bits(&pair[0]), from_bits(&pair[1])) {
            (Ok(x), Ok(expected)) if js::math::log2(x).to_bits() == expected.to_bits() => {}
            (Ok(x), Ok(expected)) => failures.push(format!(
                "log2({}) = {}, expected {}",
                bits(x),
                bits(js::math::log2(x)),
                bits(expected)
            )),
            (Err(e), _) | (_, Err(e)) => failures.push(e),
        }
    }
    let digest = &vector["digest"];
    let (from, to) = (
        digest["from"].as_u64().unwrap_or(1),
        digest["to"].as_u64().unwrap_or(0),
    );
    if digest["encoding"] != "float64-le" {
        failures.push(format!("unknown digest encoding {}", digest["encoding"]));
    }
    let mut sha = Sha256::new();
    for n in from..=to {
        let n = u32::try_from(n).map(f64::from).unwrap_or(f64::NAN);
        sha.update(js::math::log2(n).to_le_bytes());
    }
    let actual: String = sha.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest["sha256"] != actual.as_str() {
        failures.push(format!(
            "SHA-256 of log2({from}…{to}) is {actual}, expected {}",
            digest["sha256"]
        ));
    }
    if failures.is_empty() {
        Ok(explicit.len() + special.len() + 1)
    } else {
        Err(failures)
    }
}

pub fn string_order(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    let sorted: Vec<JsStr> = entries(&vector, "sorted")?
        .iter()
        .map(|s| JsStr::from(s.as_str().unwrap_or_default()))
        .collect();
    let mut failures = Vec::new();
    for pair in sorted.windows(2) {
        if pair[0] > pair[1] {
            failures.push(format!("{:?} sorts after {:?}", pair[0], pair[1]));
        }
    }
    // Sorting any permutation gives the vector's order.
    let mut shuffled: Vec<JsStr> = sorted.iter().rev().cloned().collect();
    shuffled.rotate_left(sorted.len() / 3);
    shuffled.sort();
    if shuffled != sorted {
        failures.push("sorting a permutation does not give the vector's order".to_owned());
    }
    if failures.is_empty() {
        Ok(sorted.len())
    } else {
        Err(failures)
    }
}

pub fn json_roundtrip(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    each(entries(&vector, "entries")?, |entry| {
        let text = entry["text"].as_str().ok_or("an entry without text")?;
        let parsed = json::parse(text).ok();
        for (key, write) in [
            ("stringify", json::to_string as fn(&js::Value) -> String),
            ("pretty", json::to_string_pretty),
        ] {
            let actual = parsed.as_ref().map(write);
            let expected = entry[key].as_str();
            if actual.as_deref() != expected {
                return Err(format!(
                    "{key}({text:?}) = {actual:?}, expected {expected:?}"
                ));
            }
        }
        Ok(())
    })
}

pub fn predicate_label(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    each(entries(&vector, "pairs")?, |pair| {
        let predicate = pair[0].as_str().ok_or("a pair without a predicate")?;
        let expected = pair[1].as_str().ok_or("a pair without a label")?;
        expect_eq(
            "predicateLabel",
            predicate,
            &kgdiff_core::text::predicate_label(predicate),
            expected,
        )
    })
}

pub fn text_similarity(corpus: &Corpus, file: &str) -> Outcome {
    let vector = load(corpus, file)?;
    each(entries(&vector, "pairs")?, |pair| {
        let (a, b) = (
            pair[0].as_str().unwrap_or_default(),
            pair[1].as_str().unwrap_or_default(),
        );
        let expected = pair[2].as_f64().ok_or("a pair without a similarity")?;
        let actual = kgdiff_core::text::text_similarity(a, b);
        if actual.to_bits() == expected.to_bits() {
            Ok(())
        } else {
            Err(format!(
                "textSimilarity({a:?}, {b:?}) = {actual}, expected {expected}"
            ))
        }
    })
}

pub fn facet_labels(corpus: &Corpus, file: &str) -> Outcome {
    use kgdiff_core::model::FacetKind;
    // Read with kgdiff's own reader, which keeps the order of the keys (serde_json sorts them).
    let text = std::fs::read_to_string(corpus.root.join(file)).map_err(|e| vec![e.to_string()])?;
    let vector = json::parse(&text).map_err(|e| vec![e.to_string()])?;
    let mut count = 0;
    let mut failures = Vec::new();
    for locale in [kgdiff_core::Locale::En, kgdiff_core::Locale::ZhCn] {
        let labels = vector
            .get("labels")
            .and_then(|l| l.get(locale.as_str()))
            .and_then(js::Value::as_object)
            .ok_or_else(|| vec![format!("no labels for {}", locale.as_str())])?;
        let kinds: Vec<&str> = labels.keys().map(JsStr::as_str).collect();
        let expected_order: Vec<&str> = FacetKind::ALL.iter().map(|k| k.as_str()).collect();
        if kinds != expected_order {
            failures.push(format!(
                "{}: facet kinds {kinds:?}, expected the canonical order {expected_order:?}",
                locale.as_str()
            ));
        }
        for (kind, label) in labels {
            count += 1;
            let Some(k) = FacetKind::from_name(kind) else {
                failures.push(format!("unknown facet kind {kind}"));
                continue;
            };
            let actual = kgdiff_core::facet_label(k, locale);
            if Some(actual) != label.as_str() {
                failures.push(format!(
                    "facetLabel({kind}, {}) = {actual:?}, expected {label:?}",
                    locale.as_str()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(count)
    } else {
        Err(failures)
    }
}
