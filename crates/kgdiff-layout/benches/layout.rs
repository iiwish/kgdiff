//! Timings against the layout target of RFC 0002 §7 (`cargo bench -p kgdiff-layout`), on the
//! workloads of `packages/layout/test/perf.bench.ts`:
//!
//! | What                                  | TypeScript budget       | Rust target (native) |
//! | ------------------------------------- | ----------------------- | -------------------- |
//! | `layout_diff`, 2k nodes               | < 800 ms (~0.6–0.7 s)   | < 250 ms             |
//!
//! The 5k / 10k and `extend_layout` cases are measured alongside (TypeScript's CLI targets:
//! 5k nodes < 3 s, 10k nodes < 2 s).

#[path = "../tests/support/mod.rs"]
mod support;

use divan::Bencher;
use kgdiff_core::js::JsStr;
use kgdiff_layout::{LayoutOptions, LayoutScope, extend_layout, layout_diff};
use support::{english_label, scale_free, tree};

fn main() {
    divan::main();
}

fn all() -> LayoutOptions {
    LayoutOptions {
        scope: Some(LayoutScope::All),
        ..LayoutOptions::default()
    }
}

/// A 2k-node hierarchy (target < 250 ms).
#[divan::bench(sample_count = 10)]
fn tree_2k(bencher: Bencher) {
    let diff = tree(2000, 7, english_label).diff();
    bencher.bench(|| layout_diff(&diff, &LayoutOptions::default()).unwrap());
}

/// A 2k-node scale-free graph (target < 250 ms).
#[divan::bench(sample_count = 10)]
fn scale_free_2k(bencher: Bencher) {
    let diff = scale_free(2000, 1.3, 11).diff();
    bencher.bench(|| layout_diff(&diff, &LayoutOptions::default()).unwrap());
}

#[divan::bench(sample_count = 5)]
fn scale_free_5k_scope_all(bencher: Bencher) {
    let diff = scale_free(5000, 1.3, 11).diff();
    bencher.bench(|| layout_diff(&diff, &all()).unwrap());
}

#[divan::bench(sample_count = 3)]
fn dense_10k_scope_all(bencher: Bencher) {
    let diff = scale_free(10_000, 2.0, 11).diff();
    bencher.bench(|| layout_diff(&diff, &all()).unwrap());
}

/// Five nodes back into a 1,495-node layout (the simulation window).
#[divan::bench(sample_count = 10)]
fn extend_5_into_1495(bencher: Bencher) {
    let diff = scale_free(1500, 1.3, 11).diff();
    let full = layout_diff(&diff, &LayoutOptions::default()).unwrap();
    let removed: Vec<JsStr> = ["s0100", "s0200", "s0300", "s0400", "s0500"]
        .map(JsStr::from)
        .into();
    let mut partial = full;
    partial.positions.retain(|id, _| !removed.contains(id));
    bencher.bench(|| extend_layout(&diff, &partial, &removed, &LayoutOptions::default()).unwrap());
}
