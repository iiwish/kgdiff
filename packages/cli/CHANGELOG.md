# @kgdiff/cli

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
