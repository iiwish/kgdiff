# @kgdiff/renderer

## 0.9.0

### Minor Changes

- d3e1dac: Layers: an application draws its own marks on the renderer's canvas, under and over the graph (RFC 0003, part 4a; experimental). `renderer.addLayer({ order, draw(ctx, view) })` returns the function that removes the layer. An `under` layer is drawn after the background and the dot grid and before everything else, an `over` layer after the labels: a background behind a group of nodes, a certification mark or a count on a node, without a second canvas that follows the `camera` event. `draw` is called once per painted frame (once per side in a swipe view, clipped to it, with `view.side`), in CSS pixels, with `view.worldToScreen`, `view.camera`, `view.viewport` and `view.pixelRatio`; the renderer saves the context before each layer and restores it after. Layers are in `toDataURL` and in the `frame` event's `ms`, are not picked, and their text takes no part in label placement; a layer that throws is reported and the rest of the frame is painted. Without layers the renderer paints exactly as before. `<kgdiff-stage>` gains the same `addLayer` method (experimental) for the graph inside the viewer: layers added before the stage has a canvas are drawn once it has one, and they stay with the stage when it is bound to another root or moved in the document. `@kgdiff/viewer` exports the `RendererLayer` and `LayerView` types. Known limit: labels carry a halo in the canvas background color, which shows as a faint outline over a tinted `under` area; soft tints (the theme's `soft` colors, about 10% alpha) keep it unnoticeable.

### Patch Changes

- 9669b75: The canvas shows the whole frame under an emulated device scale factor. With Chromium's device emulation at a scale factor other than 1 (Playwright's `deviceScaleFactor`, as used for screenshots and browser tests), the graph was drawn enlarged and blurred with only its top-left corner on the canvas, on the first view and after "Fit view": a CLI report, the viewer and any page with `createRenderer` alike. The renderer sized the canvas's backing store by the browser's device-pixel box (`devicePixelContentBoxSize`), which stays in CSS pixels under that emulation, and painted at `devicePixelRatio`. It now takes that box only when it is the canvas's CSS size times the pixel ratio, within the snapping to whole device pixels, and sizes the backing store by the pixel ratio otherwise, as it always has in browsers without the box. A real high-density display (the box is in device pixels there) was drawn correctly before and is drawn exactly as before. The same check keeps the backing store and the painting in step under a CSS `zoom` on an ancestor, which the box includes and `devicePixelRatio` does not; the viewer's fits under a CSS `zoom` are still off.
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

### Minor Changes

- 148fdb1: The viewer embeds as a small looping replay: `<kgdiff-viewer mode="replay" chrome="none" loop>`. `chrome="none"` shows the graph alone, with its hover tooltip and a one-line legend (`legend="auto|full|mini|none"`), no header, change list, step caption, playback bar, zoom buttons or minimap; it fits a 320px strip (the minimum height drops to 120px) and keeps the view fitted. `loop` plays the replay by itself and starts it again after `loop-delay` ms (1200), pausing while the mouse is over the graph unless `pause-on-hover="false"`. A new `kgdiff-replay-end` event fires whenever playback reaches the end. Fitting leaves room for node labels, so the names of the outermost nodes are no longer cut off at the edge of the canvas, and `fit()` takes `{ padding }`; without chrome, a label pushed aside by a neighbour stays inside the canvas or is left out. `@kgdiff/renderer` adds `labelFootprint(frame, theme)`, what a frame covers with its labels at a given zoom, and `setLabelsInside()` / the `labelsInside` option, which keep labels whole inside the canvas.

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
