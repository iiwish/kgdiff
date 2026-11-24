//! The featured datasets' summary, `--stat`, `--name-status` and Markdown, plain, in colour and
//! in a narrow terminal, compared byte for byte with the snapshots in `tests/snapshots/`
//! (the landing page shows them too).
//!
//! After an intended change of these outputs, write the snapshots again and review their diff:
//!
//! ```sh
//! KGDIFF_UPDATE_SNAPSHOTS=1 cargo test -p kgdiff --test golden
//! ```

mod common;

use common::{dataset, io, run_with};

const CASES: [(&str, &str); 4] = [
    ("enterprise-kg", "zh-CN"),
    ("enterprise-kg-en", "en"),
    ("ontology-release", "en"),
    ("llm-extraction", "en"),
];

fn snapshot_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/snapshots/{name}"))
}

/// Whether the output equals the snapshot `name`; with `KGDIFF_UPDATE_SNAPSHOTS` set, writes it.
fn matches(name: &str, output: &str) -> bool {
    let path = snapshot_path(name);
    if std::env::var_os("KGDIFF_UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, output).unwrap();
        return true;
    }
    std::fs::read_to_string(&path).unwrap() == output
}

#[test]
fn matches_the_snapshots() {
    let version = format!("kgdiff {}", kgdiff::VERSION);
    let mut failures = Vec::new();
    for (id, locale) in CASES {
        let d = dataset(id);
        let outputs: [(&str, &[&str], &str); 4] = [
            ("summary", &[], "txt"),
            ("stat", &["--stat"], "txt"),
            ("name-status", &["--name-status"], "tsv"),
            ("markdown", &["--markdown"], "md.snap"),
        ];
        for (name, flags, ext) in outputs {
            let mut argv = d.argv(&["--locale", locale]);
            argv.extend(flags);
            let r = run_with(&argv, io().var("COLUMNS", "100"));
            assert_eq!(r.code, 0, "{}", r.stderr);
            assert_eq!(r.stderr, "");
            let out = r.stdout.replace(&version, "kgdiff <version>");
            if !matches(&format!("{id}.{name}.{ext}"), &out) {
                failures.push(format!("{id}.{name}"));
            }
        }
        // In colour (truecolor).
        let r = run_with(
            &d.argv(&["--locale", locale, "--color", "always"]),
            io().var("COLUMNS", "100").var("COLORTERM", "truecolor"),
        );
        assert_eq!(r.code, 0);
        if !matches(&format!("{id}.summary.color.ansi"), &r.stdout) {
            failures.push(format!("{id}.summary.color"));
        }
        // In a narrow terminal (64 columns, colour off).
        let mut narrow = io().var("NO_COLOR", "1");
        narrow.is_tty = true;
        narrow.columns = Some(64.0);
        let r = run_with(&d.argv(&["--locale", locale]), narrow);
        if !matches(&format!("{id}.summary.64.txt"), &r.stdout) {
            failures.push(format!("{id}.summary.64"));
        }
    }
    assert!(
        failures.is_empty(),
        "differ from the snapshots: {failures:?}"
    );
}

/// `--kgcl` on the ontology datasets (OBO and Turtle), compared with `tests/snapshots/*.kgcl`.
/// The commands of both were checked by hand with kgcl-schema 0.7.0's parser and the grammar of
/// INCATools/kgcl at 1849f9c (`kgdiff_report::kgcl`); one warning on stderr counts the changes
/// written as comments and the created nodes whose other fields are, but not the notes before a
/// split or a merge.
#[test]
fn kgcl_matches_the_snapshots() {
    let mut failures = Vec::new();
    for (id, unexported, partial, notes) in
        [("ontology-release", 21, 5, 1), ("schema-vocab", 5, 5, 0)]
    {
        let d = dataset(id);
        let r = run_with(&d.argv(&["--kgcl"]), io());
        assert_eq!(r.code, 0, "{}", r.stderr);
        assert_eq!(
            r.stderr,
            format!(
                "warning: {unexported} changes have no KGCL command, and {partial} created nodes or edges have fields with no KGCL command; --kgcl writes these as comments (lines starting with #).\n"
            ),
            "{id}"
        );
        let commented = r.stdout.lines().filter(|l| l.starts_with('#')).count();
        assert_eq!(commented, unexported + partial + notes, "{id}");
        // The same diff gives the same bytes.
        assert_eq!(run_with(&d.argv(&["--kgcl"]), io()).stdout, r.stdout);
        if !matches(&format!("{id}.kgcl"), &r.stdout) {
            failures.push(id);
        }
    }
    assert!(
        failures.is_empty(),
        "differ from the snapshots: {failures:?}"
    );
}
