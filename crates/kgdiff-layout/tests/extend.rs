//! `extend_layout` (`packages/layout/test/extend.test.ts`): nothing already placed moves.

mod support;

use std::collections::BTreeSet;

use kgdiff_core::DiffResult;
use kgdiff_core::js::JsStr;
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, extend_layout, layout_diff, node_radius,
};
use support::{changes, distance, json, quality, scale_free};

const L: f64 = 56.0;

fn scoped(diff: &DiffResult) -> LayoutResult {
    let mut options = LayoutOptions::default();
    options.scope = Some(LayoutScope::Changes);
    layout_diff(diff, &options).unwrap()
}

/// The neighbours of `id` (both versions of every edge) that `layout` leaves out.
fn hidden_neighbours(diff: &DiffResult, layout: &LayoutResult, id: &str) -> Vec<JsStr> {
    diff.edges_of(id)
        .flat_map(|e| {
            [
                Some(e.source.clone()),
                Some(e.target.clone()),
                e.source_before.clone(),
                e.target_before.clone(),
            ]
        })
        .flatten()
        .filter(|v| v.as_str() != id && !layout.positions.contains_key(v.as_str()))
        .collect()
}

struct Case {
    diff: DiffResult,
    scoped: LayoutResult,
    expand_from: Vec<JsStr>,
    added: Vec<JsStr>,
    extended: LayoutResult,
}

fn case() -> Case {
    let diff = changes(17).diff();
    let scoped = scoped(&diff);
    let expand_from: Vec<JsStr> = scoped.hidden.keys().take(4).cloned().collect();
    let added: BTreeSet<JsStr> = expand_from
        .iter()
        .flat_map(|id| hidden_neighbours(&diff, &scoped, id))
        .collect();
    let added: Vec<JsStr> = added.into_iter().collect();
    let extended = extend_layout(&diff, &scoped, &added, &LayoutOptions::default()).unwrap();
    Case {
        diff,
        scoped,
        expand_from,
        added,
        extended,
    }
}

#[test]
fn adds_the_nodes_and_keeps_every_position_exactly() {
    let Case {
        scoped,
        added,
        extended,
        ..
    } = case();
    assert!(!added.is_empty());
    for (id, p) in &scoped.positions {
        let q = extended.positions[id.as_str()];
        assert_eq!(
            (q.x.to_bits(), q.y.to_bits()),
            (p.x.to_bits(), p.y.to_bits()),
            "{id}"
        );
    }
    for id in &added {
        assert!(extended.positions.contains_key(id.as_str()));
    }
    assert_eq!(
        extended.positions.len(),
        scoped.positions.len() + added.len()
    );
}

#[test]
fn places_new_nodes_among_their_neighbours_without_overlap() {
    let Case {
        diff,
        scoped,
        added,
        extended,
        ..
    } = case();
    let q = quality(&diff, &extended, 12.0);
    assert!(!q.has_nan);
    assert!(q.min_clearance >= 0.0);
    assert!(q.overlaps.is_empty(), "{:?}", q.overlaps);

    let placed_neighbours = |id: &str| -> Vec<JsStr> {
        diff.edges_of(id)
            .flat_map(|e| [e.source.clone(), e.target.clone()])
            .filter(|v| v.as_str() != id && scoped.positions.contains_key(v.as_str()))
            .collect()
    };
    let dist = |a: &str, b: &str| distance(extended.positions[a], extended.positions[b]);
    let reach = |v: &str| {
        placed_neighbours(v)
            .iter()
            .map(|u| dist(u, v))
            .fold(0.0, |a, b| if b > a { b } else { a })
    };
    for id in &added {
        let placed = placed_neighbours(id);
        assert!(!placed.is_empty());
        let p = extended.positions[id.as_str()];
        let xs: Vec<f64> = placed
            .iter()
            .map(|v| extended.positions[v.as_str()].x)
            .collect();
        let ys: Vec<f64> = placed
            .iter()
            .map(|v| extended.positions[v.as_str()].y)
            .collect();
        let lo = |v: &[f64]| {
            v.iter()
                .copied()
                .fold(f64::INFINITY, |a, b| if b < a { b } else { a })
        };
        let hi = |v: &[f64]| {
            v.iter()
                .copied()
                .fold(f64::NEG_INFINITY, |a, b| if b > a { b } else { a })
        };
        let between = p.x > lo(&xs) - 3.5 * L
            && p.x < hi(&xs) + 3.5 * L
            && p.y > lo(&ys) - 3.5 * L
            && p.y < hi(&ys) + 3.5 * L;
        let near = placed.iter().any(|v| {
            let limit = reach(v) + L;
            dist(id, v) <= if 6.0 * L > limit { 6.0 * L } else { limit }
        });
        assert!(between || near, "{id} is far from its neighbours");
    }
}

#[test]
fn recounts_hidden_neighbours_and_adds_radii() {
    let Case {
        diff,
        scoped,
        expand_from,
        added,
        extended,
    } = case();
    for id in &expand_from {
        let after = extended.hidden.get(id.as_str()).copied().unwrap_or(0);
        assert!(after < scoped.hidden[id.as_str()], "{id}");
    }
    for id in &added {
        let node = diff.node(id).unwrap();
        let degree = node.degree.before.max(node.degree.after) as f64;
        assert_eq!(extended.radii[id.as_str()], node_radius(degree));
    }
    assert_eq!(extended.scope, LayoutScope::Changes);
    assert_eq!(extended.stats.strategy, scoped.stats.strategy);
    assert_eq!(extended.stats.iterations, scoped.stats.iterations);
}

#[test]
fn is_deterministic_in_any_order() {
    let Case {
        diff,
        scoped,
        added,
        extended,
        ..
    } = case();
    let mut reversed = added.clone();
    reversed.reverse();
    let again = extend_layout(&diff, &scoped, &reversed, &LayoutOptions::default()).unwrap();
    assert_eq!(json(&again), json(&extended));
}

#[test]
fn returns_the_layout_unchanged_when_everything_is_placed() {
    let Case { diff, scoped, .. } = case();
    let placed: Vec<JsStr> = scoped.positions.keys().take(3).cloned().collect();
    let same = extend_layout(&diff, &scoped, &placed, &LayoutOptions::default()).unwrap();
    assert_eq!(same, scoped);
}

#[test]
fn rejects_ids_that_are_not_in_the_diff() {
    let Case { diff, scoped, .. } = case();
    let error = extend_layout(
        &diff,
        &scoped,
        &[JsStr::from("nope")],
        &LayoutOptions::default(),
    )
    .unwrap_err();
    assert_eq!(error.code.as_str(), "invalid-input");
    assert_eq!(
        error.message,
        "extendLayout: node \"nope\" is not in the diff"
    );
}

#[test]
fn packs_nodes_without_a_placed_neighbour_beside_the_bounds() {
    let Case { diff, scoped, .. } = case();
    let target = diff
        .nodes
        .iter()
        .find(|n| {
            !scoped.positions.contains_key(n.id.as_str()) && diff.edges_of(&n.id).next().is_none()
        })
        .or_else(|| {
            diff.nodes.iter().rev().find(|n| {
                !scoped.positions.contains_key(n.id.as_str())
                    && !hidden_neighbours(&diff, &scoped, &n.id).is_empty()
            })
        })
        .expect("a node outside the layout");
    let result = extend_layout(
        &diff,
        &scoped,
        std::slice::from_ref(&target.id),
        &LayoutOptions::default(),
    )
    .unwrap();
    assert!(quality(&diff, &result, 12.0).overlaps.is_empty());
}

#[test]
fn extends_an_empty_layout_with_finite_positions() {
    // TypeScript packs the new block by the bounds of nothing (infinities); here it stays put.
    let diff = changes(17).diff();
    let mut options = LayoutOptions::default();
    options.scope = Some(LayoutScope::Changes);
    options.large_graph_threshold = Some(0.0);
    options.context_hops = Some(0);
    let none = layout_diff(
        &support::tree(10, 7, support::english_label).diff(),
        &options,
    )
    .unwrap();
    assert!(none.positions.is_empty());
    let ids: Vec<JsStr> = diff.nodes.iter().take(5).map(|n| n.id.clone()).collect();
    let grown = extend_layout(&diff, &none, &ids, &LayoutOptions::default()).unwrap();
    assert_eq!(grown.positions.len(), 5);
    assert!(
        grown
            .positions
            .values()
            .all(|p| p.x.is_finite() && p.y.is_finite())
    );
}

#[test]
fn re_adds_nodes_to_a_large_layout_without_moving_the_placed_ones() {
    let big = scale_free(1500, 1.3, 11).diff();
    let all = layout_diff(&big, &LayoutOptions::default()).unwrap();
    let removed: Vec<JsStr> = ["s0100", "s0200", "s0300", "s0400", "s0500"]
        .map(JsStr::from)
        .into();
    let mut partial = all.clone();
    partial.positions.retain(|id, _| !removed.contains(id));
    let back = extend_layout(&big, &partial, &removed, &LayoutOptions::default()).unwrap();
    for (id, p) in &partial.positions {
        assert_eq!(back.positions[id.as_str()], *p);
    }
    // Only pairs among already placed nodes may overlap; the re-added nodes are clear.
    for (a, b) in quality(&big, &back, 12.0).overlaps {
        let re_added = |id: &str| removed.iter().any(|r| r.as_str() == id);
        assert!(!re_added(&a) && !re_added(&b), "{a} / {b}");
    }
}
