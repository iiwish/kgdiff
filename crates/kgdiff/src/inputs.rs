//! Reading inputs: files or stdin, gzip-compressed or not, UTF-8 or UTF-16 text,
//! parsed with kgdiff-formats. Failures become [`CliError`]s that name the input and suggest a
//! fix.

use std::io::Read;

use kgdiff_core::js;
use kgdiff_core::{ErrorCode, KgdiffError};
use kgdiff_formats::{FormatId, ParseOptions, ParseResult, parse_graph};
use kgdiff_report::width::sanitize;

use crate::args::{FORMATS, Format, STDIO};
use crate::errors::{CliError, CliErrorCode, CliResult, Failure, system_error_code, system_reason};
use crate::io::{CliIo, StdinError};
use crate::paths;

/// Display names of the formats, for messages.
pub const FORMAT_NAMES: [&str; 8] = [
    "JSON",
    "JSON-LD",
    "Turtle",
    "N-Triples",
    "N-Quads",
    "TriG",
    "RDF/XML",
    "OBO",
];

/// An input read as text.
#[derive(Clone, Debug)]
pub struct RawInput {
    /// How messages call it: the path as given (sanitized), or `stdin`.
    pub display: String,
    /// The file name without directories and without `.gz` (format detection, `meta.source`).
    pub filename: Option<String>,
    pub text: String,
    /// Empty or whitespace only (returned only with `allow_empty`).
    pub empty: bool,
}

/// `path` against the working directory.
pub fn resolve_path(io: &dyn CliIo, path: &str) -> String {
    paths::resolve(&io.cwd(), path)
}

/// The default input size limit, after decompression: 1 GiB.
pub const DEFAULT_MAX_INPUT: u64 = 1024 * 1024 * 1024;

fn input_error(message: String, hint: Option<String>) -> CliError {
    CliError::new(CliErrorCode::Input, message, hint)
}

/// `KGDIFF_MAX_INPUT` (bytes, or with a binary `K` / `M` / `G` suffix, e.g. `4G`), else
/// [`DEFAULT_MAX_INPUT`].
pub fn max_input_bytes(io: &dyn CliIo) -> CliResult<u64> {
    let Some(raw) = io.var("KGDIFF_MAX_INPUT") else {
        return Ok(DEFAULT_MAX_INPUT);
    };
    let raw = js::trim(&raw);
    if raw.is_empty() {
        return Ok(DEFAULT_MAX_INPUT);
    }
    let value = size_value(raw).unwrap_or(f64::NAN);
    if !value.is_finite() || value < 1.0 {
        return Err(Failure::Cli(CliError::new(
            CliErrorCode::Usage,
            format!("Invalid KGDIFF_MAX_INPUT \"{}\".", sanitize(raw)),
            Some("Use a byte count such as 2147483648, or 512M / 2G.".to_owned()),
        )));
    }
    Ok(u64::try_from(kgdiff_core::util::f64_to_count(value)).unwrap_or(u64::MAX))
}

/// `/^(\d+(?:\.\d+)?)\s*([kmg]?)i?b?$/i` read as a number of bytes.
fn size_value(raw: &str) -> Option<f64> {
    let digits_end = raw.find(|c: char| !c.is_ascii_digit()).unwrap_or(raw.len());
    if digits_end == 0 {
        return None;
    }
    let mut end = digits_end;
    let rest = &raw[digits_end..];
    if let Some(frac) = rest.strip_prefix('.') {
        let n = frac
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(frac.len());
        if n > 0 {
            end += 1 + n;
        }
    }
    let number = js::number_from_str(&raw[..end]);
    let mut rest = raw[end..].trim_start_matches(js::is_whitespace);
    let mut unit = 1.0;
    if let Some(c) = rest.chars().next() {
        let factor = match c.to_ascii_lowercase() {
            'k' => Some(1024.0),
            'm' => Some(1024.0 * 1024.0),
            'g' => Some(1024.0 * 1024.0 * 1024.0),
            _ => None,
        };
        if let Some(f) = factor {
            unit = f;
            rest = &rest[1..];
        }
    }
    let mut chars = rest.chars().peekable();
    if chars.peek().is_some_and(|c| c.eq_ignore_ascii_case(&'i')) {
        chars.next();
    }
    if chars.peek().is_some_and(|c| c.eq_ignore_ascii_case(&'b')) {
        chars.next();
    }
    if chars.next().is_some() {
        return None;
    }
    Some(number * unit)
}

/// `1.3 KiB`, `2 GiB`, `90 B`: one decimal at most (`Number(x.toFixed(1))`).
fn format_bytes(bytes: u64) -> String {
    let n = kgdiff_core::util::count_to_f64(usize::try_from(bytes).unwrap_or(usize::MAX));
    for (unit, size) in [
        ("GiB", 1024.0 * 1024.0 * 1024.0),
        ("MiB", 1024.0 * 1024.0),
        ("KiB", 1024.0),
    ] {
        if n >= size {
            let fixed = js::to_fixed(n / size, 1);
            return format!(
                "{} {unit}",
                js::number_to_string(js::number_from_str(&fixed))
            );
        }
    }
    format!("{bytes} B")
}

fn too_large(where_: &str, limit: u64) -> CliError {
    input_error(
        format!("{where_} is too large: the input limit is {}.", format_bytes(limit)),
        Some("If the input is genuine, raise the limit with KGDIFF_MAX_INPUT (e.g. KGDIFF_MAX_INPUT=4G).".to_owned()),
    )
}

/// What zlib calls a broken gzip stream, as Node reports it.
fn gunzip_reason(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::UnexpectedEof {
        return "unexpected end of file".to_owned();
    }
    let text = error.to_string();
    if let Some(reason) = text.strip_prefix("zlib: ") {
        // Our own header checks, already in zlib's words.
        return reason.to_owned();
    }
    if text.contains("checksum") || text.contains("crc") {
        "incorrect data check".to_owned()
    } else {
        "invalid block type".to_owned()
    }
}

const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// `gunzipSync(data, { maxOutputLength: limit })`: one member after another until the input
/// ends (bytes after a member are read as the next one, as zlib does); `None` beyond `limit`.
fn gunzip(data: &[u8], limit: u64) -> std::io::Result<Option<Vec<u8>>> {
    let zlib = |message: &str| std::io::Error::other(format!("zlib: {message}"));
    let mut out = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        if rest.len() >= 2 && !rest.starts_with(&GZIP_MAGIC) {
            return Err(zlib("incorrect header check"));
        }
        if rest.len() >= 3 && rest[2] != 8 {
            return Err(zlib("unknown compression method"));
        }
        let room = limit
            .saturating_add(1)
            .saturating_sub(u64::try_from(out.len()).unwrap_or(u64::MAX));
        let mut decoder = flate2::bufread::GzDecoder::new(rest);
        decoder.by_ref().take(room).read_to_end(&mut out)?;
        if u64::try_from(out.len()).unwrap_or(u64::MAX) > limit {
            return Ok(None);
        }
        rest = decoder.into_inner();
    }
    Ok(Some(out))
}

/// Decodes input bytes: gunzip when compressed (the output capped at `limit`,
/// so that a gzip bomb is an error, not an out-of-memory crash), UTF-16 by byte order mark,
/// else strict UTF-8.
pub fn decode_text(bytes: Vec<u8>, where_: &str, limit: u64) -> CliResult<String> {
    let data = if bytes.starts_with(&GZIP_MAGIC) {
        match gunzip(&bytes, limit) {
            Ok(Some(out)) => out,
            Ok(None) => return Err(too_large(&format!("{where_} (decompressed)"), limit).into()),
            Err(error) => {
                let reason = gunzip_reason(&error);
                return Err(
                    input_error(format!("Cannot decompress {where_}: {reason}."), None).into(),
                );
            }
        }
    } else {
        bytes
    };
    let invalid = |encoding: &str| {
        let formats = FORMAT_NAMES.join(", ");
        Failure::from(input_error(
            format!("{where_} is not valid {encoding} text."),
            Some(format!(
                "kgdiff reads text formats ({formats}). Convert binary formats first."
            )),
        ))
    };
    let utf16 = |le: bool| -> CliResult<String> {
        let body = &data[2..];
        let encoding = if le { "UTF-16LE" } else { "UTF-16BE" };
        if body.len() % 2 != 0 {
            return Err(invalid(encoding));
        }
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|_| invalid(encoding))
    };
    if data.starts_with(&[0xff, 0xfe]) {
        return utf16(true);
    }
    if data.starts_with(&[0xfe, 0xff]) {
        return utf16(false);
    }
    let text = String::from_utf8(data).map_err(|_| invalid("UTF-8"))?;
    // TextDecoder drops a byte order mark.
    Ok(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => text,
    })
}

/// How [`read_input`] treats empty inputs.
#[derive(Clone, Copy, Debug, Default)]
pub struct ReadOptions<'a> {
    /// Accept an empty (or whitespace-only) input as an empty graph (`--allow-empty`).
    pub allow_empty: bool,
    /// The hint when the input is empty and that is not allowed.
    pub empty_hint: Option<&'a str>,
}

/// Reads a file, or stdin for `-`, as text. `role` names the argument in
/// messages. Inputs above the size limit, and empty inputs unless allowed, are errors.
pub fn read_input(
    io: &mut dyn CliIo,
    path: &str,
    role: &str,
    options: ReadOptions<'_>,
) -> CliResult<RawInput> {
    let limit = max_input_bytes(io)?;
    let (display, where_, filename, bytes) = if path == STDIO {
        if io.stdin_is_tty() {
            io.write_stderr(&format!("Reading {role} from stdin… (end with Ctrl-D)\n"));
        }
        let where_ = format!("{role} (stdin)");
        let bytes = match io.read_stdin(limit) {
            Ok(bytes) => bytes,
            Err(StdinError::TooLarge) => return Err(too_large(&where_, limit).into()),
            Err(StdinError::Io(error)) => return Err(error.into()),
        };
        ("stdin".to_owned(), where_, None, bytes)
    } else {
        let display = sanitize(path);
        let where_ = format!("{role} \"{display}\"");
        let absolute = resolve_path(io, path);
        // `None`: larger than the limit.
        let read = |io: &mut dyn CliIo| -> Result<Option<Vec<u8>>, std::io::Error> {
            if let Some(stat) = io.stat(&absolute)?
                && stat.size > limit
            {
                return Ok(None);
            }
            io.read_file(&absolute).map(Some)
        };
        let bytes = match read(io) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Err(too_large(&where_, limit).into()),
            Err(error) => {
                let hint = match system_error_code(&error) {
                    Some("ENOENT") => Some("Check the path. Use - to read from stdin."),
                    Some("EISDIR") => Some("Pass a file, not a directory."),
                    Some("EACCES") => Some("Check the file permissions."),
                    _ => None,
                };
                let message = format!("Cannot read {where_}: {}.", system_reason(&error));
                return Err(input_error(message, hint.map(str::to_owned))
                    .caused_by(error.into())
                    .into());
            }
        };
        let base = paths::basename(path);
        let filename = strip_gz(base);
        (display, where_, Some(filename), bytes)
    };
    let text = decode_text(bytes, &where_, limit)?;
    let empty = js::trim(&text).is_empty();
    if empty && !options.allow_empty {
        let hint = options.empty_hint.map_or_else(
            || {
                if path == STDIO {
                    "Did the command before the pipe fail? Pass --allow-empty if an empty graph is intended."
                } else {
                    "Pass --allow-empty to compare with an empty graph (e.g. before a first release)."
                }
                .to_owned()
            },
            str::to_owned,
        );
        return Err(input_error(format!("{where_} is empty."), Some(hint)).into());
    }
    Ok(RawInput {
        display,
        filename,
        text,
        empty,
    })
}

/// `name.replace(/\.gz$/i, '')`.
fn strip_gz(name: &str) -> String {
    let n = name.len();
    if n >= 3 && name.is_char_boundary(n - 3) && name[n - 3..].eq_ignore_ascii_case(".gz") {
        name[..n - 3].to_owned()
    } else {
        name.to_owned()
    }
}

/// Reads two inputs; when both fail, the first one's error is reported. Both are
/// read either way.
pub fn read_pair(
    io: &mut dyn CliIo,
    first: (&str, &str, ReadOptions<'_>),
    second: (&str, &str, ReadOptions<'_>),
) -> CliResult<(RawInput, RawInput)> {
    let a = read_input(io, first.0, first.1, first.2);
    let b = read_input(io, second.0, second.1, second.2);
    Ok((a?, b?))
}

/// How [`parse_input`] parses a graph.
#[derive(Clone, Debug)]
pub struct GraphParseOptions<'a> {
    pub format: Format,
    pub languages: Option<&'a [String]>,
    /// The flag that sets this input's format, for hints (`--before-format`).
    pub format_flag: &'a str,
}

/// `message.replace(/\.$/, '')`.
fn strip_period(message: &str) -> &str {
    message.strip_suffix('.').unwrap_or(message)
}

/// Parses a graph, turning parser errors into messages that name the input.
pub fn parse_input(input: &RawInput, options: &GraphParseOptions<'_>) -> CliResult<ParseResult> {
    let mut parse_options = ParseOptions::default();
    parse_options.format = options.format;
    parse_options.filename = input.filename.clone();
    parse_options.rdf.languages = options.languages.map(<[String]>::to_vec);
    if input.empty {
        // --allow-empty: an empty graph, without asking a parser to guess the format of nothing.
        parse_options.format = Some(FormatId::Json);
        return Ok(parse_graph("{\"nodes\":[],\"edges\":[]}", &parse_options)?);
    }
    match parse_graph(&input.text, &parse_options) {
        Ok(result) => Ok(result),
        Err(error) => Err(parse_failure(input, options, error)),
    }
}

fn parse_failure(input: &RawInput, options: &GraphParseOptions<'_>, error: KgdiffError) -> Failure {
    let where_ = if input.display == "stdin" {
        "stdin".to_owned()
    } else {
        format!("\"{}\"", input.display)
    };
    let undetected = to_lower(&error.message).contains("could not detect the format");
    let message = if undetected {
        format!("Cannot tell the format of {where_}.")
    } else {
        format!("{where_}: {}.", strip_period(&error.message))
    };
    let formats = FORMATS[1..].join(", ");
    // A kgdiff file names its own format and version: another --format cannot help.
    let marked = error.code == ErrorCode::UnsupportedVersion;
    let newer = marked
        && error
            .details
            .as_ref()
            .and_then(|d| d.get("version"))
            .and_then(js::Value::as_f64)
            .is_some_and(|v| v > 1.0);
    let flag = options.format_flag;
    let hint = if undetected {
        Some(format!(
            "Pass {flag} <fmt> ({formats}) or use a known file extension."
        ))
    } else if newer {
        Some("Upgrade kgdiff: npm install -g @kgdiff/cli@latest.".to_owned())
    } else if options.format.is_none() && !marked {
        Some(format!(
            "If the format was detected wrongly, pass {flag} <fmt> ({formats})."
        ))
    } else {
        None
    };
    input_error(message, hint).caused_by(error.into()).into()
}

fn to_lower(text: &str) -> String {
    kgdiff_core::text::to_lowercase(text).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sizes_and_writes_them() {
        assert_eq!(size_value("4G"), Some(4.0 * 1024.0 * 1024.0 * 1024.0));
        assert_eq!(size_value("512 MiB"), Some(512.0 * 1024.0 * 1024.0));
        assert_eq!(size_value("1.5k"), Some(1536.0));
        assert_eq!(size_value("10b"), Some(10.0));
        assert_eq!(size_value("1e3"), None);
        assert_eq!(size_value("x"), None);
        assert_eq!(size_value("1.k"), None);
        assert_eq!(format_bytes(1331), "1.3 KiB");
        assert_eq!(format_bytes(2048), "2 KiB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1 GiB");
        assert_eq!(format_bytes(90), "90 B");
        assert_eq!(strip_gz("a.json.GZ"), "a.json");
    }
}
