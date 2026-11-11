# kgdiff viewer interaction design

Behaviour of `<kgdiff-viewer>` (package `@kgdiff/viewer`) and of the elements it is made of.
Visual tokens and encodings come from [visual-language.md](visual-language.md); the design of
the elements is [RFC 0001](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0001-viewer-components.md).

## Layout

```
┌──────────────────────────────────────────────────────────────────┬─────────────────────┐
│ ⟨◆ kgdiff │ go.obo  v2026-09 → v2026-10⟩                ⟨◐ ? ▥⟩ │ Changes  23   ⌕     │
│                                                                  │ ◉Added ◌Removed …   │  filter chips
│                                                                  │ ▍Merged “A” into “B”│
│                          canvas                                  │ ▍Renamed “x” → “y”  │  hunk list
│                                                                  │ …                   │
│               ⟨ ◀  ▶‖  ▶  ━━━●━━━━━━━  3/23  1× ⟩    (replay)   │                     │
│ ⟨Legend ▾⟩  ⟨Overlay│Swipe│Replay ┊ ◎ Changes only  0 1 2⟩  ┌map┐├─────────────────────┤
│                                                         ⟨+−⤢⟩└───┘│ detail panel        │
└──────────────────────────────────────────────────────────────────┴─────────────────────┘
```

- Sidebar 360 px, full height (folds away with `\` or the sidebar button). Its left edge drags
  its width (280 px up to the width that leaves the canvas 320 px; ← / → on the focused edge,
  Shift for larger steps, Home / End; double click: 360 px). Below 760 px wide it becomes a
  bottom sheet (40% height, draggable handle).
- In the sidebar, the change list's title row has a chevron that folds the list to that row,
  and the detail panel has a bar ("Change details") that folds it to the bar. Between the two,
  a split drags the detail panel's height (↑ / ↓ on the focused split, Home / End; double
  click: back to the content's height, up to 58%). Both separators are `role="separator"` with
  values. Every region can be opened, collapsed or hidden by the page too: see
  [Panels](#panels).
- Everything else floats over the canvas on overlay surfaces and never covers the current hunk:
  fits and flights frame it in the free part of the canvas.

## Canvas chrome

- **Title** (top left): brand mark + "before → after" names (from graph meta / file names),
  version tags. `header="compact"` leaves it out, for hosts that show their own.
- **Actions** (top right): appearance menu (theme auto / light / dark, palette default /
  color-blind safe, language), help (`?`), sidebar toggle.
- **View dock** (bottom center) holds two independent choices:
  - **Mode**: **Overlay** (`1`), **Swipe** (`2`), **Replay** (`3`). They tell before from after
    by color, by space and by time, so exactly one is active. Changing mode keeps the camera.
  - **Changes only** (`4`): a scope that works with any mode. While on, the dock shows the
    context hops 0 / 1 / 2 and “+N”, which expands the hidden context nearest the selection
    (`e`). It stays on when the layout covers only the changes (large graphs); the toggle
    then says why.
  - Replay's caption (the playing hunk) and transport stack above the dock; at the end
    "Replay finished · Restart" takes the caption's place.
  - Narrower canvases drop the labels (each control keeps its name as a tooltip).
- **Legend** (bottom left), collapsed by default: the sidebar's filter chips wear the same
  swatches.
- **Zoom** (+ / − / fit) bottom right. The **minimap** next to it appears only while part of
  the content is out of view.
- **Slots**: the page's content in `slot="top-start"`, `top-end`, `bottom-start`,
  `bottom-center` or `bottom-end` of `<kgdiff-viewer>` goes over the canvas (the top ones under
  the title and the actions while those show, the bottom ones above the chrome of their corner)
  and is kept clear of fits and flights. A chrome element slotted there replaces the built-in
  region, the title and the actions included ([Elements](#elements)). In the compact layout the zoom buttons move under the
  actions, the top-end content under them, and the bottom content above the full-width dock.

## Panels

Every region of `<kgdiff-viewer>` is `open`, `collapsed` or `hidden`: the change list
(`list`), the detail panel (`detail`), the node search (`search`), the family filters
(`filters`), the view dock (`dock`), the replay transport (`transport`), the legend (`legend`),
the zoom buttons (`zoom`), the minimap (`minimap`), the title (`title`) and the actions
(`actions`).

```html
<kgdiff-viewer panels="detail:collapsed minimap:hidden"></kgdiff-viewer>
<script>
  viewer.panels = { detail: 'collapsed' }; // the same, as a property
</script>
```

- **States.** `open`. `collapsed`: folded to the control that opens it again — the list to its
  title row, the detail panel to its bar, the search and the filters to a button in the list's
  title row, the legend to its head — and `inert`; the sidebar (or the bottom sheet) folds away
  when all four of its regions are collapsed. Regions without a fold of their own (dock,
  transport, zoom, minimap, title, actions) are not shown while collapsed. `hidden`: not shown,
  and no control brings it back (`\` does nothing once all four sidebar regions are hidden).
  Focus moves out of a region before it folds or hides: to its control, else to the sidebar
  button or the canvas.
- **Defaults.** Everything open, the legend collapsed (as it always was).
- **Syntax.** `region:state` pairs separated by spaces or commas; regions not named keep their
  state; pairs that name no region or state are ignored with a console warning. Reading
  `panels` gives the page's declaration back as an object (the attribute's value); `layout`
  gives every region's state now and the sizes (`{ panels, sidebarWidth, detailShare }`).
  Declaring the same panels again, as a framework does on every render, keeps what the user
  did; only a region whose declared value changed gives way.
- **Presets.** The older switches are panel states:

  | Attribute        | Means                                                                           |
  | ---------------- | ------------------------------------------------------------------------------- |
  | `sidebar=closed` | `list:collapsed detail:collapsed search:collapsed filters:collapsed`            |
  | `sidebar=open`   | the same four open                                                              |
  | `header=compact` | `title:hidden`                                                                  |
  | `chrome=none`    | every region but the legend hidden, the legend one line; no clicks or shortcuts |
  | `legend=…`       | the legend's style (`full`, `mini`, `none`), as before                          |

  `panels` wins over the presets for the regions it names.
- **Who decides.** A region's state comes from the first of: what the user did in this page;
  the page's `panels`, then the presets; what the user chose before (remembered); the report's
  `view.panels` ([`--panels`](cli.md#report-options)); the default. When the page sets a region
  again, its value replaces what the user did there in this page.
- **Remembered.** The default layout remembers the user's panel states, the sidebar's width,
  the list / detail split, theme, palette and language, in `localStorage` (one entry, shared
  by the viewers of the origin with the same key: `persist-key`, `kgdiff:viewer` by default;
  give each app on a shared origin, such as a GitHub Pages user site, a key of its own; storage
  that is blocked or full is ignored).
  Theme, palette and language follow the same order: the page's attribute or property, then
  what the user chose before, then the report's `view`, then the default. `persist="none"`
  turns remembering off. The elements below (`<kgdiff-root>` and the rest) remember nothing:
  the page owns their layout.
- **`kgdiff-layout`** reports every change of a panel state or size (once a drag ends), by the
  user (`source: 'user'`) or the page or a report (`source: 'host'`):
  `{ panels, sidebarWidth, detailShare, source }`. The first states are not reported.

## Modes

**Overlay.** Union layer. Hover a node: tooltip card (label, id, status, one-line summary).
Click: select its hunk (or the node if unchanged). Click empty canvas: clear selection.

**Swipe.** Before on the left, after on the right of a vertical divider (default 50%). Drag
the handle (or the divider anywhere along it), `←` / `→` move 2% (`Shift` 10%), double-click
resets. "Before" / "After" chips under the title and the actions. Selection still works on both
sides.

**Replay.** The before graph morphs into the after graph hunk by hunk (timeline from the
scene). Transport: previous / play-pause / next, scrubber with one tick per hunk (family
color, hover shows the title), position `3 / 23`, speed `0.5× 1× 2× 4×`. `Space` play/pause,
`←` / `→` step. Selecting a hunk in the list seeks to the end of its window. The camera follows
the current hunk unless the user has panned/zoomed in the last 2 s. Reaching the end shows
"Replay finished · Restart".

**Changes only (scope).** Focus view in any mode: changed elements + 1 hop of context (0 / 1 /
2 in the dock); hidden nodes summarized as "+38 unchanged" pills; click a pill to expand it
(positions via `extendLayout`, so nothing else moves). Swipe focuses both sides; replay plays
within the focus. Default for graphs above the large-graph threshold.

## Change list (sidebar)

- Header: "Changes" + count, search field (`/`): fuzzy match over node labels, aliases and ids
  across the whole graph; results show status dots; choosing one flies to the node and selects
  its hunk.
- Filter chips per family with counts (multi-select; none = all). Filtering dims non-matching
  hunks on the canvas and hides them from the list.
- Rows grouped by phase (Removed, Restructured, Modified, Added) with sticky group headers.
  Row: 3 px family bar, glyph (`+ − ~ ⇄ ⊕ ⑂`), title (one line, ellipsis, full on hover),
  subtitle (muted), and a round "reviewed" toggle. Selected row: raised surface + accent outline.
- Keyboard: `j` / `↓` next, `k` / `↑` previous, `Enter` fly to it, `x` toggle reviewed,
  `Home` / `End`. The list is a `listbox` with `aria-activedescendant`.
- Review progress bar under the header: "7 of 23 reviewed". Review state persists in
  `localStorage` keyed by `base.hash → target.hash` (wrapped in try/catch).

## Detail panel

For the selected hunk (or node), what changed comes first and the unchanged rest last:

- Title, family pill, prev / next arrows, reviewed toggle.
- Changes: one row per changed facet, before → after.
  - Name and id: character-level diff highlighting; a rekey adds its match confidence.
  - Attributes: one row per key. Text gets a word-level diff; values over 60 characters (both
    sides together) get a line per side, truncated with expand. `+` / `−` mark added and
    removed keys.
  - Synonyms, types, parents and list values: a lone removal and addition read as one edit
    (`老赖 → 失信人`). Otherwise removals and additions sharing at least half their characters
    pair up, closest first; the rest are chips with `+` / `−`.
  - Deprecation, and replacement links named by the nodes they point at.
- Merge / split composition: sources → target with confidence and "via hint / heuristic".
- Relations: changed edges as sentences — `→ holds → 上市公司 (was 企业)`, each clickable.
- Match evidence (rekeys and suggestions): bars for label / neighbours / types / attrs.
- Overview: id, types, synonyms and status that did not change. The unchanged attributes are
  folded behind a toggle.
- Added and removed nodes, and an unchanged node clicked on its own, lead with the overview and
  all their attributes, then their relations.

## Keyboard map

| Key               | Action                               |
| ----------------- | ------------------------------------ |
| `1` `2` `3`       | Overlay / Swipe / Replay             |
| `4`               | Changes only (on / off, in any mode) |
| `e`               | Expand hidden context (changes only) |
| `j` `↓` / `k` `↑` | Next / previous change               |
| `Enter`           | Fly to the selected change           |
| `Esc`             | Clear selection, close popovers      |
| `Space`           | Play / pause (replay)                |
| `←` `→`           | Step (replay) · move divider (swipe) |
| `f`               | Fit everything                       |
| `+` `−`           | Zoom in / out                        |
| `/`               | Search                               |
| `x`               | Toggle reviewed                      |
| `\`               | Toggle sidebar                       |
| `t`               | Cycle theme                          |
| `?`               | Shortcut help                        |

Shortcuts are ignored while typing in an input.

**Where they apply** (`shortcuts`): `scoped` (the default) while focus is inside the viewer;
`global` also when nothing on the page has focus (full-page viewers such as HTML reports), for
the first such viewer on the page and never the keys pages scroll with (arrows, Home / End,
Page Up / Down, Space) — the boolean `global-shortcuts` attribute means the same; `none`: no
shortcuts, though a focused change list keeps ↑ / ↓, Home / End and Enter. A key pressed inside
nested roots acts on the nearest one only.

**Rebinding** (`keymap`): single keys can be bound to another shortcut or unbound, as data:
`keymap="x:none r:review"` or `viewer.keymap = { x: null, r: 'review' }` (keys are
`KeyboardEvent.key` values, `Space` names the space bar in the attribute). A letter stands for
both its cases, here and in the default map: `x:none` also unbinds Shift+X, unless `X` is named
too. Shortcuts:
`overlay`, `swipe`, `replay`, `scope`, `expand`, `next`, `prev`, `first`, `last`, `fly`,
`escape`, `play-pause`, `left`, `right` (step in replay, move the divider in swipe, larger with
Shift), `fit`, `zoom-in`, `zoom-out`, `search`, `review`, `sidebar`, `theme`, `help`. The
shortcuts dialog lists the keys bound now, after `keymap`: a rebound key where it acts, an
unbound shortcut left out (a row of shortcuts that no longer has one key each splits into a row
per shortcut).

**Several stages.** `f`, `+` and `−` fit and zoom every stage of the root; the zoom buttons of a
stage (or a `<kgdiff-zoom>`) act on that stage alone. In a composed root `?` opens the dialog of
a `<kgdiff-actions>` bound to it (which leaves the sidebar key out), and does nothing without
one; `\` does nothing there.

## Embedding API

```html
<kgdiff-viewer theme="auto" locale="zh-CN" mode="replay" scope="changes"></kgdiff-viewer>
<script type="module">
  import '@kgdiff/viewer';
  const viewer = document.querySelector('kgdiff-viewer');
  await viewer.load({ before, after, options }); // GraphInput | KGraph | { text, filename }
  // or: viewer.payload = reportPayload;         // precomputed (CLI report)
</script>
```

The attributes and the properties they reflect, the other properties (`payload`, a
precomputed report, laid out in the browser when it carries no layout; `layout`, every region's
state and the sizes), the methods and the events
(`CustomEvent`s that bubble and are composed) are listed in
[Viewer elements: reference](viewer-elements.md#kgdiff-viewer), generated from the sources; the
sections here explain them: [Modes](#modes), [Panels](#panels), [Keyboard map](#keyboard-map),
[Theming](#theming). `changes` is a scope, not a mode: `mode="changes"` is
an unknown value, and reads as the default, `overlay`.

## Elements

`<kgdiff-viewer>` is a default layout of elements that can also be placed one by one. They are
stable since 0.10 ([RFC 0001](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0001-viewer-components.md#decisions),
decision 7): names, attributes and events follow semantic versioning. Each one's
attributes, properties, events, slots and states are in the
[reference](viewer-elements.md); this section explains how they work together.

| Element                  | What it shows                                                                     |
| ------------------------ | --------------------------------------------------------------------------------- |
| `<kgdiff-root>`          | nothing: the session, keyboard map, live region, events and theme tokens          |
| `<kgdiff-stage>`         | a view: the canvas, with its chrome (view dock, transport, legend, zoom, minimap) |
| `<kgdiff-change-list>`   | the "Changes" title, count, review progress and the change rows                   |
| `<kgdiff-change-detail>` | the selected change or node                                                       |
| `<kgdiff-search>`        | node search: a combobox with its own results list                                 |
| `<kgdiff-filters>`       | the family filter chips with their counts, and "Show all"                         |
| `<kgdiff-view-dock>`     | the view dock: mode, changes only, the context hops and "+N"                      |
| `<kgdiff-transport>`     | the replay transport and "Replay finished · Restart", in replay mode only         |
| `<kgdiff-legend>`        | the legend: the card (`variant="full"`) or one line (`variant="mini"`)            |
| `<kgdiff-zoom>`          | zoom in, zoom out and fit, for one stage                                          |
| `<kgdiff-minimap>`       | one stage's minimap, in the state `overview` while the whole graph is in view     |
| `<kgdiff-title>`         | the brand, the names of the versions compared and their tags                      |
| `<kgdiff-actions>`       | the appearance menu (theme, palette, language) and the shortcuts dialog           |

- **`<kgdiff-root>`** has the attributes, properties, methods and events of `<kgdiff-viewer>`
  except the layout's (`panels`, `persist`, `sidebar`, `header`, `chrome`, `legend` and
  `kgdiff-layout`). It renders as `display: contents`: the page lays out its children.
- **Binding.** An element shows the session of the nearest `<kgdiff-root>` (or
  `<kgdiff-viewer>`) around it, also across shadow roots, or of the one its `for="<id>"` names
  anywhere on the page. Order does not matter: a root defined or connected later, or an id that
  appears later, is found then. Two roots on a page never share selection, keys or
  announcements. The `htmlFor` property reflects `for` (as on `<label>`; setting '' removes the
  attribute), and the read-only `rootElement` is the root an element is bound to, or null while
  it waits for one: an id reference reflects as a string and resolves as `…Element`, as
  `popovertarget` does (`popoverTargetElement`).
- **The stage** has five named slots, `top-start`, `top-end`, `bottom-start`, `bottom-center`
  and `bottom-end`, for the page's content over the canvas: the stage positions it (stacked
  further from the corner than the chrome there), and every slotted element is kept clear of
  fits and flights, as the chrome is. Content positioned some other way registers itself:
  `stage.registerObstacle(element)` (returns the function that stops it), also offered to the
  stage's descendants as a context (`Symbol.for('kgdiff.stage/1')`). The stage brings its
  canvas chrome along: its `panels` attribute or property, in the syntax above, opens, collapses
  or hides the stage's regions `dock`, `transport`, `legend`, `zoom` and `minimap`
  (`<kgdiff-stage panels="zoom:hidden minimap:hidden">`). Each stage is a region named after the
  graph (and its version), not a main landmark.
- **Several stages.** A root draws every stage bound to it, each a view of its own: its canvas,
  camera, fits and flights, tooltip and minimap. The session is the root's and shared: the
  selection (every stage brings it into view), the hover (highlighted in every stage), the mode
  and scope, the replay clock, the filters and the search. `version="before"` or `"after"` (the
  `version` property; null follows the mode, another value is ignored with a warning) pins a
  stage to one version whatever the mode: no swipe divider or replay caption then, and a chip
  names the version. It is the one setting of a view; everything else is the session's.
- **Chrome elements.** `<kgdiff-view-dock>`, `<kgdiff-transport>`, `<kgdiff-legend>`,
  `<kgdiff-title>` and `<kgdiff-actions>` show the root's session (`for`, `htmlFor`,
  `rootElement`, as above). `<kgdiff-zoom>` and `<kgdiff-minimap>` act on one view: the nearest
  `<kgdiff-stage>` around them, or the one `stage="<id>"` names anywhere on the page (a
  `<kgdiff-viewer>` is the stage of the ones inside it, and can be named too). By the same
  scheme the `stage` property reflects the attribute (setting '' removes it), the read-only
  `stageElement` is the stage found, or null while it waits, and `rootElement` is that stage's
  root.
- **Replacing the built-in chrome**, one rule for every chrome element: slotted into a stage
  or a `<kgdiff-viewer>`, it replaces the built-in region of its kind (the view dock,
  transport, legend, zoom or minimap; in the viewer the title and the actions too, a stage
  having none); `panels` keeps applying to the regions still drawn (and still reads the page's
  declaration), and the element is kept clear of fits and flights like any slotted content.
  Taking it out brings the built-in one back. A `<kgdiff-actions>` bound to a viewer has the
  sidebar toggle too. Placed anywhere else, over the canvas or not, a chrome element is not an
  obstacle unless registered with `stage.registerObstacle(element)`.
- **`<kgdiff-legend>`**: `variant="full"` (the default) is the card, folded to its head until
  opened; the boolean `open` (property `open`) reflects whether it is, the reader's toggle
  included, as on `<details>`. `variant="mini"` is one line of dots. **`<kgdiff-minimap>`**
  is in the custom state `overview` (`:state(overview)`, read-only property `overview`) while
  the whole graph is in view; it sets no attribute on itself, as the host's attributes are the
  page's. Placed by the page it stays shown, so the layout around it does not move;
  `kgdiff-minimap:state(overview) { visibility: hidden }` hides it in place. Slotted into a
  stage it replaces the stage's own minimap and hides while in overview, as that one does.
  **`<kgdiff-transport>`** shows in replay mode only. **`<kgdiff-actions>`** opens its menu and
  dialog in place.
- **Search** opens its results below the box while the query is not blank. The query lives in
  the session: a change list bound to the same root steps aside meanwhile. `/` focuses the
  search registered last that is shown.
- **Keyboard.** The root owns the keyboard map (`shortcuts`, `keymap`). Keys pressed in an
  element inside the root reach it by bubbling; an element bound with `for` forwards its keys.
- **Accessibility.** The change list and the detail panel are labelled regions; ARIA id
  references stay inside one element (the list's options, the search's results); across
  elements only focus moves (choosing a result focuses the change list) and the root's single
  live region announce.
- **Theme.** Tokens set on the root are inherited by the elements inside it; an element bound
  with `for` outside the root's subtree adopts the root's built-in token set; page overrides on
  the root do not reach it, so set them on that element too.
- **Packages.** `import '@kgdiff/viewer'` defines every element. Each also has a subpath that
  defines only it: `@kgdiff/viewer/elements/root`, `…/stage`, `…/change-list`,
  `…/change-detail`, `…/search`, `…/filters`, `…/view-dock`, `…/transport`, `…/legend`,
  `…/zoom`, `…/minimap`, `…/title`, `…/actions`. The session comes with the root and the
  renderer with a stage: no other subpath carries either. `@kgdiff/viewer/panels` is the panels syntax
  (`parsePanels`, `PANEL_REGIONS`, `PANEL_STATES`), without DOM, which the CLI's `--panels`
  uses too. The package ships its Custom Elements Manifest (`custom-elements.json`, the
  `customElements` field), VS Code's HTML custom data generated from it, and React 19's JSX
  types (`@kgdiff/viewer/react`): [Editor support](guide/viewer.md#editor-support).

## Theming

Colors and fonts are CSS custom properties, `--kgdiff-*`, set on the root (`<kgdiff-viewer>`
or `<kgdiff-root>`) for the built-in theme (light, dark, color-blind palette) and inherited by
everything inside, the canvas included. They are public API from 0.6; the list is in
[visual-language.md](visual-language.md#css-tokens). Override any of them with ordinary CSS on
the root (page styles win over the built-in set), at your own responsibility for contrast:

```css
kgdiff-viewer {
  --kgdiff-accent: #e8590c;
  --kgdiff-font: "IBM Plex Sans", system-ui, sans-serif;
}
```

The viewer follows its theme, palette and system color scheme by itself. After changing tokens
in a way it cannot observe (a class on an ancestor, a stylesheet added later), call
`refreshTheme()`. A value the canvas cannot draw is ignored there with a console warning.

## States

- **Loading**: skeleton canvas + step text ("Parsing… · Matching nodes… · Laying out…").
- **Identical**: calm empty state — "No differences. Both versions have 512 nodes and 1,490
  edges." with a subtle check glyph.
- **Error**: message + details disclosure; never a blank screen.

## Accessibility

- Every control is a real button / input with an accessible name; visible focus rings (accent).
- Canvas has `role="img"` and an `aria-label` summary (stats); a polite live region announces
  "Change 3 of 23: Renamed “x” to “y”" on navigation.
- Contrast tokens are tested; color is never the only cue; reduced motion respected.
- All features reachable by keyboard; pointer targets ≥ 28 px.
- Announcements go through the root's one live region, once: the replay's end too, however many
  transports show it.

**Checks** (`packages/viewer/test/a11y.test.ts`), for the default layout and a composed root:
every control shown has a name in every state (modes, scope, replay, the menu, the search's
results, the dialog); one main landmark in the viewer and none from a stage; one live region per
root; no positive `tabindex`; a region that is not open leaves no tab stop; the shortcuts dialog
takes focus, keeps it and gives it back. The tab order they pin: in the viewer the canvas, the
page's content in the top corners, the chrome from the bottom left (legend, zoom, dock), the
title and actions, then the sidebar (search, filters, list, detail); in a composed root the
page's order, each element's controls together, slotted content where its slot is.

What they cannot cover (happy-dom has no layout and no styles): what styles hide (container
queries, the compact layout), focus rings, contrast, reduced motion and target sizes; the
accessible name as a browser computes it (approximated from `aria-labelledby`, `aria-label`,
text and `title`); real sequential focus navigation (the order is read from the flat tree;
checked by hand in Chrome on the dev page, the same order); and what a screen reader says (not
checked).

## Internationalization

UI strings in `en` and `zh-CN`; hunk titles from core `formatHunk`; numbers via
`Intl.NumberFormat`. Chinese UI uses 「」 quotes, English “ ”.
