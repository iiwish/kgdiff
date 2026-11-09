//! What the commands share for their outputs (`output.ts`): painters for stdout and stderr,
//! the locale, `--quiet`, and writing output files with a short notice on stderr; and the
//! overwrite checks (`overwrite.ts`): outputs never overwrite inputs, and two outputs never share
//! a file, under any spelling.

use kgdiff_core::Locale;
use kgdiff_core::js;
use kgdiff_report::width::sanitize;
use kgdiff_report::{Painter, Tone, resolve_locale};

use crate::args::{CommonOptions, STDIO};
use crate::errors::{CliError, CliErrorCode, CliResult, system_error_code, system_reason};
use crate::inputs::resolve_path;
use crate::io::CliIo;
use crate::paths;
use crate::style::painter;

/// The resolved output settings of a command (`OutputContext`).
pub struct OutputContext {
    pub locale: Locale,
    /// The painter of stdout.
    pub paint: Painter,
    /// The painter of stderr.
    pub err_paint: Painter,
    pub quiet: bool,
}

impl OutputContext {
    pub fn new(io: &dyn CliIo, options: &CommonOptions) -> OutputContext {
        OutputContext {
            locale: resolve_locale(options.locale, &|name| io.var(name)),
            paint: painter(options.color, io, io.is_tty()),
            err_paint: painter(options.color, io, io.stderr_is_tty()),
            quiet: options.quiet,
        }
    }

    /// Writes to stdout unless `--quiet`.
    pub fn stdout(&self, io: &mut dyn CliIo, text: &str) {
        if !self.quiet && !text.is_empty() {
            io.write_stdout(text);
        }
    }

    /// Writes a notice or a warning to stderr unless `--quiet`.
    pub fn notice(&self, io: &mut dyn CliIo, text: &str) {
        if !self.quiet {
            io.write_stderr(text);
        }
    }
}

/// `1.2 MB`, `512 kB`, `90 B`: decimal units, as most file managers show them (`formatSize`).
pub fn format_size(bytes: usize) -> String {
    let n = kgdiff_core::util::count_to_f64(bytes);
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    if bytes < 1_000_000 {
        return format!(
            "{} kB",
            js::to_fixed(n / 1000.0, if bytes < 10_000 { 1 } else { 0 })
        );
    }
    format!("{} MB", js::to_fixed(n / 1_000_000.0, 1))
}

/// Writes an output file and reports it on stderr (`✓ Wrote report.html (1.2 MB)`).
pub fn write_output_file(
    ctx: &OutputContext,
    io: &mut dyn CliIo,
    path: &str,
    content: &str,
    label: &str,
) -> CliResult<()> {
    let data = content.as_bytes();
    let absolute = resolve_path(io, path);
    if let Err(error) = io.write_file(&absolute, data) {
        let hint = match system_error_code(&error) {
            Some("ENOENT") => Some("Create the directory first."),
            Some("EISDIR") => Some("Pass a file name, not a directory."),
            Some("EACCES") => Some("Check the permissions of the directory."),
            _ => None,
        };
        let message = format!(
            "Cannot write {label} to \"{}\": {}.",
            sanitize(path),
            system_reason(&error)
        );
        return Err(
            CliError::new(CliErrorCode::Output, message, hint.map(str::to_owned))
                .caused_by(error.into())
                .into(),
        );
    }
    let p = &ctx.err_paint;
    ctx.notice(
        io,
        &format!(
            "{} Wrote {label} {} {}\n",
            p.tone(Tone::Added, "✓"),
            p.bold(&sanitize(path)),
            p.dim(&format!("({})", format_size(data.len())))
        ),
    );
    Ok(())
}

/// A path and how it was given, for messages (`<before>`, `--json`, `-o`).
pub struct PathRole<'a> {
    pub role: &'a str,
    /// As given; `-` (stdin / stdout) and `None` are ignored.
    pub path: Option<&'a str>,
}

/// The identity of the file at `path` (`fileIdentity`): device and inode when it exists, else
/// the canonical directory and the case-folded name (on case-insensitive file systems `A.json`
/// and `a.json` are one file; on others this only refuses outputs that differ in case alone).
fn file_identity(io: &mut dyn CliIo, path: &str) -> CliResult<String> {
    let absolute = resolve_path(io, path);
    if let Some(stat) = io.stat(&absolute)? {
        return Ok(format!("inode:{}:{}", stat.dev, stat.ino));
    }
    let mut directory = paths::dirname(&absolute);
    // A missing directory makes the write fail later, with its own message.
    if let Ok(real) = io.realpath(&directory) {
        directory = real;
    }
    let joined = paths::join(&directory, paths::basename(&absolute));
    Ok(format!("path:{}", kgdiff_core::text::to_lowercase(&joined)))
}

/// Refuses an output that is one of the inputs, and two outputs that are one file
/// (`checkNoOverwrite`): `usage` errors.
pub fn check_no_overwrite(
    io: &mut dyn CliIo,
    inputs: &[PathRole<'_>],
    outputs: &[PathRole<'_>],
) -> CliResult<()> {
    fn used<'a>(p: &PathRole<'a>) -> Option<&'a str> {
        p.path.filter(|path| *path != STDIO)
    }
    let mut input_ids: Vec<(String, &PathRole<'_>)> = Vec::new();
    for input in inputs {
        let Some(path) = used(input) else { continue };
        // Missing inputs are reported when they are read.
        let absolute = resolve_path(io, path);
        if io.stat(&absolute)?.is_some() {
            input_ids.push((file_identity(io, path)?, input));
        }
    }
    let mut output_ids: Vec<(String, &PathRole<'_>)> = Vec::new();
    for output in outputs {
        let Some(path) = used(output) else { continue };
        let id = file_identity(io, path)?;
        // A later input of the same identity replaces an earlier one, as in a `Map`.
        if let Some((_, input)) = input_ids.iter().rev().find(|(i, _)| *i == id) {
            let input_path = input.path.unwrap_or("");
            return Err(CliError::new(
                CliErrorCode::Usage,
                format!(
                    "{} \"{}\" is the input {} \"{}\"; kgdiff never overwrites its inputs.",
                    output.role,
                    sanitize(path),
                    input.role,
                    sanitize(input_path)
                ),
                Some("Write to another file, then move it into place if you want to replace the input.".to_owned()),
            )
            .into());
        }
        if let Some((_, other)) = output_ids.iter().find(|(o, _)| *o == id) {
            return Err(CliError::new(
                CliErrorCode::Usage,
                format!(
                    "{} and {} both write to \"{}\".",
                    other.role,
                    output.role,
                    sanitize(path)
                ),
                Some("Give each output its own file.".to_owned()),
            )
            .into());
        }
        output_ids.push((id, output));
    }
    Ok(())
}
