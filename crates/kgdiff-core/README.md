# kgdiff-core

The diff engine of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: normalizing, matching,
classifying, hunking, deltas, hashing and the JSON transports of knowledge-graph diffs, written to
produce the same bytes as the TypeScript package
[`@kgdiff/core`](https://www.npmjs.com/package/@kgdiff/core): the same `kgdiff.diff`,
`kgdiff.diff.packed`, `kgdiff.delta` and `kgdiff.graph` documents, content hashes and hunk titles
(English and Simplified Chinese).

```rust
use kgdiff_core::js::json;
use kgdiff_core::{DiffOptions, diff, diff_to_json};

let before = json::parse(r#"{"nodes":[{"id":"a","label":"Ada"}],"edges":[]}"#)?;
let after = json::parse(r#"{"nodes":[{"id":"a","label":"Ada Lovelace"}],"edges":[]}"#)?;
let result = diff(&before, &after, &DiffOptions::default())?;
println!("{}", json::to_string(&diff_to_json(&result)));
# Ok::<(), Box<dyn std::error::Error>>(())
```

This is phase 2 of
[RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md). The
conformance corpus in [`conformance/`](https://github.com/iiwish/kgdiff/tree/main/conformance)
specifies what the crate computes; `cargo test -p kgdiff-core --test conformance` checks every
case. Parsers (RDF, OBO, JSON dialects), the CLI's text outputs and the layout come in later
phases, as `kgdiff-formats`, `kgdiff-report` and `kgdiff-layout`.

Licensed under the MIT license.
