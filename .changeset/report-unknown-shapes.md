---
'@kgdiff/scene': patch
---

`sceneFromReport` passes over an entry of the payload's `view.shapes` whose shape this version does not know, as `<kgdiff-viewer>` does, instead of throwing `invalid-input`: a report from a later version may name a shape that is not one of `NODE_SHAPES`. The other entries are kept. An unknown shape in `options.shapes` is still an error.
