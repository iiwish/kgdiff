//! The primitive vectors (README, "Primitive vectors").
//!
//! Two kinds. The vectors of kgdiff's own functions — `log2`, `textSimilarity`, `predicateLabel`,
//! `estimateLabelWidth` / `nodeRadius` and `facetLabel` — are generated here from the inputs
//! below. The vectors of JavaScript built-ins — `String(x)` and friends, `Number(text)`,
//! `Math.round` / `ToUint32` / `ToInt32`, the default sort order and `JSON.parse` /
//! `JSON.stringify` — were computed by V8 and are fixed reference data: the generator does not
//! write them, and `cargo test -p kgdiff-core --test conformance` checks the Rust implementation
//! against them.

use kgdiff_core::js::{self, Object, Value, json};
use kgdiff_core::model::FacetKind;
use kgdiff_core::{Locale, facet_label};
use kgdiff_layout::{estimate_label_width, node_radius};
use sha2::{Digest as _, Sha256};

use super::pretty;

/// Every primitive vector in manifest order, and whether the generator writes it.
pub const VECTORS: &[(&str, Kind)] = &[
    ("number-to-string.json", Kind::Fixed),
    ("number-from-string.json", Kind::Fixed),
    ("js-math.json", Kind::Fixed),
    ("log2.json", Kind::Generated),
    ("string-order.json", Kind::Fixed),
    ("json-roundtrip.json", Kind::Fixed),
    ("text-similarity.json", Kind::Generated),
    ("predicate-label.json", Kind::Generated),
    ("label-width.json", Kind::Generated),
    ("facet-labels.json", Kind::Generated),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// Reference data computed by a JavaScript engine, kept as committed.
    Fixed,
    /// Written by the generator.
    Generated,
}

/// The generated vectors, by file name.
pub fn generate() -> Vec<(&'static str, String)> {
    vec![
        ("log2.json", log2()),
        ("text-similarity.json", text_similarity()),
        ("predicate-label.json", predicate_label()),
        ("label-width.json", label_width()),
        ("facet-labels.json", facet_labels()),
    ]
}

/// IEEE 754 bits of a double, as 16 hex digits (big-endian).
fn bits(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

/// A JSON object with one array item per line: readable, and diffs stay small.
fn lines(record: &[(&str, Value)]) -> String {
    let parts: Vec<String> = record
        .iter()
        .map(|(key, value)| {
            let mut head = String::from("  ");
            json::push_string(&mut head, key);
            head.push_str(": ");
            match value {
                Value::Array(items) if !items.is_empty() => {
                    let items: Vec<String> = items
                        .iter()
                        .map(|item| format!("    {}", json::to_string(item)))
                        .collect();
                    format!("{head}[\n{}\n  ]", items.join(",\n"))
                }
                other => head + &json::to_string(other),
            }
        })
        .collect();
    format!("{{\n{}\n}}\n", parts.join(",\n"))
}

fn row(items: Vec<Value>) -> Value {
    Value::Array(items)
}

// ─── log2 ────────────────────────────────────────────────────────────────────

const LOG2_DESCRIPTION: &str = "log2 of @kgdiff/core, which core's matching uses on integers ≥ 1 (1 / log2(2 + degree), 1 / log2(1 + postings)) and the layout on integers ≥ 1 (iterations, link distances). It is built from exactly rounded operations, so it gives the same bits everywhere, but it is not correctly rounded: it differs from V8's Math.log2 by one ulp on 102,219 of the integers up to 2^22 (the first is 3), so only the same operations in the same order reproduce it. For x > 0 and finite: m = x, e = 0; while m >= 2 { m /= 2; e += 1 }; while m < 1 { m *= 2; e -= 1 }; s = (m - 1) / (m + 1); s2 = s * s; term = s; sum = 0; for k = 1, 3, 5, …, 39 { sum += term / k; term *= s2 }; result e + (2 * sum) / LN2, with LN2 the double 3fe62e42fefa39ef. Not x > 0 (0, -0, negative, NaN) → -Infinity; +Infinity → +Infinity. `explicit`: [n, bits]. `special`: [bits of x, bits of log2(x)]. `digest`: SHA-256 of the little-endian float64 values of log2(n) for n = from…to, concatenated.";

/// The first 64 of the 439 integers in 1…2·10⁶ whose log₂ Apple's libm rounds differently from
/// V8 (found by comparing the two; every C library has such inputs). Kept as hard inputs for a
/// port that calls a C library's log₂ instead of repeating `log2`'s operations.
const HARD_LOG2: &[f64] = &[1375.0, 2750.0, 3393.0, 5500.0, 5755.0, 6131.0, 6351.0, 6786.0, 7957.0, 11000.0, 11219.0, 11443.0, 11510.0, 12043.0, 12262.0, 12702.0, 13572.0, 13735.0, 15914.0, 18817.0, 21099.0, 21703.0, 22000.0, 22438.0, 22886.0, 23020.0, 24086.0, 24524.0, 25309.0, 25404.0, 27144.0, 27470.0, 31828.0, 37634.0, 39493.0, 42198.0, 43406.0, 44000.0, 44876.0, 45477.0, 45772.0, 46040.0, 46581.0, 48172.0, 49048.0, 50618.0, 50808.0, 51651.0, 54288.0, 54940.0, 63656.0, 66683.0, 67359.0, 83743.0, 86015.0, 88424.0, 88632.0, 89516.0, 90727.0, 90768.0, 92078.0, 96143.0, 103485.0, 104703.0];

/// Inputs beyond the integers matching and the layout pass, as bits: the edges of the domain
/// (0, -0, -1, -∞, NaN, +∞), subnormals and the largest double (the scaling loops' longest runs),
/// mantissas next to 1 and 2 (the series' shortest and slowest cases) and a few fractions.
const SPECIAL_LOG2: &[u64] = &[0x0000000000000000, 0x8000000000000000, 0xbff0000000000000, 0xfff0000000000000, 0x7ff8000000000000, 0x7ff0000000000000, 0x0000000000000001, 0x0010000000000000, 0x001fffffffffffff, 0x7fefffffffffffff, 0x3ff0000000000001, 0x3fffffffffffffff, 0x3fe0000000000000, 0x3fe8000000000000, 0x3ff8000000000000, 0x3f50624dd2f1a9fc, 0x3fb999999999999a, 0x401e000000000000, 0x40fe240c9fbe76c9, 0x4340000000000001, 0x7e37e43c8800759c];

/// log2 is evaluated up to here for the digest.
const LOG2_DIGEST_TO: u32 = 1 << 22;

fn log2() -> String {
    let mut explicit = Vec::new();
    let integers = (1..=1024u32).map(f64::from).chain(HARD_LOG2.iter().copied());
    for n in integers {
        explicit.push(row(vec![n.into(), bits(js::math::log2(n)).into()]));
    }
    let special = SPECIAL_LOG2
        .iter()
        .map(|&b| {
            let x = f64::from_bits(b);
            row(vec![bits(x).into(), bits(js::math::log2(x)).into()])
        })
        .collect();
    let mut hasher = Sha256::new();
    for n in 1..=LOG2_DIGEST_TO {
        hasher.update(js::math::log2(f64::from(n)).to_le_bytes());
    }
    let sha256: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut digest = Object::new();
    digest.insert("from", 1);
    digest.insert("to", LOG2_DIGEST_TO);
    digest.insert("encoding", "float64-le");
    digest.insert("sha256", sha256);
    lines(&[
        ("description", LOG2_DESCRIPTION.into()),
        ("explicit", Value::Array(explicit)),
        ("special", Value::Array(special)),
        ("digest", Value::Object(digest)),
    ])
}

// ─── Text ────────────────────────────────────────────────────────────────────

/// `textSimilarity` pairs: each feature of docs/algorithms.md §2 and the Unicode handling.
const SIMILARITY_PAIRS: &[(&str, &str)] = &[
    ("", ""),
    ("", "a"),
    ("...", "..."),
    ("...", "!!!"),
    ("?", ""),
    ("a", "a"),
    ("a", "b"),
    ("AB", "ABCDEFGH"),
    ("abc", "abd"),
    ("Cat", "cat"),
    ("Domestic cat", "domestic_cat"),
    ("Domestic cat", "cat, domestic"),
    ("University of Oxford", "Univ. of Oxford"),
    ("Univ. Oxford", "University Oxford"),
    ("Dept. of Health", "Department of Health"),
    ("Type 1 diabetes", "Type 2 diabetes"),
    ("Windows 10", "Windows 11"),
    ("B1", "B12"),
    ("Route 007", "Route 7"),
    ("stg_orders", "stg_orders_v2"),
    ("Marie Curie", "Marie Skłodowska-Curie"),
    ("polonium (Po)", "Polonium"),
    ("pitchblende", "uraninite (pitchblende)"),
    ("Mercury", "Mercury"),
    ("Lorry", "Lorries"),
    ("color", "colour"),
    ("organization", "organisation"),
    ("Martha", "Marhta"),
    ("Dwayne", "Duane"),
    ("Dixon", "Dicksonx"),
    ("法定代表人", "法人代表"),
    ("企业信用", "企业信用报告"),
    ("股权出质", "股权质押"),
    ("数据资产目录", "数据资产总目录"),
    ("データカタログ", "データ・カタログ"),
    ("데이터 카탈로그", "데이터카탈로그"),
    ("Café", "Cafe\u{301}"),
    ("Café", "Cafe"),
    ("𝐀𝐩𝐩𝐥𝐞 pie", "Apple pie"),
    ("ﬁle", "file"),
    ("ＡＢＣ１２３", "ABC123"),
    ("ΟΔΟΣ", "οδος"),
    ("ΟΔΟΣ", "οδοσ"),
    ("İstanbul", "istanbul"),
    ("Straße", "strasse"),
    ("Smile 😀", "Smile 😁"),
    ("👩\u{200d}💻 Developer", "Developer"),
    ("𠀀 rare", "𠀁 rare"),
    ("Zero\u{200b}width", "Zerowidth"),
    ("Soft\u{ad}hyphen", "Softhyphen"),
    ("BOM\u{feff}inside", "BOMinside"),
    ("NBSP\u{a0}space", "NBSP space"),
    ("NEL\u{85}line", "NEL line"),
    ("Tab\there", "Tab here"),
    ("a-b/c.d_e", "a b c d e"),
    ("  padded  ", "padded"),
    ("New York City", "City New York"),
    ("the of and", "and of the"),
    ("Order line", "Order lines"),
    ("Customer", "Client"),
    ("Revenue", "Net revenue"),
];

fn text_similarity() -> String {
    let pairs = SIMILARITY_PAIRS
        .iter()
        .map(|(a, b)| {
            let similarity = kgdiff_core::text::text_similarity(a, b);
            row(vec![(*a).into(), (*b).into(), similarity.into()])
        })
        .collect();
    lines(&[
        (
            "description",
            "textSimilarity(a, b) of @kgdiff/core: NFKC, lowercase, invisible characters removed, punctuation and whitespace collapsed; bigram Dice or Jaro–Winkler, token sets with abbreviations, the number cap; rounded to 1e-6. Exactly symmetric.".into(),
        ),
        ("pairs", Value::Array(pairs)),
    ])
}

const PREDICATES: &[&str] = &[
    "rdfs:subClassOf",
    "http://www.w3.org/2000/01/rdf-schema#subClassOf",
    "http://purl.obolibrary.org/obo/part_of",
    "http://purl.obolibrary.org/obo/RO_0002131",
    "http://purl.obolibrary.org/obo/BFO_0000050",
    "https://purl.obolibrary.org/obo/RO_0002131",
    "BFO:0000050",
    "part_of",
    "is_a",
    "has_part__of",
    "snake_case_name",
    "camelCaseName",
    "http://example.org/onto#hasTopping",
    "http://example.org/onto/",
    "http://example.org/onto#",
    "http://example.org/12345",
    "http://example.org/a%20b",
    "http://example.org/caf%C3%A9",
    "http://example.org/bad%E0%A4",
    "http://example.org/100%",
    "urn:isbn:0451450523",
    "ex:knows",
    "knows",
    "投资",
    "http://example.org/关联",
    "http://example.org/Cafe\u{301}",
    "reports to",
    "  spaced  out  ",
    "_",
    "#",
    "",
    "a:b:c",
    "http://example.org/x_y_z",
    "http://example.org/😀_rel",
];

fn predicate_label() -> String {
    let pairs = PREDICATES
        .iter()
        .map(|p| row(vec![(*p).into(), kgdiff_core::text::predicate_label(p).into()]))
        .collect();
    lines(&[
        (
            "description",
            "predicateLabel(predicate) of @kgdiff/core: local part after the last #, / or :, percent-decoded, _ → space, NFC; opaque (digit-only) local parts keep the whole predicate; opaque OBO PURLs read as CURIEs.".into(),
        ),
        ("pairs", Value::Array(pairs)),
    ])
}

// ─── Layout ──────────────────────────────────────────────────────────────────

const LABELS: &[&str] = &[
    "",
    "a",
    "Animal",
    "ANIMAL",
    "animal 42",
    "   ",
    "企业信用知识图谱",
    "ＡＢＣ",
    "データ",
    "데이터",
    "Smile 😀",
    "👩\u{200d}💻",
    "🇨🇳",
    "1\u{fe0f}\u{20e3}",
    "e\u{301}",
    "Ω≈ç√∫",
    "Ελληνικά",
    "Кириллица",
    "עברית",
    "العربية",
    "Mixed 中文 and English 123",
    "𠀀𠀁",
    "Tab\tand\nnewline",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中中",
];

const DEGREES: &[f64] = &[
    -1.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 8.0, 9.0, 10.0, 16.0, 20.0, 21.0, 22.0, 25.0, 30.0, 40.0,
    100.0, 1000.0,
];

fn label_width() -> String {
    let mut widths = Vec::new();
    for font_size in [12.0, 10.0, 14.5] {
        for text in LABELS {
            let width = estimate_label_width(text, font_size);
            widths.push(row(vec![(*text).into(), font_size.into(), width.into()]));
        }
    }
    let radii = DEGREES
        .iter()
        .map(|&d| row(vec![d.into(), node_radius(d).into()]))
        .collect();
    lines(&[
        (
            "description",
            "estimateLabelWidth(text, fontSize) and nodeRadius(degree) of @kgdiff/layout. The scene sizes label boxes and nodes with these, so every implementation of the layout must agree with them exactly (a layout vector: RFC 0002, phase 4).".into(),
        ),
        ("labelWidth", Value::Array(widths)),
        ("nodeRadius", Value::Array(radii)),
    ])
}

fn facet_labels() -> String {
    let mut labels = Object::new();
    for locale in [Locale::En, Locale::ZhCn] {
        let mut kinds = Object::new();
        for kind in FacetKind::ALL {
            kinds.insert(kind.as_str(), facet_label(kind, locale));
        }
        labels.insert(locale.as_str(), kinds);
    }
    let mut out = Object::new();
    out.insert(
        "description",
        "facetLabel(kind, locale) of @kgdiff/core for every facet kind, in canonical facet order.",
    );
    out.insert("labels", labels);
    pretty(&Value::Object(out))
}
