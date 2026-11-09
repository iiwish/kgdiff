# kgdiff-layout

The layout of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: one stable, deterministic,
label-aware set of coordinates for both versions of a knowledge-graph diff, so that nothing jumps
when a viewer switches between before, after, overlay and replay. A port of the TypeScript package
[`@kgdiff/layout`](https://www.npmjs.com/package/@kgdiff/layout) and of the parts of d3-force and
d3-quadtree it uses.

This is phase 4 of
[RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md). What
does not depend on floating-point simulation — the scope, radii, `hidden` counts, strategy, tick
counts of union layouts, component membership and order, and the label widths the scene shares —
must equal TypeScript's, and the conformance corpus checks it
(`cargo test -p kgdiff-layout --test conformance`). Positions only have to be good, deterministic
and identical on every target: results use only `+ − × ÷ √`, comparisons and conversions, and a
seeded PRNG.

Licensed under the MIT license.
