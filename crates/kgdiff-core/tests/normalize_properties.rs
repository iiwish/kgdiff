//! Properties of `normalize`, `graph_to_json` and `hash_graph` on random graphs (the graph
//! invariants of `packages/core/test/properties.test.ts`).

mod support;

use kgdiff_core::js::json;
use kgdiff_core::{EdgeIdentity, NormalizeOptions, graph_to_json, hash_graph, normalize};
use proptest::prelude::*;

fn config() -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(300);
    ProptestConfig {
        cases,
        ..ProptestConfig::default()
    }
}

fn identity() -> impl Strategy<Value = EdgeIdentity> {
    prop_oneof![Just(EdgeIdentity::Structure), Just(EdgeIdentity::Id)]
}

proptest! {
    #![proptest_config(config())]

    /// `hashGraph ignores node and edge order`, and so does everything `normalize` keeps.
    #[test]
    fn normalize_ignores_node_and_edge_order(g in support::graph(10, 16), seed in 1u32..1_000_000, edge_identity in identity()) {
        let options = NormalizeOptions { edge_identity, ..NormalizeOptions::default() };
        let a = normalize(&g.to_value(), options).unwrap();
        let b = normalize(&support::shuffle_graph(&g, seed).to_value(), options).unwrap();
        prop_assert_eq!(hash_graph(&a), hash_graph(&b));
        prop_assert_eq!(json::to_string(&graph_to_json(&a)), json::to_string(&graph_to_json(&b)));
        prop_assert_eq!(&a.issues, &b.issues);
    }

    /// `normalize(graphToJSON(g))` rebuilds `g`.
    #[test]
    fn graph_json_round_trips(g in support::graph(10, 16), edge_identity in identity()) {
        let options = NormalizeOptions { edge_identity, ..NormalizeOptions::default() };
        let a = normalize(&g.to_value(), options).unwrap();
        let written = graph_to_json(&a);
        let b = normalize(&json::parse(&json::to_string(&written)).unwrap(), options).unwrap();
        prop_assert_eq!(hash_graph(&a), hash_graph(&b));
        prop_assert_eq!(json::to_string(&written), json::to_string(&graph_to_json(&b)));
    }
}
