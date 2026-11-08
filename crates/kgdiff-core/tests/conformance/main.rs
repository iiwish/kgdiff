//! kgdiff-core against the conformance corpus (`conformance/README.md`).
//!
//! Walks `conformance/manifest.json`, computes every part of every case that kgdiff-core ports
//! (RFC 0002, phase 2) and every primitive vector, and prints which pass. A part that the port
//! does not compute yet is reported as pending; a part it computes must pass for every case.
//!
//! ```sh
//! cargo test -p kgdiff-core --test conformance               # everything
//! cargo test -p kgdiff-core --test conformance -- unicode    # cases, parts or vectors matching
//! ```

mod checks;
mod corpus;
mod library;
mod vectors;

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::process::ExitCode;

use checks::{ELSEWHERE, VECTORS_ELSEWHERE};
use corpus::{Corpus, compare, read_bytes};

/// What happened to one check.
enum Outcome {
    Pass,
    Fail(String),
    Pending,
}

fn main() -> ExitCode {
    // `cargo test` hands its filter and libtest's flags to every test binary: keep the filters.
    let filters: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();
    let selected = |name: &str| filters.is_empty() || filters.iter().any(|f| name.contains(f));

    let corpus = match Corpus::open() {
        Ok(corpus) => corpus,
        Err(message) => {
            eprintln!("cannot read the conformance corpus: {message}");
            return ExitCode::FAILURE;
        }
    };
    let mut out = String::new();
    let mut failures = Vec::new();
    let (mut passed, mut pending) = (0, 0);

    // The harness must know every file the corpus has, so that a new kind of expected file or
    // vector is noticed here rather than silently skipped.
    if let Err(message) = check_coverage(&corpus) {
        eprintln!("{message}");
        return ExitCode::FAILURE;
    }

    let parts = checks::parts();
    let width = corpus
        .cases
        .iter()
        .map(|c| c.id.len())
        .max()
        .unwrap_or(0)
        .max(5);
    writeln!(
        out,
        "kgdiff-core against the conformance corpus: {} cases, {} primitive vectors\n",
        corpus.cases.len(),
        corpus.primitives.len()
    )
    .unwrap();
    write!(out, "{:width$}", "case").unwrap();
    for part in &parts {
        write!(out, "  {}", part.name).unwrap();
    }
    out.push('\n');
    for case in &corpus.cases {
        let case_selected = selected(&case.id);
        write!(out, "{:width$}", case.id).unwrap();
        for part in &parts {
            let mark = if !case_selected && !selected(part.name) {
                " "
            } else {
                let outcome = match part.produce {
                    None => Outcome::Pending,
                    Some(produce) => match (produce(case), case.read_bytes(part.file)) {
                        (Ok(actual), Ok(expected)) => {
                            match compare(part.mode, &actual, &expected) {
                                Ok(()) => Outcome::Pass,
                                Err(message) => Outcome::Fail(message),
                            }
                        }
                        (Err(message), _) | (_, Err(message)) => Outcome::Fail(message),
                    },
                };
                match outcome {
                    Outcome::Pass => {
                        passed += 1;
                        "✓"
                    }
                    Outcome::Pending => {
                        pending += 1;
                        "·"
                    }
                    Outcome::Fail(message) => {
                        failures.push(format!("{} {}: {message}", case.id, part.name));
                        "✗"
                    }
                }
            };
            write!(out, "  {mark:^w$}", w = part.name.chars().count()).unwrap();
        }
        out.push('\n');
    }
    writeln!(out, "\n✓ passes  ✗ fails  · not ported yet\n").unwrap();

    writeln!(out, "primitive vectors").unwrap();
    for vector in checks::vectors() {
        let name = vector.file.trim_start_matches("primitives/");
        if !selected(name) {
            continue;
        }
        let line = match vector.verify {
            None => {
                pending += 1;
                "· not ported yet".to_owned()
            }
            Some(verify) => match verify(&corpus, vector.file) {
                Ok(entries) => {
                    passed += 1;
                    format!("✓ {entries} entries")
                }
                Err(errors) => {
                    let count = errors.len();
                    failures.extend(errors.into_iter().take(20).map(|e| format!("{name}: {e}")));
                    format!("✗ {count} failures")
                }
            },
        };
        writeln!(out, "  {name:28}{line}").unwrap();
    }
    for (file, owner) in VECTORS_ELSEWHERE {
        writeln!(
            out,
            "  {:28}– {owner}",
            file.trim_start_matches("primitives/")
        )
        .unwrap();
    }

    writeln!(out, "\nchecked elsewhere").unwrap();
    for (file, owner) in ELSEWHERE {
        writeln!(
            out,
            "  {:28}– {owner}",
            file.trim_start_matches("expected/")
        )
        .unwrap();
    }

    if !failures.is_empty() {
        writeln!(out, "\nfailures").unwrap();
        for failure in &failures {
            writeln!(out, "  {failure}").unwrap();
        }
    }
    writeln!(
        out,
        "\n{passed} checks pass, {} fail, {pending} not ported yet",
        failures.len()
    )
    .unwrap();
    print!("{out}");
    if failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Every expected file of every case and every primitive vector of the manifest is one the
/// harness knows: checked here, or by a crate of a later phase.
fn check_coverage(corpus: &Corpus) -> Result<(), String> {
    let known: BTreeSet<&str> = checks::vectors()
        .iter()
        .map(|v| v.file)
        .chain(VECTORS_ELSEWHERE.iter().map(|(file, _)| *file))
        .collect();
    for vector in &corpus.primitives {
        if !known.contains(vector.as_str()) {
            return Err(format!(
                "the harness does not know the primitive vector {vector}"
            ));
        }
        read_bytes(&corpus.root.join(vector))?;
    }
    let parts = checks::parts();
    for case in &corpus.cases {
        let expected = case.path("expected");
        let entries =
            fs::read_dir(&expected).map_err(|e| format!("{}: {e}", expected.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let mut file = format!("expected/{}", entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                file.push('/');
            }
            let known = parts.iter().any(|p| p.file == file)
                || ELSEWHERE.iter().any(|(other, _)| *other == file);
            if !known {
                return Err(format!("{}: the harness does not know {file}", case.id));
            }
        }
        for part in &parts {
            if !case.path(part.file).is_file() {
                return Err(format!("{}: {} is missing", case.id, part.file));
            }
        }
    }
    Ok(())
}
