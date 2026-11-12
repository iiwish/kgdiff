# @kgdiff/cli

## 0.11.1

No changes in this release.

## 0.11.0

### Minor Changes

- 3024eb1: Rust crates: a compact graph in `kgdiff-core`, read through methods, and two more ways to build
  one. Breaking for Rust callers; no output changes by a byte.
  - **Memory.** `normalize` of 100k nodes and 300k edges now adds 42 MiB of resident memory
    instead of 150 MiB (RFC 0002 §7: under 50 MB), and the graph retains 23 MB of heap instead of
    100 MB. Edges are rows of positions into the nodes and into one table of predicates and labels;
    their structural keys are written when asked for. Nodes keep what few of them have
    (aliases, `replaces`, `replacedBy`, a position) apart.
  - **`normalize_input`** builds the graph from Rust values (`GraphInput`, `NodeInput`,
    `EdgeInput`, the members of `graph.v1.json`; attribute values stay `js::Value`) — the graph
    `normalize(&input.to_value(), …)` gives, with the same `graph_to_json` bytes, hash and issues,
    checked on every graph of the conformance corpus (RFC 0003, part 3).
  - **`normalize_json`** builds it from JSON text, element by element, without a tree of the whole
    document.
  - **Breaking: `KGraph`, `KGNode` and `KGEdge` have no public fields.** Read them through methods:
    `graph.nodes()`, `node(id)`, `node_at(i)`, `node_index(id)`, `contains_node(id)`,
    `node_count()`, `edges()` (`EdgeRef`s), `edge(key)`, `edge_at(i)`, `edge_index(key)`,
    `contains_edge(key)`, `edge_count()`, `meta()`, `edge_identity()`, `issues()`; `node.id()`,
    `label()`, `types()`, `aliases()`, `attrs()`, `is_deprecated()`, `replaces()`, `replaced_by()`,
    `is_implicit()`, `position()`; `edge.key()`, `id()`, `source()`, `target()`, `predicate()`,
    `label()`, `attrs()`, and `EdgeRef::to_edge()` for an edge on its own. `outgoing` and
    `incoming` yield `EdgeRef`s instead of `&Arc<KGEdge>`. A `KGNode` or `KGEdge` can no longer be
    built field by field: build graphs with `normalize_input`.

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
- 9168d34: Deltas now carry the changes of ignored attributes. Breaking before 1.0.

  With `ignoreAttrs` (`--ignore-attr`), those changes used to be left out of the delta while its
  target hash covered every attribute, so applying the delta could not reach the target and
  `kgdiff apply` warned that the result differed. Now `applyDelta(A, diff(A, B).delta)` hashes to
  `hashGraph(B)`, and the inverse restores `A`, whatever is ignored.

  "Ignored" now means what the diff matches on and shows, and nothing else: ignored attributes
  take no part in similarity, and their changes produce no facet, status, count or summary line.

  If you read deltas made with `--ignore-attr`: they have more ops than before, at the head of the
  delta and in no hunk, and a diff that reports no change can have a non-empty delta, as already
  happened for id-only renames under `similarity`. Hunk contents are unchanged, but their `ops`
  indices shift by the number of these ops. Deltas made by earlier versions still apply, with the
  same warning as before. The delta and diff document versions do not change.

## 0.9.0

### Minor Changes

- 3ae8f98: The Rust crate `kgdiff-layout` carries a layout from one version of a graph to the next through their diff: `layout_diff_on(&diff, &previous, &options)` lays the diff out on the previous version's map, and `layout_after(&diff, &layout, &options)` gives the after version the positions of its diff without computing any (RFC 0003, part 1). Every node the previous layout places stays exactly where it is, whether it continues or was removed and under whatever id it has now, and only the new nodes are placed, clear of the removed ones; going from a version to the next one, and from either to their diff, moves no node. Laying the next version out with `layout_graph` and the previous positions as pins gives that only when no id changes: a node that continues under another id is placed again, and an id given to another node pins that node where the old one was. Both functions are held to the `kgdiff.layout` bytes of the same pins written by hand on every case of the conformance corpus. A pin of the caller wins over the previous layout; scope `Changes` and strategy `Union` are `invalid-input`, and so is, for `layout_after`, a layout that does not place every node of the after version. The functions are experimental for one minor release, and `@kgdiff/layout` has no counterpart. The embedding guide and its example (`crates/kgdiff-report/examples/embedding.rs`) now use them.
- 0a52a4d: The Rust crate `kgdiff-layout` lays out one graph: `layout_graph(&graph, &options)` gives the positions `layout_diff` gives the diff of that graph with itself, with every node in scope whatever the size of the graph, so an application that shows a graph and then a diff of it moves no node between the two (RFC 0003, part 1). The two are held to the same `kgdiff.layout` bytes on both graphs of every case of the conformance corpus. Known positions, as pins or as `position` on the nodes, are kept exactly and only the other nodes are placed, which is how the next version of a graph keeps the previous version's map; scope `Changes` is `invalid-input`. The function is experimental for one minor release. `@kgdiff/layout` has no counterpart: `@kgdiff/compute` will export it with the rest of the layout (RFC 0002, phase 5).

## 0.8.0

### Minor Changes

- c3e8a63: `@kgdiff/cli` runs the native kgdiff, written in Rust (RFC 0002, phase 4), instead of the TypeScript CLI, which is removed. It prints the same bytes for the same arguments (every run of the conformance corpus is checked on Linux, macOS and Windows). The package is now a small launcher: npm installs the binary of your platform with it as an optional dependency (`@kgdiff/cli-darwin-arm64`, `-darwin-x64`, `-linux-x64-gnu`, `-linux-x64-musl`, `-linux-arm64-gnu`, `-linux-arm64-musl` or `-win32-x64`; Windows on Arm runs the x64 build), so an install with `--omit=optional` has no binary to run and says so, and `KGDIFF_BINARY` points the launcher at another one. The same kgdiff is on crates.io (`cargo install kgdiff`). Breaking: the package no longer exports a JavaScript API (`main`, `renderSummary`, `renderMarkdown`, `buildReportHtml`, …); diff in JavaScript with `@kgdiff/core` and `@kgdiff/formats`, and in Rust with the `kgdiff` and `kgdiff-report` crates. The bug report link of an unexpected error names the platform and architecture, no longer a Node.js version.

### Patch Changes

- 1182f6a: The GitHub Action runs the native kgdiff directly. From 0.8.0 on, it resolves its `version` input on npm, downloads the platform package of that version for the runner with `npm pack`, checks it against the integrity the npm registry publishes, and runs its binary for every file, with no npm process per comparison. Versions before 0.8.0 still run with `npx`. `KGDIFF_BINARY` in the step's environment runs another binary instead.

## 0.7.0

### Minor Changes

- cca58f9: JSON input with a lone surrogate escape is rejected. `JSON.parse` accepts `"\ud800"`, half of a UTF-16 surrogate pair escaped without its other half, and kgdiff used to carry it through ids and labels into its diffs and deltas; such text is not Unicode, and the Rust implementation (RFC 0002) cannot hold it. `parseGraph` now throws `invalid-input` for one in JSON and JSON-LD, located at the escape (`Invalid JSON on line 6, column 35: the escape \ud83d is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept.`), and so does a JSON-LD context text a `documentLoader` returns; `kgdiff apply` refuses a delta that has one. Escaped surrogate pairs (`"😀"`) read as before.

### Patch Changes

- Updated dependencies [d01c4e0]
- Updated dependencies [cca58f9]
- Updated dependencies [cca58f9]
- Updated dependencies [9ebb278]
- Updated dependencies [7586808]
- Updated dependencies [e510258]
  - @kgdiff/core@0.7.0
  - @kgdiff/formats@0.7.0
  - @kgdiff/layout@0.7.0
  - @kgdiff/viewer@0.7.0
  - @kgdiff/scene@0.7.0

## 0.6.0

### Minor Changes

- 325afea: The viewer's layout can be arranged, and its parts placed one by one. Every region of `<kgdiff-viewer>` (the change list, the detail panel, the search, the filters, the view dock, the replay transport, the legend, the zoom buttons, the minimap, the title, the actions) is open, collapsed or hidden through one attribute, `panels="detail:collapsed minimap:hidden"`, or the property `viewer.panels = { detail: 'collapsed' }` (reading it gives the page's declaration back; the new read-only `viewer.layout` has every region's state and the sizes); `sidebar="closed"`, `header="compact"` and `chrome="none"` keep working as presets of it. The detail panel can now be collapsed to a bar of its own, the sidebar's width and the split between the change list and the details can be dragged (or moved with the arrow keys), and `kgdiff-layout` reports every change. The viewer remembers what the reader changes (panels, sizes, theme, palette, language) in `localStorage` for the next visit, unless the page sets them or `persist="none"`; `persist-key` gives an app on a shared origin a store of its own. `shortcuts="scoped|global|none"` says where keyboard shortcuts apply (`global-shortcuts` still works) and `keymap="x:none r:review"` rebinds single keys (a letter in both cases, so Shift+J / K now step through the changes too); the `kgdiff-*` events are typed on every element, the document and the window (`KgdiffEventMap`; `KgdiffViewerEventMap` stays as a deprecated alias); `refreshTheme()` redraws the canvas after the page changed `--kgdiff-*` tokens, which are now documented, public CSS custom properties. Four of them are renamed to whole words before they become public: `--kgdiff-bg` → `--kgdiff-background`, `--kgdiff-mono` → `--kgdiff-font-mono`, `--kgdiff-text-2` → `--kgdiff-text-secondary` and `--kgdiff-text-3` → `--kgdiff-text-muted`; a page that set the old names sets the new ones instead. New, experimental elements compose a layout of your own: `<kgdiff-root>` holds the session, and `<kgdiff-stage>` (with five slots for your content over the canvas, which the graph is framed clear of, and `panels` for its own chrome: dock, transport, legend, zoom, minimap), `<kgdiff-change-list>`, `<kgdiff-change-detail>`, `<kgdiff-search>` and `<kgdiff-filters>` show its parts, inside it or anywhere on the page with `for="<root id>"`. `@kgdiff/viewer/elements/<name>` defines a single element, and `@kgdiff/viewer/panels` is the panels syntax (no DOM). The CLI's `--panels` sets a report's initial panel states; reports now carry their theme and language in the payload only, so a reader's earlier choice wins over them.

### Patch Changes

- Updated dependencies [325afea]
- Updated dependencies [8b0538c]
- Updated dependencies [69a0975]
  - @kgdiff/viewer@0.6.0
  - @kgdiff/core@0.6.0
  - @kgdiff/formats@0.6.0
  - @kgdiff/layout@0.6.0
  - @kgdiff/scene@0.6.0

## 0.5.0

### Minor Changes

- 764535e: The terminal summary and the Markdown summary (so the GitHub Action's pull request comment too) list the possible matches: pairings kgdiff considered but did not apply, between a node listed as removed and one listed as added. Until now only the viewer's detail panel showed them, so "removed “Saudi Aramco”, added “Aramco”" gave no hint that the two may be one entity. Each line names both nodes (with their ids when the names are equal), the score, why it was not applied (below `--threshold`, or too close to another candidate) and the label and neighbourhood evidence, and a closing line says how to pair one: a synonym, a replacement link or a lower threshold. At most 10 in the terminal (all with `--limit 0`) and 20 in Markdown; `--json` keeps every suggestion.
- 3f6e7d8: Changes to definitions are flagged ⚑ for review first. A reworded definition can change what existing data means while the diff looks small, and it used to be folded into `~1 attribute` among the other edits. Now a line under the diffstat bar counts the hunks that change one (`⚑ Review first: definition changed in 9 hunks`, also in `--stat`), each of their rows says so before its summary (`content · ⚑ definition · ~2 attributes`), and the Markdown summary, so the GitHub Action's pull request comment too, lists them in a ⚑ _Review first_ block before the phase groups. By default kgdiff watches `def` (OBO), `definition` (kgdiff JSON), `IAO:0000115` and `skos:definition`; the new `--watch-attr <key>` (repeatable) replaces that list, e.g. `--watch-attr rdfs:comment` for schema.org-style vocabularies. `TextContext` and `MarkdownOptions` take the same list as `watch`, and `DEFAULT_WATCH_ATTRS` and `watchedChanges` are exported.
- 6ed2b9c: HTML reports are smaller: they embed the diff packed (`packDiffJSON`, format `kgdiff.diff.packed`, schema `schema/diff-packed.v1.json`), with its unchanged elements, which are most of a large diff, stored as tables of indices into one string table. For 100k nodes / 300k edges the embedded diff goes from 68.7 MB to 19.3 MB, 6.8 MB to 3.2 MB gzipped, and the report opens as fast. `unpackDiffJSON` gives the `DiffJSON` back byte for byte; the viewer reads packed and unpacked payloads (`ReportPayload.diff` is either), so older reports still open. The standalone viewer bundle budget goes from 100 kB to 105 kB (min + gzip) for the unpacking and the consistency checks of `diffFromJSON`.

### Patch Changes

- 86f4583: The bug report link of an unexpected error takes the platform and the Node.js version from `CliIO.runtime` instead of reading `process` in `main`, so `main` keeps taking every side effect from `io` and runs in hosts other than Node.js. `nodeIO()` fills it in, so the link is unchanged for the `kgdiff` command; a custom `io` without `runtime` gets a link that names only the CLI version.
- 088671c: Link unexpected CLI errors to a bug-report form prefilled with public version and runtime
  metadata, without including error messages or input paths in the URL.
- f02bc72: Similarity matching no longer pairs two same-named nodes on their label alone when their types conflict. With `--match similarity` nothing is matched in the first round, so the neighbour evidence was missing for every pair and an equal label outweighed disjoint types: “Mercury” the planet (orbiting the Sun) and “Mercury” the element (with symbol Hg) were reported as one node whose type changed. Such a pair (both nodes typed, no type and no attribute in common, neighbours not matched yet) now waits for the next round, when propagation brings in the neighbours; the two Mercurys share none, so they are reported as removed and added with a possible match below the threshold, as `--match auto` already did. A type change that the neighbours confirm is still matched, and nodes without edges are matched as before.
- Updated dependencies [638c617]
- Updated dependencies [f957a49]
- Updated dependencies [ed1c3c9]
- Updated dependencies [212c48c]
- Updated dependencies [f02bc72]
- Updated dependencies [6ed2b9c]
- Updated dependencies [6d34966]
- Updated dependencies [5286e02]
  - @kgdiff/core@0.5.0
  - @kgdiff/viewer@0.5.0
  - @kgdiff/formats@0.5.0
  - @kgdiff/layout@0.5.0
  - @kgdiff/scene@0.5.0

## 0.4.0

### Minor Changes

- 86fe0da: Changes only is now a scope that combines with any mode instead of a fourth mode: `mode` is `overlay | swipe | replay` and the new `scope` (`all | changes`) shows only the changes, in overlay, swipe or replay alike. `mode="changes"` still works (overlay + `scope="changes"`), as do old `#kgdiff=…;mode:changes` links; `kgdiff-mode` reports `{ mode, scope }`. The CLI gains `--scope` (`--mode changes` keeps working).

  The canvas loses its header bar: the title floats top left, the actions top right, and the modes, the Changes only toggle with its context hops, and replay's transport live in one dock at the bottom. The diffstat pills (the sidebar's filter chips show the same counts) and the second fit button are gone, the chips wear the legend's swatches, the legend starts collapsed and the minimap appears only while part of the graph is out of view. Unchanged node labels use the muted text color, so the changes stand out.

### Patch Changes

- Updated dependencies [86fe0da]
  - @kgdiff/viewer@0.4.0
  - @kgdiff/scene@0.4.0
  - @kgdiff/core@0.4.0
  - @kgdiff/formats@0.4.0
  - @kgdiff/layout@0.4.0

## 0.3.0

### Patch Changes

- 148fdb1: The viewer embeds as a small looping replay: `<kgdiff-viewer mode="replay" chrome="none" loop>`. `chrome="none"` shows the graph alone, with its hover tooltip and a one-line legend (`legend="auto|full|mini|none"`), no header, change list, step caption, playback bar, zoom buttons or minimap; it fits a 320px strip (the minimum height drops to 120px) and keeps the view fitted. `loop` plays the replay by itself and starts it again after `loop-delay` ms (1200), pausing while the mouse is over the graph unless `pause-on-hover="false"`. A new `kgdiff-replay-end` event fires whenever playback reaches the end. Fitting leaves room for node labels, so the names of the outermost nodes are no longer cut off at the edge of the canvas, and `fit()` takes `{ padding }`; without chrome, a label pushed aside by a neighbour stays inside the canvas or is left out. `@kgdiff/renderer` adds `labelFootprint(frame, theme)`, what a frame covers with its labels at a given zoom, and `setLabelsInside()` / the `labelsInside` option, which keep labels whole inside the canvas.
- Updated dependencies [148fdb1]
  - @kgdiff/viewer@0.3.0
  - @kgdiff/core@0.3.0
  - @kgdiff/formats@0.3.0
  - @kgdiff/layout@0.3.0
  - @kgdiff/scene@0.3.0

## 0.2.0

### Minor Changes

- 0330630: kgdiff JSON names its format like diffs and deltas do: `graphToJSON` and `kgdiff apply` write `"format": "kgdiff.graph", "version": 1` first. Files without the marker are still read by their shape. With it, a file is read as kgdiff JSON without guessing, a newer version is refused, and so is a diff or a delta given where a graph is expected, with a message that says what the file is. JSON Schemas for graphs, diffs and deltas ship with `@kgdiff/core` (`@kgdiff/core/schema/graph.v1.json`, `diff.v1.json`, `delta.v1.json`), and tests validate everything kgdiff writes against them.

### Patch Changes

- d88fc85: The detail panel (and the HTML report) leads with what changed: one row per changed facet, before → after. A lone removed and added synonym, type or parent reads as one edit (`老赖 → 失信人`), similar ones pair up, and unchanged attributes fold behind a toggle. Added and removed nodes now show their synonyms.
- Updated dependencies [d88fc85]
- Updated dependencies [0330630]
  - @kgdiff/viewer@0.2.0
  - @kgdiff/core@0.2.0
  - @kgdiff/formats@0.2.0
  - @kgdiff/layout@0.2.0
  - @kgdiff/scene@0.2.0

## 0.1.0

Initial release.
