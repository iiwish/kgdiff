//! A JSON Schema (draft 2020-12) validator for the keywords kgdiff's schemas use, so that tests
//! check the payloads the crate writes against `packages/core/schema/report.v1.json` without a
//! schema crate (and its dependency tree) in the workspace. `report.v1.json` refers to the diff,
//! packed diff, delta, graph and layout schemas next to it, so this validator loads the whole
//! directory and follows references between the files. An unknown keyword is an error, and so
//! is an unknown `pattern`, so that no schema can grow a rule this validator silently ignores.
//! (kgdiff-layout's tests have a smaller one, for `layout.v2.json` alone.)

use kgdiff_core::js::{Object, Value, json};

const BASE: &str = "https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/";

/// Keywords that say nothing about validity.
const ANNOTATIONS: [&str; 4] = ["$schema", "$id", "title", "description"];

/// Every schema of `packages/core/schema/`, by file name.
pub struct Schemas {
    documents: Vec<(String, Value)>,
}

/// Where a schema is: the document `#` references resolve in.
#[derive(Clone, Copy)]
struct Scope<'a> {
    root: &'a Value,
}

/// One schema object applied to one value.
struct Site<'a> {
    scope: Scope<'a>,
    schema: &'a Object,
    value: &'a Value,
    /// The path of the value, for messages.
    at: &'a str,
}

impl Schemas {
    pub fn load() -> Schemas {
        let dir = format!("{}/../../packages/core/schema", env!("CARGO_MANIFEST_DIR"));
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{dir}: {e}"))
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".json"))
            .collect();
        names.sort();
        let documents = names
            .into_iter()
            .map(|name| {
                let path = format!("{dir}/{name}");
                let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
                let root = json::parse(&text).unwrap_or_else(|e| panic!("{path}: {e}"));
                // References between the files are relative to their `$id`: they name a file
                // exactly when every `$id` is the base plus the file name.
                assert_eq!(
                    root.get("$id").and_then(Value::as_str),
                    Some(format!("{BASE}{name}").as_str()),
                    "the $id of {name}"
                );
                (name, root)
            })
            .collect();
        Schemas { documents }
    }

    fn document(&self, name: &str) -> &Value {
        self.documents
            .iter()
            .find(|(n, _)| n == name)
            .map_or_else(|| panic!("no schema {name}"), |(_, root)| root)
    }

    /// The errors of `value` against the schema in the file `name`, as `path: message`.
    pub fn errors(&self, name: &str, value: &Value) -> Vec<String> {
        let root = self.document(name);
        let mut errors = Vec::new();
        self.check(Scope { root }, root, value, "$", &mut errors);
        errors
    }

    /// `file.json#/json/pointer`, with either part left out.
    fn resolve<'a>(&'a self, scope: Scope<'a>, reference: &str) -> (Scope<'a>, &'a Value) {
        let (file, pointer) = reference.split_once('#').unwrap_or((reference, ""));
        let root = if file.is_empty() {
            scope.root
        } else {
            self.document(file)
        };
        let mut schema = root;
        if !pointer.is_empty() {
            let path = pointer
                .strip_prefix('/')
                .unwrap_or_else(|| panic!("unsupported $ref {reference}"));
            for token in path.split('/') {
                let key = token.replace("~1", "/").replace("~0", "~");
                schema = schema
                    .get(&key)
                    .unwrap_or_else(|| panic!("$ref {reference}: nothing at {key}"));
            }
        }
        (Scope { root }, schema)
    }

    /// The errors of `value` against `schema`, on their own.
    fn errors_of(&self, scope: Scope<'_>, schema: &Value, value: &Value, at: &str) -> Vec<String> {
        let mut errors = Vec::new();
        self.check(scope, schema, value, at, &mut errors);
        errors
    }

    fn check(
        &self,
        scope: Scope<'_>,
        schema: &Value,
        value: &Value,
        at: &str,
        errors: &mut Vec<String>,
    ) {
        if let Value::Bool(allowed) = schema {
            if !allowed {
                errors.push(format!("{at}: not allowed"));
            }
            return;
        }
        let schema = schema
            .as_object()
            .expect("a schema is an object or a boolean");
        let site = Site {
            scope,
            schema,
            value,
            at,
        };
        for (keyword, rule) in schema.iter() {
            let keyword = keyword.as_str();
            if ANNOTATIONS.contains(&keyword) || keyword == "$defs" {
                continue;
            }
            let known = self.applicator(&site, keyword, rule, errors)
                || self.in_object(&site, keyword, rule, errors)
                || self.in_array(&site, keyword, rule, errors)
                || assertion(keyword, rule, value, at, errors);
            assert!(
                known,
                "the test validator does not know the keyword {keyword}"
            );
        }
    }

    /// The keywords that apply schemas to the value itself. `false` for any other keyword.
    fn applicator(
        &self,
        site: &Site<'_>,
        keyword: &str,
        rule: &Value,
        errors: &mut Vec<String>,
    ) -> bool {
        let Site {
            scope,
            schema,
            value,
            at,
        } = *site;
        match keyword {
            "$ref" => {
                let (target, sub) = self.resolve(scope, rule.as_str().unwrap());
                self.check(target, sub, value, at, errors);
            }
            "allOf" => {
                for sub in rule.as_array().unwrap() {
                    self.check(scope, sub, value, at, errors);
                }
            }
            "anyOf" | "oneOf" => {
                let branches: Vec<Vec<String>> = rule
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|sub| self.errors_of(scope, sub, value, at))
                    .collect();
                let valid = branches.iter().filter(|b| b.is_empty()).count();
                if valid == 0 {
                    errors.push(format!("{at}: matches no branch of {keyword}"));
                    for (i, branch) in branches.iter().enumerate() {
                        errors.extend(branch.iter().map(|e| format!("  {keyword}[{i}] {e}")));
                    }
                } else if keyword == "oneOf" && valid > 1 {
                    errors.push(format!("{at}: matches {valid} branches of oneOf"));
                }
            }
            "if" => {
                let branch = if self.errors_of(scope, rule, value, at).is_empty() {
                    "then"
                } else {
                    "else"
                };
                if let Some(sub) = schema.get(branch) {
                    self.check(scope, sub, value, at, errors);
                }
            }
            // Applied by `if`.
            "then" | "else" => {}
            _ => return false,
        }
        true
    }

    /// The keywords about an object's members. `false` for any other keyword.
    fn in_object(
        &self,
        site: &Site<'_>,
        keyword: &str,
        rule: &Value,
        errors: &mut Vec<String>,
    ) -> bool {
        let Site {
            scope,
            schema,
            value,
            at,
        } = *site;
        if !matches!(
            keyword,
            "required"
                | "properties"
                | "additionalProperties"
                | "propertyNames"
                | "minProperties"
                | "dependentRequired"
                | "dependentSchemas"
        ) {
            return false;
        }
        let Some(object) = value.as_object() else {
            return true;
        };
        let require = |errors: &mut Vec<String>, names: &Value| {
            for name in names.as_array().unwrap() {
                let name = name.as_str().unwrap();
                if !object.contains_key(name) {
                    errors.push(format!("{at}: missing {name}"));
                }
            }
        };
        match keyword {
            "required" => require(errors, rule),
            "properties" => {
                for (name, sub) in rule.as_object().unwrap().iter() {
                    if let Some(member) = object.get(name) {
                        self.check(scope, sub, member, &format!("{at}.{name}"), errors);
                    }
                }
            }
            "additionalProperties" => {
                let known = schema.get("properties").and_then(Value::as_object);
                for (name, member) in object.iter() {
                    if !known.is_some_and(|k| k.contains_key(name)) {
                        self.check(scope, rule, member, &format!("{at}[{name:?}]"), errors);
                    }
                }
            }
            "propertyNames" => {
                for name in object.keys() {
                    let key = Value::String(name.clone());
                    self.check(scope, rule, &key, &format!("{at} key {name:?}"), errors);
                }
            }
            "minProperties" => {
                if (object.len() as f64) < rule.as_f64().unwrap() {
                    errors.push(format!("{at}: too few members"));
                }
            }
            "dependentRequired" => {
                for (name, names) in rule.as_object().unwrap().iter() {
                    if object.contains_key(name) {
                        require(errors, names);
                    }
                }
            }
            _ => {
                for (name, sub) in rule.as_object().unwrap().iter() {
                    if object.contains_key(name) {
                        self.check(scope, sub, value, at, errors);
                    }
                }
            }
        }
        true
    }

    /// The keywords about an array's items. `false` for any other keyword.
    fn in_array(
        &self,
        site: &Site<'_>,
        keyword: &str,
        rule: &Value,
        errors: &mut Vec<String>,
    ) -> bool {
        let Site {
            scope,
            schema,
            value,
            at,
        } = *site;
        if !matches!(
            keyword,
            "prefixItems" | "items" | "minItems" | "maxItems" | "uniqueItems"
        ) {
            return false;
        }
        let Some(items) = value.as_array() else {
            return true;
        };
        match keyword {
            "prefixItems" => {
                for (i, (sub, item)) in rule.as_array().unwrap().iter().zip(items).enumerate() {
                    self.check(scope, sub, item, &format!("{at}[{i}]"), errors);
                }
            }
            "items" => {
                let skip = schema
                    .get("prefixItems")
                    .and_then(Value::as_array)
                    .map_or(0, <[Value]>::len);
                for (i, item) in items.iter().enumerate().skip(skip) {
                    self.check(scope, rule, item, &format!("{at}[{i}]"), errors);
                }
            }
            "uniqueItems" => {
                if rule.as_bool().unwrap() && !unique(items) {
                    errors.push(format!("{at}: items are not unique"));
                }
            }
            _ => {
                let n = items.len() as f64;
                let bound = rule.as_f64().unwrap();
                if (keyword == "minItems" && n < bound) || (keyword == "maxItems" && n > bound) {
                    errors.push(format!("{at}: {n} items violate {keyword} {bound}"));
                }
            }
        }
        true
    }
}

/// Whether no two items are equal. String tables are long, so strings are sorted.
fn unique(items: &[Value]) -> bool {
    let strings: Option<Vec<&str>> = items.iter().map(Value::as_str).collect();
    match strings {
        Some(mut strings) => {
            strings.sort();
            strings.windows(2).all(|pair| pair[0] != pair[1])
        }
        None => items
            .iter()
            .enumerate()
            .all(|(i, item)| !items[..i].contains(item)),
    }
}

/// The patterns of kgdiff's schemas, each implemented by hand (no regular expression engine).
fn matches_pattern(pattern: &str, text: &str) -> bool {
    match pattern {
        "^c53:[0-9a-f]{14}$" => text.strip_prefix("c53:").is_some_and(|hex| {
            hex.len() == 14 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        }),
        other => panic!("the test validator does not know the pattern {other}"),
    }
}

/// The keywords about the value itself. `false` for any other keyword.
fn assertion(
    keyword: &str,
    rule: &Value,
    value: &Value,
    at: &str,
    errors: &mut Vec<String>,
) -> bool {
    let mut fail = |message: String| errors.push(format!("{at}: {message}"));
    match keyword {
        "type" => {
            let name = rule.as_str().unwrap();
            let ok = match name {
                "object" => matches!(value, Value::Object(_)),
                "array" => matches!(value, Value::Array(_)),
                "string" => matches!(value, Value::String(_)),
                "number" => matches!(value, Value::Number(_)),
                "integer" => value.as_f64().is_some_and(|x| x.trunc() == x),
                "boolean" => matches!(value, Value::Bool(_)),
                "null" => matches!(value, Value::Null),
                other => panic!("unsupported type {other}"),
            };
            if !ok {
                fail(format!("expected {name}"));
            }
        }
        "const" => {
            if value != rule {
                fail(format!("expected {}", json::to_string(rule)));
            }
        }
        "enum" => {
            if !rule.as_array().unwrap().contains(value) {
                fail(format!("not one of {}", json::to_string(rule)));
            }
        }
        "minimum" | "maximum" => {
            let bound = rule.as_f64().unwrap();
            if let Some(x) = value.as_f64()
                && ((keyword == "minimum" && x < bound) || (keyword == "maximum" && x > bound))
            {
                fail(format!("{x} violates {keyword} {bound}"));
            }
        }
        "minLength" => {
            if let Some(s) = value.as_js_str()
                && (s.utf16_len() as f64) < rule.as_f64().unwrap()
            {
                fail("too short".to_owned());
            }
        }
        "pattern" => {
            if let Some(s) = value.as_str()
                && !matches_pattern(rule.as_str().unwrap(), s)
            {
                fail(format!("does not match {}", rule.as_str().unwrap()));
            }
        }
        _ => return false,
    }
    true
}
