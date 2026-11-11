# @kgdiff/scene

## 0.10.0

### Minor Changes

- bfe4b0d: Node shapes by type (RFC 0003, part 4b), experimental until 1.0. `buildScene` takes
  `shapes`, a map of node type to `circle`, `square`, `diamond` or `hexagon`; a node takes the shape
  of the first entry among its types. Shape says what kind of thing a node is: the ghost, the ring,
  the halo, the pulse and the edges all follow the outline, and picking tests the outline. Every
  shape fits the box the layout reserves, so layouts do not change. `kgdiff-node` in `@kgdiff/g6`
  draws them too; G6's own node types stay circles. A report's `view.shapes` (`ReportInfo.shapes` in
  `kgdiff-report`, described in `report.v1.json`) carries the map to `<kgdiff-viewer>`, whose legend
  lists the shapes in use. Without `shapes`, frames, draw calls and reports are unchanged.

### Patch Changes

- Updated dependencies [9168d34]
- Updated dependencies [bfe4b0d]
  - @kgdiff/core@0.10.0
  - @kgdiff/layout@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [6c3a764]
  - @kgdiff/core@0.9.0
  - @kgdiff/layout@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [3fe4030]
  - @kgdiff/layout@0.8.0
  - @kgdiff/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [d01c4e0]
- Updated dependencies [9ebb278]
- Updated dependencies [7586808]
  - @kgdiff/core@0.7.0
  - @kgdiff/layout@0.7.0

## 0.6.0

### Patch Changes

- @kgdiff/core@0.6.0
  - @kgdiff/layout@0.6.0

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
  - @kgdiff/layout@0.5.0

## 0.4.0

### Patch Changes

- 86fe0da: Changes only is now a scope that combines with any mode instead of a fourth mode: `mode` is `overlay | swipe | replay` and the new `scope` (`all | changes`) shows only the changes, in overlay, swipe or replay alike. `mode="changes"` still works (overlay + `scope="changes"`), as do old `#kgdiff=…;mode:changes` links; `kgdiff-mode` reports `{ mode, scope }`. The CLI gains `--scope` (`--mode changes` keeps working).

  The canvas loses its header bar: the title floats top left, the actions top right, and the modes, the Changes only toggle with its context hops, and replay's transport live in one dock at the bottom. The diffstat pills (the sidebar's filter chips show the same counts) and the second fit button are gone, the chips wear the legend's swatches, the legend starts collapsed and the minimap appears only while part of the graph is out of view. Unchanged node labels use the muted text color, so the changes stand out.
- @kgdiff/core@0.4.0
  - @kgdiff/layout@0.4.0

## 0.3.0

### Patch Changes

- @kgdiff/core@0.3.0
  - @kgdiff/layout@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [0330630]
  - @kgdiff/core@0.2.0
  - @kgdiff/layout@0.2.0

## 0.1.0

Initial release.
