//! The `kgdiff` command line: `git diff` for knowledge graphs. It reads two versions of a graph
//! (kgdiff JSON and other JSON graph shapes, RDF, OBO) and prints a summary, `--stat`,
//! `--name-status`, `--json`, a `--delta` for `kgdiff apply`, GitHub Markdown, or writes a
//! self-contained interactive HTML report; `docs/cli.md` in the repository lists every option.
//! npm's `@kgdiff/cli` runs this binary.
//!
//! This library is the command line without the process around it: [`cli::run`] runs a command
//! against any [`io::CliIo`], so that a host can embed kgdiff and tests can run it in memory
//! with [`testing::MemoryIo`]; [`system::SystemIo`] is the real process. The same arguments give
//! the same messages, outputs and exit codes on Linux, macOS and Windows. The modules `cli`, `io`,
//! `system` and `testing` are experimental and may change in a minor release.
//!
//! ```
//! use kgdiff::testing::MemoryIo;
//!
//! let mut io = MemoryIo::new("/work")
//!     .file("a.json", r#"{"nodes":[{"id":"ada","label":"Ada"}],"edges":[]}"#)
//!     .file("b.json", r#"{"nodes":[{"id":"ada","label":"Ada Lovelace"}],"edges":[]}"#);
//! let code = kgdiff::cli::run(&["a.json".into(), "b.json".into(), "--name-status".into()], &mut io);
//! assert_eq!(code, 0);
//! assert_eq!(io.stdout, "R\tada\tRenamed “Ada” → “Ada Lovelace”\n");
//! ```
//!
//! HTML reports carry the layout of kgdiff-layout (a layout document of version 2) and open
//! without laying anything out; the viewer's compute add-on is inlined only for layouts that
//! cover just the changes of a large graph. The viewer bundles are compiled in with the feature
//! `embed-viewer` (on by default) once `pnpm build:viewer-assets` has run.

#![warn(missing_docs)]

/// The README's examples, run as tests.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
struct ReadmeDoctests;

#[doc(hidden)]
pub mod args;
pub mod cli;
#[doc(hidden)]
pub mod commands;
#[doc(hidden)]
pub mod errors;
#[doc(hidden)]
pub mod help;
#[doc(hidden)]
pub mod inputs;
pub mod io;
#[doc(hidden)]
pub mod output;
#[doc(hidden)]
pub mod paths;
#[doc(hidden)]
pub mod style;
pub mod system;
pub mod testing;
mod v8_json;

/// The version kgdiff reports (`kgdiff --version`, report generators): the workspace's, which the
/// repository's release script keeps equal to the npm packages'.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
