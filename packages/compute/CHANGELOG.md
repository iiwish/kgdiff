# @kgdiff/compute

## 0.11.0

### Minor Changes

- de02790: `@kgdiff/compute` is published: kgdiff's Rust engine as three WebAssembly modules, each loaded only when asked for (RFC 0002, §7). `compute` diffs, matches and normalizes graphs, `formats` reads graph files, and `layout` lays diffs out on typed arrays, small enough to be inlined in an HTML report; `@kgdiff/compute/layout` loads that one alone. `init()` loads them (`init({ modules: ['layout'] })` only some), then `diffSync`, `matchNodesSync`, `textSimilaritySync`, `parseGraphSync`, `detectFormatSync`, `layoutDiffSync`, `extendLayoutSync`, `layoutGraphSync`, `layoutDiffOnSync` and `layoutAfterSync` give the objects of `@kgdiff/core`, `@kgdiff/formats` and `@kgdiff/layout`; `diff`, `parseGraph`, `layoutDiff` and the others load their module themselves. `json` is the same on JSON text, byte for byte what the kgdiff CLI writes. The other packages do not use it yet.
- 01a57e9: **Breaking.** Computing runs on kgdiff's Rust engine in WebAssembly (`@kgdiff/compute`) everywhere, and the functions that compute are asynchronous (RFC 0002, phase 5). The results are the kgdiff CLI's, byte for byte.
  - `@kgdiff/core`: `diff`, `matchNodes` and `textSimilarity` return promises. `log2` is deprecated (use `Math.log2`).
  - `@kgdiff/formats` is deprecated in favour of `@kgdiff/compute`: `parseGraph`, `detectFormat` and `compactIri` return promises and run its parsers.
  - `@kgdiff/layout`: `layoutDiff` and `extendLayout` return promises; new `layoutGraph`, `layoutDiffOn` and `layoutAfter`, to keep one map across versions. Positions are the Rust engine's, which are 0.10's for the same input (the conformance corpus checked the two engines against each other on every case through 0.10); layouts are now written as version 2 documents.
  - `@kgdiff/compute`: `diffSync` and `diffAndLayoutSync` read the engine's diff back without `diffFromJSON`'s consistency checks (it was written by the same build; documents from elsewhere are still checked), and keep the node positions of the graphs, so a diff of graphs with positions is still laid out anchored on them, and the issues found normalizing them. Graphs may be given as `KGraph`s: as in 0.10, two with the same edge identity are compared with it when the options name none, and `matchNodes` reads each with its own.
  - `@kgdiff/viewer`: the compute module and the standalone add-on run on `@kgdiff/compute`. The add-on inlines the layout-only module, so single-file reports expand collapsed groups offline; an expansion asked for while it compiles waits for it. `load()` in the standalone viewer needs `@kgdiff/compute` in the import map. The viewer bundle has no WebAssembly.

  Migrating: put `await` in front of each changed call, or `await init()` of `@kgdiff/compute` once and use its `*Sync` functions. Pages with a Content Security Policy need `'wasm-unsafe-eval'` to compute. The read path (`normalize`, `hashGraph`, `diffFromJSON`, `applyDelta`, `formatHunk`, `layoutFromJSON`, …) stays synchronous. See docs/guide/migrating-to-0.11.md.

### Patch Changes

- Updated dependencies [47a78d8]
- Updated dependencies [01a57e9]
  - @kgdiff/core@0.11.0
  - @kgdiff/formats@0.11.0
  - @kgdiff/layout@0.11.0
