# @kgdiff/cli

## 0.5.0

### Minor Changes

- 764535e: The terminal summary and the Markdown summary (so the GitHub Action's pull request comment too) list the possible matches: pairings kgdiff considered but did not apply, between a node listed as removed and one listed as added. Until now only the viewer's detail panel showed them, so "removed “Saudi Aramco”, added “Aramco”" gave no hint that the two may be one entity. Each line names both nodes (with their ids when the names are equal), the score, why it was not applied (below `--threshold`, or too close to another candidate) and the label and neighbourhood evidence, and a closing line says how to pair one: a synonym, a replacement link or a lower threshold. At most 10 in the terminal (all with `--limit 0`) and 20 in Markdown; `--json` keeps every suggestion.
- 3f6e7d8: Changes to definitions are flagged ⚑ for review first. A reworded definition can change what existing data means while the diff looks small, and it used to be folded into `~1 attribute` among the other edits. Now a line under the diffstat bar counts the hunks that change one (`⚑ Review first: definition changed in 9 hunks`, also in `--stat`), each of their rows says so before its summary (`content · ⚑ definition · ~2 attributes`), and the Markdown summary, so the GitHub Action's pull request comment too, lists them in a ⚑ _Review first_ block before the phase groups. By default kgdiff watches `def` (OBO), `definition` (kgdiff JSON), `IAO:0000115` and `skos:definition`; the new `--watch-attr <key>` (repeatable) replaces that list, e.g. `--watch-attr rdfs:comment` for schema.org-style vocabularies. `TextContext` and `MarkdownOptions` take the same list as `watch`, and `DEFAULT_WATCH_ATTRS` and `watchedChanges` are exported.
- 6ed2b9c: HTML reports are smaller: they embed the diff packed (`packDiffJSON`, format `kgdiff.diff.packed`, schema `schema/diff-packed.v1.json`), with its unchanged elements, which are most of a large diff, stored as tables of indices into one string table. For 100k nodes / 300k edges the embedded diff goes from 68.7 MB to 19.3 MB, 6.8 MB to 3.2 MB gzipped, and the report opens as fast. `unpackDiffJSON` gives the `DiffJSON` back byte for byte; the viewer reads packed and unpacked payloads (`ReportPayload.diff` is either), so older reports still open. The standalone viewer bundle budget goes from 100 kB to 105 kB (min + gzip) for the unpacking and the consistency checks of `diffFromJSON`.

### Patch Changes

- 86f4583: The bug report link of an unexpected error takes the platform and the Node.js version from `CliIO.runtime` instead of reading `process` in `main`, so `main` keeps taking every side effect from `io` and runs in hosts other than Node.js. `nodeIO()` fills it in, so the link is unchanged for the `kgdiff` command; a custom `io` without `runtime` gets a link that names only the CLI version.
- 088671c: Link unexpected CLI errors to a bug-report form prefilled with public version and runtime
  metadata, without including error messages or input paths in the URL.
- f02bc72: Similarity matching no longer pairs two same-named nodes on their label alone when their types conflict. With `--match similarity` nothing is matched in the first round, so the neighbour evidence was missing for every pair and an equal label outweighed disjoint types: “Mercury” the planet (orbiting the Sun) and “Mercury” the element (with symbol Hg) were reported as one node whose type changed. Such a pair (both nodes typed, no type and no attribute in common, neighbours not matched yet) now waits for the next round, when propagation brings in the neighbours; the two Mercurys share none, so they are reported as removed and added with a possible match below the threshold, as `--match auto` already did. A type change that the neighbours confirm is still matched, and nodes without edges are matched as before.
- Updated dependencies [638c617]
- Updated dependencies [f957a49]
- Updated dependencies [ed1c3c9]
- Updated dependencies [212c48c]
- Updated dependencies [f02bc72]
- Updated dependencies [6ed2b9c]
- Updated dependencies [6d34966]
- Updated dependencies [5286e02]
  - @kgdiff/core@0.5.0
  - @kgdiff/viewer@0.5.0
  - @kgdiff/formats@0.5.0
  - @kgdiff/layout@0.5.0
  - @kgdiff/scene@0.5.0

## 0.4.0

### Minor Changes

- 86fe0da: Changes only is now a scope that combines with any mode instead of a fourth mode: `mode` is `overlay | swipe | replay` and the new `scope` (`all | changes`) shows only the changes, in overlay, swipe or replay alike. `mode="changes"` still works (overlay + `scope="changes"`), as do old `#kgdiff=…;mode:changes` links; `kgdiff-mode` reports `{ mode, scope }`. The CLI gains `--scope` (`--mode changes` keeps working).

  The canvas loses its header bar: the title floats top left, the actions top right, and the modes, the Changes only toggle with its context hops, and replay's transport live in one dock at the bottom. The diffstat pills (the sidebar's filter chips show the same counts) and the second fit button are gone, the chips wear the legend's swatches, the legend starts collapsed and the minimap appears only while part of the graph is out of view. Unchanged node labels use the muted text color, so the changes stand out.

### Patch Changes

- Updated dependencies [86fe0da]
  - @kgdiff/viewer@0.4.0
  - @kgdiff/scene@0.4.0
  - @kgdiff/core@0.4.0
  - @kgdiff/formats@0.4.0
  - @kgdiff/layout@0.4.0

## 0.3.0

### Patch Changes

- 148fdb1: The viewer embeds as a small looping replay: `<kgdiff-viewer mode="replay" chrome="none" loop>`. `chrome="none"` shows the graph alone, with its hover tooltip and a one-line legend (`legend="auto|full|mini|none"`), no header, change list, step caption, playback bar, zoom buttons or minimap; it fits a 320px strip (the minimum height drops to 120px) and keeps the view fitted. `loop` plays the replay by itself and starts it again after `loop-delay` ms (1200), pausing while the mouse is over the graph unless `pause-on-hover="false"`. A new `kgdiff-replay-end` event fires whenever playback reaches the end. Fitting leaves room for node labels, so the names of the outermost nodes are no longer cut off at the edge of the canvas, and `fit()` takes `{ padding }`; without chrome, a label pushed aside by a neighbour stays inside the canvas or is left out. `@kgdiff/renderer` adds `labelFootprint(frame, theme)`, what a frame covers with its labels at a given zoom, and `setLabelsInside()` / the `labelsInside` option, which keep labels whole inside the canvas.
- Updated dependencies [148fdb1]
  - @kgdiff/viewer@0.3.0
  - @kgdiff/core@0.3.0
  - @kgdiff/formats@0.3.0
  - @kgdiff/layout@0.3.0
  - @kgdiff/scene@0.3.0

## 0.2.0

### Minor Changes

- 0330630: kgdiff JSON names its format like diffs and deltas do: `graphToJSON` and `kgdiff apply` write `"format": "kgdiff.graph", "version": 1` first. Files without the marker are still read by their shape. With it, a file is read as kgdiff JSON without guessing, a newer version is refused, and so is a diff or a delta given where a graph is expected, with a message that says what the file is. JSON Schemas for graphs, diffs and deltas ship with `@kgdiff/core` (`@kgdiff/core/schema/graph.v1.json`, `diff.v1.json`, `delta.v1.json`), and tests validate everything kgdiff writes against them.

### Patch Changes

- d88fc85: The detail panel (and the HTML report) leads with what changed: one row per changed facet, before → after. A lone removed and added synonym, type or parent reads as one edit (`老赖 → 失信人`), similar ones pair up, and unchanged attributes fold behind a toggle. Added and removed nodes now show their synonyms.
- Updated dependencies [d88fc85]
- Updated dependencies [0330630]
  - @kgdiff/viewer@0.2.0
  - @kgdiff/core@0.2.0
  - @kgdiff/formats@0.2.0
  - @kgdiff/layout@0.2.0
  - @kgdiff/scene@0.2.0

## 0.1.0

Initial release.
