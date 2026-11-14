# @kgdiff/core

## 0.12.1

### Patch Changes

- c136256: `@kgdiff/formats` is no longer published from 0.12.1 on, and its package is removed from the repository. It has been deprecated since 0.11.1; its releases stay on npm. Import `parseGraph`, `detectFormat`, `compactIri`, `FORMAT_EXTENSIONS` and the parsers' types from `@kgdiff/core` instead (the same functions and types), or use the `*Sync` functions of `@kgdiff/compute`.
- @kgdiff/compute@0.12.1

## 0.12.0

### Minor Changes

- 603551e: **JavaScript API:** before 1.0, the npm packages keep only the API they document, so that nothing kgdiff uses internally becomes a promise. Each entry point now has an API report (`packages/<name>/api/*.api.md`) that CI compares with the built declarations. Pages that use the viewer's elements through their attributes, properties, methods and events, and code that uses the other packages as documented, need no change. Guide: [Migrating to 0.12](https://github.com/iiwish/kgdiff/blob/main/docs/guide/migrating-to-0.12.md#javascript).
  - `@kgdiff/viewer/elements/*`: the element classes' declarations no longer show the members a subclass would override (`build`, `name`, `shadow`, `context`, `upgradedProperties`, and the hooks of `<kgdiff-root>`), nor `KgdiffStage`'s `view`. Subclassing the element classes is not covered by semantic versioning: an element's public interface is what `custom-elements.json` lists. Extend an element by composition (slots, `addLayer`, `registerObstacle`, events).
  - `@kgdiff/viewer/elements/stage` no longer exports `STAGE_REGIONS`: use the `StageRegion` values (`'dock'`, `'transport'`, `'legend'`, `'zoom'`, `'minimap'`). It exports `Context`, the type of `stageContext`.
  - `@kgdiff/compute/layout` no longer exports `layoutModule`: call `init()` and the entry point's functions.
  - `@kgdiff/core/computed` is an internal entry point of `@kgdiff/compute` of the same version, not covered by semantic versioning.
  - `@kgdiff/g6` exports `ElementKind`, the type of `KgdiffDatumData.kgdiff`.
  - `@kgdiff/scene`: `shape2` of `EdgeVisual` and `GlyphVisual` is documented as experimental, like `shape1`.
- eb7d948: **Rust crates:** the public Rust API makes room for the additions planned after 1.0, so that none of them needs a major release. The JavaScript API changes too, in a separate entry (it keeps only what is documented); the CLI, the document formats and every output byte are those of 0.11, so for the command line the upgrade is the version number. Guide: [Migrating to 0.12](https://github.com/iiwish/kgdiff/blob/main/docs/guide/migrating-to-0.12.md); what each version promises from now on: [Versioning](https://github.com/iiwish/kgdiff/blob/main/docs/versioning.md).
  - Enums that will grow are `#[non_exhaustive]` (error, issue and warning codes, formats, locales, strategies, facets, delta ops): a `match` on them needs a `_` arm. `ChangeStatus`, `HunkKind`, `ReplayPhase`, `SuggestionReason`, `End` and `js::Value` stay exhaustive.
  - Options, inputs and results are `#[non_exhaustive]`: build them from `Default::default()` or a constructor and set the fields (`let mut options = DiffOptions::default(); options.edge_identity = …;`). New constructors: `ReportInfo::new`, `ReportSide::new`, `ViewerBundles::new`, `MarkdownOptions::new`, `TextContext::new`.
  - The internals kgdiff's crates share are hidden from the documentation and not covered by semantic versioning: `kgdiff_core::js` apart from `Value`, `Object`, `JsStr`, `json`, `IndexMap` and `IndexSet`; `kgdiff_core::{canonical, text, util}`; `kgdiff_report::{locale, model, width}`; every module of `kgdiff` apart from `cli`, `io`, `system` and `testing`.
  - `kgdiff_core::js::BuildHasher` (the hasher of the public `IndexMap` and `IndexSet`) is kgdiff's own type instead of `foldhash::fast::RandomState`, so that a foldhash upgrade cannot change the public types.
  - The `kgdiff` crate's embedding interface: `CliIo::viewer_bundle` returns `ViewerMissing` instead of the internal `Failure`; `FileStat` (`FileStat::new`), `ViewerBundle` and `SystemIo` (`SystemIo::default()`) are `#[non_exhaustive]`.
  - CI checks the Rust API against the last release with `cargo-semver-checks`.

### Patch Changes

- 21f269c: **Rust crates only:** the public API of `kgdiff-core`, `kgdiff-formats`, `kgdiff-layout`, `kgdiff-report` and `kgdiff` is documented on docs.rs: every public type, field, variant and function has a description, functions that return `Result` say what they fail with, and the crate pages and READMEs describe what each crate provides, with an example that runs as a test. `#![warn(missing_docs)]` keeps it that way. No type, signature or behavior changes.
- Updated dependencies [603551e]
  - @kgdiff/compute@0.12.0

## 0.11.1

### Patch Changes

- d1c8034: `@kgdiff/core` exports everything `@kgdiff/formats` (deprecated) exports, so moving off formats means changing the import path only (`@kgdiff/formats` → `@kgdiff/core`), and the common case needs one package: `import { diff, formatHunk, parseGraph } from '@kgdiff/core'`. Nothing is removed and no type changes.
  - `parseGraph`, `detectFormat` and `compactIri`: asynchronous, with the signatures and results of `@kgdiff/formats`'. Like `diff`, they load `@kgdiff/compute` with a dynamic `import()` on the first call, so a bundle that only reads diffs still contains no WebAssembly.
  - `FORMAT_EXTENSIONS` and the parsers' types (`FormatId`, `ParseOptions`, `ParseResult`, `ParseWarning`, `ParseWarningCode`, `RdfOptions`, `JsonOptions`, `JsonLdOptions`, `JsonDialect`). `@kgdiff/core` defines them now; `@kgdiff/compute` and `@kgdiff/formats` re-export the same declarations and the same `FORMAT_EXTENSIONS` object.
  - `@kgdiff/compute`: its parsers' types and `FORMAT_EXTENSIONS` are re-exported from `@kgdiff/core`, the same declarations as before. `@kgdiff/formats`: its deprecation notes point to `@kgdiff/core`.

  The rule: the model packages (`@kgdiff/core`, `@kgdiff/layout`) give asynchronous entries that load the engine on the first call; for the synchronous API, for choosing where the `.wasm` files are loaded from, or for the low-level JSON functions, use `@kgdiff/compute`.
- Updated dependencies [d1c8034]
- Updated dependencies [f248f5a]
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
- Updated dependencies [01a57e9]
  - @kgdiff/compute@0.11.0

## 0.10.0

### Minor Changes

- 9168d34: Deltas now carry the changes of ignored attributes. Breaking before 1.0.

  With `ignoreAttrs` (`--ignore-attr`), those changes used to be left out of the delta while its
  target hash covered every attribute, so applying the delta could not reach the target and
  `kgdiff apply` warned that the result differed. Now `applyDelta(A, diff(A, B).delta)` hashes to
  `hashGraph(B)`, and the inverse restores `A`, whatever is ignored.

  "Ignored" now means what the diff matches on and shows, and nothing else: ignored attributes
  take no part in similarity, and their changes produce no facet, status, count or summary line.

  If you read deltas made with `--ignore-attr`: they have more ops than before, at the head of the
  delta and in no hunk, and a diff that reports no change can have a non-empty delta, as already
  happened for id-only renames under `similarity`. Hunk contents are unchanged, but their `ops`
  indices shift by the number of these ops. Deltas made by earlier versions still apply, with the
  same warning as before. The delta and diff document versions do not change.
- bfe4b0d: Node shapes by type (RFC 0003, part 4b), experimental until 1.0. `buildScene` takes
  `shapes`, a map of node type to `circle`, `square`, `diamond` or `hexagon`; a node takes the shape
  of the first entry among its types. Shape says what kind of thing a node is: the ghost, the ring,
  the halo, the pulse and the edges all follow the outline, and picking tests the outline. Every
  shape fits the box the layout reserves, so layouts do not change. `kgdiff-node` in `@kgdiff/g6`
  draws them too; G6's own node types stay circles. A report's `view.shapes` (`ReportInfo.shapes` in
  `kgdiff-report`, described in `report.v1.json`) carries the map to `<kgdiff-viewer>`, whose legend
  lists the shapes in use. Without `shapes`, frames, draw calls and reports are unchanged.

## 0.9.0

### Minor Changes

- 6c3a764: The payload of an HTML report has a JSON Schema: `schema/report.v1.json` describes `kgdiff.report` version 1 (`format`, `version`, the diff, packed or not, the optional `layout` of version 1 or 2, `meta` and the optional `view`), so an application that makes or reads reports can validate them as it can graphs, diffs and deltas. Members of `view` the schema does not name are allowed: later minor versions add optional ones, and viewers ignore those they do not know. The schema and `schema/layout.v2.json`, the layout document of kgdiff's Rust engine it refers to, are exported as `@kgdiff/core/schema/report.v1.json` and `@kgdiff/core/schema/layout.v2.json` (`layout.v2.json` was in the package already, without an export). In Rust, the `kgdiff-report` crate takes the layout of a report from its caller (RFC 0003, part 2): `report_payload_with` and `build_report_html_with` take a `ReportLayout`, which is `Default` (the layout of the default options, what `report_payload` and `build_report_html` keep writing, byte for byte), `Given(&layout)` (a layout the application has already, checked against the diff and refused with `invalid-input` when it places a node the diff does not have, or has scope `all` and leaves one out) or `None` (no layout: the viewer lays the diff out when the report opens). What `kgdiff` writes does not change.

## 0.8.0

No changes in this release.

## 0.7.0

### Minor Changes

- d01c4e0: Matching gives the same result in every JavaScript engine. Its neighbour and key weights (`1 / log₂(2 + degree)`, `1 / log₂(1 + postings)`) now use a `log₂` built from exactly rounded operations only, the one the layout already used, instead of `Math.log2`, which engines may approximate differently: V8 ports FreeBSD's `e_log2.c`, while an engine that calls the platform's C library gets that library's rounding (Apple's differs from V8 on 439 of the integers up to 2,000,000). A diff computed in a browser, as the playground does, now equals the CLI's whatever the engine. The new `log₂` differs from V8's by one unit in the last place on about 2% of integers; no match, suggestion or score changes in the conformance corpus, the example datasets or 144 synthetic diffs, but a score that sits exactly on a rounding boundary or a tie can move. The function is exported as `log2`, and `@kgdiff/layout` uses it from core.
- 7586808: Reports open the same way whatever Unicode version the browser has. `diffFromJSON` takes the labels, aliases and types of a document's snapshots as written instead of composing them to NFC again with the runtime's ICU, and the content hashes in the delta check that text: a report made with Node 24 (Unicode 17) no longer fails to open in a browser with older tables when a label holds a character whose composition changed in between, and a snapshot whose text was edited or is not in NFC is still rejected. To restore a label it left out without Unicode tables either, kgdiff JSON (diffs, graphs and deltas) now leaves an edge label out only when it equals `predicateLabel(predicate)` before its NFC step; a predicate whose readable part is written decomposed keeps its label in the document. A diff written by an earlier version for such a predicate, with that label left out, no longer opens: write it again. `normalize` composes API input to NFC as before.

## 0.6.0

No changes in this release.

## 0.5.0

### Minor Changes

- f957a49: `diffFromJSON` checks that a diff document is consistent before it returns, and throws `invalid-input` naming the first contradiction: an element whose versions do not fit its status (an added node with a before id, a removed edge with an after snapshot), an unchanged element with facets or a hunk, a changed one outside every hunk, a repeated id, an edge whose endpoints are not union nodes or disagree with its snapshots, a hunk that lists elements that are not its own, delta ops owned by two hunks or out of range, hunks out of review order, a summary or stats that do not match the elements, or a delta whose base or target is another graph (by content hash). Until now such a document was read as it was, and a viewer could show wrong counts or export a delta for other graphs. Everything kgdiff writes passes. `diffFromJSON` is also about 10% faster on large diffs: edges are found by their key instead of by a canonical JSON fingerprint. `schema/diff.v1.json` states the same rules per element (versions by status; facets and hunk by status).
- 212c48c: `UnionNode` and `UnionEdge` are now unions by `status`, so the types say which versions an element is in: an `added` node has `afterId` and `after` and no before version, a `removed` one only `beforeId` and `before`, an `unchanged` or `modified` one both; the same for edges, where only edges in both versions can have `sourceBefore`, `targetBefore` or `predicateBefore`. Narrow on `status` to read `before` / `after` without `?.` or casts (`AddedUnionNode`, `RemovedUnionNode`, `MatchedUnionNode` and the edge counterparts name the cases). The objects themselves are unchanged; code that builds union elements by hand (test fixtures, mocks) now has to give each status the versions it implies.
- 6ed2b9c: HTML reports are smaller: they embed the diff packed (`packDiffJSON`, format `kgdiff.diff.packed`, schema `schema/diff-packed.v1.json`), with its unchanged elements, which are most of a large diff, stored as tables of indices into one string table. For 100k nodes / 300k edges the embedded diff goes from 68.7 MB to 19.3 MB, 6.8 MB to 3.2 MB gzipped, and the report opens as fast. `unpackDiffJSON` gives the `DiffJSON` back byte for byte; the viewer reads packed and unpacked payloads (`ReportPayload.diff` is either), so older reports still open. The standalone viewer bundle budget goes from 100 kB to 105 kB (min + gzip) for the unpacking and the consistency checks of `diffFromJSON`.

### Patch Changes

- 638c617: `diffFromJSON` is about 30% faster on large diffs, so HTML reports open about 20% sooner: a report of 100k nodes / 300k edges is ready in 1.0 s instead of 1.24 s in headless Chrome. Rebuilding the two graphs was most of `diffFromJSON`. The snapshots `diffToJSON` writes are already canonical, so they are now read straight into graphs, and each union edge keeps the edge it was read into instead of looking it up again. A document `normalize` would change (parallel edges, a repeated id, a dangling end, a hand-edited snapshot) is normalized as before, as fast as before. The result is the same, field for field and in the same order: `diffToJSON(diffFromJSON(j))` is still `j`, byte for byte, the graph hashes are unchanged, and every consistency check still runs.
- ed1c3c9: Normalized graphs take about 30% less memory: a graph of 100k nodes and 300k edges now keeps about 111 MB of heap instead of 157 MB. Structural edge keys were built by concatenation, which V8 stores as a rope of many small strings that stays allocated behind every key; they are now built as flat strings, which are also quicker to hash. Keys, diffs, deltas and their JSON are unchanged, byte for byte.
- f02bc72: Similarity matching no longer pairs two same-named nodes on their label alone when their types conflict. With `--match similarity` nothing is matched in the first round, so the neighbour evidence was missing for every pair and an equal label outweighed disjoint types: “Mercury” the planet (orbiting the Sun) and “Mercury” the element (with symbol Hg) were reported as one node whose type changed. Such a pair (both nodes typed, no type and no attribute in common, neighbours not matched yet) now waits for the next round, when propagation brings in the neighbours; the two Mercurys share none, so they are reported as removed and added with a possible match below the threshold, as `--match auto` already did. A type change that the neighbours confirm is still matched, and nodes without edges are matched as before.
- 6d34966: The standalone viewer bundle, which every HTML report inlines, no longer carries the facet names
  of `facetLabel`: they are kept apart from the hunk phrasebooks that `formatHunk` reads, which
  saves 0.2 kB (min + gzip). Behaviour is unchanged. The bundle's size ceiling goes from 105 kB to
  130 kB, so a feature no longer has to raise it, and the HTML report overhead budget (without data
  or compute add-on) from 120 kB to 135 kB gzip, so it still covers the bundle.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- 0330630: kgdiff JSON names its format like diffs and deltas do: `graphToJSON` and `kgdiff apply` write `"format": "kgdiff.graph", "version": 1` first. Files without the marker are still read by their shape. With it, a file is read as kgdiff JSON without guessing, a newer version is refused, and so is a diff or a delta given where a graph is expected, with a message that says what the file is. JSON Schemas for graphs, diffs and deltas ship with `@kgdiff/core` (`@kgdiff/core/schema/graph.v1.json`, `diff.v1.json`, `delta.v1.json`), and tests validate everything kgdiff writes against them.

## 0.1.0

Initial release.
