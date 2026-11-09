//! The anchored strategy (`packages/layout/test/anchored.test.ts`): known positions stay exactly
//! where they are, new nodes join their neighbours.

mod support;

use kgdiff_core::model::Point;
use kgdiff_layout::{LayoutOptions, LayoutResult, LayoutStrategy, layout_diff};
use support::{
    EdgeSpec, GraphSpec, NodeSpec, distance, english_label, json, quality, scale_free, tree,
};

const L: f64 = 56.0;

struct Grown {
    base: GraphSpec,
    first: LayoutResult,
    grown: GraphSpec,
    layout: LayoutResult,
}

fn grown() -> Grown {
    let base = scale_free(150, 1.3, 11);
    let first = layout_diff(&base.diff(), &LayoutOptions::default()).unwrap();
    let mut grown = base.with_before_positions(&first);
    for (id, label) in [
        ("new-a", "New A"),
        ("new-b", "New B"),
        ("new-c", "New C"),
        ("new-d", "New D"),
    ] {
        grown.nodes.push(NodeSpec {
            label: label.to_owned(),
            ..NodeSpec::added(id)
        });
    }
    for (s, t) in [
        ("new-a", "s0000"),
        ("new-b", "s0000"),
        ("new-c", "s0042"),
        ("new-d", "new-c"),
    ] {
        grown.edges.push(EdgeSpec::added(s, t));
    }
    let layout = layout_diff(&grown.diff(), &LayoutOptions::default()).unwrap();
    Grown {
        base,
        first,
        grown,
        layout,
    }
}

#[test]
fn is_the_default_when_positions_are_known_and_keeps_them_exactly() {
    let Grown { first, layout, .. } = grown();
    assert_eq!(layout.stats.strategy, LayoutStrategy::Anchored);
    for (id, p) in &first.positions {
        let q = layout.positions[id.as_str()];
        assert_eq!(
            (q.x.to_bits(), q.y.to_bits()),
            (p.x.to_bits(), p.y.to_bits()),
            "{id}"
        );
    }
}

#[test]
fn places_new_nodes_next_to_their_neighbours_without_overlap() {
    let Grown {
        first,
        grown,
        layout,
        ..
    } = grown();
    let diff = grown.diff();
    // "Next to": within the ring the neighbour's existing edges already span (a hub's
    // neighbourhood is full, so a new leaf may sit a little farther out), plus L.
    let reach = |id: &str| -> f64 {
        let Some(&p) = first.positions.get(id) else {
            return 0.0;
        };
        diff.edges_of(id)
            .flat_map(|e| [e.source.clone(), e.target.clone()])
            .filter_map(|v| first.positions.get(v.as_str()).copied())
            .map(|q| distance(p, q))
            .fold(0.0, |a, b| if b > a { b } else { a })
    };
    for (node, neighbour) in [
        ("new-a", "s0000"),
        ("new-b", "s0000"),
        ("new-c", "s0042"),
        ("new-d", "new-c"),
    ] {
        let d = distance(layout.positions[node], layout.positions[neighbour]);
        let limit = reach(neighbour) + L;
        let limit = if 2.5 * L > limit { 2.5 * L } else { limit };
        assert!(d < limit, "{node}: {d} ≥ {limit}");
    }
    let q = quality(&diff, &layout, 12.0);
    assert!(q.min_clearance >= 0.0);
    assert!(q.overlaps.is_empty(), "{:?}", q.overlaps);
}

#[test]
fn preserves_pins_exactly_and_pins_win_over_node_positions() {
    let Grown { first, grown, .. } = grown();
    let options = LayoutOptions {
        pinned: support::points(&[("s0001", 1234.5678, -98.7654), ("new-a", 10.001, 20.002)]),
        ..LayoutOptions::default()
    };
    let layout = layout_diff(&grown.diff(), &options).unwrap();
    assert_eq!(
        layout.positions["s0001"],
        Point {
            x: 1234.5678,
            y: -98.7654
        }
    );
    assert_eq!(
        layout.positions["new-a"],
        Point {
            x: 10.001,
            y: 20.002
        }
    );
    assert_eq!(layout.positions["s0002"], first.positions["s0002"]);
}

#[test]
fn uses_after_positions_for_nodes_that_only_exist_after() {
    let spec = GraphSpec {
        nodes: vec![
            NodeSpec {
                before_position: Some(Point { x: 0.0, y: 0.0 }),
                ..NodeSpec::new("a", "a")
            },
            NodeSpec {
                after_position: Some(Point { x: 300.0, y: 40.0 }),
                ..NodeSpec::added("b")
            },
            NodeSpec::added("c"),
        ],
        edges: vec![EdgeSpec::added("b", "a"), EdgeSpec::added("c", "a")],
    };
    let layout = layout_diff(&spec.diff(), &LayoutOptions::default()).unwrap();
    assert_eq!(layout.positions["a"], Point { x: 0.0, y: 0.0 });
    assert_eq!(layout.positions["b"], Point { x: 300.0, y: 40.0 });
    assert!(distance(layout.positions["c"], Point { x: 0.0, y: 0.0 }) < 2.5 * L);
}

#[test]
fn is_deterministic_and_stable_when_nodes_are_added_elsewhere() {
    let Grown {
        first,
        mut grown,
        layout,
        ..
    } = grown();
    assert_eq!(
        json(&layout_diff(&grown.diff(), &LayoutOptions::default()).unwrap()),
        json(&layout)
    );
    grown.nodes.push(NodeSpec {
        label: "Far away".to_owned(),
        ..NodeSpec::added("new-z")
    });
    grown.edges.push(EdgeSpec::added("new-z", "s0120"));
    let again = layout_diff(&grown.diff(), &LayoutOptions::default()).unwrap();
    for (id, p) in &first.positions {
        assert_eq!(again.positions[id.as_str()], *p, "{id}");
    }
}

#[test]
fn packs_components_without_known_positions_beside_the_anchored_region() {
    let Grown { base, first, .. } = grown();
    let mut spec = base.with_before_positions(&first);
    spec.nodes.push(NodeSpec {
        label: "Island one".to_owned(),
        ..NodeSpec::added("island-1")
    });
    spec.nodes.push(NodeSpec {
        label: "Island two".to_owned(),
        ..NodeSpec::added("island-2")
    });
    spec.nodes.push(NodeSpec {
        label: "Lonely".to_owned(),
        ..NodeSpec::added("lonely")
    });
    spec.edges.push(EdgeSpec::added("island-1", "island-2"));
    let layout = layout_diff(&spec.diff(), &LayoutOptions::default()).unwrap();
    let b = first.bounds;
    for id in ["island-1", "island-2", "lonely"] {
        let p = layout.positions[id];
        assert!(p.x > b.x + b.width || p.y > b.y + b.height, "{id} inside");
    }
}

#[test]
fn ignores_known_positions_when_union_is_requested() {
    let Grown { first, grown, .. } = grown();
    let options = LayoutOptions {
        strategy: Some(LayoutStrategy::Union),
        ..LayoutOptions::default()
    };
    let union = layout_diff(&grown.diff(), &options).unwrap();
    assert_eq!(union.stats.strategy, LayoutStrategy::Union);
    assert_ne!(union.positions["s0001"], first.positions["s0001"]);
    assert!((union.bounds.x + union.bounds.width / 2.0).abs() < 0.05);
}

#[test]
fn falls_back_to_a_free_layout_when_nothing_is_known() {
    let options = LayoutOptions {
        strategy: Some(LayoutStrategy::Anchored),
        ..LayoutOptions::default()
    };
    let layout = layout_diff(&tree(20, 7, english_label).diff(), &options).unwrap();
    assert_eq!(layout.stats.strategy, LayoutStrategy::Anchored);
    assert_eq!(layout.positions.len(), 20);
}
