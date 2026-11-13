# @kgdiff/compute

## 0.12.0

### Minor Changes

- 603551e: **JavaScript API:** before 1.0, the npm packages keep only the API they document, so that nothing kgdiff uses internally becomes a promise. Each entry point now has an API report (`packages/<name>/api/*.api.md`) that CI compares with the built declarations. Pages that use the viewer's elements through their attributes, properties, methods and events, and code that uses the other packages as documented, need no change. Guide: [Migrating to 0.12](https://github.com/iiwish/kgdiff/blob/main/docs/guide/migrating-to-0.12.md#javascript).
  - `@kgdiff/viewer/elements/*`: the element classes' declarations no longer show the members a subclass would override (`build`, `name`, `shadow`, `context`, `upgradedProperties`, and the hooks of `<kgdiff-root>`), nor `KgdiffStage`'s `view`. Subclassing the element classes is not covered by semantic versioning: an element's public interface is what `custom-elements.json` lists. Extend an element by composition (slots, `addLayer`, `registerObstacle`, events).
  - `@kgdiff/viewer/elements/stage` no longer exports `STAGE_REGIONS`: use the `StageRegion` values (`'dock'`, `'transport'`, `'legend'`, `'zoom'`, `'minimap'`). It exports `Context`, the type of `stageContext`.
  - `@kgdiff/compute/layout` no longer exports `layoutModule`: call `init()` and the entry point's functions.
  - `@kgdiff/core/computed` is an internal entry point of `@kgdiff/compute` of the same version, not covered by semantic versioning.
  - `@kgdiff/g6` exports `ElementKind`, the type of `KgdiffDatumData.kgdiff`.
  - `@kgdiff/scene`: `shape2` of `EdgeVisual` and `GlyphVisual` is documented as experimental, like `shape1`.

### Patch Changes

- Updated dependencies [603551e]
- Updated dependencies [eb7d948]
- Updated dependencies [21f269c]
  - @kgdiff/core@0.12.0
  - @kgdiff/layout@0.12.0

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
  - @kgdiff/core@0.11.1
  - @kgdiff/layout@0.11.1

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
