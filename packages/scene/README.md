# @kgdiff/scene

The renderer-agnostic visual model of a graph diff: design tokens (dark, light and a
color-blind-safe palette), the encodings of the five change families, the before → after replay
timeline and focus for changes-only views. It turns a diff and a layout into drawable
primitives (circles, lines, labels, rings, glyphs) for any renderer:
[`@kgdiff/renderer`](../renderer) (Canvas 2D), [`@kgdiff/g6`](../g6) (AntV G6) or your own.

## Install

```sh
pnpm add @kgdiff/scene @kgdiff/core @kgdiff/layout
```

ESM only. Node.js ≥ 22 or any evergreen browser.

## Quick start

```ts
import { diff } from '@kgdiff/core';
import { layoutDiff } from '@kgdiff/layout';
import { buildScene, createViewState, createVisualResolver } from '@kgdiff/scene';

const result = await diff(before, after);
const scene = buildScene(result, await layoutDiff(result), { theme: 'light', locale: 'en' });
scene.hunks.map((hunk) => hunk.title); // localized titles, in review order

const resolver = createVisualResolver(scene);
let frame = resolver.resolve(createViewState({ layer: 'union', selectedHunk: 0 }));
for (const node of frame.nodes) {
  if (node.visible) drawCircle(node.x, node.y, node.r, node.fill, node.alpha); // your drawing code
}

// Replay: sweep `t` from 0 to scene.timeline.duration. Passing `frame` back in reuses it, so
// steady-state frames allocate nothing.
frame = resolver.resolve(createViewState({ layer: 'replay', t: 1200 }), frame);
```

`getTheme(name, palette)` returns the design tokens; `frameBounds(scene, hunks)` gives camera
targets; `computeFocus` builds the changes-only view.

## Your own layout or renderer

`buildScene` reads only the positions, radii and `hidden` counts of a layout (`SceneLayout`), so
a host that places the nodes itself passes its own:

```ts
const scene = buildScene(result, { positions, radii }); // Maps by union id, world units
```

For renderers that are not a canvas (WebGL, 3D), a glyph names the nodes it runs between,
`node1` and `node2` (indices into `scene.nodes`; a pivot has only `node1`), and
`parseColor(css)` turns any color string of a scene into `{ r, g, b, a }`.

## A report payload

The `kgdiff.report` document the CLI embeds in HTML reports (and a server can send a page) holds
a diff, its layout or none, and how a viewer starts
([schema](../core/schema/report.v1.json)). `sceneFromReport` reads one into a scene;
`reportFromJSON` reads it into its parts:

```ts
import { reportFromJSON, type ReportPayload, sceneFromReport } from '@kgdiff/scene';

const scene = sceneFromReport(payload, { theme: 'light' }); // its view.locale, palette and shapes
const { diff, layout, meta, view } = reportFromJSON(payload); // layout: undefined when it has none
```

Both throw a `KgdiffError`: `invalid-input` for a value that is not a report (another `format`,
no `diff` or `meta`), `unsupported-version` for a report version other than 1. The diff (packed
or not) is read with `diffFromJSON` and the layout with `layoutFromJSON`, and what is wrong
inside them is reported with their codes: a `diff` that is not a kgdiff diff is
`unsupported-version`, a `layout` that is not a kgdiff layout `invalid-input`.

`sceneFromReport` takes the payload's `view.locale`, `view.palette` and `view.shapes` as the
scene's unless the options give them, as `<kgdiff-viewer>` does; the theme is yours. It needs a
payload with a layout: for one without, lay `diff` out with `layoutDiff` and call `buildScene`.

## The hunk of a node

`hunkOfNode(scene, id)` is the index into `scene.hunks` of the hunk that changes a node, or `-1`.
`id` is a node id of either version: the later version's node when it has one, else the earlier
version's, which is `id@before` in the scene when the later version gave its id to another node
([Hunk ids](../../docs/algorithms.md#hunk-ids)).

## Learn more

- [Visual language](../../docs/visual-language.md): tokens, encodings, level of detail, replay
  choreography.
- [Algorithms § Hunk ordering](../../docs/algorithms.md#10-hunk-ordering-for-review-and-replay-scene)
  and [§ Focus](../../docs/algorithms.md#11-focus-changes-only-view).

## License

[MIT](../../LICENSE)
