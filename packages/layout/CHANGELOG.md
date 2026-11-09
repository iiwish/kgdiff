# @kgdiff/layout

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
