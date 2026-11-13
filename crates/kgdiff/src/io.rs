//! **Experimental.** This module may change in a minor release: the embedding interface of the
//! `kgdiff` crate still has the shape of its JavaScript origin, and no external host uses it yet.
//! It joins the semver promise once the Python bindings have used it
//! (see `docs/versioning.md`, "Experimental APIs").
//!
//! Everything the CLI needs from the outside world, behind a trait so that
//! [`crate::cli::run`] runs in memory in tests (captured streams, in-memory files, a fixed clock,
//! injected viewer bundles) and for real in the binary ([`crate::system::SystemIo`]).
//!
//! Paths are strings: the CLI resolves them against [`CliIo::cwd`]
//! ([`crate::paths::resolve`]) before it hands them to the file system methods, which get
//! absolute paths only.

use std::borrow::Cow;
use std::io;

/// Environment variables.
pub trait Env {
    /// The variable's value, `None` when it is not set.
    fn var(&self, name: &str) -> Option<String>;
}

/// What overwrite checks and size limits need to know about an existing file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct FileStat {
    /// Device and inode (volume and file index on Windows): equal for the same file under any
    /// name (case variant, link).
    pub dev: u64,
    /// Device and inode: equal for the same file under any name.
    pub ino: u64,
    /// The size in bytes.
    pub size: u64,
}

impl FileStat {
    /// The device, inode and size of a file.
    pub fn new(dev: u64, ino: u64, size: u64) -> FileStat {
        FileStat { dev, ino, size }
    }
}

/// The viewer bundles an HTML report inlines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ViewerBundle {
    /// The standalone `<kgdiff-viewer>` element.
    Main,
    /// The compute add-on that lays the diff out in the browser.
    Compute,
}

/// Why stdin could not be read.
#[derive(Debug)]
pub enum StdinError {
    /// More than the size limit.
    TooLarge,
    /// Reading failed.
    Io(io::Error),
}

/// A viewer bundle this process does not have: the CLI reports it as a `viewer-missing` error.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct ViewerMissing {
    /// What is missing and why.
    pub message: String,
    /// What to do about it, when known.
    pub hint: Option<String>,
}

impl ViewerMissing {
    /// A missing bundle, with what to do about it when known.
    pub fn new(message: impl Into<String>, hint: Option<String>) -> ViewerMissing {
        ViewerMissing {
            message: message.into(),
            hint,
        }
    }
}

/// The CLI's view of the process and the file system.
///
/// A host may implement it. Methods added to it later come with a default implementation, so
/// that an implementation keeps compiling (docs/versioning.md).
pub trait CliIo: Env {
    /// Writes text to stdout.
    fn write_stdout(&mut self, text: &str);
    /// Writes text to stderr.
    fn write_stderr(&mut self, text: &str);
    /// All of stdin; [`StdinError::TooLarge`] beyond `max_bytes`.
    ///
    /// # Errors
    ///
    /// [`StdinError::TooLarge`] beyond `max_bytes`, or [`StdinError::Io`] when reading fails.
    fn read_stdin(&mut self, max_bytes: u64) -> Result<Vec<u8>, StdinError>;
    /// A whole file.
    ///
    /// # Errors
    ///
    /// An I/O error when the file cannot be read.
    fn read_file(&mut self, path: &str) -> io::Result<Vec<u8>>;
    /// Creates or replaces a file atomically: a temporary file in the same directory renamed
    /// over `path` (readers never see a half-written file; a link at `path` is replaced, not
    /// written through).
    ///
    /// # Errors
    ///
    /// An I/O error when the file cannot be written.
    fn write_file(&mut self, path: &str, data: &[u8]) -> io::Result<()>;
    /// Stat following links; `None` when nothing exists at `path` (or a component is not a
    /// directory).
    ///
    /// # Errors
    ///
    /// An I/O error other than the file not existing.
    fn stat(&mut self, path: &str) -> io::Result<Option<FileStat>>;
    /// The canonical absolute path (links resolved); an error when `path` does not exist.
    ///
    /// # Errors
    ///
    /// An I/O error when `path` does not exist or cannot be resolved.
    fn realpath(&mut self, path: &str) -> io::Result<String>;
    /// The directory relative paths are resolved against.
    fn cwd(&self) -> String;
    /// Whether stdout is a terminal.
    fn is_tty(&self) -> bool;
    /// Whether stderr is a terminal (colours of errors and notices).
    fn stderr_is_tty(&self) -> bool;
    /// Whether stdin is a terminal (nothing piped in).
    fn stdin_is_tty(&self) -> bool;
    /// The terminal width of stdout, when known.
    fn columns(&self) -> Option<f64>;
    /// The platform, for bug reports (`darwin arm64, …`); `None` names only the version.
    fn runtime(&self) -> Option<String>;
    /// The current time as an ISO 8601 UTC timestamp with milliseconds (`2026-11-01T12:00:00.000Z`), for the `generatedAt` of reports.
    ///
    /// # Errors
    ///
    /// An I/O error when the clock cannot be read.
    fn now(&mut self) -> io::Result<String>;
    /// A fresh private directory, for reports opened with `--open` and no `-o`.
    ///
    /// # Errors
    ///
    /// An I/O error when the directory cannot be created.
    fn make_temp_dir(&mut self) -> io::Result<String>;
    /// Opens a file with the platform's default application (the browser, for HTML).
    ///
    /// # Errors
    ///
    /// An I/O error when the file cannot be opened.
    fn open_file(&mut self, path: &str) -> io::Result<()>;
    /// The source of a viewer bundle, or a `viewer-missing` error.
    ///
    /// # Errors
    ///
    /// [`ViewerMissing`] when this process does not have the bundle.
    fn viewer_bundle(&mut self, part: ViewerBundle) -> Result<Cow<'static, str>, ViewerMissing>;
}
