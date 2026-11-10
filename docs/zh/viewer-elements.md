# 查看器元素：参考

<!-- Generated from packages/viewer/custom-elements.json by packages/viewer/scripts/manifest.ts: do not edit. Run `pnpm --filter @kgdiff/viewer manifest` after changing the sources. -->

`@kgdiff/viewer` 的每个元素：它的 HTML 属性及其对应的 JavaScript 属性、其他 JavaScript 属性、方法、事件、插槽、CSS 自定义属性和自定义状态。它们如何配合见[查看器：交互与 API](interaction.md)，用法示例见[嵌入查看器](guide/viewer.md)。

除 `<kgdiff-viewer>` 外，这些元素在 0.6 中是实验性的，0.7 起稳定：在此之前，名称、属性和结构可能在次版本中变化。

本页由源码生成（`packages/viewer/custom-elements.json`）。API 名称和说明直接取自源码的英文文档注释，没有翻译：同一份说明只有一个来源，表格才能随源码自动更新、不会与英文版不一致。编辑器可以按包里的[自定义数据](guide/viewer.md#编辑器支持)补全标签和属性。

- [`<kgdiff-viewer>`](#kgdiff-viewer)
- [`<kgdiff-root>`](#kgdiff-root)
- [`<kgdiff-stage>`](#kgdiff-stage)
- [`<kgdiff-change-list>`](#kgdiff-change-list)
- [`<kgdiff-change-detail>`](#kgdiff-change-detail)
- [`<kgdiff-search>`](#kgdiff-search)
- [`<kgdiff-filters>`](#kgdiff-filters)
- [`<kgdiff-view-dock>`](#kgdiff-view-dock)
- [`<kgdiff-transport>`](#kgdiff-transport)
- [`<kgdiff-legend>`](#kgdiff-legend)
- [`<kgdiff-zoom>`](#kgdiff-zoom)
- [`<kgdiff-minimap>`](#kgdiff-minimap)
- [`<kgdiff-title>`](#kgdiff-title)
- [`<kgdiff-actions>`](#kgdiff-actions)

<a id="kgdiff-viewer"></a>

## `<kgdiff-viewer>`

The drop-in viewer: a root (`KgdiffRootElement`) with the default layout, the canvas with its chrome, the change list, the search, the filters and the detail panel.

`header="compact"` leaves the brand and the compared names out of the canvas, for hosts that show their own (such as the playground): the preset `panels="title:hidden"`. `sidebar="closed"` starts with the sidebar folded (`\` and the sidebar button open it).

A small looping replay for another page: `mode="replay" chrome="none" loop` (with a height of your choosing, such as 320px).

The canvas has the slots of `<kgdiff-stage>` (`top-start`, `top-end`, `bottom-start`, `bottom-center`, `bottom-end`; the top ones under the title and the actions while those show): a child with `slot="top-end"` goes over the canvas, kept clear of fits and flights. A chrome element slotted in replaces the built-in region of its kind, the title and the actions included; `<kgdiff-zoom>` and `<kgdiff-minimap>` inside the viewer act on its canvas.

`import '@kgdiff/viewer'` 定义 `<kgdiff-viewer>`（以及其他所有元素）。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `mode` | `mode` | `'overlay' \| 'swipe' \| 'replay'` | Reflected to the `mode` attribute. Default `overlay`. |
| `scope` | `scope` | `'all' \| 'changes'` | Reflected to the `scope` attribute. Default `all` (`changes` for large graphs). Fixed to `changes` when the layout covers only the changes. |
| `theme` | `theme` | `'auto' \| 'light' \| 'dark'` | Reflected to the `theme` attribute. Default `auto`. |
| `palette` | `palette` | `'default' \| 'colorblind'` | Reflected to the `palette` attribute. Default `default`. |
| `locale` | `locale` | `'en' \| 'zh-CN'` | Reflected to the `locale` attribute. Default from `navigator.language`. |
| `sync-hash` |  | `boolean` | Keep the selection, mode and scope in the page's URL hash (`#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`) and follow it: deep links. |
| `loop` | `loop` | `boolean` | Reflected to the boolean `loop` attribute. In `replay` mode the replay plays by itself and starts again `loopDelay` ms after it ends. `pause()` stops it until `play()`. Default false. |
| `loop-delay` | `loopDelay` | `number` | Reflected to `loop-delay`: ms between the end of a looping replay and its restart. Default 1200. |
| `pause-on-hover` | `pauseOnHover` | `boolean` | With `loop`, the replay pauses while the pointer is over the graph and continues when it leaves (a mouse or pen; not touch). Reflected as `pause-on-hover="false"` when off. Default true. |
| `shortcuts` | `shortcuts` | `'scoped' \| 'global' \| 'none'` | Reflected to the `shortcuts` attribute: where the keyboard shortcuts apply. `scoped` (the default): while focus is inside the root, or in an element bound to it with `for` (those forward their keys). `global`: also when nothing on the page has focus (for full-page viewers such as HTML reports), for the first such root, except the keys pages scroll with (arrows, Home / End, Page Up / Down, Space); the boolean `global-shortcuts` attribute is an alias. `none`: no shortcuts (a focused change list keeps its arrow keys, Home / End and Enter). |
| `keymap` | `keymap` | `string` | Single keys of the keyboard map bound to another shortcut, or unbound with `null`: `{ x: null, r: 'review' }`. The `keymap` attribute takes the same as text, `"x:none r:review"` (`Space` names the space bar). Keys are `KeyboardEvent.key` values; a letter stands for both its cases unless the other case is named too; keys not named keep the default map; entries naming no shortcut are ignored with a warning. (实验性) |
| `sidebar` |  | `'open' \| 'closed'` | A preset: `closed` starts with the sidebar folded (`\` and the sidebar button open it), `open` with its four regions open. Reflects the sidebar's state once the user toggles it. |
| `header` |  | `'compact'` | A preset: `compact` leaves the brand and the compared names out of the canvas, for hosts that show their own (`panels="title:hidden"`). |
| `chrome` | `chrome` | `'full' \| 'none'` | Reflected to the `chrome` attribute. `none` shows the graph alone: no title, actions, view dock (with the step caption and playback bar), change list, zoom buttons, minimap or legend card; the hover tooltip and a one-line legend stay. Clicks and keyboard shortcuts do nothing, the minimum height drops from 420px to 120px, and the view stays fitted: when the canvas is resized (unless the user panned or zoomed since) and at the start of every loop. Labels are never cut at the edge: one pushed from its spot by a neighbour moves inside or is left out. Default `full`. |
| `legend` | `legend` | `'auto' \| 'full' \| 'mini' \| 'none'` | Reflected to the `legend` attribute: `full` (the card), `mini` (one line: the families this diff has, then unchanged), `none`. Default `auto`: `full`, or `mini` with `chrome="none"`. |
| `panels` | `panels` | `string` | The page's declaration of panel states, reflected to the `panels` attribute: a string (`"detail:collapsed minimap:hidden"`) or an object (`{ detail: 'collapsed' }`); reading it gives the object. Regions not named keep their state; entries that name no region or state are ignored with a warning. It wins over what the user chose before (remembered) and a report's `view.panels`; the user can still open and close collapsed regions, and declaring the same again keeps what they did. The presets `sidebar="closed"` (list, detail, search and filters collapsed), `header="compact"` (title hidden) and `chrome="none"` (everything but the canvas and the legend hidden) are panel states too; `panels` wins over them for the regions it names. The states every region has now are in `layout`. |
| `persist` | `persist` | `'local' \| 'none'` | Reflected to the `persist` attribute. `local` (the default): the layout remembers the user's panel states, sizes, theme, palette and language in `localStorage` (under `persistKey`, shared by the viewers of the origin with the same key). `none`: it remembers nothing. |
| `persist-key` | `persistKey` | `string` | Reflected to the `persist-key` attribute: the `localStorage` key the layout remembers under. Viewers with the same key share what they remember; give each app on a shared origin (a GitHub Pages user site, say) a key of its own. Default `kgdiff:viewer`. |
| `global-shortcuts` |  | `boolean` | The same as `shortcuts="global"`. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `layout` (只读) | `ViewerLayout` | Every region's state and the sizes now (what `kgdiff-layout` reports, without `source`). |
| `payload` | `ReportPayload \| null` | Set a precomputed report: shown without computing anything when it carries its layout, else laid out with the compute module (see `ReportPayload.layout`). |

### 方法

| 方法 | 说明 |
| --- | --- |
| `load(options: LoadOptions): Promise<void>` | Parse (if needed), diff, lay out and show two graphs. Rejects with a KgdiffError on bad input. |
| `selectHunk(id: string \| null): void` | Select a hunk by id (null clears) and bring it into view. |
| `next(): void` | Select the next change (`j`), in the list's order, and bring it into view. |
| `prev(): void` | Select the previous change (`k`). |
| `play(): void` | Play the replay (in `replay` mode), from where it is. |
| `pause(): void` | Pause the replay; a looping one stays paused until `play()`. |
| `fit(options?: FitOptions): Promise<void>` | Fit the whole graph, labels included, into view. |
| `exportDelta(): Delta` | The full delta of the current diff. |
| `reviewState(): ReviewState` | Which changes are reviewed, and how many of all. |
| `setReviewed(hunkId: string, reviewed: boolean): void` | Mark a change (by its id) reviewed or not; saved per diff, as the reader's `x` is. |
| `refreshTheme(): void` | Draw the canvas with the `--kgdiff-*` tokens as computed now: after the page changed tokens in a way the root cannot observe (a class on an ancestor, a new stylesheet). Theme, palette and system color scheme changes are followed by themselves. |

### 事件

| 事件 | `detail` | 说明 |
| --- | --- | --- |
| `kgdiff-ready` | `{ readonly stats: DiffStats }` | A diff is shown, from `load()` or a `payload`; `stats` counts its nodes, edges and changes. |
| `kgdiff-select` | `{ readonly hunk: string \| null; readonly node: string \| null }` | The selection changed: a change (`hunk`, its id, with the node chosen in it if any), a node alone (`hunk` null), or nothing (both null). |
| `kgdiff-mode` | `{ readonly mode: ViewerMode; readonly scope: ViewerScope }` | The mode or the scope changed, by the user, a key or the host. |
| `kgdiff-review` | `{ readonly hunk: string; readonly reviewed: boolean; readonly progress: ReviewState; }` | A change was marked reviewed, or not; `progress` is the review state after it. |
| `kgdiff-error` | `{ readonly error: Error }` | Loading or showing a diff failed; `error` is a `KgdiffError` for bad input. |
| `kgdiff-replay-end` | `{ readonly loop: boolean }` | Playback reached the end of the replay (not fired for seeking or stepping there). `loop`: it starts again after `loopDelay` ms; set `loop = false` or call `pause()` to stop it. |
| `kgdiff-layout` | `ViewerLayout & { readonly source: 'user' \| 'host' }` | The default layout changed: a panel opened, collapsed or was hidden, or a size changed (once a drag ends). `source`: the user did it in the viewer, or the host (attributes, properties, a report's `view.panels`). |

### 插槽

| 插槽 | 说明 |
| --- | --- |
| `top-start` | The page's content over the canvas, top left (under the title while it shows). |
| `top-end` | The page's content over the canvas, top right (under the actions while they show). |
| `bottom-start` | The page's content over the canvas, bottom left, above the legend. |
| `bottom-center` | The page's content above the view dock and the transport. |
| `bottom-end` | The page's content over the canvas, bottom right, above the zoom buttons and the minimap. |

<a id="kgdiff-root"></a>

## `<kgdiff-root>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

A root without visuals. It owns the session and provides it to the elements inside it (`<kgdiff-stage>`, `<kgdiff-change-list>`, …) or naming it with `for`, and owns what they share: the keyboard map, the live region announcing navigation, the events and the theme tokens. It has the attributes, properties, methods and events of `<kgdiff-viewer>` except the layout's (`panels`, `sidebar`, `header`, `chrome`, `legend`, `persist`): the page lays the elements out, and nothing is remembered.

It renders as `display: contents`, so its children are laid out by the page as if it were not there.

`import '@kgdiff/viewer/elements/root'` 只定义 `<kgdiff-root>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `mode` | `mode` | `'overlay' \| 'swipe' \| 'replay'` | Reflected to the `mode` attribute. Default `overlay`. |
| `scope` | `scope` | `'all' \| 'changes'` | Reflected to the `scope` attribute. Default `all` (`changes` for large graphs). Fixed to `changes` when the layout covers only the changes. |
| `theme` | `theme` | `'auto' \| 'light' \| 'dark'` | Reflected to the `theme` attribute. Default `auto`. |
| `palette` | `palette` | `'default' \| 'colorblind'` | Reflected to the `palette` attribute. Default `default`. |
| `locale` | `locale` | `'en' \| 'zh-CN'` | Reflected to the `locale` attribute. Default from `navigator.language`. |
| `sync-hash` |  | `boolean` | Keep the selection, mode and scope in the page's URL hash (`#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`) and follow it: deep links. |
| `loop` | `loop` | `boolean` | Reflected to the boolean `loop` attribute. In `replay` mode the replay plays by itself and starts again `loopDelay` ms after it ends. `pause()` stops it until `play()`. Default false. |
| `loop-delay` | `loopDelay` | `number` | Reflected to `loop-delay`: ms between the end of a looping replay and its restart. Default 1200. |
| `pause-on-hover` | `pauseOnHover` | `boolean` | With `loop`, the replay pauses while the pointer is over the graph and continues when it leaves (a mouse or pen; not touch). Reflected as `pause-on-hover="false"` when off. Default true. |
| `shortcuts` | `shortcuts` | `'scoped' \| 'global' \| 'none'` | Reflected to the `shortcuts` attribute: where the keyboard shortcuts apply. `scoped` (the default): while focus is inside the root, or in an element bound to it with `for` (those forward their keys). `global`: also when nothing on the page has focus (for full-page viewers such as HTML reports), for the first such root, except the keys pages scroll with (arrows, Home / End, Page Up / Down, Space); the boolean `global-shortcuts` attribute is an alias. `none`: no shortcuts (a focused change list keeps its arrow keys, Home / End and Enter). |
| `keymap` | `keymap` | `string` | Single keys of the keyboard map bound to another shortcut, or unbound with `null`: `{ x: null, r: 'review' }`. The `keymap` attribute takes the same as text, `"x:none r:review"` (`Space` names the space bar). Keys are `KeyboardEvent.key` values; a letter stands for both its cases unless the other case is named too; keys not named keep the default map; entries naming no shortcut are ignored with a warning. (实验性) |
| `global-shortcuts` |  | `boolean` | The same as `shortcuts="global"`. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `payload` | `ReportPayload \| null` | Set a precomputed report: shown without computing anything when it carries its layout, else laid out with the compute module (see `ReportPayload.layout`). |

### 方法

| 方法 | 说明 |
| --- | --- |
| `load(options: LoadOptions): Promise<void>` | Parse (if needed), diff, lay out and show two graphs. Rejects with a KgdiffError on bad input. |
| `selectHunk(id: string \| null): void` | Select a hunk by id (null clears) and bring it into view. |
| `next(): void` | Select the next change (`j`), in the list's order, and bring it into view. |
| `prev(): void` | Select the previous change (`k`). |
| `play(): void` | Play the replay (in `replay` mode), from where it is. |
| `pause(): void` | Pause the replay; a looping one stays paused until `play()`. |
| `fit(options?: FitOptions): Promise<void>` | Fit the whole graph, labels included, into view. |
| `exportDelta(): Delta` | The full delta of the current diff. |
| `reviewState(): ReviewState` | Which changes are reviewed, and how many of all. |
| `setReviewed(hunkId: string, reviewed: boolean): void` | Mark a change (by its id) reviewed or not; saved per diff, as the reader's `x` is. |
| `refreshTheme(): void` | Draw the canvas with the `--kgdiff-*` tokens as computed now: after the page changed tokens in a way the root cannot observe (a class on an ancestor, a new stylesheet). Theme, palette and system color scheme changes are followed by themselves. |

### 事件

| 事件 | `detail` | 说明 |
| --- | --- | --- |
| `kgdiff-ready` | `{ readonly stats: DiffStats }` | A diff is shown, from `load()` or a `payload`; `stats` counts its nodes, edges and changes. |
| `kgdiff-select` | `{ readonly hunk: string \| null; readonly node: string \| null }` | The selection changed: a change (`hunk`, its id, with the node chosen in it if any), a node alone (`hunk` null), or nothing (both null). |
| `kgdiff-mode` | `{ readonly mode: ViewerMode; readonly scope: ViewerScope }` | The mode or the scope changed, by the user, a key or the host. |
| `kgdiff-review` | `{ readonly hunk: string; readonly reviewed: boolean; readonly progress: ReviewState; }` | A change was marked reviewed, or not; `progress` is the review state after it. |
| `kgdiff-error` | `{ readonly error: Error }` | Loading or showing a diff failed; `error` is a `KgdiffError` for bad input. |
| `kgdiff-replay-end` | `{ readonly loop: boolean }` | Playback reached the end of the replay (not fired for seeking or stepping there). `loop`: it starts again after `loopDelay` ms; set `loop = false` or call `pause()` to stop it. |

<a id="kgdiff-stage"></a>

## `<kgdiff-stage>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

The canvas of the root it is bound to: the graph, the hover tooltip, the swipe divider, the replay caption and the canvas chrome (view dock, replay transport, legend, zoom buttons and minimap). Each stage is a view of its own: a root draws every stage bound to it, each with its own camera, sharing the selection, the hover, the filters and the search; `version` pins one to a version.

Five named slots take the page's content over the canvas. The stage positions it (12–16 px from the edges, stacked further from the corner than the chrome there), and every slotted element is an obstacle: fits and flights frame the graph in the free part of the canvas. A chrome element slotted in replaces the built-in region of its kind; `panels` keeps applying to the rest. Content positioned some other way registers itself with `registerObstacle`, on the element or on the stage context (`kgdiff.stage/1`) it provides to its descendants.

`import '@kgdiff/viewer/elements/stage'` 只定义 `<kgdiff-stage>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |
| `panels` | `panels` | `string` | The states of the built-in chrome (`dock`, `transport`, `legend`, `zoom`, `minimap`), reflected to the `panels` attribute, in the syntax of `<kgdiff-viewer>`'s `panels`: `"minimap:hidden zoom:hidden"` or `{ minimap: 'hidden' }`; reading it gives the object. Other regions are ignored with a warning. Default: all open, the legend collapsed. |
| `version` | `version` | `'before' \| 'after'` | Reflected to the `version` attribute: the version this stage draws whatever the root's mode, `before` or `after` (two stages of one root side by side), or null to follow the mode. Another value is ignored with a warning. Each stage has its own camera; the selection, hover, filters and search are the root's, so both bring the same change into view. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

### 方法

| 方法 | 说明 |
| --- | --- |
| `registerObstacle(element: Element): () => void` | Keep `element` (content over the canvas the stage does not place) clear of fits and flights; returns the function that stops it. Also on the stage context descendants can request (`Symbol.for('kgdiff.stage/1')`). |
| `addLayer(layer: RendererLayer): () => void` | Draw `layer` on this stage's canvas, under the graph (`order: 'under'`: after the background and the grid, before everything else) or over it (`order: 'over'`: after the labels): what only the page knows about, such as group backgrounds or marks on nodes. `draw(ctx, view)` is called once per painted frame (once per side in swipe, clipped to it, with `view.side`), in CSS pixels, with `view.worldToScreen` for the positions of the layout; the context is saved before and restored after. Layers are in the PNG export, are not picked, and their text takes no part in label placement; the rules in full are `RendererLayer`'s (`@kgdiff/renderer`). Returns the function that removes the layer. Until then it stays with the stage: added before the stage has a canvas it is drawn once there is one, and it follows the stage to another root and back into the document; while the stage is disconnected nothing is drawn. Throws `KgdiffError('invalid-input')` for a layer without a `draw` function or with another `order`. `<kgdiff-viewer>`'s built-in stage has no such method. (实验性) |

### 插槽

| 插槽 | 说明 |
| --- | --- |
| `top-start` | The page's content in the top left corner, below the version chip. |
| `top-end` | The page's content in the top right corner. |
| `bottom-start` | The page's content in the bottom left corner, above the legend. |
| `bottom-center` | The page's content above the view dock and the transport. |
| `bottom-end` | The page's content in the bottom right corner, above the zoom buttons and the minimap. |

<a id="kgdiff-change-list"></a>

## `<kgdiff-change-list>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

The "Changes" title with the count and review progress, and the changes grouped by phase (a virtualized listbox; `j` / `k` / `x`, Enter, Home / End). A labelled region. While a search is active (the session's query is not blank) its rows step aside. Registers itself as the root's `list` focus target (choosing a search result moves focus here).

`import '@kgdiff/viewer/elements/change-list'` 只定义 `<kgdiff-change-list>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-change-detail"></a>

## `<kgdiff-change-detail>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

The selected change, or the selected node: what changed first, then the unchanged rest; prev / next and the reviewed toggle. A labelled region.

`import '@kgdiff/viewer/elements/change-detail'` 只定义 `<kgdiff-change-detail>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-search"></a>

## `<kgdiff-search>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

Node search, a combobox and the results list it owns (its `aria-controls` and `aria-activedescendant` stay inside the element). The results open below the box while the query is not blank; ↑ / ↓ move through them, Enter chooses one (its node and change are selected, and focus moves to the change list), Esc clears. The query lives in the session, so a change list bound to the same root steps aside meanwhile. Registers itself as the root's `search` focus target: `/` focuses the one registered last that is shown.

`import '@kgdiff/viewer/elements/search'` 只定义 `<kgdiff-search>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-filters"></a>

## `<kgdiff-filters>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

One chip per kind of change the diff has, with its count and the legend's swatch, toggling the session's family filter, and "Show all" while a filter is on.

`import '@kgdiff/viewer/elements/filters'` 只定义 `<kgdiff-filters>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-view-dock"></a>

## `<kgdiff-view-dock>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

How the root's diff is viewed. The mode (overlay, swipe, replay; keys `1`–`3`) and "Changes only" (key `4`) with its context hops and the nearest "+N" expansion. Binds to a root like the other elements (`for`, `htmlFor`, `rootElement`). Slotted into a `<kgdiff-stage>` it replaces the stage's built-in dock; placed anywhere else it is not kept clear of fits and flights unless registered (`stage.registerObstacle`).

`import '@kgdiff/viewer/elements/view-dock'` 只定义 `<kgdiff-view-dock>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-transport"></a>

## `<kgdiff-transport>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

The replay transport of the root's diff. Previous, play / pause, next, the scrubber with one tick per change, the position and the speed; at the end, "Replay finished · Restart" above it. Shown in replay mode only. Binds to a root (`for`, `htmlFor`, `rootElement`). Slotted into a `<kgdiff-stage>` (`slot="bottom-center"`, say) it replaces the stage's built-in transport; placed anywhere else it is not kept clear of fits and flights unless registered. Importing this module defines it.

`import '@kgdiff/viewer/elements/transport'` 只定义 `<kgdiff-transport>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-legend"></a>

## `<kgdiff-legend>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

What the colors mean. `variant="full"` (the default): a card of every family's swatch and name, folded to its head until opened; `open` reflects whether it is (the user's toggle included, as on `<details>`). `variant="mini"`: one line of dots for the families the root's diff has, then the unchanged context. Binds to a root (`for`, `htmlFor`, `rootElement`). Slotted into a `<kgdiff-stage>` it replaces the stage's built-in legend; placed anywhere else it is not kept clear of fits and flights unless registered.

`import '@kgdiff/viewer/elements/legend'` 只定义 `<kgdiff-legend>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |
| `variant` | `variant` | `'full' \| 'mini'` | Reflected to `variant`: `full` (default) or `mini`; another value reads `full`. |
| `open` | `open` | `boolean` | Reflected to the boolean `open`: whether the card is open (the user's toggle too). |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-zoom"></a>

## `<kgdiff-zoom>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

Zoom in, zoom out and fit, for one stage's view (the `+` / `−` / `f` keys act on every stage of the root). Binds to the nearest `<kgdiff-stage>` around it, or to the one `stage="<id>"` names (`stage`, `stageElement`, `rootElement`). Slotted into a stage it replaces the stage's built-in zoom buttons; placed anywhere else it is not kept clear of fits and flights unless registered.

`import '@kgdiff/viewer/elements/zoom'` 只定义 `<kgdiff-zoom>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `stage` | `stage` | `string` | Reflects the `stage` attribute: the id of the stage to act on, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `stageElement` (只读) | `KgdiffStageElement \| KgdiffViewerElement \| null` | The stage this element acts on, or null while it waits for one. Inside a `<kgdiff-viewer>` (or naming one) it is the viewer, whose built-in stage it acts on. |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root whose session the stage shows, or null while the element or the stage waits. |

<a id="kgdiff-minimap"></a>

## `<kgdiff-minimap>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

An overview of one stage's view, with the part in view outlined. While the whole graph is in view it has nothing to add: it is in the custom state `overview` then (`:state(overview)`, and the read-only `overview` property). A minimap the page places stays shown (`kgdiff-minimap:state(overview) { visibility: hidden }` hides it without moving the layout); one slotted into a stage replaces the stage's own and hides as it did. Binds to the nearest `<kgdiff-stage>` around it, or to the one `stage="<id>"` names (`stage`, `stageElement`, `rootElement`). Slotted into a stage it replaces the stage's built-in minimap; placed anywhere else it is not kept clear of fits and flights unless registered.

`import '@kgdiff/viewer/elements/minimap'` 只定义 `<kgdiff-minimap>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `stage` | `stage` | `string` | Reflects the `stage` attribute: the id of the stage to act on, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `overview` (只读) | `boolean` | Whether the whole graph is in view: the element is in the custom state `overview` then (`kgdiff-minimap:state(overview)`). Placed by the page it stays shown (`kgdiff-minimap:state(overview) { visibility: hidden }` hides it in place); slotted into a stage it replaces the stage's own minimap and hides as that one does. |
| `stageElement` (只读) | `KgdiffStageElement \| KgdiffViewerElement \| null` | The stage this element acts on, or null while it waits for one. Inside a `<kgdiff-viewer>` (or naming one) it is the viewer, whose built-in stage it acts on. |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root whose session the stage shows, or null while the element or the stage waits. |

### 自定义状态

| 状态 | 说明 |
| --- | --- |
| `:state(overview)` | While the whole graph is in view. A minimap the page places stays shown; `kgdiff-minimap:state(overview) { visibility: hidden }` hides it in place. Slotted into a stage it hides then, as the stage's own does. |

<a id="kgdiff-title"></a>

## `<kgdiff-title>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

The kgdiff mark and the root's compared names and versions. Binds to a root (`for`, `htmlFor`, `rootElement`). Slotted into a `<kgdiff-viewer>` it replaces the title over its canvas.

`import '@kgdiff/viewer/elements/title'` 只定义 `<kgdiff-title>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="kgdiff-actions"></a>

## `<kgdiff-actions>`

**实验性：** In 0.6; stable from 0.7 (RFC 0001, decision 7).

The appearance menu (theme, color palette, language: the root's `theme`, `palette` and `locale`) and the keyboard shortcuts dialog, which `?` opens too. Binds to a root (`for`, `htmlFor`, `rootElement`); bound to a `<kgdiff-viewer>` it has the sidebar toggle too (a composed root has no sidebar). Slotted into a viewer it replaces the actions over its canvas.

`import '@kgdiff/viewer/elements/actions'` 只定义 `<kgdiff-actions>`；`import '@kgdiff/viewer'` 定义所有元素。

### HTML 属性

| HTML 属性 | JavaScript 属性 | 取值 | 说明 |
| --- | --- | --- | --- |
| `for` | `htmlFor` | `string` | Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show, or '' (no attribute; setting '' removes it) for the nearest one around the element. Changing it binds again. |

### JavaScript 属性

| JavaScript 属性 | 类型 | 说明 |
| --- | --- | --- |
| `rootElement` (只读) | `KgdiffRootElement \| null` | The root this element shows, or null while it waits for one (`for`'s element, resolved). |

<a id="tokens"></a>

## CSS 自定义属性

设在 `<kgdiff-viewer>` 和 `<kgdiff-root>` 上（根元素内部的元素继承它们；在根元素之外用 `for` 绑定的元素采用根元素的内置令牌集）。画布和各个面板都用它们绘制：见[主题](interaction.md#主题)。

| 属性 | 语法 | 说明 |
| --- | --- | --- |
| `--kgdiff-background` | `<color>` | The theme's `canvas.background`. |
| `--kgdiff-grid` | `<color>` | The theme's `canvas.grid`. |
| `--kgdiff-panel` | `<color>` | The theme's `surface.panel`. |
| `--kgdiff-raised` | `<color>` | The theme's `surface.raised`. |
| `--kgdiff-overlay` | `<color>` | The theme's `surface.overlay`. |
| `--kgdiff-border` | `<color>` | The theme's `surface.border`. |
| `--kgdiff-border-strong` | `<color>` | The theme's `surface.borderStrong`. |
| `--kgdiff-control-border` | `<color>` | The theme's `surface.controlBorder`. |
| `--kgdiff-shadow` |  | The theme's `surface.shadow`. |
| `--kgdiff-text` | `<color>` | The theme's `text.primary`. |
| `--kgdiff-text-secondary` | `<color>` | The theme's `text.secondary`. |
| `--kgdiff-text-muted` | `<color>` | The theme's `text.muted`. |
| `--kgdiff-accent` | `<color>` | The theme's `accent.base`. |
| `--kgdiff-accent-strong` | `<color>` | The theme's `accent.strong`. |
| `--kgdiff-accent-soft` | `<color>` | The theme's `accent.soft`. |
| `--kgdiff-accent-text` | `<color>` | The theme's `accent.text`. |
| `--kgdiff-neutral` | `<color>` | The theme's `neutral.node`. |
| `--kgdiff-neutral-stroke` | `<color>` | The theme's `neutral.nodeStroke`. |
| `--kgdiff-neutral-edge` | `<color>` | The theme's `neutral.edge`. |
| `--kgdiff-neutral-label` | `<color>` | The theme's `neutral.label`. |
| `--kgdiff-font` |  | The theme's `font.family`. |
| `--kgdiff-font-mono` |  | The theme's `font.mono`. |
| `--kgdiff-added` | `<color>` | The theme's `family.added.base`. |
| `--kgdiff-added-strong` | `<color>` | The theme's `family.added.strong`. |
| `--kgdiff-added-soft` | `<color>` | The theme's `family.added.soft`. |
| `--kgdiff-added-text` | `<color>` | The theme's `family.added.text`. |
| `--kgdiff-removed` | `<color>` | The theme's `family.removed.base`. |
| `--kgdiff-removed-strong` | `<color>` | The theme's `family.removed.strong`. |
| `--kgdiff-removed-soft` | `<color>` | The theme's `family.removed.soft`. |
| `--kgdiff-removed-text` | `<color>` | The theme's `family.removed.text`. |
| `--kgdiff-content` | `<color>` | The theme's `family.content.base`. |
| `--kgdiff-content-strong` | `<color>` | The theme's `family.content.strong`. |
| `--kgdiff-content-soft` | `<color>` | The theme's `family.content.soft`. |
| `--kgdiff-content-text` | `<color>` | The theme's `family.content.text`. |
| `--kgdiff-structure` | `<color>` | The theme's `family.structure.base`. |
| `--kgdiff-structure-strong` | `<color>` | The theme's `family.structure.strong`. |
| `--kgdiff-structure-soft` | `<color>` | The theme's `family.structure.soft`. |
| `--kgdiff-structure-text` | `<color>` | The theme's `family.structure.text`. |
| `--kgdiff-identity` | `<color>` | The theme's `family.identity.base`. |
| `--kgdiff-identity-strong` | `<color>` | The theme's `family.identity.strong`. |
| `--kgdiff-identity-soft` | `<color>` | The theme's `family.identity.soft`. |
| `--kgdiff-identity-text` | `<color>` | The theme's `family.identity.text`. |
