# @kgdiff/layout

## 0.11.0

### Minor Changes

- 47a78d8: **Breaking.** The TypeScript compute code that kgdiff's Rust engine (`@kgdiff/compute`) replaced is removed (RFC 0002, phase 5): about 13,000 lines of source. The asynchronous functions that compute are unchanged, and the read path (`normalize`, `hashGraph`, `diffFromJSON`, `applyDelta`, `formatHunk`, `layoutFromJSON`, …) stays in TypeScript, synchronous.
  - `@kgdiff/core`: `log2`, deprecated in the previous change, is removed (use `Math.log2`). The TypeScript matching, classification, hunks, delta emission and similarity are removed; `diff`, `matchNodes` and `textSimilarity` run on `@kgdiff/compute`.
  - `@kgdiff/formats`: the TypeScript parsers are removed, and with them the dependency on `n3`. `parseGraph`, `detectFormat`, `compactIri`, `FORMAT_EXTENSIONS` and the types stay; the package remains deprecated in favour of `@kgdiff/compute`.
  - `@kgdiff/layout`: the TypeScript layout engine is removed, and with it the dependencies on `d3-force` and `d3-quadtree`.
- 01a57e9: **Breaking.** Computing runs on kgdiff's Rust engine in WebAssembly (`@kgdiff/compute`) everywhere, and the functions that compute are asynchronous (RFC 0002, phase 5). The results are the kgdiff CLI's, byte for byte.
  - `@kgdiff/core`: `diff`, `matchNodes` and `textSimilarity` return promises. `log2` is deprecated (use `Math.log2`).
  - `@kgdiff/formats` is deprecated in favour of `@kgdiff/compute`: `parseGraph`, `detectFormat` and `compactIri` return promises and run its parsers.
  - `@kgdiff/layout`: `layoutDiff` and `extendLayout` return promises; new `layoutGraph`, `layoutDiffOn` and `layoutAfter`, to keep one map across versions. Positions are the Rust engine's, which are 0.10's for the same input (the conformance corpus checked the two engines against each other on every case through 0.10); layouts are now written as version 2 documents.
  - `@kgdiff/compute`: `diffSync` and `diffAndLayoutSync` read the engine's diff back without `diffFromJSON`'s consistency checks (it was written by the same build; documents from elsewhere are still checked), and keep the node positions of the graphs, so a diff of graphs with positions is still laid out anchored on them, and the issues found normalizing them. Graphs may be given as `KGraph`s: as in 0.10, two with the same edge identity are compared with it when the options name none, and `matchNodes` reads each with its own.
  - `@kgdiff/viewer`: the compute module and the standalone add-on run on `@kgdiff/compute`. The add-on inlines the layout-only module, so single-file reports expand collapsed groups offline; an expansion asked for while it compiles waits for it. `load()` in the standalone viewer needs `@kgdiff/compute` in the import map. The viewer bundle has no WebAssembly.

  Migrating: put `await` in front of each changed call, or `await init()` of `@kgdiff/compute` once and use its `*Sync` functions. Pages with a Content Security Policy need `'wasm-unsafe-eval'` to compute. The read path (`normalize`, `hashGraph`, `diffFromJSON`, `applyDelta`, `formatHunk`, `layoutFromJSON`, …) stays synchronous. See docs/guide/migrating-to-0.11.md.

### Patch Changes

- Updated dependencies [de02790]
- Updated dependencies [47a78d8]
- Updated dependencies [01a57e9]
  - @kgdiff/compute@0.11.0
  - @kgdiff/core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [9168d34]
- Updated dependencies [bfe4b0d]
  - @kgdiff/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [6c3a764]
  - @kgdiff/core@0.9.0

## 0.8.0

### Minor Changes

- 3fe4030: `layoutToJSON` writes a layout read from version 2 back as version 2, with its `generator` (RFC 0002, D-3). Before, it wrote version 1 and dropped the `generator`, so a layout of kgdiff's Rust engine that went through `layoutFromJSON` and `layoutToJSON` no longer said which engine computed its positions. Layouts this package computes, and layouts `extendLayout` added a node to, are still written as version 1. Version 2 has the member order of the Rust engine's documents (`format`, `version`, `generator`, then version 1's members), so `layoutToJSON(layoutFromJSON(json))` reproduces `json` of either version. Types: `layoutToJSON` returns `LayoutJSON` (`LayoutJSONV1 | LayoutJSONV2`) instead of `LayoutJSONV1`; code that needs version 1 checks `version`.

### Patch Changes

- @kgdiff/core@0.8.0

## 0.7.0

### Minor Changes

- 9ebb278: `layoutFromJSON` reads version 2 of the layout document, which kgdiff's Rust layout engine will write. Version 2 is version 1's members plus `generator`, a non-empty string such as `"kgdiff-layout/1"` that names the engine generation that computed the positions. It becomes the new optional `LayoutResult.generator`. Positions read from either version are valid pins for anchored layouts and `extendLayout`. A version 2 document without a `generator` is rejected (`invalid-input`), and versions other than 1 and 2 are rejected as before (`unsupported-version`). `layoutToJSON` still writes version 1, so a layout read from version 2 is written back as version 1 without its `generator`. Types: `LayoutJSON` is now the union of the documents `layoutFromJSON` reads, `LayoutJSONV1 | LayoutJSONV2`, and `layoutToJSON` returns `LayoutJSONV1`. Code that relied on `LayoutJSON['version']` being `1` should use `LayoutJSONV1`. Through `ReportPayload.layout` (a `LayoutJSON`), the viewer opens reports whose layout is version 2.

### Patch Changes

- Updated dependencies [d01c4e0]
- Updated dependencies [7586808]
  - @kgdiff/core@0.7.0

## 0.6.0

### Patch Changes

- @kgdiff/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [638c617]
- Updated dependencies [f957a49]
- Updated dependencies [ed1c3c9]
- Updated dependencies [212c48c]
- Updated dependencies [f02bc72]
- Updated dependencies [6ed2b9c]
- Updated dependencies [6d34966]
  - @kgdiff/core@0.5.0

## 0.4.0

### Patch Changes

- @kgdiff/core@0.4.0

## 0.3.0

### Patch Changes

- @kgdiff/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [0330630]
  - @kgdiff/core@0.2.0

## 0.1.0

Initial release.
