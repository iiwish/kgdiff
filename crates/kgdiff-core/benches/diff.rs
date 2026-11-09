//! Timings against the native targets of RFC 0002 §7 (`cargo bench -p kgdiff-core`), on the
//! workloads of `packages/core/test/performance.bench.ts` (ported from `test/support/
//! synthetic.ts`, with the same mulberry32 stream):
//!
//! | What                                         | TypeScript budget | Rust target |
//! | -------------------------------------------- | ----------------- | ----------- |
//! | `diff`, exact ids, 10k nodes / 30k edges     | < 150 ms          | < 40 ms     |
//! | `diff`, exact ids, 100k nodes / 300k edges   | < 2 s             | < 500 ms    |
//! | similarity matching, 5k unmatched per side   | < 1.5 s           | < 400 ms    |
//!
//! The graphs are given as kgdiff reads them, parsed from JSON text (the TypeScript benchmark
//! gives object literals); parsing is not timed. `normalize`'s memory is measured by the
//! `normalize_memory` example.

mod synthetic;

use kgdiff_core::js::{Value, json};
use kgdiff_core::{
    DiffOptions, KGraph, MatchStrategy, NormalizeOptions, diff, diff_from_json, diff_graphs,
    diff_to_json, match_nodes, normalize,
};

use synthetic::{edit_graph, extraction_pair, synthetic_graph};

fn main() {
    divan::main();
}

fn normalized(g: &Value) -> KGraph {
    normalize(g, NormalizeOptions::default()).expect("valid")
}

#[divan::bench(args = [10_000, 100_000], sample_count = 5, sample_size = 1)]
fn diff_exact_ids_from_inputs(bencher: divan::Bencher, nodes: usize) {
    let before = synthetic_graph(nodes, nodes * 3, 1);
    let after = edit_graph(&before, 2);
    bencher.bench(|| diff(&before, &after, &DiffOptions::default()).expect("diff"));
}

#[divan::bench(args = [10_000, 100_000], sample_count = 5, sample_size = 1)]
fn diff_exact_ids_from_normalized_graphs(bencher: divan::Bencher, nodes: usize) {
    let before = synthetic_graph(nodes, nodes * 3, 1);
    let after = edit_graph(&before, 2);
    let (a, b) = (normalized(&before), normalized(&after));
    bencher
        .with_inputs(|| (a.clone(), b.clone()))
        .bench_values(|(a, b)| diff_graphs(a, b, DiffOptions::default()).expect("diff"));
}

#[divan::bench(args = [10_000, 100_000], sample_count = 5, sample_size = 1)]
fn normalize_graph(bencher: divan::Bencher, nodes: usize) {
    let g = synthetic_graph(nodes, nodes * 3, 1);
    bencher.bench(|| normalized(&g));
}

#[divan::bench(sample_count = 5, sample_size = 1)]
fn diff_to_json_and_back_10k(bencher: divan::Bencher) {
    let before = synthetic_graph(10_000, 30_000, 1);
    let after = edit_graph(&before, 2);
    let result = diff(&before, &after, &DiffOptions::default()).expect("diff");
    let text = json::to_string(&diff_to_json(&result));
    bencher.bench(|| {
        let written = json::to_string(&diff_to_json(&result));
        let read = diff_from_json(&json::parse(&text).expect("json")).expect("read");
        (written.len(), read.nodes.len())
    });
}

#[divan::bench(args = [2_000, 5_000], sample_count = 3, sample_size = 1)]
fn similarity_matching(bencher: divan::Bencher, unmatched: usize) {
    let (a, b) = extraction_pair(unmatched, 3);
    let (a, b) = (normalized(&a), normalized(&b));
    let mut options = DiffOptions::default().r#match;
    options.strategy = MatchStrategy::Similarity;
    bencher.bench(|| match_nodes(&a, &b, &options));
}
