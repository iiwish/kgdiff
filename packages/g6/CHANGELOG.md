# @kgdiff/g6

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
  - @kgdiff/scene@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [d1c8034]
  - @kgdiff/core@0.11.1
  - @kgdiff/scene@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [47a78d8]
- Updated dependencies [01a57e9]
  - @kgdiff/core@0.11.0
  - @kgdiff/scene@0.11.0

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
  - @kgdiff/scene@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [6c3a764]
  - @kgdiff/core@0.9.0
  - @kgdiff/scene@0.9.0

## 0.8.0

### Patch Changes

- @kgdiff/scene@0.8.0
  - @kgdiff/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [d01c4e0]
- Updated dependencies [7586808]
  - @kgdiff/core@0.7.0
  - @kgdiff/scene@0.7.0

## 0.6.0

### Patch Changes

- @kgdiff/core@0.6.0
  - @kgdiff/scene@0.6.0

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
  - @kgdiff/scene@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [86fe0da]
  - @kgdiff/scene@0.4.0
  - @kgdiff/core@0.4.0

## 0.3.0

### Patch Changes

- @kgdiff/core@0.3.0
  - @kgdiff/scene@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [0330630]
  - @kgdiff/core@0.2.0
  - @kgdiff/scene@0.2.0

## 0.1.0

Initial release.
