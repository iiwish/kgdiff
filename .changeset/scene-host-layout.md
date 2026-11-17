---
'@kgdiff/scene': patch
---

A host with its own layout or renderer needs fewer workarounds. `buildScene` takes the positions a host already has: it reads only `positions`, `radii` and `hidden` of a layout (the new type `SceneLayout`), so `buildScene(result, { positions, radii })` works without computing a kgdiff layout, and a `LayoutResult` is accepted as before. A glyph names the nodes it runs between, `node1` and `node2` (indices into `scene.nodes`; a pivot has only `node1`), so a renderer that moves nodes, in 3D say, can move the glyph with them instead of finding the node nearest to its ends. And `parseColor` is exported, with its type `Rgba`: it turns any color string of a scene into channels, and its documentation says which syntaxes it accepts. [Embedding](https://github.com/iiwish/kgdiff/blob/main/docs/guide/embedding.md#with-your-own-layout-or-renderer) has an example.
