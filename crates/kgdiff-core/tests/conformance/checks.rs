//! What kgdiff-core is checked against: the parts of every case it computes, and the primitive
//! vectors. A part is `Pending` until the slice of the port that computes it turns it on by giving
//! it a function; from then on it must pass for every case.

use crate::corpus::{Case, Corpus, Mode};
use crate::vectors;

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

/// The parts of a case that kgdiff-core computes (RFC 0002, phase 2, Acceptance), starting from
/// `expected/parse.<side>.json`'s graph.
pub fn parts() -> Vec<Part> {
    use Mode::{Bytes, Value};
    let part = |name, file, mode| Part {
        name,
        file,
        mode,
        produce: None,
    };
    vec![
        part("graph.before", "expected/graph.before.json", Bytes),
        part("graph.after", "expected/graph.after.json", Bytes),
        part("issues", "expected/issues.json", Value),
        part("hashes", "expected/hashes.json", Value),
        part("diff", "expected/diff.json", Bytes),
        part("titles", "expected/titles.json", Value),
        part("packed", "expected/diff.packed.json", Bytes),
        part("delta", "expected/delta.json", Bytes),
        part("inverse", "expected/delta.inverse.json", Bytes),
        part("apply", "expected/apply.json", Bytes),
    ]
}

/// Expected files of a case that other crates compute, with the phase that ports them.
pub const ELSEWHERE: &[(&str, &str)] = &[
    ("expected/parse.before.json", "kgdiff-formats, phase 3"),
    ("expected/parse.after.json", "kgdiff-formats, phase 3"),
    ("expected/report.json", "kgdiff-report, phase 3"),
    ("expected/layout-contract.json", "kgdiff-layout, phase 4"),
    ("expected/cli/", "the kgdiff binary, phase 3"),
];

/// The primitive vectors kgdiff-core passes (every one but the layout's).
pub fn vectors() -> Vec<Vector> {
    let vector = |file| Vector { file, verify: None };
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
        vector("primitives/text-similarity.json"),
        vector("primitives/predicate-label.json"),
        vector("primitives/facet-labels.json"),
    ]
}

/// Primitive vectors of other crates.
pub const VECTORS_ELSEWHERE: &[(&str, &str)] =
    &[("primitives/label-width.json", "kgdiff-layout, phase 4")];
