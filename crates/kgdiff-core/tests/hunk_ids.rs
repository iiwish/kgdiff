//! Hunk ids (docs/algorithms.md §7, "Hunk ids"): the rule, what leaves an id alone and what
//! moves it. Hosts store review progress under these ids, so the rule is a contract; the cases
//! are those of `packages/core/test/hunk-ids.test.ts`.

mod support;

use kgdiff_core::js::{JsStr, Object, Value, json};
use kgdiff_core::{DiffOptions, EdgeIdentity, MatchStrategy, diff};
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

/// The variants of `diff_properties.rs`.
fn variant() -> impl Strategy<Value = DiffOptions> {
    let edge_id = DiffOptions {
        edge_identity: EdgeIdentity::Id,
        ..DiffOptions::default()
    };
    prop::sample::select(vec![
        DiffOptions::default(),
        matching(MatchStrategy::Similarity),
        edge_id,
        plain(),
    ])
}

/// Matching by id: no edit changes how another node is matched.
fn id_variant() -> impl Strategy<Value = DiffOptions> {
    prop::sample::select(vec![matching(MatchStrategy::Id), plain()])
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

    /// At most `modify:x` appears, and `relations:x` goes with it.
    #[test]
    fn a_changed_attribute(
        (a, b) in support::version_pair(10, 16),
        n in any::<usize>(),
        options in id_variant(),
    ) {
        if b.nodes.is_empty() {
            return Ok(());
        }
        let mut more = b.clone();
        let at = n % more.nodes.len();
        let x = more.nodes[at].id.clone();
        more.nodes[at].attrs.get_or_insert_with(Object::new).insert("fresh-key", 1);
        let a = a.to_value();
        let changed = changes(&ids(&a, &b.to_value(), &options), &ids(&a, &more.to_value(), &options));
        let (modify, relations) = (format!("+modify:{x}"), format!("-relations:{x}"));
        prop_assert!(changed.iter().all(|c| *c == modify || *c == relations), "{:?}", changed);
        prop_assert!(!changed.contains(&relations) || changed.contains(&modify));
    }

    /// At most `relations:source` appears.
    #[test]
    fn a_new_edge_between_two_nodes_of_both_versions(
        (a, b) in support::version_pair(10, 16),
        (s, t) in (any::<usize>(), any::<usize>()),
        options in id_variant(),
    ) {
        let both: Vec<&NodeIn> =
            b.nodes.iter().filter(|n| a.nodes.iter().any(|m| m.id == n.id)).collect();
        if both.is_empty() {
            return Ok(());
        }
        let source = both[s % both.len()].id.clone();
        let target = both[t % both.len()].id.clone();
        let mut more: GraphIn = b.clone();
        more.edges.push(EdgeIn {
            source: source.clone(),
            target,
            predicate: Some("fresh-predicate".to_owned()),
            ..EdgeIn::default()
        });
        let a = a.to_value();
        let changed = changes(&ids(&a, &b.to_value(), &options), &ids(&a, &more.to_value(), &options));
        let relations = format!("+relations:{source}");
        prop_assert!(changed.iter().all(|c| *c == relations), "{:?}", changed);
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
