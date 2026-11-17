//! `DiffResult`'s lookups after a caller changed its public vectors: no panic, and never an
//! element other than the one asked for.

use kgdiff_core::js::{JsStr, Value, json};
use kgdiff_core::{DiffOptions, DiffResult, diff};

const BEFORE: &str = r#"{"nodes":[{"id":"animal","label":"Animal"},{"id":"bird","label":"Bird"},{"id":"cat","label":"Cat","attrs":{"legs":4}},{"id":"dog","label":"Dog"},{"id":"dodo","label":"Dodo"}],"edges":[{"source":"bird","target":"animal","predicate":"is_a"},{"source":"cat","target":"animal","predicate":"is_a"},{"source":"dog","target":"animal","predicate":"is_a"},{"source":"dodo","target":"bird","predicate":"eats"}]}"#;
const AFTER: &str = r#"{"nodes":[{"id":"animal","label":"Animal"},{"id":"bird","label":"Bird"},{"id":"cat","label":"House cat","attrs":{"legs":4}},{"id":"dog","label":"Dog"},{"id":"owl","label":"Owl"}],"edges":[{"source":"bird","target":"animal","predicate":"is_a"},{"source":"cat","target":"animal","predicate":"is_a"},{"source":"dog","target":"animal","predicate":"is_a"},{"source":"owl","target":"bird","predicate":"is_a"}]}"#;

fn zoo() -> DiffResult {
    let graph = |text: &str| -> Value { json::parse(text).unwrap() };
    diff(&graph(BEFORE), &graph(AFTER), &DiffOptions::default()).unwrap()
}

/// Looks every element up once, which builds every table.
fn look_everything_up(d: &DiffResult) {
    for n in &d.nodes {
        assert_eq!(d.node(&n.id).map(|m| &m.id), Some(&n.id));
        if let Some(id) = &n.before_id {
            assert_eq!(d.node_by_before(id).map(|m| &m.id), Some(&n.id));
        }
        if let Some(id) = &n.after_id {
            assert_eq!(d.node_by_after(id).map(|m| &m.id), Some(&n.id));
        }
    }
    for e in &d.edges {
        assert_eq!(d.edge(&e.id).map(|f| &f.id), Some(&e.id));
    }
    for h in &d.hunks {
        assert_eq!(d.hunk(&h.id).map(|g| &g.id), Some(&h.id));
    }
    let _ = d.edges_of("animal").count();
}

/// Every lookup of every id gives either nothing or the element asked for.
fn check_lookups(d: &DiffResult, node_ids: &[JsStr], edge_ids: &[JsStr], hunk_ids: &[JsStr]) {
    for id in node_ids {
        if let Some(n) = d.node(id) {
            assert_eq!(&n.id, id);
        }
        if let Some(n) = d.node_by_before(id) {
            assert_eq!(n.before_id.as_ref(), Some(id));
        }
        if let Some(n) = d.node_by_after(id) {
            assert_eq!(n.after_id.as_ref(), Some(id));
        }
        for e in d.edges_of(id) {
            let ends = [
                Some(&e.source),
                Some(&e.target),
                e.source_before.as_ref(),
                e.target_before.as_ref(),
            ];
            assert!(ends.iter().flatten().any(|end| *end == id), "{id}");
        }
    }
    for id in edge_ids {
        if let Some(e) = d.edge(id) {
            assert_eq!(&e.id, id);
        }
    }
    for id in hunk_ids {
        if let Some(h) = d.hunk(id) {
            assert_eq!(&h.id, id);
        }
    }
}

struct Ids {
    nodes: Vec<JsStr>,
    edges: Vec<JsStr>,
    hunks: Vec<JsStr>,
}

fn ids(d: &DiffResult) -> Ids {
    let mut nodes: Vec<JsStr> = d.nodes.iter().map(|n| n.id.clone()).collect();
    nodes.push(JsStr::from("missing"));
    Ids {
        nodes,
        edges: d.edges.iter().map(|e| e.id.clone()).collect(),
        hunks: d.hunks.iter().map(|h| h.id.clone()).collect(),
    }
}

#[test]
fn finds_everything_when_nothing_changed() {
    let d = zoo();
    look_everything_up(&d);
    look_everything_up(&d);
    assert!(d.node("missing").is_none() && d.edge("missing").is_none());
    assert_eq!(d.edges_of("missing").count(), 0);
    let incident: Vec<&str> = d.edges_of("bird").map(|e| e.id.as_str()).collect();
    let mut sorted = incident.clone();
    sorted.sort();
    assert_eq!(incident, sorted);
    assert_eq!(incident.len(), 3);
    assert_eq!(d.edges_of("animal").count(), 3);
}

#[test]
fn a_swap_after_the_first_lookup_turns_the_two_into_misses() {
    let mut d = zoo();
    look_everything_up(&d);
    let (first, last) = (d.nodes[0].id.clone(), d.nodes[d.nodes.len() - 1].id.clone());
    let last_at = d.nodes.len() - 1;
    d.nodes.swap(0, last_at);
    assert!(d.node(&first).is_none() && d.node(&last).is_none());
    // The others are where they were.
    let middle = d.nodes[1].id.clone();
    assert_eq!(d.node(&middle).map(|n| &n.id), Some(&middle));
    let (e0, e1) = (d.edges[0].id.clone(), d.edges[1].id.clone());
    d.edges.swap(0, 1);
    assert!(d.edge(&e0).is_none() && d.edge(&e1).is_none());
    if d.hunks.len() > 1 {
        let (h0, h1) = (d.hunks[0].id.clone(), d.hunks[1].id.clone());
        d.hunks.swap(0, 1);
        assert!(d.hunk(&h0).is_none() && d.hunk(&h1).is_none());
    }
    let all = ids(&zoo());
    check_lookups(&d, &all.nodes, &all.edges, &all.hunks);
}

#[test]
fn clearing_truncating_or_pushing_after_the_first_lookup_does_not_panic() {
    let all = ids(&zoo());

    let mut cleared = zoo();
    look_everything_up(&cleared);
    cleared.nodes.clear();
    cleared.edges.clear();
    cleared.hunks.clear();
    for id in &all.nodes {
        assert!(cleared.node(id).is_none());
        assert!(cleared.node_by_before(id).is_none() && cleared.node_by_after(id).is_none());
        assert_eq!(cleared.edges_of(id).count(), 0);
    }
    assert!(all.edges.iter().all(|id| cleared.edge(id).is_none()));
    assert!(all.hunks.iter().all(|id| cleared.hunk(id).is_none()));

    let mut truncated = zoo();
    look_everything_up(&truncated);
    truncated.nodes.truncate(2);
    truncated.edges.truncate(1);
    truncated.hunks.truncate(1);
    let kept = truncated.nodes[1].id.clone();
    assert_eq!(truncated.node(&kept).map(|n| &n.id), Some(&kept));
    assert!(truncated.node(&all.nodes[2]).is_none());
    assert!(truncated.edge(&all.edges[1]).is_none());
    assert_eq!(
        truncated.edge(&all.edges[0]).map(|e| &e.id),
        Some(&truncated.edges[0].id)
    );
    check_lookups(&truncated, &all.nodes, &all.edges, &all.hunks);

    // What is pushed after the first lookup is not indexed; what was there still is.
    let mut pushed = zoo();
    look_everything_up(&pushed);
    let mut extra = pushed.nodes[0].clone();
    extra.id = "pushed".into();
    pushed.nodes.push(extra);
    let mut extra = pushed.edges[0].clone();
    extra.id = "pushed".into();
    pushed.edges.push(extra);
    assert!(pushed.node("pushed").is_none() && pushed.edge("pushed").is_none());
    look_everything_up(&zoo());
    let first = pushed.nodes[0].id.clone();
    assert_eq!(pushed.node(&first).map(|n| &n.id), Some(&first));
    check_lookups(&pushed, &all.nodes, &all.edges, &all.hunks);
}

#[test]
fn a_change_before_the_first_lookup_is_indexed() {
    let mut d = zoo();
    let last_at = d.nodes.len() - 1;
    d.nodes.swap(0, last_at);
    d.edges.truncate(2);
    look_everything_up(&d);
    let all = ids(&zoo());
    check_lookups(&d, &all.nodes, &all.edges, &all.hunks);
}
