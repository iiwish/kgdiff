//! The case definitions (`conformance/definitions.json`) and the CLI runs they imply.
//!
//! A definition names a case's input files (authored under `cases/<id>/`, or copied there from an
//! example dataset), how they are parsed, the diff options and the CLI runs beyond the standard
//! ones. Everything `case.json` records besides that is computed.

use std::fs;
use std::path::Path;

use kgdiff_core::js::{Object, Value, json};

/// The environment of every CLI run, unless a run overrides part of it.
pub const COLUMNS: &str = "100";

/// The two sides of a case.
#[derive(Clone, Debug)]
pub struct Sides<T> {
    pub before: T,
    pub after: T,
}

impl<T> Sides<T> {
    pub fn get(&self, side: Side) -> &T {
        match side {
            Side::Before => &self.before,
            Side::After => &self.after,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Side {
    Before,
    After,
}

impl Side {
    pub const BOTH: [Side; 2] = [Side::Before, Side::After];

    pub fn name(self) -> &'static str {
        match self {
            Side::Before => "before",
            Side::After => "after",
        }
    }
}

/// An extra run of the case's diff arguments with more flags (`extraRuns`).
#[derive(Debug)]
pub struct ExtraRun {
    pub name: String,
    pub flags: Vec<String>,
    pub env: Object,
    /// File name under `expected/cli/`.
    pub file: String,
}

/// A run with arguments of its own (`customRuns`), whose exit code is part of the expectation.
#[derive(Debug)]
pub struct CustomRun {
    pub name: String,
    pub args: Vec<String>,
    pub env: Object,
    pub stdin: Option<String>,
    pub exit: i32,
    /// File name under `expected/cli/`; `None` when stdout must be empty.
    pub file: Option<String>,
}

/// One case of `definitions.json`.
#[derive(Debug)]
pub struct Definition {
    pub id: String,
    pub description: String,
    pub covers: Vec<String>,
    pub inputs: Sides<String>,
    /// Repository paths the inputs are copied from (the example datasets).
    pub copied_from: Option<Sides<String>>,
    /// `--before-format` / `--after-format`; `None` is `auto`.
    pub formats: Sides<Option<String>>,
    pub languages: Option<Vec<String>>,
    pub allow_empty: bool,
    /// The `DiffOptions` as given, an object.
    pub options: Value,
    /// CLI flags that shape only the text outputs (`--watch-attr`, `--limit`).
    pub text_flags: Vec<String>,
    pub locale: String,
    /// The `LayoutOptions` of `layout-contract.json`, an object.
    pub layout: Value,
    pub extra_runs: Vec<ExtraRun>,
    pub custom_runs: Vec<CustomRun>,
    /// Further authored files the custom runs read.
    pub extra_inputs: Option<Vec<String>>,
}

/// A CLI run as the generator records it.
#[derive(Debug)]
pub struct RunSpec {
    pub name: String,
    pub args: Vec<String>,
    pub env: Object,
    /// Path relative to the case directory; `None` when stdout must be empty.
    pub file: Option<String>,
    /// A file of the case directory piped to stdin.
    pub stdin: Option<String>,
    /// The expected exit code; `None` for the standard runs (0, or 1 for `exit-code`).
    pub exit: Option<i32>,
}

fn base_env() -> Object {
    let mut env = Object::new();
    env.insert("COLUMNS", COLUMNS);
    env
}

/// The base environment with `overrides` applied (JavaScript's `{ ...BASE_ENV, ...overrides }`).
fn env_with(overrides: &Object) -> Object {
    let mut env = base_env();
    for (key, value) in overrides.iter() {
        env.insert(key.clone(), value.clone());
    }
    env
}

/// Reads one field of a definition, which only has the fields it is allowed to have.
struct Fields<'a> {
    what: String,
    object: &'a Object,
}

impl<'a> Fields<'a> {
    fn new(what: String, value: &'a Value, allowed: &[&str]) -> Result<Fields<'a>, String> {
        let object = value
            .as_object()
            .ok_or_else(|| format!("{what} is not an object"))?;
        if let Some(key) = object.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(format!("{what} has an unknown field \"{key}\""));
        }
        Ok(Fields { what, object })
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        self.object.get(key)
    }

    fn string(&self, key: &str) -> Result<String, String> {
        self.optional_string(key)?
            .ok_or_else(|| format!("{} has no {key}", self.what))
    }

    fn optional_string(&self, key: &str) -> Result<Option<String>, String> {
        match self.get(key) {
            None => Ok(None),
            Some(value) => value
                .as_str()
                .map(|s| Some(s.to_owned()))
                .ok_or_else(|| format!("{}: {key} is not a string", self.what)),
        }
    }

    fn strings(&self, key: &str) -> Result<Option<Vec<String>>, String> {
        let Some(value) = self.get(key) else {
            return Ok(None);
        };
        let list = value
            .as_array()
            .ok_or_else(|| format!("{}: {key} is not an array", self.what))?;
        list.iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{}: {key} holds a non-string", self.what))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some)
    }

    fn object(&self, key: &str) -> Result<Object, String> {
        match self.get(key) {
            None => Ok(Object::new()),
            Some(Value::Object(object)) => Ok(object.clone()),
            Some(_) => Err(format!("{}: {key} is not an object", self.what)),
        }
    }

    fn sides(&self, key: &str) -> Result<Option<Sides<Option<String>>>, String> {
        let Some(value) = self.get(key) else {
            return Ok(None);
        };
        let fields = Fields::new(format!("{}: {key}", self.what), value, &["before", "after"])?;
        Ok(Some(Sides {
            before: fields.optional_string("before")?,
            after: fields.optional_string("after")?,
        }))
    }
}

const FIELDS: &[&str] = &[
    "id",
    "dataset",
    "description",
    "covers",
    "inputs",
    "formats",
    "languages",
    "allowEmpty",
    "options",
    "textFlags",
    "locale",
    "layout",
    "extraRuns",
    "customRuns",
    "extraInputs",
];

/// Reads `conformance/definitions.json`. A case with `dataset` copies its inputs from
/// `examples/datasets/<dataset>/` and is diffed with the options of that dataset's `meta.json`.
pub fn load(repo: &Path) -> Result<Vec<Definition>, String> {
    let path = repo.join("conformance/definitions.json");
    let document = read_json(&path)?;
    let cases = document
        .get("cases")
        .and_then(Value::as_array)
        .ok_or("definitions.json has no cases")?;
    let mut out: Vec<Definition> = Vec::new();
    for value in cases {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or("a definition without an id")?;
        let definition = definition(repo, value, format!("definition {id}"))?;
        if out.iter().any(|d| d.id == definition.id) {
            return Err(format!("two definitions of {id}"));
        }
        out.push(definition);
    }
    Ok(out)
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    json::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn definition(repo: &Path, value: &Value, what: String) -> Result<Definition, String> {
    let f = Fields::new(what.clone(), value, FIELDS)?;
    let inputs = f
        .sides("inputs")?
        .and_then(|s| {
            Some(Sides {
                before: s.before?,
                after: s.after?,
            })
        })
        .ok_or_else(|| format!("{what} has no inputs"))?;
    let (copied_from, dataset_options) = match f.optional_string("dataset")? {
        None => (None, None),
        Some(name) => {
            let dir = format!("examples/datasets/{name}");
            let meta = read_json(&repo.join(&dir).join("meta.json"))?;
            let files = meta.get("files");
            let file = |side: &str| files.and_then(|f| f.get(side)).and_then(Value::as_str);
            if file("before") != Some(inputs.before.as_str())
                || file("after") != Some(inputs.after.as_str())
            {
                return Err(format!("{dir}/meta.json names other files than {what}"));
            }
            let options = meta
                .get("options")
                .cloned()
                .unwrap_or_else(|| Value::Object(Object::new()));
            let copied = Sides {
                before: format!("{dir}/{}", inputs.before),
                after: format!("{dir}/{}", inputs.after),
            };
            (Some(copied), Some(options))
        }
    };
    let options = match (dataset_options, f.get("options")) {
        (Some(_), Some(_)) => {
            return Err(format!(
                "{what}: a dataset case takes the options of its meta.json"
            ));
        }
        (Some(options), None) => options,
        (None, Some(options @ Value::Object(_))) => options.clone(),
        (None, Some(_)) => return Err(format!("{what}: options is not an object")),
        (None, None) => return Err(format!("{what} has no options")),
    };
    let mut extra_runs = Vec::new();
    for run in f.get("extraRuns").and_then(Value::as_array).unwrap_or(&[]) {
        let r = Fields::new(
            format!("{what}: an extra run"),
            run,
            &["name", "flags", "env", "file"],
        )?;
        extra_runs.push(ExtraRun {
            name: r.string("name")?,
            flags: r.strings("flags")?.unwrap_or_default(),
            env: r.object("env")?,
            file: r.string("file")?,
        });
    }
    let mut custom_runs = Vec::new();
    for run in f.get("customRuns").and_then(Value::as_array).unwrap_or(&[]) {
        let r = Fields::new(
            format!("{what}: a custom run"),
            run,
            &["name", "args", "env", "stdin", "exit", "file"],
        )?;
        let exit = match r.get("exit").and_then(Value::as_f64) {
            Some(0.0) => 0,
            Some(1.0) => 1,
            Some(2.0) => 2,
            _ => return Err(format!("{what}: a custom run's exit is not 0, 1 or 2")),
        };
        custom_runs.push(CustomRun {
            name: r.string("name")?,
            args: r.strings("args")?.unwrap_or_default(),
            env: r.object("env")?,
            stdin: r.optional_string("stdin")?,
            exit,
            file: r.optional_string("file")?,
        });
    }
    let layout = match f.get("layout") {
        None => Value::Object(Object::new()),
        Some(layout @ Value::Object(_)) => layout.clone(),
        Some(_) => return Err(format!("{what}: layout is not an object")),
    };
    let allow_empty = match f.get("allowEmpty") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(format!("{what}: allowEmpty is not a boolean")),
    };
    Ok(Definition {
        id: f.string("id")?,
        description: f.string("description")?,
        covers: f.strings("covers")?.unwrap_or_default(),
        inputs,
        copied_from,
        formats: f.sides("formats")?.unwrap_or(Sides {
            before: None,
            after: None,
        }),
        languages: f.strings("languages")?,
        allow_empty,
        options,
        text_flags: f.strings("textFlags")?.unwrap_or_default(),
        locale: f.string("locale")?,
        layout,
        extra_runs,
        custom_runs,
        extra_inputs: f.strings("extraInputs")?,
    })
}

impl Definition {
    /// CLI flags equivalent to the diff options; anything the CLI cannot express is refused.
    fn option_flags(&self) -> Result<Vec<String>, String> {
        const KNOWN: &[&str] = &[
            "match",
            "hierarchyPredicates",
            "edgeIdentity",
            "ignoreAttrs",
            "detectMerges",
            "detectSplits",
        ];
        let o = &self.options;
        let options = o.as_object().ok_or("options is not an object")?;
        if let Some(key) = options.keys().find(|k| !KNOWN.contains(&k.as_str())) {
            return Err(format!("the CLI cannot express the diff option \"{key}\""));
        }
        let matching = o.get("match");
        if let Some(key) = matching.and_then(Value::as_object).and_then(|m| {
            m.keys()
                .find(|k| !["strategy", "threshold"].contains(&k.as_str()))
        }) {
            return Err(format!("the CLI cannot express the match option \"{key}\""));
        }
        let mut flags = Vec::new();
        let mut push = |flag: &str, value: String| {
            flags.push(flag.to_owned());
            flags.push(value);
        };
        if let Some(strategy) = matching
            .and_then(|m| m.get("strategy"))
            .and_then(Value::as_str)
            && !strategy.is_empty()
        {
            push("--match", strategy.to_owned());
        }
        if let Some(threshold) = matching.and_then(|m| m.get("threshold")) {
            push("--threshold", threshold.to_js_string());
        }
        for p in o
            .get("hierarchyPredicates")
            .and_then(Value::as_array)
            .unwrap_or(&[])
        {
            push("--hierarchy", p.to_js_string());
        }
        if let Some(identity) = o.get("edgeIdentity").and_then(Value::as_str)
            && !identity.is_empty()
        {
            push("--edge-identity", identity.to_owned());
        }
        for k in o
            .get("ignoreAttrs")
            .and_then(Value::as_array)
            .unwrap_or(&[])
        {
            push("--ignore-attr", k.to_js_string());
        }
        if o.get("detectMerges") == Some(&Value::Bool(false)) {
            flags.push("--no-merges".to_owned());
        }
        if o.get("detectSplits") == Some(&Value::Bool(false)) {
            flags.push("--no-splits".to_owned());
        }
        Ok(flags)
    }

    fn input_flags(&self) -> Vec<String> {
        let mut flags = Vec::new();
        match (&self.formats.before, &self.formats.after) {
            (Some(b), Some(a)) if b == a => flags.extend(["--format".to_owned(), b.clone()]),
            (b, a) => {
                if let Some(b) = b {
                    flags.extend(["--before-format".to_owned(), b.clone()]);
                }
                if let Some(a) = a {
                    flags.extend(["--after-format".to_owned(), a.clone()]);
                }
            }
        }
        self.reading_flags(&mut flags);
        flags
    }

    /// `--lang` and `--allow-empty`, shared by the diff and the apply runs.
    fn reading_flags(&self, flags: &mut Vec<String>) {
        if let Some(languages) = &self.languages {
            flags.extend(["--lang".to_owned(), languages.join(",")]);
        }
        if self.allow_empty {
            flags.push("--allow-empty".to_owned());
        }
    }

    /// Arguments of the apply run: the before graph, read as it was for the diff.
    fn apply_flags(&self) -> Vec<String> {
        let mut flags = Vec::new();
        if let Some(b) = &self.formats.before {
            flags.extend(["--format".to_owned(), b.clone()]);
        }
        self.reading_flags(&mut flags);
        flags
    }

    /// Arguments of the diff runs: inputs, how they are read, diff options, text and locale.
    pub fn diff_args(&self) -> Result<Vec<String>, String> {
        let mut args = vec![self.inputs.before.clone(), self.inputs.after.clone()];
        args.extend(self.input_flags());
        args.extend(self.option_flags()?);
        args.extend(self.text_flags.iter().cloned());
        args.extend([
            "--locale".to_owned(),
            self.locale.clone(),
            "--color".to_owned(),
            "never".to_owned(),
        ]);
        Ok(args)
    }

    /// Every run of the case: the standard ones, the extra ones, `apply`, the custom ones.
    pub fn runs(&self) -> Result<Vec<RunSpec>, String> {
        let base = self.diff_args()?;
        let standard = |name: &str, flags: &[&str], file: Option<&str>| RunSpec {
            name: name.to_owned(),
            args: base
                .iter()
                .cloned()
                .chain(flags.iter().map(|f| (*f).to_owned()))
                .collect(),
            env: base_env(),
            file: file.map(str::to_owned),
            stdin: None,
            exit: None,
        };
        let mut runs = vec![
            standard("summary", &[], Some("expected/cli/summary.txt")),
            standard("stat", &["--stat"], Some("expected/cli/stat.txt")),
            standard(
                "name-status",
                &["--name-status"],
                Some("expected/cli/name-status.tsv"),
            ),
            standard("markdown", &["--markdown"], Some("expected/cli/summary.md")),
            standard("json", &["--json"], Some("expected/diff.json")),
            standard("delta", &["--delta"], Some("expected/delta.json")),
            standard("exit-code", &["--exit-code", "--quiet"], None),
        ];
        for extra in &self.extra_runs {
            runs.push(RunSpec {
                name: extra.name.clone(),
                args: base.iter().chain(&extra.flags).cloned().collect(),
                env: env_with(&extra.env),
                file: Some(format!("expected/cli/{}", extra.file)),
                stdin: None,
                exit: None,
            });
        }
        let mut apply = vec![
            "apply".to_owned(),
            self.inputs.before.clone(),
            "expected/delta.json".to_owned(),
        ];
        apply.extend(self.apply_flags());
        apply.extend(["--color".to_owned(), "never".to_owned()]);
        runs.push(RunSpec {
            name: "apply".to_owned(),
            args: apply,
            env: base_env(),
            file: Some("expected/apply.json".to_owned()),
            stdin: None,
            exit: None,
        });
        for custom in &self.custom_runs {
            runs.push(RunSpec {
                name: custom.name.clone(),
                args: custom.args.clone(),
                env: env_with(&custom.env),
                file: custom.file.as_ref().map(|f| format!("expected/cli/{f}")),
                stdin: custom.stdin.clone(),
                exit: Some(custom.exit),
            });
        }
        Ok(runs)
    }

    /// The authored inputs, relative to the case directory (none for a dataset case).
    pub fn authored_inputs(&self) -> Vec<String> {
        if self.copied_from.is_some() {
            return Vec::new();
        }
        let mut out = vec![self.inputs.before.clone(), self.inputs.after.clone()];
        out.extend(self.extra_inputs.iter().flatten().cloned());
        out
    }

    /// `parse` of `case.json` for one side: format, file name, languages, `allowEmpty`.
    pub fn parse_record(&self, side: Side) -> Value {
        let mut out = Object::new();
        out.insert(
            "format",
            self.formats.get(side).as_deref().unwrap_or("auto"),
        );
        out.insert("filename", input_filename(self.inputs.get(side)));
        if let Some(languages) = &self.languages {
            out.insert("languages", strings(languages));
        }
        out.insert("allowEmpty", self.allow_empty);
        Value::Object(out)
    }
}

/// The file name the parser is given: without directories and without `.gz`.
pub fn input_filename(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".gz") {
        name[..name.len() - 3].to_owned()
    } else {
        name.to_owned()
    }
}

pub fn strings(list: &[String]) -> Value {
    Value::Array(list.iter().map(|s| Value::from(s.as_str())).collect())
}

pub fn sides_value(sides: &Sides<String>) -> Value {
    let mut out = Object::new();
    out.insert("before", sides.before.as_str());
    out.insert("after", sides.after.as_str());
    Value::Object(out)
}
