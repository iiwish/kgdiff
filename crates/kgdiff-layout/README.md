# kgdiff-layout

The layout of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: one stable, deterministic,
label-aware set of coordinates for both versions of a knowledge-graph diff, so that nothing jumps
when a viewer switches between before, after, overlay and replay. `layout_diff` places every node
of a [`kgdiff-core`](https://crates.io/crates/kgdiff-core) diff once, with a force simulation that
keeps labels apart, packs disconnected components, and can limit the layout to the changes and
their context. The parts of d3-force and d3-quadtree it needs are built in.

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

Positions are good, deterministic and identical on every target: results use only `+ − × ÷ √`,
comparisons and conversions, and a seeded PRNG, and CI compares layout hashes across x86-64 Linux,
AArch64 macOS, x86-64 Windows and WebAssembly. What does not depend on floating-point simulation
(the scope, radii, `hidden` counts, strategy, tick counts of union layouts, component membership
and order, and the label widths renderers share) is pinned by the conformance corpus
(`cargo test -p kgdiff-layout --test conformance`).

Layout documents are `kgdiff.layout` version 2 (`generator: "kgdiff-layout/1"`), described by
[`layout.v2.json`](https://github.com/iiwish/kgdiff/blob/main/packages/core/schema/layout.v2.json);
version 1 documents, written by the engine that preceded this crate, are read as well.

## One graph

`layout_graph` lays out one graph. Its result is defined as the layout of the diff of that graph
with itself, with every node in scope (whatever the size of the graph), and the tests hold the
two to the same `kgdiff.layout` bytes on both graphs of every corpus case: going from a graph to
a diff of it moves nothing. Scope `Changes` is `invalid-input`, since one graph has no changes
to select.

Known positions, as pins or as `position` on the nodes, are kept: those nodes stay exactly where
they are, and only the others are placed. A layout keeps a known position exactly, and a layout
document rounds coordinates to 0.01. Computed positions are on that grid already, so positions
read back from a layout document stay as they are through any number of versions; a position
from elsewhere (`300.125`) is kept exactly in the `LayoutResult` and written as `300.13`.

## The next version on the same map

A position belongs to a node, not to an id, and the diff is what knows which node of the next
version continues which node of the previous one. `layout_diff_on` lays the diff out on the
previous version's map: every node that map has stays exactly where it is, under whatever id it
has now, removed nodes included, and only the new nodes are placed. `layout_after` then gives
the next version the positions of its diff, without computing any. Going from a version to the
next one, and from either to their diff, moves no node.

```rust
use kgdiff_core::js::json;
use kgdiff_core::{DiffOptions, NormalizeOptions, diff_graphs, normalize};
use kgdiff_layout::{LayoutOptions, layout_after, layout_diff_on, layout_from_json, layout_graph, layout_to_json};

let v1 = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"edges":[{"source":"a","target":"b","predicate":"p"},{"source":"b","target":"c","predicate":"p"}]}"#)?;
let v1 = normalize(&v1, NormalizeOptions::default())?;
let layout = layout_graph(&v1, &LayoutOptions::default())?;

// Stored as a layout document, and read back when the next version arrives.
let stored = json::to_string(&layout_to_json(&layout));
let previous = layout_from_json(&json::parse(&stored)?)?;

// Version 2: b continues under another id, c is gone and d is new.
let v2 = json::parse(r#"{"nodes":[{"id":"a"},{"id":"b2","replaces":["b"]},{"id":"d"}],"edges":[{"source":"a","target":"b2","predicate":"p"},{"source":"b2","target":"d","predicate":"p"}]}"#)?;
let v2 = normalize(&v2, NormalizeOptions::default())?;
let diff = diff_graphs(v1, v2, DiffOptions::default())?;

// The diff first, on the previous map: b2 is where b was, c stays, and d is placed.
let both = layout_diff_on(&diff, &previous, &LayoutOptions::default())?;
assert_eq!(both.positions["b2"], previous.positions["b"]);
assert_eq!(both.positions["c"], previous.positions["c"]);

// Then version 2, where its diff has it: the layout to store with version 2.
let next = layout_after(&diff, &both, &LayoutOptions::default())?;
assert_eq!(next.positions["b2"], previous.positions["b"]);
assert_eq!(next.positions["d"], both.positions["d"]);
# Ok::<(), Box<dyn std::error::Error>>(())
```

- The positions are carried through the diff, from a union node's `before_id` to its union id
  and its `after_id`. Laying the next version out with `layout_graph` and
  `pinned: previous.positions.clone()` carries them by id, which is the same only when no id
  changes: a node that continues under another id (a `replaces` hint, a match by similarity) is
  placed again as if it were new, and an id given to another node pins that node where the old
  one was.
- The diff comes first because the layout of the next version alone cannot see the removed
  nodes, and may put a new node where one of them was. On the diff, the new nodes are placed
  clear of them.
- The scope is every node, as for `layout_graph`. A pin in `options.pinned` wins over the
  previous layout, which wins over a `position` on a node. Scope `Changes` and strategy `Union`
  (which ignores known positions) are `invalid-input`, and so is, for `layout_after`, a layout
  that does not place every node of the after version.

The tests hold both functions to the `kgdiff.layout` bytes of the same pins written by hand, on
both graphs of every corpus case and on pairs whose ids change or are given to other nodes. The
guide
[Embed kgdiff in a Rust application](https://github.com/iiwish/kgdiff/blob/main/docs/guide/embedding.md)
walks through it, from the first layout to a report and the browser, with code that is tested
on the conformance corpus.

`layout_graph`, `layout_diff_on` and `layout_after` are new in 0.9
([RFC 0003](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0003-embedding-hosts.md), part 1).
In JavaScript they are `layoutGraph`, `layoutDiffOn` and `layoutAfter` of
[`@kgdiff/compute`](https://www.npmjs.com/package/@kgdiff/compute): this crate compiled to
WebAssembly.

Licensed under the MIT license.
