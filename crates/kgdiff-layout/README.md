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
seeded PRNG, and CI compares layout hashes across x86-64 Linux, AArch64 macOS, x86-64 Windows and
WebAssembly.

Layout documents are `kgdiff.layout` version 2 (`generator: "kgdiff-layout/1"`), described by
[`layout.v2.json`](https://github.com/iiwish/kgdiff/blob/main/packages/core/schema/layout.v2.json);
version 1 documents of the TypeScript engine are read as well.

## One graph

`layout_graph` lays out one graph. Its result is defined as the layout of the diff of that graph
with itself, with every node in scope (whatever the size of the graph), and the tests hold the
two to the same `kgdiff.layout` bytes on both graphs of every corpus case: going from a graph to
a diff of it moves nothing. Scope `Changes` is `invalid-input`, since one graph has no changes
to select.

The next version of a graph keeps the previous version's map when it is laid out with the
previous positions, as pins or as `position` on its nodes: those nodes stay exactly where they
are, and only the new ones are placed.

```rust
use kgdiff_core::js::json;
use kgdiff_core::{NormalizeOptions, normalize};
use kgdiff_layout::{LayoutOptions, layout_from_json, layout_graph, layout_to_json};

let first = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"source":"a","target":"b","predicate":"p"}]}"#)?;
let first = normalize(&first, NormalizeOptions::default())?;
let layout = layout_graph(&first, &LayoutOptions::default())?;

// Stored as a layout document, and read back when the next version arrives.
let stored = json::to_string(&layout_to_json(&layout));
let previous = layout_from_json(&json::parse(&stored)?)?;

let next = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"edges":[{"source":"a","target":"b","predicate":"p"},{"source":"b","target":"c","predicate":"p"}]}"#)?;
let next = normalize(&next, NormalizeOptions::default())?;
let pinned = LayoutOptions { pinned: previous.positions.clone(), ..LayoutOptions::default() };
let grown = layout_graph(&next, &pinned)?;
assert_eq!(grown.positions["a"], previous.positions["a"]); // a and b do not move
assert!(grown.positions.contains_key("c")); // c is placed beside them
# Ok::<(), Box<dyn std::error::Error>>(())
```

A layout keeps a known position exactly, and a layout document rounds coordinates to 0.01.
Computed positions are on that grid already, so positions read back from a layout document stay
as they are through any number of versions; a position from elsewhere (`300.125`) is kept exactly
in the `LayoutResult` and written as `300.13`.

`layout_graph` is new in 0.9 ([RFC 0003](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0003-embedding-hosts.md), part 1) and
experimental for one minor release. The TypeScript package `@kgdiff/layout` has no counterpart;
`@kgdiff/compute` will export it with the rest of the layout (RFC 0002, phase 5).

Licensed under the MIT license.
