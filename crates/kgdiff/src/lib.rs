//! The `kgdiff` command line: `git diff` for knowledge graphs (RFC 0002). npm's `@kgdiff/cli`
//! runs this binary.
//!
//! It records the CLI runs of the conformance corpus, and every one is replayed against it on
//! Linux, macOS and Windows (`conformance/replay.ts`): the same arguments, messages, outputs and
//! exit codes, byte for byte. The library is
//! [`cli::run`] behind the [`io::CliIo`] trait, so that a host embeds kgdiff (the Python package
//! does) and tests run it in memory; [`system::SystemIo`] is the real process.
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

pub mod args;
pub mod cli;
pub mod commands;
pub mod errors;
pub mod help;
pub mod inputs;
pub mod io;
pub mod output;
pub mod paths;
pub mod style;
pub mod system;
pub mod testing;
mod v8_json;

/// The version kgdiff reports (`kgdiff --version`, report generators): the workspace's, which
/// `scripts/sync-versions.ts` keeps equal to the npm packages'.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
