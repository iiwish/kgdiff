//! The resident memory that `normalize` adds for the graph of RFC 0002 §7's memory target, 100k
//! nodes and 300k edges given as kgdiff reads them (parsed from JSON text): the process's resident
//! set size before and after, as `ps` reports it.
//!
//! ```text
//! cargo run --release -p kgdiff-core --example normalize_memory
//! ```

#[path = "../benches/synthetic/mod.rs"]
#[allow(dead_code, reason = "the example needs one of the workloads")]
mod synthetic;

use std::process::Command;

use kgdiff_core::{NormalizeOptions, normalize};

/// This process's resident set size in MiB.
fn resident_mib() -> f64 {
    let pid = std::process::id().to_string();
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .expect("ps");
    let kib: f64 = String::from_utf8_lossy(&out.stdout)
        .trim_ascii()
        .parse()
        .expect("a size in KiB");
    kib / 1024.0
}

fn main() {
    let input = synthetic::synthetic_graph(100_000, 300_000, 1);
    let before = resident_mib();
    let graph = normalize(&input, NormalizeOptions::default()).expect("valid");
    let after = resident_mib();
    println!(
        "normalize, {} nodes / {} edges: resident {before:.1} MiB → {after:.1} MiB, +{:.1} MiB \
         (RFC 0002 §7 target: < 50 MB)",
        graph.node_count(),
        graph.edge_count(),
        after - before
    );
}
