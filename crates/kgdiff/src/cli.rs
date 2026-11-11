//! The entry point: parse the command line, dispatch, and turn every failure into a
//! friendly message on stderr and an exit code.

use std::panic::{AssertUnwindSafe, Location, catch_unwind};

use kgdiff_report::Painter;

use crate::VERSION;
use crate::args::{Command, parse_command_line, peek_color_mode};
use crate::commands::{run_apply, run_diff};
use crate::errors::{CliResult, Failure, bug_report_url, debug_enabled, format_error};
use crate::help::render_help;
use crate::io::CliIo;
use crate::style::{is_light_background, painter, resolve_color_level};

fn dispatch(argv: &[String], io: &mut dyn CliIo) -> CliResult<u8> {
    match parse_command_line(argv)? {
        Command::Help { topic, color } => {
            let paint = painter(color, io, io.is_tty());
            let width = match io.columns() {
                Some(c) if io.is_tty() && c > 0.0 => kgdiff_core::util::f64_to_count(c),
                _ => 80,
            };
            io.write_stdout(&render_help(topic, VERSION, &paint, width));
            Ok(0)
        }
        Command::Version => {
            io.write_stdout(&format!("kgdiff {VERSION}\n"));
            Ok(0)
        }
        Command::Diff(options) => run_diff(&options, io),
        Command::Apply(options) => run_apply(&options, io),
    }
}

/// What a panic says.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_owned())
}

/// Runs kgdiff with `argv` (without the program name) against `io`; the exit code.
///
/// 0 on success (and no differences with `--exit-code`), 1 for differences with `--exit-code`,
/// 2 for a usage or input error (the message on stderr; the chain of causes only with
/// `DEBUG=kgdiff`). Never panics: a bug becomes an "Unexpected error" with a link to the bug
/// report form.
pub fn run(argv: &[String], io: &mut dyn CliIo) -> u8 {
    let light = is_light_background(io);
    let outcome = catch_unwind(AssertUnwindSafe(|| dispatch(argv, io))).unwrap_or_else(|payload| {
        Err(Failure::Unexpected(
            panic_message(payload.as_ref()),
            Location::caller(),
        ))
    });
    match outcome {
        Ok(code) => code,
        Err(failure) => {
            let paint = Painter::new(
                resolve_color_level(peek_color_mode(argv), io, io.stderr_is_tty()),
                light,
            );
            // The platform comes from `io` like every other side effect, so `run` stays
            // deterministic in tests.
            let report = bug_report_url(VERSION, io.runtime().as_deref());
            let debug = debug_enabled(io.var("DEBUG").as_deref());
            io.write_stderr(&format_error(&failure, &paint, debug, Some(&report)));
            2
        }
    }
}
