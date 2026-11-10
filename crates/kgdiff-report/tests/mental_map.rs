//! One mental map, end to end (RFC 0003, parts 1 and 2, and the promise both serve): going from
//! a version of a graph to the next version, and from either to the diff of the two, moves no
//! node. `layout_graph`, the layout document, `layout_diff` and `report_payload_with` each have
//! their own tests; this one walks the chain an embedding application walks, with the functions
//! of `examples/embedding.rs` (which `docs/guide/embedding.md` quotes), on both graphs of every
//! corpus case and on a pair whose ids are reused:
//!
//! 1. the before version is laid out, and its layout stored as a document and read back;
//! 2. the after version is laid out with those positions: a node that continues a before node
//!    stays where it was, bit for bit, and only the new nodes are placed;
//! 3. the diff is laid out with the positions of both versions: every union node is where its
//!    version has it, and a removed node stays where the before version had it;
//! 4. the report payload carries that layout byte for byte, validates against
//!    `report.v1.json`, and reads back as the diff and the layout it was made from.
//!
//! Positions are carried through the diff (a union node's `before_id` and `after_id`), because
//! a union id is not always an id of either version. What carrying them by id does instead is
//! pinned down below, so that the guide's warning stays true.

#[path = "../examples/embedding.rs"]
mod host;
#[path = "support/schema.rs"]
mod schema;

use std::path::{Path, PathBuf};

use kgdiff_core::js::{IndexMap, JsStr, Object, Value, json};
use kgdiff_core::model::{HunkKind, Point};
use kgdiff_core::{
    DiffOptions, DiffResult, KGraph, MatchStrategy, NormalizeOptions, diff_from_json, diff_graphs,
    graph_to_json, hash_graph, normalize, resolve_options, unpack_diff_json,
};
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, LayoutStrategy, layout_diff, layout_from_json,
    layout_graph, layout_to_json,
};
use kgdiff_report::{ReportInfo, ViewerBundles, needs_compute, report_payload};
use schema::Schemas;

const REPORT: &str = "report.v1.json";

// ─── The pairs ──────────────────────────────────────────────────────────────────────────────

/// Two versions of a graph and the options they are diffed with.
struct Pair {
    name: String,
    before: KGraph,
    after: KGraph,
    options: DiffOptions,
}

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn read(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    json::parse(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn graph(value: &Value, options: &DiffOptions) -> KGraph {
    let options = NormalizeOptions {
        edge_identity: options.edge_identity,
        ..NormalizeOptions::default()
    };
    normalize(value, options).expect("a valid graph")
}

/// Every case of the corpus: its two parsed graphs and its diff options.
fn corpus_pairs() -> Vec<Pair> {
    let manifest = read(&corpus().join("manifest.json"));
    let cases = manifest.get("cases").and_then(Value::as_array).unwrap();
    cases
        .iter()
        .map(|entry| {
            let id = entry.get("id").and_then(Value::as_str).unwrap();
            let dir = corpus().join("cases").join(id);
            let spec = read(&dir.join("case.json"));
            let options = resolve_options(spec.get("options")).unwrap();
            let side = |side: &str| {
                let parsed = read(&dir.join(format!("expected/parse.{side}.json")));
                graph(parsed.get("graph").unwrap(), &options)
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

/// A pair as an extraction without stable ids gives it: the ids are renumbered, so `n1` and
/// `n2` name other things in the after version, and the removed `n1` gets a union id that is an
/// id of neither version (`n1@before`). The corpus has no such collision.
fn renumbered() -> Pair {
    let options = DiffOptions {
        r#match: kgdiff_core::MatchOptions {
            strategy: MatchStrategy::Similarity,
            ..DiffOptions::default().r#match
        },
        ..DiffOptions::default()
    };
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
    Pair {
        name: "renumbered ids".to_owned(),
        before: graph(&json::parse(before).unwrap(), &options),
        after: graph(&json::parse(after).unwrap(), &options),
        options,
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────

fn same(a: Point, b: Point) -> bool {
    a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits()
}

fn document(layout: &LayoutResult) -> String {
    json::to_string(&layout_to_json(layout))
}

fn sorted<'a>(ids: impl Iterator<Item = &'a JsStr>) -> Vec<&'a JsStr> {
    let mut ids: Vec<&JsStr> = ids.collect();
    ids.sort();
    ids
}

fn info() -> ReportInfo {
    host::report_info("v1 → v2", "v1", "v2")
}

const STUBS: ViewerBundles<'static> = ViewerBundles {
    main: "/* viewer */",
    compute: Some("/* compute */"),
};

/// The JSON text of a position in a layout document: what a page reads.
fn written(document: &Value, id: &str) -> String {
    let position = document
        .get("positions")
        .and_then(|positions| positions.get(id))
        .unwrap_or_else(|| panic!("no position for {id}"));
    json::to_string(position)
}

// ─── The chain ──────────────────────────────────────────────────────────────────────────────

/// What a walk of the chain saw, to check that the pairs cover what they are meant to.
#[derive(Default)]
struct Seen {
    /// Union nodes in both versions (kept in place).
    continued: usize,
    /// Of them, those whose id changed.
    rekeyed: usize,
    added: usize,
    removed: usize,
    /// Removed nodes whose union id is not their before id.
    renamed_removed: usize,
    merges: usize,
    splits: usize,
}

impl Seen {
    fn add(&mut self, other: &Seen) {
        self.continued += other.continued;
        self.rekeyed += other.rekeyed;
        self.added += other.added;
        self.removed += other.removed;
        self.renamed_removed += other.renamed_removed;
        self.merges += other.merges;
        self.splits += other.splits;
    }
}

/// The three layouts of a pair, as the chain computes them.
struct Maps {
    diff: DiffResult,
    /// The before version's, read back from its document.
    previous: LayoutResult,
    /// The after version's.
    next: LayoutResult,
    /// The diff's.
    both: LayoutResult,
}

/// Steps 1 to 4 on one pair.
fn walk(pair: &Pair, schemas: &Schemas) -> (Maps, Seen) {
    let what = &pair.name;
    let mut seen = Seen::default();

    // 1. The before version, its layout document, and the document read back.
    let (first, stored) = host::first_map(&pair.before).unwrap_or_else(|e| panic!("{what}: {e}"));
    let previous = host::stored_map(&stored).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(first.scope, LayoutScope::All, "{what}");
    assert_eq!(
        sorted(previous.positions.keys()),
        sorted(pair.before.nodes.keys()),
        "{what}: every before node has a stored position"
    );
    for (id, p) in &first.positions {
        assert!(
            same(previous.positions[id.as_str()], *p),
            "{what}: {id} changed in the layout document"
        );
    }
    assert_eq!(
        document(&previous),
        stored,
        "{what}: the document round-trips"
    );

    // 2. The after version on that map.
    let diff = diff_graphs(
        pair.before.clone(),
        pair.after.clone(),
        pair.options.clone(),
    )
    .unwrap_or_else(|e| panic!("{what}: {e}"));
    let next = host::next_map(&diff, &previous).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(next.scope, LayoutScope::All, "{what}");
    assert_eq!(
        sorted(next.positions.keys()),
        sorted(pair.after.nodes.keys()),
        "{what}: every after node has a position"
    );
    for node in &diff.nodes {
        match (&node.before_id, &node.after_id) {
            (Some(before), Some(after)) => {
                seen.continued += 1;
                seen.rekeyed += usize::from(before != after);
                assert!(
                    same(
                        next.positions[after.as_str()],
                        previous.positions[before.as_str()]
                    ),
                    "{what}: {before} → {after} moved between the versions"
                );
            }
            (None, Some(after)) => {
                seen.added += 1;
                let p = next.positions[after.as_str()];
                assert!(
                    p.x.is_finite() && p.y.is_finite(),
                    "{what}: {after} at {p:?}"
                );
            }
            (Some(before), None) => {
                seen.removed += 1;
                seen.renamed_removed += usize::from(*before != node.id);
            }
            (None, None) => panic!("{what}: union node {} is in neither version", node.id),
        }
    }
    let expected = if seen.continued > 0 {
        LayoutStrategy::Anchored
    } else {
        LayoutStrategy::Union
    };
    assert_eq!(next.stats.strategy, expected, "{what}");
    // The next version's layout can be stored in turn: the kept positions were on the
    // document's grid already, and the new ones are computed on it.
    let reread = layout_from_json(&json::parse(&document(&next)).unwrap()).unwrap();
    for (id, p) in &next.positions {
        assert!(
            same(reread.positions[id.as_str()], *p),
            "{what}: {id} changed in the next layout document"
        );
    }

    // Either version on its own, as a page that draws one graph gets it: a payload of the
    // unchanged diff with the version's layout.
    for (graph, layout) in [(&pair.before, &previous), (&pair.after, &next)] {
        let plain =
            host::graph_payload(graph, layout, &info()).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(
            plain.get("layout").map(json::to_string),
            Some(document(layout)),
            "{what}: the layout of one version's payload"
        );
        assert_eq!(
            schemas.errors(REPORT, &plain),
            Vec::<String>::new(),
            "{what}"
        );
        let unchanged = diff_from_json(&unpack_diff_json(plain.get("diff").unwrap()).unwrap());
        assert!(unchanged.unwrap().stats.identical, "{what}");
    }

    // 3. The diff on the maps of both versions.
    let both = host::diff_map(&diff, &previous, &next).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(both.scope, LayoutScope::All, "{what}");
    assert!(both.hidden.is_empty(), "{what}");
    assert_eq!(
        sorted(both.positions.keys()),
        sorted(diff.nodes.iter().map(|node| &node.id)),
        "{what}: every union node has a position"
    );
    for node in &diff.nodes {
        let at = both.positions[node.id.as_str()];
        if let Some(after) = &node.after_id {
            assert!(
                same(at, next.positions[after.as_str()]),
                "{what}: {} is not where the after version has {after}",
                node.id
            );
        }
        if let Some(before) = &node.before_id {
            assert!(
                same(at, previous.positions[before.as_str()]),
                "{what}: {} is not where the before version had {before}",
                node.id
            );
        }
    }
    if !diff.nodes.is_empty() {
        assert_eq!(both.stats.strategy, LayoutStrategy::Anchored, "{what}");
        assert_eq!(
            both.stats.iterations, 0,
            "{what}: nothing was left to place"
        );
    }

    // 4. The report with that layout.
    let layout_document = layout_to_json(&both);
    let payload = host::report(&diff, &both, &info()).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(
        payload.get("layout").map(json::to_string),
        Some(json::to_string(&layout_document)),
        "{what}: the payload's layout"
    );
    assert_eq!(
        schemas.errors(REPORT, &payload),
        Vec::<String>::new(),
        "{what}"
    );
    assert!(!needs_compute(&payload), "{what}");
    // What a page reads from the payload is what the stored map of step 1 said, as text.
    let stored_document = json::parse(&stored).unwrap();
    for node in &diff.nodes {
        if let Some(before) = &node.before_id {
            assert_eq!(
                written(payload.get("layout").unwrap(), node.id.as_str()),
                written(&stored_document, before.as_str()),
                "{what}: {} in the report",
                node.id
            );
        }
    }
    // And the payload reads back as the diff and the layout it was made from.
    let text = json::to_string(&payload);
    let reread = json::parse(&text).unwrap();
    let packed = reread.get("diff").unwrap();
    let diff_read = diff_from_json(&unpack_diff_json(packed).unwrap()).unwrap();
    let layout_read = layout_from_json(reread.get("layout").unwrap()).unwrap();
    assert_eq!(diff_read.nodes.len(), diff.nodes.len(), "{what}");
    for node in &diff_read.nodes {
        assert!(
            same(
                layout_read.positions[node.id.as_str()],
                both.positions[node.id.as_str()]
            ),
            "{what}: {} read back from the report",
            node.id
        );
    }
    let page = host::report_page(&diff, &both, &info(), STUBS).unwrap();
    assert!(page.contains("/* viewer */"), "{what}");
    assert!(
        !page.contains("/* compute */"),
        "{what}: a full layout needs no compute add-on"
    );

    for hunk in &diff.hunks {
        seen.merges += usize::from(hunk.kind == HunkKind::Merge);
        seen.splits += usize::from(hunk.kind == HunkKind::Split);
    }
    let maps = Maps {
        diff,
        previous,
        next,
        both,
    };
    (maps, seen)
}

#[test]
fn a_version_its_successor_and_their_diff_share_one_map_on_every_corpus_case() {
    let schemas = Schemas::load();
    let pairs = corpus_pairs();
    assert_eq!(pairs.len(), 29);
    let mut total = Seen::default();
    for pair in &pairs {
        let (_, seen) = walk(pair, &schemas);
        total.add(&seen);
    }
    // What the corpus has to exercise for this test to mean something.
    assert!(total.continued > 1000, "continued: {}", total.continued);
    assert!(total.rekeyed >= 50, "rekeyed: {}", total.rekeyed);
    assert!(total.added >= 50, "added: {}", total.added);
    assert!(total.removed >= 20, "removed: {}", total.removed);
    assert!(total.merges >= 10, "merges: {}", total.merges);
    assert!(total.splits >= 4, "splits: {}", total.splits);
}

#[test]
fn ids_reused_for_other_nodes_keep_the_map_too() {
    let pair = renumbered();
    let (maps, seen) = walk(&pair, &Schemas::load());
    let Maps {
        diff,
        previous,
        next,
        both,
    } = &maps;
    // Babbage, the engine and London continue under other ids; Ada is removed, and her id is
    // taken, so her union id is an id of neither version.
    assert_eq!(seen.continued, 3);
    assert_eq!(seen.rekeyed, 3);
    assert_eq!((seen.added, seen.removed, seen.renamed_removed), (1, 1, 1));
    let ada = diff.node_by_before("n1").unwrap();
    assert_eq!(ada.id.as_str(), "n1@before");
    assert!(ada.after_id.is_none());
    assert!(same(both.positions["n1@before"], previous.positions["n1"]));
    // Babbage was n2 and is n1: he is where n2 was, not where the old n1 (Ada) was.
    assert_eq!(diff.node("n1").unwrap().before_id.as_deref(), Some("n2"));
    assert!(same(next.positions["n1"], previous.positions["n2"]));
    assert!(same(both.positions["n1"], previous.positions["n2"]));
    assert!(!same(both.positions["n1"], both.positions["n1@before"]));
}

// ─── What carrying positions by id does ─────────────────────────────────────────────────────

/// The after version laid out with the stored positions as they are, keyed by the before
/// version's ids: the short form in kgdiff-layout's README, right when ids are stable.
fn by_id(pair: &Pair, previous: &LayoutResult) -> LayoutResult {
    let options = LayoutOptions {
        pinned: previous.positions.clone(),
        ..LayoutOptions::default()
    };
    layout_graph(&pair.after, &options).unwrap()
}

#[test]
fn positions_carried_by_id_keep_only_the_nodes_whose_id_is_stable() {
    let schemas = Schemas::load();
    let (mut kept, mut moved) = (0, 0);
    for pair in &corpus_pairs() {
        let what = &pair.name;
        let (maps, _) = walk(pair, &schemas);
        let naive = by_id(pair, &maps.previous);
        for node in &maps.diff.nodes {
            let (Some(before), Some(after)) = (&node.before_id, &node.after_id) else {
                continue;
            };
            let stays = same(
                naive.positions[after.as_str()],
                maps.previous.positions[before.as_str()],
            );
            if before == after {
                assert!(stays, "{what}: {after} kept its id and moved");
                kept += 1;
            } else {
                // The layout of one graph cannot know that `after` continues `before`: it is a
                // new node to it, and gets a new place.
                assert!(!stays, "{what}: {before} → {after} stayed, carried by id");
                moved += 1;
            }
        }
        let stable = |n: &kgdiff_core::model::UnionNode| {
            n.before_id.is_none() || n.after_id.is_none() || n.before_id == n.after_id
        };
        if maps.diff.nodes.iter().all(stable) {
            // With stable ids both ways are one: pins for nodes that are gone are not read.
            assert_eq!(document(&naive), document(&maps.next), "{what}");
        }
    }
    assert!(kept > 1000, "kept: {kept}");
    assert!(moved >= 50, "moved: {moved}");

    // Worse than a node that moves: a reused id pins another node to the old one's place.
    let pair = renumbered();
    let (maps, _) = walk(&pair, &schemas);
    let naive = by_id(&pair, &maps.previous);
    assert!(same(naive.positions["n1"], maps.previous.positions["n1"]));
    assert!(!same(naive.positions["n1"], maps.next.positions["n1"]));
}

// ─── The other order: the diff first ────────────────────────────────────────────────────────

/// The distance between two discs (negative when they overlap).
fn gap(layout: &LayoutResult, a: &str, b: &str) -> f64 {
    let (p, q) = (layout.positions[a], layout.positions[b]);
    let (dx, dy) = (p.x - q.x, p.y - q.y);
    (dx * dx + dy * dy).sqrt() - layout.radii[a] - layout.radii[b]
}

/// The after version's own layout (step 2) cannot see the removed nodes, so it may put a new
/// node where one of them was: in `dataset-data-lineage` the discs of an added and a removed
/// node overlap by 0.16 in the diff of step 3. Laying the diff out first, with the before
/// version's positions, keeps the same map and places the new nodes clear of the removed ones.
#[test]
fn the_diff_laid_out_first_keeps_the_map_and_clears_the_removed_nodes() {
    let schemas = Schemas::load();
    let mut pairs = corpus_pairs();
    pairs.push(renumbered());
    let mut checked = 0;
    for pair in &pairs {
        let what = &pair.name;
        let (maps, _) = walk(pair, &schemas);
        let Maps { diff, previous, .. } = &maps;
        let both = host::diff_map_first(diff, previous).unwrap_or_else(|e| panic!("{what}: {e}"));
        let next = host::next_map_of(diff, &both).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(both.scope, LayoutScope::All, "{what}");
        assert_eq!(
            sorted(both.positions.keys()),
            sorted(diff.nodes.iter().map(|node| &node.id)),
            "{what}"
        );
        assert_eq!(
            sorted(next.positions.keys()),
            sorted(pair.after.nodes.keys()),
            "{what}"
        );
        for node in &diff.nodes {
            let at = both.positions[node.id.as_str()];
            if let Some(before) = &node.before_id {
                assert!(
                    same(at, previous.positions[before.as_str()]),
                    "{what}: {} is not where the before version had {before}",
                    node.id
                );
            }
            if let Some(after) = &node.after_id {
                // What `next_map_of` relies on.
                assert_eq!(&node.id, after, "{what}: the union id of an after node");
                assert!(
                    same(next.positions[after.as_str()], at),
                    "{what}: {after} is not where the diff has it"
                );
            }
        }
        for added in diff.nodes.iter().filter(|n| n.before_id.is_none()) {
            for removed in diff.nodes.iter().filter(|n| n.after_id.is_none()) {
                let gap = gap(&both, added.id.as_str(), removed.id.as_str());
                assert!(
                    gap >= 0.0,
                    "{what}: added {} overlaps removed {} by {}",
                    added.id,
                    removed.id,
                    -gap
                );
                checked += 1;
            }
        }
        let payload = host::report(diff, &both, &info()).unwrap();
        assert_eq!(
            schemas.errors(REPORT, &payload),
            Vec::<String>::new(),
            "{what}"
        );
    }
    assert!(
        checked >= 100,
        "pairs of an added and a removed node: {checked}"
    );
}

// ─── Positions on the nodes instead of pins ─────────────────────────────────────────────────

/// `graph` with `positions` written on its nodes, as an application that keeps positions in its
/// export writes them.
fn with_positions(graph: &KGraph, positions: &IndexMap<JsStr, Point>) -> KGraph {
    let Value::Object(mut value) = graph_to_json(graph) else {
        panic!("a graph document is an object");
    };
    let Some(Value::Array(nodes)) = value.get_mut("nodes") else {
        panic!("a graph document has nodes");
    };
    for node in nodes {
        let Value::Object(node) = node else {
            panic!("a node is an object");
        };
        let id = node.get("id").and_then(Value::as_str).unwrap().to_owned();
        if let Some(p) = positions.get(id.as_str()) {
            let mut point = Object::new();
            point.insert("x", p.x);
            point.insert("y", p.y);
            node.insert("position", Value::Object(point));
        }
    }
    let value = Value::Object(value);
    let options = NormalizeOptions {
        edge_identity: graph.edge_identity,
        ..NormalizeOptions::default()
    };
    let positioned = normalize(&value, options).unwrap();
    assert_eq!(hash_graph(&positioned), hash_graph(graph));
    positioned
}

#[test]
fn positions_on_the_nodes_say_what_pins_say() {
    let schemas = Schemas::load();
    let mut pairs = corpus_pairs();
    pairs.push(renumbered());
    for pair in &pairs {
        let what = &pair.name;
        let (maps, _) = walk(pair, &schemas);
        let Maps {
            diff,
            previous,
            next,
            both,
        } = &maps;

        // The after version with the carried positions on its nodes, and no pins.
        let carried: IndexMap<JsStr, Point> = diff
            .nodes
            .iter()
            .filter_map(|node| {
                let (before, after) = (node.before_id.as_ref()?, node.after_id.as_ref()?);
                Some((after.clone(), previous.positions[before.as_str()]))
            })
            .collect();
        let after = with_positions(&pair.after, &carried);
        let on_nodes = layout_graph(&after, &LayoutOptions::default()).unwrap();
        assert_eq!(
            document(&on_nodes),
            document(next),
            "{what}: the after version"
        );

        // Both versions exported with their positions: the default layout of their diff is the
        // map, and so is the default report's (the corpus is below the large-graph threshold).
        let before = with_positions(&pair.before, &previous.positions);
        let after = with_positions(&pair.after, &next.positions);
        let positioned = diff_graphs(before, after, pair.options.clone()).unwrap();
        let default = layout_diff(&positioned, &LayoutOptions::default()).unwrap();
        assert_eq!(document(&default), document(both), "{what}: the diff");
        assert_eq!(
            json::to_string(&report_payload(&positioned, &info())),
            json::to_string(&host::report(diff, both, &info()).unwrap()),
            "{what}: the report"
        );
    }
}

// ─── The example and the guide ──────────────────────────────────────────────────────────────

#[test]
fn the_example_runs() {
    host::main().unwrap();
    let v1 = host::read_graph(r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[]}"#).unwrap();
    let v2 = host::read_graph(r#"{"nodes":[{"id":"a"},{"id":"c"}],"edges":[]}"#).unwrap();
    let diff = host::changes(&v1, &v2).unwrap();
    let (text, markdown) = host::summaries(&diff, "v1 → v2").unwrap();
    assert!(text.starts_with("kgdiff  v1 → v2"));
    assert!(markdown.starts_with("## kgdiff · v1 → v2"));
}

/// The Rust code blocks of a Markdown file.
fn rust_blocks(markdown: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut open: Option<Vec<&str>> = None;
    for line in markdown.lines() {
        match &mut open {
            None if line == "```rust" => open = Some(Vec::new()),
            None => {}
            Some(lines) if line == "```" => {
                blocks.push(lines.join("\n"));
                open = None;
            }
            Some(lines) => lines.push(line),
        }
    }
    assert!(open.is_none(), "an unclosed code block");
    blocks
}

#[test]
fn the_guide_quotes_the_example() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let example = std::fs::read_to_string(root.join("crates/kgdiff-report/examples/embedding.rs"))
        .unwrap()
        .replace("\r\n", "\n");
    for guide in ["docs/guide/embedding.md", "docs/zh/guide/embedding.md"] {
        let markdown = std::fs::read_to_string(root.join(guide))
            .unwrap_or_else(|e| panic!("{guide}: {e}"))
            .replace("\r\n", "\n");
        let blocks = rust_blocks(&markdown);
        assert!(blocks.len() >= 5, "{guide}: {} Rust blocks", blocks.len());
        for block in blocks {
            assert!(
                example.contains(&block),
                "{guide} has Rust code that is not in examples/embedding.rs:\n{block}"
            );
        }
    }
}
