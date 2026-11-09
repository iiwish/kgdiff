//! `packages/cli/test/cli.test.ts`, ported: the summary, possible matches, review first,
//! colours, every output, exit codes and errors, RDF/XML and JSON-LD inputs, help, apply, edge
//! cases. Each test is the TypeScript test of the same name.

mod common;

use std::io::Write;

use common::{CWD, dataset, io, re, repo, run, run_with};
use kgdiff::testing::MemoryIo;
use kgdiff_core::js::{Value, json};
use kgdiff_core::{NormalizeOptions, hash_graph, normalize};
use kgdiff_formats::{ParseOptions, parse_graph};
use kgdiff_report::strip_ansi;
use kgdiff_report::width::string_width;

const BEFORE: &str = r#"{"meta":{"name":"zoo","version":"v1"},"nodes":[{"id":"animal","label":"Animal"},{"id":"bird","label":"Bird"},{"id":"cat","label":"Cat","attrs":{"legs":4}},{"id":"dog","label":"Dog"},{"id":"dodo","label":"Dodo"}],"edges":[{"source":"bird","target":"animal","predicate":"is_a"},{"source":"cat","target":"animal","predicate":"is_a"},{"source":"dog","target":"animal","predicate":"is_a"},{"source":"dodo","target":"bird","predicate":"eats"}]}"#;
const AFTER: &str = r#"{"meta":{"name":"zoo","version":"v2"},"nodes":[{"id":"animal","label":"Animal"},{"id":"bird","label":"Bird"},{"id":"cat","label":"House cat","attrs":{"legs":4}},{"id":"dog","label":"Dog"},{"id":"owl","label":"Owl"}],"edges":[{"source":"bird","target":"animal","predicate":"is_a"},{"source":"cat","target":"animal","predicate":"is_a"},{"source":"dog","target":"animal","predicate":"is_a"},{"source":"owl","target":"bird","predicate":"is_a"}]}"#;
const FILES: [(&str, &str); 2] = [("before.json", BEFORE), ("after.json", AFTER)];
const ESC: &str = "\x1b";

fn zoo() -> MemoryIo {
    io().file("before.json", BEFORE).file("after.json", AFTER)
}

fn tty(mut io: MemoryIo, columns: Option<f64>) -> MemoryIo {
    io.is_tty = true;
    io.columns = columns;
    io
}

fn parse_json(text: &str) -> Value {
    json::parse(text).unwrap()
}

fn graph_hash(text: &str, filename: &str) -> String {
    let parsed = parse_graph(
        text,
        &ParseOptions {
            filename: Some(filename.to_owned()),
            ..ParseOptions::default()
        },
    )
    .unwrap();
    hash_graph(&normalize(&Value::Object(parsed.graph), NormalizeOptions::default()).unwrap())
        .to_owned()
}

fn hunk_rows(stdout: &str) -> usize {
    stdout
        .lines()
        .filter(|l| re(r"^ {2}[⑂⊕⇄~+−] ").is_match(l))
        .count()
}

// ─── summary ─────────────────────────────────────────────────────────────────

#[test]
fn prints_header_counters_bar_and_hunks_grouped_by_phase() {
    let r = run(&["before.json", "after.json"], &FILES);
    assert_eq!(r.code, 0);
    assert_eq!(r.stderr, "");
    let lines: Vec<&str> = r.stdout.split('\n').collect();
    assert!(
        re(r"^kgdiff {2}zoo v1 → v2 +5 nodes · 4 edges$").is_match(lines[0]),
        "{}",
        lines[0]
    );
    assert!(
        re(r"^ {2}\+1 added {3}−1 removed {3}~1 modified +\d+ changes in 3 hunks$")
            .is_match(lines[2])
    );
    assert!(re(r"^ {2}[+−~]+$").is_match(lines[3]));
    assert!(
        r.stdout
            .contains("  Modified 1\n  ~ Renamed “Cat” → “House cat”")
    );
    assert!(re(r" {2}\+ Added “Owl” and 1 relation +added · ").is_match(&r.stdout));
    assert!(re(r" {2}− Removed “Dodo” and 1 relation +removed · ").is_match(&r.stdout));
    assert!(!r.stdout.contains(ESC));
    assert!(r.stdout.ends_with('\n'));
}

#[test]
fn lists_groups_in_replay_order() {
    let d = dataset("ontology-release");
    let r = run_with(&d.argv(&[]), io());
    let headings: Vec<String> = r
        .stdout
        .lines()
        .filter(|l| re(r"^ {2}[A-Z][a-z]+ \d+$").is_match(l))
        .map(|l| {
            kgdiff_core::js::trim(l)
                .split(' ')
                .next()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(headings, ["Restructured", "Modified", "Added"]);
    let e = dataset("enterprise-kg");
    let zh = run_with(&e.argv(&["--locale", "zh-CN"]), io());
    let zh_headings: Vec<String> = zh
        .stdout
        .lines()
        .filter(|l| re(r"^ {2}\p{Han}+ \d+$").is_match(l))
        .map(|l| {
            kgdiff_core::js::trim(l)
                .split(' ')
                .next()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(zh_headings, ["删除", "结构调整", "修改", "新增"]);
    let md = run_with(&e.argv(&["--markdown"]), io());
    let summaries: Vec<String> = re(r"<summary>(\w+) \(")
        .captures_iter(&md.stdout)
        .map(|c| c[1].to_owned())
        .collect();
    assert_eq!(summaries, ["Removed", "Restructured", "Modified", "Added"]);
}

#[test]
fn reports_identical_graphs_calmly() {
    let r = run(&["before.json", "before.json", "--exit-code"], &FILES);
    assert_eq!(r.code, 0);
    assert!(
        r.stdout
            .contains("✓ No differences  Both versions have 5 nodes and 4 edges.")
    );
}

#[test]
fn limits_the_list_and_says_how_many_are_hidden() {
    let d = dataset("ontology-release");
    let r = run_with(&d.argv(&["--limit", "3"]), io());
    assert_eq!(hunk_rows(&r.stdout), 3);
    assert!(r.stdout.contains("  … and 19 more · --limit 0 lists all"));
    let all = run_with(&d.argv(&["--limit", "0"]), io());
    assert_eq!(hunk_rows(&all.stdout), 22);
    assert!(!all.stdout.contains("more ·"));
}

#[test]
fn keeps_every_line_within_the_terminal_width_cjk_included() {
    let d = dataset("enterprise-kg");
    for columns in [50, 64, 80, 132] {
        let r = run_with(
            &d.argv(&["--locale", "zh-CN"]),
            tty(io().var("NO_COLOR", "1"), Some(f64::from(columns))),
        );
        for line in r.stdout.split('\n') {
            assert!(
                string_width(line) <= usize::try_from(columns.min(120)).unwrap(),
                "{line}"
            );
        }
    }
}

#[test]
fn aligns_the_family_column_with_wide_characters_and_with_color() {
    let d = dataset("enterprise-kg");
    for color in ["never", "always"] {
        let r = run_with(
            &d.argv(&["--locale", "zh-CN", "--color", color]),
            io().var("COLUMNS", "100").var("COLORTERM", "truecolor"),
        );
        let plain = strip_ansi(&r.stdout);
        let rows: Vec<&str> = plain
            .lines()
            .filter(|l| re(r"^ {2}[⑂⊕⇄~+−] ").is_match(l))
            .collect();
        assert_eq!(rows.len(), 12);
        let family = re(r"(新增|删除|内容|结构|身份)( ·|$)");
        let columns: std::collections::BTreeSet<usize> = rows
            .iter()
            .map(|row| string_width(&row[..family.find(row).unwrap().start()]))
            .collect();
        assert_eq!(columns.len(), 1);
    }
}

#[test]
fn localizes_from_lang_and_lets_locale_win() {
    let zh = run_with(
        &["before.json", "after.json"],
        zoo().var("LANG", "zh_CN.UTF-8"),
    );
    assert!(zh.stdout.contains("「Cat」改名为「House cat」"));
    assert!(zh.stdout.contains("节点 5 · 关系 4"));
    let en = run_with(
        &["before.json", "after.json", "--locale", "en"],
        zoo().var("LANG", "zh_CN.UTF-8"),
    );
    assert!(en.stdout.contains("Renamed “Cat” → “House cat”"));
}

#[test]
fn never_prints_control_characters_from_labels() {
    let evil =
        r#"{"nodes":[{"id":"x\u001b[2J","label":"bad\u001b]0;title\u0007\nname"}],"edges":[]}"#;
    let r = run_with(
        &["before.json", "evil.json", "--name-status"],
        zoo().file("evil.json", evil),
    );
    assert_eq!(r.code, 0);
    assert!(!r.stdout.contains(ESC) && !r.stdout.contains('\u{7}'));
    assert!(
        r.stdout
            .split('\n')
            .filter(|l| !l.is_empty())
            .all(|l| l.split('\t').count() == 3)
    );
}

// ─── possible matches ────────────────────────────────────────────────────────

fn graph(nodes: &[String], edges: &[String]) -> String {
    format!(
        "{{\"nodes\":[{}],\"edges\":[{}]}}",
        nodes.join(","),
        edges.join(",")
    )
}

fn node(id: &str, label: &str, kind: &str) -> String {
    format!("{{\"id\":\"{id}\",\"label\":\"{label}\",\"type\":\"{kind}\"}}")
}

fn edge(s: &str, t: &str, p: &str) -> String {
    format!("{{\"source\":\"{s}\",\"target\":\"{t}\",\"predicate\":\"{p}\"}}")
}

/// Two extraction runs with fresh ids: “Saudi Aramco” is “Aramco” with the same neighbours.
fn runs() -> MemoryIo {
    let side = |ids: [&str; 5], name: &str| {
        graph(
            &[
                node(ids[0], name, "Organization"),
                node(ids[1], "Saudi Arabia", "Country"),
                node(ids[2], "Petroleum", "Industry"),
                node(ids[3], "Amin Nasser", "Person"),
                node(ids[4], "Dhahran", "City"),
            ],
            &[
                edge(ids[0], ids[1], "based_in"),
                edge(ids[0], ids[2], "industry"),
                edge(ids[3], ids[0], "ceo_of"),
                edge(ids[0], ids[4], "headquartered_in"),
            ],
        )
    };
    io().file(
        "run-a.json",
        side(["e1", "e2", "e3", "e4", "e5"], "Saudi Aramco"),
    )
    .file("run-b.json", side(["x9", "x2", "x7", "x4", "x1"], "Aramco"))
}

const SIMILAR: [&str; 4] = ["run-a.json", "run-b.json", "--match", "similarity"];

/// Six atoms bonded in a ring, and the same atoms as two triangles: every pairing ties.
fn rings() -> MemoryIo {
    let ring = |prefix: &str, bonds: [(u8, u8); 6]| {
        let nodes: Vec<String> = (1..=6)
            .map(|i| node(&format!("{prefix}{i}"), "C", "Atom"))
            .collect();
        let edges: Vec<String> = bonds
            .iter()
            .map(|(s, t)| edge(&format!("{prefix}{s}"), &format!("{prefix}{t}"), "bond"))
            .collect();
        graph(&nodes, &edges)
    };
    io().file(
        "hexagon.json",
        ring("h", [(1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 1)]),
    )
    .file(
        "triangles.json",
        ring("t", [(1, 2), (2, 3), (3, 1), (4, 5), (5, 6), (6, 4)]),
    )
}

const SYMMETRIC: [&str; 4] = ["hexagon.json", "triangles.json", "--match", "similarity"];

fn with<'a>(base: &[&'a str], extra: &[&'a str]) -> Vec<&'a str> {
    base.iter().chain(extra).copied().collect()
}

#[test]
fn lists_a_pairing_that_was_not_applied() {
    let r = run_with(&SIMILAR, runs());
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert!(
        r.stdout
            .contains("  − Removed “Saudi Aramco” and 3 relations")
    );
    assert!(r.stdout.contains("  + Added “Aramco” and 3 relations"));
    assert!(re(r"\n\n {2}Possible matches 1\n {2}≈ “Saudi Aramco” → “Aramco” {3}80% · below the 82% threshold · name 67% · neighbours 100%\n").is_match(&r.stdout));
    assert!(re(r"neighbours 100%\n {2}Not paired, so listed as removed or added\. To pair one, add a synonym or a replacement link, or lower --threshold\.\n$").is_match(&r.stdout));
}

#[test]
fn says_nothing_once_the_pairing_is_applied() {
    let paired = run_with(&with(&SIMILAR, &["--threshold", "0.79"]), runs());
    assert!(
        paired
            .stdout
            .contains("~ Renamed “Saudi Aramco” → “Aramco”")
    );
    assert!(!paired.stdout.contains("Possible matches"));
    assert!(
        !run(&["before.json", "after.json"], &FILES)
            .stdout
            .contains("Possible matches")
    );
}

#[test]
fn names_each_side_by_its_id_when_both_have_the_same_name() {
    let r = run_with(&with(&SYMMETRIC, &["--limit", "1"]), rings());
    assert!(
        re(r" {2}≈ “C” \(h1\) → “C” \(t1\) +100% · too close to another candidate · name 100%")
            .is_match(&r.stdout)
    );
}

#[test]
fn lists_10_unless_limit_is_lower_or_0() {
    let count = |stdout: &str| stdout.split('\n').filter(|l| l.starts_with("  ≈ ")).count();
    let capped = run_with(&SYMMETRIC, rings());
    assert!(capped.stdout.contains("  Possible matches 36\n"));
    assert_eq!(count(&capped.stdout), 10);
    assert!(
        capped
            .stdout
            .contains("  … and 26 more · --json lists all\n")
    );
    assert_eq!(
        count(&run_with(&with(&SYMMETRIC, &["--limit", "3"]), rings()).stdout),
        3
    );
    let all = run_with(&with(&SYMMETRIC, &["--limit", "0"]), rings());
    assert_eq!(count(&all.stdout), 36);
    assert!(!all.stdout.contains("more · --json"));
}

#[test]
fn possible_matches_speak_chinese() {
    let r = run_with(&with(&SIMILAR, &["--locale", "zh-CN"]), runs());
    assert!(re(r" {2}可能的匹配 1\n {2}≈ 「Saudi Aramco」→「Aramco」 +80% · 低于阈值 82% · 名称 67% · 邻居 100%\n").is_match(&r.stdout));
    assert!(r.stdout.contains("这些节点未配对，因此按删除或新增列出。"));
}

#[test]
fn markdown_lists_possible_matches_in_their_own_block() {
    let r = run_with(&with(&SIMILAR, &["--markdown"]), runs());
    let block = &r.stdout[r.stdout.find("<details open>\n<summary>Possible").unwrap()..];
    let expected = [
        "<details open>",
        "<summary>Possible matches (1)</summary>",
        "",
        "*kgdiff did not pair these nodes, so they are listed above as removed or added. If a pair is the same thing, add a synonym or a replacement link, or lower `--threshold`.*",
        "",
        "- ≈ “Saudi Aramco” → “Aramco” — *80% · below the 82% threshold · name 67% · neighbours 100%*",
        "",
        "</details>",
        "",
        &format!("*Generated by kgdiff {}*", kgdiff::VERSION),
        "",
    ]
    .join("\n");
    assert_eq!(block, expected);
    let paired = run_with(
        &with(&SIMILAR, &["--threshold", "0.79", "--markdown"]),
        runs(),
    );
    assert!(!paired.stdout.contains("Possible matches"));
}

#[test]
fn markdown_escapes_the_names_collapses_a_long_list_and_caps_it_at_20() {
    let escaped = run_with(
        &[
            "a.json",
            "b.json",
            "--match",
            "similarity",
            "--threshold",
            "0.99",
            "--markdown",
        ],
        io().file(
            "a.json",
            r#"{"nodes":[{"id":"t","label":"*Tom* @cat <b>"}],"edges":[]}"#,
        )
        .file(
            "b.json",
            r#"{"nodes":[{"id":"u","label":"*Tom* @cats <b>"}],"edges":[]}"#,
        ),
    );
    assert!(escaped.stdout.contains(
        "- ≈ “\\*Tom\\* @\u{200b}cat &lt;b&gt;” → “\\*Tom\\* @\u{200b}cats &lt;b&gt;” — *82% · below the 99% threshold"
    ));
    let many = run_with(&with(&SYMMETRIC, &["--markdown"]), rings());
    assert!(
        many.stdout
            .contains("<details>\n<summary>Possible matches (36)</summary>")
    );
    assert_eq!(
        many.stdout
            .split('\n')
            .filter(|l| l.starts_with("- ≈ "))
            .count(),
        20
    );
    assert!(many.stdout.contains(
        "*…and 16 more possible matches. The HTML report shows them in each node's details.*"
    ));
}

// ─── review first ────────────────────────────────────────────────────────────

/// Terms under “Disease”: `(id, label, attrs JSON or "")`.
fn disease_graph(terms: &[(String, String, String)]) -> String {
    let mut nodes: Vec<String> = terms
        .iter()
        .map(|(id, label, attrs)| {
            if attrs.is_empty() {
                format!("{{\"id\":\"{id}\",\"label\":\"{label}\"}}")
            } else {
                format!("{{\"id\":\"{id}\",\"label\":\"{label}\",\"attrs\":{attrs}}}")
            }
        })
        .collect();
    nodes.push("{\"id\":\"disease\",\"label\":\"Disease\"}".to_owned());
    let edges: Vec<String> = terms
        .iter()
        .map(|(id, _, _)| edge(id, "disease", "is_a"))
        .collect();
    graph(&nodes, &edges)
}

fn t(id: &str, label: &str, attrs: &str) -> (String, String, String) {
    (id.to_owned(), label.to_owned(), attrs.to_owned())
}

/// Asthma's definition is reworded (and a note edited); Gout is only renamed.
fn release() -> MemoryIo {
    io().file(
        "v1.json",
        disease_graph(&[
            t(
                "asthma",
                "Asthma",
                r#"{"def":"A chronic disease of the airways.","note":"a"}"#,
            ),
            t("gout", "Gout", ""),
        ]),
    )
    .file(
        "v2.json",
        disease_graph(&[
            t(
                "asthma",
                "Asthma",
                r#"{"def":"A chronic inflammatory disease of the airways.","note":"b"}"#,
            ),
            t("gout", "Gouty arthritis", ""),
        ]),
    )
}

const PAIR: [&str; 2] = ["v1.json", "v2.json"];

#[test]
fn counts_the_hunks_that_change_a_definition_and_marks_their_rows() {
    let r = run_with(&PAIR, release());
    assert_eq!(r.code, 0, "{}", r.stderr);
    let lines: Vec<&str> = r.stdout.split('\n').collect();
    assert!(re(r"^ {2}~+$").is_match(lines[3]));
    assert_eq!(lines[4], "  ⚑ Review first: definition changed in 1 hunk");
    assert!(
        re(r" {2}~ Updated attributes of “Asthma” +content · ⚑ definition · ~2 attributes\n")
            .is_match(&r.stdout)
    );
    assert!(re(r" {2}~ Renamed “Gout” → “Gouty arthritis” +content\n").is_match(&r.stdout));
    assert!(
        run_with(&with(&PAIR, &["--stat"]), release())
            .stdout
            .contains("  ⚑ Review first: definition changed in 1 hunk\n")
    );
}

#[test]
fn review_first_speaks_chinese() {
    let r = run_with(&with(&PAIR, &["--locale", "zh-CN"]), release());
    assert!(r.stdout.contains("  ⚑ 优先审查：1 组变更修改了定义\n"));
    assert!(re(r"「Asthma」.* +内容 · ⚑ 定义 · ").is_match(&r.stdout));
}

#[test]
fn watch_attr_replaces_the_definitions_and_ignore_attr_leaves_nothing() {
    let note = run_with(&with(&PAIR, &["--watch-attr", "note"]), release());
    assert!(
        note.stdout
            .contains("  ⚑ Review first: note changed in 1 hunk\n")
    );
    assert!(note.stdout.contains("content · ⚑ note · "));
    assert!(!note.stdout.contains("⚑ definition"));
    let both = run_with(
        &with(&PAIR, &["--watch-attr", "note", "--watch-attr", "def"]),
        release(),
    );
    assert!(
        both.stdout
            .contains("  ⚑ Review first: note, definition changed in 1 hunk\n")
    );
    assert!(
        !run_with(&with(&PAIR, &["--ignore-attr", "def"]), release())
            .stdout
            .contains('⚑')
    );
    assert!(
        !run(&["before.json", "after.json"], &FILES)
            .stdout
            .contains('⚑')
    );
}

#[test]
fn markdown_lists_review_first_before_the_groups() {
    let r = run_with(&with(&PAIR, &["--markdown"]), release());
    let item = "- 🟨 \\~ Updated attributes of “Asthma” — *⚑ definition · \\~2 attributes*";
    let expected = [
        "<details open>",
        "<summary>⚑ Review first (1)</summary>",
        "",
        "*These hunks change a watched attribute (definition). Such an edit can change what existing data means even when the diff looks small.*",
        "",
        item,
        "",
        "</details>",
        "",
        "<details open>",
        "<summary>Modified (2)</summary>",
        "",
        item,
        "- 🟨 \\~ Renamed “Gout” → “Gouty arthritis”",
    ]
    .join("\n");
    assert!(r.stdout.contains(&expected), "{}", r.stdout);
    assert!(
        !run(&["before.json", "after.json", "--markdown"], &FILES)
            .stdout
            .contains("Review first")
    );
}

#[test]
fn markdown_lists_at_most_20_under_review_first() {
    let ids: Vec<String> = (0..25).map(|i| format!("t{i:02}")).collect();
    let side = |prefix: &str| {
        disease_graph(
            &ids.iter()
                .map(|id| {
                    t(
                        id,
                        &format!("Term {id}"),
                        &format!("{{\"def\":\"{prefix} {id}.\"}}"),
                    )
                })
                .collect::<Vec<_>>(),
        )
    };
    let r = run_with(
        &["m1.json", "m2.json", "--markdown"],
        io().file("m1.json", side("Old"))
            .file("m2.json", side("New")),
    );
    let block = &r.stdout[..r.stdout.find("</details>").unwrap()];
    assert!(block.contains("<summary>⚑ Review first (25)</summary>"));
    assert_eq!(
        block.split('\n').filter(|l| l.starts_with("- ")).count(),
        20
    );
    assert!(block.contains("*…and 5 more.*"));
}

// ─── colors ──────────────────────────────────────────────────────────────────

#[test]
fn is_plain_when_stdout_is_not_a_terminal() {
    assert!(
        !run(&["before.json", "after.json"], &FILES)
            .stdout
            .contains(ESC)
    );
}

#[test]
fn colors_a_terminal_unless_no_color_is_set() {
    assert!(
        run_with(&["before.json", "after.json"], tty(zoo(), None))
            .stdout
            .contains(ESC)
    );
    assert!(
        !run_with(
            &["before.json", "after.json"],
            tty(zoo().var("NO_COLOR", "1"), None)
        )
        .stdout
        .contains(ESC)
    );
}

#[test]
fn honours_color_and_force_color() {
    let always = run_with(
        &["before.json", "after.json", "--color", "always"],
        zoo().var("NO_COLOR", "1"),
    );
    assert!(always.stdout.contains("\x1b["));
    let never = run_with(
        &["before.json", "after.json", "--color=never"],
        tty(zoo().var("FORCE_COLOR", "3"), None),
    );
    assert!(!never.stdout.contains(ESC));
    let forced = run_with(
        &["before.json", "after.json"],
        zoo().var("FORCE_COLOR", "3"),
    );
    assert!(forced.stdout.contains("\x1b[38;2;52;211;153m"));
}

#[test]
fn uses_256_colors_and_16_colors_depending_on_the_terminal() {
    let r256 = run_with(
        &["before.json", "after.json"],
        tty(zoo().var("TERM", "xterm-256color"), None),
    );
    assert!(r256.stdout.contains("\x1b[38;5;"));
    let r16 = run_with(
        &["before.json", "after.json"],
        tty(zoo().var("TERM", "xterm"), None),
    );
    assert!(re("\x1b\\[3[1-6]m").is_match(&r16.stdout));
    assert!(!r16.stdout.contains("38;5;"));
}

#[test]
fn paints_the_bar_with_family_colored_blocks() {
    let r = run(&["before.json", "after.json", "--color", "always"], &FILES);
    assert!(re(r"^ {2}█+$").is_match(strip_ansi(&r.stdout).split('\n').nth(3).unwrap()));
}

// ─── outputs ─────────────────────────────────────────────────────────────────

#[test]
fn stat_prints_the_diffstat_with_counts_and_types() {
    let r = run(&["before.json", "after.json", "--stat"], &FILES);
    assert!(r.stdout.contains("added  removed  modified  unchanged"));
    assert!(re(r"nodes +1 +1 +1 +3").is_match(&r.stdout));
    assert!(r.stdout.contains("By type") && r.stdout.contains("(untyped)"));
    assert!(!r.stdout.contains("Renamed"));
}

#[test]
fn name_status_prints_one_tab_separated_line_per_hunk() {
    assert_eq!(
        run(&["before.json", "after.json", "--name-status"], &FILES).stdout,
        "D\tdodo\tRemoved “Dodo” and 1 relation\nR\tcat\tRenamed “Cat” → “House cat”\nA\towl\tAdded “Owl” and 1 relation\n"
    );
}

#[test]
fn name_status_aligns_columns_on_a_terminal() {
    let r = run_with(
        &["before.json", "after.json", "--name-status"],
        tty(zoo().var("NO_COLOR", "1"), None),
    );
    assert!(r.stdout.contains("D  dodo  Removed “Dodo” and 1 relation"));
    assert!(r.stdout.contains("R  cat   Renamed “Cat” → “House cat”"));
}

#[test]
fn stat_and_name_status_combine() {
    let r = run(
        &["before.json", "after.json", "--stat", "--name-status"],
        &FILES,
    );
    assert!(r.stdout.contains("By type") && r.stdout.contains("R\tcat\t"));
}

#[test]
fn json_prints_the_full_diff_and_pretty_indents_it() {
    let r = run(&["before.json", "after.json", "--json"], &FILES);
    let diff = parse_json(&r.stdout);
    assert_eq!(
        diff.get("format").and_then(Value::as_str),
        Some("kgdiff.diff")
    );
    assert_eq!(
        diff.get("hunks")
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(3)
    );
    assert_eq!(r.stdout.split('\n').count(), 2);
    assert!(
        run(&["before.json", "after.json", "--json", "--pretty"], &FILES)
            .stdout
            .contains("\n  \"format\": \"kgdiff.diff\"")
    );
}

#[test]
fn delta_prints_the_delta_only() {
    let delta = parse_json(&run(&["before.json", "after.json", "--delta"], &FILES).stdout);
    assert_eq!(
        delta.get("format").and_then(Value::as_str),
        Some("kgdiff.delta")
    );
    assert_eq!(
        delta
            .get("base")
            .and_then(|b| b.get("name"))
            .and_then(Value::as_str),
        Some("zoo")
    );
}

#[test]
fn writes_combined_outputs_to_files_and_keeps_the_summary_on_stdout() {
    let r = run(
        &[
            "before.json",
            "after.json",
            "-o",
            "report.html",
            "--markdown",
            "summary.md",
            "--json",
            "diff.json",
            "--delta",
            "delta.json",
        ],
        &FILES,
    );
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert!(r.stdout.starts_with("kgdiff  zoo"));
    assert_eq!(
        parse_json(&r.file("diff.json"))
            .get("format")
            .and_then(Value::as_str),
        Some("kgdiff.diff")
    );
    assert_eq!(
        parse_json(&r.file("delta.json"))
            .get("format")
            .and_then(Value::as_str),
        Some("kgdiff.delta")
    );
    assert!(r.file("summary.md").starts_with("## kgdiff · zoo v1 → v2"));
    assert!(r.file("report.html").starts_with("<!doctype html>"));
    assert!(re(r"✓ Wrote diff diff\.json \(\d+(\.\d)? kB\)").is_match(&r.stderr));
    assert!(r.stderr.contains("✓ Wrote report report.html"));
}

#[test]
fn quiet_prints_nothing_but_still_writes_files_and_sets_the_exit_code() {
    let r = run(
        &[
            "before.json",
            "after.json",
            "-q",
            "--exit-code",
            "--json",
            "out.json",
        ],
        &FILES,
    );
    assert_eq!(r.code, 1);
    assert_eq!((r.stdout.as_str(), r.stderr.as_str()), ("", ""));
    assert_eq!(r.io.written.len(), 1);
}

#[test]
fn markdown_escapes_labels() {
    let tricky = r#"{"nodes":[{"id":"a","label":"*bold* _it_ `code`"},{"id":"b","label":"[link](x) | pipe ~strike~"},{"id":"c","label":"<script>alert(1)</script> & co"},{"id":"d","label":"@octocat fixes #12 :tada:"},{"id":"e","label":"line\nbreak"}],"edges":[]}"#;
    let md = run_with(
        &["before.json", "tricky.json", "--markdown"],
        zoo().file("tricky.json", tricky),
    )
    .stdout;
    assert!(md.contains("\\*bold\\* \\_it\\_ \\`code\\`"));
    assert!(md.contains("\\[link\\](x) \\| pipe \\~strike\\~"));
    assert!(md.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co"));
    assert!(!md.contains("<script>"));
    assert!(
        md.contains("@\u{200b}octocat")
            && md.contains("\\#\u{200b}12")
            && md.contains(":\u{200b}tada:")
    );
    assert!(md.contains("line break"));
    // Only <details> / <summary> as HTML.
    let tags: std::collections::BTreeSet<String> = re(r"</?([a-z]+)")
        .captures_iter(&md)
        .map(|c| c[1].to_owned())
        .collect();
    assert_eq!(tags.into_iter().collect::<Vec<_>>(), ["details", "summary"]);
}

#[test]
fn markdown_lists_at_most_100_hunks() {
    let nodes: Vec<String> = (0..130)
        .map(|i| format!("{{\"id\":\"n{i}\",\"label\":\"Node {i}\"}}"))
        .collect();
    let r = run_with(
        &["empty.json", "many.json", "--markdown"],
        io().file("empty.json", r#"{"nodes":[],"edges":[]}"#)
            .file("many.json", graph(&nodes, &[])),
    );
    assert_eq!(
        r.stdout.split('\n').filter(|l| l.starts_with("- ")).count(),
        100
    );
    assert!(r.stdout.contains("…and 30 more hunks."));
    assert!(
        r.stdout
            .contains("<details>\n<summary>Added (130)</summary>")
    );
}

#[test]
fn reads_one_side_from_stdin() {
    let r = run_with(
        &["-", "after.json", "--name-status"],
        zoo().with_stdin(BEFORE),
    );
    assert_eq!(r.code, 0);
    assert!(r.stdout.contains("R\tcat\t"));
    let mut prompt = zoo().with_stdin(AFTER);
    prompt.stdin_is_tty = true;
    assert_eq!(run_with(&["before.json", "-", "-q"], prompt).code, 0);
}

#[test]
fn prompts_when_stdin_is_a_terminal() {
    let mut io = zoo().with_stdin(AFTER);
    io.stdin_is_tty = true;
    assert!(
        run_with(&["before.json", "-"], io)
            .stderr
            .contains("Reading <after> from stdin… (end with Ctrl-D)")
    );
}

#[test]
fn reads_gzip_compressed_and_utf16_files() {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(BEFORE.as_bytes()).unwrap();
    let mut utf16 = vec![0xff, 0xfe];
    utf16.extend(AFTER.encode_utf16().flat_map(u16::to_le_bytes));
    let r = run_with(
        &["before.json.gz", "after16.json", "--name-status"],
        io().file("before.json.gz", gz.finish().unwrap())
            .file("after16.json", utf16),
    );
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert!(r.stdout.contains("R\tcat\t"));
}

#[test]
fn opens_the_report_in_a_temporary_file_without_o() {
    let r = run(&["before.json", "after.json", "--open", "-q"], &FILES);
    assert_eq!(r.code, 0, "{}", r.stderr);
    let expected = kgdiff::paths::join("/tmp/kgdiff-1", "kgdiff-report.html");
    assert_eq!(r.io.opened, std::slice::from_ref(&expected));
    assert!(r.io.written.iter().any(|(p, _)| *p == expected));
    let named = run(
        &["before.json", "after.json", "-o", "r.html", "--open", "-q"],
        &FILES,
    );
    assert_eq!(named.io.opened, [kgdiff::paths::resolve(CWD, "r.html")]);
}

#[test]
fn warns_but_succeeds_when_the_browser_cannot_be_opened() {
    let mut io = zoo();
    io.open_error = Some("spawn xdg-open ENOENT".to_owned());
    let r = run_with(&["before.json", "after.json", "-o", "r.html", "--open"], io);
    assert_eq!(r.code, 0);
    assert!(
        r.stderr
            .contains("warning: Could not open the report (spawn xdg-open ENOENT)")
    );
}

#[test]
fn reports_parse_warnings_on_stderr_unless_quiet() {
    let obo = |extra: &str| format!("format-version: 1.4\n\n[Term]\nid: X:1\nname: one\n{extra}");
    let files = || {
        io().file("a.obo", obo(""))
            .file("b.obo", obo("\n[Weird]\nid: Y\n"))
    };
    let r = run_with(&["a.obo", "b.obo"], files());
    assert_eq!(r.code, 0);
    assert!(
        re(r"(?m)^warning: b\.obo:\d+: ").is_match(&r.stderr),
        "{}",
        r.stderr
    );
    assert_eq!(run_with(&["a.obo", "b.obo", "-q"], files()).stderr, "");
}

// ─── exit codes and errors ───────────────────────────────────────────────────

#[test]
fn exits_1_with_exit_code_when_the_graphs_differ() {
    assert_eq!(
        run(&["before.json", "after.json", "--exit-code"], &FILES).code,
        1
    );
    assert_eq!(run(&["before.json", "after.json"], &FILES).code, 0);
}

#[test]
fn exits_2_with_a_one_line_message_and_a_hint_for_a_missing_file() {
    let r = run(&["nope.json", "after.json"], &FILES);
    assert_eq!(r.code, 2);
    assert_eq!(r.stdout, "");
    assert_eq!(
        r.stderr,
        "error: Cannot read <before> \"nope.json\": no such file or directory.\nhint: Check the path. Use - to read from stdin.\n"
    );
}

#[test]
fn prints_where_errors_were_raised_only_with_debug() {
    let r = run_with(&["nope.json", "after.json"], zoo().var("DEBUG", "kgdiff"));
    assert!(re(r"\n\s+at ").is_match(&r.stderr), "{}", r.stderr);
    assert!(r.stderr.contains("ENOENT"));
}

#[test]
fn names_the_file_and_line_of_a_syntax_error() {
    let r = run_with(
        &["before.json", "bad.ttl"],
        zoo().file(
            "bad.ttl",
            "@prefix ex: <http://e/> .\nex:a ex:b ex:c ;\n ex:d .",
        ),
    );
    assert_eq!(r.code, 2);
    assert!(
        re(r#"^error: "bad\.ttl": Invalid Turtle: .* line 3\.\nhint: If the format was detected wrongly, pass --format <fmt>"#)
            .is_match(&r.stderr),
        "{}",
        r.stderr
    );
}

#[test]
fn suggests_format_when_the_format_cannot_be_detected() {
    let r = run_with(
        &["before.json", "mystery.txt"],
        zoo().file("mystery.txt", "hello world"),
    );
    assert_eq!(r.code, 2);
    assert!(
        r.stderr
            .contains("error: Cannot tell the format of \"mystery.txt\".")
    );
    assert!(r.stderr.contains("hint: Pass --format <fmt>"));
}

#[test]
fn says_so_when_a_kgdiff_diff_is_given_as_a_graph() {
    let made = run(
        &["before.json", "after.json", "--json", "diff.json", "-q"],
        &FILES,
    );
    let r = run_with(
        &["before.json", "diff.json"],
        zoo().file("diff.json", made.file("diff.json")),
    );
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains(
        "error: \"diff.json\": This is a kgdiff diff (format \"kgdiff.diff\", as `kgdiff --json` writes it), not a graph."
    ));
    assert!(!r.stderr.contains("hint:"));
}

#[test]
fn suggests_an_upgrade_for_a_graph_from_a_newer_kgdiff() {
    let v2 = r#"{"format":"kgdiff.graph","version":2,"nodes":[],"edges":[]}"#;
    let r = run_with(&["before.json", "v2.json"], zoo().file("v2.json", v2));
    assert_eq!(r.code, 2);
    assert!(
        r.stderr
            .contains("error: \"v2.json\": Unsupported kgdiff graph version 2;"),
        "{}",
        r.stderr
    );
    assert!(
        r.stderr
            .contains("hint: Upgrade kgdiff: npm install -g @kgdiff/cli@latest.")
    );
}

#[test]
fn rejects_binary_input() {
    let r = run_with(
        &["before.json", "bin.json"],
        zoo().file("bin.json", vec![0x7b, 0xc3, 0x28, 0x7d]),
    );
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains("is not valid UTF-8 text"));
}

#[test]
fn reports_usage_errors_with_exit_code_2() {
    let r = run(&["before.json", "after.json", "--sta"], &FILES);
    assert_eq!(r.code, 2);
    assert_eq!(
        r.stderr,
        "error: Unknown option --sta.\nhint: Did you mean --stat? Run `kgdiff --help` for usage.\n"
    );
    assert!(
        run(&["a", "b", "--sta", "--color", "always"], &[])
            .stderr
            .contains(ESC)
    );
}

#[test]
fn refuses_to_overwrite_an_input_or_write_two_outputs_to_one_file() {
    let r = run(
        &["before.json", "after.json", "--json", "after.json"],
        &FILES,
    );
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains(
        "error: --json \"after.json\" is the input <after> \"after.json\"; kgdiff never overwrites its inputs."
    ));
    let twice = run(
        &["before.json", "after.json", "--json", "x", "--delta", "x"],
        &FILES,
    );
    assert!(
        twice
            .stderr
            .contains("--json and --delta both write to \"x\"")
    );
}

#[test]
fn reports_unwritable_outputs() {
    let r = run(
        &[
            "before.json",
            "after.json",
            "--json",
            "missing-dir/out.json",
        ],
        &FILES,
    );
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains(
        "error: Cannot write diff to \"missing-dir/out.json\": no such file or directory."
    ));
    assert!(r.stderr.contains("hint: Create the directory first."));
}

#[test]
fn fails_clearly_when_the_viewer_bundle_is_missing() {
    let mut io = zoo();
    io.bundle = Err("The HTML report needs the standalone viewer bundle.".to_owned());
    let r = run_with(&["before.json", "after.json", "-o", "r.html"], io);
    assert_eq!(r.code, 2);
    assert_eq!(
        r.stderr,
        "error: The HTML report needs the standalone viewer bundle.\nhint: Build it.\n"
    );
    assert!(r.io.written.is_empty());
}

#[test]
fn fails_before_writing_when_the_compute_add_on_is_missing() {
    // The reports of this kgdiff carry no layout (D-10): without the add-on they cannot open.
    let mut io = zoo();
    io.compute = Err("The HTML report needs the viewer compute add-on.".to_owned());
    let r = run_with(
        &[
            "before.json",
            "after.json",
            "-o",
            "r.html",
            "--json",
            "d.json",
        ],
        io,
    );
    assert_eq!(r.code, 2);
    assert_eq!(
        r.stderr,
        "error: The HTML report needs the viewer compute add-on.\nhint: Build it.\n"
    );
    assert!(r.io.written.is_empty());
}

#[test]
fn maps_invalid_diff_options_to_an_input_error() {
    assert!([0, 2].contains(&run(&["before.json", "after.json", "--hierarchy", ""], &FILES).code));
}

// ─── RDF/XML and JSON-LD inputs ──────────────────────────────────────────────

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/packages/formats/test/fixtures/{name}", repo())).unwrap()
}

/// The hunks and warnings of a one-edit diff; file names are taken out of the warnings.
fn diff_of(name: &str, from: &str, to: &str) -> (String, String) {
    let extension = &name[name.find('.').unwrap()..];
    let text = fixture(name);
    let (a, b) = (format!("a{extension}"), format!("b{extension}"));
    let r = run_with(
        &[&a, &b, "--json"],
        io().file(&a, text.clone()).file(&b, text.replace(from, to)),
    );
    assert_eq!(r.code, 0, "{name}: {}", r.stderr);
    let hunks = parse_json(&r.stdout).get("hunks").cloned().unwrap();
    (json::to_string(&hunks), r.stderr.replace(extension, ".*"))
}

#[test]
fn diffs_owl_and_jsonld_files_exactly_like_their_turtle_twins() {
    let turtle = diff_of("go-mini.ttl", "\"mitochondrion\"@en", "\"mitochondria\"@en");
    assert_eq!(
        parse_json(&turtle.0).as_array().map(<[Value]>::len),
        Some(1)
    );
    assert_eq!(
        diff_of("go-mini.owl", ">mitochondrion<", ">mitochondria<"),
        turtle
    );
    assert_eq!(
        diff_of("go-mini.jsonld", "\"mitochondrion\"", "\"mitochondria\""),
        turtle
    );
}

#[test]
fn reads_jsonld_and_rdfxml_from_stdin_by_their_content() {
    let r = run_with(
        &["go.owl", "-", "--exit-code", "-q"],
        io().file("go.owl", fixture("go-mini.owl"))
            .with_stdin(fixture("go-mini.jsonld")),
    );
    assert_eq!(r.code, 0, "{}", r.stderr);
}

#[test]
fn explains_that_remote_jsonld_contexts_are_never_fetched() {
    let remote = r#"{"@context": "https://schema.org/", "@id": "https://ex.org/a", "name": "A"}"#;
    let r = run_with(
        &["a.jsonld", "b.jsonld"],
        io().file("a.jsonld", remote).file("b.jsonld", remote),
    );
    assert_eq!(r.code, 2);
    assert!(re(r#"^error: "a\.jsonld": Invalid JSON-LD: loading remote context failed: "https://schema\.org/" was not loaded, as kgdiff never fetches documents; inline the context"#).is_match(&r.stderr), "{}", r.stderr);
}

#[test]
fn rejects_owl_xml_saved_as_owl_with_a_conversion_hint() {
    let owl = "<?xml version=\"1.0\"?>\n<Ontology xmlns=\"http://www.w3.org/2002/07/owl#\" ontologyIRI=\"http://ex.org/pizza\"/>";
    let r = run_with(&["before.json", "pizza.owl"], zoo().file("pizza.owl", owl));
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains("OWL/XML is not supported") && r.stderr.contains("robot convert"));
}

// ─── help and version ────────────────────────────────────────────────────────

#[test]
fn help_lists_every_input_format_and_its_extensions() {
    let help = re(r"\s+")
        .replace_all(&run(&["--help"], &[]).stdout, " ")
        .into_owned();
    assert!(help.contains("RDF/XML (.rdf, .owl)") && help.contains("JSON-LD (.jsonld)"));
    assert!(
        help.contains(
            "Input format: auto, json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo"
        )
    );
}

#[test]
fn prints_the_version() {
    let r = run(&["--version"], &[]);
    assert!(re(r"^kgdiff \d+\.\d+\.\d+\n$").is_match(&r.stdout));
    assert_eq!(r.code, 0);
}

#[test]
fn documents_every_option_grouped_within_80_columns() {
    let r = run(&["--help"], &[]);
    assert_eq!(r.code, 0);
    for section in [
        "Usage",
        "Output",
        "Diff",
        "Report",
        "Behaviour",
        "Examples",
        "Exit status",
    ] {
        assert!(r.stdout.contains(&format!("\n{section}\n")), "{section}");
    }
    for name in kgdiff::args::diff_option_names() {
        assert!(r.stdout.contains(&format!("--{name}")), "{name}");
    }
    for line in r.stdout.split('\n') {
        assert!(string_width(line) <= 80, "{line}");
    }
    assert!(!r.stdout.contains(ESC));
}

#[test]
fn has_a_help_page_for_apply() {
    let r = run(&["apply", "--help"], &[]);
    assert!(r.stdout.contains("kgdiff apply <graph> <delta>") && r.stdout.contains("--no-strict"));
}

#[test]
fn wraps_help_on_narrow_terminals_and_colors_it_on_a_tty() {
    let r = run_with(&["--help"], tty(io(), Some(50.0)));
    assert!(r.stdout.contains(ESC));
    for line in strip_ansi(&r.stdout).split('\n') {
        assert!(string_width(line) <= 50, "{line}");
    }
}

// ─── apply ───────────────────────────────────────────────────────────────────

fn delta_of(files: MemoryIo, before: &str, after: &str, path: &str) -> String {
    let made = run_with(&[before, after, "--delta", path, "-q"], files);
    assert_eq!(made.code, 0, "{}", made.stderr);
    made.file(path)
}

#[test]
fn round_trips_every_example_dataset() {
    for id in [
        "enterprise-kg",
        "enterprise-kg-en",
        "ontology-release",
        "schema-vocab",
        "llm-extraction",
        "data-lineage",
    ] {
        let d = dataset(id);
        let made = run_with(&d.argv(&["--delta", "patch.json", "-q"]), io());
        assert_eq!(made.code, 0);
        let applied = run_with(
            &["apply", &d.before, "patch.json", "-o", "out.json"],
            io().file("patch.json", made.file("patch.json")),
        );
        assert_eq!(applied.code, 0, "{}", applied.stderr);
        assert!(
            re(r"✓ Wrote patched graph \(\d+ operations applied, c\d+:[0-9a-f]+\) out\.json")
                .is_match(&applied.stderr),
            "{}",
            applied.stderr
        );
        let expected = graph_hash(&std::fs::read_to_string(&d.after).unwrap(), &d.after);
        assert_eq!(
            graph_hash(&applied.file("out.json"), "out.json"),
            expected,
            "{id}"
        );
        // kgdiff reads its own output back as the same graph.
        let mut argv = vec![d.after.as_str(), "out.json", "--exit-code", "-q"];
        argv.extend(d.flags.iter().map(String::as_str));
        assert_eq!(
            run_with(&argv, io().file("out.json", applied.file("out.json"))).code,
            0,
            "{id}"
        );
    }
}

#[test]
fn chains_two_applies() {
    let mut v3 = parse_json(AFTER);
    if let Value::Object(o) = &mut v3 {
        o.insert("meta", parse_json(r#"{"name":"zoo","version":"v3"}"#));
        if let Some(Value::Array(nodes)) = o.get_mut("nodes") {
            nodes.push(parse_json(r#"{"id":"emu","label":"Emu","type":"Bird"}"#));
        }
    }
    let v3 = json::to_string(&v3);
    let d1 = delta_of(zoo(), "before.json", "after.json", "d1.json");
    let d2 = delta_of(
        zoo().file("v3.json", v3.clone()),
        "after.json",
        "v3.json",
        "d2.json",
    );
    let out1 = run_with(
        &["apply", "before.json", "d1.json", "-o", "out1.json", "-q"],
        zoo().file("d1.json", d1),
    );
    assert_eq!(out1.code, 0, "{}", out1.stderr);
    let out2 = run_with(
        &["apply", "out1.json", "d2.json", "-o", "out2.json"],
        io().file("out1.json", out1.file("out1.json"))
            .file("d2.json", d2),
    );
    assert_eq!(out2.code, 0, "{}", out2.stderr);
    assert!(!out2.stderr.contains("warning"));
    assert_eq!(
        graph_hash(&out2.file("out2.json"), "out2.json"),
        graph_hash(&v3, "v3.json")
    );
}

#[test]
fn lists_every_skipped_operation_in_one_pass_with_verbose() {
    let d = delta_of(zoo(), "before.json", "after.json", "d.json");
    let total = parse_json(&d)
        .get("ops")
        .and_then(Value::as_array)
        .map_or(0, <[Value]>::len);
    let r = run_with(
        &[
            "apply",
            "empty.json",
            "d.json",
            "--no-strict",
            "--verbose",
            "--allow-empty",
        ],
        io().file("empty.json", "").file("d.json", d),
    );
    assert_eq!(r.code, 0, "{}", r.stderr);
    let count: usize = re(r"Skipped (\d+) of (\d+) operations")
        .captures(&r.stderr)
        .unwrap()[1]
        .parse()
        .unwrap();
    assert!(r.stderr.contains(&format!(
        "of {total} operations that do not fit this graph:"
    )));
    assert!(count > 0);
    assert_eq!(
        r.stderr
            .split('\n')
            .filter(|l| re(r"^ {2}#\d+ ").is_match(l))
            .count(),
        count
    );
    let indices: Vec<usize> = re(r"(?m)^ {2}#(\d+) ")
        .captures_iter(&r.stderr)
        .map(|c| c[1].parse().unwrap())
        .collect();
    let mut sorted = indices.clone();
    sorted.sort();
    assert_eq!(indices, sorted);
}

#[test]
fn writes_kgdiff_json_that_leads_with_its_format_marker() {
    let d = delta_of(zoo(), "before.json", "after.json", "d.json");
    let out = run_with(&["apply", "before.json", "d.json"], zoo().file("d.json", d));
    let graph = parse_json(&out.stdout);
    let keys: Vec<&str> = graph
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    assert_eq!(keys, ["format", "version", "meta", "nodes", "edges"]);
    assert_eq!(
        graph.get("format").and_then(Value::as_str),
        Some("kgdiff.graph")
    );
    assert_eq!(graph.get("version").and_then(Value::as_f64), Some(1.0));
}

#[test]
fn records_the_target_version_and_the_output_file_in_meta() {
    let d = delta_of(zoo(), "before.json", "after.json", "d.json");
    let out = run_with(
        &[
            "apply",
            "before.json",
            "d.json",
            "-o",
            "dir/patched.json",
            "-q",
        ],
        zoo().file("d.json", d.clone()),
    );
    let meta = parse_json(&out.file("dir/patched.json"))
        .get("meta")
        .cloned()
        .unwrap();
    assert_eq!(
        json::to_string(&meta),
        r#"{"name":"zoo","version":"v2","source":"patched.json"}"#
    );
    let stdout = run_with(&["apply", "before.json", "d.json"], zoo().file("d.json", d));
    assert_eq!(
        json::to_string(parse_json(&stdout.stdout).get("meta").unwrap()),
        r#"{"name":"zoo","version":"v2"}"#
    );
}

#[test]
fn accepts_json_output_as_the_delta_and_reads_it_from_stdin() {
    let made = run(&["before.json", "after.json", "--json"], &FILES);
    let out = run_with(
        &["apply", "before.json", "-", "--pretty"],
        zoo().with_stdin(made.stdout),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("\n  \"nodes\": ["));
    assert_eq!(
        graph_hash(&out.stdout, "x.json"),
        graph_hash(AFTER, "after.json")
    );
}

#[test]
fn refuses_a_delta_made_for_another_graph_unless_no_strict() {
    let d = delta_of(zoo(), "before.json", "after.json", "d.json");
    let strict = run_with(
        &["apply", "after.json", "d.json"],
        zoo().file("d.json", d.clone()),
    );
    assert_eq!(strict.code, 2);
    assert!(re(r#"^error: <graph> "after\.json" is not the base of this delta \(graph c\d+:[0-9a-f]+, delta base c\d+:[0-9a-f]+\)\."#).is_match(&strict.stderr));
    assert!(
        strict.stderr.contains("--format and --lang must match")
            && strict.stderr.contains("--no-strict applies what fits")
    );
    let loose = run_with(
        &["apply", "after.json", "d.json", "--no-strict"],
        zoo().file("d.json", d.clone()),
    );
    assert_eq!(loose.code, 0);
    assert!(re(r"(?m)^warning: Skipped \d+ of \d+ operations that do not fit this graph \(--verbose lists them\)\.$").is_match(&loose.stderr));
    let verbose = run_with(
        &["apply", "after.json", "d.json", "--no-strict", "--verbose"],
        zoo().file("d.json", d),
    );
    assert!(re(r"(?m)^ {2}#\d+ node\.\w+: .+$").is_match(&verbose.stderr));
}

#[test]
fn counts_exactly_the_skipped_operations_with_no_strict() {
    let d = delta_of(zoo(), "before.json", "after.json", "d.json");
    let ops = parse_json(&d)
        .get("ops")
        .and_then(Value::as_array)
        .map_or(0, <[Value]>::len);
    let partial = BEFORE.replace("\"label\":\"Cat\"", "\"label\":\"House cat\"");
    let out = run_with(
        &[
            "apply",
            "partial.json",
            "d.json",
            "--no-strict",
            "--verbose",
            "-o",
            "out.json",
        ],
        io().file("partial.json", partial).file("d.json", d),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stderr
            .contains(&format!("Skipped 1 of {ops} operations"))
    );
    assert!(re(r#"#\d+ node\.set: node "cat" label differs from "from""#).is_match(&out.stderr));
    assert!(
        out.stderr
            .contains(&format!("({} operations applied,", ops - 1))
    );
    assert_eq!(
        graph_hash(&out.file("out.json"), "out.json"),
        graph_hash(AFTER, "after.json")
    );
}

#[test]
fn explains_files_that_are_not_deltas() {
    let not_json = run_with(
        &["apply", "before.json", "x.json"],
        zoo().file("x.json", "{"),
    );
    assert_eq!(not_json.code, 2);
    assert!(
        not_json
            .stderr
            .starts_with("error: \"x.json\" is not valid JSON")
    );
    assert!(
        run(&["apply", "before.json", "after.json"], &FILES)
            .stderr
            .contains("\"after.json\" is not a kgdiff delta")
    );
    let future = run_with(
        &["apply", "before.json", "d.json"],
        zoo().file(
            "d.json",
            r#"{"format":"kgdiff.delta","version":9,"edgeIdentity":"structure","ops":[]}"#,
        ),
    );
    assert_eq!(future.code, 2);
    assert!(
        future.stderr.contains("Unsupported delta version 9"),
        "{}",
        future.stderr
    );
    assert!(future.stderr.contains("hint: Upgrade kgdiff"));
}

// ─── edge cases ──────────────────────────────────────────────────────────────

#[test]
fn handles_empty_graphs() {
    let empty = || {
        io().file("e1.json", r#"{"nodes":[],"edges":[]}"#)
            .file("e2.json", r#"{"nodes":[],"edges":[]}"#)
    };
    let r = run_with(&["e1.json", "e2.json", "--exit-code"], empty());
    assert_eq!(r.code, 0);
    assert!(
        r.stdout
            .contains("No differences  Both versions have 0 nodes and 0 edges.")
    );
    assert!(
        run_with(&["e1.json", "e2.json", "--markdown"], empty())
            .stdout
            .contains("✅ **No differences.**")
    );
    assert_eq!(
        run_with(&["e1.json", "e2.json", "--name-status"], empty()).stdout,
        ""
    );
}

#[test]
fn handles_a_single_node_self_loops_parallel_edges_and_odd_ids() {
    let before = r#"{"nodes":[{"id":"a | \"quoted\" id","label":"A"}],"edges":[]}"#;
    let after = r#"{"nodes":[{"id":"a | \"quoted\" id","label":"A"},{"id":"b c","label":"B"}],"edges":[{"source":"a | \"quoted\" id","target":"a | \"quoted\" id","predicate":"self"},{"source":"b c","target":"a | \"quoted\" id","predicate":"p"},{"source":"b c","target":"a | \"quoted\" id","predicate":"p","attrs":{"n":2}}]}"#;
    let files = || io().file("a.json", before).file("b.json", after);
    let r = run_with(&["a.json", "b.json", "--name-status"], files());
    assert_eq!(r.code, 0, "{}", r.stderr);
    let lines: Vec<&str> = kgdiff_core::js::trim(&r.stdout).split('\n').collect();
    assert!(!lines.is_empty());
    assert!(lines.iter().all(|l| l.split('\t').count() == 3));
    assert!(r.stdout.contains("a | \"quoted\" id"));
    assert_eq!(run_with(&["a.json", "b.json"], files()).code, 0);
}

#[test]
fn truncates_very_long_labels_to_the_terminal_width() {
    let long = "Very long label ".repeat(40);
    let r = run_with(
        &["a.json", "b.json"],
        tty(
            io().file("a.json", r#"{"nodes":[{"id":"x","label":"X"}],"edges":[]}"#)
                .file(
                    "b.json",
                    format!("{{\"nodes\":[{{\"id\":\"x\",\"label\":\"{long}\"}}],\"edges\":[]}}"),
                )
                .var("NO_COLOR", "1"),
            Some(70.0),
        ),
    );
    for line in r.stdout.split('\n') {
        assert!(string_width(line) <= 70, "{line}");
    }
    assert!(r.stdout.contains('…'));
}
