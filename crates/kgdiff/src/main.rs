//! The `kgdiff` binary.

use std::process::ExitCode;

fn main() -> ExitCode {
    // Panics become "Unexpected error" messages (`kgdiff::cli::run`), not Rust's panic report.
    std::panic::set_hook(Box::new(|_| {}));
    // Arguments that are not Unicode read as Node reads them: invalid bytes as U+FFFD.
    let argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let code = kgdiff::cli::run(&argv, &mut kgdiff::system::SystemIo::default());
    ExitCode::from(code)
}
