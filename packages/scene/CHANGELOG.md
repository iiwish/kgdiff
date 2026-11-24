# @kgdiff/scene

## 0.12.4

### Patch Changes

- c5a87b1: A hidden edge in a frame has a color `parseColor` reads: the color it was last drawn in, or its union-layer color if it has not been drawn yet. Before, an edge that had never been drawn carried an empty string, so a host that parsed every edge's color had to check `visible` first. Nothing is drawn differently.
- c5a87b1: `sceneFromReport` passes over an entry of the payload's `view.shapes` whose shape this version does not know, as `<kgdiff-viewer>` does, instead of throwing `invalid-input`: a report from a later version may name a shape that is not one of `NODE_SHAPES`. The other entries are kept. An unknown shape in `options.shapes` is still an error.
- @kgdiff/core@0.12.4
  - @kgdiff/layout@0.12.4

## 0.12.3

### Patch Changes

- 725e734: A host that draws its own change view with the G6 adapter needs no workarounds for four things it had to do by hand.

  The replay steps both ways. `DiffGraphController.seekReplay(index)` puts the replay at a hunk, forwards or backwards, without rebuilding the graph: `-1` is its start, the earlier version before any hunk, and any other index is the end of that hunk with the hunk spotlighted and in view, what `selectHunk(index)` shows in the replay layer. It switches to the replay layer from another one and stops a running `playReplay`. `selectHunk` is unchanged: `selectHunk(-1)` still only clears the selection.

  `DiffGraphController.hunkOf(elementId)` says which hunk a drawn G6 element belongs to (-1 for none), for a host that keeps its own selection in step with clicks. `KgdiffDatumData`, the `data` of every element the adapter generates, is now described field by field as part of the adapter's contract.

  `hunkOfNode(scene, id)` in `@kgdiff/scene` gives the hunk that changes a node, from a node id of either version: the later version's node when it has one, else the earlier version's (`id@before` when the later version reuses its id).

  `sceneFromReport(payload, options)` in `@kgdiff/scene` builds the scene of a `kgdiff.report` payload, and `reportFromJSON(payload)` reads it into `{ diff, layout, meta, view }`; both throw a `KgdiffError` for a value that is not a report (`invalid-input`) or is of another version (`unsupported-version`), and `sceneFromReport` for a payload without a layout. The scene is in the report's language, palette and node shapes (`view.locale`, `view.palette`, `view.shapes`) unless the options give them, as in `<kgdiff-viewer>`; the theme is the host's. `ReportPayload` and `ReportView` are its types, and `ReportPayload` of `@kgdiff/viewer` is assignable to the former.
- ff50c16: A host with its own layout or renderer needs fewer workarounds. `buildScene` takes the positions a host already has: it reads only `positions`, `radii` and `hidden` of a layout (the new type `SceneLayout`), so `buildScene(result, { positions, radii })` works without computing a kgdiff layout, and a `LayoutResult` is accepted as before. A glyph names the nodes it runs between, `node1` and `node2` (indices into `scene.nodes`; a pivot has only `node1`), so a renderer that moves nodes, in 3D say, can move the glyph with them instead of finding the node nearest to its ends. And `parseColor` is exported, with its type `Rgba`: it turns any color string of a scene into channels, and its documentation says which syntaxes it accepts. [Embedding](https://github.com/iiwish/kgdiff/blob/main/docs/guide/embedding.md#with-your-own-layout-or-renderer) has an example.
- Updated dependencies [0e71a6c]
- Updated dependencies [2f65e0e]
- Updated dependencies [8348e34]
  - @kgdiff/core@0.12.3
  - @kgdiff/layout@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies [081c437]
- Updated dependencies [102ce48]
  - @kgdiff/core@0.12.2
  - @kgdiff/layout@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [c136256]
  - @kgdiff/core@0.12.1
  - @kgdiff/layout@0.12.1

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

- Updated dependencies [d1c8034]
  - @kgdiff/core@0.11.1
  - @kgdiff/layout@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [47a78d8]
- Updated dependencies [01a57e9]
  - @kgdiff/core@0.11.0
  - @kgdiff/layout@0.11.0

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
