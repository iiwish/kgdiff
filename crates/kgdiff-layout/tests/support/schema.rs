//! A JSON Schema (draft 2020-12) validator for the keywords kgdiff's schemas use, so that tests
//! check what the crate writes against `packages/core/schema/layout.v2.json` without a schema
//! crate (and its dependency tree) in the workspace. An unknown keyword is an error, so that the
//! schema cannot grow a rule this validator silently ignores.

use kgdiff_core::js::{Value, json};

pub struct Schema {
    root: Value,
}

const ANNOTATIONS: [&str; 4] = ["$schema", "$id", "title", "description"];

impl Schema {
    pub fn load(name: &str) -> Schema {
        let path = format!(
            "{}/../../packages/core/schema/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        Schema {
            root: json::parse(&text).unwrap_or_else(|e| panic!("{path}: {e}")),
        }
    }

    /// The errors of `value` against the schema, as `path: message`.
    pub fn errors(&self, value: &Value) -> Vec<String> {
        let mut errors = Vec::new();
        self.check(&self.root, value, "$", &mut errors);
        errors
    }

    fn resolve<'a>(&'a self, reference: &str) -> &'a Value {
        let name = reference
            .strip_prefix("#/$defs/")
            .unwrap_or_else(|| panic!("unsupported $ref {reference}"));
        self.root
            .get("$defs")
            .and_then(|defs| defs.get(name))
            .unwrap_or_else(|| panic!("no $defs/{name}"))
    }

    #[allow(clippy::too_many_lines, reason = "one match arm per keyword")]
    fn check(&self, schema: &Value, value: &Value, at: &str, errors: &mut Vec<String>) {
        if let Value::Bool(allowed) = schema {
            if !allowed {
                errors.push(format!("{at}: not allowed"));
            }
            return;
        }
        let schema = schema
            .as_object()
            .expect("a schema is an object or a boolean");
        for (keyword, rule) in schema.iter() {
            let fail = |errors: &mut Vec<String>, message: String| {
                errors.push(format!("{at}: {message}"));
            };
            match keyword.as_str() {
                k if ANNOTATIONS.contains(&k) => {}
                "$defs" => {}
                "$ref" => self.check(self.resolve(rule.as_str().unwrap()), value, at, errors),
                "type" => {
                    let ok = match rule.as_str().unwrap() {
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
                        fail(errors, format!("expected {}", rule.as_str().unwrap()));
                    }
                }
                "const" => {
                    if value != rule {
                        fail(errors, format!("expected {}", json::to_string(rule)));
                    }
                }
                "enum" => {
                    if !rule.as_array().unwrap().contains(value) {
                        fail(errors, format!("not one of {}", json::to_string(rule)));
                    }
                }
                "minimum" | "maximum" => {
                    let bound = rule.as_f64().unwrap();
                    if let Some(x) = value.as_f64() {
                        let ok = if keyword.as_str() == "minimum" {
                            x >= bound
                        } else {
                            x <= bound
                        };
                        if !ok {
                            fail(errors, format!("{x} violates {keyword} {bound}"));
                        }
                    }
                }
                "minLength" => {
                    if let Some(s) = value.as_js_str()
                        && (s.utf16_len() as f64) < rule.as_f64().unwrap()
                    {
                        fail(errors, "too short".to_owned());
                    }
                }
                "minItems" | "maxItems" => {
                    if let Some(items) = value.as_array() {
                        let n = items.len() as f64;
                        let bound = rule.as_f64().unwrap();
                        if (keyword.as_str() == "minItems" && n < bound)
                            || (keyword.as_str() == "maxItems" && n > bound)
                        {
                            fail(errors, format!("{n} items violate {keyword} {bound}"));
                        }
                    }
                }
                "required" => {
                    if let Some(object) = value.as_object() {
                        for name in rule.as_array().unwrap() {
                            let name = name.as_str().unwrap();
                            if !object.contains_key(name) {
                                fail(errors, format!("missing {name}"));
                            }
                        }
                    }
                }
                "properties" => {
                    if let Some(object) = value.as_object() {
                        for (name, sub) in rule.as_object().unwrap().iter() {
                            if let Some(member) = object.get(name) {
                                self.check(sub, member, &format!("{at}.{name}"), errors);
                            }
                        }
                    }
                }
                "additionalProperties" => {
                    if let Some(object) = value.as_object() {
                        let known = schema.get("properties").and_then(Value::as_object);
                        for (name, member) in object.iter() {
                            if known.is_some_and(|k| k.contains_key(name)) {
                                continue;
                            }
                            self.check(rule, member, &format!("{at}[{name:?}]"), errors);
                        }
                    }
                }
                "prefixItems" => {
                    if let Some(items) = value.as_array() {
                        for (i, (sub, item)) in
                            rule.as_array().unwrap().iter().zip(items).enumerate()
                        {
                            self.check(sub, item, &format!("{at}[{i}]"), errors);
                        }
                    }
                }
                "items" => {
                    if let Some(items) = value.as_array() {
                        let skip = schema
                            .get("prefixItems")
                            .and_then(Value::as_array)
                            .map_or(0, <[Value]>::len);
                        for (i, item) in items.iter().enumerate().skip(skip) {
                            self.check(rule, item, &format!("{at}[{i}]"), errors);
                        }
                    }
                }
                other => panic!("the test validator does not know the keyword {other}"),
            }
        }
    }
}
