//! An in-memory [`CliIo`] for tests and examples:
//! captured streams, files in memory, writes kept apart, a fixed clock, injected viewer
//! bundles, links and an optional case-insensitive file system.

use kgdiff_core::js::IndexMap;
use std::borrow::Cow;
use std::io;

use crate::io::{CliIo, Env, FileStat, StdinError, ViewerBundle, ViewerMissing};
use crate::paths;

/// A stand-in for the viewer bundle.
pub const FAKE_BUNDLE: &str =
    "/* fake viewer */ customElements.define(\"kgdiff-viewer\", class extends HTMLElement {});";
/// A stand-in for the compute add-on.
pub const FAKE_COMPUTE: &str = "/* fake compute */ globalThis.KgdiffCompute = {};";

/// Paths in a `missing-dir` directory do not exist.
fn in_missing_dir(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(|segment| segment == "missing-dir")
}

fn enoent() -> io::Error {
    io::Error::from(io::ErrorKind::NotFound)
}

/// The in-memory process. Build it with the methods that take `self`, run
/// [`crate::cli::run`] against it, then read `stdout`, `stderr`, `written` and `opened`.
#[derive(Debug)]
pub struct MemoryIo {
    cwd: String,
    files: IndexMap<String, Vec<u8>>,
    /// Aliases (links): path → the file it names, both absolute.
    links: IndexMap<String, String>,
    case_insensitive: bool,
    /// Absolute paths under this directory are read from disk when not in memory.
    read_through: Option<String>,
    inodes: IndexMap<String, u64>,
    temps: usize,
    /// Environment variables.
    pub env: IndexMap<String, String>,
    /// What standard input holds.
    pub stdin: Vec<u8>,
    /// Whether stdout is a terminal.
    pub is_tty: bool,
    /// Whether stderr is a terminal.
    pub stderr_is_tty: bool,
    /// Whether stdin is a terminal.
    pub stdin_is_tty: bool,
    /// The terminal width of stdout, when known.
    pub columns: Option<f64>,
    /// The platform string for bug reports.
    pub runtime: Option<String>,
    /// What `now` returns, or the message it fails with.
    pub now: Result<String, String>,
    /// The viewer bundle, or the message of the `viewer-missing` error it fails with.
    pub bundle: Result<String, String>,
    /// The compute add-on bundle, or the message of the `viewer-missing` error it fails with.
    pub compute: Result<String, String>,
    /// When set, opening a file fails with this message.
    pub open_error: Option<String>,
    /// Everything written to stdout.
    pub stdout: String,
    /// Everything written to stderr.
    pub stderr: String,
    /// Files written, by absolute path (case-folded on a case-insensitive file system), in order.
    pub written: Vec<(String, Vec<u8>)>,
    /// Files opened with the default application, by absolute path.
    pub opened: Vec<String>,
}

impl MemoryIo {
    /// An empty process whose working directory is `cwd`.
    pub fn new(cwd: &str) -> MemoryIo {
        MemoryIo {
            cwd: cwd.to_owned(),
            files: IndexMap::default(),
            links: IndexMap::default(),
            case_insensitive: false,
            read_through: None,
            inodes: IndexMap::default(),
            temps: 0,
            env: IndexMap::default(),
            stdin: Vec::new(),
            is_tty: false,
            stderr_is_tty: false,
            stdin_is_tty: false,
            columns: None,
            runtime: Some("testos x64, Node.js v0.0.0".to_owned()),
            now: Ok("2026-11-01T12:00:00.000Z".to_owned()),
            bundle: Ok(FAKE_BUNDLE.to_owned()),
            compute: Ok(FAKE_COMPUTE.to_owned()),
            open_error: None,
            stdout: String::new(),
            stderr: String::new(),
            written: Vec::new(),
            opened: Vec::new(),
        }
    }

    fn absolute(&self, path: &str) -> String {
        paths::resolve(&self.cwd, path)
    }

    fn canon(&self, path: &str) -> String {
        let target = self
            .links
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.to_owned());
        if self.case_insensitive {
            kgdiff_core::text::to_lowercase(&target).into_owned()
        } else {
            target
        }
    }

    /// A file, by a path relative to the working directory or absolute.
    #[must_use]
    pub fn file(mut self, path: &str, content: impl Into<Vec<u8>>) -> MemoryIo {
        let absolute = self.absolute(path);
        let key = self.canon(&absolute);
        self.files.insert(key, content.into());
        self
    }

    #[must_use]
    /// Sets an environment variable.
    pub fn var(mut self, name: &str, value: &str) -> MemoryIo {
        self.env.insert(name.to_owned(), value.to_owned());
        self
    }

    #[must_use]
    /// Sets what standard input holds.
    pub fn with_stdin(mut self, data: impl Into<Vec<u8>>) -> MemoryIo {
        self.stdin = data.into();
        self
    }

    /// `from` names the file `to` (a link), both relative to the working directory.
    #[must_use]
    pub fn link(mut self, from: &str, to: &str) -> MemoryIo {
        let (from, to) = (self.absolute(from), self.absolute(to));
        self.links.insert(from, to);
        self
    }

    /// A case-insensitive file system: names that differ in case alone are one file.
    #[must_use]
    pub fn case_insensitive(mut self) -> MemoryIo {
        self.case_insensitive = true;
        let files = std::mem::take(&mut self.files);
        for (path, data) in files {
            let key = self.canon(&path);
            self.files.insert(key, data);
        }
        self
    }

    /// Absolute paths under `root` are read from disk (fixtures, datasets) when not in memory.
    #[must_use]
    pub fn read_through(mut self, root: &str) -> MemoryIo {
        self.read_through = Some(root.to_owned());
        self
    }

    fn lookup(&self, path: &str) -> Option<Vec<u8>> {
        let key = self.canon(path);
        if let Some((_, data)) = self.written.iter().find(|(p, _)| *p == key) {
            return Some(data.clone());
        }
        if let Some(data) = self.files.get(&key) {
            return Some(data.clone());
        }
        let root = self.read_through.as_deref()?;
        if paths::is_absolute(path) && path.starts_with(root) {
            return std::fs::read(path).ok();
        }
        None
    }

    /// The text of a written file (relative to the working directory or absolute).
    ///
    /// # Panics
    ///
    /// When the file was not written.
    pub fn written_text(&self, path: &str) -> String {
        let absolute = self.absolute(path);
        let lower = kgdiff_core::text::to_lowercase(&absolute).into_owned();
        let data = self
            .written
            .iter()
            .rev()
            .find(|(p, _)| *p == absolute || *p == lower)
            .map(|(_, d)| d.clone())
            .unwrap_or_else(|| {
                let have: Vec<&str> = self.written.iter().map(|(p, _)| p.as_str()).collect();
                panic!("{path} was not written (have: {})", have.join(", "))
            });
        String::from_utf8(data).unwrap_or_default()
    }
}

impl Env for MemoryIo {
    fn var(&self, name: &str) -> Option<String> {
        self.env.get(name).cloned()
    }
}

impl CliIo for MemoryIo {
    fn write_stdout(&mut self, text: &str) {
        self.stdout.push_str(text);
    }

    fn write_stderr(&mut self, text: &str) {
        self.stderr.push_str(text);
    }

    fn read_stdin(&mut self, max_bytes: u64) -> Result<Vec<u8>, StdinError> {
        if u64::try_from(self.stdin.len()).unwrap_or(u64::MAX) > max_bytes {
            return Err(StdinError::TooLarge);
        }
        Ok(self.stdin.clone())
    }

    fn read_file(&mut self, path: &str) -> io::Result<Vec<u8>> {
        self.lookup(path).ok_or_else(enoent)
    }

    fn write_file(&mut self, path: &str, data: &[u8]) -> io::Result<()> {
        if in_missing_dir(path) {
            return Err(enoent());
        }
        // Atomic replace: a link at `path` is replaced, not written through.
        self.links.shift_remove(path);
        let key = self.canon(path);
        match self.written.iter_mut().find(|(p, _)| *p == key) {
            Some(entry) => entry.1 = data.to_vec(),
            None => self.written.push((key, data.to_vec())),
        }
        Ok(())
    }

    fn stat(&mut self, path: &str) -> io::Result<Option<FileStat>> {
        let Some(data) = self.lookup(path) else {
            return Ok(None);
        };
        let key = self.canon(path);
        let next = u64::try_from(self.inodes.len()).unwrap_or(0) + 1;
        let ino = *self.inodes.entry(key).or_insert(next);
        Ok(Some(FileStat {
            dev: 1,
            ino,
            size: u64::try_from(data.len()).unwrap_or(u64::MAX),
        }))
    }

    fn realpath(&mut self, path: &str) -> io::Result<String> {
        if in_missing_dir(path) {
            return Err(enoent());
        }
        Ok(self
            .links
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.to_owned()))
    }

    fn cwd(&self) -> String {
        self.cwd.clone()
    }

    fn is_tty(&self) -> bool {
        self.is_tty
    }

    fn stderr_is_tty(&self) -> bool {
        self.stderr_is_tty
    }

    fn stdin_is_tty(&self) -> bool {
        self.stdin_is_tty
    }

    fn columns(&self) -> Option<f64> {
        self.columns
    }

    fn runtime(&self) -> Option<String> {
        self.runtime.clone()
    }

    fn now(&mut self) -> io::Result<String> {
        self.now.clone().map_err(io::Error::other)
    }

    fn make_temp_dir(&mut self) -> io::Result<String> {
        self.temps += 1;
        Ok(format!("/tmp/kgdiff-{}", self.temps))
    }

    fn open_file(&mut self, path: &str) -> io::Result<()> {
        if let Some(message) = &self.open_error {
            return Err(io::Error::other(message.clone()));
        }
        self.opened.push(path.to_owned());
        Ok(())
    }

    fn viewer_bundle(&mut self, part: ViewerBundle) -> Result<Cow<'static, str>, ViewerMissing> {
        let source = match part {
            ViewerBundle::Main => &self.bundle,
            ViewerBundle::Compute => &self.compute,
        };
        source
            .clone()
            .map(Cow::Owned)
            .map_err(|message| ViewerMissing::new(message, Some("Build it.".to_owned())))
    }
}
