//! Properties of `diff` on random version pairs (the diff invariants of
//! `packages/core/test/properties.test.ts`), under the same four option variants.

mod support;

use kgdiff_core::js::{JsStr, Lookup, json};
use kgdiff_core::model::ChangeStatus;
use kgdiff_core::{
    ApplyOptions, DeltaOp, DiffOptions, DiffResult, EdgeIdentity, MatchStrategy, apply_delta, diff,
    diff_from_json, diff_to_json, hash_graph, invert_delta, pack_diff_json, unpack_diff_json,
};
use proptest::prelude::*;

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

/// `IGNORED`: keys `support::graph` and its mutations use on nodes and on edges, sorted.
fn ignored() -> Vec<JsStr> {
    ["k1", "w", "名称"].map(JsStr::from).to_vec()
}

/// `VARIANTS`: default options, similarity matching, id edge identity, id matching without
/// restructuring, and ignored attributes with default options and with similarity matching and
/// id edge identity.
fn variant() -> impl Strategy<Value = DiffOptions> {
    let mut similarity = DiffOptions::default();
    similarity.r#match.strategy = MatchStrategy::Similarity;
    let edge_id = DiffOptions {
        edge_identity: EdgeIdentity::Id,
        ..DiffOptions::default()
    };
    let mut plain = DiffOptions {
        detect_merges: false,
        detect_splits: false,
        ..DiffOptions::default()
    };
    plain.r#match.strategy = MatchStrategy::Id;
    let ignoring = DiffOptions {
        ignore_attrs: ignored(),
        ..DiffOptions::default()
    };
    let mut ignoring_similarity = DiffOptions {
        ignore_attrs: ignored(),
        edge_identity: EdgeIdentity::Id,
        ..DiffOptions::default()
    };
    ignoring_similarity.r#match.strategy = MatchStrategy::Similarity;
    prop::sample::select(vec![
        DiffOptions::default(),
        similarity,
        edge_id,
        plain,
        ignoring,
        ignoring_similarity,
    ])
}

fn bytes(d: &DiffResult) -> String {
    json::to_string(&diff_to_json(d))
}

/// Every changed element is owned by exactly one hunk, and every op by exactly one hunk
/// (`expectHunkPartition`).
fn check_partition(d: &DiffResult) -> Result<(), TestCaseError> {
    let mut node_owner: Lookup<String, String> = Lookup::new();
    let mut edge_owner: Lookup<String, String> = Lookup::new();
    let mut op_owner: Lookup<usize, String> = Lookup::new();
    for h in &d.hunks {
        prop_assert!(!h.nodes.is_empty() || !h.edges.is_empty());
        for id in &h.nodes {
            prop_assert!(
                node_owner
                    .insert(id.to_string(), h.id.to_string())
                    .is_none()
            );
        }
        for id in &h.edges {
            prop_assert!(
                edge_owner
                    .insert(id.to_string(), h.id.to_string())
                    .is_none()
            );
        }
        for &i in &h.ops {
            prop_assert!(op_owner.insert(i, h.id.to_string()).is_none());
        }
        prop_assert!(h.ops.windows(2).all(|w| w[0] < w[1]));
        for id in &h.context {
            prop_assert!(!h.nodes.contains(id));
            prop_assert!(d.node(id).is_some());
        }
        if h.kind != kgdiff_core::model::HunkKind::Relations {
            prop_assert_eq!(&h.nodes[0], &h.anchor);
        }
    }
    for n in &d.nodes {
        let owner = node_owner.get(n.id.as_str()).map(String::as_str);
        if n.status == ChangeStatus::Unchanged {
            prop_assert!(n.hunk.is_none());
        } else {
            prop_assert_eq!(n.hunk.as_deref(), owner);
            prop_assert!(n.hunk.is_some());
        }
    }
    for e in &d.edges {
        let owner = edge_owner.get(e.id.as_str()).map(String::as_str);
        if e.status == ChangeStatus::Unchanged {
            prop_assert!(e.hunk.is_none());
        } else {
            prop_assert_eq!(e.hunk.as_deref(), owner);
        }
    }
    prop_assert_eq!(
        node_owner.len(),
        d.nodes
            .iter()
            .filter(|n| n.status != ChangeStatus::Unchanged)
            .count()
    );
    prop_assert_eq!(
        edge_owner.len(),
        d.edges
            .iter()
            .filter(|e| e.status != ChangeStatus::Unchanged)
            .count()
    );
    for (i, op) in d.delta.ops.iter().enumerate() {
        if op_owner.contains_key(&i) {
            continue;
        }
        // Only what the diff does not show as a change lives outside hunks: the id changes of
        // `similarity` matches and the changes of ignored attributes.
        if matches!(op, DeltaOp::NodeRekey { .. }) {
            prop_assert_eq!(d.options.r#match.strategy, MatchStrategy::Similarity);
        } else {
            prop_assert!(
                !d.options.ignore_attrs.is_empty(),
                "op {} belongs to no hunk",
                i
            );
        }
    }
    prop_assert!(d.hunks.iter().enumerate().all(|(i, h)| h.order == i));
    Ok(())
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn reports_nothing_for_identical_inputs(g in support::graph(10, 16), options in variant()) {
        let value = g.to_value();
        let d = diff(&value, &value, &options).unwrap();
        prop_assert!(d.delta.ops.is_empty());
        prop_assert!(d.hunks.is_empty());
        prop_assert!(d.stats.identical);
        prop_assert!(d.nodes.iter().all(|n| n.status == ChangeStatus::Unchanged));
    }

    #[test]
    fn is_deterministic_under_shuffled_node_and_edge_order(
        (a, b) in support::version_pair(10, 16),
        seed in 1u32..1_000_000,
        options in variant(),
    ) {
        let reference = bytes(&diff(&a.to_value(), &b.to_value(), &options).unwrap());
        let shuffled = diff(&support::shuffle_graph(&a, seed).to_value(), &support::shuffle_graph(&b, seed + 1).to_value(), &options).unwrap();
        prop_assert_eq!(bytes(&shuffled), reference);
    }

    #[test]
    fn partitions_the_changed_elements_and_the_delta_ops_into_hunks((a, b) in support::version_pair(10, 16), options in variant()) {
        check_partition(&diff(&a.to_value(), &b.to_value(), &options).unwrap())?;
    }

    /// Without directional replacement links, the diff of B and A mirrors the diff of A and B.
    #[test]
    fn mirrors_in_size_without_replacement_links((a, b) in support::version_pair(10, 16)) {
        let unlink = |g: &support::GraphIn| {
            let mut g = g.clone();
            for n in &mut g.nodes {
                n.replaces = None;
                n.replaced_by = None;
            }
            g.to_value()
        };
        let mut options = DiffOptions { detect_merges: false, detect_splits: false, ..DiffOptions::default() };
        options.r#match.strategy = MatchStrategy::Id;
        let (a, b) = (unlink(&a), unlink(&b));
        let forward = diff(&a, &b, &options).unwrap();
        let backward = diff(&b, &a, &options).unwrap();
        prop_assert_eq!(backward.stats.nodes.added, forward.stats.nodes.removed);
        prop_assert_eq!(backward.stats.nodes.removed, forward.stats.nodes.added);
        prop_assert_eq!(backward.stats.nodes.modified, forward.stats.nodes.modified);
    }
}

/// Applies the ops of no hunk, then every hunk's ops in `order`, each step strictly against the
/// graph reached so far, checking that `requires` is respected (`applyHunkByHunk`).
fn apply_hunk_by_hunk(d: &DiffResult) -> Result<kgdiff_core::KGraph, TestCaseError> {
    let mut graph = d.before.clone();
    let step = |graph: &mut kgdiff_core::KGraph, indices: &[usize]| -> Result<(), TestCaseError> {
        if indices.is_empty() {
            return Ok(());
        }
        let mut delta = d.delta.clone();
        delta.base.insert("hash", hash_graph(graph));
        delta.ops = indices.iter().map(|&i| d.delta.ops[i].clone()).collect();
        let (next, _) = apply_delta(graph, &delta, ApplyOptions::default())
            .map_err(|e| TestCaseError::fail(e.message))?;
        *graph = next;
        Ok(())
    };
    let owned: Lookup<usize, ()> =
        d.hunks
            .iter()
            .flat_map(|h| h.ops.iter())
            .fold(Lookup::new(), |mut set, &i| {
                set.insert(i, ());
                set
            });
    let free: Vec<usize> = (0..d.delta.ops.len())
        .filter(|i| !owned.contains_key(i))
        .collect();
    step(&mut graph, &free)?;
    let mut applied: Lookup<String, ()> = Lookup::new();
    for h in &d.hunks {
        for r in &h.requires {
            prop_assert!(applied.contains_key(r.as_str()), "{} requires {}", h.id, r);
        }
        step(&mut graph, &h.ops)?;
        applied.insert(h.id.to_string(), ());
    }
    Ok(graph)
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn applies_hunk_by_hunk_in_order_strictly_to_the_after_graph((a, b) in support::version_pair(10, 16), options in variant()) {
        let d = diff(&a.to_value(), &b.to_value(), &options).unwrap();
        let reached = apply_hunk_by_hunk(&d)?;
        prop_assert_eq!(hash_graph(&reached), hash_graph(&d.after));
    }

    #[test]
    fn applying_the_delta_and_its_inverse_moves_between_the_versions((a, b) in support::version_pair(10, 16), options in variant()) {
        let d = diff(&a.to_value(), &b.to_value(), &options).unwrap();
        let (there, _) = apply_delta(&d.before, &d.delta, ApplyOptions::default()).unwrap();
        prop_assert_eq!(hash_graph(&there), hash_graph(&d.after));
        let inverse = invert_delta(&d.delta);
        let (back, _) = apply_delta(&d.after, &inverse, ApplyOptions::default()).unwrap();
        prop_assert_eq!(hash_graph(&back), hash_graph(&d.before));
        let (again, _) = apply_delta(&there, &inverse, ApplyOptions::default()).unwrap();
        prop_assert_eq!(hash_graph(&again), hash_graph(&d.before));
        prop_assert_eq!(&invert_delta(&inverse), &d.delta);
    }

    #[test]
    fn round_trips_through_diff_to_json_and_diff_from_json((a, b) in support::version_pair(10, 16), options in variant()) {
        let d = diff(&a.to_value(), &b.to_value(), &options).unwrap();
        let text = bytes(&d);
        let back = diff_from_json(&json::parse(&text).unwrap()).unwrap();
        prop_assert_eq!(bytes(&back), text.clone());
        prop_assert_eq!(hash_graph(&back.before), hash_graph(&d.before));
        prop_assert_eq!(hash_graph(&back.after), hash_graph(&d.after));
        for n in &d.nodes {
            let read = back.node(&n.id).unwrap();
            prop_assert_eq!((&read.status, &read.facets, &read.hunk, &read.label, &read.degree), (&n.status, &n.facets, &n.hunk, &n.label, &n.degree));
        }
        for e in &d.edges {
            let read = back.edge(&e.id).unwrap();
            prop_assert_eq!((&read.status, &read.facets, &read.hunk, &read.predicate, &read.before_key, &read.after_key), (&e.status, &e.facets, &e.hunk, &e.predicate, &e.before_key, &e.after_key));
        }
        let packed = pack_diff_json(&diff_to_json(&d));
        prop_assert_eq!(json::to_string(&unpack_diff_json(&packed).unwrap()), text);
    }
}
