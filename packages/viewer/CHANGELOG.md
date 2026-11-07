# @kgdiff/viewer

## 0.6.0

### Minor Changes

- 325afea: The viewer's layout can be arranged, and its parts placed one by one. Every region of `<kgdiff-viewer>` (the change list, the detail panel, the search, the filters, the view dock, the replay transport, the legend, the zoom buttons, the minimap, the title, the actions) is open, collapsed or hidden through one attribute, `panels="detail:collapsed minimap:hidden"`, or the property `viewer.panels = { detail: 'collapsed' }` (reading it gives the page's declaration back; the new read-only `viewer.layout` has every region's state and the sizes); `sidebar="closed"`, `header="compact"` and `chrome="none"` keep working as presets of it. The detail panel can now be collapsed to a bar of its own, the sidebar's width and the split between the change list and the details can be dragged (or moved with the arrow keys), and `kgdiff-layout` reports every change. The viewer remembers what the reader changes (panels, sizes, theme, palette, language) in `localStorage` for the next visit, unless the page sets them or `persist="none"`; `persist-key` gives an app on a shared origin a store of its own. `shortcuts="scoped|global|none"` says where keyboard shortcuts apply (`global-shortcuts` still works) and `keymap="x:none r:review"` rebinds single keys (a letter in both cases, so Shift+J / K now step through the changes too); the `kgdiff-*` events are typed on every element, the document and the window (`KgdiffEventMap`; `KgdiffViewerEventMap` stays as a deprecated alias); `refreshTheme()` redraws the canvas after the page changed `--kgdiff-*` tokens, which are now documented, public CSS custom properties. Four of them are renamed to whole words before they become public: `--kgdiff-bg` → `--kgdiff-background`, `--kgdiff-mono` → `--kgdiff-font-mono`, `--kgdiff-text-2` → `--kgdiff-text-secondary` and `--kgdiff-text-3` → `--kgdiff-text-muted`; a page that set the old names sets the new ones instead. New, experimental elements compose a layout of your own: `<kgdiff-root>` holds the session, and `<kgdiff-stage>` (with five slots for your content over the canvas, which the graph is framed clear of, and `panels` for its own chrome: dock, transport, legend, zoom, minimap), `<kgdiff-change-list>`, `<kgdiff-change-detail>`, `<kgdiff-search>` and `<kgdiff-filters>` show its parts, inside it or anywhere on the page with `for="<root id>"`. `@kgdiff/viewer/elements/<name>` defines a single element, and `@kgdiff/viewer/panels` is the panels syntax (no DOM). The CLI's `--panels` sets a report's initial panel states; reports now carry their theme and language in the payload only, so a reader's earlier choice wins over them.
- 8b0538c: Several views of one diff, and the canvas chrome as elements (experimental). A `<kgdiff-root>` now draws every `<kgdiff-stage>` bound to it, each with its own canvas, camera, zoom buttons and minimap, all sharing the selection, the hover, the filters, the search and the replay; `version="before"` or `version="after"` pins a stage to one version, for before and after side by side. The view dock, the replay transport, the legend, the zoom buttons, the minimap, the title and the actions are elements of their own (each says which root it shows with `rootElement`): `<kgdiff-view-dock>`, `<kgdiff-transport>`, `<kgdiff-legend>` (`variant="full|mini"`, `open`), `<kgdiff-zoom>` and `<kgdiff-minimap>` (bound to the nearest stage or to the one `stage="<id>"` names: `stage`, `stageElement`, `rootElement`; the minimap is in the custom state `:state(overview)` while the whole graph is in view), `<kgdiff-title>` and `<kgdiff-actions>`, each with a subpath `@kgdiff/viewer/elements/<name>`. Slotted into a stage or a `<kgdiff-viewer>`, one of them replaces the built-in region of its kind (in the viewer the title and the actions too) while `panels` keeps applying to the rest; placed anywhere else it is no obstacle to fits and flights unless registered with `registerObstacle`. `<kgdiff-viewer>` gets the stage's five slots: your content in `slot="top-end"` (and `top-start`, `bottom-start`, `bottom-center`, `bottom-end`) goes over the canvas and the graph is framed clear of it. The shortcuts dialog lists the keys bound after `keymap`, and `?` in a composed root opens the dialog of its `<kgdiff-actions>`. Accessibility: the zoom toolbar, the appearance menu and the search's results have names, a `<kgdiff-stage>` is a named region rather than a main landmark, the end of a replay is announced once, and the page's content in the top corners comes first in the tab order. `@kgdiff/viewer/elements/root` no longer carries the renderer (64 kB instead of 88 kB, min + gzip): each stage brings its own.
- 69a0975: The viewer describes its elements for tools. The package ships a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) (`custom-elements.json`, named by the new `customElements` field), generated from the sources: every element's attributes and the properties they reflect, its methods, the roots' events with their `detail` types, the slots, the `--kgdiff-*` CSS custom properties and `<kgdiff-minimap>`'s `:state(overview)`, with each experimental part marked. Generated from it: `vscode.html-custom-data.json`, which VS Code reads through `html.customData` to complete and describe the tags and their attributes; and `@kgdiff/viewer/react` (experimental), React 19's JSX types for the elements, their properties and their `onkgdiff-*` events, enabled with `import type {} from '@kgdiff/viewer/react'` (`@types/react` is an optional peer dependency). The elements stay experimental in 0.6 and become stable in 0.7. The docs gain a reference of every element generated from the manifest, and tested recipes for React 19, Vue 3 and Svelte 5.

### Patch Changes

- @kgdiff/core@0.6.0
  - @kgdiff/formats@0.6.0
  - @kgdiff/layout@0.6.0
  - @kgdiff/renderer@0.6.0
  - @kgdiff/scene@0.6.0

## 0.5.0

### Minor Changes

- 6ed2b9c: HTML reports are smaller: they embed the diff packed (`packDiffJSON`, format `kgdiff.diff.packed`, schema `schema/diff-packed.v1.json`), with its unchanged elements, which are most of a large diff, stored as tables of indices into one string table. For 100k nodes / 300k edges the embedded diff goes from 68.7 MB to 19.3 MB, 6.8 MB to 3.2 MB gzipped, and the report opens as fast. `unpackDiffJSON` gives the `DiffJSON` back byte for byte; the viewer reads packed and unpacked payloads (`ReportPayload.diff` is either), so older reports still open. The standalone viewer bundle budget goes from 100 kB to 105 kB (min + gzip) for the unpacking and the consistency checks of `diffFromJSON`.

### Patch Changes

- 638c617: `diffFromJSON` is about 30% faster on large diffs, so HTML reports open about 20% sooner: a report of 100k nodes / 300k edges is ready in 1.0 s instead of 1.24 s in headless Chrome. Rebuilding the two graphs was most of `diffFromJSON`. The snapshots `diffToJSON` writes are already canonical, so they are now read straight into graphs, and each union edge keeps the edge it was read into instead of looking it up again. A document `normalize` would change (parallel edges, a repeated id, a dangling end, a hand-edited snapshot) is normalized as before, as fast as before. The result is the same, field for field and in the same order: `diffToJSON(diffFromJSON(j))` is still `j`, byte for byte, the graph hashes are unchanged, and every consistency check still runs.
- 6d34966: The standalone viewer bundle, which every HTML report inlines, no longer carries the facet names
  of `facetLabel`: they are kept apart from the hunk phrasebooks that `formatHunk` reads, which
  saves 0.2 kB (min + gzip). Behaviour is unchanged. The bundle's size ceiling goes from 105 kB to
  130 kB, so a feature no longer has to raise it, and the HTML report overhead budget (without data
  or compute add-on) from 120 kB to 135 kB gzip, so it still covers the bundle.
- 5286e02: The viewer's CSS custom properties are renamed from `--kg-*` to `--kgdiff-*`. They are not documented API yet; a page that set one of the old names on `<kgdiff-viewer>` sets the new name instead, and the canvas now follows it too, not only the panels. Styles are one shared constructable stylesheet, parsed once for every viewer on the page, instead of `<style>` elements in each. Inside, `<kgdiff-viewer>` is now built from a headless session and regions bound to it (RFC 0001, phase 1); its attributes, properties, methods, events and HTML reports are unchanged.
- Updated dependencies [638c617]
- Updated dependencies [f957a49]
- Updated dependencies [ed1c3c9]
- Updated dependencies [212c48c]
- Updated dependencies [f02bc72]
- Updated dependencies [6ed2b9c]
- Updated dependencies [6d34966]
  - @kgdiff/core@0.5.0
  - @kgdiff/formats@0.5.0
  - @kgdiff/layout@0.5.0
  - @kgdiff/renderer@0.5.0
  - @kgdiff/scene@0.5.0

## 0.4.0

### Minor Changes

- 86fe0da: Changes only is now a scope that combines with any mode instead of a fourth mode: `mode` is `overlay | swipe | replay` and the new `scope` (`all | changes`) shows only the changes, in overlay, swipe or replay alike. `mode="changes"` still works (overlay + `scope="changes"`), as do old `#kgdiff=…;mode:changes` links; `kgdiff-mode` reports `{ mode, scope }`. The CLI gains `--scope` (`--mode changes` keeps working).

  The canvas loses its header bar: the title floats top left, the actions top right, and the modes, the Changes only toggle with its context hops, and replay's transport live in one dock at the bottom. The diffstat pills (the sidebar's filter chips show the same counts) and the second fit button are gone, the chips wear the legend's swatches, the legend starts collapsed and the minimap appears only while part of the graph is out of view. Unchanged node labels use the muted text color, so the changes stand out.

### Patch Changes

- Updated dependencies [86fe0da]
  - @kgdiff/scene@0.4.0
  - @kgdiff/renderer@0.4.0
  - @kgdiff/core@0.4.0
  - @kgdiff/formats@0.4.0
  - @kgdiff/layout@0.4.0

## 0.3.0

### Minor Changes

- 148fdb1: The viewer embeds as a small looping replay: `<kgdiff-viewer mode="replay" chrome="none" loop>`. `chrome="none"` shows the graph alone, with its hover tooltip and a one-line legend (`legend="auto|full|mini|none"`), no header, change list, step caption, playback bar, zoom buttons or minimap; it fits a 320px strip (the minimum height drops to 120px) and keeps the view fitted. `loop` plays the replay by itself and starts it again after `loop-delay` ms (1200), pausing while the mouse is over the graph unless `pause-on-hover="false"`. A new `kgdiff-replay-end` event fires whenever playback reaches the end. Fitting leaves room for node labels, so the names of the outermost nodes are no longer cut off at the edge of the canvas, and `fit()` takes `{ padding }`; without chrome, a label pushed aside by a neighbour stays inside the canvas or is left out. `@kgdiff/renderer` adds `labelFootprint(frame, theme)`, what a frame covers with its labels at a given zoom, and `setLabelsInside()` / the `labelsInside` option, which keep labels whole inside the canvas.

### Patch Changes

- Updated dependencies [148fdb1]
  - @kgdiff/renderer@0.3.0
  - @kgdiff/core@0.3.0
  - @kgdiff/formats@0.3.0
  - @kgdiff/layout@0.3.0
  - @kgdiff/scene@0.3.0

## 0.2.0

### Patch Changes

- d88fc85: The detail panel (and the HTML report) leads with what changed: one row per changed facet, before → after. A lone removed and added synonym, type or parent reads as one edit (`老赖 → 失信人`), similar ones pair up, and unchanged attributes fold behind a toggle. Added and removed nodes now show their synonyms.
- Updated dependencies [0330630]
  - @kgdiff/core@0.2.0
  - @kgdiff/formats@0.2.0
  - @kgdiff/layout@0.2.0
  - @kgdiff/renderer@0.2.0
  - @kgdiff/scene@0.2.0

## 0.1.0

Initial release.
