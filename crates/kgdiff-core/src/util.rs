//! Small helpers shared by every module of the engine (`util.ts`).

use crate::js::{self, JsStr};

/// Sorted (UTF-16 order), de-duplicated copy without empty strings (`sortedUnique`).
pub fn sorted_unique(values: &[JsStr]) -> Vec<JsStr> {
    let mut out: Vec<JsStr> = values.iter().filter(|v| !v.is_empty()).cloned().collect();
    out.sort();
    out.dedup();
    out
}

/// Rounds a score to 1e-6, the precision of every score that leaves the engine (`round6`).
pub fn round6(value: f64) -> f64 {
    js::math::round(value * 1e6) / 1e6
}

/// Clamps to [0, 1]; NaN becomes 0 (`clamp01`).
pub fn clamp01(value: f64) -> f64 {
    if value > 0.0 {
        js::math::min(value, 1.0)
    } else {
        0.0
    }
}

/// `{ added: b \ a, removed: a \ b }` of two sorted, unique lists (`sortedSetDiff`).
pub fn sorted_set_diff(a: &[JsStr], b: &[JsStr]) -> (Vec<JsStr>, Vec<JsStr>) {
    let (mut added, mut removed) = (Vec::new(), Vec::new());
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        match (a.get(i), b.get(j)) {
            (Some(x), Some(y)) if x < y => {
                removed.push(x.clone());
                i += 1;
            }
            (Some(x), None) => {
                removed.push(x.clone());
                i += 1;
            }
            (Some(x), Some(y)) if y < x => {
                added.push(y.clone());
                j += 1;
            }
            (None, Some(y)) => {
                added.push(y.clone());
                j += 1;
            }
            _ => {
                i += 1;
                j += 1;
            }
        }
    }
    (added, removed)
}
