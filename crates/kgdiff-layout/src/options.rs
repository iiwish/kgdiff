//! Option defaults and validation (`options.ts`), with TypeScript's messages.

use kgdiff_core::js::{IndexMap, Object, Value, json};
use kgdiff_core::model::{Point, UnionId};
use kgdiff_core::{KgdiffError, Result};

use crate::math::{clamp, log2, max, round};
use crate::prng::seed_state;

/// How positions are found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LayoutStrategy {
    /// Lay out the union graph, so that neither version is favoured (the default when no
    /// position is known).
    Union,
    /// Keep known positions (pins, or `position` on the graph nodes) fixed and place only the
    /// other nodes (the default when at least one position is known).
    Anchored,
}

impl LayoutStrategy {
    /// The name in options and layout documents (`union`, `anchored`).
    pub fn as_str(self) -> &'static str {
        match self {
            LayoutStrategy::Union => "union",
            LayoutStrategy::Anchored => "anchored",
        }
    }

    pub fn from_name(name: &str) -> Option<LayoutStrategy> {
        match name {
            "union" => Some(LayoutStrategy::Union),
            "anchored" => Some(LayoutStrategy::Anchored),
            _ => None,
        }
    }
}

/// Which union nodes get a position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LayoutScope {
    /// Every union node.
    All,
    /// Changed nodes, the endpoints of changed edges and `context_hops` of unchanged context
    /// around changed nodes, not expanded through hubs (see [`LayoutOptions::hub_degree`]).
    /// Hidden neighbours are counted in [`LayoutResult::hidden`](crate::LayoutResult::hidden).
    Changes,
}

impl LayoutScope {
    /// The name in options and layout documents (`all`, `changes`).
    pub fn as_str(self) -> &'static str {
        match self {
            LayoutScope::All => "all",
            LayoutScope::Changes => "changes",
        }
    }

    pub fn from_name(name: &str) -> Option<LayoutScope> {
        match name {
            "all" => Some(LayoutScope::All),
            "changes" => Some(LayoutScope::Changes),
            _ => None,
        }
    }
}

/// The options of a layout (`LayoutOptions` of `@kgdiff/layout`); `None` takes the default.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayoutOptions {
    /// Default: `Anchored` when any position is known, else `Union`.
    pub strategy: Option<LayoutStrategy>,
    /// Default: `Changes` when the union has more than `large_graph_threshold` nodes.
    pub scope: Option<LayoutScope>,
    /// Context hops kept around changes when the scope is `Changes`. Default 1.
    pub context_hops: Option<usize>,
    /// Scope `Changes`: context is never expanded from a node whose degree (max over both
    /// versions) exceeds this, so that one changed hub (a class with thousands of instances)
    /// does not pull its whole neighbourhood into the layout. The hub itself stays in scope
    /// when it is a seed or within reach; neighbours that could only enter through it are
    /// counted in `hidden`. Default 40; `f64::INFINITY` disables the rule.
    pub hub_degree: Option<f64>,
    /// Default 3000 nodes.
    pub large_graph_threshold: Option<f64>,
    /// The PRNG seed: the same seed and input give identical positions. Any finite number;
    /// integers map to the 32-bit state by `ToUint32`, others by a hash of their JavaScript
    /// text. Default 1.
    pub seed: Option<f64>,
    /// Simulation ticks. Default: chosen from the size of each simulation.
    pub iterations: Option<usize>,
    /// Target edge length in world units. Default 56.
    pub link_distance: Option<f64>,
    /// Reserve room for labels so that they do not overlap. Default true.
    pub label_aware: Option<bool>,
    /// The font size label boxes are estimated with (world units at zoom 1). Default 12.
    pub font_size: Option<f64>,
    /// Explicit positions; they win over `position` found on graph nodes.
    pub pinned: IndexMap<UnionId, Point>,
    /// The gap between packed connected components. Default 96.
    pub component_gap: Option<f64>,
}

const CONTEXT_HOPS: usize = 1;
const HUB_DEGREE: f64 = 40.0;
const LARGE_GRAPH_THRESHOLD: f64 = 3000.0;
const SEED: f64 = 1.0;
pub(crate) const LINK_DISTANCE: f64 = 56.0;
const LABEL_AWARE: bool = true;
const FONT_SIZE: f64 = 12.0;
const COMPONENT_GAP: f64 = 96.0;

/// Every option with its default filled in.
#[derive(Clone, Debug)]
pub(crate) struct Resolved<'a> {
    /// `None` = choose from the data (anchored when any position is known).
    pub strategy: Option<LayoutStrategy>,
    /// `None` = choose from the graph size.
    pub scope: Option<LayoutScope>,
    pub context_hops: usize,
    pub hub_degree: f64,
    pub large_graph_threshold: f64,
    /// The 32-bit PRNG state of the seed.
    pub seed: u32,
    /// `None` = choose from the graph size.
    pub iterations: Option<usize>,
    pub link_distance: f64,
    pub label_aware: bool,
    pub font_size: f64,
    pub pinned: &'a IndexMap<UnionId, Point>,
    pub component_gap: f64,
}

fn invalid(option: &str, value: Value, expected: &str) -> KgdiffError {
    let mut details = Object::new();
    details.insert("option", option);
    let shown = value.to_js_string();
    details.insert("value", value);
    KgdiffError::invalid_input(format!(
        "Invalid layout option {option}: expected {expected}, got {shown}"
    ))
    .with_details(details)
}

fn number(
    option: &str,
    value: Option<f64>,
    fallback: f64,
    check: impl Fn(f64) -> bool,
    expected: &str,
) -> Result<f64> {
    match value {
        None => Ok(fallback),
        Some(v) if !v.is_nan() && check(v) => Ok(v),
        Some(v) => Err(invalid(option, Value::Number(v), expected)),
    }
}

impl LayoutOptions {
    /// Validates the options and fills in the defaults.
    pub(crate) fn resolve(&self) -> Result<Resolved<'_>> {
        for (id, p) in &self.pinned {
            if !p.x.is_finite() || !p.y.is_finite() {
                let mut point = Object::new();
                point.insert("x", p.x);
                point.insert("y", p.y);
                let shown = json::to_string(&Value::Object(point));
                return Err(invalid(
                    &format!("pinned[{id}]"),
                    Value::from(shown),
                    "a finite point",
                ));
            }
        }
        let at_least_zero = |v: f64| v >= 0.0;
        let finite_positive = |v: f64| v.is_finite() && v > 0.0;
        Ok(Resolved {
            strategy: self.strategy,
            scope: self.scope,
            context_hops: self.context_hops.unwrap_or(CONTEXT_HOPS),
            hub_degree: number(
                "hubDegree",
                self.hub_degree,
                HUB_DEGREE,
                at_least_zero,
                "a number ≥ 0",
            )?,
            large_graph_threshold: number(
                "largeGraphThreshold",
                self.large_graph_threshold,
                LARGE_GRAPH_THRESHOLD,
                at_least_zero,
                "a number ≥ 0",
            )?,
            seed: seed_state(number(
                "seed",
                self.seed,
                SEED,
                f64::is_finite,
                "a finite number",
            )?),
            iterations: self.iterations,
            link_distance: number(
                "linkDistance",
                self.link_distance,
                LINK_DISTANCE,
                finite_positive,
                "a finite number > 0",
            )?,
            label_aware: self.label_aware.unwrap_or(LABEL_AWARE),
            font_size: number(
                "fontSize",
                self.font_size,
                FONT_SIZE,
                finite_positive,
                "a finite number > 0",
            )?,
            pinned: &self.pinned,
            component_gap: number(
                "componentGap",
                self.component_gap,
                COMPONENT_GAP,
                |v| v.is_finite() && v >= 0.0,
                "a finite number ≥ 0",
            )?,
        })
    }

    /// The options of a JSON object, as `@kgdiff/layout` reads a `LayoutOptions` object
    /// (`layoutOptions` of the conformance corpus): the same names, checks and messages.
    /// Absent members take their defaults and unknown members are ignored; `labelAware` is
    /// JavaScript truthiness (`null` takes the default). `pinned`, a `Map` in TypeScript, is an
    /// object of `{ "x": …, "y": … }` points here.
    ///
    /// # Errors
    ///
    /// `invalid-input` for a value TypeScript rejects (an unknown strategy, a non-integer
    /// `iterations`, a non-finite pin, …), or when `value` is not an object.
    pub fn from_value(value: &Value) -> Result<LayoutOptions> {
        let Some(object) = value.as_object() else {
            return Err(KgdiffError::invalid_input(format!(
                "Invalid layout options: expected an object, got {}",
                value.to_js_string()
            )));
        };
        let member = |name: &str| object.get(name);
        let named = |name: &str, expected: &str, parse: fn(&str) -> Option<()>| -> Result<()> {
            match member(name) {
                None => Ok(()),
                Some(v) if v.as_str().and_then(parse).is_some() => Ok(()),
                Some(v) => Err(invalid(name, v.clone(), expected)),
            }
        };
        named("strategy", "'union' or 'anchored'", |s| {
            LayoutStrategy::from_name(s).map(|_| ())
        })?;
        named("scope", "'all' or 'changes'", |s| {
            LayoutScope::from_name(s).map(|_| ())
        })?;
        let strategy = member("strategy")
            .and_then(Value::as_str)
            .and_then(LayoutStrategy::from_name);
        let scope = member("scope")
            .and_then(Value::as_str)
            .and_then(LayoutScope::from_name);

        let mut pinned = IndexMap::default();
        if let Some(points) = member("pinned") {
            let points = points
                .as_object()
                .ok_or_else(|| invalid("pinned", points.clone(), "an object of points"))?;
            for (id, p) in points.iter() {
                let coordinate = |name: &str| {
                    p.as_object()
                        .and_then(|o| o.get(name))
                        .and_then(Value::as_f64)
                        .filter(|v| v.is_finite())
                };
                let (Some(x), Some(y)) = (coordinate("x"), coordinate("y")) else {
                    return Err(invalid(
                        &format!("pinned[{id}]"),
                        Value::from(json::to_string(p)),
                        "a finite point",
                    ));
                };
                pinned.insert(id.clone(), Point { x, y });
            }
        }

        // The numbers, each checked completely in TypeScript's order, so that the first invalid
        // option is the one TypeScript reports.
        let number = |name: &str, check: fn(f64) -> bool, expected: &str| -> Result<Option<f64>> {
            match member(name) {
                None => Ok(None),
                Some(Value::Number(x)) if !x.is_nan() && check(*x) => Ok(Some(*x)),
                Some(other) => Err(invalid(name, other.clone(), expected)),
            }
        };
        let integer = |v: f64| v.is_finite() && v.trunc() == v && v >= 0.0;
        let at_least_zero = |v: f64| v >= 0.0;
        let finite_positive = |v: f64| v.is_finite() && v > 0.0;
        let iterations = number("iterations", integer, "an integer ≥ 0")?.map(to_count);
        let context_hops = number("contextHops", integer, "an integer ≥ 0")?.map(to_count);
        let hub_degree = number("hubDegree", at_least_zero, "a number ≥ 0")?;
        let large_graph_threshold = number("largeGraphThreshold", at_least_zero, "a number ≥ 0")?;
        let seed = number("seed", f64::is_finite, "a finite number")?;
        let link_distance = number("linkDistance", finite_positive, "a finite number > 0")?;
        let label_aware = match member("labelAware") {
            None | Some(Value::Null) => None,
            Some(v) => Some(truthy(v)),
        };
        let font_size = number("fontSize", finite_positive, "a finite number > 0")?;
        let component_gap = number(
            "componentGap",
            |v| v.is_finite() && v >= 0.0,
            "a finite number ≥ 0",
        )?;
        Ok(LayoutOptions {
            strategy,
            scope,
            context_hops,
            hub_degree,
            large_graph_threshold,
            seed,
            iterations,
            link_distance,
            label_aware,
            font_size,
            pinned,
            component_gap,
        })
    }
}

/// JavaScript's `Boolean(value)` for a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(x) => *x != 0.0 && !x.is_nan(),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A non-negative integer-valued double as a count; beyond `usize` (a simulation that would
/// never finish in TypeScript either) it saturates.
pub(crate) fn to_count(x: f64) -> usize {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "x is a non-negative integer; `as` saturates beyond usize::MAX"
    )]
    let count = x as usize;
    count
}

/// Above this many nodes in one simulation the tick count shrinks (see `default_iterations`).
const LARGE_SIMULATION: f64 = 2000.0;
const MIN_TICKS: f64 = 30.0;

/// The default tick count of a simulation over `node_count` nodes: `clamp(300 − 25·log₂(N), 120,
/// 300)` up to 2000 nodes, then `max(30, 120 · 2000 / N)`, which holds the work at that of a
/// 2000-node run (each tick costs ~N log N).
pub(crate) fn default_iterations(node_count: usize) -> usize {
    let n = node_count as f64;
    let ticks = if n > LARGE_SIMULATION {
        max(MIN_TICKS, round((120.0 * LARGE_SIMULATION) / n))
    } else {
        clamp(round(300.0 - 25.0 * log2(max(1.0, n))), 120.0, 300.0)
    };
    to_count(ticks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_iterations_follow_the_spec() {
        assert_eq!(default_iterations(0), 300);
        assert_eq!(default_iterations(2), 275);
        assert_eq!(default_iterations(64), 150);
        assert_eq!(default_iterations(300), 120);
        assert_eq!(default_iterations(2000), 120);
        assert_eq!(default_iterations(5000), 48);
        assert_eq!(default_iterations(10_000), 30);
    }

    #[test]
    fn rejects_what_typescript_rejects() {
        let parse = |text: &str| LayoutOptions::from_value(&json::parse(text).unwrap());
        for text in [
            r#"{"linkDistance":0}"#,
            r#"{"fontSize":-1}"#,
            r#"{"iterations":1.5}"#,
            r#"{"iterations":-1}"#,
            r#"{"contextHops":-1}"#,
            r#"{"componentGap":1e400}"#,
            r#"{"strategy":"force"}"#,
            r#"{"scope":"some"}"#,
            r#"{"hubDegree":-1}"#,
            r#"{"seed":"x"}"#,
            r#"{"pinned":{"a":{"x":1}}}"#,
        ] {
            let error = parse(text).unwrap_err();
            assert_eq!(error.code.as_str(), "invalid-input", "{text}");
        }
        assert_eq!(
            parse(r#"{"iterations":1.5}"#).unwrap_err().message,
            "Invalid layout option iterations: expected an integer ≥ 0, got 1.5"
        );
        assert_eq!(
            parse(r#"{"strategy":"force"}"#).unwrap_err().message,
            "Invalid layout option strategy: expected 'union' or 'anchored', got force"
        );
        let options = LayoutOptions {
            seed: Some(f64::NAN),
            ..LayoutOptions::default()
        };
        assert_eq!(
            options.resolve().unwrap_err().message,
            "Invalid layout option seed: expected a finite number, got NaN"
        );
        let mut pinned = IndexMap::default();
        pinned.insert(
            UnionId::from("t0"),
            Point {
                x: f64::NAN,
                y: 0.0,
            },
        );
        let options = LayoutOptions {
            pinned,
            ..LayoutOptions::default()
        };
        assert_eq!(
            options.resolve().unwrap_err().message,
            r#"Invalid layout option pinned[t0]: expected a finite point, got {"x":null,"y":0}"#
        );
    }

    #[test]
    fn reads_the_options_of_the_corpus() {
        let options =
            LayoutOptions::from_value(&json::parse(r#"{"scope":"changes","seed":0.5}"#).unwrap())
                .unwrap();
        assert_eq!(options.scope, Some(LayoutScope::Changes));
        assert_eq!(options.seed, Some(0.5));
        assert_eq!(
            LayoutOptions::from_value(&json::parse("{}").unwrap()).unwrap(),
            LayoutOptions::default()
        );
    }
}
