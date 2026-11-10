//! Hunk ids (docs/algorithms.md §7, "Hunk ids"): the rule, what leaves an id alone and what
//! moves it. Hosts store review progress under these ids, so the rule is a contract; the cases
//! are those of `packages/core/test/hunk-ids.test.ts`.

mod support;

use kgdiff_core::js::{JsStr, Object, Value, json};
use kgdiff_core::{DiffOptions, DiffResult, EdgeIdentity, MatchStrategy, diff};
use proptest::prelude::*;
use support::{EdgeIn, GraphIn, NodeIn};

fn config() -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(150);
    ProptestConfig {
        cases,
        ..ProptestConfig::default()
    }
}

fn matching(strategy: MatchStrategy) -> DiffOptions {
    let mut options = DiffOptions::default();
    options.r#match.strategy = strategy;
    options
}

fn plain() -> DiffOptions {
    DiffOptions {
        detect_merges: false,
        detect_splits: false,
        ..matching(MatchStrategy::Id)
    }
}

fn edge_id() -> DiffOptions {
    DiffOptions {
        edge_identity: EdgeIdentity::Id,
        ..DiffOptions::default()
    }
}

/// The variants of `diff_properties.rs`.
fn variants() -> Vec<DiffOptions> {
    vec![
        DiffOptions::default(),
        matching(MatchStrategy::Similarity),
        edge_id(),
        plain(),
    ]
}

fn variant() -> impl Strategy<Value = DiffOptions> {
    prop::sample::select(variants())
}

/// Matching by id: no edit changes how another node is matched.
fn id_variant() -> impl Strategy<Value = DiffOptions> {
    prop::sample::select(vec![matching(MatchStrategy::Id), plain()])
}

/// Where equal ids are one node: `auto` and `id`.
fn same_id_variant() -> impl Strategy<Value = DiffOptions> {
    prop::sample::select(vec![
        DiffOptions::default(),
        edge_id(),
        plain(),
        matching(MatchStrategy::Id),
    ])
}

fn graph(text: &str) -> Value {
    json::parse(text).unwrap()
}

/// The hunk ids of a diff, sorted: a set, without the review order.
fn ids(before: &Value, after: &Value, options: &DiffOptions) -> Vec<String> {
    let d = diff(before, after, options).unwrap();
    let mut ids: Vec<JsStr> = d.hunks.iter().map(|h| h.id.clone()).collect();
    ids.sort();
    ids.iter().map(ToString::to_string).collect()
}

fn ids_of(before: &str, after: &str, options: &DiffOptions) -> Vec<String> {
    ids(&graph(before), &graph(after), options)
}

/// What `to` has and `from` has not (`+id`), and the reverse (`-id`).
fn changes(from: &[String], to: &[String]) -> Vec<String> {
    let gone = from
        .iter()
        .filter(|id| !to.contains(id))
        .map(|id| format!("-{id}"));
    let new = to
        .iter()
        .filter(|id| !from.contains(id))
        .map(|id| format!("+{id}"));
    gone.chain(new).collect()
}

/// The ids of `from` that `to` has not, and the ids of `to` that `from` has not.
fn moved(from: &DiffResult, to: &DiffResult) -> (Vec<JsStr>, Vec<JsStr>) {
    let only = |x: &DiffResult, y: &DiffResult| -> Vec<JsStr> {
        x.hunks
            .iter()
            .filter(|h| y.hunk(&h.id).is_none())
            .map(|h| h.id.clone())
            .collect()
    };
    (only(from, to), only(to, from))
}

/// The ids of the nodes that both versions have.
fn in_both(a: &GraphIn, b: &GraphIn) -> Vec<String> {
    b.nodes
        .iter()
        .filter(|n| a.nodes.iter().any(|m| m.id == n.id))
        .map(|n| n.id.clone())
        .collect()
}

/// `list` with `from` replaced by `to`, sorted.
fn changed(list: &[&str], from: &str, to: &str) -> Vec<String> {
    let mut out: Vec<String> = list
        .iter()
        .map(|id| if *id == from { to } else { id }.to_owned())
        .collect();
    out.sort();
    out
}

fn with(list: &[&str], more: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = list.iter().chain(more).map(|id| (*id).to_owned()).collect();
    out.sort();
    out
}

// One hunk of each kind: `m-curie` merges into `curie`, `physics` splits off `nuclear`, `lab`
// and `bench` are new, `old` and `older` are gone, `sorbonne` is renamed and `paris` gets an
// edge.
const KINDS_BEFORE: &str = r#"{"nodes":[
  {"id":"paris","label":"Paris"},{"id":"curie","label":"Marie Curie"},
  {"id":"m-curie","label":"M. Curie"},{"id":"sorbonne","label":"Sorbonne"},
  {"id":"radium","label":"Radium"},{"id":"physics","label":"Physics"},
  {"id":"old","label":"Old"},{"id":"older","label":"Older"}],
"edges":[
  {"source":"curie","target":"paris","predicate":"livesIn"},
  {"source":"old","target":"older","predicate":"p"},
  {"source":"old","target":"paris","predicate":"p"},
  {"source":"physics","target":"radium","predicate":"studies"},
  {"source":"physics","target":"paris","predicate":"taughtIn"}]}"#;
const KINDS_AFTER: &str = r#"{"nodes":[
  {"id":"paris","label":"Paris"},{"id":"curie","label":"Marie Curie","replaces":["m-curie"]},
  {"id":"sorbonne","label":"Sorbonne University"},{"id":"radium","label":"Radium"},
  {"id":"physics","label":"Physics"},
  {"id":"nuclear","label":"Nuclear physics","replaces":["physics"]},
  {"id":"lab","label":"Lab"},{"id":"bench","label":"Bench"}],
"edges":[
  {"source":"curie","target":"paris","predicate":"livesIn"},
  {"source":"lab","target":"bench","predicate":"has"},
  {"source":"lab","target":"paris","predicate":"in"},
  {"source":"nuclear","target":"radium","predicate":"studies"},
  {"source":"physics","target":"paris","predicate":"taughtIn"},
  {"source":"paris","target":"radium","predicate":"exhibits"}]}"#;

// A base and a head under review: `a` is renamed, `old` is gone, `n1` and `n2` are new and
// `c` gets an edge.
const BASE: &str = r#"{"nodes":[
  {"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"},
  {"id":"d","label":"D"},{"id":"old","label":"Old"}],
"edges":[
  {"source":"a","target":"b","predicate":"p"},{"source":"old","target":"a","predicate":"p"}]}"#;
const HEAD: &str = r#"{"nodes":[
  {"id":"a","label":"A2"},{"id":"b","label":"B"},{"id":"c","label":"C"},
  {"id":"d","label":"D"},{"id":"n1"},{"id":"n2"}],
"edges":[
  {"source":"a","target":"b","predicate":"p"},{"source":"c","target":"d","predicate":"p"},
  {"source":"n1","target":"n2","predicate":"p"},{"source":"n1","target":"a","predicate":"p"}]}"#;
const HEAD_IDS: [&str; 4] = ["add:n1", "modify:a", "relations:c", "remove:old"];

fn members(graph: &Value, key: &str) -> Vec<Value> {
    graph
        .get(key)
        .and_then(Value::as_array)
        .unwrap_or_default()
        .to_vec()
}

fn graph_of(nodes: Vec<Value>, edges: Vec<Value>) -> Value {
    let mut out = Object::new();
    out.insert("nodes", Value::Array(nodes));
    out.insert("edges", Value::Array(edges));
    Value::Object(out)
}

fn node(id: &str) -> String {
    format!(r#"{{"id":"{id}"}}"#)
}

fn edge(source: &str, target: &str, predicate: &str) -> String {
    format!(r#"{{"source":"{source}","target":"{target}","predicate":"{predicate}"}}"#)
}

/// `HEAD` with more nodes and edges (JSON), and the members of `patch` set on the node it names.
fn head(nodes: &[String], edges: &[String], patch: Option<(&str, &str)>) -> Value {
    let head = graph(HEAD);
    let mut all_nodes = members(&head, "nodes");
    if let Some((id, fields)) = patch {
        for n in &mut all_nodes {
            let Value::Object(n) = n else { continue };
            if n.get("id").and_then(Value::as_str) != Some(id) {
                continue;
            }
            for (key, value) in graph(fields).as_object().unwrap() {
                n.insert(key.clone(), value.clone());
            }
        }
    }
    all_nodes.extend(nodes.iter().map(|n| graph(n)));
    let mut all_edges = members(&head, "edges");
    all_edges.extend(edges.iter().map(|e| graph(e)));
    graph_of(all_nodes, all_edges)
}

// A person whose id changes, with and without a hint.
const CURIE: &str = r#"{"nodes":[
  {"id":"a","label":"Marie Curie","type":["Person"]},{"id":"b","label":"Paris"}],
"edges":[{"source":"a","target":"b","predicate":"livesIn"}]}"#;

fn curie(id: &str, more: &str) -> String {
    format!(
        r#"{{"nodes":[
  {{"id":"{id}","label":"Marie Curie","type":["Person"]{more}}},{{"id":"b","label":"Paris"}}],
"edges":[{{"source":"{id}","target":"b","predicate":"livesIn"}}]}}"#
    )
}

// ─── The rule ────────────────────────────────────────────────────────────────

#[test]
fn names_a_hunk_by_its_kind_and_its_anchor() {
    let d = diff(
        &graph(KINDS_BEFORE),
        &graph(KINDS_AFTER),
        &DiffOptions::default(),
    )
    .unwrap();
    let mut hunks: Vec<(String, &str, String)> = d
        .hunks
        .iter()
        .map(|h| (h.id.to_string(), h.kind.as_str(), h.anchor.to_string()))
        .collect();
    hunks.sort();
    let expected = [
        ("add:lab", "add", "lab"),
        ("merge:curie", "merge", "curie"),
        ("modify:sorbonne", "modify", "sorbonne"),
        ("relations:paris", "relations", "paris"),
        ("remove:old", "remove", "old"),
        ("split:physics", "split", "physics"),
    ]
    .map(|(id, kind, anchor)| (id.to_owned(), kind, anchor.to_owned()));
    assert_eq!(hunks, expected);
}

#[test]
fn anchors_a_group_at_its_best_connected_node_then_the_smallest_id() {
    let options = DiffOptions::default();
    let hub = graph(r#"{"nodes":[{"id":"hub"}],"edges":[]}"#);
    let group = |first: String| {
        graph_of(
            ["hub", "k", "m", "z"].map(|id| graph(&node(id))).to_vec(),
            vec![graph(&edge("m", "k", "p")), graph(&first)],
        )
    };
    // k and m have one edge each: the smaller id. Then z, with two.
    let apart = group(edge("z", "hub", "p"));
    let joined = group(edge("z", "m", "p"));
    assert_eq!(ids(&hub, &apart, &options), ["add:k", "add:z"]);
    assert_eq!(ids(&hub, &joined, &options), ["add:m"]);
    assert_eq!(ids(&apart, &hub, &options), ["remove:k", "remove:z"]);
    assert_eq!(ids(&joined, &hub, &options), ["remove:m"]);
}

#[test]
fn names_a_node_by_its_id_in_the_after_version_and_a_removed_node_by_its_old_id() {
    let options = DiffOptions::default();
    assert_eq!(ids_of(CURIE, &curie("a9", ""), &options), ["modify:a9"]);
    assert_eq!(
        ids_of(
            CURIE,
            &curie("a9", r#","replaces":["a"]"#),
            &matching(MatchStrategy::Id)
        ),
        ["modify:a9"]
    );
    assert_eq!(
        ids_of(
            &curie("a9", ""),
            r#"{"nodes":[{"id":"b","label":"Paris"}],"edges":[]}"#,
            &options
        ),
        ["remove:a9"]
    );
}

#[test]
fn adds_before_to_a_removed_node_whose_id_another_node_took() {
    let similarity = matching(MatchStrategy::Similarity);
    let before =
        r#"{"nodes":[{"id":"x","label":"Alpha","type":["Person"]},{"id":"k"}],"edges":[]}"#;
    let gone = r#"{"nodes":[{"id":"k"}],"edges":[]}"#;
    let taken = r#"{"nodes":[{"id":"k"},{"id":"x","label":"完全不同","type":["Org"]}],"edges":[]}"#;
    assert_eq!(ids_of(before, gone, &similarity), ["remove:x"]);
    assert_eq!(
        ids_of(before, taken, &similarity),
        ["add:x", "remove:x@before"]
    );
    // Where ids decide, the same id is the same node.
    assert_eq!(ids_of(before, taken, &DiffOptions::default()), ["modify:x"]);
}

// ─── What leaves an id alone ─────────────────────────────────────────────────

#[test]
fn the_order_of_nodes_and_edges_in_the_input() {
    let options = DiffOptions::default();
    let reversed = |text: &str| {
        let g = graph(text);
        let (mut nodes, mut edges) = (members(&g, "nodes"), members(&g, "edges"));
        nodes.reverse();
        edges.reverse();
        graph_of(nodes, edges)
    };
    assert_eq!(ids_of(BASE, HEAD, &options), HEAD_IDS);
    assert_eq!(ids(&reversed(BASE), &reversed(HEAD), &options), HEAD_IDS);
}

#[test]
fn more_changes_in_the_same_hunk() {
    // `a` also gets an attribute and an edge, the new group a third node, `c` a second edge.
    let grown = head(
        &[node("n3")],
        &[
            edge("a", "d", "q"),
            edge("c", "b", "p"),
            edge("n3", "n1", "p"),
        ],
        Some(("a", r#"{"attrs":{"k":1}}"#)),
    );
    assert_eq!(ids(&graph(BASE), &grown, &DiffOptions::default()), HEAD_IDS);
}

#[test]
fn changes_elsewhere() {
    let more = head(
        &[node("zz")],
        &[edge("b", "d", "q")],
        Some(("d", r#"{"attrs":{"k":1}}"#)),
    );
    assert_eq!(
        ids(&graph(BASE), &more, &DiffOptions::default()),
        with(&HEAD_IDS, &["add:zz", "modify:d", "relations:b"])
    );
}

#[test]
fn a_base_that_takes_some_of_the_changes() {
    // `a` is already renamed and `old` already gone.
    let caught_up = r#"{"nodes":[
      {"id":"a","label":"A2"},{"id":"b","label":"B"},{"id":"c","label":"C"},
      {"id":"d","label":"D"}],
    "edges":[{"source":"a","target":"b","predicate":"p"}]}"#;
    assert_eq!(
        ids_of(caught_up, HEAD, &DiffOptions::default()),
        ["add:n1", "relations:c"]
    );
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn is_the_kind_and_the_anchor_and_unique_in_a_diff(
        (a, b) in support::version_pair(10, 16),
        options in variant(),
    ) {
        let d = diff(&a.to_value(), &b.to_value(), &options).unwrap();
        let mut seen: Vec<&JsStr> = Vec::new();
        for h in &d.hunks {
            prop_assert_eq!(h.id.to_string(), format!("{}:{}", h.kind.as_str(), h.anchor));
            prop_assert!(!seen.contains(&&h.id));
            seen.push(&h.id);
        }
    }

    #[test]
    fn the_order_of_nodes_and_edges_in_the_input_on_random_pairs(
        (a, b) in support::version_pair(10, 16),
        seed in 1u32..1_000_000,
        options in variant(),
    ) {
        let shuffled = ids(
            &support::shuffle_graph(&a, seed).to_value(),
            &support::shuffle_graph(&b, seed + 1).to_value(),
            &options,
        );
        prop_assert_eq!(shuffled, ids(&a.to_value(), &b.to_value(), &options));
    }

    #[test]
    fn a_new_node_that_is_connected_to_nothing_and_resembles_nothing(
        (a, b) in support::version_pair(10, 16),
        options in variant(),
    ) {
        let mut more = b.clone();
        more.nodes.push(NodeIn {
            id: "fresh-node".to_owned(),
            label: Some("Q7 zzyzx".to_owned()),
            ..NodeIn::default()
        });
        let a = a.to_value();
        prop_assert_eq!(
            changes(&ids(&a, &b.to_value(), &options), &ids(&a, &more.to_value(), &options)),
            ["+add:fresh-node"]
        );
    }

    /// A changed attribute of a node of both versions leaves alone every hunk without that node
    /// or its edges. Not "at most `modify:x` appears": the hunk of `x` may be one that a
    /// dependency cycle merged, and such a hunk has the id of its best-ranked member, which this
    /// change can make another.
    #[test]
    fn a_changed_attribute_of_a_node_of_both_versions(
        (a, b) in support::version_pair(10, 16),
        n in any::<usize>(),
        options in same_id_variant(),
    ) {
        let both = in_both(&a, &b);
        if both.is_empty() {
            return Ok(());
        }
        let x = &both[n % both.len()];
        let mut more = b.clone();
        for node in more.nodes.iter_mut().filter(|node| node.id == *x) {
            node.attrs.get_or_insert_with(Object::new).insert("fresh-key", 1);
        }
        let a = a.to_value();
        let d1 = diff(&a, &b.to_value(), &options).unwrap();
        let d2 = diff(&a, &more.to_value(), &options).unwrap();
        // The hunks that held `x` or an edge change of `x`, and the hunk that holds `x` now.
        let mut held: Vec<Option<&JsStr>> = vec![d1.node(x).and_then(|n| n.hunk.as_ref())];
        held.extend(d1.edges.iter().filter(|e| e.source == x.as_str()).map(|e| e.hunk.as_ref()));
        let holds = d2.node(x).and_then(|n| n.hunk.as_ref());
        prop_assert!(holds.is_some());
        let (gone, fresh) = moved(&d1, &d2);
        prop_assert!(gone.iter().all(|id| held.contains(&Some(id))), "gone {:?}", gone);
        prop_assert!(fresh.iter().all(|id| Some(id) == holds), "new {:?}", fresh);
    }

    /// A new edge that pairs with no other edge change leaves alone every hunk but the one that
    /// takes it. An edge with a predicate of its own, between two nodes that no edge went from
    /// and to before, is no predicate change and no retarget of another edge
    /// (docs/algorithms.md §5).
    #[test]
    fn a_new_edge_that_pairs_with_no_other_edge_change(
        (a, b) in support::version_pair(10, 16),
        (s, t) in (any::<usize>(), any::<usize>()),
        options in id_variant(),
    ) {
        let both = in_both(&a, &b);
        if both.is_empty() {
            return Ok(());
        }
        let (source, target) = (&both[s % both.len()], &both[t % both.len()]);
        if a.edges.iter().any(|e| e.source == *source && e.target == *target) {
            return Ok(());
        }
        let mut more: GraphIn = b.clone();
        more.edges.push(EdgeIn {
            source: source.clone(),
            target: target.clone(),
            predicate: Some("fresh-predicate".to_owned()),
            ..EdgeIn::default()
        });
        let a = a.to_value();
        let d1 = diff(&a, &b.to_value(), &options).unwrap();
        let d2 = diff(&a, &more.to_value(), &options).unwrap();
        // The hunk that takes the edge, and the hunks that held what it holds.
        let takes = d2
            .edges
            .iter()
            .find(|e| e.predicate == "fresh-predicate")
            .and_then(|e| e.hunk.as_ref());
        let hunk = takes.and_then(|id| d2.hunk(id));
        prop_assert!(hunk.is_some());
        let mut held: Vec<Option<&JsStr>> = Vec::new();
        if let Some(h) = hunk {
            held.extend(h.nodes.iter().map(|id| d1.node(id).and_then(|n| n.hunk.as_ref())));
            held.extend(h.edges.iter().map(|id| d1.edge(id).and_then(|e| e.hunk.as_ref())));
        }
        let (gone, fresh) = moved(&d1, &d2);
        prop_assert!(gone.iter().all(|id| held.contains(&Some(id))), "gone {:?}", gone);
        prop_assert!(fresh.iter().all(|id| Some(id) == takes), "new {:?}", fresh);
    }
}

// ─── What moves an id ────────────────────────────────────────────────────────
// Not guarantees: what the documentation says an id does not survive. A change to one of these
// is a change to docs/algorithms.md.

#[test]
fn a_node_with_edge_changes_only_once_it_changes_itself() {
    let renamed = head(&[], &[], Some(("c", r#"{"label":"C2"}"#)));
    assert_eq!(
        ids(&graph(BASE), &renamed, &DiffOptions::default()),
        changed(&HEAD_IDS, "relations:c", "modify:c")
    );
}

#[test]
fn a_group_whose_best_connected_node_changes_or_that_joins_another_group() {
    let (options, base) = (DiffOptions::default(), graph(BASE));
    let n2_leads = head(
        &[],
        &[
            edge("n2", "b", "p"),
            edge("n2", "c", "p"),
            edge("n2", "d", "p"),
        ],
        None,
    );
    assert_eq!(
        ids(&base, &n2_leads, &options),
        changed(&HEAD_IDS, "add:n1", "add:n2")
    );

    let mut second = vec![
        edge("m1", "m2", "p"),
        edge("m1", "b", "p"),
        edge("m1", "c", "p"),
        edge("m1", "d", "p"),
    ];
    let apart = head(&[node("m1"), node("m2")], &second, None);
    assert_eq!(ids(&base, &apart, &options), with(&HEAD_IDS, &["add:m1"]));
    second.push(edge("m2", "n2", "p"));
    let joined = head(&[node("m1"), node("m2")], &second, None);
    assert_eq!(
        ids(&base, &joined, &options),
        changed(&HEAD_IDS, "add:n1", "add:m1")
    );
}

#[test]
fn a_node_whose_id_changes_again() {
    let options = DiffOptions::default();
    assert_eq!(ids_of(CURIE, &curie("a9", ""), &options), ["modify:a9"]);
    assert_eq!(ids_of(CURIE, &curie("a10", ""), &options), ["modify:a10"]);
}

#[test]
fn a_pair_of_nodes_that_is_matched_differently_after_another_edit() {
    let options = DiffOptions::default();
    // Renamed and then rewritten: no longer the same node, so a removal and an addition.
    let rewritten = r#"{"nodes":[
      {"id":"a9","label":"Radium Institute","type":["Org"]},{"id":"b","label":"Paris"}],
    "edges":[]}"#;
    assert_eq!(ids_of(CURIE, &curie("a9", ""), &options), ["modify:a9"]);
    assert_eq!(ids_of(CURIE, rewritten, &options), ["add:a9", "remove:a"]);
}

#[test]
fn an_edge_change_that_pairs_with_another_one() {
    // `s` points at `v` instead of `t`, and `u` no longer points at `v`.
    let nodes = || ["s", "t", "u", "v"].map(|id| graph(&node(id))).to_vec();
    let of = |edges: &[String]| graph_of(nodes(), edges.iter().map(|e| graph(e)).collect());
    let before = of(&[edge("s", "t", "p"), edge("u", "v", "p")]);
    let after = of(&[edge("s", "v", "p")]);
    // A new edge from `s` to `t` is now the old one with another predicate. So the edge to `v`
    // is no longer that old edge with another target: it is the edge of `u` with another
    // source, and nothing is left under `u`. Found by CI with fast-check, seed -1797998617.
    let more = of(&[edge("s", "v", "p"), edge("s", "t", "q")]);
    for options in variants() {
        assert_eq!(
            ids(&before, &after, &options),
            ["relations:s", "relations:u"]
        );
        assert_eq!(ids(&before, &more, &options), ["relations:s"]);
    }
}

#[test]
fn hunks_merged_for_a_cycle_take_the_id_of_another_member() {
    // Two copies of one statement: one gets another label, the other goes from `n` to `q`. The
    // hunks of `n` and of `q` change the same triple, so they require each other and are one.
    let cites = |source: &str, label: &str| {
        format!(r#"{{"source":"{source}","target":"z","predicate":"cites","label":"{label}"}}"#)
    };
    let of = |n: &str, edges: &[String]| {
        graph_of(
            vec![graph(n), graph(&node("q")), graph(&node("z"))],
            edges.iter().map(|e| graph(e)).collect(),
        )
    };
    let before = of(&node("n"), &[cites("n", "first"), cites("n", "second")]);
    let edges = [cites("n", "first, revised"), cites("q", "second")];
    for options in [DiffOptions::default(), matching(MatchStrategy::Id)] {
        assert_eq!(
            ids(&before, &of(&node("n"), &edges), &options),
            ["relations:n"]
        );
        // One more edge under `q` makes its hunk the larger one.
        let mut larger = edges.to_vec();
        larger.push(edge("q", "n", "fresh-predicate"));
        assert_eq!(
            ids(&before, &of(&node("n"), &larger), &options),
            ["relations:q"]
        );
        // An attribute on `n` puts `n` into the hunk, which is not `modify:n`.
        let changed_node = of(r#"{"id":"n","attrs":{"k":1}}"#, &edges);
        let d = diff(&before, &changed_node, &options).unwrap();
        let hunks: Vec<(String, Vec<String>)> = d
            .hunks
            .iter()
            .map(|h| {
                (
                    h.id.to_string(),
                    h.nodes.iter().map(ToString::to_string).collect(),
                )
            })
            .collect();
        assert_eq!(hunks, [("relations:q".to_owned(), vec!["n".to_owned()])]);
    }
}

#[test]
fn hunks_that_come_to_require_each_other() {
    // `a9` replaces `a` and now lives in the new `n`: its hunk requires the hunk that adds `n`.
    let after = |edges: &str| {
        format!(
            r#"{{"nodes":[
  {{"id":"a9","label":"Marie Curie","type":["Person"],"replaces":["a"]}},
  {{"id":"b","label":"Paris"}},{{"id":"n","label":"Warsaw"}}],
"edges":[{{"source":"a9","target":"n","predicate":"livesIn"}}{edges}]}}"#
        )
    };
    for options in [DiffOptions::default(), matching(MatchStrategy::Id)] {
        assert_eq!(ids_of(CURIE, &after(""), &options), ["add:n", "modify:a9"]);
        // An edge back makes adding `n` require the renamed `a9` as well: one hunk takes the
        // other in.
        let back = r#",{"source":"n","target":"a9","predicate":"birthplaceOf"}"#;
        let d = diff(&graph(CURIE), &graph(&after(back)), &options).unwrap();
        let hunks: Vec<(String, Vec<String>)> = d
            .hunks
            .iter()
            .map(|h| {
                (
                    h.id.to_string(),
                    h.nodes.iter().map(ToString::to_string).collect(),
                )
            })
            .collect();
        assert_eq!(
            hunks,
            [(
                "modify:a9".to_owned(),
                vec!["a9".to_owned(), "n".to_owned()]
            )]
        );
    }
}
