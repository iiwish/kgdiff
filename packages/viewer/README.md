# @kgdiff/viewer

`<kgdiff-viewer>`, a framework-agnostic web component for reviewing graph diffs. Three ways to
compare (Overlay, Swipe, Replay), each with or without Changes only, a searchable change list, a detail panel with
character-level diffs, review progress, deep links, keyboard shortcuts, light and dark themes, and
an English and Chinese UI.

## Install

```sh
pnpm add @kgdiff/viewer
```

ESM only. Runs in evergreen browsers.

## Quick start

```html
<kgdiff-viewer theme="auto" locale="en" style="height: 640px"></kgdiff-viewer>
<script type="module">
  import '@kgdiff/viewer'; // defines <kgdiff-viewer>

  const viewer = document.querySelector('kgdiff-viewer');
  viewer.addEventListener('kgdiff-ready', (event) => console.log(event.detail.stats));
  await viewer.load({
    before: { text: await (await fetch('v1.ttl')).text(), filename: 'v1.ttl' },
    after: { text: await (await fetch('v2.ttl')).text(), filename: 'v2.ttl' },
  });
</script>
```

- `load()` also takes structured graphs (`{ nodes, edges }`). The parsers, the diff engine and the
  force layout are imported on demand, so they stay out of your initial bundle.
- To show a precomputed diff without any work in the browser, set `viewer.payload` to a report
  payload: that is what the `kgdiff` CLI embeds in its HTML reports.
- Without a bundler, `@kgdiff/viewer/standalone` (`dist/standalone/kgdiff-viewer.js`) is a
  self-contained script that defines the element and shows embedded payloads. The optional
  `@kgdiff/viewer/standalone/compute` add-on brings the diff engine and force layout for `load()`.

Attributes: `mode` (`overlay` | `swipe` | `replay`), `scope` (`all` | `changes`), `theme`,
`palette`, `locale`, `panels`, `persist`, `sidebar`, `sync-hash`, `shortcuts`,
`global-shortcuts`, `keymap`, `header`, `chrome`, `legend`, `loop`, `loop-delay`,
`pause-on-hover`. The legacy `mode="changes"` still works: it means `overlay` with
`scope="changes"`. Methods: `load`, `selectHunk`, `next`, `prev`, `play`, `pause`, `fit`,
`exportDelta`, `reviewState`, `setReviewed`, `refreshTheme`. Events: `kgdiff-ready`,
`kgdiff-select`, `kgdiff-mode`, `kgdiff-review`, `kgdiff-error`, `kgdiff-replay-end`,
`kgdiff-layout`.

## Arrange the layout

Every region can be open, collapsed or hidden: `list`, `detail`, `search`, `filters`, `dock`,
`transport`, `legend`, `zoom`, `minimap`, `title`, `actions`.

```html
<kgdiff-viewer panels="detail:collapsed minimap:hidden"></kgdiff-viewer>
```

`viewer.panels` is your page's declaration (as the attribute); `viewer.layout` has every
region's state and the sizes now. The viewer remembers what the reader changes (panels, sizes, theme, palette, language) per
origin; what the page sets wins over it, `persist="none"` turns it off, and `persist-key` names the
storage entry (`kgdiff:viewer` by default) for apps that share an origin. Colors and fonts are
`--kgdiff-*` CSS custom properties: override them on the element.

## Compose your own layout (experimental)

`<kgdiff-root>` holds the session; `<kgdiff-stage>` (the canvas, with five slots for your own
content over it), `<kgdiff-change-list>`, `<kgdiff-change-detail>`, `<kgdiff-search>` and
`<kgdiff-filters>` show its parts, inside it or anywhere with `for="<root id>"`. Importing
`@kgdiff/viewer` defines them all; `@kgdiff/viewer/elements/<name>` defines one, and
`@kgdiff/viewer/session` is the headless session. See
[the guide](../../docs/guide/viewer.md#compose-your-own-layout).

## Embed a small looping replay

To show a graph's changes as a small strip on another page, leave the review UI out and let the
replay loop:

```html
<kgdiff-viewer mode="replay" chrome="none" loop style="height: 320px"></kgdiff-viewer>
```

| Attribute (property)              | Values                         | Default                                          |
| --------------------------------- | ------------------------------ | ------------------------------------------------ |
| `chrome` (`chrome`)               | `full`, `none`                 | `full`                                           |
| `legend` (`legend`)               | `auto`, `full`, `mini`, `none` | `auto`: `full`, or `mini` with `chrome="none"`   |
| `loop` (`loop`)                   | boolean                        | off                                              |
| `loop-delay` (`loopDelay`)        | ms between the end and restart | `1200`                                           |
| `pause-on-hover` (`pauseOnHover`) | `false` to keep playing        | on: a looping replay pauses under a mouse or pen |

- `chrome="none"` shows the graph alone: no title, actions (theme, help, sidebar button), view
  dock (with its step caption, playback bar and finished card), change list, zoom buttons,
  minimap or legend card. The hover tooltip stays, and the legend becomes one line with the families this
  diff has, then unchanged. Clicks and keyboard shortcuts do nothing. The minimum height drops
  from 420px to 120px. The view stays fitted: when the canvas is resized (unless the user
  panned or zoomed since) and at the start of every loop. Labels are never cut at the edge: one
  pushed from its spot by a neighbour moves inside the canvas or is left out (the tooltip
  still names it).
- `loop` plays the replay by itself (in `replay` mode) and starts it again `loop-delay` ms after
  it ends. `pause()` stops it until `play()`; a new diff starts it again.
- `kgdiff-replay-end` fires each time playback reaches the end, with `detail.loop` telling
  whether it will start again. Set `loop = false` or call `pause()` in the listener to stop
  there.
- `fit({ padding })` fits the graph with its labels into view, keeping `padding` px around them
  (default 24, kept for the later automatic fits); `fit({ animate: false })` jumps.

```js
let rounds = 0;
viewer.addEventListener('kgdiff-replay-end', (event) => {
  if (event.detail.loop && ++rounds === 3) viewer.loop = false; // three rounds, then stop
});
```

## Learn more

- [Interaction](../../docs/interaction.md): views, change list, panels, keyboard map, the
  [embedding API](../../docs/interaction.md#embedding-api) and the elements.
- [Visual language](../../docs/visual-language.md): what every color, ring and glyph means.

## License

[MIT](../../LICENSE)
