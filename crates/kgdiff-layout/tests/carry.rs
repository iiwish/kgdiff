//! `layout_diff_on` and `layout_after` (RFC 0003, part 1): the layout of a version carried to the
//! next one through their diff. A host leans on what they promise, one mental map, so the
//! promise is written out here and checked on both graphs of every corpus case, on hand-written
//! pairs whose ids change or are given to other nodes, and with options that would break it:
//!
//! - `layout_diff_on` is `layout_diff` with every node in scope and the previous positions as
//!   pins, read through `before_id` and keyed by union id: the same `kgdiff.layout` bytes as the
//!   pins written by hand, which is what an embedding application did before these functions.
//!   A node the previous layout places, kept or removed, stays where it is, bit for bit; the
//!   others are placed, and no new node overlaps a removed one.
//! - `layout_after` is `layout_graph` of the after version with the diff's positions as pins,
//!   read by union id and keyed by `after_id`: every node is where the diff has it, bit for bit,
//!   and no simulation runs.

mod support;

use std::path::{Path, PathBuf};

use kgdiff_core::js::{IndexMap, JsStr, Value, json};
use kgdiff_core::model::{Point, UnionId};
use kgdiff_core::{
    DiffOptions, DiffResult, EdgeIdentity, KGraph, MatchOptions, MatchStrategy, NormalizeOptions,
    Result, diff_graphs, normalize, resolve_options,
};
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, LayoutStrategy, layout_after, layout_diff,
    layout_diff_on, layout_from_json, layout_graph,
};
use support::{EdgeSpec, GraphSpec, NodeSpec, Status, changes, scale_free};

// ─── By hand ────────────────────────────────────────────────────────────────────────────────

/// What `layout_diff_on` replaces: the pins an embedding application wrote itself
/// (`diff_map_first` of `kgdiff-report`'s example `embedding.rs`, as it was), with the caller's
/// options and pins.
fn diff_on_by_hand(
    diff: &DiffResult,
    previous: &LayoutResult,
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    let mut pinned: IndexMap<UnionId, Point> = IndexMap::default();
    for node in &diff.nodes {
        let in_before = node.before_id.as_ref();
        if let Some(position) = in_before.and_then(|id| previous.positions.get(id.as_str())) {
            pinned.insert(node.id.clone(), *position);
        }
    }
    for (id, position) in &options.pinned {
        pinned.insert(id.clone(), *position);
    }
    let options = LayoutOptions {
        pinned,
        scope: Some(LayoutScope::All),
        ..options.clone()
    };
    layout_diff(diff, &options)
}

/// What `layout_after` replaces (`next_map_of` of the same example, as it was): the diff's
/// positions as the pins of the after version, by union id.
fn after_by_hand(
    diff: &DiffResult,
    both: &LayoutResult,
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    let options = LayoutOptions {
        pinned: both.positions.clone(),
        ..options.clone()
    };
    layout_graph(&diff.after, &options)
}

// ─── The pairs ──────────────────────────────────────────────────────────────────────────────

/// Two versions of a graph and the options they are diffed with.
struct Pair {
    name: String,
    before: KGraph,
    after: KGraph,
    options: DiffOptions,
}

impl Pair {
    fn diff(&self) -> DiffResult {
        diff_graphs(
            self.before.clone(),
            self.after.clone(),
            self.options.clone(),
        )
        .unwrap_or_else(|e| panic!("{}: {e}", self.name))
    }

    /// The same pair the other way round: the after version becomes the previous one.
    fn reversed(&self) -> Pair {
        Pair {
            name: format!("{} (back)", self.name),
            before: self.after.clone(),
            after: self.before.clone(),
            options: self.options.clone(),
        }
    }
}

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn read(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    json::parse(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn graph(value: &Value, edge_identity: EdgeIdentity) -> KGraph {
    let options = NormalizeOptions {
        edge_identity,
        ..NormalizeOptions::default()
    };
    normalize(value, options).expect("a valid graph")
}

/// Every case of the corpus: its two parsed graphs and its diff options.
fn corpus_pairs() -> Vec<Pair> {
    let manifest = read(&corpus().join("manifest.json"));
    let cases = manifest.get("cases").and_then(Value::as_array).unwrap();
    // Written out, not read from the manifest: a corpus that loses cases must fail here.
    assert_eq!(cases.len(), 30);
    cases
        .iter()
        .map(|entry| {
            let id = entry.get("id").and_then(Value::as_str).unwrap();
            let dir = corpus().join("cases").join(id);
            let spec = read(&dir.join("case.json"));
            let options = resolve_options(spec.get("options")).unwrap();
            let side = |side: &str| {
                let parsed = read(&dir.join(format!("expected/parse.{side}.json")));
                graph(parsed.get("graph").unwrap(), options.edge_identity)
            };
            Pair {
                name: id.to_owned(),
                before: side("before"),
                after: side("after"),
                options,
            }
        })
        .collect()
}

fn pair(name: &str, before: &str, after: &str, strategy: MatchStrategy) -> Pair {
    let options = DiffOptions {
        r#match: MatchOptions {
            strategy,
            ..DiffOptions::default().r#match
        },
        ..DiffOptions::default()
    };
    let side = |text: &str| graph(&json::parse(text).unwrap(), options.edge_identity);
    Pair {
        name: name.to_owned(),
        before: side(before),
        after: side(after),
        options,
    }
}

/// A draft whose ids came from table names gets business ids, each with a `replaces` hint; one
/// node is dropped and one is new. Every id of the before version is gone, and no node is.
fn rekeyed() -> Pair {
    let before = r#"{"nodes":[
        {"id":"t_cust","label":"Customer","types":["concept"]},
        {"id":"t_ord","label":"Order","types":["concept"]},
        {"id":"t_ord_item","label":"Order line","types":["concept"]},
        {"id":"t_tmp_2019","label":"Import staging","types":["concept"]}],
      "edges":[
        {"source":"t_ord","target":"t_cust","predicate":"placed_by"},
        {"source":"t_ord_item","target":"t_ord","predicate":"part_of"},
        {"source":"t_tmp_2019","target":"t_ord","predicate":"feeds"}]}"#;
    let after = r#"{"nodes":[
        {"id":"customer","label":"Customer","types":["concept"],"replaces":["t_cust"]},
        {"id":"order","label":"Sales order","types":["concept"],"replaces":["t_ord"]},
        {"id":"order-line","label":"Order line","types":["concept"],"replaces":["t_ord_item"]},
        {"id":"refund","label":"Refund","types":["concept"]}],
      "edges":[
        {"source":"order","target":"customer","predicate":"placed_by"},
        {"source":"order-line","target":"order","predicate":"part_of"},
        {"source":"refund","target":"order","predicate":"refunds"}]}"#;
    pair("rekeyed", before, after, MatchStrategy::Id)
}

/// A pair as an extraction without stable ids gives it: the ids are renumbered, so `n1`, `n2`
/// and `n3` name other things in the after version, `n4` is given to a new node, and the removed
/// `n1` gets a union id that is an id of neither version (`n1@before`). The corpus has no such
/// collision.
fn renumbered() -> Pair {
    let before = r#"{"nodes":[
        {"id":"n1","label":"Ada Lovelace","types":["person"]},
        {"id":"n2","label":"Charles Babbage","types":["person"]},
        {"id":"n3","label":"Analytical Engine","types":["machine"]},
        {"id":"n4","label":"London","types":["place"]}],
      "edges":[
        {"source":"n1","target":"n3","predicate":"wrote_about"},
        {"source":"n2","target":"n3","predicate":"designed"},
        {"source":"n2","target":"n4","predicate":"lived_in"}]}"#;
    let after = r#"{"nodes":[
        {"id":"n1","label":"Charles Babbage","types":["person"]},
        {"id":"n2","label":"Analytical Engine","types":["machine"]},
        {"id":"n3","label":"London","types":["place"]},
        {"id":"n4","label":"Difference Engine","types":["machine"]}],
      "edges":[
        {"source":"n1","target":"n2","predicate":"designed"},
        {"source":"n1","target":"n3","predicate":"lived_in"},
        {"source":"n1","target":"n4","predicate":"designed"}]}"#;
    pair("renumbered", before, after, MatchStrategy::Similarity)
}

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────

fn same(a: Point, b: Point) -> bool {
    a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits()
}

/// A position off the 0.01 grid of the layout document.
fn off_grid(p: Point) -> Point {
    Point {
        x: p.x + 0.003_1,
        y: p.y - 1.0 / 3.0,
    }
}

fn sorted<'a>(ids: impl Iterator<Item = &'a JsStr>) -> Vec<&'a JsStr> {
    let mut ids: Vec<&JsStr> = ids.collect();
    ids.sort();
    ids
}

/// A layout as an application stores it and reads it back: through its document.
fn stored(layout: &LayoutResult) -> LayoutResult {
    layout_from_json(&json::parse(&support::json(layout)).unwrap()).unwrap()
}

/// The layout of a version that has no map yet, stored and read back.
fn first_map(graph: &KGraph) -> LayoutResult {
    stored(&layout_graph(graph, &LayoutOptions::default()).unwrap())
}

/// `layout` with every position moved off the grid.
fn shifted(layout: &LayoutResult) -> LayoutResult {
    let mut out = layout.clone();
    for position in out.positions.values_mut() {
        *position = off_grid(*position);
    }
    out
}

/// The distance between two discs (negative when they overlap).
fn gap(layout: &LayoutResult, a: &str, b: &str) -> f64 {
    let (p, q) = (layout.positions[a], layout.positions[b]);
    let (dx, dy) = (p.x - q.x, p.y - q.y);
    (dx * dx + dy * dy).sqrt() - layout.radii[a] - layout.radii[b]
}

fn expect_invalid(result: Result<LayoutResult>, message: &str) -> kgdiff_core::KgdiffError {
    let error = result.expect_err(message);
    assert_eq!(error.code.as_str(), "invalid-input");
    assert_eq!(error.message, message);
    error
}

// ─── The contract ───────────────────────────────────────────────────────────────────────────

/// What a walk saw, to check that the pairs cover what they are meant to.
#[derive(Default)]
struct Seen {
    /// Union nodes in both versions.
    continued: usize,
    /// Of them, those whose id changed.
    rekeyed: usize,
    added: usize,
    removed: usize,
    /// Pairs of an added and a removed node whose discs were checked.
    cleared: usize,
}

impl Seen {
    fn add(&mut self, other: &Seen) {
        self.continued += other.continued;
        self.rekeyed += other.rekeyed;
        self.added += other.added;
        self.removed += other.removed;
        self.cleared += other.cleared;
    }
}

struct Maps {
    diff: DiffResult,
    /// The diff on the previous map.
    both: LayoutResult,
    /// The after version on the diff's map.
    next: LayoutResult,
}

/// Both functions on one pair: the bytes of the pins written by hand, and what they promise.
/// `previous` must place every node of the before version.
fn walk(pair: &Pair, previous: &LayoutResult, options: &LayoutOptions) -> (Maps, Seen) {
    let what = &pair.name;
    let diff = pair.diff();
    let mut seen = Seen::default();

    // The diff on the previous map.
    let both = layout_diff_on(&diff, previous, options).unwrap_or_else(|e| panic!("{what}: {e}"));
    let by_hand = diff_on_by_hand(&diff, previous, options).unwrap();
    assert_eq!(support::json(&both), support::json(&by_hand), "{what}");
    assert_eq!(both, by_hand, "{what}");
    assert_eq!(both.scope, LayoutScope::All, "{what}");
    assert!(both.hidden.is_empty(), "{what}");
    assert_eq!(
        sorted(both.positions.keys()),
        sorted(diff.nodes.iter().map(|node| &node.id)),
        "{what}: every union node has a position"
    );
    for node in &diff.nodes {
        let at = both.positions[node.id.as_str()];
        if options.pinned.contains_key(node.id.as_str()) {
            assert!(
                same(at, options.pinned[node.id.as_str()]),
                "{what}: {} is not where the caller pinned it",
                node.id
            );
        } else if let Some(before) = &node.before_id {
            assert!(
                same(at, previous.positions[before.as_str()]),
                "{what}: {} is not where the previous version had {before}",
                node.id
            );
        } else {
            assert!(
                at.x.is_finite() && at.y.is_finite(),
                "{what}: {} at {at:?}",
                node.id
            );
        }
        match (&node.before_id, &node.after_id) {
            (Some(before), Some(after)) => {
                seen.continued += 1;
                seen.rekeyed += usize::from(before != after);
            }
            (None, Some(_)) => seen.added += 1,
            (Some(_), None) => seen.removed += 1,
            (None, None) => panic!("{what}: union node {} is in neither version", node.id),
        }
    }
    let known = seen.continued + seen.removed > 0 || !options.pinned.is_empty();
    let strategy = |known: bool| match (options.strategy, known) {
        (None, false) => LayoutStrategy::Union,
        _ => LayoutStrategy::Anchored,
    };
    assert_eq!(both.stats.strategy, strategy(known), "{what}");
    if seen.added == 0 {
        assert_eq!(both.stats.iterations, 0, "{what}: nothing to place");
    }

    // The after version on that map.
    let next = layout_after(&diff, &both, options).unwrap_or_else(|e| panic!("{what}: {e}"));
    let by_hand = after_by_hand(&diff, &both, options).unwrap();
    assert_eq!(support::json(&next), support::json(&by_hand), "{what}");
    assert_eq!(next, by_hand, "{what}");
    assert_eq!(next.scope, LayoutScope::All, "{what}");
    assert!(next.hidden.is_empty(), "{what}");
    assert_eq!(
        sorted(next.positions.keys()),
        sorted(pair.after.nodes().map(|n| n.id())),
        "{what}: every after node has a position"
    );
    for node in &diff.nodes {
        let Some(after) = &node.after_id else {
            assert!(
                !next.positions.contains_key(node.id.as_str()),
                "{what}: removed {} is in the after version's layout",
                node.id
            );
            continue;
        };
        assert!(
            same(
                next.positions[after.as_str()],
                both.positions[node.id.as_str()]
            ),
            "{what}: {after} is not where the diff has {}",
            node.id
        );
    }
    assert_eq!(next.stats.iterations, 0, "{what}: nothing was simulated");
    assert_eq!(
        next.stats.strategy,
        strategy(pair.after.node_count() != 0),
        "{what}"
    );
    (Maps { diff, both, next }, seen)
}

/// No new node on a removed one: the reason the diff is laid out before the after version.
fn check_cleared(what: &str, maps: &Maps, seen: &mut Seen) {
    let Maps { diff, both, .. } = maps;
    for added in diff.nodes.iter().filter(|n| n.before_id.is_none()) {
        for removed in diff.nodes.iter().filter(|n| n.after_id.is_none()) {
            let gap = gap(both, added.id.as_str(), removed.id.as_str());
            assert!(
                gap >= 0.0,
                "{what}: added {} overlaps removed {} by {}",
                added.id,
                removed.id,
                -gap
            );
            seen.cleared += 1;
        }
    }
}

#[test]
fn keeps_the_previous_map_on_every_corpus_case() {
    let mut total = Seen::default();
    for pair in &corpus_pairs() {
        let what = &pair.name;
        let previous = first_map(&pair.before);
        let (maps, mut seen) = walk(pair, &previous, &LayoutOptions::default());
        check_cleared(what, &maps, &mut seen);
        total.add(&seen);

        // What the after version has on its own is its own: the radii of its degrees.
        let alone = layout_graph(&pair.after, &LayoutOptions::default()).unwrap();
        assert_eq!(maps.next.radii, alone.radii, "{what}");

        // The next layout is stored in turn, and comes back as it is: the kept positions were on
        // the document's grid already, and the new ones are computed on it.
        let next = stored(&maps.next);
        for (id, p) in &maps.next.positions {
            assert!(
                same(next.positions[id.as_str()], *p),
                "{what}: {id} changed in the next layout document"
            );
        }
        // The two stored layouts are enough to lay the diff out again: the after version's
        // positions as pins, which win, and the previous ones for the removed nodes. Nothing is
        // left to place, and every node is where the diff had it.
        let from_both = LayoutOptions {
            pinned: next.positions.clone(),
            ..LayoutOptions::default()
        };
        let again = layout_diff_on(&maps.diff, &previous, &from_both).unwrap();
        assert_eq!(again.positions, maps.both.positions, "{what}");
        assert_eq!(again.radii, maps.both.radii, "{what}");
        assert_eq!(again.bounds, maps.both.bounds, "{what}");
        assert_eq!(again.stats.iterations, 0, "{what}");
        let previous = next;
        // A second step, back to the first version: its removed nodes come back as new ones.
        let back = pair.reversed();
        let (returned, mut seen) = walk(&back, &previous, &LayoutOptions::default());
        check_cleared(&back.name, &returned, &mut seen);
        total.add(&seen);
    }
    // What the corpus has to exercise for this test to mean something.
    assert!(total.continued > 2000, "continued: {}", total.continued);
    assert!(total.rekeyed >= 100, "rekeyed: {}", total.rekeyed);
    assert!(total.added >= 70, "added: {}", total.added);
    assert!(total.removed >= 70, "removed: {}", total.removed);
    assert!(total.cleared >= 200, "cleared: {}", total.cleared);
}

/// Other options, a previous layout off the grid, and the caller's own pins: on a kept node, on a
/// removed one and on a new one.
#[test]
fn keeps_the_previous_map_with_other_options_and_the_callers_pins() {
    let mut pairs = corpus_pairs();
    pairs.push(rekeyed());
    pairs.push(renumbered());
    let mut pins = 0;
    for pair in &pairs {
        let previous = shifted(&first_map(&pair.before));
        let diff = pair.diff();
        let first = |keep: fn(&kgdiff_core::model::UnionNode) -> bool| {
            diff.nodes.iter().find(|node| keep(node)).map(|n| &n.id)
        };
        let picked = [
            first(|n| n.before_id.is_some() && n.after_id.is_some()),
            first(|n| n.after_id.is_none()),
            first(|n| n.before_id.is_none()),
        ];
        let mut pinned: IndexMap<UnionId, Point> = IndexMap::default();
        for (k, id) in picked.into_iter().flatten().enumerate() {
            let at = Point {
                x: 4321.125 + 97.0 * k as f64,
                y: -1234.5,
            };
            pinned.insert(id.clone(), at);
        }
        pinned.insert(JsStr::from("not-a-node"), Point { x: 1.0, y: 2.0 });
        pins += pinned.len() - 1;
        let options = LayoutOptions {
            strategy: Some(LayoutStrategy::Anchored),
            seed: Some(7.0),
            label_aware: Some(false),
            font_size: Some(15.0),
            link_distance: Some(40.0),
            // Not read: every node is in scope.
            large_graph_threshold: Some(0.0),
            context_hops: Some(0),
            hub_degree: Some(0.0),
            pinned,
            ..LayoutOptions::default()
        };
        let (maps, _) = walk(pair, &previous, &options);
        assert!(
            !maps.next.positions.contains_key("not-a-node"),
            "{}",
            pair.name
        );

        // The options of the diff's layout are the options of the after version's: the font
        // size is in its bounds, and the pins are not read again.
        let own = LayoutOptions {
            pinned: IndexMap::default(),
            ..options.clone()
        };
        assert_eq!(
            layout_after(&maps.diff, &maps.both, &own).unwrap(),
            maps.next,
            "{}",
            pair.name
        );
    }
    assert!(pins >= 60, "pins: {pins}");
}

// ─── Ids that change, and ids given to other nodes ──────────────────────────────────────────

#[test]
fn a_node_under_another_id_keeps_its_place() {
    let pair = rekeyed();
    let previous = first_map(&pair.before);
    let (maps, mut seen) = walk(&pair, &previous, &LayoutOptions::default());
    check_cleared("rekeyed", &maps, &mut seen);
    assert_eq!((seen.continued, seen.rekeyed), (3, 3));
    assert_eq!((seen.added, seen.removed, seen.cleared), (1, 1, 1));
    let Maps { both, next, .. } = &maps;
    for (was, is) in [
        ("t_cust", "customer"),
        ("t_ord", "order"),
        ("t_ord_item", "order-line"),
    ] {
        assert!(same(both.positions[is], previous.positions[was]), "{is}");
        assert!(same(next.positions[is], previous.positions[was]), "{is}");
    }
    assert!(same(
        both.positions["t_tmp_2019"],
        previous.positions["t_tmp_2019"]
    ));
    assert!(same(next.positions["refund"], both.positions["refund"]));

    // By id, the layout of the after version knows none of its nodes: no position is known, and
    // the whole map is computed again.
    let by_id = LayoutOptions {
        pinned: previous.positions.clone(),
        ..LayoutOptions::default()
    };
    let naive = layout_graph(&pair.after, &by_id).unwrap();
    assert_eq!(naive.stats.strategy, LayoutStrategy::Union);
}

#[test]
fn an_id_given_to_another_node_does_not_carry_the_old_position() {
    let pair = renumbered();
    let previous = first_map(&pair.before);
    let (maps, mut seen) = walk(&pair, &previous, &LayoutOptions::default());
    check_cleared("renumbered", &maps, &mut seen);
    assert_eq!((seen.continued, seen.rekeyed), (3, 3));
    assert_eq!((seen.added, seen.removed, seen.cleared), (1, 1, 1));
    let Maps { diff, both, next } = &maps;

    // Ada is removed and her id is taken: her union id is an id of neither version, and she is
    // where she was.
    let ada = diff.node_by_before("n1").unwrap();
    assert_eq!(ada.id.as_str(), "n1@before");
    assert!(ada.after_id.is_none());
    assert!(same(both.positions["n1@before"], previous.positions["n1"]));
    assert!(!next.positions.contains_key("n1@before"));

    // Babbage was n2 and is n1, the engine was n3 and is n2, London was n4 and is n3: each is
    // where it was, not where the id's former owner was.
    for (was, is) in [("n2", "n1"), ("n3", "n2"), ("n4", "n3")] {
        assert_eq!(diff.node(is).unwrap().before_id.as_deref(), Some(was));
        assert!(same(both.positions[is], previous.positions[was]), "{is}");
        assert!(same(next.positions[is], previous.positions[was]), "{is}");
        assert!(!same(next.positions[is], previous.positions[is]), "{is}");
    }
    // n4 is new: it is placed, and not where the old n4 (London) is.
    assert!(diff.node("n4").unwrap().before_id.is_none());
    assert!(!same(both.positions["n4"], previous.positions["n4"]));
    assert!(gap(both, "n4", "n3") > 0.0);
    assert!(same(next.positions["n4"], both.positions["n4"]));

    // By id, every node of the after version is pinned where another node was.
    let by_id = LayoutOptions {
        pinned: previous.positions.clone(),
        ..LayoutOptions::default()
    };
    let naive = layout_graph(&pair.after, &by_id).unwrap();
    for id in ["n1", "n2", "n3", "n4"] {
        assert!(same(naive.positions[id], previous.positions[id]), "{id}");
    }
}

/// `layout_after` reads a position by union id and writes it under `after_id`. A diff of
/// kgdiff-core gives a node of the after version its own id as union id, so the two are told
/// apart here on a diff whose union ids were changed by hand.
#[test]
fn the_after_version_is_keyed_by_after_id_whatever_the_union_id() {
    let pair = renumbered();
    let previous = first_map(&pair.before);
    let mut diff = pair.diff();
    let both = layout_diff_on(&diff, &previous, &LayoutOptions::default()).unwrap();
    let expected = layout_after(&diff, &both, &LayoutOptions::default()).unwrap();

    let renamed = |id: &JsStr| JsStr::from(format!("union:{id}"));
    let mut moved = both.clone();
    moved.positions = both
        .positions
        .iter()
        .map(|(id, p)| (renamed(id), *p))
        .collect();
    for node in &mut diff.nodes {
        node.id = renamed(&node.id);
    }
    let next = layout_after(&diff, &moved, &LayoutOptions::default()).unwrap();
    assert_eq!(next, expected);
    assert_eq!(
        sorted(next.positions.keys()),
        sorted(pair.after.nodes().map(|n| n.id()))
    );
}

// ─── What the previous layout does not place ────────────────────────────────────────────────

/// The review fixture: 120 nodes with additions, removals, renames, merges and a split.
fn review() -> (Pair, DiffResult) {
    let spec = changes(17);
    let (before, after) = spec.versions();
    let pair = Pair {
        name: "review".to_owned(),
        before: graph(&before, EdgeIdentity::Structure),
        after: graph(&after, EdgeIdentity::Structure),
        options: DiffOptions {
            r#match: MatchOptions {
                strategy: MatchStrategy::Id,
                ..DiffOptions::default().r#match
            },
            ..DiffOptions::default()
        },
    };
    let diff = pair.diff();
    (pair, diff)
}

#[test]
fn a_node_the_previous_layout_does_not_place_is_placed() {
    let (pair, diff) = review();
    let full = first_map(&pair.before);

    // Every third node of the before version is missing from the previous layout.
    let mut partial = full.clone();
    partial.positions = full
        .positions
        .iter()
        .enumerate()
        .filter(|(k, _)| k % 3 != 0)
        .map(|(_, (id, p))| (id.clone(), *p))
        .collect();
    let both = layout_diff_on(&diff, &partial, &LayoutOptions::default()).unwrap();
    assert_eq!(
        both,
        diff_on_by_hand(&diff, &partial, &LayoutOptions::default()).unwrap()
    );
    assert_eq!(both.positions.len(), diff.nodes.len());
    assert_eq!(both.stats.strategy, LayoutStrategy::Anchored);
    let mut placed = 0;
    for node in &diff.nodes {
        let Some(before) = &node.before_id else {
            continue;
        };
        match partial.positions.get(before.as_str()) {
            Some(p) => assert!(same(both.positions[node.id.as_str()], *p), "{}", node.id),
            None => placed += 1,
        }
    }
    assert!(placed >= 40, "placed: {placed}");

    // Nothing known at all: the layout of the diff as it is without a previous map.
    let mut empty = full.clone();
    empty.positions = IndexMap::default();
    let free = layout_diff_on(&diff, &empty, &LayoutOptions::default()).unwrap();
    let all = LayoutOptions {
        scope: Some(LayoutScope::All),
        ..LayoutOptions::default()
    };
    assert_eq!(free, layout_diff(&diff, &all).unwrap());
    assert_eq!(free.stats.strategy, LayoutStrategy::Union);
    // Asking for `Anchored` changes its name only.
    let anchored = LayoutOptions {
        strategy: Some(LayoutStrategy::Anchored),
        ..LayoutOptions::default()
    };
    let named = layout_diff_on(&diff, &empty, &anchored).unwrap();
    assert_eq!(named.positions, free.positions);
}

/// Known positions, by priority: the caller's pin, the previous layout, the `position` on a node.
#[test]
fn the_previous_layout_wins_over_positions_on_the_nodes() {
    let at = |x, y| Some(Point { x, y });
    let node = |id: &str, status, before, after| NodeSpec {
        status,
        before_position: before,
        after_position: after,
        ..NodeSpec::new(id, id)
    };
    let spec = GraphSpec {
        nodes: vec![
            node("a", Status::Both, at(900.5, 900.5), at(-900.5, -900.5)),
            node("b", Status::Both, at(800.5, 800.5), None),
            node("c", Status::Removed, at(700.5, 700.5), None),
            node("d", Status::Added, None, at(55.125, -66.25)),
            node("e", Status::Added, None, None),
        ],
        edges: vec![
            EdgeSpec::new("a", "b"),
            EdgeSpec {
                status: Status::Removed,
                ..EdgeSpec::new("b", "c")
            },
            EdgeSpec::added("b", "d"),
            EdgeSpec::added("d", "e"),
        ],
    };
    let diff = spec.diff();
    let mut previous = first_map(&diff.before);
    previous.positions = support::points(&[("a", 10.0, 20.0), ("c", 30.0, 40.0)]);
    let options = LayoutOptions {
        pinned: support::points(&[("c", -1.5, -2.5)]),
        ..LayoutOptions::default()
    };
    let both = layout_diff_on(&diff, &previous, &options).unwrap();
    let position = |id: &str| (both.positions[id].x, both.positions[id].y);
    assert_eq!(position("a"), (10.0, 20.0)); // the previous layout, not the node
    assert_eq!(position("b"), (800.5, 800.5)); // the node, where the layout has nothing
    assert_eq!(position("c"), (-1.5, -2.5)); // the caller's pin
    assert_eq!(position("d"), (55.125, -66.25)); // a new node with a position of its own
    assert!(both.positions["e"].x.is_finite());

    // The after version takes them all from the diff, and none from its own nodes.
    let next = layout_after(&diff, &both, &options).unwrap();
    for id in ["a", "b", "d", "e"] {
        assert!(same(next.positions[id], both.positions[id]), "{id}");
    }
    assert_eq!(next.positions.len(), 4);
}

// ─── Options ────────────────────────────────────────────────────────────────────────────────

#[test]
fn every_node_is_in_scope_whatever_the_threshold() {
    let (pair, diff) = review();
    let previous = first_map(&pair.before);
    let reference = layout_diff_on(&diff, &previous, &LayoutOptions::default()).unwrap();
    let small_threshold = LayoutOptions {
        large_graph_threshold: Some(10.0),
        ..LayoutOptions::default()
    };
    // Left to itself, `layout_diff` lays out the changes only.
    let trapped = layout_diff(&diff, &small_threshold).unwrap();
    assert_eq!(trapped.scope, LayoutScope::Changes);
    assert!(trapped.positions.len() < diff.nodes.len());

    let both = layout_diff_on(&diff, &previous, &small_threshold).unwrap();
    assert_eq!(both.scope, LayoutScope::All);
    assert_eq!(support::json(&both), support::json(&reference));
    let next = layout_after(&diff, &both, &small_threshold).unwrap();
    assert_eq!(next.scope, LayoutScope::All);
    assert_eq!(next.positions.len(), pair.after.node_count());
}

/// Above the default threshold of 3,000 nodes. Slow in a debug build: the `targets` CI job runs
/// it with `cargo test --release`.
#[test]
#[cfg_attr(debug_assertions, ignore = "slow in debug builds: run with --release")]
fn a_diff_above_the_default_threshold_is_laid_out_whole() {
    let mut spec = scale_free(3500, 1.3, 11);
    for k in 0..5 {
        let id = format!("new-{k}");
        spec.nodes.push(NodeSpec::added(&id));
        spec.edges
            .push(EdgeSpec::added(&id, &format!("s{:04}", 40 * k)));
    }
    let (before, after) = spec.versions();
    let pair = Pair {
        name: "scale-free 3.5k".to_owned(),
        before: graph(&before, EdgeIdentity::Structure),
        after: graph(&after, EdgeIdentity::Structure),
        options: DiffOptions::default(),
    };
    let previous = first_map(&pair.before);
    let (maps, seen) = walk(&pair, &previous, &LayoutOptions::default());
    assert_eq!((seen.continued, seen.added), (3500, 5));
    assert_eq!(maps.both.positions.len(), 3505);
    assert_eq!(maps.next.positions.len(), 3505);
}

#[test]
fn rejects_the_options_that_would_not_keep_the_map() {
    let (pair, diff) = review();
    let previous = first_map(&pair.before);
    let both = layout_diff_on(&diff, &previous, &LayoutOptions::default()).unwrap();

    let changes = LayoutOptions {
        scope: Some(LayoutScope::Changes),
        ..LayoutOptions::default()
    };
    let error = expect_invalid(
        layout_diff_on(&diff, &previous, &changes),
        "Invalid layout option scope: expected 'all' (a layout on the previous version's map \
         places every node), got changes",
    );
    let details = error.details.unwrap();
    assert_eq!(details.get("option").and_then(Value::as_str), Some("scope"));
    assert_eq!(
        details.get("value").and_then(Value::as_str),
        Some("changes")
    );
    expect_invalid(
        layout_after(&diff, &both, &changes),
        "Invalid layout option scope: expected 'all' (the layout of one graph has no changes \
         to select), got changes",
    );

    // `Union` ignores every known position: the whole map would be computed again.
    let union = LayoutOptions {
        strategy: Some(LayoutStrategy::Union),
        ..LayoutOptions::default()
    };
    let error = expect_invalid(
        layout_diff_on(&diff, &previous, &union),
        "Invalid layout option strategy: expected 'anchored' (the positions of the previous \
         version's layout are kept), got union",
    );
    let details = error.details.unwrap();
    assert_eq!(
        details.get("option").and_then(Value::as_str),
        Some("strategy")
    );
    assert_eq!(details.get("value").and_then(Value::as_str), Some("union"));
    expect_invalid(
        layout_after(&diff, &both, &union),
        "Invalid layout option strategy: expected 'anchored' (the positions of the diff's \
         layout are kept), got union",
    );

    // What `layout_diff` rejects is rejected with its message.
    let all = |options: &LayoutOptions| LayoutOptions {
        scope: Some(LayoutScope::All),
        ..options.clone()
    };
    for options in [
        LayoutOptions {
            link_distance: Some(0.0),
            ..LayoutOptions::default()
        },
        LayoutOptions {
            seed: Some(f64::NAN),
            ..LayoutOptions::default()
        },
        LayoutOptions {
            hub_degree: Some(-1.0),
            ..LayoutOptions::default()
        },
        LayoutOptions {
            pinned: support::points(&[("t0000", f64::INFINITY, 0.0)]),
            ..LayoutOptions::default()
        },
    ] {
        let expected = layout_diff(&diff, &all(&options)).unwrap_err();
        let error = layout_diff_on(&diff, &previous, &options).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid-input");
        assert_eq!(error.message, expected.message);
        if options.pinned.is_empty() {
            let error = layout_after(&diff, &both, &options).unwrap_err();
            assert_eq!(error.message, expected.message);
        } else {
            // The pins of the options are not read.
            assert_eq!(
                layout_after(&diff, &both, &options).unwrap(),
                layout_after(&diff, &both, &LayoutOptions::default()).unwrap()
            );
        }
    }
}

/// With every position given, what is left of the options is the font size, which sizes the
/// label boxes the bounds include.
#[test]
fn only_the_font_size_shows_in_the_after_version() {
    let (pair, diff) = review();
    let previous = first_map(&pair.before);
    let both = layout_diff_on(&diff, &previous, &LayoutOptions::default()).unwrap();
    let next = layout_after(&diff, &both, &LayoutOptions::default()).unwrap();

    let others = LayoutOptions {
        strategy: Some(LayoutStrategy::Anchored),
        scope: Some(LayoutScope::All),
        seed: Some(99.0),
        iterations: Some(5),
        link_distance: Some(200.0),
        label_aware: Some(false),
        component_gap: Some(0.0),
        large_graph_threshold: Some(0.0),
        context_hops: Some(0),
        hub_degree: Some(0.0),
        pinned: support::points(&[("t0000", 1.0, 2.0), ("not-a-node", 3.0, 4.0)]),
        ..LayoutOptions::default()
    };
    assert_eq!(layout_after(&diff, &both, &others).unwrap(), next);

    let larger = LayoutOptions {
        font_size: Some(24.0),
        ..LayoutOptions::default()
    };
    let with_larger_labels = layout_after(&diff, &both, &larger).unwrap();
    assert_eq!(with_larger_labels.positions, next.positions);
    assert_eq!(with_larger_labels.radii, next.radii);
    assert!(with_larger_labels.bounds.width > next.bounds.width);
    assert!(with_larger_labels.bounds.height > next.bounds.height);
}

/// Every node of the after version needs a position in the diff's layout: with one missing, the
/// after version would get a place for it that the diff does not have.
#[test]
fn rejects_a_layout_that_does_not_place_the_after_version() {
    let (pair, diff) = review();
    let previous = first_map(&pair.before);
    let both = layout_diff_on(&diff, &previous, &LayoutOptions::default()).unwrap();

    // A layout of the changes only.
    let changes = LayoutOptions {
        scope: Some(LayoutScope::Changes),
        context_hops: Some(0),
        ..LayoutOptions::default()
    };
    let focused = layout_diff(&diff, &changes).unwrap();
    assert!(focused.positions.len() < diff.nodes.len());
    let missing = diff
        .nodes
        .iter()
        .find(|n| n.after_id.is_some() && !focused.positions.contains_key(n.id.as_str()))
        .unwrap();
    let error = expect_invalid(
        layout_after(&diff, &focused, &LayoutOptions::default()),
        &format!(
            "layout_after: the layout has no position for node \"{0}\" of the diff, which is \
             \"{0}\" in the after version",
            missing.id
        ),
    );
    let details = error.details.unwrap();
    assert_eq!(
        details.get("node").and_then(Value::as_str),
        Some(missing.id.as_str())
    );

    // The layout of another diff: the before version's own.
    let error = layout_after(&diff, &previous, &LayoutOptions::default()).unwrap_err();
    assert_eq!(error.code.as_str(), "invalid-input");
    assert!(error.message.starts_with("layout_after: "));

    // A removed node needs none.
    let mut without_removed = both.clone();
    without_removed.positions = diff
        .nodes
        .iter()
        .filter(|n| n.after_id.is_some())
        .map(|n| (n.id.clone(), both.positions[n.id.as_str()]))
        .collect();
    assert!(without_removed.positions.len() < both.positions.len());
    assert_eq!(
        layout_after(&diff, &without_removed, &LayoutOptions::default()).unwrap(),
        layout_after(&diff, &both, &LayoutOptions::default()).unwrap()
    );
}

#[test]
fn empty_versions() {
    let (pair, _) = review();
    let empty = graph(&GraphSpec::default().versions().1, EdgeIdentity::Structure);
    let options = LayoutOptions::default();

    // From nothing: no previous position, the layout of the diff.
    let first = Pair {
        name: "from nothing".to_owned(),
        before: empty.clone(),
        after: pair.after.clone(),
        options: DiffOptions::default(),
    };
    let (maps, seen) = walk(&first, &first_map(&empty), &options);
    assert_eq!(seen.added, pair.after.node_count());
    assert_eq!(maps.both.stats.strategy, LayoutStrategy::Union);
    assert_eq!(
        support::json(&maps.both),
        support::json(&layout_graph(&pair.after, &options).unwrap())
    );

    // To nothing: every node stays where it was, and the after version has no node.
    let last = Pair {
        name: "to nothing".to_owned(),
        before: pair.after.clone(),
        after: empty.clone(),
        options: DiffOptions::default(),
    };
    let previous = stored(&maps.next);
    let (maps, seen) = walk(&last, &previous, &options);
    assert_eq!(seen.removed, pair.after.node_count());
    assert_eq!(maps.both.positions, previous.positions);
    assert!(maps.next.positions.is_empty());
    assert_eq!(maps.next.stats.strategy, LayoutStrategy::Union);
}
