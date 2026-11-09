//! `packages/cli/test/golden.test.ts`, ported: the featured datasets' summary, `--stat`,
//! `--name-status` and Markdown, plain, in colour and in a narrow terminal, compared byte for
//! byte with the TypeScript suite's own snapshots.

mod common;

use common::{dataset, io, repo, run_with};

const CASES: [(&str, &str); 4] = [
    ("enterprise-kg", "zh-CN"),
    ("enterprise-kg-en", "en"),
    ("ontology-release", "en"),
    ("llm-extraction", "en"),
];

fn snapshot(name: &str) -> String {
    std::fs::read_to_string(format!("{}/packages/cli/test/__snapshots__/{name}", repo())).unwrap()
}

#[test]
fn matches_the_typescript_snapshots() {
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
            if out != snapshot(&format!("{id}.{name}.{ext}")) {
                failures.push(format!("{id}.{name}"));
            }
        }
        // In colour (truecolor).
        let r = run_with(
            &d.argv(&["--locale", locale, "--color", "always"]),
            io().var("COLUMNS", "100").var("COLORTERM", "truecolor"),
        );
        assert_eq!(r.code, 0);
        if r.stdout != snapshot(&format!("{id}.summary.color.ansi")) {
            failures.push(format!("{id}.summary.color"));
        }
        // In a narrow terminal (64 columns, colour off).
        let mut narrow = io().var("NO_COLOR", "1");
        narrow.is_tty = true;
        narrow.columns = Some(64.0);
        let r = run_with(&d.argv(&["--locale", locale]), narrow);
        if r.stdout != snapshot(&format!("{id}.summary.64.txt")) {
            failures.push(format!("{id}.summary.64"));
        }
    }
    assert!(
        failures.is_empty(),
        "differ from the snapshots: {failures:?}"
    );
}
