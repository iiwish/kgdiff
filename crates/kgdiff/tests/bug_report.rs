//! An unexpected error links the bug report form
//! with public metadata only.

mod common;

use common::{io, re, run, run_with};

fn url_in(stderr: &str) -> String {
    re(r"https://github\.com/iiwish/kgdiff/issues/new\?\S+")
        .find(stderr)
        .unwrap()
        .as_str()
        .to_owned()
}

/// The query's keys and values (`URLSearchParams`).
fn params(url: &str) -> Vec<(String, String)> {
    let query = &url[url.find('?').unwrap() + 1..];
    query
        .split('&')
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap();
            let decode = |s: &str| {
                let bytes = s.replace('+', " ").into_bytes();
                let mut out = Vec::new();
                let mut i = 0;
                while i < bytes.len() {
                    if bytes[i] == b'%' {
                        out.push(
                            u8::from_str_radix(
                                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap(),
                                16,
                            )
                            .unwrap(),
                        );
                        i += 3;
                    } else {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
                String::from_utf8(out).unwrap()
            };
            (decode(k), decode(v))
        })
        .collect()
}

const EMPTY: &str = r#"{"nodes":[],"edges":[]}"#;

#[test]
fn prefills_only_the_version_and_runtime_never_private_error_data() {
    let private = "/private/secret-graph.json?token=keep-this-private";
    let mut io = io().file("a.json", EMPTY).file("b.json", EMPTY);
    io.now = Err(private.to_owned());
    let r = run_with(&["a.json", "b.json", "--html", "out.html"], io);
    assert_eq!(r.code, 2);
    let url = url_in(&r.stderr);
    let mut p = params(&url);
    p.sort();
    assert_eq!(
        p,
        [
            (
                "environment".to_owned(),
                "testos x64, Node.js v0.0.0".to_owned()
            ),
            ("template".to_owned(), "bug_report.yml".to_owned()),
            ("version".to_owned(), format!("kgdiff {}", kgdiff::VERSION)),
        ]
    );
    assert!(!url.contains("secret-graph") && !url.contains("keep-this-private"));
    assert!(r.stderr.contains(&format!("Unexpected error: {private}")));
    assert!(r.stderr.contains("DEBUG=kgdiff"));
}

#[test]
fn names_only_the_version_when_the_host_gives_no_runtime() {
    let mut io = io().file("a.json", EMPTY).file("b.json", EMPTY);
    io.now = Err("boom".to_owned());
    io.runtime = None;
    let r = run_with(&["a.json", "b.json", "--html", "out.html"], io);
    assert_eq!(r.code, 2);
    let mut keys: Vec<String> = params(&url_in(&r.stderr))
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    keys.sort();
    assert_eq!(keys, ["template", "version"]);
}

/// A process whose clock panics: a bug inside kgdiff, as far as `run` can tell.
struct Panicking(kgdiff::testing::MemoryIo);

impl kgdiff::io::Env for Panicking {
    fn var(&self, name: &str) -> Option<String> {
        kgdiff::io::Env::var(&self.0, name)
    }
}

impl kgdiff::io::CliIo for Panicking {
    fn write_stdout(&mut self, text: &str) {
        self.0.write_stdout(text);
    }
    fn write_stderr(&mut self, text: &str) {
        self.0.write_stderr(text);
    }
    fn read_stdin(&mut self, max: u64) -> Result<Vec<u8>, kgdiff::io::StdinError> {
        self.0.read_stdin(max)
    }
    fn read_file(&mut self, path: &str) -> std::io::Result<Vec<u8>> {
        self.0.read_file(path)
    }
    fn write_file(&mut self, path: &str, data: &[u8]) -> std::io::Result<()> {
        self.0.write_file(path, data)
    }
    fn stat(&mut self, path: &str) -> std::io::Result<Option<kgdiff::io::FileStat>> {
        self.0.stat(path)
    }
    fn realpath(&mut self, path: &str) -> std::io::Result<String> {
        self.0.realpath(path)
    }
    fn cwd(&self) -> String {
        self.0.cwd()
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
        self.0.runtime()
    }
    fn now(&mut self) -> std::io::Result<String> {
        panic!("the clock broke")
    }
    fn make_temp_dir(&mut self) -> std::io::Result<String> {
        self.0.make_temp_dir()
    }
    fn open_file(&mut self, path: &str) -> std::io::Result<()> {
        self.0.open_file(path)
    }
    fn viewer_bundle(
        &mut self,
        part: kgdiff::io::ViewerBundle,
    ) -> Result<std::borrow::Cow<'static, str>, kgdiff::io::ViewerMissing> {
        self.0.viewer_bundle(part)
    }
}

#[test]
fn reports_a_panic_as_an_unexpected_error() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut io = Panicking(io().file("a.json", EMPTY).file("b.json", EMPTY));
    let argv: Vec<String> = ["a.json", "b.json", "--html", "out.html"]
        .iter()
        .map(|a| (*a).to_owned())
        .collect();
    assert_eq!(kgdiff::cli::run(&argv, &mut io), 2);
    assert!(
        io.0.stderr.starts_with(
            "error: Unexpected error: the clock broke\nhint: This is a bug in kgdiff."
        ),
        "{}",
        io.0.stderr
    );
    assert!(io.0.stderr.contains("/issues/new?"));
    assert!(io.0.written.is_empty());
}

#[test]
fn adds_no_bug_report_url_for_usage_input_or_graph_errors() {
    let files = [("invalid.json", "not JSON"), ("other.json", EMPTY)];
    for argv in [
        &["--not-an-option"][..],
        &["missing.json", "other.json"][..],
        &["invalid.json", "other.json"][..],
    ] {
        let r = run(argv, &files);
        assert_eq!(r.code, 2, "{argv:?}");
        assert!(!r.stderr.contains("/issues/new?"), "{argv:?}");
    }
}
