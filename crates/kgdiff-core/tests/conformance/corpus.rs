//! Reading the corpus (`conformance/README.md`) and comparing outputs with its expected files.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The `format` and the highest `version` of `manifest.json` this harness reads.
const FORMAT: &str = "kgdiff.conformance";
const VERSION: u64 = 1;

/// The corpus in the repository, next to the workspace.
pub struct Corpus {
    pub root: PathBuf,
    pub cases: Vec<Case>,
    /// Paths of the primitive vector files, relative to `root`, as the manifest lists them.
    pub primitives: Vec<String>,
}

/// One directory of `conformance/cases/`.
pub struct Case {
    pub id: String,
    pub dir: PathBuf,
    /// `case.json`.
    #[expect(
        dead_code,
        reason = "read by the checks that need a case's options (diff, delta)"
    )]
    pub spec: Value,
}

impl Corpus {
    /// Reads `conformance/manifest.json` and every case's `case.json`.
    pub fn open() -> Result<Corpus, String> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance");
        let manifest = read_json(&root.join("manifest.json"))?;
        if manifest["format"] != FORMAT {
            return Err(format!(
                "manifest.json: format is {}, not {FORMAT:?}",
                manifest["format"]
            ));
        }
        match manifest["version"].as_u64() {
            Some(version) if version <= VERSION => {}
            _ => {
                return Err(format!(
                    "manifest.json: version {} is newer than this harness reads ({VERSION})",
                    manifest["version"]
                ));
            }
        }
        let mut cases = Vec::new();
        for entry in manifest["cases"]
            .as_array()
            .ok_or("manifest.json: no cases")?
        {
            let id = entry["id"]
                .as_str()
                .ok_or("manifest.json: a case without an id")?;
            let dir = root.join("cases").join(id);
            let spec = read_json(&dir.join("case.json"))?;
            if spec["id"] != id {
                return Err(format!("cases/{id}/case.json: id is {}", spec["id"]));
            }
            cases.push(Case {
                id: id.to_owned(),
                dir,
                spec,
            });
        }
        let primitives = manifest["primitives"]
            .as_array()
            .ok_or("manifest.json: no primitives")?
            .iter()
            .map(|p| {
                p.as_str()
                    .map(str::to_owned)
                    .ok_or("manifest.json: a primitive is not a path")
            })
            .collect::<Result<_, _>>()?;
        Ok(Corpus {
            root,
            cases,
            primitives,
        })
    }
}

impl Case {
    /// The path of a file of the case, relative to its directory (`expected/diff.json`).
    pub fn path(&self, relative: &str) -> PathBuf {
        self.dir.join(relative)
    }

    pub fn read_bytes(&self, relative: &str) -> Result<Vec<u8>, String> {
        read_bytes(&self.path(relative))
    }
}

pub fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = read_bytes(path)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// How an expected file is compared (README, "Layout").
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Reproduced exactly.
    Bytes,
    /// Parsed and compared as JSON values: object key order does not matter, arrays are ordered,
    /// numbers are compared as IEEE 754 doubles.
    Value,
}

/// Compares `actual` with the expected file; `Err` says where they differ.
pub fn compare(mode: Mode, actual: &[u8], expected: &[u8]) -> Result<(), String> {
    match mode {
        Mode::Bytes => compare_bytes(actual, expected),
        Mode::Value => {
            let actual: Value = serde_json::from_slice(actual)
                .map_err(|e| format!("the output is not JSON: {e}"))?;
            let expected: Value = serde_json::from_slice(expected)
                .map_err(|e| format!("the expected file is not JSON: {e}"))?;
            compare_values(&actual, &expected, &mut String::from("$"))
        }
    }
}

fn compare_bytes(actual: &[u8], expected: &[u8]) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    let at = actual
        .iter()
        .zip(expected)
        .take_while(|(a, e)| a == e)
        .count();
    let excerpt = |bytes: &[u8]| {
        let start = at.saturating_sub(40);
        let end = (at + 40).min(bytes.len());
        format!("{:?}", String::from_utf8_lossy(&bytes[start..end]))
    };
    Err(format!(
        "bytes differ at offset {at} (output {} bytes, expected {})\n      output:   …{}…\n      expected: …{}…",
        actual.len(),
        expected.len(),
        excerpt(actual),
        excerpt(expected),
    ))
}

fn compare_values(actual: &Value, expected: &Value, path: &mut String) -> Result<(), String> {
    let mismatch = |path: &str| Err(format!("{path}: output {actual}, expected {expected}"));
    match (actual, expected) {
        (Value::Number(a), Value::Number(e)) => {
            let (a, e) = (a.as_f64(), e.as_f64());
            if a.map(f64::to_bits) == e.map(f64::to_bits) {
                Ok(())
            } else {
                mismatch(path)
            }
        }
        (Value::Array(a), Value::Array(e)) => {
            if a.len() != e.len() {
                return Err(format!(
                    "{path}: output has {} items, expected {}",
                    a.len(),
                    e.len()
                ));
            }
            for (i, (a, e)) in a.iter().zip(e).enumerate() {
                let len = path.len();
                write!(path, "[{i}]").unwrap();
                compare_values(a, e, path)?;
                path.truncate(len);
            }
            Ok(())
        }
        (Value::Object(a), Value::Object(e)) => {
            if let Some(key) = e.keys().find(|k| !a.contains_key(*k)) {
                return Err(format!("{path}: output lacks the member {key:?}"));
            }
            if let Some(key) = a.keys().find(|k| !e.contains_key(*k)) {
                return Err(format!("{path}: output has an unexpected member {key:?}"));
            }
            for (key, e) in e {
                let len = path.len();
                write!(path, ".{key}").unwrap();
                compare_values(&a[key], e, path)?;
                path.truncate(len);
            }
            Ok(())
        }
        _ if actual == expected => Ok(()),
        _ => mismatch(path),
    }
}
