# kgdiff-layout

The layout of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: one stable, deterministic,
label-aware set of coordinates for both versions of a knowledge-graph diff, so that nothing jumps
when a viewer switches between before, after, overlay and replay. A port of the TypeScript package
[`@kgdiff/layout`](https://www.npmjs.com/package/@kgdiff/layout) and of the parts of d3-force and
d3-quadtree it uses.

```rust
use kgdiff_core::js::json;
use kgdiff_core::{DiffOptions, diff};
use kgdiff_layout::{LayoutOptions, layout_diff, layout_to_json};

let before = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"source":"a","target":"b","predicate":"p"}]}"#)?;
let after = json::parse(r#"{"nodes":[{"id":"a"},{"id":"c"}],"edges":[{"source":"a","target":"c","predicate":"p"}]}"#)?;
let result = diff(&before, &after, &DiffOptions::default())?;
let layout = layout_diff(&result, &LayoutOptions::default())?;
assert_eq!(layout.positions.len(), 3);
// The kgdiff.layout document, version 2.
println!("{}", json::to_string(&layout_to_json(&layout)));
# Ok::<(), Box<dyn std::error::Error>>(())
```

This is phase 4 of
[RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md). What
does not depend on floating-point simulation — the scope, radii, `hidden` counts, strategy, tick
counts of union layouts, component membership and order, and the label widths the scene shares —
must equal TypeScript's, and the conformance corpus checks it
(`cargo test -p kgdiff-layout --test conformance`). Positions only have to be good, deterministic
and identical on every target: results use only `+ − × ÷ √`, comparisons and conversions, and a
seeded PRNG.

Layout documents are `kgdiff.layout` version 2 (`generator: "kgdiff-layout/1"`), described by
[`layout.v2.json`](https://github.com/iiwish/kgdiff/blob/main/packages/core/schema/layout.v2.json);
version 1 documents of the TypeScript engine are read as well.

Licensed under the MIT license.
