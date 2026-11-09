//! Command-line parsing and validation (`args.ts`, docs/cli.md §Usage).
//!
//! The tokens are those of Node's `util.parseArgs` (tokens mode, `strict: false`), whose rules
//! the TypeScript CLI builds on and whose quirks its messages show: `-ofile` and `-o file` bind a
//! value, `-o=file` binds `=file`, `-qv` is `-q -v`, a string option takes the next argument
//! whatever it starts with. On top of them, kgdiff's own rules: known options only, string
//! options need a value (one that starts with `-` must be attached with `=`), booleans take
//! none, and options with an optional value (`--json [file]`, `--delta [file]`,
//! `--markdown [file]`) take the next argument unless it is needed as one of the two files
//! (`kgdiff --json a.ttl b.ttl` writes JSON to stdout). Pure: no I/O.

use kgdiff_core::js::IndexMap;

use kgdiff_core::Locale;
use kgdiff_core::js::{self, Object, Value};
use kgdiff_core::text::to_lowercase;
use kgdiff_formats::FormatId;
use kgdiff_report::match_locale;

use crate::errors::{CliResult, Failure, HELP_HINT, usage, usage_with};
use crate::style::ColorMode;

/// The path that means stdout / stdin.
pub const STDIO: &str = "-";

/// `--format` values.
pub const FORMATS: [&str; 9] = [
    "auto", "json", "jsonld", "turtle", "ntriples", "nquads", "trig", "rdfxml", "obo",
];
const MATCH_STRATEGIES: [&str; 3] = ["id", "auto", "similarity"];
const EDGE_IDENTITIES: [&str; 2] = ["structure", "id"];
const THEMES: [&str; 3] = ["auto", "light", "dark"];
/// `changes` is the viewer's legacy mode: overlay with `--scope changes`.
const MODES: [&str; 4] = ["overlay", "swipe", "replay", "changes"];
const SCOPES: [&str; 2] = ["all", "changes"];
/// `--panels` regions and states (`@kgdiff/viewer/panels`).
pub const PANEL_REGIONS: [&str; 11] = [
    "list",
    "detail",
    "search",
    "filters",
    "dock",
    "transport",
    "legend",
    "zoom",
    "minimap",
    "title",
    "actions",
];
pub const PANEL_STATES: [&str; 3] = ["open", "collapsed", "hidden"];
/// The default `--limit`.
pub const DEFAULT_LIMIT: usize = 50;

/// A format option: `None` is `auto`.
pub type Format = Option<FormatId>;

/// Options of every command.
#[derive(Clone, Debug, Default)]
pub struct CommonOptions {
    pub color: ColorMode,
    pub quiet: bool,
    pub locale: Option<Locale>,
}

/// `kgdiff <before> <after>`.
#[derive(Clone, Debug)]
pub struct DiffCommandOptions {
    pub common: CommonOptions,
    /// Paths, or `-` for stdin.
    pub before: String,
    pub after: String,
    pub before_format: Format,
    pub after_format: Format,
    /// `--lang`: the RDF label language preference.
    pub languages: Option<Vec<String>>,
    /// The diff options as given (`DiffOptions` before `resolveOptions`, which `diff` runs).
    pub diff: Value,
    pub stat: bool,
    pub name_status: bool,
    /// Output paths, or `-` for stdout.
    pub json: Option<String>,
    pub delta: Option<String>,
    pub markdown: Option<String>,
    pub html: Option<String>,
    pub open: bool,
    pub pretty: bool,
    pub title: Option<String>,
    pub theme: Option<String>,
    pub mode: Option<String>,
    pub scope: Option<String>,
    /// `--panels`: `(region, state)` in the order a JavaScript object keeps them.
    pub panels: Option<Vec<(String, String)>>,
    pub reproducible: bool,
    pub allow_empty: bool,
    /// False with `--no-compute`.
    pub compute: bool,
    pub exit_code: bool,
    /// Hunks listed in the summary; 0 lists all.
    pub limit: usize,
    /// `--watch-attr`: the attributes flagged ⚑ for review first, replacing the defaults.
    pub watch_attrs: Option<Vec<String>>,
}

/// `kgdiff apply <graph> <delta>`.
#[derive(Clone, Debug)]
pub struct ApplyCommandOptions {
    pub common: CommonOptions,
    pub graph: String,
    pub delta: String,
    /// Output path, or `-` for stdout.
    pub output: String,
    pub strict: bool,
    pub format: Format,
    pub languages: Option<Vec<String>>,
    pub pretty: bool,
    pub allow_empty: bool,
    /// `--verbose`: list what `--no-strict` skipped.
    pub verbose: bool,
}

/// What the command line asks for.
#[derive(Clone, Debug)]
pub enum Command {
    Help { topic: HelpTopic, color: ColorMode },
    Version,
    Diff(Box<DiffCommandOptions>),
    Apply(Box<ApplyCommandOptions>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelpTopic {
    Main,
    Apply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Boolean,
    String,
}

#[derive(Clone, Copy, Debug)]
struct OptionSpec {
    name: &'static str,
    kind: Kind,
    short: Option<char>,
    /// `--json [file]`: a string option whose value may be omitted.
    optional_value: bool,
}

const fn boolean(name: &'static str) -> OptionSpec {
    OptionSpec {
        name,
        kind: Kind::Boolean,
        short: None,
        optional_value: false,
    }
}
const fn string(name: &'static str) -> OptionSpec {
    OptionSpec {
        name,
        kind: Kind::String,
        short: None,
        optional_value: false,
    }
}
const fn short(spec: OptionSpec, c: char) -> OptionSpec {
    OptionSpec {
        short: Some(c),
        ..spec
    }
}
const fn optional(name: &'static str) -> OptionSpec {
    OptionSpec {
        name,
        kind: Kind::String,
        short: None,
        optional_value: true,
    }
}

const COMMON: [OptionSpec; 7] = [
    short(boolean("help"), 'h'),
    short(boolean("version"), 'v'),
    short(boolean("quiet"), 'q'),
    string("color"),
    string("locale"),
    string("lang"),
    boolean("pretty"),
];

const DIFF_ONLY: [OptionSpec; 28] = [
    boolean("stat"),
    boolean("name-status"),
    optional("json"),
    optional("delta"),
    optional("markdown"),
    short(string("html"), 'o'),
    boolean("open"),
    short(string("format"), 'f'),
    string("before-format"),
    string("after-format"),
    string("match"),
    string("threshold"),
    string("edge-identity"),
    string("hierarchy"),
    string("ignore-attr"),
    boolean("no-merges"),
    boolean("no-splits"),
    string("title"),
    string("theme"),
    string("mode"),
    string("scope"),
    string("panels"),
    boolean("reproducible"),
    boolean("no-compute"),
    boolean("allow-empty"),
    boolean("exit-code"),
    string("limit"),
    string("watch-attr"),
];

const APPLY_ONLY: [OptionSpec; 5] = [
    short(string("output"), 'o'),
    short(string("format"), 'f'),
    boolean("no-strict"),
    boolean("allow-empty"),
    boolean("verbose"),
];

/// The long names of the options of `kgdiff <before> <after>`, in the order of the help.
pub fn diff_option_names() -> Vec<&'static str> {
    diff_spec().iter().map(|s| s.name).collect()
}

fn diff_spec() -> Vec<OptionSpec> {
    COMMON.iter().chain(DIFF_ONLY.iter()).copied().collect()
}

fn apply_spec() -> Vec<OptionSpec> {
    COMMON.iter().chain(APPLY_ONLY.iter()).copied().collect()
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

/// Edit distance in UTF-16 units: insertions, deletions, substitutions and adjacent
/// transpositions (`editDistance`).
pub fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = v;
        }
    }
    d[a.len()][b.len()]
}

/// The closest candidate within a small edit distance, or sharing a prefix (`suggest`).
pub fn suggest<'a>(input: &str, candidates: &[&'a str]) -> Option<&'a str> {
    let needle = to_lowercase(input);
    let needle_len = js::utf16_len(&needle);
    let mut best = None;
    // Scores are whole numbers or one half: doubled, they compare as integers.
    let mut best_score = usize::MAX;
    for &c in candidates {
        let distance = edit_distance(&needle, &to_lowercase(c));
        let limit = (js::utf16_len(c) / 3).clamp(1, 3);
        let score = if c.starts_with(needle.as_ref()) && needle_len >= 2 {
            1
        } else {
            distance * 2
        };
        if score <= limit * 2 && score < best_score {
            best = Some(c);
            best_score = score;
        }
    }
    best
}

// ─── Tokens (`util.parseArgs`) ───────────────────────────────────────────────

#[derive(Clone, Debug)]
enum Token {
    Option {
        index: usize,
        name: String,
        raw_name: String,
        value: Option<String>,
        inline: bool,
    },
    Positional {
        index: usize,
        value: String,
    },
    Terminator,
}

/// A string of UTF-16 units, lone surrogates as U+FFFD (what a process writes).
fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// The tokens `parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true })`
/// gives. `string_typed` tells whether a long name is a string option; `long_for_short` finds
/// the long name of a short option (the short itself when none has it).
fn tokenize(args: &[String], spec: &[OptionSpec]) -> Vec<Token> {
    let string_typed = |name: &str| {
        spec.iter()
            .any(|s| s.name == name && s.kind == Kind::String && !s.optional_value)
    };
    let long_for_short = |unit: &[u16]| -> String {
        let short = text(unit);
        spec.iter()
            .find(|s| s.short.is_some_and(|c| c.to_string() == short))
            .map_or(short, |s| s.name.to_owned())
    };
    let mut tokens = Vec::new();
    let mut remaining: std::collections::VecDeque<Vec<u16>> =
        args.iter().map(|a| a.encode_utf16().collect()).collect();
    let mut index: isize = -1;
    let mut group_count = 0usize;
    let dash = u16::from(b'-');
    let eq = u16::from(b'=');
    while let Some(arg) = remaining.pop_front() {
        if group_count > 0 {
            group_count -= 1;
        } else {
            index += 1;
        }
        let at = usize::try_from(index).unwrap_or(0);
        if arg == [dash, dash] {
            tokens.push(Token::Terminator);
            for (i, rest) in (at + 1..).zip(remaining.drain(..)) {
                tokens.push(Token::Positional {
                    index: i,
                    value: text(&rest),
                });
            }
            break;
        }
        let starts_dash = arg.first() == Some(&dash);
        let second_dash = arg.get(1) == Some(&dash);
        // `-f`
        if arg.len() == 2 && starts_dash && !second_dash {
            let name = long_for_short(&arg[1..2]);
            let mut value = None;
            if string_typed(&name)
                && let Some(next) = remaining.pop_front()
            {
                value = Some(text(&next));
            }
            let took = value.is_some();
            tokens.push(Token::Option {
                index: at,
                name,
                raw_name: text(&arg),
                value,
                inline: false,
            });
            if took {
                index += 1;
            }
            continue;
        }
        if arg.len() > 2 && starts_dash && !second_dash {
            let name = long_for_short(&arg[1..2]);
            if !string_typed(&name) {
                // `-abc` → `-a -b -c`; a string option in the middle takes the rest as its value.
                let mut expanded = Vec::new();
                for i in 1..arg.len() {
                    let unit = &arg[i..=i];
                    if !string_typed(&long_for_short(unit)) || i == arg.len() - 1 {
                        expanded.push(vec![dash, unit[0]]);
                    } else {
                        let mut rest = vec![dash];
                        rest.extend_from_slice(&arg[i..]);
                        expanded.push(rest);
                        break;
                    }
                }
                group_count = expanded.len();
                for e in expanded.into_iter().rev() {
                    remaining.push_front(e);
                }
                continue;
            }
            // `-fFILE`
            tokens.push(Token::Option {
                index: at,
                raw_name: format!("-{}", text(&arg[1..2])),
                name,
                value: Some(text(&arg[2..])),
                inline: true,
            });
            continue;
        }
        if arg.len() > 2 && starts_dash && second_dash {
            // An `=` from the fourth unit on makes it `--name=value`, split at the first `=`.
            let has_value = arg[3..].contains(&eq);
            match arg.iter().position(|&u| u == eq).filter(|_| has_value) {
                // `--foo`
                None => {
                    let name = text(&arg[2..]);
                    let mut value = None;
                    if string_typed(&name)
                        && let Some(next) = remaining.pop_front()
                    {
                        value = Some(text(&next));
                    }
                    let took = value.is_some();
                    tokens.push(Token::Option {
                        index: at,
                        name,
                        raw_name: text(&arg),
                        value,
                        inline: false,
                    });
                    if took {
                        index += 1;
                    }
                }
                // `--foo=bar`
                Some(eq_at) => {
                    let name = text(&arg[2..eq_at]);
                    tokens.push(Token::Option {
                        index: at,
                        raw_name: format!("--{name}"),
                        name,
                        value: Some(text(&arg[eq_at + 1..])),
                        inline: true,
                    });
                }
            }
            continue;
        }
        tokens.push(Token::Positional {
            index: at,
            value: text(&arg),
        });
    }
    tokens
}

// ─── kgdiff's rules ──────────────────────────────────────────────────────────

/// The option values (`true` for a flag or an optional value left out) and the positionals.
struct RawParse {
    values: IndexMap<String, Vec<Option<String>>>,
    positionals: Vec<String>,
}

/// Options whose value is a file path (a leading `-` can be written `./-name`).
fn looks_like_path(name: &str) -> bool {
    matches!(name, "html" | "output" | "json" | "delta" | "markdown")
}

fn raw_parse(
    argv: &[String],
    spec: &[OptionSpec],
    positionals_needed: usize,
) -> CliResult<RawParse> {
    let find = |name: &str| spec.iter().find(|s| s.name == name);
    let known: Vec<&str> = spec.iter().map(|s| s.name).collect();
    let mut after_terminator = false;
    struct Pos {
        value: String,
        candidate_for: Option<usize>,
    }
    struct Opt {
        name: String,
        index: usize,
        had_value: bool,
        value: Option<String>,
    }
    let mut positionals: Vec<Pos> = Vec::new();
    let mut options: Vec<Opt> = Vec::new();
    for token in tokenize(argv, spec) {
        match token {
            Token::Terminator => after_terminator = true,
            Token::Positional { index, value } => {
                let candidate = !after_terminator
                    && options.last().is_some_and(|prev| {
                        prev.index + 1 == index
                            && find(&prev.name).is_some_and(|s| s.optional_value)
                            && !prev.had_value
                    })
                    && (!value.starts_with('-') || value == STDIO);
                positionals.push(Pos {
                    value,
                    candidate_for: candidate.then(|| options.len() - 1),
                });
            }
            Token::Option {
                index,
                name,
                raw_name,
                value,
                inline,
            } => {
                let Some(s) = find(&name) else {
                    let display = if raw_name.starts_with('-') {
                        raw_name.clone()
                    } else {
                        format!("--{raw_name}")
                    };
                    let close = if raw_name.starts_with("--") || js::utf16_len(&raw_name) > 2 {
                        suggest(&name, &known)
                    } else {
                        None
                    };
                    return Err(usage_with(
                        format!("Unknown option {display}."),
                        match close {
                            Some(close) => format!("Did you mean --{close}? {HELP_HINT}"),
                            None => HELP_HINT.to_owned(),
                        },
                    ));
                };
                if s.kind == Kind::Boolean && value.is_some() {
                    return Err(usage(format!("Option {raw_name} does not take a value.")));
                }
                if s.kind == Kind::String && !s.optional_value {
                    let Some(v) = &value else {
                        return Err(usage(format!("Option {raw_name} needs a value.")));
                    };
                    if !inline && v.starts_with('-') && v != STDIO {
                        let path = if looks_like_path(&name) {
                            format!(" or {raw_name} ./{v}")
                        } else {
                            String::new()
                        };
                        return Err(usage_with(
                            format!("Option {raw_name} needs a value, got \"{v}\"."),
                            format!("If that is the value, write --{name}={v}{path}. {HELP_HINT}"),
                        ));
                    }
                }
                options.push(Opt {
                    name,
                    index,
                    had_value: value.is_some(),
                    value,
                });
            }
        }
    }
    // Optional values bind greedily; give them back (earliest first) while positionals are missing.
    let free = |p: &[Pos]| p.iter().filter(|p| p.candidate_for.is_none()).count();
    for i in 0..positionals.len() {
        if free(&positionals) >= positionals_needed {
            break;
        }
        positionals[i].candidate_for = None;
    }
    for p in &positionals {
        if let Some(owner) = p.candidate_for {
            options[owner].value = Some(p.value.clone());
        }
    }
    let mut values: IndexMap<String, Vec<Option<String>>> = IndexMap::default();
    for o in options {
        values.entry(o.name).or_default().push(o.value);
    }
    Ok(RawParse {
        values,
        positionals: positionals
            .into_iter()
            .filter(|p| p.candidate_for.is_none())
            .map(|p| p.value)
            .collect(),
    })
}

struct Values(RawParse);

impl Values {
    fn flag(&self, name: &str) -> bool {
        self.0.values.contains_key(name)
    }
    /// The last value of a string option.
    fn string(&self, name: &str) -> Option<String> {
        self.0.values.get(name)?.last()?.clone()
    }
    /// An optional-value option: `None` when absent, `-` (stdout) when given without a value.
    fn target(&self, name: &str) -> Option<String> {
        let list = self.0.values.get(name)?;
        Some(match list.last() {
            Some(Some(v)) if !v.is_empty() => v.clone(),
            _ => STDIO.to_owned(),
        })
    }
    fn strings(&self, name: &str) -> Vec<String> {
        self.0
            .values
            .get(name)
            .map_or_else(Vec::new, |list| list.iter().flatten().cloned().collect())
    }
}

fn choice(name: &str, value: &str, choices: &[&str]) -> CliResult<String> {
    if choices.contains(&value) {
        return Ok(value.to_owned());
    }
    let close =
        suggest(value, choices).map_or_else(String::new, |c| format!("Did you mean \"{c}\"? "));
    Err(usage_with(
        format!("Invalid value \"{value}\" for --{name}."),
        format!("{close}Expected one of: {}.", choices.join(", ")),
    ))
}

fn parse_common(v: &Values) -> CliResult<CommonOptions> {
    let locale = match v.string("locale") {
        None => None,
        Some(tag) => Some(match_locale(&tag).ok_or_else(|| {
            usage_with(
                format!("Unsupported locale \"{tag}\"."),
                "Expected en or zh-CN.",
            )
        })?),
    };
    let color = match v.string("color") {
        None => ColorMode::Auto,
        Some(c) => ColorMode::from_id(&choice("color", &c, &ColorMode::ALL)?).unwrap_or_default(),
    };
    Ok(CommonOptions {
        color,
        quiet: v.flag("quiet"),
        locale,
    })
}

fn parse_languages(v: &Values) -> CliResult<Option<Vec<String>>> {
    let Some(lang) = v.string("lang") else {
        return Ok(None);
    };
    let tags: Vec<String> = lang.split(',').map(|t| js::trim(t).to_owned()).collect();
    if tags
        .iter()
        .any(|t| !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
    {
        return Err(usage_with(
            format!("Invalid --lang \"{lang}\"."),
            "Use comma-separated language tags, e.g. zh,en.",
        ));
    }
    Ok(Some(tags))
}

fn parse_format(name: &str, value: Option<String>) -> CliResult<Option<Format>> {
    match value {
        None => Ok(None),
        Some(v) => {
            let id = choice(name, &v, &FORMATS)?;
            Ok(Some(FormatId::from_id(&id)))
        }
    }
}

/// `Number(value)` within `[min, max]`, an integer when `integer` (`parseNumber`).
fn parse_number(name: &str, value: &str, min: f64, max: f64, integer: bool) -> CliResult<f64> {
    let n = js::number_from_str(value);
    if js::trim(value).is_empty()
        || !n.is_finite()
        || n < min
        || n > max
        || (integer && n.fract() != 0.0)
    {
        let range = if integer {
            format!("an integer ≥ {}", js::number_to_string(min))
        } else {
            format!(
                "a number between {} and {}",
                js::number_to_string(min),
                js::number_to_string(max)
            )
        };
        return Err(usage_with(
            format!("Invalid value \"{value}\" for --{name}."),
            format!("Expected {range}."),
        ));
    }
    Ok(n)
}

fn command_prefix(names: [&str; 2]) -> &'static str {
    if names[0] == "graph" { "apply " } else { "" }
}

fn check_positionals(positionals: &[String], names: [&str; 2]) -> CliResult<(String, String)> {
    if positionals.len() < 2 {
        let missing: Vec<String> = names[positionals.len()..]
            .iter()
            .map(|n| format!("<{n}>"))
            .collect();
        return Err(usage_with(
            format!(
                "Missing {} {}.",
                missing.join(" and "),
                if missing.len() == 1 {
                    "argument"
                } else {
                    "arguments"
                }
            ),
            format!(
                "Usage: kgdiff {}<{}> <{}> [options]. {HELP_HINT}",
                command_prefix(names),
                names[0],
                names[1]
            ),
        ));
    }
    if positionals.len() > 2 {
        let extra: Vec<String> = positionals[2..]
            .iter()
            .map(|p| format!("\"{p}\""))
            .collect();
        return Err(usage_with(
            format!(
                "Unexpected {} {}.",
                if positionals.len() > 3 {
                    "arguments"
                } else {
                    "argument"
                },
                extra.join(", ")
            ),
            format!(
                "kgdiff {}takes exactly two files: <{}> <{}>. {HELP_HINT}",
                command_prefix(names),
                names[0],
                names[1]
            ),
        ));
    }
    let (a, b) = (positionals[0].clone(), positionals[1].clone());
    if a == STDIO && b == STDIO {
        return Err(usage_with(
            "Only one input can be read from stdin.",
            "Pass a file path for the other side.",
        ));
    }
    Ok((a, b))
}

/// `--panels`, read as the viewer reads `panels` (pairs separated by whitespace or commas; a
/// region named twice keeps its first place and takes the last state). The first pair it
/// rejects becomes a usage error that says what is wrong with it.
fn panels_option(values: &[String]) -> CliResult<Option<Vec<(String, String)>>> {
    let joined = values.join(" ");
    let mut panels: Vec<(String, String)> = Vec::new();
    for token in joined.split(|c: char| c == ',' || js::is_whitespace(c)) {
        if token.is_empty() {
            continue;
        }
        let parts: Vec<&str> = token.split(':').collect();
        let valid = parts.len() == 2
            && PANEL_REGIONS.contains(&parts[0])
            && PANEL_STATES.contains(&parts[1]);
        if !valid {
            return Err(panels_error(token, &parts));
        }
        match panels.iter_mut().find(|(r, _)| r == parts[0]) {
            Some(entry) => entry.1 = parts[1].to_owned(),
            None => panels.push((parts[0].to_owned(), parts[1].to_owned())),
        }
    }
    Ok((!panels.is_empty()).then_some(panels))
}

fn panels_error(token: &str, parts: &[&str]) -> Failure {
    let regions = format!(
        "Regions: {}; states: {}.",
        PANEL_REGIONS.join(", "),
        PANEL_STATES.join(", ")
    );
    if parts.len() != 2 {
        return usage_with(
            format!("Invalid value \"{token}\" for --panels."),
            format!(
                "Expected region:state pairs, e.g. --panels \"detail:collapsed minimap:hidden\". {regions}"
            ),
        );
    }
    let (region, state) = (parts[0], parts[1]);
    if !PANEL_REGIONS.contains(&region) {
        let close = suggest(region, &PANEL_REGIONS)
            .map_or_else(String::new, |c| format!("Did you mean \"{c}\"? "));
        return usage_with(
            format!("Unknown panel region \"{region}\" in --panels."),
            format!("{close}{regions}"),
        );
    }
    let close = suggest(state, &PANEL_STATES)
        .map_or_else(String::new, |c| format!("Did you mean \"{c}\"? "));
    usage_with(
        format!("Invalid state \"{state}\" for the {region} panel in --panels."),
        format!("{close}Expected one of: {}.", PANEL_STATES.join(", ")),
    )
}

/// The diff options as the TypeScript CLI hands them to `diff`: only what was given.
fn diff_options(v: &Values) -> CliResult<Value> {
    let mut o = Object::new();
    let mut matching = Object::new();
    if let Some(strategy) = v.string("match") {
        matching.insert("strategy", choice("match", &strategy, &MATCH_STRATEGIES)?);
    }
    if let Some(threshold) = v.string("threshold") {
        matching.insert(
            "threshold",
            parse_number("threshold", &threshold, 0.0, 1.0, false)?,
        );
    }
    let edge_identity = v.string("edge-identity");
    let hierarchy = v.strings("hierarchy");
    let ignore = v.strings("ignore-attr");
    if !matching.is_empty() {
        o.insert("match", matching);
    }
    if let Some(e) = edge_identity {
        o.insert(
            "edgeIdentity",
            choice("edge-identity", &e, &EDGE_IDENTITIES)?,
        );
    }
    let strings = |list: Vec<String>| Value::Array(list.into_iter().map(Value::from).collect());
    if !hierarchy.is_empty() {
        o.insert("hierarchyPredicates", strings(hierarchy));
    }
    if !ignore.is_empty() {
        o.insert("ignoreAttrs", strings(ignore));
    }
    if v.flag("no-merges") {
        o.insert("detectMerges", false);
    }
    if v.flag("no-splits") {
        o.insert("detectSplits", false);
    }
    Ok(Value::Object(o))
}

fn parse_diff(argv: &[String]) -> CliResult<Command> {
    let raw = raw_parse(argv, &diff_spec(), 2)?;
    let v = Values(raw);
    let common = parse_common(&v)?;
    if v.flag("help") {
        return Ok(Command::Help {
            topic: HelpTopic::Main,
            color: common.color,
        });
    }
    if v.flag("version") {
        return Ok(Command::Version);
    }
    let (before, after) = check_positionals(&v.0.positionals, ["before", "after"])?;
    let format = parse_format("format", v.string("format"))?.unwrap_or(None);
    let diff = diff_options(&v)?;
    let theme = v.string("theme");
    let mode = match v.string("mode") {
        None => None,
        Some(m) => Some(choice("mode", &m, &MODES)?),
    };
    let scope = match v.string("scope") {
        Some(s) => Some(choice("scope", &s, &SCOPES)?),
        None if mode.as_deref() == Some("changes") => Some("changes".to_owned()),
        None => None,
    };
    let panels = panels_option(&v.strings("panels"))?;
    let limit = v.string("limit");
    let languages = parse_languages(&v)?;
    let watch = v.strings("watch-attr");
    if watch.iter().any(|key| js::trim(key).is_empty()) {
        return Err(usage_with(
            "--watch-attr needs an attribute key.",
            "e.g. --watch-attr rdfs:comment. Attribute keys are listed in the JSON output (--json).",
        ));
    }
    let before_format = parse_format("before-format", v.string("before-format"))?.unwrap_or(format);
    let after_format = parse_format("after-format", v.string("after-format"))?.unwrap_or(format);
    let theme = match theme {
        None => None,
        Some(t) => Some(choice("theme", &t, &THEMES)?),
    };
    let limit = match limit {
        None => DEFAULT_LIMIT,
        Some(l) => kgdiff_core::util::f64_to_count(parse_number(
            "limit",
            &l,
            0.0,
            9_007_199_254_740_991.0,
            true,
        )?),
    };
    let options = DiffCommandOptions {
        common,
        before,
        after,
        before_format,
        after_format,
        languages,
        diff,
        stat: v.flag("stat"),
        name_status: v.flag("name-status"),
        json: v.target("json"),
        delta: v.target("delta"),
        markdown: v.target("markdown"),
        html: v.string("html"),
        open: v.flag("open"),
        pretty: v.flag("pretty"),
        title: v.string("title"),
        theme,
        mode: mode.map(|m| {
            if m == "changes" {
                "overlay".to_owned()
            } else {
                m
            }
        }),
        scope,
        panels,
        reproducible: v.flag("reproducible"),
        compute: !v.flag("no-compute"),
        allow_empty: v.flag("allow-empty"),
        exit_code: v.flag("exit-code"),
        limit,
        watch_attrs: (!watch.is_empty()).then_some(watch),
    };
    check_outputs(&options)?;
    Ok(Command::Diff(Box::new(options)))
}

/// At most one output may go to stdout (`--stat` and `--name-status` combine).
fn check_outputs(o: &DiffCommandOptions) -> CliResult<()> {
    let stdio = |t: &Option<String>| t.as_deref() == Some(STDIO);
    let mut to_stdout = Vec::new();
    if stdio(&o.json) {
        to_stdout.push("--json");
    }
    if stdio(&o.delta) {
        to_stdout.push("--delta");
    }
    if stdio(&o.markdown) {
        to_stdout.push("--markdown");
    }
    if o.stat || o.name_status {
        to_stdout.push(if o.stat { "--stat" } else { "--name-status" });
    }
    if to_stdout.len() > 1 {
        let (last, rest) = to_stdout.split_last().unwrap_or((&"", &[]));
        let first = to_stdout[0];
        return Err(usage_with(
            format!("{} and {last} would all write to stdout.", rest.join(", ")),
            format!(
                "Send all but one to a file, e.g. {first} out.{}.",
                if first == "--markdown" { "md" } else { "json" }
            ),
        ));
    }
    if o.html.as_deref() == Some(STDIO) {
        return Err(usage_with(
            "The HTML report must be written to a file.",
            "Use -o report.html.",
        ));
    }
    Ok(())
}

fn parse_apply(argv: &[String]) -> CliResult<Command> {
    let raw = raw_parse(argv, &apply_spec(), 2)?;
    let v = Values(raw);
    let common = parse_common(&v)?;
    if v.flag("help") {
        return Ok(Command::Help {
            topic: HelpTopic::Apply,
            color: common.color,
        });
    }
    if v.flag("version") {
        return Ok(Command::Version);
    }
    let (graph, delta) = check_positionals(&v.0.positionals, ["graph", "delta"])?;
    let languages = parse_languages(&v)?;
    Ok(Command::Apply(Box::new(ApplyCommandOptions {
        common,
        graph,
        delta,
        output: v.string("output").unwrap_or_else(|| STDIO.to_owned()),
        strict: !v.flag("no-strict"),
        format: parse_format("format", v.string("format"))?.unwrap_or(None),
        languages,
        pretty: v.flag("pretty"),
        allow_empty: v.flag("allow-empty"),
        verbose: v.flag("verbose"),
    })))
}

/// Parses `argv` (without the program name) into a command.
///
/// # Errors
///
/// A `usage` [`Failure`] with a message and a hint for any invalid command line.
pub fn parse_command_line(argv: &[String]) -> CliResult<Command> {
    match argv.first().map(String::as_str) {
        Some("apply") => parse_apply(&argv[1..]),
        Some("help") => {
            // `kgdiff help [apply] [--color <when>]`
            let raw = raw_parse(&argv[1..], &[string("color")], 0)?;
            let topic = raw.positionals.join(" ");
            if raw.positionals.len() > 1 || (!topic.is_empty() && topic != "apply") {
                return Err(usage_with(
                    format!("Unknown help topic \"{topic}\"."),
                    "Try `kgdiff help` or `kgdiff help apply`.",
                ));
            }
            let color = parse_common(&Values(raw))?.color;
            Ok(Command::Help {
                topic: if topic == "apply" {
                    HelpTopic::Apply
                } else {
                    HelpTopic::Main
                },
                color,
            })
        }
        _ => parse_diff(argv),
    }
}

/// The best guess at `--color` for an error about the command line itself (`peekColorMode`).
pub fn peek_color_mode(argv: &[String]) -> ColorMode {
    for (i, arg) in argv.iter().enumerate().rev() {
        let value = if let Some(v) = arg.strip_prefix("--color=") {
            Some(v)
        } else if arg == "--color" {
            argv.get(i + 1).map(String::as_str)
        } else {
            None
        };
        if let Some(mode) = value.and_then(ColorMode::from_id) {
            return mode;
        }
    }
    ColorMode::Auto
}
