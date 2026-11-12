//! The properties of RFC 0002, phase 4, for every corpus case and for synthetic graphs up to 10k
//! nodes: every node in scope has a finite position rounded to 0.01 (known positions of
//! anchored layouts excepted, they are kept as given); no two node or label boxes overlap;
//! anchored layouts keep known positions bit for bit; `extend_layout` moves no placed node; and
//! shuffled input gives identical bytes.
//!
//! The synthetic graphs run in release builds (`cargo test --release`, as the `targets` CI job
//! does on every platform).

mod support;

use std::path::{Path, PathBuf};

use kgdiff_core::DiffResult;
use kgdiff_core::js::{JsStr, Object, Value, json};
use kgdiff_core::model::Point;
use kgdiff_core::resolve_options;
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, LayoutStrategy, extend_layout, layout_diff,
};
use support::{Rng, english_label, quality, scale_free, tree};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn read(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    json::parse(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A corpus case: its two graphs (`expected/parse.*.json`), diff options and layout options.
struct Case {
    id: String,
    before: Value,
    after: Value,
    options: Value,
    layout: LayoutOptions,
}

fn cases() -> Vec<Case> {
    let manifest = read(&corpus().join("manifest.json"));
    manifest
        .get("cases")
        .and_then(Value::as_array)
        .expect("cases")
        .iter()
        .map(|entry| {
            let id = entry.get("id").and_then(Value::as_str).unwrap().to_owned();
            let dir = corpus().join("cases").join(&id);
            let spec = read(&dir.join("case.json"));
            let graph = |side: &str| {
                read(&dir.join(format!("expected/parse.{side}.json")))
                    .get("graph")
                    .cloned()
                    .unwrap()
            };
            let empty = || Value::Object(Object::new());
            let layout = LayoutOptions::from_value(
                &spec.get("layoutOptions").cloned().unwrap_or_else(empty),
            )
            .unwrap();
            Case {
                before: graph("before"),
                after: graph("after"),
                options: spec.get("options").cloned().unwrap_or_else(empty),
                layout,
                id,
            }
        })
        .collect()
}

fn diff(case: &Case, before: &Value, after: &Value) -> DiffResult {
    let options = resolve_options(Some(&case.options)).unwrap();
    kgdiff_core::diff(before, after, &options).unwrap()
}

fn is_hundredth(v: f64) -> bool {
    kgdiff_core::js::math::round(v * 100.0) / 100.0 == v
}

fn same(a: Point, b: Point) -> bool {
    a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits()
}

/// The positions the diff's graphs carry (what an anchored layout keeps).
fn known(diff: &DiffResult) -> Vec<(JsStr, Point)> {
    diff.nodes
        .iter()
        .filter_map(|n| {
            let p = n
                .before
                .as_ref()
                .and_then(|b| b.position())
                .or_else(|| n.after.as_ref().and_then(|a| a.position()))?;
            (p.x.is_finite() && p.y.is_finite()).then(|| (n.id.clone(), p))
        })
        .collect()
}

/// Finite, rounded positions (but for the known ones) and no overlapping boxes.
fn check_layout(what: &str, diff: &DiffResult, layout: &LayoutResult, max_overlap: f64) {
    let known = known(diff);
    let anchored = layout.stats.strategy == LayoutStrategy::Anchored;
    for (id, p) in &layout.positions {
        assert!(p.x.is_finite() && p.y.is_finite(), "{what}: {id} at {p:?}");
        let is_known = anchored && known.iter().any(|(k, _)| k == id);
        if !is_known {
            assert!(
                is_hundredth(p.x) && is_hundredth(p.y),
                "{what}: {id} at {p:?}"
            );
        }
    }
    let q = quality(diff, layout, 12.0);
    if max_overlap == 0.0 {
        assert!(
            q.overlaps.is_empty(),
            "{what}: overlapping boxes {:?}",
            q.overlaps
        );
    } else {
        assert!(
            q.label_overlap_ratio < max_overlap,
            "{what}: overlap ratio {}",
            q.label_overlap_ratio
        );
    }
}

/// Pins every other node of `base` at a position off the 0.01 grid, lays out again and checks
/// that each pin is kept bit for bit.
fn check_pins(what: &str, diff: &DiffResult, base: &LayoutResult, options: &LayoutOptions) {
    let mut pinned = kgdiff_core::js::IndexMap::default();
    for (k, (id, p)) in base.positions.iter().enumerate() {
        if k % 2 == 0 {
            pinned.insert(
                id.clone(),
                Point {
                    x: p.x + 0.003_1,
                    y: p.y - 1.0 / 3.0,
                },
            );
        }
    }
    let options = {
        let mut o = options.clone();
        o.pinned = pinned.clone();
        o
    };
    let layout = layout_diff(diff, &options).unwrap();
    if pinned.is_empty() {
        return;
    }
    assert_eq!(layout.stats.strategy, LayoutStrategy::Anchored, "{what}");
    for (id, p) in &pinned {
        assert!(
            same(layout.positions[id.as_str()], *p),
            "{what}: pin {id} moved"
        );
    }
    for p in layout.positions.values() {
        assert!(p.x.is_finite() && p.y.is_finite(), "{what}");
    }
}

/// Drops every third node of `base`, extends the rest by them and checks that nothing placed
/// moved; then the same from a changes-only layout, expanding its hidden neighbours.
fn check_extend(what: &str, diff: &DiffResult, base: &LayoutResult) {
    let dropped: Vec<JsStr> = base
        .positions
        .keys()
        .enumerate()
        .filter(|(k, _)| k % 3 == 1)
        .map(|(_, id)| id.clone())
        .collect();
    let mut partial = base.clone();
    partial.positions.retain(|id, _| !dropped.contains(id));
    let back = extend_layout(diff, &partial, &dropped, &LayoutOptions::default()).unwrap();
    for (id, p) in &partial.positions {
        assert!(
            same(back.positions[id.as_str()], *p),
            "{what}: extend moved {id}"
        );
    }
    assert_eq!(back.positions.len(), base.positions.len(), "{what}");
    for p in back.positions.values() {
        assert!(p.x.is_finite() && p.y.is_finite(), "{what}");
    }

    let mut changes = LayoutOptions::default();
    changes.scope = Some(LayoutScope::Changes);
    let focused = layout_diff(diff, &changes).unwrap();
    let mut expand: Vec<JsStr> = Vec::new();
    for id in focused.hidden.keys() {
        for e in diff.edges_of(id) {
            for v in [&e.source, &e.target] {
                if !focused.positions.contains_key(v.as_str()) && !expand.contains(v) {
                    expand.push(v.clone());
                }
            }
        }
    }
    let grown = extend_layout(diff, &focused, &expand, &LayoutOptions::default()).unwrap();
    for (id, p) in &focused.positions {
        assert!(
            same(grown.positions[id.as_str()], *p),
            "{what}: expanding moved {id}"
        );
    }
}

/// `graph` with its node and edge arrays in a seeded random order (Fisher–Yates).
fn shuffled(graph: &Value, seed: u32) -> Value {
    let mut random = Rng::new(seed);
    let mut out = graph.as_object().unwrap().clone();
    for key in ["nodes", "edges"] {
        let Some(items) = out.get(key).and_then(Value::as_array) else {
            continue;
        };
        let mut items = items.to_vec();
        for i in (1..items.len()).rev() {
            items.swap(i, random.below(i + 1));
        }
        out.insert(key, Value::Array(items));
    }
    Value::Object(out)
}

fn text(layout: &LayoutResult) -> String {
    support::json(layout)
}

#[test]
fn every_corpus_case() {
    let cases = cases();
    // Written out, not read from the manifest: a corpus that loses cases must fail here.
    assert_eq!(cases.len(), 30);
    for case in &cases {
        let what = case.id.as_str();
        let result = diff(case, &case.before, &case.after);
        let layout = layout_diff(&result, &case.layout).unwrap();
        check_layout(what, &result, &layout, 0.0);

        // Known positions of anchored layouts are kept bit for bit.
        if layout.stats.strategy == LayoutStrategy::Anchored {
            for (id, p) in known(&result) {
                assert!(same(layout.positions[id.as_str()], p), "{what}: {id} moved");
            }
        }
        check_pins(what, &result, &layout, &case.layout);
        check_extend(what, &result, &layout);

        let reference = text(&layout);
        for seed in [1, 2] {
            let again = diff(
                case,
                &shuffled(&case.before, seed),
                &shuffled(&case.after, seed + 10),
            );
            assert_eq!(
                text(&layout_diff(&again, &case.layout).unwrap()),
                reference,
                "{what}: shuffled"
            );
        }
    }
}

/// A minute in a debug build: the `targets` CI job runs it with `cargo test --release`.
#[test]
#[cfg_attr(debug_assertions, ignore = "slow in debug builds: run with --release")]
fn synthetic_graphs_up_to_10k_nodes() {
    let graphs = [
        ("tree 1k", tree(1000, 7, english_label), 0.0),
        ("scale-free 2k", scale_free(2000, 1.3, 11), 0.0),
        ("scale-free 5k", scale_free(5000, 1.3, 11), 0.001),
        ("dense scale-free 10k", scale_free(10_000, 2.0, 11), 0.001),
    ];
    for (what, spec, max_overlap) in graphs {
        let result = spec.diff();
        let mut options = LayoutOptions::default();
        options.scope = Some(LayoutScope::All);
        let layout = layout_diff(&result, &options).unwrap();
        check_layout(what, &result, &layout, max_overlap);
        check_pins(what, &result, &layout, &options);
        check_extend(what, &result, &layout);
        let again = support::shuffled(&spec, 3).diff();
        assert_eq!(
            text(&layout_diff(&again, &options).unwrap()),
            text(&layout),
            "{what}: shuffled"
        );
    }
}
