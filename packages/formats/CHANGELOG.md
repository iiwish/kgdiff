# @kgdiff/formats

## 0.12.0

### Patch Changes

- Updated dependencies [603551e]
- Updated dependencies [eb7d948]
- Updated dependencies [21f269c]
  - @kgdiff/compute@0.12.0
  - @kgdiff/core@0.12.0

## 0.11.1

### Patch Changes

- d1c8034: `@kgdiff/core` exports everything `@kgdiff/formats` (deprecated) exports, so moving off formats means changing the import path only (`@kgdiff/formats` → `@kgdiff/core`), and the common case needs one package: `import { diff, formatHunk, parseGraph } from '@kgdiff/core'`. Nothing is removed and no type changes.
  - `parseGraph`, `detectFormat` and `compactIri`: asynchronous, with the signatures and results of `@kgdiff/formats`'. Like `diff`, they load `@kgdiff/compute` with a dynamic `import()` on the first call, so a bundle that only reads diffs still contains no WebAssembly.
  - `FORMAT_EXTENSIONS` and the parsers' types (`FormatId`, `ParseOptions`, `ParseResult`, `ParseWarning`, `ParseWarningCode`, `RdfOptions`, `JsonOptions`, `JsonLdOptions`, `JsonDialect`). `@kgdiff/core` defines them now; `@kgdiff/compute` and `@kgdiff/formats` re-export the same declarations and the same `FORMAT_EXTENSIONS` object.
  - `@kgdiff/compute`: its parsers' types and `FORMAT_EXTENSIONS` are re-exported from `@kgdiff/core`, the same declarations as before. `@kgdiff/formats`: its deprecation notes point to `@kgdiff/core`.

  The rule: the model packages (`@kgdiff/core`, `@kgdiff/layout`) give asynchronous entries that load the engine on the first call; for the synchronous API, for choosing where the `.wasm` files are loaded from, or for the low-level JSON functions, use `@kgdiff/compute`.
- f248f5a: No other kgdiff package depends on `@kgdiff/formats` any more, so that it can be marked deprecated on npm without warning everyone who installs `@kgdiff/compute` or `@kgdiff/viewer`. Nothing is removed and no type changes.
  - `@kgdiff/compute`: exports the parsers' types (`FormatId`, `ParseOptions`, `ParseResult`, `ParseWarning`, `ParseWarningCode`, `RdfOptions`, `JsonOptions`, `JsonLdOptions`, `JsonDialect`) and `FORMAT_EXTENSIONS`, the declarations `@kgdiff/core` defines since this release, the same as those of `@kgdiff/formats` 0.11.0. It no longer depends on `@kgdiff/formats`.
  - `@kgdiff/formats` (deprecated, and not published from 1.0 on: 0.11.x stays on npm and keeps working): re-exports those from `@kgdiff/compute`, and its `parseGraph`, `detectFormat` and `compactIri` call `@kgdiff/compute`'s. Its exports and their types are the ones of 0.11.0.
  - `@kgdiff/viewer`: `load()` parses text sources with `parseGraph` of `@kgdiff/compute` (imported on demand, as before), and `ParseOptions` comes from there. It no longer depends on `@kgdiff/formats`. The standalone viewer imports `@kgdiff/compute` for text sources, which an import map that served `@kgdiff/formats` already had to provide.
- Updated dependencies [d1c8034]
- Updated dependencies [f248f5a]
  - @kgdiff/core@0.11.1
  - @kgdiff/compute@0.11.1

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

### Patch Changes

- @kgdiff/core@0.8.0

## 0.7.0

### Minor Changes

- cca58f9: JSON input with a lone surrogate escape is rejected. `JSON.parse` accepts `"\ud800"`, half of a UTF-16 surrogate pair escaped without its other half, and kgdiff used to carry it through ids and labels into its diffs and deltas; such text is not Unicode, and the Rust implementation (RFC 0002) cannot hold it. `parseGraph` now throws `invalid-input` for one in JSON and JSON-LD, located at the escape (`Invalid JSON on line 6, column 35: the escape \ud83d is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept.`), and so does a JSON-LD context text a `documentLoader` returns; `kgdiff apply` refuses a delta that has one. Escaped surrogate pairs (`"😀"`) read as before.
- cca58f9: Numbers beyond the range of a double in JSON graphs are kept instead of lost. JSON may write `1e400`, which `JSON.parse` reads as `Infinity`; the JSON reader used to drop such a number without a word (an attribute or `meta` member disappeared, an array item became `null`), so a diff could report nothing for a value that changed, or a change that did not happen. It now keeps the value as the string `"Infinity"` or `"-Infinity"`, as `normalize` keeps a non-finite number an API caller passes, and reports how many with a `json-non-finite` warning (`ParseWarningCode`), in every JSON dialect.

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

### Minor Changes

- 0330630: kgdiff JSON names its format like diffs and deltas do: `graphToJSON` and `kgdiff apply` write `"format": "kgdiff.graph", "version": 1` first. Files without the marker are still read by their shape. With it, a file is read as kgdiff JSON without guessing, a newer version is refused, and so is a diff or a delta given where a graph is expected, with a message that says what the file is. JSON Schemas for graphs, diffs and deltas ship with `@kgdiff/core` (`@kgdiff/core/schema/graph.v1.json`, `diff.v1.json`, `delta.v1.json`), and tests validate everything kgdiff writes against them.

### Patch Changes

- Updated dependencies [0330630]
  - @kgdiff/core@0.2.0

## 0.1.0

Initial release.
