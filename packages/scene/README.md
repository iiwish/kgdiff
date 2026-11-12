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

## Learn more

- [Visual language](../../docs/visual-language.md): tokens, encodings, level of detail, replay
  choreography.
- [Algorithms § Hunk ordering](../../docs/algorithms.md#10-hunk-ordering-for-review-and-replay-scene)
  and [§ Focus](../../docs/algorithms.md#11-focus-changes-only-view).

## License

[MIT](../../LICENSE)
