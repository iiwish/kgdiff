//! The `kgdiff.layout` document (`json.ts`, RFC 0002 §2): version 2, with `generator`, written
//! by this crate; versions 1 and 2 read. `packages/core/schema/layout.v2.json` describes what is
//! written.

use kgdiff_core::js::{IndexMap, JsStr, Object, Value};
use kgdiff_core::model::{Point, UnionId};
use kgdiff_core::{ErrorCode, KgdiffError, Result};

use crate::math::round2;
use crate::{LayoutComponent, LayoutResult, LayoutScope, LayoutStats, LayoutStrategy, Rect};

/// The `format` of a layout document.
pub const FORMAT: &str = "kgdiff.layout";

fn rect(r: &Rect) -> Value {
    let mut out = Object::new();
    out.insert("x", round2(r.x));
    out.insert("y", round2(r.y));
    out.insert("width", round2(r.width));
    out.insert("height", round2(r.height));
    Value::Object(out)
}

/// The members of an ordered map, sorted by id (UTF-16 code units) as `layoutToJSON` writes
/// them; `js::Object` then lists array-index ids first, as JavaScript does.
fn sorted<T>(map: &IndexMap<UnionId, T>) -> Vec<(&UnionId, &T)> {
    let mut entries: Vec<(&UnionId, &T)> = map.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    entries
}

pub(crate) fn to_json(layout: &LayoutResult) -> Value {
    let mut out = Object::new();
    out.insert("format", FORMAT);
    match &layout.generator {
        Some(generator) => {
            out.insert("version", 2u32);
            out.insert("generator", generator.clone());
        }
        None => {
            out.insert("version", 1u32);
        }
    }
    out.insert("strategy", layout.stats.strategy.as_str());
    out.insert("scope", layout.scope.as_str());
    out.insert("iterations", layout.stats.iterations);
    let mut positions = Object::with_capacity(layout.positions.len());
    for (id, p) in sorted(&layout.positions) {
        positions.insert(
            id.clone(),
            Value::Array(vec![round2(p.x).into(), round2(p.y).into()]),
        );
    }
    out.insert("positions", positions);
    let mut radii = Object::with_capacity(layout.radii.len());
    for (id, r) in sorted(&layout.radii) {
        radii.insert(id.clone(), round2(*r));
    }
    out.insert("radii", radii);
    let mut hidden = Object::new();
    for (id, count) in sorted(&layout.hidden) {
        hidden.insert(id.clone(), *count);
    }
    out.insert("hidden", hidden);
    out.insert("bounds", rect(&layout.bounds));
    out.insert(
        "components",
        Value::Array(
            layout
                .components
                .iter()
                .map(|c| {
                    let mut component = Object::new();
                    component.insert(
                        "nodes",
                        Value::Array(c.nodes.iter().map(Value::from).collect()),
                    );
                    component.insert("bounds", rect(&c.bounds));
                    Value::Object(component)
                })
                .collect(),
        ),
    );
    Value::Object(out)
}

fn fail(message: impl std::fmt::Display, details: Option<Object>) -> KgdiffError {
    let error = KgdiffError::invalid_input(format!("layoutFromJSON: {message}"));
    match details {
        Some(details) => error.with_details(details),
        None => error,
    }
}

fn details(pairs: &[(&str, Value)]) -> Option<Object> {
    let mut out = Object::new();
    for (key, value) in pairs {
        out.insert(*key, value.clone());
    }
    Some(out)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// A non-negative integer (iterations, hidden counts): TypeScript accepts any finite number
/// here, but this crate's model counts with integers.
fn count(value: Option<&Value>) -> Option<usize> {
    finite(value)
        .filter(|x| *x >= 0.0 && x.trunc() == *x && *x <= 9_007_199_254_740_991.0)
        .map(crate::options::to_count)
}

fn read_rect(value: Option<&Value>, at: &str) -> Result<Rect> {
    let object = value.and_then(Value::as_object);
    let member = |name: &str| finite(object.and_then(|o| o.get(name)));
    match (member("x"), member("y"), member("width"), member("height")) {
        (Some(x), Some(y), Some(width), Some(height)) => Ok(Rect {
            x,
            y,
            width,
            height,
        }),
        _ => Err(fail(
            format!("{at} must be a rectangle"),
            details(&[("where", Value::from(at))]),
        )),
    }
}

fn entries<'a>(value: Option<&'a Value>, at: &str) -> Result<Vec<(&'a JsStr, &'a Value)>> {
    let object = value.and_then(Value::as_object).ok_or_else(|| {
        fail(
            format!("{at} must be an object"),
            details(&[("where", Value::from(at))]),
        )
    })?;
    let mut entries: Vec<(&JsStr, &Value)> = object.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    Ok(entries)
}

pub(crate) fn from_json(value: &Value) -> Result<LayoutResult> {
    let raw = value
        .as_object()
        .filter(|o| o.get("format").and_then(Value::as_str) == Some(FORMAT))
        .ok_or_else(|| fail("not a kgdiff.layout document", None))?;
    let version = raw.get("version");
    let generator = match version.and_then(Value::as_f64) {
        Some(1.0) => None,
        Some(2.0) => Some(
            raw.get("generator")
                .and_then(Value::as_js_str)
                .filter(|g| !g.is_empty())
                .cloned()
                .ok_or_else(|| fail("generator must be a non-empty string", None))?,
        ),
        _ => {
            let shown = version.map_or_else(|| "undefined".to_owned(), Value::to_js_string);
            let mut error = KgdiffError::new(
                ErrorCode::UnsupportedVersion,
                format!("Unsupported kgdiff.layout version {shown}"),
            );
            if let Some(version) = version {
                error = error
                    .with_details(details(&[("version", version.clone())]).unwrap_or_default());
            }
            return Err(error);
        }
    };
    let strategy = raw
        .get("strategy")
        .and_then(Value::as_str)
        .and_then(LayoutStrategy::from_name)
        .ok_or_else(|| fail("strategy must be union or anchored", None))?;
    let scope = raw
        .get("scope")
        .and_then(Value::as_str)
        .and_then(LayoutScope::from_name)
        .ok_or_else(|| fail("scope must be all or changes", None))?;
    let iterations = count(raw.get("iterations"))
        .ok_or_else(|| fail("iterations must be an integer ≥ 0", None))?;

    let mut positions = IndexMap::default();
    for (id, p) in entries(raw.get("positions"), "positions")? {
        let point = p.as_array().filter(|a| a.len() == 2).and_then(|a| {
            Some(Point {
                x: finite(a.first())?,
                y: finite(a.get(1))?,
            })
        });
        let Some(point) = point else {
            return Err(fail(
                format!("positions[\"{id}\"] must be [x, y]"),
                details(&[("id", Value::from(id))]),
            ));
        };
        positions.insert(id.clone(), point);
    }
    let mut radii = IndexMap::default();
    for (id, r) in entries(raw.get("radii"), "radii")? {
        let r = finite(Some(r)).ok_or_else(|| {
            fail(
                format!("radii[\"{id}\"] must be a finite number"),
                details(&[("where", Value::from("radii")), ("id", Value::from(id))]),
            )
        })?;
        radii.insert(id.clone(), r);
    }
    let mut hidden = IndexMap::default();
    for (id, n) in entries(raw.get("hidden"), "hidden")? {
        let n = count(Some(n)).ok_or_else(|| {
            fail(
                format!("hidden[\"{id}\"] must be an integer ≥ 0"),
                details(&[("where", Value::from("hidden")), ("id", Value::from(id))]),
            )
        })?;
        hidden.insert(id.clone(), n);
    }

    let list = raw
        .get("components")
        .and_then(Value::as_array)
        .ok_or_else(|| fail("components must be an array", None))?;
    let mut components = Vec::with_capacity(list.len());
    for (k, c) in list.iter().enumerate() {
        let object = c.as_object();
        let nodes = object
            .and_then(|o| o.get("nodes"))
            .and_then(Value::as_array)
            .and_then(|nodes| {
                nodes
                    .iter()
                    .map(|id| id.as_js_str().cloned())
                    .collect::<Option<Vec<JsStr>>>()
            })
            .ok_or_else(|| {
                fail(
                    format!("components[{k}] must have a nodes array"),
                    details(&[("index", Value::from(k))]),
                )
            })?;
        let bounds = read_rect(
            object.and_then(|o| o.get("bounds")),
            &format!("components[{k}].bounds"),
        )?;
        components.push(LayoutComponent { nodes, bounds });
    }
    let bounds = read_rect(raw.get("bounds"), "bounds")?;

    let nodes = positions.len();
    Ok(LayoutResult {
        positions,
        radii,
        bounds,
        scope,
        hidden,
        components,
        stats: LayoutStats {
            strategy,
            iterations,
            nodes,
        },
        generator,
    })
}
