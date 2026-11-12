# kgdiff-core

The diff engine of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: a semantic, reviewable diff
of two versions of a knowledge graph, and the invertible delta between them.

`diff` normalizes both graphs, matches their nodes (by id, by replacement hints such as OBO's
`replaced_by`, or by similarity), detects renames, moves, merges and splits, classifies every node
and edge as added, removed, modified or unchanged, groups the changes into reviewable hunks and
emits the delta that turns the first graph into the second. The same input gives the same output,
byte for byte, on every platform. The crate also writes and reads the `kgdiff.diff`,
`kgdiff.diff.packed`, `kgdiff.delta` and `kgdiff.graph` documents, hashes graphs, applies and
inverts deltas, and words hunk titles in English and Simplified Chinese.

```rust
use kgdiff_core::js::json;
use kgdiff_core::{DiffOptions, Locale, diff, diff_to_json, format_hunk};

let before = json::parse(r#"{"nodes":[{"id":"a","label":"Ada"}],"edges":[]}"#)?;
let after = json::parse(r#"{"nodes":[{"id":"a","label":"Ada Lovelace"}],"edges":[]}"#)?;
let result = diff(&before, &after, &DiffOptions::default())?;

assert_eq!(result.stats.nodes.modified, 1);
let (title, _subtitle) = format_hunk(&result.hunks[0], &result, Locale::En)?;
assert_eq!(title, "Renamed “Ada” → “Ada Lovelace”");

// The kgdiff.diff document, as `kgdiff --json` writes it.
println!("{}", json::to_string(&diff_to_json(&result)));
# Ok::<(), Box<dyn std::error::Error>>(())
```

Graphs are given as kgdiff JSON ([`docs/formats.md`](https://github.com/iiwish/kgdiff/blob/main/docs/formats.md))
or as `GraphInput` values. To read RDF, OBO and the other JSON graph shapes, use
[`kgdiff-formats`](https://crates.io/crates/kgdiff-formats); to lay a diff out, use
[`kgdiff-layout`](https://crates.io/crates/kgdiff-layout); for the terminal summary, Markdown and
the HTML report, use [`kgdiff-report`](https://crates.io/crates/kgdiff-report).

How the diff is computed is described in
[`docs/algorithms.md`](https://github.com/iiwish/kgdiff/blob/main/docs/algorithms.md) and the delta
in [`docs/delta-format.md`](https://github.com/iiwish/kgdiff/blob/main/docs/delta-format.md). The
conformance corpus in [`conformance/`](https://github.com/iiwish/kgdiff/tree/main/conformance)
pins what the crate computes; `cargo test -p kgdiff-core --test conformance` checks every case.
The guide
[Embed kgdiff in a Rust application](https://github.com/iiwish/kgdiff/blob/main/docs/guide/embedding.md)
walks through using the crates together. In JavaScript, `@kgdiff/compute` is this crate compiled
to WebAssembly.

Licensed under the MIT license.
