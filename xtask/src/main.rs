//! The repository's own tasks, run as `cargo xtask <task>` (the alias is in `.cargo/config.toml`).
//! Not published.
//!
//! - `conformance [--check] [--bin <kgdiff>]`: generates the conformance corpus
//!   (`conformance/README.md`, "Changing the corpus"), or with `--check` compares it with the
//!   files on disk.

mod conformance;

use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask conformance [--check] [--bin <kgdiff>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("conformance") => conformance::main(&args[1..]),
        Some("-h" | "--help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
