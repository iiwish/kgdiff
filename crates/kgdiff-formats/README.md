# kgdiff-formats

The parsers of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: kgdiff JSON and the common JSON
graph shapes (d3 / NetworkX, Cytoscape.js, AntV G6, graphology, vis-network), RDF (Turtle,
N-Triples, N-Quads, TriG, RDF/XML, JSON-LD) and OBO, read into the graphs
[`kgdiff-core`](https://crates.io/crates/kgdiff-core) diffs. It gives what the TypeScript package
[`@kgdiff/formats`](https://www.npmjs.com/package/@kgdiff/formats) gives: the same graph, prefixes,
relation labels and warnings, the same errors.

```rust
use kgdiff_formats::{ParseOptions, parse_graph};

let text = r#"{"nodes":[{"id":"a","label":"Ada"}],"edges":[]}"#;
let result = parse_graph(text, &ParseOptions::default())?;
assert_eq!(result.format.id(), "json");
# Ok::<(), kgdiff_core::KgdiffError>(())
```

This is phase 3 of
[RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md). The
conformance corpus in [`conformance/`](https://github.com/iiwish/kgdiff/tree/main/conformance)
specifies what the crate computes: every case's `parse.before.json` and `parse.after.json`.
Nothing is ever fetched: JSON-LD remote contexts come only from a document loader you pass.

Licensed under the MIT license.
