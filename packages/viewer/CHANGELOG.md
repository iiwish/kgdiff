# @kgdiff/viewer

## 0.11.1

### Patch Changes

- f248f5a: No other kgdiff package depends on `@kgdiff/formats` any more, so that it can be marked deprecated on npm without warning everyone who installs `@kgdiff/compute` or `@kgdiff/viewer`. Nothing is removed and no type changes.
  - `@kgdiff/compute`: exports the parsers' types (`FormatId`, `ParseOptions`, `ParseResult`, `ParseWarning`, `ParseWarningCode`, `RdfOptions`, `JsonOptions`, `JsonLdOptions`, `JsonDialect`) and `FORMAT_EXTENSIONS`, the declarations `@kgdiff/core` defines since this release, the same as those of `@kgdiff/formats` 0.11.0. It no longer depends on `@kgdiff/formats`.
  - `@kgdiff/formats` (deprecated, and not published from 1.0 on: 0.11.x stays on npm and keeps working): re-exports those from `@kgdiff/compute`, and its `parseGraph`, `detectFormat` and `compactIri` call `@kgdiff/compute`'s. Its exports and their types are the ones of 0.11.0.
  - `@kgdiff/viewer`: `load()` parses text sources with `parseGraph` of `@kgdiff/compute` (imported on demand, as before), and `ParseOptions` comes from there. It no longer depends on `@kgdiff/formats`. The standalone viewer imports `@kgdiff/compute` for text sources, which an import map that served `@kgdiff/formats` already had to provide.
- Updated dependencies [d1c8034]
- Updated dependencies [f248f5a]
  - @kgdiff/core@0.11.1
  - @kgdiff/compute@0.11.1
  - @kgdiff/layout@0.11.1
  - @kgdiff/renderer@0.11.1
  - @kgdiff/scene@0.11.1

## 0.11.0

### Minor Changes

- 01a57e9: **Breaking.** Computing runs on kgdiff's Rust engine in WebAssembly (`@kgdiff/compute`) everywhere, and the functions that compute are asynchronous (RFC 0002, phase 5). The results are the kgdiff CLI's, byte for byte.
  - `@kgdiff/core`: `diff`, `matchNodes` and `textSimilarity` return promises. `log2` is deprecated (use `Math.log2`).
  - `@kgdiff/formats` is deprecated in favour of `@kgdiff/compute`: `parseGraph`, `detectFormat` and `compactIri` return promises and run its parsers.
  - `@kgdiff/layout`: `layoutDiff` and `extendLayout` return promises; new `layoutGraph`, `layoutDiffOn` and `layoutAfter`, to keep one map across versions. Positions are the Rust engine's, which are 0.10's for the same input (the conformance corpus checked the two engines against each other on every case through 0.10); layouts are now written as version 2 documents.
  - `@kgdiff/compute`: `diffSync` and `diffAndLayoutSync` read the engine's diff back without `diffFromJSON`'s consistency checks (it was written by the same build; documents from elsewhere are still checked), and keep the node positions of the graphs, so a diff of graphs with positions is still laid out anchored on them, and the issues found normalizing them. Graphs may be given as `KGraph`s: as in 0.10, two with the same edge identity are compared with it when the options name none, and `matchNodes` reads each with its own.
  - `@kgdiff/viewer`: the compute module and the standalone add-on run on `@kgdiff/compute`. The add-on inlines the layout-only module, so single-file reports expand collapsed groups offline; an expansion asked for while it compiles waits for it. `load()` in the standalone viewer needs `@kgdiff/compute` in the import map. The viewer bundle has no WebAssembly.

  Migrating: put `await` in front of each changed call, or `await init()` of `@kgdiff/compute` once and use its `*Sync` functions. Pages with a Content Security Policy need `'wasm-unsafe-eval'` to compute. The read path (`normalize`, `hashGraph`, `diffFromJSON`, `applyDelta`, `formatHunk`, `layoutFromJSON`, …) stays synchronous. See docs/guide/migrating-to-0.11.md.

### Patch Changes

- Updated dependencies [de02790]
- Updated dependencies [47a78d8]
- Updated dependencies [01a57e9]
  - @kgdiff/compute@0.11.0
  - @kgdiff/core@0.11.0
  - @kgdiff/formats@0.11.0
  - @kgdiff/layout@0.11.0
  - @kgdiff/renderer@0.11.0
  - @kgdiff/scene@0.11.0

## 0.10.0

### Minor Changes

- 5dfeb83: Remove three compatibility paths. Breaking before 1.0:
  - **GitHub Action: `version` below 0.8.0.** Before 0.8.0 `@kgdiff/cli` was a TypeScript CLI without
    platform packages, and the action ran it with `npx`. The action now runs only the native
    kgdiff, so a `version` input that resolves to a release before 0.8.0 fails with an error that
    names the minimum. A runner with no native build for it also fails, with its own error, instead
    of falling back to `npx`. To keep using an older version, pin an earlier release of the
    action: `iiwish/kgdiff@v0.7.0`. The default (the action's own release) is not affected.
  - **Viewer: the mode `changes`.** Before scopes existed, "only the changes" was a fourth mode.
    `mode="changes"` (attribute or property), `mode:changes` in `sync-hash` deep links and
    `view.mode: "changes"` in a report's payload were read as `overlay` plus scope `changes`; they
    are now unknown values, like any other: the attribute and the property use the default,
    `overlay`; a deep link drops that field; a report's `view` drops it and the viewer logs a
    warning. The scope is not implied any more. Write `mode="overlay" scope="changes"`. The
    TypeScript types of `mode` and `setMode` no longer accept `'changes'`.
  - **Site playground.** Links with `mode=changes` open in the default mode; use `mode=overlay` and
    `scope=changes`.
- bfe4b0d: Node shapes by type (RFC 0003, part 4b), experimental until 1.0. `buildScene` takes
  `shapes`, a map of node type to `circle`, `square`, `diamond` or `hexagon`; a node takes the shape
  of the first entry among its types. Shape says what kind of thing a node is: the ghost, the ring,
  the halo, the pulse and the edges all follow the outline, and picking tests the outline. Every
  shape fits the box the layout reserves, so layouts do not change. `kgdiff-node` in `@kgdiff/g6`
  draws them too; G6's own node types stay circles. A report's `view.shapes` (`ReportInfo.shapes` in
  `kgdiff-report`, described in `report.v1.json`) carries the map to `<kgdiff-viewer>`, whose legend
  lists the shapes in use. Without `shapes`, frames, draw calls and reports are unchanged.
- 6bed516: The composable viewer elements are stable. RFC 0001 planned this for 0.7; it happens now, in 0.10.
  `<kgdiff-root>`, `<kgdiff-stage>`, `<kgdiff-change-list>`, `<kgdiff-change-detail>`,
  `<kgdiff-search>`, `<kgdiff-filters>`, `<kgdiff-view-dock>`, `<kgdiff-transport>`,
  `<kgdiff-legend>`, `<kgdiff-zoom>`, `<kgdiff-minimap>`, `<kgdiff-title>` and `<kgdiff-actions>`,
  with their attributes, properties, methods, events, slots, custom states, the element types, the
  React types and the `keymap` shortcut names, no longer carry `@experimental`: from now on they
  follow semantic versioning. Nothing changes in behavior or types.

  CSS `::part()` is not offered in 1.0: theme the elements with the `--kgdiff-*` custom properties.
  Adding `::part()` names later is purely additive.

  `<kgdiff-stage>`'s `addLayer` and the `RendererLayer` / `LayerView` types stay experimental until
  1.0, as RFC 0003 says.

### Patch Changes

- 643849c: The viewer's saved review progress is versioned. New writes carry `v: 1` in the value (the key is unchanged, so saved progress stays). Progress saved without a version is read as before and upgraded on the next write; a value from a newer viewer is read but never overwritten.
- Updated dependencies [9168d34]
- Updated dependencies [bfe4b0d]
  - @kgdiff/core@0.10.0
  - @kgdiff/scene@0.10.0
  - @kgdiff/renderer@0.10.0
  - @kgdiff/formats@0.10.0
  - @kgdiff/layout@0.10.0

## 0.9.0

### Minor Changes

- d3e1dac: Layers: an application draws its own marks on the renderer's canvas, under and over the graph (RFC 0003, part 4a; experimental). `renderer.addLayer({ order, draw(ctx, view) })` returns the function that removes the layer. An `under` layer is drawn after the background and the dot grid and before everything else, an `over` layer after the labels: a background behind a group of nodes, a certification mark or a count on a node, without a second canvas that follows the `camera` event. `draw` is called once per painted frame (once per side in a swipe view, clipped to it, with `view.side`), in CSS pixels, with `view.worldToScreen`, `view.camera`, `view.viewport` and `view.pixelRatio`; the renderer saves the context before each layer and restores it after. Layers are in `toDataURL` and in the `frame` event's `ms`, are not picked, and their text takes no part in label placement; a layer that throws is reported and the rest of the frame is painted. Without layers the renderer paints exactly as before. `<kgdiff-stage>` gains the same `addLayer` method (experimental) for the graph inside the viewer: layers added before the stage has a canvas are drawn once it has one, and they stay with the stage when it is bound to another root or moved in the document. `@kgdiff/viewer` exports the `RendererLayer` and `LayerView` types. Known limit: labels carry a halo in the canvas background color, which shows as a faint outline over a tinted `under` area; soft tints (the theme's `soft` colors, about 10% alpha) keep it unnoticeable.

### Patch Changes

- 9669b75: The canvas shows the whole frame under an emulated device scale factor. With Chromium's device emulation at a scale factor other than 1 (Playwright's `deviceScaleFactor`, as used for screenshots and browser tests), the graph was drawn enlarged and blurred with only its top-left corner on the canvas, on the first view and after "Fit view": a CLI report, the viewer and any page with `createRenderer` alike. The renderer sized the canvas's backing store by the browser's device-pixel box (`devicePixelContentBoxSize`), which stays in CSS pixels under that emulation, and painted at `devicePixelRatio`. It now takes that box only when it is the canvas's CSS size times the pixel ratio, within the snapping to whole device pixels, and sizes the backing store by the pixel ratio otherwise, as it always has in browsers without the box. A real high-density display (the box is in device pixels there) was drawn correctly before and is drawn exactly as before. The same check keeps the backing store and the painting in step under a CSS `zoom` on an ancestor, which the box includes and `devicePixelRatio` does not; the viewer's fits under a CSS `zoom` are still off.
- Updated dependencies [9669b75]
- Updated dependencies [d3e1dac]
- Updated dependencies [6c3a764]
  - @kgdiff/renderer@0.9.0
  - @kgdiff/core@0.9.0
  - @kgdiff/formats@0.9.0
  - @kgdiff/layout@0.9.0
  - @kgdiff/scene@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [3fe4030]
  - @kgdiff/layout@0.8.0
  - @kgdiff/scene@0.8.0
  - @kgdiff/renderer@0.8.0
  - @kgdiff/core@0.8.0
  - @kgdiff/formats@0.8.0

## 0.7.0

### Minor Changes

- e510258: Report payloads may leave their layout out. `ReportPayload.layout` is optional: a payload without one (the member left out) is laid out in the browser when the viewer reads it, with `layoutDiff`'s default options, so an application that computed a diff itself can show it by passing its `diff.v1` JSON as a payload. The ESM build imports the compute module on demand for it; the standalone viewer takes it from the `@kgdiff/viewer/standalone/compute` add-on (`globalThis.KgdiffCompute`), and without the add-on shows an error that says what is missing instead of failing to read the layout. The diff engine never runs for a payload, and payloads with a layout open exactly as before, without loading the compute module. A `layout` that is present but not an object (`null`, for instance) is rejected. The CLI keeps writing the layout into its reports.

### Patch Changes

- 7586808: Reports open the same way whatever Unicode version the browser has. `diffFromJSON` takes the labels, aliases and types of a document's snapshots as written instead of composing them to NFC again with the runtime's ICU, and the content hashes in the delta check that text: a report made with Node 24 (Unicode 17) no longer fails to open in a browser with older tables when a label holds a character whose composition changed in between, and a snapshot whose text was edited or is not in NFC is still rejected. To restore a label it left out without Unicode tables either, kgdiff JSON (diffs, graphs and deltas) now leaves an edge label out only when it equals `predicateLabel(predicate)` before its NFC step; a predicate whose readable part is written decomposed keeps its label in the document. A diff written by an earlier version for such a predicate, with that label left out, no longer opens: write it again. `normalize` composes API input to NFC as before.
- Updated dependencies [d01c4e0]
- Updated dependencies [cca58f9]
- Updated dependencies [cca58f9]
- Updated dependencies [9ebb278]
- Updated dependencies [7586808]
  - @kgdiff/core@0.7.0
  - @kgdiff/formats@0.7.0
  - @kgdiff/layout@0.7.0
  - @kgdiff/renderer@0.7.0
  - @kgdiff/scene@0.7.0

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
