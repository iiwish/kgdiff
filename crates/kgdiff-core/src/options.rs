//! Option defaults and validation (`options.ts`).

use crate::error::{KgdiffError, Result};
use crate::js::{JsStr, Object, Value};
use crate::model::EdgeIdentity;

/// Hierarchy predicates recognised out of the box (child → parent).
pub const DEFAULT_HIERARCHY_PREDICATES: [&str; 9] = [
    "rdfs:subClassOf",
    "http://www.w3.org/2000/01/rdf-schema#subClassOf",
    "rdfs:subPropertyOf",
    "http://www.w3.org/2000/01/rdf-schema#subPropertyOf",
    "skos:broader",
    "http://www.w3.org/2004/02/skos/core#broader",
    "is_a",
    "subClassOf",
    "parent",
];

/// How nodes are matched across versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MatchStrategy {
    Id,
    Auto,
    Similarity,
}

impl MatchStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchStrategy::Id => "id",
            MatchStrategy::Auto => "auto",
            MatchStrategy::Similarity => "similarity",
        }
    }
}

/// `Required<MatchOptions>`.
#[derive(Clone, Debug, PartialEq)]
pub struct MatchOptions {
    pub strategy: MatchStrategy,
    pub threshold: f64,
    pub suggest_threshold: f64,
    pub max_candidates: f64,
}

impl Default for MatchOptions {
    fn default() -> MatchOptions {
        MatchOptions {
            strategy: MatchStrategy::Auto,
            threshold: 0.82,
            suggest_threshold: 0.6,
            max_candidates: 8.0,
        }
    }
}

/// `ResolvedDiffOptions`: every option with its default filled in.
#[derive(Clone, Debug, PartialEq)]
pub struct DiffOptions {
    pub r#match: MatchOptions,
    pub edge_identity: EdgeIdentity,
    pub hierarchy_predicates: Vec<JsStr>,
    pub detect_merges: bool,
    pub detect_splits: bool,
    /// Sorted, unique.
    pub ignore_attrs: Vec<JsStr>,
}

impl Default for DiffOptions {
    fn default() -> DiffOptions {
        DiffOptions {
            r#match: MatchOptions::default(),
            edge_identity: EdgeIdentity::Structure,
            hierarchy_predicates: DEFAULT_HIERARCHY_PREDICATES
                .iter()
                .map(|p| JsStr::from(*p))
                .collect(),
            detect_merges: true,
            detect_splits: true,
            ignore_attrs: Vec::new(),
        }
    }
}

impl DiffOptions {
    /// The options as `diffToJSON` writes them (`ResolvedDiffOptions`).
    pub fn to_value(&self) -> Value {
        let m = &self.r#match;
        let mut matching = Object::new();
        matching.insert("strategy", m.strategy.as_str());
        matching.insert("threshold", m.threshold);
        matching.insert("suggestThreshold", m.suggest_threshold);
        matching.insert("maxCandidates", m.max_candidates);
        let strings = |list: &[JsStr]| Value::Array(list.iter().map(Value::from).collect());
        let mut out = Object::new();
        out.insert("match", matching);
        out.insert("edgeIdentity", self.edge_identity.as_str());
        out.insert("hierarchyPredicates", strings(&self.hierarchy_predicates));
        out.insert("detectMerges", self.detect_merges);
        out.insert("detectSplits", self.detect_splits);
        out.insert("ignoreAttrs", strings(&self.ignore_attrs));
        Value::Object(out)
    }
}

fn invalid(message: String, option: &str) -> KgdiffError {
    let mut details = Object::new();
    details.insert("option", option);
    KgdiffError::invalid_input(message).with_details(details)
}

/// `String(value)` of an option value, `undefined` when absent.
fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), Value::to_js_string)
}

fn unit_interval(value: Option<&Value>, fallback: f64, option: &str) -> Result<f64> {
    match value {
        None => Ok(fallback),
        Some(Value::Number(x)) if *x >= 0.0 && *x <= 1.0 => Ok(*x),
        Some(other) => Err(invalid(
            format!(
                "{option} must be a number between 0 and 1 (got {})",
                other.to_js_string()
            ),
            option,
        )),
    }
}

/// A list of strings, de-duplicated in first-occurrence order.
fn string_list(value: Option<&Value>, fallback: &[&str], option: &str) -> Result<Vec<JsStr>> {
    let Some(value) = value else {
        return Ok(fallback.iter().map(|s| JsStr::from(*s)).collect());
    };
    let items = value
        .as_array()
        .filter(|items| items.iter().all(|item| item.as_str().is_some()))
        .ok_or_else(|| invalid(format!("{option} must be an array of strings"), option))?;
    let mut out: Vec<JsStr> = Vec::with_capacity(items.len());
    for item in items {
        let item = item.as_js_str().cloned().unwrap_or_default();
        if !out.contains(&item) {
            out.push(item);
        }
    }
    Ok(out)
}

/// `resolveMatchOptions`.
pub fn resolve_match_options(options: Option<&Value>) -> Result<MatchOptions> {
    let defaults = MatchOptions::default();
    let Some(options) = options else {
        return Ok(defaults);
    };
    let options = options
        .as_object()
        .ok_or_else(|| invalid("match options must be an object".to_owned(), "match"))?;
    // `??` falls back on null as on undefined.
    let given = |key: &str| options.get(key).filter(|v| !v.is_null());
    let strategy = match given("strategy") {
        None => defaults.strategy,
        Some(Value::String(s)) if s == "id" => MatchStrategy::Id,
        Some(Value::String(s)) if s == "auto" => MatchStrategy::Auto,
        Some(Value::String(s)) if s == "similarity" => MatchStrategy::Similarity,
        Some(other) => {
            return Err(invalid(
                format!(
                    "match.strategy must be 'id', 'auto' or 'similarity' (got {})",
                    other.to_js_string()
                ),
                "match.strategy",
            ));
        }
    };
    let max_candidates = match given("maxCandidates") {
        None => defaults.max_candidates,
        Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 1.0 && n.is_finite() => *n,
        Some(other) => {
            return Err(invalid(
                format!(
                    "match.maxCandidates must be a positive integer (got {})",
                    other.to_js_string()
                ),
                "match.maxCandidates",
            ));
        }
    };
    Ok(MatchOptions {
        strategy,
        threshold: unit_interval(
            options.get("threshold"),
            defaults.threshold,
            "match.threshold",
        )?,
        suggest_threshold: unit_interval(
            options.get("suggestThreshold"),
            defaults.suggest_threshold,
            "match.suggestThreshold",
        )?,
        max_candidates,
    })
}

/// `resolveEdgeIdentity`.
pub fn resolve_edge_identity(
    value: Option<&Value>,
    fallback: EdgeIdentity,
) -> Result<EdgeIdentity> {
    match value {
        None => Ok(fallback),
        Some(v) => v.as_str().and_then(EdgeIdentity::from_name).ok_or_else(|| {
            invalid(
                format!(
                    "edgeIdentity must be 'structure' or 'id' (got {})",
                    shown(Some(v))
                ),
                "edgeIdentity",
            )
        }),
    }
}

/// `resolveOptions`: `DiffOptions` given as JSON (`undefined` members absent), every default
/// filled in; lists de-duplicated, `ignoreAttrs` sorted.
pub fn resolve_options(options: Option<&Value>) -> Result<DiffOptions> {
    let empty = Object::new();
    let o = match options {
        None => &empty,
        Some(Value::Object(o)) => o,
        Some(_) => return Err(invalid("options must be an object".to_owned(), "options")),
    };
    for flag in ["detectMerges", "detectSplits"] {
        if o.get(flag).is_some_and(|v| v.as_bool().is_none()) {
            return Err(invalid(format!("{flag} must be a boolean"), flag));
        }
    }
    let mut ignore_attrs = string_list(o.get("ignoreAttrs"), &[], "ignoreAttrs")?;
    ignore_attrs.sort();
    Ok(DiffOptions {
        r#match: resolve_match_options(o.get("match"))?,
        edge_identity: resolve_edge_identity(o.get("edgeIdentity"), EdgeIdentity::Structure)?,
        hierarchy_predicates: string_list(
            o.get("hierarchyPredicates"),
            &DEFAULT_HIERARCHY_PREDICATES,
            "hierarchyPredicates",
        )?,
        detect_merges: o
            .get("detectMerges")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        detect_splits: o
            .get("detectSplits")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        ignore_attrs,
    })
}

/// What happens to edges whose endpoints are missing (`NormalizeOptions.danglingEdges`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DanglingEdges {
    /// Add an implicit node.
    #[default]
    Create,
    /// Discard the edge.
    Drop,
    /// Fail with `dangling-edge`.
    Error,
}

/// `NormalizeOptions`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NormalizeOptions {
    pub edge_identity: EdgeIdentity,
    pub dangling_edges: DanglingEdges,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js;

    #[test]
    fn resolves_defaults_and_rejects_bad_options() {
        let resolved = resolve_options(None).unwrap();
        assert_eq!(resolved, DiffOptions::default());
        let bad = js::json::parse(r#"{"match":{"threshold":2}}"#).unwrap();
        let error = resolve_options(Some(&bad)).unwrap_err();
        assert_eq!(
            error.message,
            "match.threshold must be a number between 0 and 1 (got 2)"
        );
        let list = js::json::parse(r#"{"ignoreAttrs":["b","a","b"]}"#).unwrap();
        assert_eq!(
            resolve_options(Some(&list)).unwrap().ignore_attrs,
            [JsStr::from("a"), JsStr::from("b")]
        );
    }
}
