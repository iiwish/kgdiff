//! `layout_diff`: basics, determinism and options (`packages/layout/test/layout.test.ts`).

mod support;

use kgdiff_core::model::Point;
use kgdiff_layout::{
    LayoutOptions, LayoutStrategy, Rect, estimate_label_width, layout_diff, layout_to_json,
    node_radius,
};
use support::{
    EdgeSpec, GraphSpec, LABEL_GAP, NodeSpec, changes, components, english_label, json,
    label_before, label_box, shuffled, tree,
};

fn default() -> LayoutOptions {
    LayoutOptions::default()
}

fn is_hundredth(v: f64) -> bool {
    kgdiff_core::js::math::round(v * 100.0) / 100.0 == v
}

#[test]
fn returns_an_empty_layout_for_an_empty_diff() {
    let layout = layout_diff(&GraphSpec::default().diff(), &default()).unwrap();
    assert!(layout.positions.is_empty());
    assert!(layout.components.is_empty());
    assert_eq!(layout.bounds, Rect::ZERO);
    assert_eq!(layout.stats.strategy, LayoutStrategy::Union);
    assert_eq!((layout.stats.iterations, layout.stats.nodes), (0, 0));
}

#[test]
fn places_a_single_node_at_the_origin_with_its_label_below() {
    let spec = GraphSpec {
        nodes: vec![NodeSpec::new("only", "Only")],
        edges: vec![],
    };
    let layout = layout_diff(&spec.diff(), &default()).unwrap();
    let p = layout.positions["only"];
    assert_eq!(layout.radii["only"], node_radius(0.0));
    let b = layout.bounds;
    assert!((b.x + b.width / 2.0).abs() < 0.05);
    assert!((b.y + b.height / 2.0).abs() < 0.05);
    assert!(p.y < 0.0);
    assert_eq!(layout.components.len(), 1);
}

#[test]
fn handles_self_loops_parallel_edges_cycles_and_special_ids() {
    let ids = [
        "a|b",
        "say \"hi\"",
        "with space",
        "http://x.org/onto#C",
        "__proto__",
        "42",
    ];
    let mut spec = GraphSpec {
        nodes: ids.iter().map(|id| NodeSpec::new(id, id)).collect(),
        edges: vec![
            EdgeSpec::new("a|b", "a|b"),
            EdgeSpec::new("a|b", "say \"hi\""),
            EdgeSpec::new("say \"hi\"", "with space"),
            EdgeSpec::new("with space", "a|b"),
            EdgeSpec::new("__proto__", "42"),
        ],
    };
    spec.edges.push(EdgeSpec {
        predicate: "other".to_owned(),
        ..EdgeSpec::new("say \"hi\"", "a|b")
    });
    let layout = layout_diff(&spec.diff(), &default()).unwrap();
    assert_eq!(layout.positions.len(), ids.len());
    assert!(
        layout
            .positions
            .values()
            .all(|p| p.x.is_finite() && p.y.is_finite())
    );
    let document = layout_to_json(&layout);
    let positions = document.get("positions").unwrap().as_object().unwrap();
    assert!(positions.contains_key("__proto__"));
    // Array-index ids first, as JavaScript writes them.
    assert_eq!(positions.keys().next().unwrap().as_str(), "42");
}

#[test]
fn gives_every_node_the_radius_of_its_max_degree() {
    let diff = changes(17).diff();
    let layout = layout_diff(&diff, &default()).unwrap();
    for node in &diff.nodes {
        let degree = node.degree.before.max(node.degree.after) as f64;
        assert_eq!(layout.radii[node.id.as_str()], node_radius(degree));
    }
}

#[test]
fn rounds_computed_coordinates_to_hundredths() {
    let layout = layout_diff(&tree(40, 7, english_label).diff(), &default()).unwrap();
    for p in layout.positions.values() {
        assert!(is_hundredth(p.x) && is_hundredth(p.y), "{p:?}");
    }
}

#[test]
fn reports_bounds_that_contain_every_box_centered_on_the_origin() {
    let diff = changes(17).diff();
    let layout = layout_diff(&diff, &default()).unwrap();
    let b = layout.bounds;
    for node in &diff.nodes {
        let p = layout.positions[node.id.as_str()];
        let r = layout.radii[node.id.as_str()];
        let (width, height) =
            label_box(&node.label, label_before(&diff, &node.id).as_deref(), 12.0);
        let half = if r > width / 2.0 { r } else { width / 2.0 };
        assert!(p.x - half >= b.x - 1e-9);
        assert!(p.x + half <= b.x + b.width + 1e-9);
        assert!(p.y - r >= b.y - 1e-9);
        assert!(p.y + r + LABEL_GAP + height <= b.y + b.height + 1e-9);
    }
    assert!((b.x + b.width / 2.0).abs() < 0.05);
    assert!((b.y + b.height / 2.0).abs() < 0.05);
}

#[test]
fn lists_components_largest_first_each_node_once() {
    let diff = components(30, 40, 3).diff();
    let layout = layout_diff(&diff, &default()).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    let mut previous = usize::MAX;
    for component in &layout.components {
        assert!(component.nodes.len() <= previous);
        previous = component.nodes.len();
        for id in &component.nodes {
            assert!(seen.insert(id.clone()), "{id} twice");
        }
        let mut sorted = component.nodes.clone();
        sorted.sort();
        assert_eq!(component.nodes, sorted);
    }
    assert_eq!(seen.len(), diff.nodes.len());
}

#[test]
fn is_byte_identical_for_the_same_input_and_seed() {
    let options = LayoutOptions {
        seed: Some(7.0),
        ..default()
    };
    let a = layout_diff(&changes(17).diff(), &options).unwrap();
    let b = layout_diff(&changes(17).diff(), &options).unwrap();
    assert_eq!(json(&a), json(&b));
}

#[test]
fn differs_for_another_seed() {
    let diff = changes(17).diff();
    let seed = |s: f64| LayoutOptions {
        seed: Some(s),
        ..default()
    };
    assert_ne!(
        json(&layout_diff(&diff, &seed(1.0)).unwrap()),
        json(&layout_diff(&diff, &seed(2.0)).unwrap())
    );
}

#[test]
fn does_not_depend_on_input_order() {
    let spec = changes(17);
    let reference = json(&layout_diff(&spec.diff(), &default()).unwrap());
    for seed in [1, 2, 3] {
        let again = layout_diff(&shuffled(&spec, seed).diff(), &default()).unwrap();
        assert_eq!(json(&again), reference);
    }
    // Union nodes and edges in reverse order (not sorted by id) are sorted by the layout.
    let diff = components(8, 5, 3).diff();
    let mut nodes = diff.nodes.clone();
    let mut edges = diff.edges.clone();
    nodes.reverse();
    edges.reverse();
    let reversed = kgdiff_layout::LayoutInput {
        nodes: &nodes,
        edges: &edges,
    };
    assert_eq!(
        json(&layout_diff(reversed, &default()).unwrap()),
        json(&layout_diff(&diff, &default()).unwrap())
    );
}

#[test]
fn accepts_non_integer_seeds_deterministically() {
    let diff = tree(30, 7, english_label).diff();
    let seed = |s: f64| LayoutOptions {
        seed: Some(s),
        ..default()
    };
    let half = json(&layout_diff(&diff, &seed(0.5)).unwrap());
    assert_eq!(half, json(&layout_diff(&diff, &seed(0.5)).unwrap()));
    assert_ne!(half, json(&layout_diff(&diff, &seed(1.0)).unwrap()));
}

#[test]
fn chooses_iterations_from_the_size() {
    let ticks = |n: usize, iterations: Option<usize>| {
        let options = LayoutOptions {
            iterations,
            ..default()
        };
        layout_diff(&tree(n, 7, english_label).diff(), &options)
            .unwrap()
            .stats
            .iterations
    };
    assert_eq!(ticks(2, None), 275);
    assert_eq!(ticks(64, None), 150);
    assert_eq!(ticks(300, None), 120);
    assert_eq!(ticks(30, Some(17)), 17);
}

#[test]
fn still_separates_nodes_and_labels_with_zero_iterations() {
    let options = LayoutOptions {
        iterations: Some(0),
        ..default()
    };
    let layout = layout_diff(&tree(60, 7, english_label).diff(), &options).unwrap();
    assert_eq!(layout.stats.iterations, 0);
    let entries: Vec<(&kgdiff_core::js::JsStr, &Point)> = layout.positions.iter().collect();
    for (i, (a, pa)) in entries.iter().enumerate() {
        for (b, pb) in &entries[i + 1..] {
            let d = support::distance(**pa, **pb);
            assert!(d >= layout.radii[a.as_str()] + layout.radii[b.as_str()]);
        }
    }
}

#[test]
fn scales_with_the_link_distance() {
    let diff = tree(40, 7, english_label).diff();
    let area = |distance: f64| {
        let options = LayoutOptions {
            link_distance: Some(distance),
            label_aware: Some(false),
            ..default()
        };
        let b = layout_diff(&diff, &options).unwrap().bounds;
        b.width * b.height
    };
    assert!(area(120.0) > 2.0 * area(30.0));
}

#[test]
fn reserves_less_room_when_labels_are_ignored() {
    let diff = tree(80, 7, english_label).diff();
    let area = |label_aware: bool| {
        let options = LayoutOptions {
            label_aware: Some(label_aware),
            ..default()
        };
        let b = layout_diff(&diff, &options).unwrap().bounds;
        b.width * b.height
    };
    assert!(area(false) < area(true));
}

#[test]
fn rejects_invalid_options_with_invalid_input() {
    let diff = tree(3, 7, english_label).diff();
    let cases = [
        LayoutOptions {
            link_distance: Some(0.0),
            ..default()
        },
        LayoutOptions {
            link_distance: Some(f64::NAN),
            ..default()
        },
        LayoutOptions {
            font_size: Some(-1.0),
            ..default()
        },
        LayoutOptions {
            component_gap: Some(f64::INFINITY),
            ..default()
        },
        LayoutOptions {
            seed: Some(f64::NAN),
            ..default()
        },
        LayoutOptions {
            hub_degree: Some(-1.0),
            ..default()
        },
        LayoutOptions {
            pinned: support::points(&[("t0000", f64::NAN, 0.0)]),
            ..default()
        },
    ];
    for options in &cases {
        let error = layout_diff(&diff, options).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid-input", "{options:?}");
        assert!(error.message.starts_with("Invalid layout option "));
    }
}

#[test]
fn estimates_label_widths_by_character_class() {
    let em = |text: &str| estimate_label_width(text, 1.0);
    let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert_eq!(em(""), 0.0);
    assert!(close(em("Ab 1"), 0.68 + 0.56 + 0.3 + 0.6));
    assert!(close(em("知识图谱"), 4.0));
    assert!(close(em("カタカナ"), 4.0));
    assert!(close(em("한국어"), 3.0));
    assert!(close(em("ＡＢ１"), 3.0));
    assert!(close(em("\u{20000}"), 1.0));
    assert!(close(em("🚀"), 1.0));
    assert!(close(em("👍🏽"), 1.0));
    assert!(close(em("❤️"), 1.0));
    assert!(close(em("👨‍👩‍👧"), 3.0));
    assert!(close(em("🇫🇷"), 1.0));
    assert!(close(em("Ω"), 0.68));
    assert!(close(em("ω"), 0.56));
    assert!(close(em("e\u{301}"), 0.56));
    assert!(close(em("٣"), 0.6));
    assert!(close(em("\u{a0}"), 0.3));
    assert!(close(
        estimate_label_width("Gene Ontology", 12.0),
        12.0 * em("Gene Ontology")
    ));
}

#[test]
fn computes_radii_from_degrees() {
    assert_eq!(node_radius(0.0), 4.0);
    assert_eq!(node_radius(-3.0), 4.0);
    assert!((node_radius(4.0) - 8.4).abs() < 1e-12);
    assert_eq!(node_radius(10_000.0), 14.0);
}
