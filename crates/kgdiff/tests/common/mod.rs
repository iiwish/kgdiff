//! The test harness: `kgdiff::cli::run` against a [`MemoryIo`],
//! files read through from the repository, the example datasets.

#![allow(dead_code)]

use std::path::Path;

use kgdiff::testing::MemoryIo;
use kgdiff_core::js::{Value, json};

/// A regular expression of an assertion, kept as written. Engine code builds
/// its patterns in its `re` module (RFC 0002 §4.5); tests only match output with them.
#[allow(clippy::disallowed_methods)]
pub fn re(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).unwrap()
}

/// The working directory of every run.
pub const CWD: &str = "/work";

/// The repository root.
pub fn repo() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let text = path.canonicalize().unwrap().to_string_lossy().into_owned();
    // Windows' verbatim prefix, which paths as users write them never have.
    text.strip_prefix(r"\\?\")
        .map_or(text.clone(), str::to_owned)
}

/// A process whose files are in memory, with the repository read through.
pub fn io() -> MemoryIo {
    MemoryIo::new(CWD).read_through(&repo())
}

/// What a run gives.
pub struct Run {
    pub code: u8,
    pub stdout: String,
    pub stderr: String,
    pub io: MemoryIo,
}

impl Run {
    /// The text of a written file.
    pub fn file(&self, path: &str) -> String {
        self.io.written_text(path)
    }
}

pub fn args(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

/// Runs kgdiff with `argv` against `io`.
pub fn run_with(argv: &[&str], mut io: MemoryIo) -> Run {
    let code = kgdiff::cli::run(&args(argv), &mut io);
    Run {
        code,
        stdout: io.stdout.clone(),
        stderr: io.stderr.clone(),
        io,
    }
}

/// Runs kgdiff with `argv` and `files` (relative to [`CWD`]).
pub fn run(argv: &[&str], files: &[(&str, &str)]) -> Run {
    let mut io = io();
    for (path, content) in files {
        io = io.file(path, content.as_bytes());
    }
    run_with(argv, io)
}

/// An example dataset (`examples/datasets/<id>`): its files and the flags of its options.
pub struct Dataset {
    pub before: String,
    pub after: String,
    pub flags: Vec<String>,
}

pub fn dataset(id: &str) -> Dataset {
    let dir = Path::new(&repo()).join("examples/datasets").join(id);
    let meta: Value =
        json::parse(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
    let file = |side: &str| {
        let name = meta
            .get("files")
            .and_then(|f| f.get(side))
            .and_then(Value::as_str)
            .unwrap();
        dir.join(name).to_string_lossy().into_owned()
    };
    let mut flags = Vec::new();
    if let Some(o) = meta.get("options") {
        if let Some(s) = o
            .get("match")
            .and_then(|m| m.get("strategy"))
            .and_then(Value::as_str)
        {
            flags.extend(["--match".to_owned(), s.to_owned()]);
        }
        if let Some(t) = o.get("match").and_then(|m| m.get("threshold")) {
            flags.extend(["--threshold".to_owned(), t.to_js_string()]);
        }
        for p in o
            .get("hierarchyPredicates")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            flags.extend(["--hierarchy".to_owned(), p.as_str().unwrap().to_owned()]);
        }
        if let Some(e) = o.get("edgeIdentity").and_then(Value::as_str) {
            flags.extend(["--edge-identity".to_owned(), e.to_owned()]);
        }
        for k in o
            .get("ignoreAttrs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            flags.extend(["--ignore-attr".to_owned(), k.as_str().unwrap().to_owned()]);
        }
        if o.get("detectMerges") == Some(&Value::Bool(false)) {
            flags.push("--no-merges".to_owned());
        }
        if o.get("detectSplits") == Some(&Value::Bool(false)) {
            flags.push("--no-splits".to_owned());
        }
    }
    Dataset {
        before: file("before"),
        after: file("after"),
        flags,
    }
}

impl Dataset {
    /// `before after flags… extra…`.
    pub fn argv<'a>(&'a self, extra: &[&'a str]) -> Vec<&'a str> {
        let mut out = vec![self.before.as_str(), self.after.as_str()];
        out.extend(self.flags.iter().map(String::as_str));
        out.extend(extra);
        out
    }
}

/// The payload of an HTML report, decoded, and its encoding.
pub fn extract_payload(html: &str) -> (Option<String>, Value) {
    use base64::Engine;
    use std::io::Read;
    let open = "<script type=\"application/kgdiff+json\"";
    let start = html.find(open).expect("no payload script") + open.len();
    let rest = &html[start..];
    let end = rest.find('>').unwrap();
    let attrs = &rest[..end];
    let body = &rest[end + 1..rest.find("</script>").unwrap()];
    if attrs.contains("data-encoding=\"gzip-base64\"") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body)
            .unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_string(&mut text)
            .unwrap();
        (Some("gzip-base64".to_owned()), json::parse(&text).unwrap())
    } else {
        (None, json::parse(body).unwrap())
    }
}
