//! `cargo xtask conformance`: generates the conformance corpus (`conformance/README.md`).
//!
//! For every case of `conformance/definitions.json`: `case.json` and every file below
//! `expected/` — the library outputs from kgdiff-formats, kgdiff-core and kgdiff-layout, and what
//! the CLI produces (the CLI runs and `report.json`) from the Rust `kgdiff`, run as a real process
//! in a copy of the case directory, exactly as `pnpm conformance:replay` runs it. Then the
//! generated primitive vectors and the manifest. Where two of them write the same thing
//! (`--json`, `--delta`, the report's packed diff and layout, `apply`), it checks that they agree.
//!
//! ```sh
//! pnpm build:viewer-assets            # once, and after the viewer changed: kgdiff embeds them
//! cargo xtask conformance             # builds the release kgdiff, regenerates the corpus
//! cargo xtask conformance --check     # the same, comparing with the files instead of writing
//! cargo xtask conformance --bin <kgdiff>
//! ```
//!
//! Writing removes generated files no longer generated (below a case's `expected/`, and
//! unlisted files of `primitives/`), never touches authored inputs or the fixed primitive
//! vectors, and reports a directory under `cases/` that no case defines.

mod cli;
mod definitions;
mod library;
mod primitives;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{NormalizeOptions, hash_graph, normalize};

use cli::{Recorder, VERSION_PLACEHOLDER};
use definitions::{Definition, Side, sides_value, strings};
use primitives::{Kind, VECTORS};

/// Corpus files by path relative to `conformance/`, `/`-separated.
type Corpus = BTreeMap<String, Vec<u8>>;

/// Files operating systems drop into directories (Finder, Explorer): never part of the corpus.
const OS_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// What kgdiff writes: compact JSON and a newline.
pub fn compact(value: &Value) -> String {
    let mut text = json::to_string(value);
    text.push('\n');
    text
}

/// Value files of the corpus: two-space indentation and a newline.
pub fn pretty(value: &Value) -> String {
    let mut text = json::to_string_pretty(value);
    text.push('\n');
    text
}

struct Args {
    bin: Option<PathBuf>,
    check: bool,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut out = Args {
        bin: None,
        check: false,
    };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--check" => out.check = true,
            "--bin" => {
                let path = args
                    .next()
                    .filter(|p| !p.starts_with('-'))
                    .ok_or("--bin needs the path of an executable")?;
                out.bin = Some(std::path::absolute(path).map_err(|e| e.to_string())?);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(out)
}

pub fn main(args: &[String]) -> ExitCode {
    match run(args) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("conformance: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    let args = parse_args(args)?;
    let repo = repo();
    let root = repo.join("conformance");
    let bin = match args.bin {
        Some(bin) => bin,
        None => build_kgdiff(&repo)?,
    };
    let recorder = Recorder::new(bin, &root)?;
    let definitions = definitions::load(&repo)?;
    let mut corpus = Corpus::new();
    for def in &definitions {
        let files =
            generate_case(&repo, def, &recorder).map_err(|e| format!("case {}: {e}", def.id))?;
        corpus.extend(files);
    }
    corpus.extend(shared(&definitions));
    if args.check {
        check(&root, &definitions, &corpus)
    } else {
        write(&root, &definitions, &corpus)?;
        Ok(ExitCode::SUCCESS)
    }
}

/// The repository: the parent of this crate.
fn repo() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap_or(manifest).to_path_buf()
}

/// The release `kgdiff`, built now (with the viewer bundles its reports embed).
fn build_kgdiff(repo: &Path) -> Result<PathBuf, String> {
    if !repo
        .join("crates/kgdiff-report/assets/kgdiff-viewer.js")
        .is_file()
    {
        return Err(
            "the viewer bundles kgdiff embeds are missing; run `pnpm build:viewer-assets` first"
                .to_owned(),
        );
    }
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .args(["build", "--release", "-p", "kgdiff", "--locked"])
        .current_dir(repo)
        .status()
        .map_err(|e| format!("cargo: {e}"))?;
    if !status.success() {
        return Err("`cargo build --release -p kgdiff` failed".to_owned());
    }
    let target =
        std::env::var_os("CARGO_TARGET_DIR").map_or_else(|| repo.join("target"), PathBuf::from);
    Ok(target
        .join("release")
        .join(format!("kgdiff{}", std::env::consts::EXE_SUFFIX)))
}

/// A directory below the system's temporary directory, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Result<Scratch, String> {
        let path = std::env::temp_dir().join(format!("kgdiff-{name}-{}", std::process::id()));
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Scratch(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_file(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(path, data).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The files of one case, keyed by path relative to `conformance/`.
fn generate_case(repo: &Path, def: &Definition, recorder: &Recorder) -> Result<Corpus, String> {
    let dir = repo.join("conformance/cases").join(&def.id);
    let prefix = format!("cases/{}/", def.id);
    let mut files = Corpus::new();
    // The runs read a copy of the case directory holding every file generated so far (apply
    // reads the delta), so that nothing is written to the corpus before everything is generated.
    let work = Scratch::new(&format!("corpus-{}", def.id))?;
    let mut put = |path: &str, data: Vec<u8>| -> Result<(), String> {
        write_file(&work.0.join(path), &data)?;
        files.insert(format!("{prefix}{path}"), data);
        Ok(())
    };
    for input in def.authored_inputs() {
        write_file(&work.0.join(&input), &read_file(&dir.join(&input))?)?;
    }
    let mut inputs = Vec::new();
    for side in Side::BOTH {
        let name = def.inputs.get(side);
        let bytes = match &def.copied_from {
            Some(copied) => {
                let bytes = read_file(&repo.join(copied.get(side)))?;
                put(name, bytes.clone())?;
                bytes
            }
            None => read_file(&dir.join(name))?,
        };
        inputs.push(bytes);
    }

    // Library outputs.
    let lib = library::compute(def, [&inputs[0], &inputs[1]])?;
    for (path, text) in &lib.files {
        put(path, text.clone().into_bytes())?;
    }

    // The report: what its payload says besides the diff and the layout, both checked.
    let out = Scratch::new(&format!("report-{}", def.id))?;
    let report = out.0.join("report.html");
    let mut args = def.diff_args()?;
    args.extend([
        "-o".to_owned(),
        report.to_string_lossy().into_owned(),
        "--reproducible".to_owned(),
    ]);
    let run = recorder.capture("report", &args, &work.0, &base_env(), None)?;
    if run.code != 0 {
        return Err(format!(
            "the report run exited with {}:\n{}",
            run.code, run.stderr
        ));
    }
    let html = String::from_utf8(read_file(&report)?).map_err(|e| e.to_string())?;
    let layout = library::report_layout(&lib.result)?;
    let record = cli::report_record(&html, recorder, &lib.packed_text, &layout)?;
    put("expected/report.json", pretty(&record).into_bytes())?;

    // The CLI runs.
    let mut records = Vec::new();
    for spec in def.runs()? {
        let markdown = spec.file.as_deref().is_some_and(|f| f.ends_with(".md"));
        let stdin = match &spec.stdin {
            Some(file) => Some(read_file(&work.0.join(file))?),
            None => None,
        };
        let mut captured = recorder.capture(&spec.name, &spec.args, &work.0, &spec.env, stdin)?;
        if markdown {
            captured.stdout = captured
                .stdout
                .replace(recorder.version.as_str(), VERSION_PLACEHOLDER);
        }
        let expected =
            spec.exit
                .unwrap_or(if spec.name == "exit-code" && !lib.result.stats.identical {
                    1
                } else {
                    0
                });
        if captured.code != expected {
            return Err(format!(
                "run \"{}\" exited with {}, expected {expected}:\n{}",
                spec.name, captured.code, captured.stderr
            ));
        }
        let mut record = Object::new();
        record.insert("name", spec.name.as_str());
        record.insert("args", strings(&spec.args));
        record.insert("env", spec.env.clone());
        if let Some(file) = &spec.stdin {
            let mut stdin = Object::new();
            stdin.insert("file", file.as_str());
            record.insert("stdin", stdin);
        }
        let mut stdout = Object::new();
        match &spec.file {
            None => {
                if !captured.stdout.is_empty() {
                    return Err(format!("run \"{}\" printed to stdout", spec.name));
                }
                stdout.insert("text", "");
            }
            Some(file) => {
                if file == "expected/diff.json" && captured.stdout != lib.diff_text {
                    return Err("kgdiff --json differs from diff_to_json(diff(…))".to_owned());
                }
                if file == "expected/delta.json" && captured.stdout != lib.delta_text {
                    return Err("kgdiff --delta differs from diff(…).delta".to_owned());
                }
                put(file, captured.stdout.into_bytes())?;
                stdout.insert("file", file.as_str());
            }
        }
        record.insert("stdout", stdout);
        if markdown {
            record.insert("versionPlaceholder", true);
        }
        let mut stderr = Object::new();
        stderr.insert("text", captured.stderr);
        record.insert("stderr", stderr);
        record.insert("exit", captured.code);
        records.push(Value::Object(record));
    }

    // `kgdiff apply` must reproduce the after graph.
    let applied = files
        .get(&format!("{prefix}expected/apply.json"))
        .ok_or("no apply.json")?;
    let applied = json::parse(std::str::from_utf8(applied).map_err(|e| e.to_string())?)
        .map_err(|e| format!("apply.json: {e}"))?;
    let options = {
        let mut o = NormalizeOptions::default();
        o.edge_identity = lib.options.edge_identity;
        o
    };
    let graph = normalize(&applied, options).map_err(|e| format!("apply.json: {}", e.message))?;
    if hash_graph(&graph) != lib.hashes[1] {
        return Err("kgdiff apply does not reproduce the after graph".to_owned());
    }

    let mut record = Object::new();
    record.insert("id", def.id.as_str());
    record.insert("description", def.description.as_str());
    record.insert("covers", strings(&def.covers));
    record.insert("inputs", sides_value(&def.inputs));
    if let Some(extra) = &def.extra_inputs {
        record.insert("extraInputs", strings(extra));
    }
    if let Some(copied) = &def.copied_from {
        record.insert("copiedFrom", sides_value(copied));
    }
    let mut parse = Object::new();
    for side in Side::BOTH {
        parse.insert(side.name(), def.parse_record(side));
    }
    record.insert("parse", parse);
    record.insert("options", def.options.clone());
    record.insert("resolvedOptions", lib.options.to_value());
    record.insert("locale", def.locale.as_str());
    record.insert("layoutOptions", def.layout.clone());
    record.insert("identical", lib.result.stats.identical);
    record.insert("cli", Value::Array(records));
    files.insert(
        format!("{prefix}case.json"),
        pretty(&Value::Object(record)).into_bytes(),
    );
    Ok(files)
}

fn base_env() -> Object {
    let mut env = Object::new();
    env.insert("COLUMNS", definitions::COLUMNS);
    env
}

/// The generated primitive vectors and the manifest.
fn shared(definitions: &[Definition]) -> Corpus {
    let mut corpus = Corpus::new();
    for (name, text) in primitives::generate() {
        corpus.insert(format!("primitives/{name}"), text.into_bytes());
    }
    let mut manifest = Object::new();
    manifest.insert("format", "kgdiff.conformance");
    manifest.insert("version", 1);
    manifest.insert(
        "description",
        "Language-neutral conformance corpus of kgdiff: inputs, options and the expected outputs of the reference (Rust) implementation. See README.md.",
    );
    manifest.insert("versionPlaceholder", VERSION_PLACEHOLDER);
    let cases = definitions
        .iter()
        .map(|def| {
            let mut case = Object::new();
            case.insert("id", def.id.as_str());
            case.insert("covers", strings(&def.covers));
            Value::Object(case)
        })
        .collect();
    manifest.insert("cases", Value::Array(cases));
    manifest.insert(
        "primitives",
        Value::Array(
            VECTORS
                .iter()
                .map(|(name, _)| Value::from(format!("primitives/{name}")))
                .collect(),
        ),
    );
    corpus.insert(
        "manifest.json".to_owned(),
        pretty(&Value::Object(manifest)).into_bytes(),
    );
    corpus
}

/// Every file below `dir`, relative to `root`, `/`-separated, without the operating system's.
fn files_below(root: &Path, relative: &str, out: &mut Vec<String>) -> Result<(), String> {
    let dir = root.join(relative);
    if !dir.is_dir() {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if OS_FILES.contains(&name.as_str()) {
            continue;
        }
        let path = format!("{relative}/{name}");
        if entry.path().is_dir() {
            files_below(root, &path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// Directories of `cases/` that no case defines.
fn unknown_cases(root: &Path, definitions: &[Definition]) -> Result<Vec<String>, String> {
    let ids: BTreeSet<&str> = definitions.iter().map(|d| d.id.as_str()).collect();
    let dir = root.join("cases");
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let name = entry.map_err(|e| e.to_string())?.file_name();
        let name = name.to_string_lossy();
        if !ids.contains(name.as_ref()) && !OS_FILES.contains(&name.as_ref()) {
            out.push(format!("cases/{name}"));
        }
    }
    out.sort();
    Ok(out)
}

/// Fixed primitive vectors must be there: the generator never writes them.
fn fixed_vectors(root: &Path) -> Result<(), String> {
    for (name, kind) in VECTORS {
        if *kind == Kind::Fixed && !root.join("primitives").join(name).is_file() {
            return Err(format!(
                "primitives/{name} is missing: it is fixed reference data, restore it from git"
            ));
        }
    }
    Ok(())
}

/// Whether a file on disk is one the generator owns: below a case's `expected/`, or in
/// `primitives/`.
fn generated(path: &str, definitions: &[Definition]) -> bool {
    let mut parts = path.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("primitives"), Some(_), None) => true,
        (Some("cases"), Some(id), Some("expected")) => definitions.iter().any(|d| d.id == id),
        _ => false,
    }
}

/// Files the generator keeps: what it writes, the authored inputs and the fixed vectors.
fn kept(definitions: &[Definition], corpus: &Corpus) -> BTreeSet<String> {
    let mut keep: BTreeSet<String> = corpus.keys().cloned().collect();
    for def in definitions {
        for input in def.authored_inputs() {
            keep.insert(format!("cases/{}/{input}", def.id));
        }
    }
    for (name, kind) in VECTORS {
        if *kind == Kind::Fixed {
            keep.insert(format!("primitives/{name}"));
        }
    }
    keep
}

fn write(root: &Path, definitions: &[Definition], corpus: &Corpus) -> Result<(), String> {
    fixed_vectors(root)?;
    let keep = kept(definitions, corpus);
    let mut on_disk = Vec::new();
    files_below(root, "cases", &mut on_disk)?;
    files_below(root, "primitives", &mut on_disk)?;
    let mut removed = 0;
    for path in on_disk {
        if !keep.contains(&path) && generated(&path, definitions) {
            fs::remove_file(root.join(&path)).map_err(|e| format!("{path}: {e}"))?;
            removed += 1;
        }
    }
    for (path, data) in corpus {
        write_file(&root.join(path), data)?;
    }
    for def in definitions {
        prune_empty(&root.join("cases").join(&def.id).join("expected"))?;
    }
    let stale = if removed > 0 {
        format!(", removed {removed} stale ones")
    } else {
        String::new()
    };
    println!("conformance: wrote {} files{stale}.", corpus.len());
    let unknown = unknown_cases(root, definitions)?;
    if !unknown.is_empty() {
        eprintln!(
            "conformance: no case defines {}; remove what is no longer needed by hand.",
            unknown.join(", ")
        );
    }
    Ok(())
}

/// Removes empty directories below `dir`, deepest first.
fn prune_empty(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            prune_empty(&path)?;
        }
    }
    if fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        fs::remove_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

/// `--check`: every generated file is on disk with the same bytes, and nothing else is.
fn check(root: &Path, definitions: &[Definition], corpus: &Corpus) -> Result<ExitCode, String> {
    let mut problems = Vec::new();
    if let Err(message) = fixed_vectors(root) {
        problems.push(message);
    }
    for (path, data) in corpus {
        match fs::read(root.join(path)) {
            Ok(disk) if &disk == data => {}
            Ok(_) => problems.push(format!("{path} differs")),
            Err(_) => problems.push(format!("{path} is missing")),
        }
    }
    let keep = kept(definitions, corpus);
    let mut on_disk = Vec::new();
    files_below(root, "cases", &mut on_disk)?;
    files_below(root, "primitives", &mut on_disk)?;
    for path in on_disk {
        if !keep.contains(&path) {
            problems.push(format!("{path} is not part of the corpus"));
        }
    }
    for path in unknown_cases(root, definitions)? {
        problems.push(format!("{path}: no case defines it"));
    }
    if problems.is_empty() {
        println!(
            "conformance: the {} generated files are up to date.",
            corpus.len()
        );
        Ok(ExitCode::SUCCESS)
    } else {
        for problem in &problems {
            eprintln!("  {problem}");
        }
        eprintln!(
            "conformance: {} problems; run `cargo xtask conformance` if the change is intended, and review the diff.",
            problems.len()
        );
        Ok(ExitCode::FAILURE)
    }
}
