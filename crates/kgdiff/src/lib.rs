//! The `kgdiff` command line: `git diff` for knowledge graphs (RFC 0002, phase 3).
//!
//! Byte for byte what the TypeScript CLI `@kgdiff/cli` prints: the same arguments, messages,
//! outputs and exit codes, checked against every run the conformance corpus records
//! (`conformance/replay.ts --bin`). The library is [`cli::run`] behind the [`io::CliIo`] trait,
//! so that a host embeds kgdiff (the Python package does) and tests run it in memory;
//! [`system::SystemIo`] is the real process.
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
//! HTML reports carry no layout in phase 3 (decision D-10): the viewer lays the diff out in the
//! browser with its compute add-on, which every report inlines. The viewer bundles are compiled
//! in with the feature `embed-viewer` (on by default) once `pnpm build:viewer-assets` has run.

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
