//! Overwrite protection (in memory and on the
//! real file system), escape and bidi injection, Markdown neutralization, empty and oversized
//! inputs (gzip bombs), terminal widths and command-line corner cases.

mod common;

use std::borrow::Cow;
use std::io::Write;

use common::{dataset, io, re, run, run_with};
use kgdiff::commands::output_width;

use kgdiff::inputs::{DEFAULT_MAX_INPUT, max_input_bytes};
use kgdiff::io::{CliIo, Env, FileStat, StdinError, ViewerBundle, ViewerMissing};
use kgdiff::style::{ColorMode, resolve_color_level};
use kgdiff::system::SystemIo;
use kgdiff::testing::MemoryIo;
use kgdiff_report::escape_markdown;
use kgdiff_report::strip_ansi;
use kgdiff_report::width::{sanitize, string_width};

const ESC: &str = "\u{1b}";
const BEL: &str = "\u{7}";
const RLO: &str = "\u{202e}";
const ZWSP: &str = "\u{200b}";
const A: &str = r#"{"nodes":[{"id":"a","label":"A"}],"edges":[]}"#;
const B: &str = r#"{"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"edges":[]}"#;

fn ab() -> MemoryIo {
    io().file("a.json", A).file("b.json", B)
}

/// A JSON string literal of `text`, for building graphs.
fn quoted(text: &str) -> String {
    let mut out = String::new();
    kgdiff_core::js::json::push_string(&mut out, text);
    out
}

fn graph_of_labels(labels: &[String]) -> String {
    let nodes: Vec<String> = labels
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{{\"id\":\"n{i}\",\"label\":{}}}", quoted(l)))
        .collect();
    format!("{{\"nodes\":[{}],\"edges\":[]}}", nodes.join(","))
}

// ─── outputs never overwrite inputs ──────────────────────────────────────────

#[test]
fn sees_through_case_variants_on_case_insensitive_file_systems() {
    let r = run_with(
        &["a.json", "b.json", "--json", "A.json"],
        ab().case_insensitive(),
    );
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains("kgdiff never overwrites its inputs"));
    assert!(r.io.written.is_empty());
}

#[test]
fn sees_through_symlinks_and_hard_links() {
    let r = run_with(
        &["a.json", "b.json", "--markdown", "alias.md"],
        ab().link("alias.md", "b.json"),
    );
    assert_eq!(r.code, 2);
    assert!(
        r.stderr
            .contains("--markdown \"alias.md\" is the input <after> \"b.json\"")
    );
}

#[test]
fn refuses_two_outputs_that_are_one_file() {
    let r = run_with(
        &["a.json", "b.json", "--json", "X.json", "--delta", "x.json"],
        ab(),
    );
    assert_eq!(r.code, 2);
    assert!(
        r.stderr
            .contains("--json and --delta both write to \"x.json\"")
    );
}

#[test]
fn applies_to_kgdiff_apply_too() {
    let made = run_with(&["a.json", "b.json", "--delta", "d.json", "-q"], ab());
    for target in ["a.json", "d.json", "./a.json"] {
        let r = run_with(
            &["apply", "a.json", "d.json", "-o", target],
            io().file("a.json", A).file("d.json", made.file("d.json")),
        );
        assert_eq!(r.code, 2, "{target}");
        assert!(r.stderr.contains("kgdiff never overwrites its inputs"));
        assert!(r.io.written.is_empty());
    }
}

/// The real file system under `cwd`, with captured streams.
struct RealFs {
    mem: MemoryIo,
    sys: SystemIo,
    cwd: String,
}

impl Env for RealFs {
    fn var(&self, name: &str) -> Option<String> {
        Env::var(&self.mem, name)
    }
}

impl CliIo for RealFs {
    fn write_stdout(&mut self, text: &str) {
        self.mem.write_stdout(text);
    }
    fn write_stderr(&mut self, text: &str) {
        self.mem.write_stderr(text);
    }
    fn read_stdin(&mut self, max_bytes: u64) -> Result<Vec<u8>, StdinError> {
        self.mem.read_stdin(max_bytes)
    }
    fn read_file(&mut self, path: &str) -> std::io::Result<Vec<u8>> {
        self.sys.read_file(path)
    }
    fn write_file(&mut self, path: &str, data: &[u8]) -> std::io::Result<()> {
        self.sys.write_file(path, data)
    }
    fn stat(&mut self, path: &str) -> std::io::Result<Option<FileStat>> {
        self.sys.stat(path)
    }
    fn realpath(&mut self, path: &str) -> std::io::Result<String> {
        self.sys.realpath(path)
    }
    fn cwd(&self) -> String {
        self.cwd.clone()
    }
    fn is_tty(&self) -> bool {
        false
    }
    fn stderr_is_tty(&self) -> bool {
        false
    }
    fn stdin_is_tty(&self) -> bool {
        false
    }
    fn columns(&self) -> Option<f64> {
        None
    }
    fn runtime(&self) -> Option<String> {
        None
    }
    fn now(&mut self) -> std::io::Result<String> {
        self.mem.now()
    }
    fn make_temp_dir(&mut self) -> std::io::Result<String> {
        self.mem.make_temp_dir()
    }
    fn open_file(&mut self, path: &str) -> std::io::Result<()> {
        self.mem.open_file(path)
    }
    fn viewer_bundle(&mut self, part: ViewerBundle) -> Result<Cow<'static, str>, ViewerMissing> {
        self.mem.viewer_bundle(part)
    }
}

struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new(name: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("kgdiff-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.canonicalize().unwrap().to_string_lossy().into_owned();
        // Windows' verbatim prefix, which paths as users write them never have.
        TempDir(std::path::PathBuf::from(
            real.strip_prefix(r"\\?\").unwrap_or(&real),
        ))
    }
    fn path(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
    fn io(&self) -> RealFs {
        RealFs {
            mem: MemoryIo::new("/"),
            sys: SystemIo::default(),
            cwd: self.0.to_string_lossy().into_owned(),
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn refuses_symlinks_hard_links_and_case_variants_on_the_real_file_system() {
    let dir = TempDir::new("links");
    std::fs::write(dir.path("a.json"), A).unwrap();
    std::fs::write(dir.path("b.json"), B).unwrap();
    #[cfg(unix)]
    let symlinked = std::os::unix::fs::symlink(dir.path("a.json"), dir.path("sym.json")).is_ok();
    #[cfg(windows)]
    // Windows refuses symlinks without Developer Mode or elevated rights.
    let symlinked =
        std::os::windows::fs::symlink_file(dir.path("a.json"), dir.path("sym.json")).is_ok();
    std::fs::hard_link(dir.path("b.json"), dir.path("hard.json")).unwrap();
    let case_folding = dir.path("A.JSON").exists();
    let mut targets = vec!["hard.json"];
    if symlinked {
        targets.push("sym.json");
    }
    if case_folding {
        targets.push("A.json");
    }
    for target in targets {
        let code = kgdiff::cli::run(
            &args(&["a.json", "b.json", "--json", target]),
            &mut dir.io(),
        );
        assert_eq!(code, 2, "{target}");
    }
    assert_eq!(std::fs::read_to_string(dir.path("a.json")).unwrap(), A);
    assert_eq!(std::fs::read_to_string(dir.path("b.json")).unwrap(), B);
}

#[test]
fn writes_atomically_keeps_permissions_and_leaves_no_temporary_files() {
    let dir = TempDir::new("atomic");
    std::fs::write(dir.path("a.json"), A).unwrap();
    std::fs::write(dir.path("b.json"), B).unwrap();
    std::fs::write(dir.path("out.json"), "old").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path("out.json"), std::fs::Permissions::from_mode(0o640))
            .unwrap();
    }
    let mut io = dir.io();
    let code = kgdiff::cli::run(
        &args(&["a.json", "b.json", "--json", "out.json", "-q"]),
        &mut io,
    );
    assert_eq!(code, 0, "{}", io.mem.stderr);
    assert!(
        std::fs::read_to_string(dir.path("out.json"))
            .unwrap()
            .contains("\"format\":\"kgdiff.diff\"")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path("out.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
    let temps: Vec<String> = std::fs::read_dir(&dir.0)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect();
    assert!(temps.is_empty(), "{temps:?}");
}

// ─── no escape sequences or bidi controls reach the terminal ─────────────────

fn evil() -> String {
    format!("{ESC}]8;;https://evil.example/{BEL}click{ESC}]8;;{BEL}{ESC}[2J")
}

#[test]
fn sanitizes_parser_messages_that_quote_the_input() {
    for (name, text) in [
        ("bad.json", format!("{{\"nodes\": [{}]}}", evil())),
        (
            "bad.ttl",
            format!("@prefix ex: <http://e/> .\nex:a ex:b {} .", evil()),
        ),
    ] {
        let r = run_with(&["a.json", name], io().file("a.json", A).file(name, text));
        assert_eq!(r.code, 2, "{name}");
        assert!(
            !r.stderr.contains(ESC) && !r.stderr.contains(BEL),
            "{name}: {:?}",
            r.stderr
        );
    }
}

#[test]
fn sanitizes_json_parse_excerpts_of_a_broken_delta() {
    let r = run_with(
        &["apply", "a.json", "d.json"],
        io().file("a.json", A).file(
            "d.json",
            format!("{{\"format\": \"kgdiff.delta\", {}", evil()),
        ),
    );
    assert_eq!(r.code, 2);
    assert!(r.stderr.starts_with("error: \"d.json\" is not valid JSON"));
    assert!(!r.stderr.contains(ESC) && !r.stderr.contains(BEL));
}

#[test]
fn sanitizes_file_names_in_errors_warnings_and_traces() {
    let name = format!("missing{ESC}[31m{RLO}.json");
    let r = run_with(
        &[&name, "b.json"],
        io().file("b.json", B).var("DEBUG", "kgdiff"),
    );
    assert_eq!(r.code, 2);
    assert!(!r.stderr.contains(ESC) && !r.stderr.contains(RLO));
    assert!(r.stderr.contains("⟨U+202E⟩"));
}

#[test]
fn reveals_bidi_and_invisible_characters_in_labels_and_keeps_emoji_joiners() {
    let family = "\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}";
    let labels = [
        format!("admin{RLO}txt.exe"),
        format!("zero{ZWSP}width\u{feff}"),
        "iso\u{2067}late".to_owned(),
        family.to_owned(),
    ];
    let after = graph_of_labels(&labels);
    for flags in [&[][..], &["--name-status"][..], &["--markdown"][..]] {
        let mut argv = vec!["a.json", "after.json"];
        argv.extend(flags);
        let r = run_with(
            &argv,
            io().file("a.json", A).file("after.json", after.clone()),
        );
        assert_eq!(r.code, 0);
        for hidden in [RLO, "\u{feff}", "\u{2067}"] {
            assert!(!r.stdout.contains(hidden), "{flags:?}");
        }
        assert!(r.stdout.contains("⟨U+202E⟩") && r.stdout.contains("⟨U+FEFF⟩"));
        assert!(r.stdout.contains(family));
    }
    assert_eq!(sanitize("a\u{9b}31m"), "a\u{fffd}31m");
    assert_eq!(escape_markdown("a\u{9b}31m"), "a31m");
}

// ─── Markdown neutralization ─────────────────────────────────────────────────

#[test]
fn defuses_emoji_shortcodes_references_mentions_autolinks_and_math() {
    assert_eq!(
        escape_markdown(":white_check_mark:"),
        format!(":{ZWSP}white\\_check\\_mark:")
    );
    assert_eq!(escape_markdown(":+1:"), format!(":{ZWSP}+1:"));
    assert_eq!(escape_markdown("see GH-123"), format!("see GH{ZWSP}-123"));
    assert_eq!(
        escape_markdown("org/repo#12"),
        format!("org/repo\\#{ZWSP}12")
    );
    assert_eq!(escape_markdown("@octocat"), format!("@{ZWSP}octocat"));
    assert_eq!(
        escape_markdown("https://evil.example/x"),
        format!("https://{ZWSP}evil.example/x")
    );
    assert_eq!(
        escape_markdown("www.evil.example"),
        format!("www{ZWSP}.evil.example")
    );
    assert_eq!(
        escape_markdown("$\\frac{a}{b}$ and $x$"),
        "\\$\\\\frac{a}{b}\\$ and \\$x\\$"
    );
    assert_eq!(
        escape_markdown("<!-- c --> & <b>"),
        "&lt;!-- c --&gt; &amp; &lt;b&gt;"
    );
    assert_eq!(escape_markdown(&format!("a{RLO}b")), "a⟨U+202E⟩b");
}

#[test]
fn neutralizes_whole_documents() {
    let after = graph_of_labels(&[":tada: GH-1 www.x.org $y$".to_owned()]);
    let r = run_with(
        &["a.json", "after.json", "--markdown"],
        io().file("a.json", A).file("after.json", after),
    );
    for bad in [":tada:", "GH-1", "www.x"] {
        assert!(!r.stdout.contains(bad), "{bad}");
    }
    // `(?<!\\)\$`: every dollar sign is escaped.
    for (i, _) in r.stdout.match_indices('$') {
        assert!(i > 0 && r.stdout.as_bytes()[i - 1] == b'\\');
    }
}

// ─── empty input ─────────────────────────────────────────────────────────────

#[test]
fn empty_input_is_an_error_unless_allow_empty() {
    for empty in ["", "  \n\t"] {
        let r = run_with(
            &["a.json", "empty.json"],
            io().file("a.json", A).file("empty.json", empty),
        );
        assert_eq!(r.code, 2);
        assert_eq!(
            r.stderr,
            "error: <after> \"empty.json\" is empty.\nhint: Pass --allow-empty to compare with an empty graph (e.g. before a first release).\n"
        );
    }
    let ok = run_with(
        &["empty.json", "b.json", "--allow-empty", "--name-status"],
        io().file("b.json", B).file("empty.json", ""),
    );
    assert_eq!(ok.code, 0);
    assert!(ok.stdout.contains("A\t"));
}

#[test]
fn points_at_the_pipe_for_empty_stdin() {
    let r = run_with(&["a.json", "-"], io().file("a.json", A).with_stdin(""));
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains("error: <after> (stdin) is empty."));
    assert!(r.stderr.contains("Did the command before the pipe fail?"));
}

#[test]
fn empty_input_is_an_error_for_deltas() {
    let r = run_with(
        &["apply", "a.json", "d.json"],
        io().file("a.json", A).file("d.json", ""),
    );
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains("error: <delta> \"d.json\" is empty."));
}

// ─── input size limit ────────────────────────────────────────────────────────

#[test]
fn reads_kgdiff_max_input() {
    let limit = |value: Option<&str>| {
        let io = match value {
            Some(v) => io().var("KGDIFF_MAX_INPUT", v),
            None => io(),
        };
        max_input_bytes(&io)
    };
    assert_eq!(limit(None).unwrap(), DEFAULT_MAX_INPUT);
    assert_eq!(DEFAULT_MAX_INPUT, 1024 * 1024 * 1024);
    assert_eq!(limit(Some("4096")).unwrap(), 4096);
    assert_eq!(limit(Some("2K")).unwrap(), 2048);
    assert_eq!(limit(Some("512M")).unwrap(), 512 * 1024 * 1024);
    assert_eq!(limit(Some("4G")).unwrap(), 4 * 1024 * 1024 * 1024);
    let Err(kgdiff::errors::Failure::Cli(e)) = limit(Some("lots")) else {
        panic!("expected an error")
    };
    assert!(e.message.starts_with("Invalid KGDIFF_MAX_INPUT"));
}

#[test]
fn stops_gzip_bombs() {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    gz.write_all(format!("{{\"nodes\": [], \"edges\": [] {}}}", " ".repeat(200_000)).as_bytes())
        .unwrap();
    let bomb = gz.finish().unwrap();
    assert!(bomb.len() < 1024);
    let r = run_with(
        &["a.json", "bomb.json.gz"],
        io().file("a.json", A)
            .file("bomb.json.gz", bomb.clone())
            .var("KGDIFF_MAX_INPUT", "64K"),
    );
    assert_eq!(r.code, 2);
    assert_eq!(
        r.stderr,
        "error: <after> \"bomb.json.gz\" (decompressed) is too large: the input limit is 64 KiB.\nhint: If the input is genuine, raise the limit with KGDIFF_MAX_INPUT (e.g. KGDIFF_MAX_INPUT=4G).\n"
    );
    let raised = run_with(
        &["a.json", "bomb.json.gz", "-q"],
        io().file("a.json", A)
            .file("bomb.json.gz", bomb)
            .var("KGDIFF_MAX_INPUT", "1M"),
    );
    assert_eq!(raised.code, 0, "{}", raised.stderr);
}

#[test]
fn reports_broken_gzip_as_node_does() {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(B.as_bytes()).unwrap();
    let whole = gz.finish().unwrap();
    // Node: `unexpected end of file`; bytes after a member are read as another member.
    let truncated = whole[..whole.len() - 6].to_vec();
    let r = run_with(
        &["a.json", "b.json.gz"],
        io().file("a.json", A).file("b.json.gz", truncated),
    );
    assert_eq!(
        r.stderr,
        "error: Cannot decompress <after> \"b.json.gz\": unexpected end of file.\n"
    );
    let mut trailing = whole.clone();
    trailing.extend_from_slice(b"garbage");
    let r = run_with(
        &["a.json", "b.json.gz"],
        io().file("a.json", A).file("b.json.gz", trailing),
    );
    assert_eq!(
        r.stderr,
        "error: Cannot decompress <after> \"b.json.gz\": incorrect header check.\n"
    );
    let mut crc = whole.clone();
    let at = crc.len() - 8;
    crc[at..at + 4].copy_from_slice(&[0, 0, 0, 0]);
    let r = run_with(
        &["a.json", "b.json.gz"],
        io().file("a.json", A).file("b.json.gz", crc),
    );
    assert_eq!(
        r.stderr,
        "error: Cannot decompress <after> \"b.json.gz\": incorrect data check.\n"
    );
    let mut twice = whole.clone();
    twice.extend_from_slice(&whole);
    let r = run_with(
        &["a.json", "b.json.gz"],
        io().file("a.json", A).file("b.json.gz", twice),
    );
    // Two members: the JSON twice, which is not JSON.
    assert_eq!(r.code, 2);
    assert!(r.stderr.contains("Invalid JSON"), "{}", r.stderr);
}

#[test]
fn limits_plain_files_and_stdin() {
    let nodes: Vec<String> = (0..200).map(|i| format!("{{\"id\":\"n{i}\"}}")).collect();
    let big = format!("{{\"nodes\":[{}],\"edges\":[]}}", nodes.join(","));
    let file = run_with(
        &["a.json", "big.json"],
        io().file("a.json", A)
            .file("big.json", big.clone())
            .var("KGDIFF_MAX_INPUT", "1K"),
    );
    assert!(
        file.stderr
            .contains("error: <after> \"big.json\" is too large: the input limit is 1 KiB.")
    );
    let stdin = run_with(
        &["a.json", "-"],
        io().file("a.json", A)
            .with_stdin(big)
            .var("KGDIFF_MAX_INPUT", "1K"),
    );
    assert!(stdin.stderr.contains("error: <after> (stdin) is too large"));
}

// ─── terminal width ──────────────────────────────────────────────────────────

#[test]
fn falls_back_when_a_terminal_reports_0_columns_and_clamps_to_40_120() {
    let width = |is_tty: bool, columns: Option<f64>, env: &[(&str, &str)]| {
        let mut io = MemoryIo::new("/work");
        io.is_tty = is_tty;
        io.columns = columns;
        for (k, v) in env {
            io = io.var(k, v);
        }
        output_width(&io)
    };
    assert_eq!(width(true, Some(0.0), &[]), 80);
    assert_eq!(width(true, Some(0.0), &[("COLUMNS", "100")]), 100);
    assert_eq!(width(true, Some(132.0), &[]), 120);
    assert_eq!(width(true, Some(25.0), &[]), 40);
    assert_eq!(width(false, None, &[]), 120);
    assert_eq!(width(false, None, &[("COLUMNS", "abc")]), 120);
}

#[test]
fn fits_every_line_at_every_width_from_40_to_130_columns() {
    for (d, locale) in [
        (dataset("enterprise-kg"), "zh-CN"),
        (dataset("ontology-release"), "en"),
    ] {
        for mode in [&[][..], &["--stat"][..], &["--name-status"][..]] {
            for columns in (30..=130).step_by(7) {
                let mut argv = d.argv(&["--locale", locale, "--limit", "0"]);
                argv.extend(mode);
                let mut terminal = io().var("COLORTERM", "truecolor");
                terminal.is_tty = true;
                terminal.columns = Some(f64::from(columns));
                let r = run_with(&argv, terminal);
                let max = usize::try_from(columns.clamp(40, 120)).unwrap();
                for line in strip_ansi(&r.stdout).split('\n') {
                    assert!(
                        string_width(line) <= max,
                        "{locale} {mode:?} {columns}: {line}"
                    );
                }
            }
        }
    }
}

// ─── command line ────────────────────────────────────────────────────────────

#[test]
fn accepts_a_dash_as_stdout_for_optional_value_outputs() {
    for flag in ["--json", "--delta", "--markdown"] {
        let r = run_with(&["a.json", "b.json", flag, "-"], ab());
        assert_eq!(r.code, 0, "{flag}");
        assert!(!r.stdout.is_empty());
        assert!(r.io.written.is_empty());
    }
}

#[test]
fn suggests_how_to_pass_values_that_start_with_a_dash() {
    let r = run_with(&["a.json", "b.json", "-o", "-x.html"], ab());
    assert_eq!(r.code, 2);
    assert!(
        r.stderr
            .contains("hint: If that is the value, write --html=-x.html or -o ./-x.html.")
    );
    assert!(
        run(&["a.json", "b.json", "--title", "-draft"], &[])
            .stderr
            .contains("write --title=-draft.")
    );
}

#[test]
fn pluralizes_totals() {
    let one = r#"{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"a","predicate":"self"}]}"#;
    let r = run(&["one.json", "one.json"], &[("one.json", one)]);
    assert!(re(r" 1 node · 1 edge\n").is_match(&r.stdout));
    assert!(r.stdout.contains("Both versions have 1 node and 1 edge."));
}

#[test]
fn lets_force_color_1_force_16_colors_even_on_truecolor_terminals() {
    struct Vars(&'static [(&'static str, &'static str)]);
    impl Env for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }
    assert_eq!(
        resolve_color_level(
            ColorMode::Auto,
            &Vars(&[("FORCE_COLOR", "1"), ("COLORTERM", "truecolor")]),
            true
        ),
        1
    );
    assert_eq!(
        resolve_color_level(
            ColorMode::Always,
            &Vars(&[("FORCE_COLOR", "2"), ("COLORTERM", "truecolor")]),
            false
        ),
        2
    );
    assert_eq!(
        resolve_color_level(
            ColorMode::Auto,
            &Vars(&[("FORCE_COLOR", "true"), ("COLORTERM", "truecolor")]),
            false
        ),
        3
    );
}

#[test]
fn accepts_options_after_a_help_topic() {
    let mut terminal = io();
    terminal.is_tty = true;
    let r = run_with(&["help", "apply", "--color", "never"], terminal);
    assert_eq!(r.code, 0);
    assert!(r.stdout.contains("kgdiff apply <graph> <delta>"));
    assert!(!r.stdout.contains(ESC));
    assert!(
        run(&["help", "--color", "always"], &[])
            .stdout
            .contains(ESC)
    );
    assert_eq!(run(&["help", "nope"], &[]).code, 2);
}
