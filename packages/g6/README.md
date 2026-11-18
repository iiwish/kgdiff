# @kgdiff/g6

Render kgdiff's semantic graph diffs inside [AntV G6 v5](https://g6.antv.antgroup.com/), with the
same visual language as the kgdiff viewer: five meaning families, hollow dashed ghosts, rings,
glows, struck-through old names, merge / split arcs, a selection spotlight and a hunk-by-hunk
replay.

kgdiff computes the diff (`@kgdiff/core`), lays both versions out on one map (`@kgdiff/layout`)
and resolves every frame into visual primitives (`@kgdiff/scene`). This package turns those
primitives into G6 data and drives a G6 `Graph` with them.

## Install

```sh
pnpm add @kgdiff/g6 @kgdiff/core @kgdiff/layout @kgdiff/scene @antv/g6
```

`@antv/g6` (≥ 5.1) is a peer dependency: use the one your product already ships.

## Quick start

```ts
import { diff } from '@kgdiff/core';
import { layoutDiff } from '@kgdiff/layout';
import { buildScene } from '@kgdiff/scene';
import { createDiffGraph } from '@kgdiff/g6';

// before / after: GraphInput ({ nodes, edges }) — or parse files with parseGraph of @kgdiff/core.
const result = await diff(before, after);
const scene = buildScene(result, await layoutDiff(result), { theme: 'dark', locale: 'en' });

const diffGraph = await createDiffGraph(document.getElementById('graph') as HTMLElement, scene);

await diffGraph.selectHunk(0); // spotlight the first change and pan to it
await diffGraph.setLayer('after'); // 'union' (overlay, default) | 'before' | 'after'
await diffGraph.playReplay({ speed: 2 }); // before → after, hunk by hunk
diffGraph.destroy();
```

The container needs a size: G6 rewrites its inline `position` / `display`, so size it (or a
wrapper) with CSS rather than relying on `position: fixed` on the container itself.

## Controller

`createDiffGraph(container, scene, options?)` resolves to a controller:

| Member                  |                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `graph`                 | The G6 `Graph`, for your own plugins, events and camera calls.                                                     |
| `setLayer(layer)`       | Show `'union'`, `'before'` or `'after'`; animates over `theme.motion.base`.                                        |
| `selectHunk(index)`     | Spotlight a hunk (`-1` clears) and pan to its nodes. In the replay layer it seeks to the end of the hunk's window. |
| `seekReplay(index)`     | Put the replay at a hunk, forwards or backwards: `-1` is its start, a hunk the end of its window (see below).      |
| `hunkOf(elementId)`     | The hunk of a drawn element (index into `scene.hunks`), or `-1`.                                                   |
| `playReplay({ speed })` | Play the replay (default 1×). Resolves when finished or stopped.                                                   |
| `stop()`                | Stop a running replay; its promise resolves at once.                                                               |
| `setTheme(theme)`       | Switch colours, e.g. `getTheme('light', 'colorblind')` from `@kgdiff/scene`.                                       |
| `destroy()`             | Destroy the graph. Pending calls settle; later calls reject.                                                       |

Options:

- `view` — the initial `ViewState` (layer, selection, family filter, focus, `reducedMotion`…).
- `interactive` (default `true`) — zoom / drag the canvas, hover highlights, click a change to
  select its hunk, click an unchanged node to select it, click the canvas to clear.
- `g6` — extra G6 options merged over the generated ones: `behaviors`, `plugins` and
  `transforms` are appended, plain objects merge recursively, other values replace.
  `animation: false` turns animations off (the replay keeps its pace).

### Stepping through the replay

A host with its own replay controls (previous, next, to the start, a list of changes) steps the
replay with `seekReplay`, in either direction, without rebuilding the graph:

```ts
const diffGraph = await createDiffGraph(container, scene, { view: { layer: 'replay' } });

let step = -1; // the start: the earlier version, before hunk 0
const go = (next: number) => {
  step = Math.max(-1, Math.min(scene.hunks.length - 1, next));
  return diffGraph.seekReplay(step);
};
await go(step + 1); // next
await go(step - 1); // previous
await go(-1); // to the start
```

`seekReplay(i)` shows what `selectHunk(i)` shows in the replay layer: the end of hunk `i`'s
window, with the hunk spotlighted and in view. `seekReplay(-1)` goes back to the start (time 0,
nothing selected) and leaves the camera where it is; `selectHunk(-1)` only clears the selection.
Called in another layer, `seekReplay` switches to the replay layer (`setLayer` leaves it). It
stops a running `playReplay`, rejects an index outside `[-1, hunks)`, and lands on the same
graph as a new controller would at that step. The positions are the hunk windows also in chapter
mode, where the viewer's own transport steps by chapter.

### Which hunk an element belongs to

With `interactive`, a click on a change already selects its hunk. A host that keeps its own
selection (a list, the address bar) reads the hunk of the clicked element with `hunkOf`:

```ts
import type { IElementEvent } from '@antv/g6';

const onClick = (event: IElementEvent) => {
  const hunk = diffGraph.hunkOf(event.target.id);
  if (hunk >= 0) showHunk(hunk);
};
diffGraph.graph.on('node:click', onClick);
diffGraph.graph.on('edge:click', onClick);
```

`hunkOf(id)` is the `hunk` of the element's `KgdiffDatumData` (below), as drawn now, and `-1`
for an unchanged element, an id the graph does not show, an element you added and after
`destroy()`. To find the hunk of a node by its graph id rather than a G6 element, use
`hunkOfNode(scene, id)` from `@kgdiff/scene`.

Calls made while a draw is still running are merged (latest wins): five quick clicks cost one
G6 update. Every update sends G6 only the elements that changed, with only the changed style
keys.

The promises resolve when G6's animation has finished, or at most 1 s after its duration:
browsers pause animation frames in background tabs, and G6 only settles a draw once its
animation has run.

## Using `toG6Data` with your own graph

```ts
import { createViewState, createVisualResolver } from '@kgdiff/scene';
import { toG6Data } from '@kgdiff/g6';

const resolver = createVisualResolver(scene);
const frame = resolver.resolve(createViewState({ layer: 'union', selectedHunk: 3 }));
graph.setData(toG6Data(scene, frame, { idPrefix: 'diff/' }));
await graph.draw();
```

`toG6Data` is pure. Nodes have no `type` and render as G6 circles. The ring, glow, replay pulse,
node shapes (`buildScene`'s `shapes`), struck-through labels and old names are drawn by the
`kgdiff-node` type, which only `createDiffGraph` registers, so a plain circle ignores the shape
and shows a simpler G6 halo instead. Level of detail
is evaluated at zoom 1. Every element's `data` is a `KgdiffDatumData`:
`{ kgdiff: 'node' | 'edge' | 'glyph' | 'anchor' | 'collapsed', index, hunk, family, changed,
label, glyph }`. `index` is the scene index, so your handlers can map a G6 id back to the diff.
This type is part of the package's contract, for `toG6Data` and `createDiffGraph` alike: read
it with `graph.getElementData(id).data as KgdiffDatumData`. `kgdiff` is the kind of element;
`index` the scene node or edge index (for glyphs the index in `frame.glyphs`, for collapsed pills
in `frame.collapsed`, for anchors the scene node at that point or `-1`); `hunk` the index into
`scene.hunks` of the hunk that changes the element (glyphs: their source node's, else their
target's), or `-1`; `family` the change family drawn (`neutral` when unchanged); `changed`
whether a change is drawn; `label` the plain label; `glyph` the glyph kind, `''` for other
elements.

Every style key is always present, switched off with `false` / `0` / `''` when unused, because
G6 merges updates into the previous style.

## Notes

- **Your own elements.** The controller adds, updates and removes only the elements it
  generated, so elements you add with `graph.addData` stay. Don't call `graph.setData`,
  `graph.clear` or `removeData` on kgdiff's elements: the controller patches the graph
  incrementally and expects its elements to be there. Avoid ids that start with `kgdiff-` or
  equal scene union ids. Edges you attach to a kgdiff node are removed by G6 when that node is
  hidden (for example an added node in the `before` layer).
- **Screen-constant sizes.** G6 scales strokes, labels and arrowheads with the camera; kgdiff's
  sizes are exact at zoom 1. For readable overviews, add G6's `fix-element-size` behaviour:

  ```ts
  createDiffGraph(container, scene, {
    g6: {
      behaviors: [
        {
          type: 'fix-element-size',
          enable: (event) => event.data.scale < 1,
          node: [{ shape: 'key', fields: ['lineWidth'] }, { shape: 'label' }],
          edge: [{ shape: 'key', fields: ['lineWidth'] }, { shape: 'label' }],
        },
      ],
    },
  });
  ```

- **Theme.** The graph runs with `theme: false`, so no G6 theme styles, palettes or state
  styles mix with kgdiff's encodings. The canvas colour comes from a `background` plugin, and
  hover uses a private state (`kgdiff-hover`).

## Limitations

- Labels, badges and arrowheads switch on at their zoom threshold. The native viewer fades them
  in over the last 10% of zoom.
- There is no label collision avoidance. G6's `auto-adapt-label` is O(n²) and reorders
  elements, so it is not enabled.
- Replay animations are piecewise linear between four samples per hunk (spotlight, mid-move,
  settle, end). Merge travel follows two straight segments instead of an arc.
- Turning the spotlight on or off changes the opacity of every element, and G6 5.1 re-renders
  each changed element in full. At ~5k nodes / 12k edges that took about 1.7 s in our tests
  (happy-dom, G6 5.1.1). Moving between hunks, or switching layers on a mostly unchanged graph,
  only touches what changed.
- The camera pans to a selection (`focusElement`) but does not zoom.
- Glyph lines start at the node outline, not 4 units outside it like the native viewer.

## Development

```sh
pnpm vitest run packages/g6
pnpm --filter @kgdiff/g6 typecheck
pnpm vite --config packages/g6/dev/vite.config.ts    # harness on http://localhost:5197
```

The harness renders the example datasets (`?dataset=<id>`) with layer, replay, theme and hunk
controls, for comparison with the native renderer's harness.
