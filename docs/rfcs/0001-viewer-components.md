# RFC 0001: Composable viewer components

- **Status:** Accepted design, decisions recorded (see [Decisions](#decisions)). Phase 1 is
  implemented ([PR #34](https://github.com/iiwish/kgdiff/pull/34), merged as 34a7b13); phase 2 is
  in progress.
- **Date:** 2026-11-06
- **Prototype:** the branch `spike/viewer-components` was never merged and was deleted on
  2026-11-06; its findings are in [Prototype results](#prototype-results)
- **Affects:** `@kgdiff/viewer` (public API), `@kgdiff/renderer` (theme input), the CLI's HTML
  report (unchanged output), docs

## Summary

Split `<kgdiff-viewer>` into elements that share one diff session: a provider (`<kgdiff-root>`)
and region components (canvas, change list, detail panel, search, filters, view dock, replay
transport, legend, zoom, minimap, title, actions). `<kgdiff-viewer>` stays, unchanged for its users, as the
default layout composed from those elements. Hosts that need another layout compose the
elements themselves; hosts that only need to hide or collapse a region set one attribute on
the default layout.

A prototype validated the three risky parts — binding across shadow roots, keyboard and
accessibility across components, and keeping floating host content clear of the camera — and
found the design rules this RFC adopts (see [Prototype results](#prototype-results)).

## Motivation

The viewer is one custom element with a handful of switches (`sidebar`, `header`, `chrome`,
`legend`). Measured on the current build:

- **Regions cannot be hidden one by one.** The detail panel lives inside the sidebar and takes up
  to 58% of it once a change is selected (323 px of 713 at 1280 × 800); it has no collapse of
  its own. Only the whole sidebar can be closed.
- **Regions cannot be placed by the host.** A host app that wants the change list in its own
  sidebar, or the detail panel in a drawer, cannot have it.
- **Preferences are not remembered, and reports cannot preset them.** Only review progress
  persists. The CLI offers `--theme`, `--mode` and `--scope`, nothing about layout.
- **The switch list only grows.** Every new layout need adds an attribute to one element.

kgdiff aims to be embedded where knowledge graphs are reviewed: ontology editors, notebooks,
code-review tools, IDE extensions. Those hosts have layouts of their own. They need parts, not
one fixed screen. Media players took the same path (media-chrome's `<media-controller>` with
`<media-play-button>` and friends; Vidstack's default layout built from its own components);
mapping libraries expose controls as plug-ins for the same reason.

## Goals

1. Every region can be shown, collapsed, hidden, or placed by the host.
2. `<kgdiff-viewer>` keeps its API and behaviour; HTML reports keep working unchanged.
3. One state model drives every component; components never talk to each other directly.
4. Works without a framework and in every framework (custom elements, properties, DOM events).
5. Accessible by construction, as today: keyboard map, live announcements, focus, contrast.
6. The standalone bundle stays within its budget; ESM users pay only for what they import.

## Non-goals

- Framework-specific component libraries (React components, Vue SFCs). Thin wrappers may come
  later; the elements are the product.
- Making every button a component. See [Granularity](#granularity).
- Changing the visual language (docs/visual-language.md) or the interaction design of the
  regions themselves (docs/interaction.md).

## Design

Three layers:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 3. Default layout   <kgdiff-viewer panels="…">  (what reports and most users use) │
├──────────────────────────────────────────────────────────────────────────────┤
│ 2. Elements         <kgdiff-root> <kgdiff-stage> <kgdiff-change-list> …          │
├──────────────────────────────────────────────────────────────────────────────┤
│ 1. Session          headless: data, selection, filters, review, replay, prefs   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1. The session (headless core)

Today `ViewerController` holds everything: loading, selection, filters, review state, the replay
clock, preferences, and also the renderer, the camera and the framing. That second half belongs
to a view, not to the session: it is why the prototype could attach only one canvas per root.

The session is split along that line:

- **`DiffSession`** (one per root): the loaded diff and scene, selection, hover, filters, the
  search query and its hits, focus / scope, review state, replay timeline and time, theme /
  palette / locale preferences, and the events (`kgdiff-ready`, `kgdiff-select`, …). No DOM.
- **`StageView`** (one per `<kgdiff-stage>`): renderer, camera, framing, minimap, and the
  obstacles kept clear of. It reads the session and sends user intents (click a node, drag the
  divider) back to it.

One session with several views enables side-by-side before / after canvases and overview
thumbnails later, without changing the model. The boundary is fixed now; the split itself is
done in phase 3 (decision 6).

The public surface of the session is deliberately smaller than the class is today: a read-only
state snapshot, commands, and `subscribe(topics, listener)`. Internal fields stay internal.

**Scheduling.** The session's frame loop advances with animation frames only, so it pauses
where the browser pauses them (a looping replay in a background tab costs nothing) and never
draws a frame that is not presented. One-off work that must not wait forever, the loading steps
above all, races a frame against a 32 ms timer: the prototype found that a hidden embedding
container pauses `requestAnimationFrame` without the page reporting itself hidden, so loading
stalled forever. (Phase 1 first raced every frame; review kept the timer to one-off work.)

### 2. Binding: the context protocol

Components find their session with the Web Components community
[context protocol](https://github.com/webcomponents-cg/community-protocols/blob/main/proposals/context.md):

- A component dispatches a bubbling, composed `context-request`; the nearest `<kgdiff-root>`
  answers and stops it. Because the event is composed, a component inside another component's
  shadow root still reaches its root.
- Requests nobody answered wait at `document`; a root that connects later announces itself
  (`context-provider`) and the waiting requests are replayed. Definition and connection order
  do not matter.
- A component placed elsewhere on the page names its root: `for="<root id>"`.
- Frameworks may inject a session directly: the `session` property wins over `for`, which wins
  over the nearest ancestor.
- The context key is `Symbol.for('kgdiff.viewer/1')`, not an object identity, so components of
  one copy of the library find the root of another (an IIFE report bundle next to an ESM build).
  The `/1` is bumped if the provided value changes incompatibly.

Components never reference each other. Everything goes through the session (state) or the
root (keyboard, announcements, events).

### 3. Elements

| Element                  | Region                                                      | Binds to      |
| ------------------------ | ----------------------------------------------------------- | ------------- |
| `<kgdiff-root>`          | no visuals: the session, keyboard map, live region, events  | —             |
| `<kgdiff-stage>`         | the canvas: graph, tooltip, swipe divider, replay caption   | session       |
| `<kgdiff-view-dock>`     | mode (overlay / swipe / replay), Changes only, context hops | session       |
| `<kgdiff-transport>`     | replay transport and scrubber                               | session       |
| `<kgdiff-legend>`        | legend card or one-line legend                              | session       |
| `<kgdiff-zoom>`          | zoom in / out / fit                                         | nearest stage |
| `<kgdiff-minimap>`       | minimap                                                     | nearest stage |
| `<kgdiff-title>`         | brand, compared names, versions                             | session       |
| `<kgdiff-actions>`       | appearance menu, help, panel toggles                        | session       |
| `<kgdiff-change-list>`   | title, count, review progress, the change rows              | session       |
| `<kgdiff-change-detail>` | the selected change or node                                 | session       |
| `<kgdiff-search>`        | node search: a combobox with its own results list           | session       |
| `<kgdiff-filters>`       | family filter chips with their counts, "show all"           | session       |
| `<kgdiff-viewer>`        | the default layout of all of the above                      | its own root  |

`<kgdiff-zoom>` and `<kgdiff-minimap>` act on a view, so they bind to the nearest stage (a
second, view-level context the stage provides to its slotted children), or to `stage="<id>"`.

#### Granularity

A component is a region with its own reason to be placed, hidden or replaced independently.
Controls inside a region (buttons, single chips, the transport's buttons) are not components:
making them public would freeze their markup and multiply the focus and keyboard rules.

Search and the family filters are regions (decision 5): hosts put search in their own header or
command bar, and filters next to their own toolbar.

- **`<kgdiff-search>` owns its results.** The input is a combobox whose `aria-activedescendant`
  and `aria-controls` point at the results, so input and results live in one shadow root (see
  [Keyboard, focus and accessibility](#5-keyboard-focus-and-accessibility)). Standalone, the
  results open below the input as a popup. The default layout stretches that results panel
  over the change list, so it looks and behaves as today, when results take the list's place.
- **The query lives in the session.** While a search is active, `<kgdiff-change-list>` steps
  aside (hidden and inert in the default layout); the two components never reference each
  other. Choosing a hit selects its node and change through the session, as today.
- **`/` focuses the search.** Search elements register themselves with their root as the
  `search` focus target; `/` focuses the registered one (the one in the open, most recently
  registered region), or does nothing when the page has none.
- **`<kgdiff-filters>`** renders the family chips from the session's family counts and toggles
  the session's family filter. It has no references across components.

#### Stage slots and obstacles

`<kgdiff-stage>` has five named slots: `top-start`, `top-end`, `bottom-start`, `bottom-center`
and `bottom-end`. The stage positions slotted content, and every slotted element is an obstacle:
fits and flights frame the graph in the free part of the canvas, as they do today for the
built-in chrome. Content positioned some other way can register as an obstacle explicitly
(`registerObstacle(element)` on the view context). The default layout puts its own chrome in
these slots, so host content and built-in chrome follow one rule.

### 4. The default layout

`<kgdiff-viewer>` renders a root, a stage with its chrome in the slots, the change list and the
detail panel, in the layout it has today (sidebar 360 px; a bottom sheet below 760 px). Its
attributes, properties, methods and events stay.

New: one attribute for every region's state,

```html
<kgdiff-viewer panels="detail:collapsed minimap:hidden"></kgdiff-viewer>
```

with states `open`, `collapsed` and `hidden`, for `list`, `detail`, `search`, `filters`,
`dock`, `transport`, `legend`, `zoom`, `minimap`, `title` and `actions`. Regions not named keep their default. The
property form is an object: `viewer.panels = { detail: 'collapsed' }`. Collapsed regions are
`inert`. A `kgdiff-layout` event reports every change, by the user or the host.

The existing switches become presets of `panels`:

| Attribute        | Means                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `sidebar=closed` | `list:collapsed detail:collapsed search:collapsed filters:collapsed`  |
| `header=compact` | `title:hidden`                                                        |
| `chrome=none`    | everything but the stage hidden, `legend` one line, no clicks or keys |
| `legend=…`       | the legend's style, as today                                          |

The detail panel gets its own collapse control and a draggable split with the list; the sidebar
gets a draggable width. Both are remembered.

**Persistence** (decision 3). The default layout remembers the user's panel states, sizes, theme,
palette and language in `localStorage` (per origin, wrapped in try/catch, as review progress
is). Precedence:
attribute or property set by the host > remembered by the user > the report's `view` > default.
`persist="none"` turns it off. Composed elements do not persist anything on their own: the host
owns its layout.

**Reports and the CLI.** `ReportPayload.view` gains `panels`; the CLI gains `--panels`
(same syntax). Older payloads without it keep today's layout.

### 5. Keyboard, focus and accessibility

- **One keyboard map, owned by the root.** Keys pressed inside the root's subtree reach it by
  bubbling. Components bound with `for` forward their key events to the root (the prototype
  found they otherwise do nothing). Two roots on a page never act on each other's keys.
- **Configurable.** `shortcuts="scoped" | "global" | "none"` (`global-shortcuts` stays as an
  alias of `global`); `keymap` overrides or disables single keys, as data.
- **ARIA references stay inside one component.** ID references (`aria-activedescendant`,
  `aria-controls`, `aria-labelledby`) cannot cross shadow roots today. The change list keeps its
  listbox, options and search results in one shadow root, as it does now; across components
  only events and focus moves are used.
- **Landmarks.** The change list and the detail panel are labelled regions; the stage keeps
  `role="img"` with the summary label. The root owns the single polite live region that
  announces navigation ("Change 3 of 12: …").
- **Focus order is the host's DOM order.** Collapsing a region moves focus out of it first.

### 6. Theming

Tokens are set once, on the root, and inherited by every component inside it (custom properties
cross shadow roots). Components bound with `for` receive the same tokens through the context.

**CSS is the theme's single source of truth** (decision 1). Today the canvas reads colors from
the JavaScript `Theme` object and the panels from the CSS tokens derived from it; the prototype
overrode `--kg-accent` on a root and the panels turned magenta while the canvas did not.

- **Tokens.** Colors and fonts are CSS custom properties named `--kgdiff-*` (decision 2; today's
  internal `--kg-*` are renamed in phase 1, before any of them is public). Motion, sizes and
  other non-visual theme values stay in JavaScript.
- **Built-in themes are token sets.** Light, dark and the color-blind palette are token sets the
  root applies on `:host`; their contrast guarantees stay tested as today. A host overrides any
  token with ordinary CSS on the root (page styles win over `:host`), at its own responsibility
  for contrast.
- **The canvas follows the computed tokens.** The root reads `getComputedStyle(root)` and builds
  the scene / renderer theme from it when the theme preference, the palette or the system color
  scheme changes, and when the host calls `refreshTheme()` after changing tokens itself (an
  ancestor's class change cannot be observed). Reading a few dozen properties per theme change
  is negligible.

Styles move from `<style>` elements to constructable stylesheets (`adoptedStyleSheets`), parsed
once and shared by every shadow root. They are not subject to the `style-src` restrictions
strict-CSP sites put on inline `<style>`.

### 7. Packaging and size

- `@kgdiff/viewer` keeps defining `<kgdiff-viewer>` and its parts on import.
- Each element also gets a subpath (`@kgdiff/viewer/elements/stage`, …) that defines only it,
  plus `@kgdiff/viewer/session` for the headless core. ESM hosts that compose a stage and a
  transport do not ship the change list. `sideEffects` lists the defining modules.
- The standalone IIFE still contains everything; reports are unchanged.
- **Size.** The prototype's glue (protocol, root, stage with slots, list, detail, overlay) was
  3.5 kB min + gzip on top of the existing UI classes. That is an upper bound: the rebuilt
  `<kgdiff-viewer>` replaces most of today's wiring in `element.ts`. Phase 1 measures the net
  cost against the standalone budget in docs/architecture.md (105 kB today; PR #32 proposes
  130 kB) before anything is published.

### 8. API description and docs

The elements are described by a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest)
generated from the sources (a new dev dependency, justified by what follows). The attribute,
property, event, slot, part and CSS-token tables in the docs are generated from it, and a test
fails when the docs and the manifest disagree. Today's docs already drifted (`sidebar` listed
as a property in docs/interaction.md, `setReviewed()` missing from its method list); generated
reference tables end that class of error. Hand-written docs become recipes: replay only,
detail collapsed by default, list in the host's sidebar, theming with CSS, React 19 / Vue /
Svelte usage.

## Compatibility

- `<kgdiff-viewer>`: no removed or changed attribute, property, method or event. Existing
  switches are presets of `panels`.
- HTML reports: same payload format (plus the optional `view.panels`); old reports open as
  before.
- New elements ship marked experimental for one minor version, then become stable.
- CSS tokens become public API when they are documented; they are renamed `--kgdiff-*` while
  still internal (decision 2), so no public rename happens later.

## Testing

- Unit (happy-dom): context binding in every topology (child, nested shadow root, `for`, late
  root, two roots), slot obstacle registration, panel states and presets, persistence
  precedence, keyboard forwarding, the `search` focus target, the list stepping aside while a
  search is active.
- Parity: the existing viewer test suite runs unchanged against the rebuilt `<kgdiff-viewer>`.
- Browser: obstacle avoidance measured as in the [prototype](#prototype-results) (nodes under
  slotted content after fits and flights); keyboard and live-region checks; a11y snapshots of each region.
- Size: the standalone budget test, plus per-subpath size reports.

## Rollout

1. **Session and wiring.** Extract `DiffSession` behind the current controller API (the search
   query moves into it); frame / timer scheduling; constructable stylesheets; tokens renamed
   `--kgdiff-*`; the canvas theme built from computed tokens. Rebuild `<kgdiff-viewer>` on
   `<kgdiff-root>` + stage + list + detail + search + filters internally. No new public API;
   parity tests and the size budget gate it.
2. **First public elements** (experimental): `<kgdiff-root>`, `<kgdiff-stage>` with slots,
   `<kgdiff-change-list>`, `<kgdiff-change-detail>`, `<kgdiff-search>`, `<kgdiff-filters>`;
   `panels`, persistence, `--panels`, `refreshTheme()`; recipes.
3. **View split and chrome elements:** `StageView`; dock, transport, legend, zoom, minimap,
   title and actions as elements; a side-by-side before / after recipe.
4. **Stable:** experimental marks removed, manifest-generated reference docs, framework recipes.

Viewer bundle-size work (PR #32) is coordinated with phase 1: it is the phase that adds or
removes the most bytes.

## Prototype results

Measured in the browser on `examples/datasets/enterprise-kg` (75 nodes, 12 changes), three
layouts on one page: (A) list on the left inside another component's shadow root, host card in
the stage's `top-end` slot, detail in its own column collapsed by default; (B) replay only;
(C) B's list elsewhere on the page via `for`.

| Risk / question                  | Result                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Binding across shadow roots      | All components bound: plain child, nested shadow root, `for`; roots defined 300 ms late                      |
| Two roots on one page            | Independent: selection, keys and announcements never crossed                                                 |
| Context across library copies    | A request with another object but the same `Symbol.for` key reached the same session                         |
| Focus and listbox semantics      | Focus reaches the listbox through two shadow roots; `aria-activedescendant` resolves                         |
| Keyboard inside a root           | `j` selects the next change, the canvas follows, the root announces "第 2 项变更，共 12 项…"                 |
| Keyboard from a `for` component  | Did nothing until keys were forwarded to the root; then `j j k` → 0, 1, 0                                    |
| Host card over the canvas (slot) | Positioned by the stage (12 px from the corner, no host CSS); nodes under it: 0 of 75, 9 when not registered |
| Larger host card (450 × 320)     | Nodes under it: 0 of 75 registered, 31 not registered; 12 flights: 0 changed nodes under                     |
| Detail separate, collapsed       | Updated while collapsed; opening it (340 px) shrank the canvas and refit it                                  |
| Theme tokens                     | Inherited from the root; overriding `--kg-accent` changed the panels but not the canvas                      |
| Hidden container                 | Loading stalled (no animation frames); a frame / timer race fixed it                                         |
| Glue size                        | 3.5 kB min + gzip (upper bound)                                                                              |

The prototype reused the existing `Stage`, `Sidebar` and `Detail` classes unchanged: they only
depend on a `UiContext`, which confirms that the UI is already cut along region lines.

Not prototyped: search and filters as elements of their own (decided after the prototype,
decision 5). Their risk is the combobox semantics, which the design keeps inside one component;
phase 2's unit and a11y tests cover them.

## Alternatives considered

- **More switches on one element** (a `panels` attribute only). Cheap and part of this design,
  but it cannot put a region into the host's layout, and the switch list keeps growing.
- **Framework components first.** Serves one framework and leaves the others; custom elements
  work in all of them (React 19 supports their properties and events natively).
- **Lit.** A good base, but the viewer needs a small fraction of it, the budget is tight, and new
  runtime dependencies need a strong reason. The protocol needs about 1 kB of our own code.
- **Slots-only customization of one element.** Lets hosts add content, not move or remove
  regions. Kept for the stage (its slots) and the default layout.
- **Embedding in an iframe.** Isolation without composition, with worse accessibility and sizing.

## Decisions

Recorded 2026-11-06 by the maintainer.

1. **Theme source of truth: CSS.** Colors and fonts are CSS tokens; the canvas follows the
   computed tokens ([Theming](#6-theming)).
2. **Token names: `--kgdiff-*`,** renamed in phase 1 while still internal.
3. **Persistence: on in the default layout, off in composed elements.**
4. **Element names: `kgdiff-change-list` and `kgdiff-change-detail`.**
5. **Search and filters are elements in v1:** `<kgdiff-search>` (owning its results) and
   `<kgdiff-filters>` ([Granularity](#granularity)).
6. **`StageView` is split in phase 3,** after the first public elements prove the protocol; the
   session / view boundary is respected from phase 1 on.

## Risks

| Risk                                         | Mitigation                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| A much larger public API to keep stable      | Region granularity only; experimental for a minor; manifest-checked docs    |
| Behaviour drift in the default layout        | Phase 1 rebuilds it with no new API; the existing tests are the parity gate |
| Bundle growth past the ceiling               | Measured in phase 1 before publishing; subpaths keep ESM hosts lean         |
| Accessibility regressions across components  | ARIA references within a component; root-owned live region; a11y snapshots  |
| Theming inconsistencies (canvas vs panels)   | CSS is the single source of truth (decision 1); the canvas reads the tokens |
| Search split breaking the combobox semantics | Results stay inside `<kgdiff-search>`; the list steps aside via the session |

## Phase 2 results

Phase 2 shipped `panels`, persistence, `--panels`, `refreshTheme()` and the first public
elements, marked experimental. Where it departs from the design above, or decides what the
design left open:

- **The default layout renders the region classes in its own shadow root**, as in phase 1,
  not nested public elements. Its DOM, its tests (the parity gate) and its single stylesheet
  stay as they are; the public elements wrap the same classes in shadow roots of their own.
  So `<kgdiff-viewer>` exposes no stage slots yet: left open.
- **`<kgdiff-stage>` brings its canvas chrome along** (view dock, transport, legend, zoom,
  minimap; not the title or actions) until those become elements in phase 3. Slotted content
  stacks further from the corner than the chrome there, and stays shown while a diff loads.
  Until `StageView` is split, a root draws one stage; a second stays empty, with a warning.
  The stage's `panels` (its regions `dock`, `transport`, `legend`, `zoom`, `minimap`, in the
  default layout's syntax) opens, collapses or hides that chrome. Phase 3 continues from it: a
  chrome element slotted into the stage (`<kgdiff-transport slot="bottom-center">`) replaces
  the built-in one, and `panels` keeps applying to the built-in chrome a page keeps.
- **What `collapsed` means, per region.** The list folds to its title row, the detail panel to
  a new "Change details" bar, the search and the filters to buttons in the list's title row,
  the legend to its head; the sidebar (and the bottom sheet) folds away when all four of its
  regions are collapsed. Regions without a fold of their own (dock, transport, zoom, minimap,
  title, actions) are not shown while collapsed. The legend's default is `collapsed`, as the
  card always started folded.
- **Precedence has one more level on top: what the user did in this page.** The order is the
  user in this page > the host (`panels`, then the presets) > remembered > the report's
  `view.panels` > default; the host restating a region replaces the user's change there.
  `sidebar="open"` is a preset too (the four regions open), so a host that says open wins over
  a remembered fold. `panels` wins over the presets for the regions it names.
- **`panels` is the page's declaration, both ways.** The property reads back what the page
  declared, as the attribute does; the resolved states and sizes are a read-only `layout`
  (what `kgdiff-layout` reports, without `source`). Declaring the same panels again, as React
  and Vue do on every render, keeps what the user did: only a region whose declared (or
  preset) value changed gives way.
- **Persistence** is one `localStorage` entry, `kgdiff:viewer` unless `persist-key` names
  another (apps sharing an origin, such as a GitHub Pages user site, each take their own): panel states the
  user changed, the sidebar width, the list / detail split, theme, palette, language. Writes
  merge with what other viewers of the origin wrote. `kgdiff-layout` carries
  `{ panels, sidebarWidth, detailShare, source }`, with `source` `user` or `host`, and is not
  fired for the first states.
- **Reports no longer write `theme` and `locale` as attributes** of their `<kgdiff-viewer>`:
  an attribute is the host's and outranked what the reader chose before, so a remembered theme
  never applied in a report. They travel in `view`, and the viewer applies a payload's theme,
  palette and language as soon as the payload is set. A gzip-encoded (large) report with an
  explicit `--theme` that differs from the system's may show the system theme until the
  payload is decoded.
- **Keyboard.** `keymap` names 22 shortcuts (`next`, `zoom-in`, `left`, …; `left` / `right`
  step in replay and move the divider in swipe); the help dialog still lists the default keys
  (left open). With `shortcuts="none"` a focused change list keeps ↑ / ↓, Home / End and Enter,
  its listbox keys. A key inside nested roots acts on the nearest one.
- **Tokens for `for=` elements.** An element outside its root's subtree adopts the root's
  built-in token set; page overrides set on the root do not reach it.
- **`@kgdiff/viewer/session`** exports `DiffSession`, `createSession` (browser clock, frames,
  storage) and the topics, as experimental. The read-only snapshot / commands / `subscribe`
  surface of §1 is not done yet; the `session` property that lets frameworks inject a session
  into elements is not either. Both are left open.
- **Not done in phase 2:** a11y snapshots of each region (the Testing section) and the Custom
  Elements Manifest (phase 4).

Measured in Chrome (the desktop app's browser pane) on `examples/datasets/enterprise-kg`
(75 nodes, 12 changes) with the dev harness's new `/components/` page, three layouts on one
page as in the prototype:

| Check                                  | Result                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Host card in `top-end` (246 × 39)      | Nodes under it after a fit: 0 of 75                                                      |
| Larger card (450 × 320)                | 0 of 75 registered (slotted), 53 when taken out of the slot                              |
| 12 flights, both card sizes            | 0 of the flown change's nodes under the card                                             |
| Keys from a `for` list (B's list in C) | `j j` selected B's change 2, B's live region announced it, A did not move                |
| `/` and choosing a result              | `/` focused the search bound to that root; Enter selected the node and focused the list  |
| Default layout                         | Detail bar folds and opens; ← / → on the sidebar edge and ↑ / ↓ on the split; remembered |
| Reload with a remembered width         | Opens at it (a first version animated from 360 px: fixed)                                |

Size (`kgdiff-viewer.js`, min + gzip, local zlib): 105.54 kB after phase 1, 112.62 kB after
phase 2 (ceiling 130 kB): panel states, presets, splitters and persistence +4.2 kB, the
elements, keyboard configuration and slots +2.5 kB. Each subpath bundled on its own (min +
gzip): root 88.0 kB (the session and the canvas), stage 17.4, change-list 13.1, change-detail
16.4, search 11.8, filters 10.1, session 49.6; the elements other than root leave the session
out. `@kgdiff/viewer/panels` (0.6 kB) is the panels syntax without DOM, which the CLI's
`--panels` reads with too. After review fixes the standalone bundle is 112.77 kB.
