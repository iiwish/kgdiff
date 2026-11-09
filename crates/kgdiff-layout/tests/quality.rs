//! Layout quality as regression guards (`packages/layout/test/quality.test.ts`,
//! `integration.test.ts`, `perf.test.ts`). The thresholds are TypeScript's.

mod support;

use kgdiff_core::DiffResult;
use kgdiff_core::js::{JsStr, Object, Value};
use kgdiff_core::model::NodeFacet;
use kgdiff_layout::{LayoutOptions, LayoutScope, LayoutStrategy, extend_layout, layout_diff};
use support::{
    Quality, Rng, changes, cjk, components, distance, english_label, expect_readable, json,
    quality, scale_free, star, tree,
};

const L: f64 = 56.0;

fn measure(name: &str, diff: &DiffResult, options: &LayoutOptions) -> Quality {
    let layout = layout_diff(diff, options).unwrap();
    let q = quality(diff, &layout, 12.0);
    println!(
        "{name:24} n={:5} clearance={:.2} overlap={:.5} ({} pairs) edge={:.2}L median={:.2}L aspect={:.2} partners={:?}",
        q.nodes,
        q.min_clearance,
        q.label_overlap_ratio,
        q.overlaps.len(),
        q.mean_edge_length / L,
        q.median_edge_length / L,
        q.aspect,
        q.partner_ratios
    );
    q
}

fn plain() -> LayoutOptions {
    LayoutOptions::default()
}

fn without_labels() -> LayoutOptions {
    LayoutOptions {
        label_aware: Some(false),
        ..LayoutOptions::default()
    }
}

fn within(value: f64, lo: f64, hi: f64) {
    assert!((lo..=hi).contains(&value), "{value} not in [{lo}, {hi}]");
}

#[test]
fn tree_of_150() {
    let q = measure("tree", &tree(150, 7, english_label).diff(), &plain());
    expect_readable(&q);
    within(q.mean_edge_length / L, 0.6, 2.2);
}

#[test]
fn scale_free_500() {
    let diff = scale_free(500, 1.3, 11).diff();
    let q = measure("scale-free", &diff, &plain());
    expect_readable(&q);
    // Hubs carry the spec charge and weak links, so hub-to-hub edges stretch well beyond L.
    within(q.mean_edge_length / L, 0.6, 6.0);
    let bare = measure("scale-free (no labels)", &diff, &without_labels());
    assert!(bare.mean_edge_length < q.mean_edge_length);
}

#[test]
fn many_components_and_isolated_nodes() {
    let q = measure("components", &components(30, 40, 3).diff(), &plain());
    expect_readable(&q);
    within(q.mean_edge_length / L, 0.6, 2.2);
    // Packed towards a 16:10 picture.
    within(q.aspect, 1.2, 2.2);
}

#[test]
fn star_of_60_labelled_leaves() {
    let diff = star(60).diff();
    let q = measure("star", &diff, &plain());
    expect_readable(&q);
    assert!(q.mean_edge_length / L <= 4.5);
    let bare = measure("star (no labels)", &diff, &without_labels());
    assert!(!bare.has_nan && bare.min_clearance >= 0.0);
    within(bare.mean_edge_length / L, 0.6, 2.2);
}

#[test]
fn a_dense_graph_makes_room_for_its_labels() {
    expect_readable(&measure(
        "dense sf",
        &scale_free(500, 2.0, 11).diff(),
        &plain(),
    ));
}

#[test]
fn a_hub_with_300_leaves_spreads_them() {
    expect_readable(&measure("star-300", &star(300).diff(), &plain()));
}

#[test]
fn cjk_labels() {
    let q = measure("cjk", &cjk(90, 13).diff(), &plain());
    expect_readable(&q);
    within(q.median_edge_length / L, 0.6, 2.2);
    assert!(q.mean_edge_length / L <= 2.6);
}

fn partner_distances(
    diff: &DiffResult,
    layout: &kgdiff_layout::LayoutResult,
) -> (Vec<f64>, Vec<f64>) {
    let (mut merges, mut splits) = (Vec::new(), Vec::new());
    for node in &diff.nodes {
        for facet in &node.facets {
            let (list, partner) = match facet {
                NodeFacet::MergedInto { target, .. } => (&mut merges, target),
                NodeFacet::SplitFrom { source, .. } => (&mut splits, source),
                _ => continue,
            };
            list.push(distance(
                layout.positions[node.id.as_str()],
                layout.positions[partner.as_str()],
            ));
        }
    }
    (merges, splits)
}

#[test]
fn merges_stay_next_to_their_target() {
    for seed in [0, 1, 2, 3, 4, 5] {
        let diff = changes(17 + seed).diff();
        let options = LayoutOptions {
            seed: (seed > 0).then_some(f64::from(seed)),
            ..LayoutOptions::default()
        };
        let layout = layout_diff(&diff, &options).unwrap();
        let q = quality(&diff, &layout, 12.0);
        expect_readable(&q);
        if seed == 0 {
            within(q.mean_edge_length / L, 0.6, 2.2);
        }
        let (merges, splits) = partner_distances(&diff, &layout);
        assert_eq!(merges.len(), 2, "seed {seed}");
        assert_eq!(splits.len(), 2, "seed {seed}");
        for d in merges {
            assert!(d < q.median_edge_length, "seed {seed}: merge {d}");
        }
        // Two targets compete for the spots next to one source: allow a little more.
        for d in splits {
            assert!(d < 5.0 * q.median_edge_length, "seed {seed}: split {d}");
        }
    }
}

// ─── With the real diff engine (integration.test.ts) ────────────────────────────────────────

/// A 300-class ontology and its next release: renames, removals, additions, moves, merges.
#[allow(
    clippy::needless_range_loop,
    reason = "index loops, as integration.test.ts"
)]
fn ontology(seed: u32) -> (Value, Value) {
    let mut random = Rng::new(seed);
    let id = |i: usize| format!("C:{i:04}");
    let n = 300;
    let labels: Vec<String> = (0..n).map(|_| english_label(&mut random)).collect();
    let parent: Vec<Option<usize>> = (0..n).map(|i| (i > 0).then(|| random.below(i))).collect();
    let node = |id: String, label: &str, replaces: &[String]| {
        let mut out = Object::new();
        out.insert("id", id);
        out.insert("label", label);
        if !replaces.is_empty() {
            out.insert(
                "replaces",
                Value::Array(replaces.iter().map(|r| Value::from(r.as_str())).collect()),
            );
        }
        Value::Object(out)
    };
    let is_a = |child: &str, p: &str| {
        let mut out = Object::new();
        out.insert("source", child);
        out.insert("target", p);
        out.insert("predicate", "is_a");
        Value::Object(out)
    };
    let before_nodes: Vec<Value> = (0..n).map(|i| node(id(i), &labels[i], &[])).collect();
    let before_edges: Vec<Value> = (0..n)
        .filter_map(|i| parent[i].map(|p| is_a(&id(i), &id(p))))
        .collect();

    let mut leaves: Vec<usize> = (0..n).filter(|i| !parent.contains(&Some(*i))).collect();
    leaves.sort();
    let removed = &leaves[0..5];
    let merged: Vec<(usize, usize)> = (0..3).map(|k| (leaves[5 + k], leaves[20 + k])).collect();
    let moved: Vec<(usize, usize)> = (0..5).map(|k| (leaves[30 + k], 1 + k)).collect();
    let renamed = [3, 17, 42, 99, 150];

    let mut after_nodes = Vec::new();
    for i in 0..n {
        if removed.contains(&i) || merged.iter().any(|&(from, _)| from == i) {
            continue;
        }
        let replaces: Vec<String> = merged
            .iter()
            .filter(|&&(_, into)| into == i)
            .map(|&(from, _)| id(from))
            .collect();
        let label = if renamed.contains(&i) {
            format!("{} (v2)", labels[i])
        } else {
            labels[i].clone()
        };
        after_nodes.push(node(id(i), &label, &replaces));
    }
    let mut after_edges = Vec::new();
    for i in 1..n {
        if removed.contains(&i) || merged.iter().any(|&(from, _)| from == i) {
            continue;
        }
        let p = moved
            .iter()
            .find(|&&(leaf, _)| leaf == i)
            .map_or(parent[i].unwrap(), |&(_, to)| to);
        after_edges.push(is_a(&id(i), &id(p)));
    }
    for k in 0..10 {
        let new_id = format!("N:{k}");
        after_nodes.push(node(new_id.clone(), &english_label(&mut random), &[]));
        after_edges.push(is_a(&new_id, &id(random.below(60))));
    }
    let graph = |nodes: Vec<Value>, edges: Vec<Value>| {
        let mut out = Object::new();
        out.insert("nodes", Value::Array(nodes));
        out.insert("edges", Value::Array(edges));
        Value::Object(out)
    };
    (
        graph(before_nodes, before_edges),
        graph(after_nodes, after_edges),
    )
}

fn diff(before: &Value, after: &Value) -> DiffResult {
    kgdiff_core::diff(before, after, &kgdiff_core::DiffOptions::default()).unwrap()
}

/// `graph` with its node and edge arrays in a seeded random order.
fn shuffle_graph(graph: &Value, random: &mut Rng) -> Value {
    let mut out = graph.as_object().unwrap().clone();
    for key in ["nodes", "edges"] {
        let mut keyed: Vec<(f64, Value)> = out
            .get(key)
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .map(|v| (random.next(), v.clone()))
            .collect();
        keyed.sort_by(|a, b| a.0.total_cmp(&b.0));
        out.insert(
            key,
            Value::Array(keyed.into_iter().map(|(_, v)| v).collect()),
        );
    }
    Value::Object(out)
}

#[test]
fn lays_out_a_real_diff_readably() {
    let (before, after) = ontology(21);
    let result = diff(&before, &after);
    let layout = layout_diff(&result, &plain()).unwrap();
    assert_eq!(layout.positions.len(), result.nodes.len());
    let q = quality(&result, &layout, 12.0);
    assert!(!q.has_nan);
    assert!(q.min_clearance >= 0.0);
    assert!(q.overlaps.is_empty(), "{:?}", q.overlaps);
    assert!(q.mean_edge_length / L <= 2.2);
    assert_eq!(q.partner_ratios.len(), 3);
    for ratio in &q.partner_ratios {
        assert!(*ratio < 1.0, "{ratio}");
    }

    // Identical for shuffled inputs.
    let mut random = Rng::new(5);
    let again = diff(
        &shuffle_graph(&before, &mut random),
        &shuffle_graph(&after, &mut random),
    );
    assert_eq!(json(&layout_diff(&again, &plain()).unwrap()), json(&layout));
}

#[test]
fn keeps_the_previous_picture_when_the_before_graph_has_positions() {
    let (before, after) = ontology(21);
    let previous = layout_diff(&diff(&before, &before), &plain()).unwrap();
    let mut positioned = before.as_object().unwrap().clone();
    let nodes: Vec<Value> = before
        .get("nodes")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|node| {
            let mut node = node.as_object().unwrap().clone();
            let p = previous.positions[node.get("id").unwrap().as_str().unwrap()];
            let mut point = Object::new();
            point.insert("x", p.x);
            point.insert("y", p.y);
            node.insert("position", point);
            Value::Object(node)
        })
        .collect();
    positioned.insert("nodes", Value::Array(nodes));
    let result = diff(&Value::Object(positioned), &after);
    let anchored = layout_diff(&result, &plain()).unwrap();
    assert_eq!(anchored.stats.strategy, LayoutStrategy::Anchored);
    for (id, p) in &previous.positions {
        assert_eq!(anchored.positions[id.as_str()], *p);
    }
    // Known nodes keep their place even where a rename now needs a second label line; every
    // node the layout placed itself is clear of everything.
    for (a, b) in quality(&result, &anchored, 12.0).overlaps {
        assert!(
            previous.positions.contains_key(a.as_str())
                && previous.positions.contains_key(b.as_str())
        );
    }
}

#[test]
fn focuses_on_changes_and_expands_them_without_moving_anything() {
    let (before, after) = ontology(21);
    let result = diff(&before, &after);
    let options = LayoutOptions {
        scope: Some(LayoutScope::Changes),
        ..LayoutOptions::default()
    };
    let focused = layout_diff(&result, &options).unwrap();
    assert!(focused.positions.len() < result.nodes.len());
    for hunk in &result.hunks {
        for id in hunk.nodes.iter().chain(&hunk.context) {
            assert!(focused.positions.contains_key(id.as_str()), "{id}");
        }
    }
    let first = focused.hidden.keys().next().unwrap().clone();
    let expand: Vec<JsStr> = result
        .edges_of(&first)
        .flat_map(|e| [e.source.clone(), e.target.clone()])
        .filter(|v| !focused.positions.contains_key(v.as_str()))
        .collect();
    let expanded = extend_layout(&result, &focused, &expand, &plain()).unwrap();
    for (id, p) in &focused.positions {
        assert_eq!(expanded.positions[id.as_str()], *p);
    }
    assert_eq!(expanded.hidden.get(first.as_str()).copied().unwrap_or(0), 0);
}

// ─── Large graphs (perf.test.ts) ───────────────────────────────────────────────────────────

#[test]
fn a_2k_hierarchy_without_overlapping_nodes() {
    let q = measure("tree 2k", &tree(2000, 7, english_label).diff(), &plain());
    assert!(q.overlaps.is_empty(), "{} pairs", q.overlaps.len());
}

#[test]
fn a_2k_scale_free_graph_with_almost_no_overlapping_labels() {
    let q = measure("scale-free 2k", &scale_free(2000, 1.3, 11).diff(), &plain());
    assert!(q.label_overlap_ratio < 0.001);
    assert!(!q.has_nan);
}

#[test]
fn a_5k_graph_in_48_ticks_deterministically() {
    let diff = scale_free(5000, 1.3, 11).diff();
    let options = LayoutOptions {
        scope: Some(LayoutScope::All),
        ..LayoutOptions::default()
    };
    let layout = layout_diff(&diff, &options).unwrap();
    assert_eq!(layout.stats.iterations, 48);
    assert_eq!(json(&layout_diff(&diff, &options).unwrap()), json(&layout));
    assert!(quality(&diff, &layout, 12.0).label_overlap_ratio < 0.001);
}

#[test]
fn a_dense_10k_graph_in_30_ticks() {
    let diff = scale_free(10_000, 2.0, 11).diff();
    let options = LayoutOptions {
        scope: Some(LayoutScope::All),
        ..LayoutOptions::default()
    };
    let layout = layout_diff(&diff, &options).unwrap();
    assert_eq!(layout.stats.iterations, 30);
    let q = quality(&diff, &layout, 12.0);
    assert!(!q.has_nan);
    assert!(q.label_overlap_ratio < 0.001, "{}", q.label_overlap_ratio);
}
