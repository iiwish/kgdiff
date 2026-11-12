//! Scope `changes` (`packages/layout/test/scope.test.ts`), against a brute-force reference.

mod support;

use std::collections::{BTreeMap, BTreeSet};

use kgdiff_core::DiffResult;
use kgdiff_core::model::ChangeStatus;
use kgdiff_layout::{LayoutOptions, LayoutScope, Rect, layout_diff};
use support::{EdgeSpec, GraphSpec, NodeSpec, changes, english_label, tree};

/// Neighbours over both versions of every edge.
fn neighbours(diff: &DiffResult) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = diff
        .nodes
        .iter()
        .map(|n| (n.id.to_string(), BTreeSet::new()))
        .collect();
    let mut link = |a: &str, b: &str| {
        if a == b {
            return;
        }
        if let Some(set) = out.get_mut(a) {
            set.insert(b.to_owned());
        }
        if let Some(set) = out.get_mut(b) {
            set.insert(a.to_owned());
        }
    };
    for e in &diff.edges {
        link(&e.source, &e.target);
        link(
            e.source_before.as_ref().unwrap_or(&e.source),
            e.target_before.as_ref().unwrap_or(&e.target),
        );
    }
    out
}

/// The reference for scope `changes`: changed nodes at distance 0, unchanged endpoints of
/// changed edges at distance 1, a BFS that never expands from a hub.
fn expected_scope(diff: &DiffResult, hops: usize, hub_degree: usize) -> BTreeSet<String> {
    let adj = neighbours(diff);
    let degree: BTreeMap<String, usize> = diff
        .nodes
        .iter()
        .map(|n| (n.id.to_string(), n.degree.before.max(n.degree.after)))
        .collect();
    let mut distance: BTreeMap<String, usize> = BTreeMap::new();
    for n in &diff.nodes {
        if n.status != ChangeStatus::Unchanged {
            distance.insert(n.id.to_string(), 0);
        }
    }
    for e in &diff.edges {
        if e.status == ChangeStatus::Unchanged {
            continue;
        }
        for id in [
            Some(&e.source),
            Some(&e.target),
            e.source_before.as_ref(),
            e.target_before.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            distance.entry(id.to_string()).or_insert(1);
        }
    }
    for d in 0..hops {
        let current: Vec<(String, usize)> = distance.iter().map(|(k, v)| (k.clone(), *v)).collect();
        for (id, dist) in current {
            if dist != d || degree[&id] > hub_degree {
                continue;
            }
            for v in &adj[&id] {
                distance.entry(v.clone()).or_insert(d + 1);
            }
        }
    }
    distance.into_keys().collect()
}

fn ids(layout: &kgdiff_layout::LayoutResult) -> BTreeSet<String> {
    layout.positions.keys().map(ToString::to_string).collect()
}

fn changes_only(hops: Option<usize>) -> LayoutOptions {
    {
        let mut o = LayoutOptions::default();
        o.scope = Some(LayoutScope::Changes);
        o.context_hops = hops;
        o
    }
}

#[test]
fn places_exactly_the_changes_and_their_context() {
    let diff = changes(17).diff();
    for hops in 0..4 {
        let layout = layout_diff(&diff, &changes_only(Some(hops))).unwrap();
        let expected = expected_scope(&diff, hops, 40);
        assert_eq!(ids(&layout), expected, "{hops} hops");
        assert_eq!(layout.scope, LayoutScope::Changes);
        assert_eq!(layout.radii.len(), expected.len());
        assert_eq!(layout.stats.nodes, expected.len());
    }
}

#[test]
fn counts_hidden_neighbours_per_visible_node() {
    let diff = changes(17).diff();
    let layout = layout_diff(&diff, &changes_only(None)).unwrap();
    let adj = neighbours(&diff);
    let mut total = 0;
    for id in layout.positions.keys() {
        let missing = adj[id.as_str()]
            .iter()
            .filter(|v| !layout.positions.contains_key(v.as_str()))
            .count();
        assert_eq!(
            layout.hidden.get(id.as_str()).copied().unwrap_or(0),
            missing
        );
        total += missing;
    }
    assert!(total > 0);
    for (id, count) in &layout.hidden {
        assert!(layout.positions.contains_key(id.as_str()));
        assert!(*count > 0);
    }
}

#[test]
fn keeps_both_endpoints_of_a_relation_only_change() {
    let mut spec = tree(30, 7, english_label);
    spec.edges.push(EdgeSpec::added("t0020", "t0021"));
    let layout = layout_diff(&spec.diff(), &changes_only(Some(0))).unwrap();
    assert_eq!(
        ids(&layout),
        BTreeSet::from(["t0020".to_owned(), "t0021".to_owned()])
    );
}

#[test]
fn defaults_to_changes_above_the_threshold() {
    let diff = changes(17).diff();
    let threshold = |t: Option<f64>| {
        let mut options = LayoutOptions::default();
        options.large_graph_threshold = t;
        layout_diff(&diff, &options).unwrap().scope
    };
    assert_eq!(threshold(None), LayoutScope::All);
    assert_eq!(threshold(Some(100.0)), LayoutScope::Changes);
    assert_eq!(threshold(Some(130.0)), LayoutScope::All);
    assert!(
        layout_diff(&diff, &LayoutOptions::default())
            .unwrap()
            .hidden
            .is_empty()
    );
}

#[test]
fn never_expands_context_from_a_hub() {
    // A changed hub with 60 leaves, one changed leaf with an unchanged neighbour chain.
    let mut spec = GraphSpec::default();
    spec.nodes.push(NodeSpec {
        label_before: Some("H".to_owned()),
        ..NodeSpec::new("hub", "hub")
    });
    for i in 0..60 {
        let leaf = format!("leaf{i:02}");
        spec.nodes.push(NodeSpec::new(&leaf, &leaf));
        spec.edges.push(EdgeSpec::new(&leaf, "hub"));
    }
    spec.nodes.push(NodeSpec::added("x"));
    spec.nodes.push(NodeSpec::new("y", "y"));
    spec.nodes.push(NodeSpec::new("z", "z"));
    spec.edges.push(EdgeSpec::added("x", "leaf00"));
    spec.edges.push(EdgeSpec::added("y", "x"));
    spec.edges.push(EdgeSpec::new("z", "y"));
    let diff = spec.diff();
    let set = |list: &[&str]| {
        list.iter()
            .map(|s| (*s).to_owned())
            .collect::<BTreeSet<_>>()
    };

    let layout = layout_diff(&diff, &changes_only(None)).unwrap();
    // hub (changed), x (added), leaf00 and y (endpoints of added edges, distance 1). The hub's
    // other leaves would only enter through the hub; z is two hops from x.
    assert_eq!(ids(&layout), set(&["hub", "leaf00", "x", "y"]));
    assert_eq!(layout.hidden["hub"], 59);
    assert_eq!(layout.hidden["y"], 1);
    assert_eq!(ids(&layout), expected_scope(&diff, 1, 40));

    // Without the rule the hub pulls in all of its leaves.
    let mut all = changes_only(None);
    all.hub_degree = Some(f64::INFINITY);
    let all = layout_diff(&diff, &all).unwrap();
    assert_eq!(all.positions.len(), 63);
    assert!(!all.hidden.contains_key("hub"));

    // Two hops: z enters through y; the hub still does not expand.
    let two = layout_diff(&diff, &changes_only(Some(2))).unwrap();
    assert_eq!(ids(&two), set(&["hub", "leaf00", "x", "y", "z"]));
}

#[test]
fn keeps_a_reachable_hub_without_expanding_from_it() {
    let mut spec = GraphSpec::default();
    spec.nodes.push(NodeSpec::added("a"));
    spec.nodes.push(NodeSpec::new("hub", "hub"));
    spec.edges.push(EdgeSpec::added("a", "hub"));
    for i in 0..50 {
        let id = format!("n{i}");
        spec.nodes.push(NodeSpec::new(&id, &id));
        spec.edges.push(EdgeSpec::new(&id, "hub"));
    }
    let layout = layout_diff(&spec.diff(), &changes_only(Some(3))).unwrap();
    assert_eq!(
        ids(&layout),
        BTreeSet::from(["a".to_owned(), "hub".to_owned()])
    );
    assert_eq!(layout.hidden["hub"], 50);
}

#[test]
fn is_empty_when_nothing_changed() {
    let layout = layout_diff(&tree(20, 7, english_label).diff(), &changes_only(None)).unwrap();
    assert!(layout.positions.is_empty());
    assert_eq!(layout.bounds, Rect::ZERO);
}

#[test]
fn has_the_statuses_the_fixture_describes() {
    // The fixture (built through kgdiff-core) has the changes the TypeScript one builds by hand.
    let diff = changes(17).diff();
    let status = |id: &str| diff.node(id).unwrap().status;
    assert_eq!(status("new0"), ChangeStatus::Added);
    assert_eq!(status("t0110"), ChangeStatus::Removed);
    assert_eq!(status("t0003"), ChangeStatus::Modified);
    let facets = |id: &str| {
        diff.node(id)
            .unwrap()
            .facets
            .iter()
            .map(|f| f.kind().as_str())
            .collect::<Vec<_>>()
    };
    assert!(
        facets("t0100").contains(&"mergedInto"),
        "{:?}",
        facets("t0100")
    );
    assert!(
        facets("split0").contains(&"splitFrom"),
        "{:?}",
        facets("split0")
    );
    assert!(
        facets("t0040").contains(&"splitInto"),
        "{:?}",
        facets("t0040")
    );
}
