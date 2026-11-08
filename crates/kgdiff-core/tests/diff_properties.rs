//! Properties of `diff` on random version pairs (the diff invariants of
//! `packages/core/test/properties.test.ts`), under the same four option variants.

mod support;

use kgdiff_core::js::{Lookup, json};
use kgdiff_core::model::ChangeStatus;
use kgdiff_core::{
    DeltaOp, DiffOptions, DiffResult, EdgeIdentity, MatchStrategy, diff, diff_to_json,
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

/// `VARIANTS`: default options, similarity matching, id edge identity, id matching without
/// restructuring.
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
    prop::sample::select(vec![DiffOptions::default(), similarity, edge_id, plain])
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
        // Only the id changes of `similarity` matches, which are not changes, live outside hunks.
        let is_rekey = matches!(op, DeltaOp::NodeRekey { .. });
        prop_assert!(is_rekey, "op {} belongs to no hunk", i);
        prop_assert_eq!(d.options.r#match.strategy, MatchStrategy::Similarity);
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
