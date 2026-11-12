//! `layout_graph`, the layout of one graph (RFC 0003, part 1). Its definition is its contract:
//! the layout document of a graph is, byte for byte, the layout document of the diff of that
//! graph with itself, with every node in scope. The contract is checked on both graphs of every
//! corpus case and on seeded random graphs, so that building the unchanged union without a diff
//! stays a safe change. Then: known positions are kept bit for bit and only the other nodes are
//! placed; the scope is `All` whatever the size of the graph; scope `Changes` is rejected.

mod support;

use std::path::{Path, PathBuf};

use kgdiff_core::js::{IndexMap, JsStr, Object, Value, json};
use kgdiff_core::model::Point;
use kgdiff_core::{
    DiffOptions, EdgeIdentity, KGraph, NormalizeOptions, diff_graphs, normalize, resolve_options,
};
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, LayoutStrategy, layout_diff, layout_from_json,
    layout_graph,
};
use support::{
    EdgeSpec, GraphSpec, NodeSpec, Rng, changes, cjk, cjk_label, components, english_label,
    scale_free, star, tree,
};

fn graph(value: &Value, edge_identity: EdgeIdentity) -> KGraph {
    let mut options = NormalizeOptions::default();
    options.edge_identity = edge_identity;
    normalize(value, options).expect("a valid graph")
}

fn diff_options(graph: &KGraph) -> DiffOptions {
    {
        let mut o = DiffOptions::default();
        o.edge_identity = graph.edge_identity();
        o
    }
}

fn all(options: &LayoutOptions) -> LayoutOptions {
    {
        let mut o = options.clone();
        o.scope = Some(LayoutScope::All);
        o
    }
}

/// The right-hand side of the contract, written out: the layout of the diff of `graph` with
/// itself (default diff options, the graph's edge identity) with scope `All`.
fn of_the_identical_diff(graph: &KGraph, options: &LayoutOptions) -> LayoutResult {
    let identical = diff_graphs(graph.clone(), graph.clone(), diff_options(graph)).unwrap();
    assert!(identical.stats.identical);
    layout_diff(&identical, &all(options)).unwrap()
}

/// The contract, and what follows from scope `All`: every node of the graph has a position.
fn check_contract(what: &str, graph: &KGraph, options: &LayoutOptions) -> LayoutResult {
    let layout = layout_graph(graph, options).unwrap_or_else(|e| panic!("{what}: {e}"));
    let expected = of_the_identical_diff(graph, options);
    assert_eq!(support::json(&layout), support::json(&expected), "{what}");
    assert_eq!(layout, expected, "{what}");

    assert_eq!(layout.scope, LayoutScope::All, "{what}");
    assert!(layout.hidden.is_empty(), "{what}");
    let mut ids: Vec<&JsStr> = graph.nodes().map(|n| n.id()).collect();
    ids.sort();
    let mut placed: Vec<&JsStr> = layout.positions.keys().collect();
    placed.sort();
    assert_eq!(placed, ids, "{what}");
    for (id, p) in &layout.positions {
        assert!(p.x.is_finite() && p.y.is_finite(), "{what}: {id} at {p:?}");
    }
    layout
}

fn same(a: Point, b: Point) -> bool {
    a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits()
}

fn is_hundredth(v: f64) -> bool {
    kgdiff_core::js::math::round(v * 100.0) / 100.0 == v
}

/// A position off the 0.01 grid of the layout document.
fn off_grid(p: Point) -> Point {
    Point {
        x: p.x + 0.003_1,
        y: p.y - 1.0 / 3.0,
    }
}

// ─── The contract on the corpus ─────────────────────────────────────────────────────────────

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn read(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    json::parse(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn equals_the_layout_of_the_identical_diff_on_both_graphs_of_every_corpus_case() {
    let manifest = read(&corpus().join("manifest.json"));
    let cases = manifest.get("cases").and_then(Value::as_array).unwrap();
    // Written out, not read from the manifest: a corpus that loses cases must fail here.
    assert_eq!(cases.len(), 30);
    let empty = || Value::Object(Object::new());
    for entry in cases {
        let id = entry.get("id").and_then(Value::as_str).unwrap();
        let dir = corpus().join("cases").join(id);
        let spec = read(&dir.join("case.json"));
        let edge_identity = resolve_options(spec.get("options")).unwrap().edge_identity;
        // The case's layout options, but for its scope (`synthetic-600` asks for `changes`).
        let given = {
            let mut o = LayoutOptions::from_value(
                &spec.get("layoutOptions").cloned().unwrap_or_else(empty),
            )
            .unwrap();
            o.scope = None;
            o
        };
        for side in ["before", "after"] {
            let what = format!("{id} ({side})");
            let parsed = read(&dir.join(format!("expected/parse.{side}.json")));
            let value = parsed.get("graph").unwrap();
            let graph = graph(value, edge_identity);

            let layout = check_contract(&what, &graph, &LayoutOptions::default());
            if given != LayoutOptions::default() {
                check_contract(&what, &graph, &given);
            }

            // Other options, the ones `layout_graph` does not read set to what would empty a
            // layout of the identical diff, and every third node pinned off the grid.
            let pinned: IndexMap<JsStr, Point> = layout
                .positions
                .iter()
                .enumerate()
                .filter(|(k, _)| k % 3 == 0)
                .map(|(_, (id, p))| (id.clone(), off_grid(*p)))
                .collect();
            let mut options = LayoutOptions::default();
            options.seed = Some(7.0);
            options.label_aware = Some(false);
            options.large_graph_threshold = Some(0.0);
            options.context_hops = Some(0);
            options.hub_degree = Some(0.0);
            options.pinned = pinned.clone();
            let anchored = check_contract(&what, &graph, &options);
            for (id, p) in &pinned {
                assert!(same(anchored.positions[id.as_str()], *p), "{what}: {id}");
            }

            // What a host did before `layout_graph`: diff the graph's JSON with itself and
            // force the scope.
            let by_hand = kgdiff_core::diff(value, value, &diff_options(&graph)).unwrap();
            assert_eq!(
                support::json(&layout_diff(&by_hand, &all(&LayoutOptions::default())).unwrap()),
                support::json(&layout),
                "{what}: diffed by hand"
            );
        }
    }
}

// ─── The contract on random graphs ──────────────────────────────────────────────────────────

fn point(p: Point) -> Value {
    let mut out = Object::new();
    out.insert("x", p.x);
    out.insert("y", p.y);
    Value::Object(out)
}

fn somewhere(random: &mut Rng) -> Point {
    Point {
        x: (random.next() - 0.5) * 900.0,
        y: (random.next() - 0.5) * 600.0,
    }
}

/// A random graph as kgdiff JSON: up to 40 nodes, some without a label, some with a position
/// (not on the 0.01 grid) or a `replaces` hint; edges with self-loops, parallel edges, exact
/// duplicates and dangling endpoints; edge ids when `edge_ids`.
fn random_graph(random: &mut Rng, edge_ids: bool) -> Value {
    let n = random.below(41);
    let id = |i: usize| format!("n{i:02}");
    let mut nodes = Vec::new();
    for i in 0..n {
        let mut node = Object::new();
        node.insert("id", id(i));
        match random.below(4) {
            0 => {}
            1 => {
                node.insert("label", cjk_label(random));
            }
            _ => {
                node.insert("label", english_label(random));
            }
        }
        if random.next() < 0.25 {
            node.insert("position", point(somewhere(random)));
        }
        if random.next() < 0.1 {
            let other = Value::from(id(random.below(n)));
            node.insert("replaces", Value::Array(vec![other]));
        }
        nodes.push(Value::Object(node));
    }
    let mut edges = Vec::new();
    let count = if n == 0 { 0 } else { random.below(2 * n + 1) };
    for k in 0..count {
        let end = |random: &mut Rng| {
            if random.next() < 0.05 {
                format!("ghost{}", random.below(3))
            } else {
                id(random.below(n))
            }
        };
        let mut edge = Object::new();
        edge.insert("source", end(random));
        edge.insert("target", end(random));
        edge.insert("predicate", ["is_a", "related", "投资"][random.below(3)]);
        if edge_ids && random.next() < 0.8 {
            edge.insert("id", format!("e{k:03}"));
        }
        edges.push(Value::Object(edge));
    }
    let mut out = Object::new();
    out.insert("nodes", Value::Array(nodes));
    out.insert("edges", Value::Array(edges));
    Value::Object(out)
}

/// Random options: every member `layout_graph` reads, the three it does not, and pins (one of
/// them for a node the graph does not have).
fn random_options(random: &mut Rng, graph: &KGraph) -> LayoutOptions {
    let mut options = LayoutOptions::default();
    let coin = |random: &mut Rng, p: f64| random.next() < p;
    options.strategy = match random.below(4) {
        0 => Some(LayoutStrategy::Union),
        1 => Some(LayoutStrategy::Anchored),
        _ => None,
    };
    if coin(random, 0.5) {
        options.scope = Some(LayoutScope::All);
    }
    if coin(random, 0.5) {
        options.seed = Some(random.below(1000) as f64 - 0.5 * random.below(2) as f64);
    }
    if coin(random, 0.3) {
        options.iterations = Some(random.below(80));
    }
    if coin(random, 0.3) {
        options.link_distance = Some(30.0 + 60.0 * random.next());
    }
    if coin(random, 0.3) {
        options.label_aware = Some(false);
    }
    if coin(random, 0.3) {
        options.font_size = Some(9.0 + random.below(8) as f64);
    }
    if coin(random, 0.3) {
        options.component_gap = Some(200.0 * random.next());
    }
    if coin(random, 0.5) {
        options.large_graph_threshold = Some(random.below(3) as f64);
    }
    if coin(random, 0.5) {
        options.context_hops = Some(random.below(3));
    }
    if coin(random, 0.5) {
        options.hub_degree = Some(random.below(3) as f64);
    }
    if coin(random, 0.4) {
        for id in graph.nodes().map(|n| n.id()) {
            if coin(random, 0.2) {
                options.pinned.insert(id.clone(), somewhere(random));
            }
        }
        options
            .pinned
            .insert(JsStr::from("not-a-node"), somewhere(random));
    }
    options
}

#[test]
fn equals_the_layout_of_the_identical_diff_on_random_graphs() {
    let mut random = Rng::new(20_261_110);
    for run in 0..96 {
        let edge_ids = run % 3 == 0;
        let value = random_graph(&mut random, edge_ids);
        let edge_identity = if edge_ids {
            EdgeIdentity::Id
        } else {
            EdgeIdentity::Structure
        };
        let graph = graph(&value, edge_identity);
        let options = random_options(&mut random, &graph);
        let what = format!("run {run}: {} with {options:?}", json::to_string(&value));
        check_contract(&what, &graph, &options);
    }
}

#[test]
fn equals_the_layout_of_the_identical_diff_on_the_fixture_graphs() {
    let both = |spec: &GraphSpec| -> [Value; 2] {
        let (before, after) = spec.versions();
        [before, after]
    };
    let fixtures = [
        ("tree", tree(60, 7, english_label)),
        ("scale-free", scale_free(150, 1.3, 11)),
        ("star", star(50)),
        ("components", components(30, 40, 3)),
        ("cjk", cjk(80, 5)),
        ("changes", changes(17)),
        ("empty", GraphSpec::default()),
    ];
    for (what, spec) in &fixtures {
        for value in both(spec) {
            let graph = graph(&value, EdgeIdentity::Structure);
            check_contract(what, &graph, &LayoutOptions::default());
        }
    }
}

#[test]
fn is_the_same_for_the_same_graph_in_another_order() {
    let spec = scale_free(150, 1.3, 11);
    let layout = |spec: &GraphSpec| {
        let graph = graph(&spec.versions().1, EdgeIdentity::Structure);
        support::json(&layout_graph(&graph, &LayoutOptions::default()).unwrap())
    };
    assert_eq!(layout(&support::shuffled(&spec, 3)), layout(&spec));
}

// ─── Known positions ────────────────────────────────────────────────────────────────────────

/// A graph, its layout, and its next version: the same nodes plus four new ones.
struct Versions {
    first: LayoutResult,
    next: GraphSpec,
}

const NEW: [(&str, &str); 4] = [
    ("new-a", "s0000"),
    ("new-b", "s0000"),
    ("new-c", "s0042"),
    ("new-d", "new-c"),
];

fn versions() -> Versions {
    let base = scale_free(150, 1.3, 11);
    let graph = graph(&base.versions().1, EdgeIdentity::Structure);
    let first = layout_graph(&graph, &LayoutOptions::default()).unwrap();
    assert_eq!(first.stats.strategy, LayoutStrategy::Union);
    let mut next = base;
    for (id, neighbour) in NEW {
        next.nodes.push(NodeSpec::new(id, id));
        next.edges.push(EdgeSpec::new(id, neighbour));
    }
    Versions { first, next }
}

/// The after version of `spec`, every node at `position(id)` when it gives one.
fn positioned(spec: &GraphSpec, position: impl Fn(&str) -> Option<Point>) -> KGraph {
    let mut spec = spec.clone();
    for node in &mut spec.nodes {
        node.after_position = position(&node.id);
    }
    graph(&spec.versions().1, EdgeIdentity::Structure)
}

fn check_placed(layout: &LayoutResult) {
    for (id, _) in NEW {
        let p = layout.positions[id];
        assert!(p.x.is_finite() && p.y.is_finite(), "{id} at {p:?}");
        assert!(is_hundredth(p.x) && is_hundredth(p.y), "{id} at {p:?}");
    }
}

#[test]
fn keeps_the_positions_on_the_nodes_bit_for_bit_and_places_only_the_others() {
    let Versions { first, next } = versions();
    // Off the grid, so that a position kept exactly is told apart from one rounded on the way.
    let known = |id: &str| first.positions.get(id).map(|p| off_grid(*p));
    let graph = positioned(&next, known);
    let layout = check_contract("positions", &graph, &LayoutOptions::default());
    assert_eq!(layout.stats.strategy, LayoutStrategy::Anchored);
    assert_eq!(layout.positions.len(), first.positions.len() + NEW.len());
    for id in first.positions.keys() {
        assert!(
            same(layout.positions[id.as_str()], known(id).unwrap()),
            "{id} moved"
        );
    }
    check_placed(&layout);
}

#[test]
fn keeps_pins_bit_for_bit_and_pins_win_over_the_positions_on_the_nodes() {
    let Versions { first, next } = versions();
    let pinned: IndexMap<JsStr, Point> = first
        .positions
        .iter()
        .map(|(id, p)| (id.clone(), off_grid(*p)))
        .collect();
    let mut options = LayoutOptions::default();
    options.pinned = pinned.clone();
    let unpositioned = graph(&next.versions().1, EdgeIdentity::Structure);
    let layout = check_contract("pins", &unpositioned, &options);
    assert_eq!(layout.stats.strategy, LayoutStrategy::Anchored);
    for (id, p) in &pinned {
        assert!(same(layout.positions[id.as_str()], *p), "{id} moved");
    }
    check_placed(&layout);

    // The same positions on the nodes give the same layout, and a pin wins over them.
    let on_nodes = positioned(&next, |id| pinned.get(id).copied());
    assert_eq!(
        layout_graph(&on_nodes, &LayoutOptions::default()).unwrap(),
        layout
    );
    let mut options = LayoutOptions::default();
    options.pinned = support::points(&[("s0001", 1234.5678, -98.7654), ("new-a", 10.001, 20.002)]);
    let layout = check_contract("pins over positions", &on_nodes, &options);
    let at = |x, y| Point { x, y };
    assert_eq!(layout.positions["s0001"], at(1234.5678, -98.7654));
    assert_eq!(layout.positions["new-a"], at(10.001, 20.002));
    assert!(same(layout.positions["s0002"], pinned["s0002"]));
}

/// The layout document rounds to 0.01, and computed positions are on that grid already: what is
/// read back from a document stays as written, through any number of versions.
#[test]
fn positions_read_back_from_a_layout_document_survive_unchanged() {
    let Versions { first, next } = versions();
    let stored = |layout: &LayoutResult| -> (String, LayoutResult) {
        let text = support::json(layout);
        let read = layout_from_json(&json::parse(&text).unwrap()).unwrap();
        (text, read)
    };
    let written = |text: &str, id: &str| -> Value {
        let document = json::parse(text).unwrap();
        document.get("positions").unwrap().get(id).cloned().unwrap()
    };
    let (first_text, previous) = stored(&first);
    assert_eq!(previous.positions, first.positions);

    let graph = graph(&next.versions().1, EdgeIdentity::Structure);
    let mut options = LayoutOptions::default();
    options.pinned = previous.positions.clone();
    let second = layout_graph(&graph, &options).unwrap();
    let (second_text, previous) = stored(&second);
    assert_eq!(previous.positions, second.positions);
    for id in first.positions.keys() {
        assert_eq!(written(&second_text, id), written(&first_text, id), "{id}");
    }

    // A third version with nothing new: every position is known, and the document repeats.
    let mut options = LayoutOptions::default();
    options.pinned = previous.positions.clone();
    let third = layout_graph(&graph, &options).unwrap();
    assert_eq!(third.positions, second.positions);
    let positions = |text: &str| json::parse(text).unwrap().get("positions").cloned();
    assert_eq!(positions(&support::json(&third)), positions(&second_text));

    // A position from elsewhere is kept exactly in the result and rounded in the document.
    let mut options = options;
    options.pinned.insert(
        JsStr::from("s0001"),
        Point {
            x: 300.125,
            y: -7.0,
        },
    );
    let exact = layout_graph(&graph, &options).unwrap();
    assert_eq!(exact.positions["s0001"].x.to_bits(), 300.125_f64.to_bits());
    let (text, read) = stored(&exact);
    assert_eq!(read.positions["s0001"].x, 300.13);
    assert_eq!(json::to_string(&written(&text, "s0001")), "[300.13,-7]");
}

// ─── Scope ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn rejects_scope_changes() {
    let mut options = LayoutOptions::default();
    options.scope = Some(LayoutScope::Changes);
    for spec in [GraphSpec::default(), tree(20, 7, english_label)] {
        let graph = graph(&spec.versions().1, EdgeIdentity::Structure);
        let error = layout_graph(&graph, &options).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid-input");
        assert_eq!(
            error.message,
            "Invalid layout option scope: expected 'all' (the layout of one graph has no \
             changes to select), got changes"
        );
        let details = error.details.unwrap();
        assert_eq!(details.get("option").and_then(Value::as_str), Some("scope"));
        assert_eq!(
            details.get("value").and_then(Value::as_str),
            Some("changes")
        );
    }
}

#[test]
fn rejects_the_options_layout_diff_rejects() {
    let graph = graph(
        &tree(20, 7, english_label).versions().1,
        EdgeIdentity::Structure,
    );
    let identical = diff_graphs(graph.clone(), graph.clone(), diff_options(&graph)).unwrap();
    let invalid = [
        {
            let mut o = LayoutOptions::default();
            o.link_distance = Some(0.0);
            o
        },
        {
            let mut o = LayoutOptions::default();
            o.seed = Some(f64::NAN);
            o
        },
        {
            let mut o = LayoutOptions::default();
            o.pinned = support::points(&[("t0000", f64::INFINITY, 0.0)]);
            o
        },
        // Not read, but still checked.
        {
            let mut o = LayoutOptions::default();
            o.hub_degree = Some(-1.0);
            o
        },
    ];
    for options in &invalid {
        let error = layout_graph(&graph, options).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid-input");
        let expected = layout_diff(&identical, &all(options)).unwrap_err();
        assert_eq!(error.message, expected.message);
    }
}

/// Left to itself, `layout_diff` lays out the changes of a graph above `large_graph_threshold`,
/// and the diff of a graph with itself has none: the trap `layout_graph` removes.
#[test]
fn every_node_is_in_scope_whatever_the_threshold() {
    let graph = graph(
        &scale_free(150, 1.3, 11).versions().1,
        EdgeIdentity::Structure,
    );
    let reference = support::json(&layout_graph(&graph, &LayoutOptions::default()).unwrap());
    let mut small_threshold = LayoutOptions::default();
    small_threshold.large_graph_threshold = Some(100.0);
    let identical = diff_graphs(graph.clone(), graph.clone(), diff_options(&graph)).unwrap();
    let trapped = layout_diff(&identical, &small_threshold).unwrap();
    assert_eq!(trapped.scope, LayoutScope::Changes);
    assert!(trapped.positions.is_empty());

    let layout = layout_graph(&graph, &small_threshold).unwrap();
    assert_eq!(layout.scope, LayoutScope::All);
    assert_eq!(layout.positions.len(), 150);
    assert_eq!(support::json(&layout), reference);

    // The options of scope `Changes` change nothing.
    let mut unread = LayoutOptions::default();
    unread.scope = Some(LayoutScope::All);
    unread.large_graph_threshold = Some(0.0);
    unread.context_hops = Some(3);
    unread.hub_degree = Some(0.0);
    assert_eq!(
        support::json(&layout_graph(&graph, &unread).unwrap()),
        reference
    );
}

/// Above the default threshold of 3,000 nodes. Slow in a debug build: the `targets` CI job runs
/// it with `cargo test --release`.
#[test]
#[cfg_attr(debug_assertions, ignore = "slow in debug builds: run with --release")]
fn a_graph_above_the_default_threshold_is_laid_out_whole() {
    let graph = graph(
        &scale_free(3500, 1.3, 11).versions().1,
        EdgeIdentity::Structure,
    );
    let layout = check_contract("scale-free 3.5k", &graph, &LayoutOptions::default());
    assert_eq!(layout.positions.len(), 3500);
}

#[test]
fn takes_the_edge_identity_of_the_graph() {
    let value = json::parse(
        r#"{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],
            "edges":[{"id":"e1","source":"a","target":"b","predicate":"p"},
                     {"id":"e2","source":"a","target":"b","predicate":"p"},
                     {"source":"b","target":"c","predicate":"q"}]}"#,
    )
    .unwrap();
    for edge_identity in [EdgeIdentity::Structure, EdgeIdentity::Id] {
        let graph = graph(&value, edge_identity);
        let layout = check_contract("edge identity", &graph, &LayoutOptions::default());
        assert_eq!(layout.positions.len(), 3);
    }
}
