---
'@kgdiff/scene': minor
'@kgdiff/renderer': minor
'@kgdiff/g6': minor
'@kgdiff/viewer': minor
'@kgdiff/core': minor
---

Node shapes by type (RFC 0003, part 4b), experimental until 1.0. `buildScene` takes
`shapes`, a map of node type to `circle`, `square`, `diamond` or `hexagon`; a node takes the shape
of the first entry among its types. Shape says what kind of thing a node is: the ghost, the ring,
the halo, the pulse and the edges all follow the outline, and picking tests the outline. Every
shape fits the box the layout reserves, so layouts do not change. `kgdiff-node` in `@kgdiff/g6`
draws them too; G6's own node types stay circles. A report's `view.shapes` (`ReportInfo.shapes` in
`kgdiff-report`, described in `report.v1.json`) carries the map to `<kgdiff-viewer>`, whose legend
lists the shapes in use. Without `shapes`, frames, draw calls and reports are unchanged.
