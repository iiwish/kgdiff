//! What kgdiff-core is checked against: the parts of every case it computes, and the primitive
//! vectors. A part is `Pending` until the slice of the port that computes it turns it on by giving
//! it a function; from then on it must pass for every case.

use crate::corpus::{Case, Corpus, Mode};
use crate::{library, vectors};

/// The output of a part for one case, compared with its expected file.
pub type Produce = fn(&Case) -> Result<Vec<u8>, String>;

/// One expected file of every case.
pub struct Part {
    /// Short name, used in the report and as a filter.
    pub name: &'static str,
    /// The expected file, relative to the case directory.
    pub file: &'static str,
    pub mode: Mode,
    /// `None` while the port does not compute it yet.
    pub produce: Option<Produce>,
}

/// The outcome of a primitive vector: `Ok` with how many entries passed, or the failures.
pub type Verify = fn(&Corpus, &str) -> Result<usize, Vec<String>>;

/// One primitive vector file.
pub struct Vector {
    pub file: &'static str,
    pub verify: Option<Verify>,
}

/// The parts of a case that kgdiff-formats and kgdiff-core compute (RFC 0002, phases 2 and 3),
/// starting from the case's input files.
pub fn parts() -> Vec<Part> {
    use Mode::{Bytes, Value};
    let _part = |name, file, mode| Part {
        name,
        file,
        mode,
        produce: None,
    };
    let ported = |name, file, mode, produce: Produce| Part {
        name,
        file,
        mode,
        produce: Some(produce),
    };
    vec![
        ported(
            "parse.before",
            "expected/parse.before.json",
            Value,
            library::parse_before,
        ),
        ported(
            "parse.after",
            "expected/parse.after.json",
            Value,
            library::parse_after,
        ),
        ported(
            "graph.before",
            "expected/graph.before.json",
            Bytes,
            library::graph_before,
        ),
        ported(
            "graph.after",
            "expected/graph.after.json",
            Bytes,
            library::graph_after,
        ),
        // The same graphs from Rust values and from JSON text (RFC 0003, part 3).
        ported(
            "input.before",
            "expected/graph.before.json",
            Bytes,
            library::input_before,
        ),
        ported(
            "input.after",
            "expected/graph.after.json",
            Bytes,
            library::input_after,
        ),
        ported("issues", "expected/issues.json", Value, library::issues),
        ported("hashes", "expected/hashes.json", Value, library::hashes),
        ported("diff", "expected/diff.json", Bytes, library::diff),
        ported("titles", "expected/titles.json", Value, library::titles),
        ported(
            "packed",
            "expected/diff.packed.json",
            Bytes,
            library::packed,
        ),
        ported("delta", "expected/delta.json", Bytes, library::delta),
        ported(
            "inverse",
            "expected/delta.inverse.json",
            Bytes,
            library::inverse,
        ),
        ported("apply", "expected/apply.json", Bytes, library::apply),
    ]
}

/// Expected files of a case that other crates compute, with the phase that ports them.
pub const ELSEWHERE: &[(&str, &str)] = &[
    ("expected/report.json", "kgdiff-report, phase 3"),
    ("expected/layout-contract.json", "kgdiff-layout, phase 4"),
    ("expected/cli/", "the kgdiff binary, phase 3"),
];

/// The primitive vectors kgdiff-core passes (every one but the layout's).
pub fn vectors() -> Vec<Vector> {
    let ported = |file, verify: Verify| Vector {
        file,
        verify: Some(verify),
    };
    vec![
        ported(
            "primitives/number-to-string.json",
            vectors::number_to_string,
        ),
        ported(
            "primitives/number-from-string.json",
            vectors::number_from_string,
        ),
        ported("primitives/js-math.json", vectors::js_math),
        ported("primitives/log2.json", vectors::log2),
        ported("primitives/string-order.json", vectors::string_order),
        ported("primitives/json-roundtrip.json", vectors::json_roundtrip),
        ported("primitives/text-similarity.json", vectors::text_similarity),
        ported("primitives/predicate-label.json", vectors::predicate_label),
        ported("primitives/facet-labels.json", vectors::facet_labels),
    ]
}

/// Primitive vectors of other crates.
pub const VECTORS_ELSEWHERE: &[(&str, &str)] =
    &[("primitives/label-width.json", "kgdiff-layout, phase 4")];
