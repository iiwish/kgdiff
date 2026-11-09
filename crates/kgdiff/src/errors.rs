//! Error reporting (`errors.ts`): every failure becomes one friendly line on stderr, a hint
//! when there is one, and exit code 2; the chain of causes, where each was raised and the
//! details of engine errors only with `DEBUG=kgdiff`.

use std::fmt;
use std::io;
use std::panic::Location;

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{Value, json};
use kgdiff_report::width::{sanitize, sanitize_lines};
use kgdiff_report::{Painter, Tone};

/// What kind of failure a [`CliError`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliErrorCode {
    /// A bad command line.
    Usage,
    /// A file or stdin could not be read, or its content is not a graph / delta.
    Input,
    /// An output file could not be written.
    Output,
    /// The viewer bundles are missing.
    ViewerMissing,
}

/// An error with a message meant for the user and, optionally, a hint on how to fix it.
#[derive(Debug)]
pub struct CliError {
    pub code: CliErrorCode,
    pub message: String,
    pub hint: Option<String>,
    pub cause: Option<Box<Failure>>,
    location: &'static Location<'static>,
}

impl CliError {
    #[track_caller]
    pub fn new(code: CliErrorCode, message: impl Into<String>, hint: Option<String>) -> CliError {
        CliError {
            code,
            message: message.into(),
            hint,
            cause: None,
            location: Location::caller(),
        }
    }

    #[must_use]
    pub fn caused_by(mut self, cause: Failure) -> CliError {
        self.cause = Some(Box::new(cause));
        self
    }
}

/// A usage error with the default hint.
#[track_caller]
pub fn usage(message: impl Into<String>) -> Failure {
    Failure::Cli(CliError::new(
        CliErrorCode::Usage,
        message,
        Some(HELP_HINT.to_owned()),
    ))
}

/// A usage error with its own hint.
#[track_caller]
pub fn usage_with(message: impl Into<String>, hint: impl Into<String>) -> Failure {
    Failure::Cli(CliError::new(
        CliErrorCode::Usage,
        message,
        Some(hint.into()),
    ))
}

/// The hint of most usage errors.
pub const HELP_HINT: &str = "Run `kgdiff --help` for usage.";

/// Everything a command can fail with (what `main`'s `catch` sees in TypeScript).
#[derive(Debug)]
pub enum Failure {
    Cli(CliError),
    /// An error of the engine (`KgdiffError`).
    Kgdiff(KgdiffError, &'static Location<'static>),
    /// An error of the operating system.
    System(io::Error, &'static Location<'static>),
    /// Anything else: a bug.
    Unexpected(String, &'static Location<'static>),
}

impl From<CliError> for Failure {
    fn from(error: CliError) -> Failure {
        Failure::Cli(error)
    }
}

impl From<KgdiffError> for Failure {
    #[track_caller]
    fn from(error: KgdiffError) -> Failure {
        Failure::Kgdiff(error, Location::caller())
    }
}

impl From<io::Error> for Failure {
    #[track_caller]
    fn from(error: io::Error) -> Failure {
        Failure::System(error, Location::caller())
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&describe(self, None).0)
    }
}

impl std::error::Error for Failure {}

pub type CliResult<T> = Result<T, Failure>;

/// The Node.js name of an operating system error (`ENOENT`, `EACCES`, …), if it has one.
pub fn system_error_code(error: &io::Error) -> Option<&'static str> {
    #[cfg(unix)]
    if let Some(errno) = error.raw_os_error() {
        return errno_name(errno);
    }
    use io::ErrorKind as K;
    Some(match error.kind() {
        K::NotFound => "ENOENT",
        K::IsADirectory => "EISDIR",
        K::NotADirectory => "ENOTDIR",
        // libuv reads Windows' ERROR_ACCESS_DENIED as EPERM.
        K::PermissionDenied if cfg!(windows) => "EPERM",
        K::PermissionDenied => "EACCES",
        K::ReadOnlyFilesystem => "EROFS",
        K::StorageFull => "ENOSPC",
        K::AlreadyExists => "EEXIST",
        K::DirectoryNotEmpty => "ENOTEMPTY",
        K::InvalidFilename => "ENAMETOOLONG",
        K::BrokenPipe => "EPIPE",
        _ => return None,
    })
}

#[cfg(unix)]
fn errno_name(errno: i32) -> Option<&'static str> {
    // 1–34 are the same on Linux and macOS.
    Some(match errno {
        1 => "EPERM",
        2 => "ENOENT",
        4 => "EINTR",
        5 => "EIO",
        6 => "ENXIO",
        9 => "EBADF",
        12 => "ENOMEM",
        13 => "EACCES",
        16 => "EBUSY",
        17 => "EEXIST",
        18 => "EXDEV",
        19 => "ENODEV",
        20 => "ENOTDIR",
        21 => "EISDIR",
        22 => "EINVAL",
        23 => "ENFILE",
        24 => "EMFILE",
        26 => "ETXTBSY",
        27 => "EFBIG",
        28 => "ENOSPC",
        30 => "EROFS",
        31 => "EMLINK",
        32 => "EPIPE",
        #[cfg(target_os = "linux")]
        36 => "ENAMETOOLONG",
        #[cfg(target_os = "linux")]
        40 => "ELOOP",
        #[cfg(target_os = "linux")]
        122 => "EDQUOT",
        #[cfg(target_vendor = "apple")]
        62 => "ELOOP",
        #[cfg(target_vendor = "apple")]
        63 => "ENAMETOOLONG",
        #[cfg(target_vendor = "apple")]
        69 => "EDQUOT",
        _ => return None,
    })
}

/// The short reason of a system error (`systemReason`).
pub fn system_reason(error: &io::Error) -> String {
    let reason = match system_error_code(error) {
        Some("ENOENT") => "no such file or directory",
        Some("EISDIR") => "is a directory",
        Some("ENOTDIR") => "a path component is not a directory",
        Some("EACCES") => "permission denied",
        Some("EPERM") => "operation not permitted",
        Some("EROFS") => "read-only file system",
        Some("ENOSPC") => "no space left on device",
        Some("EMFILE") => "too many open files",
        Some("EEXIST") => "file already exists",
        Some(code) => return format!("{code}: {}", os_message(error)),
        None => return os_message(error),
    };
    reason.to_owned()
}

/// The operating system's message without Rust's `(os error N)`.
fn os_message(error: &io::Error) -> String {
    let text = error.to_string();
    match text.rfind(" (os error ") {
        Some(i) if text.ends_with(')') => text[..i].to_owned(),
        _ => text,
    }
}

/// The hint of an engine error code, as the CLI gives it.
fn kgdiff_hint(code: &str) -> Option<&'static str> {
    Some(match code {
        "delta-base-mismatch" => {
            "The delta was made for a different version of this graph. Use --no-strict to apply it anyway."
        }
        "delta-conflict" => {
            "The graph changed since the delta was made. --no-strict skips the failing operations."
        }
        "unsupported-version" => {
            "Upgrade kgdiff (npm install -g @kgdiff/cli@latest), or check that the file is a kgdiff delta."
        }
        "dangling-edge" => "An edge refers to a node the graph does not define.",
        _ => return None,
    })
}

/// The bug report form an unexpected error links to.
const BUG_REPORT_FORM: &str = "https://github.com/iiwish/kgdiff/issues/new";

/// `application/x-www-form-urlencoded`, as `URLSearchParams` writes it.
fn form_encode(text: &str) -> String {
    let mut out = String::new();
    for &b in text.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(b))
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The link to the bug report form, prefilled through the form's field ids with public metadata
/// only (`bugReportUrl`): error messages and paths can hold private data.
pub fn bug_report_url(version: &str, runtime: Option<&str>) -> String {
    let mut url = format!(
        "{BUG_REPORT_FORM}?template=bug_report.yml&version={}",
        form_encode(&format!("kgdiff {version}"))
    );
    if let Some(runtime) = runtime.filter(|r| !r.is_empty()) {
        url.push_str("&environment=");
        url.push_str(&form_encode(runtime));
    }
    url
}

/// The message and hint the user sees for a failure (`describeError`).
pub fn describe(failure: &Failure, bug_report_url: Option<&str>) -> (String, Option<String>) {
    match failure {
        Failure::Cli(e) => (e.message.clone(), e.hint.clone()),
        Failure::Kgdiff(e, _) => (
            e.message.clone(),
            kgdiff_hint(e.code.as_str()).map(str::to_owned),
        ),
        Failure::System(e, _) if system_error_code(e).is_some() => (system_reason(e), None),
        Failure::System(e, _) => unexpected(&os_message(e), bug_report_url),
        Failure::Unexpected(message, _) => unexpected(message, bug_report_url),
    }
}

fn unexpected(message: &str, bug_report_url: Option<&str>) -> (String, Option<String>) {
    let hint = match bug_report_url {
        Some(url) => {
            format!("This is a bug in kgdiff. Run again with DEBUG=kgdiff and report it: {url}")
        }
        None => {
            "This is a bug in kgdiff. Run again with DEBUG=kgdiff and report the output.".to_owned()
        }
    };
    (format!("Unexpected error: {message}"), Some(hint))
}

/// True when `DEBUG` turns on kgdiff's diagnostics (`kgdiff`, `kgdiff*`, `kgdiff:*`, `*`, in a
/// list separated by commas or whitespace).
pub fn debug_enabled(debug: Option<&str>) -> bool {
    debug
        .unwrap_or("")
        .split(|c: char| c == ',' || kgdiff_core::js::is_whitespace(c))
        .any(|d| matches!(d, "*" | "kgdiff" | "kgdiff*" | "kgdiff:*"))
}

/// One link of the cause chain, as `DEBUG=kgdiff` prints it: name, message and where it was
/// raised (the Rust counterpart of a JavaScript stack).
fn trace(failure: &Failure) -> String {
    let (name, message, location) = match failure {
        Failure::Cli(e) => ("CliError", e.message.clone(), e.location),
        Failure::Kgdiff(e, at) => (
            "KgdiffError",
            format!("[{}] {}", e.code.as_str(), e.message),
            *at,
        ),
        Failure::System(e, at) => {
            let message = match system_error_code(e) {
                Some(code) => format!("{code}: {}", os_message(e)),
                None => os_message(e),
            };
            ("Error", message, *at)
        }
        Failure::Unexpected(message, at) => ("Error", message.clone(), *at),
    };
    format!(
        "{name}: {message}\n    at {}:{}:{}",
        location.file(),
        location.line(),
        location.column()
    )
}

/// What stderr shows for a failure, ending with a newline (`formatError`). Messages quote user
/// input (paths, parser excerpts): escape sequences and bidi controls never reach the terminal.
pub fn format_error(
    failure: &Failure,
    paint: &Painter,
    debug: bool,
    bug_report_url: Option<&str>,
) -> String {
    let (message, hint) = describe(failure, bug_report_url);
    let mut lines = vec![format!(
        "{} {}",
        paint.bold(&paint.tone(Tone::Removed, "error:")),
        sanitize(&message)
    )];
    if let Some(hint) = hint {
        lines.push(format!(
            "{} {}",
            paint.tone(Tone::Accent, "hint:"),
            sanitize(&hint)
        ));
    }
    if debug {
        let mut current = Some(failure);
        let mut depth = 0;
        while let Some(f) = current.filter(|_| depth < 5) {
            lines.push(String::new());
            lines.push(paint.dim(&sanitize_lines(&trace(f))));
            if let Failure::Kgdiff(
                KgdiffError {
                    details: Some(details),
                    ..
                },
                _,
            ) = f
            {
                let text = json::to_string(&Value::Object(details.clone()));
                lines.push(paint.dim(&sanitize(&format!("details: {text}"))));
            }
            current = match f {
                Failure::Cli(CliError {
                    cause: Some(cause), ..
                }) => Some(cause),
                _ => None,
            };
            depth += 1;
        }
    }
    format!("{}\n", lines.join("\n"))
}

/// A warning line for stderr (`formatWarning`).
pub fn format_warning(message: &str, paint: &Painter) -> String {
    format!(
        "{} {}\n",
        paint.bold(&paint.tone(Tone::Content, "warning:")),
        sanitize(message)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_the_bug_report_form_with_public_metadata() {
        assert_eq!(
            bug_report_url("1.2.3", Some("linux x64, Node.js v24.0.0")),
            "https://github.com/iiwish/kgdiff/issues/new?template=bug_report.yml&version=kgdiff+1.2.3&environment=linux+x64%2C+Node.js+v24.0.0"
        );
        assert_eq!(
            bug_report_url("1.2.3", None),
            "https://github.com/iiwish/kgdiff/issues/new?template=bug_report.yml&version=kgdiff+1.2.3"
        );
        assert!(!bug_report_url("1.2.3", Some("")).contains("environment"));
    }

    #[test]
    fn reads_debug() {
        assert!(
            debug_enabled(Some("kgdiff"))
                && debug_enabled(Some("x, kgdiff:*"))
                && debug_enabled(Some("*"))
        );
        assert!(!debug_enabled(Some("kgdiffx")) && !debug_enabled(None));
    }

    #[test]
    fn names_system_errors_as_node() {
        assert_eq!(
            system_reason(&io::Error::from(io::ErrorKind::NotFound)),
            "no such file or directory"
        );
        #[cfg(unix)]
        assert_eq!(
            system_reason(&io::Error::from_raw_os_error(13)),
            "permission denied"
        );
        let other = Failure::System(io::Error::other("boom"), Location::caller());
        assert_eq!(describe(&other, None).0, "Unexpected error: boom");
    }
}
