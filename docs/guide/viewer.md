# Embed the viewer

`<kgdiff-viewer>` is a web component: one custom element that works with any framework, or none.
It is the same viewer as in the HTML reports and the playground.

![The kgdiff viewer: both versions on one map, changes colored by kind, and the list of changes to review](../images/viewer-en.webp)

## Install

```sh
npm install @kgdiff/viewer
```

The package is ESM only and runs in evergreen browsers.

## Show a diff

```html
<kgdiff-viewer theme="auto" style="height: 640px"></kgdiff-viewer>

<script type="module">
  import '@kgdiff/viewer'; // defines <kgdiff-viewer>

  const viewer = document.querySelector('kgdiff-viewer');
  const text = async (url) => (await fetch(url)).text();
  await viewer.load({
    before: { text: await text('/graphs/v1.ttl'), filename: 'v1.ttl' },
    after: { text: await text('/graphs/v2.ttl'), filename: 'v2.ttl' },
  });
</script>
```

Give the element a height. `load()` takes each side as one of:

- `{ text, filename }`: parsed with `@kgdiff/formats`, the format detected from the file name and
  the content; `parse` passes parser options;
- a graph object `{ nodes, edges }` in [kgdiff JSON](../formats.md#kgdiff-json);
- a normalized graph from `@kgdiff/core`.

Optionally, `diff` passes [diff options](./library.md#options) (matching, hierarchy predicates,
ignored attributes), `names` the names of the two sides and `title` a title. The parsers, the
diff engine and the layout are loaded on demand, so they stay out of your initial bundle.

## Listen and control

```js
viewer.addEventListener('kgdiff-ready', (event) => console.log(event.detail.stats));
viewer.addEventListener('kgdiff-select', (event) => console.log(event.detail.hunk));

viewer.next(); // select the next change
viewer.mode = 'replay';
viewer.play();
```

| Attribute          | Values                                                        | Default                    |
| ------------------ | ------------------------------------------------------------- | -------------------------- |
| `mode`             | `overlay`, `swipe`, `replay` (legacy `changes`, see below)    | `overlay`                  |
| `scope`            | `all`, `changes`: only the changes, in any mode               | `all` (`changes` if large) |
| `theme`            | `auto`, `light`, `dark`                                       | `auto`                     |
| `palette`          | `default`, `colorblind`                                       | `default`                  |
| `locale`           | `en`, `zh-CN`                                                 | from `navigator.language`  |
| `panels`           | region states, e.g. `detail:collapsed minimap:hidden`         | all open, legend collapsed |
| `persist`          | `none`: remember nothing                                      | remembers (per origin)     |
| `persist-key`      | the `localStorage` key to remember under                      | `kgdiff:viewer`            |
| `sidebar`          | `open`, `closed` (a preset of `panels`)                       |                            |
| `sync-hash`        | boolean: deep links `#kgdiff=hunk:<id>;mode:<m>;scope:<s>`    |                            |
| `shortcuts`        | `scoped`, `global` (also when nothing has focus), `none`      | `scoped`                   |
| `global-shortcuts` | boolean: the same as `shortcuts="global"`                     |                            |
| `keymap`           | keys rebound or unbound, e.g. `x:none r:review`               |                            |
| `header`           | `compact`: no brand or graph names, when your page shows them |                            |
| `chrome`           | `none`: the graph alone, for small embeds                     | `full`                     |
| `legend`           | `auto`, `full`, `mini` (one line), `none`                     | `auto`                     |
| `loop`             | boolean: the replay plays by itself, over and over            |                            |
| `loop-delay`       | ms between the end of a looping replay and its restart        | `1200`                     |
| `pause-on-hover`   | `false`: a looping replay keeps playing under the mouse       | pauses                     |

`mode="changes"`, from before scopes existed, still works: it means `overlay` with
`scope="changes"`, and the attributes are rewritten to say so.

`mode`, `scope`, `theme`, `palette`, `locale`, `panels`, `persist`, `chrome`, `legend`, `loop`,
`loopDelay`, `pauseOnHover`, `shortcuts` and `keymap` are also properties (`panels` and
`keymap` take objects too). Methods: `load()`, `selectHunk(id)`, `next()`, `prev()`, `play()`,
`pause()`, `fit({ animate, padding })`, `exportDelta()`, `reviewState()`,
`setReviewed(id, reviewed)` and `refreshTheme()`. Events, all bubbling and composed:
`kgdiff-ready` `{ stats }`, `kgdiff-select` `{ hunk, node }`, `kgdiff-mode` `{ mode, scope }`,
`kgdiff-review` `{ hunk, reviewed, progress }`, `kgdiff-error` `{ error }`,
`kgdiff-replay-end` `{ loop }` and `kgdiff-layout` `{ panels, sidebarWidth, detailShare, source }`.
[Viewer: interaction and API](../interaction.md#embedding-api) has the details.

## Arrange the layout

Every region of the viewer can be open, collapsed (folded to the control that opens it again)
or hidden, with one attribute: the change list (`list`), the detail panel (`detail`), the
search (`search`), the filters (`filters`), the view dock (`dock`), the replay transport
(`transport`), the legend (`legend`), the zoom buttons (`zoom`), the minimap (`minimap`), the
title (`title`) and the actions (`actions`). The viewer remembers what the reader changes
(panels, the sidebar's width and the split between the list and the details, theme, palette,
language) for the next visit; what your page sets wins over that. `persist="none"` turns it
off, and `persist-key="my-app:viewer"` keeps your app's choices apart from other apps on the same
origin. [Panels](../interaction.md#panels) has the rules.

### The detail panel collapsed by default

```html
<kgdiff-viewer panels="detail:collapsed" style="height: 640px"></kgdiff-viewer>
```

The change list gets the sidebar's height; the reader opens the details from their bar. Set it
as a property just as well: `viewer.panels = { detail: 'collapsed' }`. Reading `panels` gives back
what your page declared; `viewer.layout.panels` has every region's state now, including what the
reader changed. Setting the same `panels` again (a React or Vue re-render) keeps the reader's
changes.

### Watch the replay only

```html
<kgdiff-viewer
  mode="replay"
  panels="list:hidden detail:hidden search:hidden filters:hidden"
  style="height: 480px"
></kgdiff-viewer>
```

The canvas takes the whole width, with the dock and the replay transport. Add
`dock:hidden zoom:hidden minimap:hidden` for the transport alone, or use `chrome="none" loop`
for an embed without any control ([below](#embed-a-small-looping-replay)). Composed from the
elements, the same is a root and a stage alone:
`<kgdiff-root mode="replay"><kgdiff-stage panels="zoom:hidden minimap:hidden"></kgdiff-stage></kgdiff-root>`.

### React to layout changes

```js
viewer.addEventListener('kgdiff-layout', (event) => {
  const { panels, sidebarWidth, source } = event.detail;
  if (source === 'user') saveLayout({ panels, sidebarWidth }); // e.g. per user, on your server
});
```


## Embed a small looping replay

To show a graph's changes as a small strip on another page, leave the review UI out and let the
replay loop:

```html
<kgdiff-viewer mode="replay" chrome="none" loop style="height: 320px"></kgdiff-viewer>
```

`chrome="none"` keeps the graph, its hover tooltip and a one-line legend; the header, change
list, step caption, playback bar, zoom buttons and minimap go, clicks and shortcuts do nothing
and the view stays fitted, labels included: no name is cut at the edge. `loop` replays the changes, pausing
`loop-delay` ms (1.2 s) between rounds and while the mouse is over the graph.
`kgdiff-replay-end` fires at the end of every round.

## Compose your own layout

The viewer is made of elements you can also place yourself (experimental in 0.6: they may
change in a minor release before they are stable). `<kgdiff-root>` holds the diff session and
shows nothing; the other elements show its parts wherever they are: inside it, or anywhere on
the page with `for="<root id>"`.

| Element                  | Shows                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `<kgdiff-root>`          | nothing: it has the viewer's attributes, methods and events |
| `<kgdiff-stage>`         | the graph, with the view dock, transport, legend and zoom   |
| `<kgdiff-change-list>`   | the list of changes, with review progress                   |
| `<kgdiff-change-detail>` | the selected change                                         |
| `<kgdiff-search>`        | node search, its results in a popup                         |
| `<kgdiff-filters>`       | the filter chips                                            |

### The change list in your own sidebar

```html
<div class="app">
  <aside class="my-sidebar">
    <kgdiff-search for="diff"></kgdiff-search>
    <kgdiff-change-list for="diff"></kgdiff-change-list>
  </aside>
  <kgdiff-root id="diff">
    <kgdiff-stage>
      <my-legend-card slot="top-end"></my-legend-card>
    </kgdiff-stage>
  </kgdiff-root>
  <kgdiff-change-detail for="diff" class="my-drawer"></kgdiff-change-detail>
</div>

<script type="module">
  import '@kgdiff/viewer'; // or only what you use: '@kgdiff/viewer/elements/root', …/stage, …
  await document.getElementById('diff').load({ before, after });
</script>
```

- Lay the elements out with your own CSS; give the stage and the list a height.
  `<kgdiff-root>` renders as `display: contents`, so its children take part in your layout.
- The stage's slots (`top-start`, `top-end`, `bottom-start`, `bottom-center`, `bottom-end`)
  place your content over the canvas, and the graph is framed clear of it. For content you
  position yourself, call `stage.registerObstacle(element)`.
- The keyboard map belongs to the root: `j` / `k`, `x`, `/` and the rest work in every element
  bound to it, and `/` focuses the search. `shortcuts` and `keymap` go on the root.
- Composed elements remember nothing: your page owns the layout.
- Each element has a subpath that defines only it: `@kgdiff/viewer/elements/root`, `/stage`,
  `/change-list`, `/change-detail`, `/search`, `/filters`. `@kgdiff/viewer/session` is the
  headless session, without any element.

## Theme it with CSS

Colors and fonts are CSS custom properties, set on `<kgdiff-viewer>` (or `<kgdiff-root>`) and
inherited by the canvas and every panel. Override them with ordinary CSS:

```css
kgdiff-viewer {
  --kgdiff-accent: #e8590c;
  --kgdiff-accent-soft: rgb(232 89 12 / 0.16);
  --kgdiff-font: "IBM Plex Sans", system-ui, sans-serif;
}
```

The [token list](../visual-language.md#css-tokens) is public API from 0.6. Light, dark and the
color-blind palette stay available underneath (`theme`, `palette`); your values win over them,
and keeping them readable is up to you. When tokens change in a way the viewer cannot see (a
class on an ancestor, a stylesheet loaded later), call `viewer.refreshTheme()` so the canvas
follows.

## Keep review progress

The viewer remembers in the browser which changes were marked reviewed. To keep that progress
somewhere else, such as your backend, listen to `kgdiff-review` and restore it with
`setReviewed()`:

```js
viewer.addEventListener('kgdiff-review', (event) => save(event.detail.progress.reviewed));
viewer.addEventListener('kgdiff-ready', async () => {
  for (const id of await loadSaved()) viewer.setReviewed(id, true);
});
```

## React

Use a ref to call `load()` and to listen to events:

```jsx
import '@kgdiff/viewer';
import { useEffect, useRef } from 'react';

export function GraphDiff({ before, after, onSelect }) {
  const viewer = useRef(null);

  useEffect(() => {
    viewer.current.load({ before, after });
  }, [before, after]);

  useEffect(() => {
    const element = viewer.current;
    const listener = (event) => onSelect(event.detail.hunk);
    element.addEventListener('kgdiff-select', listener);
    return () => element.removeEventListener('kgdiff-select', listener);
  }, [onSelect]);

  return <kgdiff-viewer ref={viewer} theme="auto" style={{ height: 640 }} />;
}
```

In TypeScript, declare `kgdiff-viewer` in `JSX.IntrinsicElements`; the package exports the
element's type as `KgdiffViewerElement`.

The `kgdiff-*` events are in TypeScript's global event maps (`KgdiffEventMap`), so a listener on
any element, the document or the window gets a typed `detail` without a cast:
`viewer.addEventListener('kgdiff-select', (event) => event.detail.hunk)`.

## Vue

Tell Vue that `kgdiff-*` tags are custom elements, in `vite.config.js`:

```js
import vue from '@vitejs/plugin-vue';

export default {
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('kgdiff-') } } }),
  ],
};
```

then use it like any element:

```vue
<script setup>
import '@kgdiff/viewer';
import { onMounted, ref } from 'vue';

const props = defineProps(['before', 'after']);
const emit = defineEmits(['select']);
const viewer = ref(null);

onMounted(() => viewer.value.load({ before: props.before, after: props.after }));
const onSelect = (event) => emit('select', event.detail.hunk);
</script>

<template>
  <kgdiff-viewer ref="viewer" theme="auto" style="height: 640px" @kgdiff-select="onSelect" />
</template>
```

## Without a bundler

`@kgdiff/viewer/standalone` (`dist/standalone/kgdiff-viewer.js`) is a classic script that defines
the element and shows precomputed diffs: it is what the HTML reports of the CLI embed. With its
compute add-on, `@kgdiff/viewer/standalone/compute` (`kgdiff-viewer-compute.js`), it can also
`load()` graph objects (`{ nodes, edges }`). Parsing text in the browser needs the ESM package
and a bundler.

## Large graphs

For large graphs the viewer opens with Changes only on, which lays out the changes and their
neighbourhood instead of the whole graph. Computing a big diff and its layout takes time in the
browser; the CLI's HTML report does that work ahead of time and opens instantly.
