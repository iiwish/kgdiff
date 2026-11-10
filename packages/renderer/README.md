# @kgdiff/renderer

A high-DPI Canvas 2D renderer for [`@kgdiff/scene`](../scene) frames: smooth camera (pan, zoom,
fly-to), level of detail, collision-free label placement, hit testing, swipe clipping and a
minimap. It draws pixels and knows nothing about diffs, so the same frames can also go to
[`@kgdiff/g6`](../g6) or your own renderer.

## Install

```sh
pnpm add @kgdiff/renderer @kgdiff/scene @kgdiff/layout @kgdiff/core
```

ESM only. Runs in evergreen browsers (it needs a DOM and Canvas 2D).

## Quick start

```ts
import { diff } from '@kgdiff/core';
import { layoutDiff } from '@kgdiff/layout';
import { createMinimap, createRenderer } from '@kgdiff/renderer';
import { buildScene, createViewState, createVisualResolver, getTheme } from '@kgdiff/scene';

const result = diff(before, after);
const scene = buildScene(result, layoutDiff(result), { theme: 'dark' });
const resolver = createVisualResolver(scene);

// The container needs a size (CSS); the canvas follows it through a ResizeObserver.
const container = document.getElementById('graph') as HTMLElement;
const renderer = createRenderer(container, { theme: getTheme('dark') });
let frame = resolver.resolve(createViewState());
renderer.setFrame(frame); // the first frame with content is fitted automatically

renderer.on('click', ({ pick }) => {
  if (pick?.type !== 'node') return;
  frame = resolver.resolve(createViewState({ selectedNode: pick.index }), frame);
  renderer.setFrame(frame);
});

createMinimap(document.getElementById('minimap') as HTMLElement, renderer).update(frame);
```

`setFrame` only marks the view dirty; drawing happens on the next animation frame and the loop
sleeps when nothing changes. Pass `{ split, before, after }` to `setFrame` for a swipe view.

Labels keep their pixel size at any zoom and move beside their node when the spot below is
taken, so fitting node positions alone can clip the labels of the outermost nodes.
`labelFootprint(frame, theme).at(k)` runs the renderer's label placement at zoom `k` and returns
the world rect the discs, labels and badges cover, for fits that keep every label in view.

## Layers: drawing under and over the graph

What only your application knows about (a background behind a group of nodes, a certification
mark, a count on a node) you draw yourself, on the renderer's own canvas, in two places:
`under` the graph (after the background and the dot grid, before everything else) and `over`
it (after the labels). No second canvas to keep in step with the camera.

```ts
const removeBackground = renderer.addLayer({
  order: 'under',
  draw(ctx, view) {
    // Positions are the layout's (world units); the context is in CSS pixels.
    const corner = view.worldToScreen({ x: group.x, y: group.y });
    const k = view.camera.k;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.12)'; // keep it soft, see below
    ctx.beginPath();
    ctx.roundRect(corner.x, corner.y, group.width * k, group.height * k, 12);
    ctx.fill();
  },
});

renderer.addLayer({
  order: 'over',
  draw(ctx, view) {
    for (const mark of marks) {
      const p = view.worldToScreen(mark); // { x, y } of a node
      ctx.fillStyle = mark.color;
      ctx.beginPath();
      ctx.arc(p.x + 8, p.y - 8, 4, 0, Math.PI * 2); // 4 px at every zoom
      ctx.fill();
    }
  },
});

removeBackground(); // `addLayer` returns the function that removes the layer
```

- `draw` is called once per painted frame; in a swipe view once per side, clipped to it, with
  `view.side` (`'before'` or `'after'`). `view.viewport` is the world rectangle that call can
  show, for culling. When your own data changes, call `renderer.requestRender()`.
- The renderer saves the context before each layer and restores it after, so nothing a layer
  sets leaks into the graph. On entry the transform is the pixel ratio, `globalAlpha` is 1 and
  the line dash is empty; set every other property you use.
- Layers are part of the frame: `toDataURL` includes them, and their time counts in the `frame`
  event's `ms`. With no layers the renderer paints exactly as before.
- Layers are not picked, and their text takes no part in label placement. Hit-test your own
  marks with `renderer.camera.screenToWorld` and the `click` event's `world`.
- Known limit: labels carry a halo in the canvas background color, which shows as a faint
  outline over a tinted `under` area. Soft tints, such as the theme's `soft` colors (about 10%
  alpha), keep it unnoticeable.

`addLayer` is experimental in 0.9 (RFC 0003, part 4a): it may change in a minor release before
it is stable. `<kgdiff-stage>` of [`@kgdiff/viewer`](../viewer) has the same method for the
graph inside the viewer.

## Learn more

- [Visual language § Level of detail and label placement](../../docs/visual-language.md#level-of-detail-and-label-placement)
  and [§ Rendering quality bars](../../docs/visual-language.md#rendering-quality-bars).
- [Interaction](../../docs/interaction.md): how the viewer drives the camera and picking.

## License

[MIT](../../LICENSE)
