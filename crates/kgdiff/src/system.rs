//! **Experimental.** This module may change in a minor release: the embedding interface of the
//! `kgdiff` crate still has the shape of its JavaScript origin, and no external host uses it yet.
//! It joins the semver promise once the Python bindings have used it
//! (see `docs/versioning.md`, "Experimental APIs").
//!
//! The real [`CliIo`]: the process's streams and environment, the file system,
//! the platform's opener and the viewer bundles compiled into kgdiff.

use std::borrow::Cow;
use std::fs;
use std::hash::{BuildHasher, RandomState};
use std::io::{self, IsTerminal, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use kgdiff_report::{MISSING_VIEWER_HINT, embedded_viewer};

use crate::errors::system_error_code;
use crate::io::{CliIo, Env, FileStat, StdinError, ViewerBundle, ViewerMissing};
use crate::paths;

/// The process as kgdiff sees it.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct SystemIo;

impl Env for SystemIo {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
    }
}

fn write_all(mut out: impl Write, text: &str) {
    let result = out.write_all(text.as_bytes()).and_then(|()| out.flush());
    // `kgdiff … | head` closes the pipe early: stop quietly, as other command-line tools do.
    if result
        .as_ref()
        .is_err_and(|e| e.kind() == io::ErrorKind::BrokenPipe)
    {
        std::process::exit(0);
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Hex digits from the operating system's randomness (`RandomState` keys) and a counter.
fn random_hex(digits: usize) -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let value = RandomState::new().hash_one((n, now, std::process::id()));
    let text = format!("{value:016x}");
    text[..digits.min(16)].to_owned()
}

/// Letters and digits, as `mkdtemp` picks them.
fn random_name(len: usize) -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut value = RandomState::new().hash_one((n, std::process::id()));
    (0..len)
        .map(|_| {
            let c = CHARS[usize::try_from(value % 62).unwrap_or(0)];
            value /= 62;
            char::from(c)
        })
        .collect()
}

/// Atomic replace: write `.<name>.<random>.tmp` next to `path` (created exclusively), copy the
/// permissions of the file it replaces, then rename it over `path`; the temporary file is
/// removed on failure.
fn write_file_atomic(path: &str, data: &[u8]) -> io::Result<()> {
    let temp = paths::join(
        &paths::dirname(path),
        &format!(".{}.{}.tmp", paths::basename(path), random_hex(12)),
    );
    let attempt = || -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o666);
        let mut file = options.open(&temp)?;
        file.write_all(data)?;
        drop(file);
        if let Ok(existing) = fs::metadata(path) {
            fs::set_permissions(&temp, existing.permissions())?;
        }
        fs::rename(&temp, path)
    };
    attempt().inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

#[cfg(unix)]
fn identity(path: &str, metadata: &fs::Metadata) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let _ = path;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn identity(path: &str, _metadata: &fs::Metadata) -> io::Result<(u64, u64)> {
    let handle = winapi_util::Handle::from_path_any(path)?;
    let info = winapi_util::file::information(&handle)?;
    Ok((info.volume_serial_number(), info.file_index()))
}

#[cfg(not(any(unix, windows)))]
fn identity(_path: &str, _metadata: &fs::Metadata) -> io::Result<(u64, u64)> {
    Ok((0, 0))
}

/// `canonicalize` without Windows' `\\?\` prefix, as `realpath` writes paths.
fn display_path(path: std::path::PathBuf) -> String {
    let text = path.to_string_lossy().into_owned();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    text.strip_prefix(r"\\?\")
        .map_or(text.clone(), str::to_owned)
}

/// `Date.prototype.toISOString`: `2026-11-09T12:34:56.789Z`.
pub fn iso_timestamp(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let millis = since.subsec_millis();
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// The command that opens a file with the default application.
fn open_command(path: &str) -> Command {
    if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(path);
        c
    } else if cfg!(windows) {
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut c = Command::new("cmd");
        // `start` takes its first quoted argument as a window title, hence the empty "". With
        // /s, cmd strips the outer quotes and runs the rest verbatim.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.raw_arg("/d /s /c")
                .raw_arg(format!("\"start \"\" \"{path}\"\""));
        }
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        c
    }
}

impl CliIo for SystemIo {
    fn write_stdout(&mut self, text: &str) {
        write_all(io::stdout().lock(), text);
    }

    fn write_stderr(&mut self, text: &str) {
        write_all(io::stderr().lock(), text);
    }

    fn read_stdin(&mut self, max_bytes: u64) -> Result<Vec<u8>, StdinError> {
        let mut data = Vec::new();
        io::stdin()
            .lock()
            .take(max_bytes.saturating_add(1))
            .read_to_end(&mut data)
            .map_err(StdinError::Io)?;
        if u64::try_from(data.len()).unwrap_or(u64::MAX) > max_bytes {
            return Err(StdinError::TooLarge);
        }
        Ok(data)
    }

    fn read_file(&mut self, path: &str) -> io::Result<Vec<u8>> {
        // Windows refuses to open a directory as a file: name it as Node does.
        if cfg!(windows) && fs::metadata(path).is_ok_and(|m| m.is_dir()) {
            return Err(io::Error::from(io::ErrorKind::IsADirectory));
        }
        fs::read(path)
    }

    fn write_file(&mut self, path: &str, data: &[u8]) -> io::Result<()> {
        write_file_atomic(path, data)
    }

    fn stat(&mut self, path: &str) -> io::Result<Option<FileStat>> {
        match fs::metadata(path) {
            Ok(metadata) => {
                let (dev, ino) = identity(path, &metadata)?;
                Ok(Some(FileStat {
                    dev,
                    ino,
                    size: metadata.len(),
                }))
            }
            Err(error) if matches!(system_error_code(&error), Some("ENOENT" | "ENOTDIR")) => {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn realpath(&mut self, path: &str) -> io::Result<String> {
        fs::canonicalize(path).map(display_path)
    }

    fn cwd(&self) -> String {
        std::env::current_dir()
            .map(display_path)
            .unwrap_or_else(|_| ".".to_owned())
    }

    fn is_tty(&self) -> bool {
        io::stdout().is_terminal()
    }

    fn stderr_is_tty(&self) -> bool {
        io::stderr().is_terminal()
    }

    fn stdin_is_tty(&self) -> bool {
        io::stdin().is_terminal()
    }

    fn columns(&self) -> Option<f64> {
        if !self.is_tty() {
            return None;
        }
        terminal_size::terminal_size_of(io::stdout()).map(|(w, _)| f64::from(w.0))
    }

    fn runtime(&self) -> Option<String> {
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "x86" => "ia32",
            other => other,
        };
        Some(format!("{platform} {arch}, native"))
    }

    fn now(&mut self) -> io::Result<String> {
        Ok(iso_timestamp(SystemTime::now()))
    }

    fn make_temp_dir(&mut self) -> io::Result<String> {
        let base = display_path(std::env::temp_dir());
        loop {
            let dir = paths::join(&base, &format!("kgdiff-{}", random_name(6)));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            match builder.create(&dir) {
                Ok(()) => return Ok(dir),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }

    fn open_file(&mut self, path: &str) -> io::Result<()> {
        let mut command = open_command(path);
        let program = command.get_program().to_string_lossy().into_owned();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match command.spawn() {
            Ok(_) => Ok(()),
            // `spawn xdg-open ENOENT`, as Node reports it.
            Err(error) => {
                let code = system_error_code(&error).unwrap_or("UNKNOWN");
                Err(io::Error::new(
                    error.kind(),
                    format!("spawn {program} {code}"),
                ))
            }
        }
    }

    fn viewer_bundle(&mut self, part: ViewerBundle) -> Result<Cow<'static, str>, ViewerMissing> {
        let (what, specifier) = match part {
            ViewerBundle::Main => ("standalone viewer bundle", "@kgdiff/viewer/standalone"),
            ViewerBundle::Compute => ("viewer compute add-on", "@kgdiff/viewer/standalone/compute"),
        };
        let source = embedded_viewer().and_then(|b| match part {
            ViewerBundle::Main => Some(b.main),
            ViewerBundle::Compute => b.compute,
        });
        source.map(Cow::Borrowed).ok_or_else(|| {
            ViewerMissing::new(format!("The HTML report needs the {what} ({specifier}), which this kgdiff was built without."), Some(MISSING_VIEWER_HINT.to_owned()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn writes_iso_timestamps() {
        assert_eq!(iso_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let t = UNIX_EPOCH + Duration::from_millis(1_793_534_400_123);
        assert_eq!(iso_timestamp(t), "2026-11-01T12:00:00.123Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(iso_timestamp(leap), "2000-02-29T00:00:00.000Z");
    }
}
