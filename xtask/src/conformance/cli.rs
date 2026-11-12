//! Recording what the CLI produces (README, "CLI runs"): the Rust `kgdiff`, run as a real process
//! exactly as `pnpm conformance:replay` runs it, in a copy of the case directory.

use std::ffi::OsString;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use kgdiff_core::js::{Object, Value, json};

use super::compact;

/// How the CLI's version appears in recorded output (Markdown footers name it).
pub const VERSION_PLACEHOLDER: &str = "kgdiff <version>";

/// The executable that records the runs, and the version it reports (`kgdiff X.Y.Z`).
pub struct Recorder {
    pub bin: PathBuf,
    pub version: String,
}

/// What one run printed and its exit code.
pub struct Captured {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Recorder {
    /// A recorder for `bin`, with the version its `--version` prints.
    pub fn new(bin: PathBuf, cwd: &Path) -> Result<Recorder, String> {
        let mut recorder = Recorder {
            bin,
            version: String::new(),
        };
        let run = recorder.capture(
            "--version",
            &["--version".to_owned()],
            cwd,
            &Object::new(),
            None,
        )?;
        let version = run
            .stdout
            .strip_prefix("kgdiff ")
            .and_then(|rest| rest.split_ascii_whitespace().next())
            .map(|v| format!("kgdiff {v}"));
        match version {
            Some(version) if run.code == 0 => recorder.version = version,
            _ => {
                return Err(format!(
                    "{} --version exited with {}: {}",
                    recorder.bin.display(),
                    run.code,
                    run.stderr
                ));
            }
        }
        Ok(recorder)
    }

    /// Runs `kgdiff` in `cwd` with `env` and only what starting a process needs besides it, stdin
    /// from `stdin` or empty, stdout and stderr through pipes; its output must be UTF-8.
    pub fn capture(
        &self,
        name: &str,
        args: &[String],
        cwd: &Path,
        env: &Object,
        stdin: Option<Vec<u8>>,
    ) -> Result<Captured, String> {
        let mut command = Command::new(&self.bin);
        command
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(process_env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env.iter() {
            command.env(key.as_str(), value.to_js_string());
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("{}: {e}", self.bin.display()))?;
        let mut pipe = child.stdin.take().ok_or("no stdin pipe")?;
        let input = stdin.unwrap_or_default();
        // A run that does not read stdin may exit before it is written: not an error.
        let writer = std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut out = child.stdout.take().ok_or("no stdout pipe")?;
        let mut err = child.stderr.take().ok_or("no stderr pipe")?;
        let reader = std::thread::spawn(move || {
            let mut buffer = Vec::new();
            err.read_to_end(&mut buffer).map(|_| buffer)
        });
        out.read_to_end(&mut stdout).map_err(|e| e.to_string())?;
        stderr.extend(
            reader
                .join()
                .map_err(|_| "the stderr reader panicked")?
                .map_err(|e| e.to_string())?,
        );
        let _ = writer.join();
        let status = child.wait().map_err(|e| e.to_string())?;
        let code = status
            .code()
            .ok_or_else(|| format!("run \"{name}\" did not finish ({status})"))?;
        let text = |data: Vec<u8>, stream: &str| {
            String::from_utf8(data)
                .map_err(|_| format!("run \"{name}\" wrote {stream} that is not UTF-8"))
        };
        Ok(Captured {
            code,
            stdout: text(stdout, "stdout")?,
            stderr: text(stderr, "stderr")?,
        })
    }
}

/// What a process needs to start, besides the recorded environment.
fn process_env() -> Vec<(&'static str, OsString)> {
    let mut env = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        env.push(("PATH", path));
    }
    if cfg!(windows)
        && let Some(root) = std::env::var_os("SystemRoot")
    {
        env.push(("SystemRoot", root));
    }
    env
}

/// The payload script of an HTML report: plain JSON, or gzip + base64 (`data-encoding`).
pub fn embedded_payload(html: &str) -> Result<Value, String> {
    const OPEN: &str = "<script type=\"application/kgdiff+json\"";
    let start = html.find(OPEN).ok_or("the report has no payload script")? + OPEN.len();
    let rest = &html[start..];
    let end_attrs = rest.find('>').ok_or("an unterminated payload script")?;
    let attrs = &rest[..end_attrs];
    let body_and_rest = &rest[end_attrs + 1..];
    let end_body = body_and_rest
        .find('<')
        .ok_or("an unterminated payload script")?;
    if !body_and_rest[end_body..].starts_with("</script>") || attrs.contains('<') {
        return Err("the payload script holds markup".to_owned());
    }
    let body = &body_and_rest[..end_body];
    let text = if attrs.contains("data-encoding=\"gzip-base64\"") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|e| format!("the payload is not base64: {e}"))?;
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_end(&mut out)
            .map_err(|e| format!("the payload is not gzip: {e}"))?;
        String::from_utf8(out).map_err(|e| e.to_string())?
    } else {
        body.to_owned()
    };
    json::parse(&text).map_err(|e| format!("the payload is not JSON: {e}"))
}

/// How many `<script` elements the report has (`/<script\b/g`).
pub fn script_count(html: &str) -> usize {
    html.match_indices("<script")
        .filter(|(at, tag)| {
            !html[at + tag.len()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
        .count()
}

/// What the report records besides its diff and layout, after checking both: format, version,
/// meta (with the generator's version replaced) and view.
pub fn report_record(
    html: &str,
    recorder: &Recorder,
    packed_text: &str,
    expected_layout: &Value,
) -> Result<Value, String> {
    let payload = embedded_payload(html)?;
    let layout = payload.get("layout").cloned().unwrap_or_default();
    if layout.get("version") != Some(&Value::Number(2.0))
        || layout.get("generator").and_then(Value::as_str).is_none()
    {
        return Err("the report's layout is not a version 2 document with a generator".to_owned());
    }
    if &layout != expected_layout {
        return Err(
            "the report's layout differs from layout_to_json(layout_diff(diff(…)))".to_owned(),
        );
    }
    let scope = expected_layout.get("scope").and_then(Value::as_str);
    let scripts = script_count(html);
    if scripts != if scope == Some("changes") { 3 } else { 2 } {
        return Err(format!(
            "the report has {scripts} scripts with a layout of scope {scope:?}"
        ));
    }
    if compact(&payload.get("diff").cloned().unwrap_or_default()) != packed_text {
        return Err(
            "the report's diff differs from pack_diff_json(diff_to_json(diff(…)))".to_owned(),
        );
    }
    let mut meta = payload
        .get("meta")
        .and_then(Value::as_object)
        .cloned()
        .ok_or("the report has no meta")?;
    let generator = meta.get("generator").and_then(Value::as_str);
    if generator != Some(recorder.version.as_str()) {
        return Err(format!(
            "the report names its generator {generator:?}, not \"{}\"",
            recorder.version
        ));
    }
    meta.insert("generator", VERSION_PLACEHOLDER);
    let mut out = Object::new();
    for key in ["format", "version"] {
        out.insert(key, payload.get(key).cloned().unwrap_or_default());
    }
    out.insert("meta", meta);
    out.insert("view", payload.get("view").cloned().unwrap_or_default());
    Ok(Value::Object(out))
}
