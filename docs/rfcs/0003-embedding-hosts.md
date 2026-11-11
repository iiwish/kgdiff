# RFC 0003: Embedding hosts and the plain view

- **Status:** Draft, proposed. The parts planned for 0.9 are merged and released as 0.9.0:
  part 1, `layout_graph` ([#78](https://github.com/iiwish/kgdiff/pull/78), 0a52a4d), and
  with it `layout_diff_on` and `layout_after`, which carry a layout to the next version
  through the diff ([#86](https://github.com/iiwish/kgdiff/pull/86), 3ae8f98); part 2, reports with
  the caller's layout and `report.v1.json`
  ([#79](https://github.com/iiwish/kgdiff/pull/79), 6c3a764); part 4a, renderer layers
  ([#80](https://github.com/iiwish/kgdiff/pull/80), d3e1dac). See [0.9 results](#09-results).
  Of the [open decisions](#open-decisions), D-2, D-8 and D-9 are taken with those merges. Part
  4b is implemented for 0.10, with D-3 and D-4 taken: see [4b results](#4b-results). The other
  decisions, and parts 3, 4c and 4d, are not decided or started.
- **Date:** 2026-11-10; 0.9 results the same day; 4b results 2026-11-11.
- **Affects:** `kgdiff-layout`, `kgdiff-report` and `kgdiff-core` (API additions),
  `@kgdiff/renderer`, `@kgdiff/scene`, `@kgdiff/g6` and `@kgdiff/viewer` (additions),
  `docs/visual-language.md` (two new rules), the report payload (a schema, optional members).
  No document changes its version. The layout engine changes only in part 4d, after 1.0.

## Summary

The first application that embeds kgdiff's crates (an ontology editor: Rust on the server, the
scene and the renderer in its web pages) checked what it needs against 0.8.0 and found four
gaps. Each has a workaround, so none blocks it; each will be met again by the next host. This
RFC says which to close, how, and when, around the work that is already planned
([RFC 0002](./0002-rust-compute-core.md), phase 5, kgdiff 1.0):

| Part | What                                                         | Release       | Size   |
| ---- | ------------------------------------------------------------ | ------------- | ------ |
| 1    | `layout_graph`: the layout of one graph                      | 0.9           | small  |
| 2    | Reports that carry the caller's layout; `report.v1.json`     | 0.9           | small  |
| 4a   | Renderer layers: the host draws under and over the graph     | 0.9           | small  |
| 4b   | Node shapes by type                                          | 0.10          | medium |
| 4c   | The plain view: one graph, colored by the host's categories  | 0.10 or later | medium |
| 3    | Typed graph input                                            | 1.0           | medium |
| 4d   | Groups: backgrounds and a layout that keeps a group together | after 1.0     | large  |

Parts 1 to 3 are embedding API and change nothing kgdiff writes. Part 4 is the one that touches
what kgdiff is, so this RFC first states a rule for it ([Positioning](#positioning)): kgdiff
draws a graph for the sake of its changes, and the plain view is that same map with nothing
changed on it yet — not a general graph visualization.

## Motivation

RFC 0002 gave "applications that embed kgdiff want it as a library, in Rust" as a reason for
the port, and named an ontology editor as the example. The first such host exists now. It
shows four pictures on kgdiff's layout, scene and renderer: the ontology itself, a coverage
map, the change graph of every edit, and a small graph of the concepts one question used. Its
design depends on one promise of kgdiff's: **one mental map**. Going from "the ontology" to
"what changed" must not move a node.

What it found, checked against the 0.8.0 sources for this RFC:

1. **A layout needs a diff.** `LayoutInput` is `UnionNode`s and `UnionEdge`s
   (`crates/kgdiff-layout/src/lib.rs`). To lay out one graph, the host diffs it with itself
   and has to know to force the scope to `All`: above `large_graph_threshold` (3,000 nodes)
   the default scope is `Changes`, and a diff without changes has nothing in that scope.
2. **A report computes its own layout.** `report_payload` calls
   `layout_diff(diff, &LayoutOptions::default())` (`crates/kgdiff-report/src/html.rs`). A
   host that has a layout — cached, or computed with other options — must assemble the
   payload itself: `format`, `version`, the packed diff, `meta`, `view`. That copies a
   versioned document's shape into the host, where it will drift. `kgdiff.report` has no JSON
   Schema either: RFC 0002 (§2) planned `report.v1.json`, and `packages/core/schema/` has
   none.
3. **A graph is built as JSON.** `normalize` takes a `js::Value`; `KGraph` has private
   members (its adjacency, its cached hash), so nothing outside the crate can construct one.
   A Rust host builds kgdiff's JSON value by hand and has it read back.
4. **The scene draws diffs only.** Every node is a disc; color is the change family; there
   are no groups. An ontology graph wants kinds told apart by shape (concept, metric, rule),
   nodes colored by business domain, and a background behind each domain. The renderer paints
   its canvas from an opaque background up in one pass (`paint.ts`, `drawBackground`), so a
   host cannot put anything of its own between the background and the edges; it can only
   stack a second canvas on top and follow the `camera` event.

Measured while checking (2): with default options the layout is already anchored when nodes
carry a `position`, so a report made from two graphs whose nodes have positions keeps them. A
five-node pair with positions on four nodes came back `strategy: "anchored"`, `scope: "all"`,
the four positions unchanged and the fifth node placed. The gap in (2) is therefore the second
computation, the scope above 3,000 nodes, and layouts computed with other options — not wrong
positions in the common case. The same run shows a limit to document: `LayoutResult` keeps a
known position exactly, but the layout document rounds to 0.01 (`300.125` was written as
`300.13`). Positions read back from a layout document are on that grid and survive unchanged;
positions from elsewhere do not round-trip through a report.

## Positioning

kgdiff is "git diff for knowledge graphs", built on four ideas
([architecture.md](../architecture.md#positioning)), all about change. The visual language's
first principle is "exactly five change families plus neutral. No decorative color."
Parts 4b to 4d ask for shapes, host colors and backgrounds, which that principle seems to
forbid. The proposal is to accept them under four rules, and to write the rules into
[visual-language.md](../visual-language.md) with the first part that needs them:

1. **kgdiff draws a graph for the sake of its changes.** The plain view is one version with
   nothing changed: the map a reviewer learns before a diff is put on it, and returns to
   after. It exists so that "the graph" and "what changed in it" are one picture. A host that
   wants a graph view with no diff in sight has G6, Cytoscape.js and Sigma.js, which kgdiff
   adapts to rather than replaces.
2. **Color says one thing at a time.** In a view that shows a change, color is the change
   family, as today. Only in the plain view, where no family but neutral occurs, may color
   carry the host's categories. The two never share a frame.
3. **Shape says what kind of thing a node is, in every view.** The cues of change — the
   hollow dashed ghost, the ring, the halo, the badge, the struck name — apply to every
   shape. Hollow keeps meaning "not in this version".
4. **What only the host knows, the host draws.** Certification marks, issue counts, lineage
   bands: kgdiff gives layers to draw them on (part 4a) and no API to describe them.

## Goals

1. A host lays out one graph and gets exactly the positions its diffs will use.
2. A host hands a report the layout it already has; no host assembles a `kgdiff.report`
   payload by hand.
3. A Rust host builds a graph from typed values.
4. A host can tell node kinds apart by shape, in the plain view and in diffs.
5. A host can show one graph colored and grouped by its own categories, on the same map as
   its diffs.
6. Nothing kgdiff writes today changes: every corpus case, every layout byte, every report.
7. 1.0 (RFC 0002, phase 5) is not delayed by any of this.

## Non-goals

- A general-purpose graph visualization or a graph editor.
- Per-node style callbacks (`fill: (node) => …`). Hosts choose from closed sets — shapes,
  category slots — so that every renderer and the G6 adapter draw the same picture and the
  contrast tests keep covering all of it.
- Host-specific marks in kgdiff's API (rule 4).
- Compound layouts with nested groups, group collapsing by the host, or 3D.
- Changing what a diff view looks like without options: every default stays as it is.

## Design

### 1. The layout of one graph (0.9)

```rust
/// The layout of one graph: the positions `layout_diff` gives the diff of `graph` with
/// itself, with every node in scope.
pub fn layout_graph(graph: &KGraph, options: &LayoutOptions) -> Result<LayoutResult>;
```

- **The definition is the contract.** For every graph `g` and options `o`,
  `layout_to_json(&layout_graph(&g, &o)?)` is byte for byte
  `layout_to_json(&layout_diff(&diff_graphs(g.clone(), g.clone(), d)?, &o_all)?)`, where `d`
  is the default diff options with `g`'s edge identity and `o_all` is `o` with scope `All`.
  This equality is what "going from the graph to its diff moves nothing" rests on, so it is a
  test over both graphs of every corpus case and a property over random graphs, not prose.
- **Scope.** Always `All`. `scope: Some(Changes)` is `invalid-input` (a graph has no
  changes); `large_graph_threshold`, `context_hops` and `hub_degree` are not read.
- **Known positions** work as in `layout_diff`: a node's `position`, or `pinned`, makes the
  layout anchored; those nodes stay exactly where they are and only the others are placed.
  That is how the next version of a graph keeps the previous version's map for the nodes
  whose id is the same in both versions, and only for those: positions are known by id (for
  the others, see "The next version" below). The crate's documentation gains this as a
  tested example, with the 0.01 grid of the layout document (see [Motivation](#motivation))
  stated.
- **Implementation.** It may start as the definition, literally: diffing 10k nodes / 30k
  edges with itself costs about 30 ms natively. Building the unchanged union directly, without
  running matching, classification and delta emission, comes when a host needs it for large
  graphs; the contract test makes that change safe.
- **TypeScript.** Not added to `@kgdiff/layout`, whose engine phase 5 deletes.
  `@kgdiff/compute` exports `layoutGraph` with the rest of the layout in phase 5.

**The next version** (added once an end-to-end test had walked the chain; see
[0.9 results](#09-results)). Known positions are known by id, so `layout_graph` with the
previous positions keeps the previous version's map only for the nodes whose id is the same in
both versions. Two functions carry the map through the diff instead, which is what knows which
node continues which:

```rust
/// The layout of a diff on the map of its before version: every node `previous` places stays
/// exactly where it is, and only the other nodes are placed.
pub fn layout_diff_on<'a>(
    input: impl Into<LayoutInput<'a>>,
    previous: &LayoutResult,
    options: &LayoutOptions,
) -> Result<LayoutResult>;

/// The layout of the after version of a diff on the map of the diff: every node is where
/// `layout` has it, and nothing is computed.
pub fn layout_after(
    diff: &DiffResult,
    layout: &LayoutResult,
    options: &LayoutOptions,
) -> Result<LayoutResult>;
```

- **Through the diff, not by id.** A union node with a `before_id` takes the position the
  previous layout has for that id, under its union id, and the after version reads it back
  under its `after_id`. By id, a node that continues under another id (a `replaces` hint, a
  match by similarity) is a new node to the layout of one graph and is placed again, and an id
  given to another node pins that node where the old one was.
- **The diff first, then the after version.** The layout of the after version alone cannot see
  the removed nodes, and may place a new node on one of them. On the diff the removed nodes
  are in place and the new ones are placed clear of them; the after version then takes its
  positions from the diff.
- **Contracts.** `layout_diff_on` is `layout_diff` with scope `All` and the previous positions
  as pins keyed by union id (a pin of the caller wins); `layout_after` is `layout_graph` of
  the after version with the diff's positions as pins keyed by `after_id`. Both are tests
  against those pins written by hand, byte for byte, on every corpus case. Scope `Changes` is
  `invalid-input`, as for `layout_graph`.

### 2. Reports with the caller's layout (0.9)

```rust
/// What the report's layout is.
pub enum ReportLayout<'a> {
    /// `layout_diff` with the default options (what `report_payload` does today).
    Default,
    /// The caller's layout of this diff.
    Given(&'a LayoutResult),
    /// No layout: the viewer lays the diff out when the report opens (RFC 0002, D-5).
    None,
}

pub fn report_payload_with(
    diff: &DiffResult,
    layout: ReportLayout<'_>,
    info: &ReportInfo,
) -> Result<Value>;

pub fn build_report_html_with(
    diff: &DiffResult,
    layout: ReportLayout<'_>,
    info: &ReportInfo,
    bundles: ViewerBundles<'_>,
) -> Result<String>;
```

- `report_payload` and `build_report_html` stay, as the `Default` case; the CLI's reports do
  not change by a byte (the corpus's `report.json` checks it).
- **A given layout is checked against the diff** (`invalid-input` otherwise): every position
  belongs to a union node, and with scope `all` every union node has a position. The scene
  skips a node without a position, so an unchecked layout of another diff would open as a
  graph with silent holes.
- `needs_compute` already reads the payload: a given layout with scope `changes` inlines the
  compute add-on, a full one does not.
- **`packages/core/schema/report.v1.json`** is added, and the tests validate every payload
  the crate writes against it, as they do for the other documents. With hosts making reports
  through an API, the payload is a contract for more than the CLI.

### 3. Typed graph input (1.0)

```rust
pub struct GraphInput { pub meta: Object, pub nodes: Vec<NodeInput>, pub edges: Vec<EdgeInput> }
pub struct NodeInput { pub id: String, pub label: Option<String>, /* types, aliases, … */ }
pub struct EdgeInput { pub source: String, pub target: String, pub predicate: String, /* … */ }

pub fn normalize_input(input: GraphInput, options: NormalizeOptions) -> Result<KGraph>;
```

The members are those of `graph.v1.json`; attribute values stay `js::Value`, because their
numbers, key order and canonical form are JavaScript's (RFC 0002, §4). The contract:
`normalize_input(x)` gives the graph `normalize(&x.to_value(), …)` gives — the same
`graph_to_json` bytes, hash and issues — checked on every corpus graph.

**Why with 1.0 and not now.** The native memory gate of 1.0 (`normalize` of 100k nodes / 300k
edges under 50 MB; 150 MiB measured) is to be met by a compact graph representation: interned
ids, edges as columns. A typed input is the natural front end of that representation, and the
JSON reader can feed the same builder instead of a `Value` tree, which is also part of the
WebAssembly memory problem (the text transport holds the text, the parsed value, the graph and
the output at once). Designed now, against today's `KGraph`, the input API would be designed
twice. The workaround costs the first host little meanwhile: its export has to be writable as
kgdiff JSON anyway.

### 4a. Renderer layers (0.9)

```ts
export interface RendererLayer {
  /** `under`: after the background and grid, before everything else. `over`: after labels. */
  readonly order: 'under' | 'over';
  /** Called once per painted frame (once per side in swipe, clipped to it). */
  draw(ctx: CanvasRenderingContext2D, view: LayerView): void;
}

export interface LayerView {
  readonly camera: CameraState;
  /** The visible world rectangle. */
  readonly viewport: Rect;
  readonly pixelRatio: number;
  /** Set in swipe comparison. */
  readonly side?: 'before' | 'after';
  worldToScreen(p: Point): Point;
}

interface Renderer {
  /** Returns a function that removes the layer. */
  addLayer(layer: RendererLayer): () => void;
}
```

- The renderer saves and restores the context around each layer. A layer draws in CSS pixels
  and converts with `worldToScreen`, as the renderer's own passes do, so strokes keep their
  width under zoom.
- Layers are part of the frame: `toDataURL` includes them, and their time is in the `frame`
  event's `ms`. Without layers the paint path is what it is today.
- Layers are not picked and their text takes no part in label placement. A host hit-tests its
  own marks with `camera.screenToWorld` and the `click` event's `world`.
- **Known limit:** labels carry a halo in the canvas background color. Over a tinted
  background drawn by an `under` layer the halo shows as a faint outline; soft tints (the
  theme's `soft` tokens are about 10% alpha) keep it unnoticeable. Part 4d removes the limit
  for kgdiff's own group backgrounds.
- `<kgdiff-stage>` exposes `addLayer` as an experimental method
  ([D-8](#open-decisions)), so the change graph inside the viewer can carry the same marks.

This is the smallest part that unblocks the first host's ontology graph, and it commits kgdiff
to no semantics: until 4b to 4d ship, the host draws shapes, domain backgrounds and its own
badges on these two layers, from the positions it already has.

### 4b. Node shapes by type (0.10)

```ts
export type NodeShape = 'circle' | 'square' | 'diamond' | 'hexagon';

interface SceneOptions {
  /** Type → shape. A node takes the shape of the first entry, in this order, among its types. */
  readonly shapes?: Readonly<Record<string, NodeShape>>;
}

interface NodeVisual {
  /** Absent means `circle`. */
  shape?: NodeShape;
}
```

- **Which version's types.** The after version's; the before version's for a removed node. A
  change of type does not animate the shape during replay ([D-4](#open-decisions)).
- **The layout does not change.** Every shape fits in the square of half side `r` around the
  node's center, which is the box the layout already reserves (`box_half_width ≥ r`, top
  `−r`). Positions, `generator` and every stored layout stay valid.
- **Every change cue follows the shape:** the ghost's dashes are spaced evenly along the
  shape's outline (as `evenCircleDash` does for a disc), the concentric ring and the light
  theme's offset ring are the outline grown by their gap, the pulse grows the outline. Edges
  stop at the outline. The dark theme's glow stays radial.
- **Renderer:** the node buckets are keyed by shape as well, so batching holds; picking tests
  the point against the shape instead of the distance; below `NODE_TINY_R` every node is
  already a square. The minimap keeps dots.
- **G6 adapter:** `kgdiff-node` extends G6's `circle`; it gains the three other outlines. On
  G6's built-in node types the member is ignored and the node is a circle, as the halo
  degrades today.
- **Reports and the viewer:** the payload's `view` gains an optional `shapes` member with the
  same shape, so `<kgdiff-viewer>` and HTML reports draw it; `ReportInfo` gains the field.
  The legend lists the shapes in use with their type names.
- **Hollow is not a shape** (rule 3, [D-3](#open-decisions)): a host that wants one kind
  drawn as a ring picks another shape.
- **Budgets:** `resolve` stays under 4 ms for 5k nodes / 10k edges without steady-state
  allocations (one more member, no object), and pan / zoom at 60 fps; the benchmarks run with
  a scene that uses all four shapes.

### 4c. The plain view (0.10 or after 1.0)

A plain view is the scene of a diff without changes (`stats.identical`), which a host gets by
diffing a graph with itself. No new input type: `buildScene`, the report payload and the
viewer's payload reader work as they are. A host that drives the scene and the renderer itself
gets the graph in neutral today. The stage of the viewer covers an identical diff with a
"No differences" card (`ui/stage.ts`); it keeps doing so unless the host asks for the plain
view, with `plain` on `<kgdiff-stage>` or `view.plain` in a payload.

```ts
interface SceneOptions {
  readonly categories?: {
    /** Where a node's category comes from: an attribute's string value, or its first type. */
    readonly by: { readonly attr: string } | { readonly type: true };
    /** Category → palette slot, 0 to 7. Unlisted categories take the free slots in name order. */
    readonly slots?: Readonly<Record<string, number>>;
  };
}
```

- **Color only in the plain view** (rule 2). In a scene with changes `categories` colors
  nothing; one branch in the scene decides it, and a test asserts that a frame never holds a
  category color and a change family together.
- **A categorical palette of eight** per theme, with a colorblind variant (Okabe–Ito based,
  as the change palette's is), under the existing tests: at least 3:1 against the canvas for
  marks and 4.5:1 for text. A ninth category and beyond is neutral and listed as "+N more";
  colors are never reused for two categories.
- **Stable colors are the host's to pin.** Without `slots` a new category shifts the ones
  after it in name order; a host that shows the same graph across versions passes `slots`.
- **Never color alone:** the legend names every category, and hover and the detail panel say
  it in text.
- **Scope of this part:** the scene, the legend element and `<kgdiff-stage>`. What the default
  layout of `<kgdiff-viewer>` does with a plain view (it has no changes to list) is
  [D-7](#open-decisions).

### 4d. Groups: backgrounds and layout (after 1.0)

A background behind each category only reads well when the category's nodes sit together, and
the force layout does not put them together. So this part is two things that ship as one:

- **Layout:** an option that maps nodes to groups adds a weak spring toward the group's
  centroid and keeps groups apart. Without the option every layout stays byte-identical (the
  `targets` job checks it), so `generator` stays `kgdiff-layout/1`; if that cannot be held,
  it becomes `kgdiff-layout/2`. Anchored layouts keep known positions as always and place new
  nodes by their group.
- **Scene and renderer:** the scene derives one outline per group from the positions
  (deterministic), and the renderer draws it in a pass of its own between the grid and the
  edges, with label halos that match. In a view with changes the backgrounds are neutral
  (rule 2); in the plain view they take the category's `soft` tint.

**Why after 1.0.** Until phase 5 the layout engine exists twice, and the two give
bit-identical positions on the corpus (RFC 0002, phase 4 progress); the browser's
`extendLayout` is the TypeScript one. A new force would be written twice and one copy deleted
weeks later. After phase 5 it is written once, in Rust, and reaches the browser through
`@kgdiff/compute`. Until then hosts draw backgrounds on an `under` layer (4a).

## Compatibility

- Everything is additive. `layout_diff`, `report_payload`, `build_report_html`, `normalize`,
  `buildScene` and `createRenderer` keep their signatures and results.
- No document changes version. `kgdiff.report` version 1 gains optional members of `view`
  (`shapes` in 4b, `categories` and `plain` in 4c). The viewer's payload check
  (`assertPayload`, `packages/viewer/src/payload.ts`) reads `format`, `version`, `diff` and
  `layout` and does not reject other members, so older viewers open newer reports and draw
  discs; a test pins that before 4b ships.
- `FrameVisuals` gains an optional member per node (4b). A renderer that does not read it
  draws circles.
- The new APIs are marked experimental for one minor, as RFC 0001's elements were, and become
  stable in 1.0 (0.10 is that minor); the Rust additions follow the crates' semver from their
  first release.

## Testing

| Part | Tests                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | the contract equality on both graphs of every corpus case and as a `proptest` property; anchored: known positions bit-exact; `Changes` rejected; a doc test     |
| 2    | `Default` equals `report_payload` byte for byte; a given layout appears unchanged in the payload; layouts of another diff rejected; every payload validates     |
| 3    | `normalize_input(x)` against `normalize(x.to_value())` on every corpus graph: bytes, hash, issues                                                               |
| 4a   | pass order and clipping in swipe (pixel tests as the renderer's); state restored after a layer that leaves it dirty; `toDataURL` includes layers; no-layer cost |
| 4b   | per shape: outline, dash spacing, ring, pick inside and outside; the scene's golden frames with `shapes`; G6 mapping; benchmarks with mixed shapes              |
| 4c   | palette contrast (both themes, both palettes); never a category color with a change family; slot assignment deterministic; the ninth category neutral           |
| 4d   | ungrouped layouts byte-identical on every target; groups do not overlap on the datasets; anchored positions kept; outlines deterministic                        |

## Rollout

| Release   | Parts                       | Where                            | Depends on                       |
| --------- | --------------------------- | -------------------------------- | -------------------------------- |
| 0.9       | 1, 2 (`report.v1.json`), 4a | Rust crates; `@kgdiff/renderer`  | nothing                          |
| 0.10      | 4b; 4c if D-5 says so       | scene, renderer, g6, viewer      | the Positioning rules accepted   |
| 1.0       | 3                           | `kgdiff-core`                    | the compact graph representation |
| after 1.0 | 4d; 4c if deferred          | `kgdiff-layout`, scene, renderer | phase 5 (one layout engine)      |

0.9 is the part the first host waits for: with it, its ontology graph and its reports need no
copy of kgdiff's payload and no second canvas. Each later release adds something its users can
see, and the host deletes the matching piece of its own layer code.

## Risks

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                                                 |
| -------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The plain view grows into a general graph viewer, request by request | medium     | high   | the four rules of [Positioning](#positioning) in visual-language.md; closed sets instead of callbacks; rule 4 for everything host-specific |
| 4b and 4c delay 1.0 (one maintainer)                                 | medium     | high   | they touch only the interactive half, which phase 5 does not; 4c moves after 1.0 by default (D-5); 0.9's three parts are days, not weeks   |
| Category colors are read as change colors by habit                   | medium     | medium | never in one frame (tested); the legend switches with the view; backgrounds neutral in views with changes                                  |
| Shapes weaken the cues of change                                     | low        | medium | every cue is defined per shape and tested per shape; hollow stays reserved                                                                 |
| Layers let hosts draw what breaks the visual language                | certain    | low    | by design (rule 4): the host's pixels are the host's; kgdiff's own passes and their contrast tests are unaffected                          |
| API added in 0.9 turns out wrong once a second host arrives          | medium     | low    | experimental for one minor; the additions are small and sit beside the existing functions                                                  |
| The first host's needs are taken for every host's                    | medium     | medium | each part is justified without naming the host's domain; whatever only it needs stays in its layers                                        |

## Alternatives considered

- **Leave all four to the host's workarounds.** They work, and the host's own notes say none
  blocks it. But two of them copy kgdiff's contracts into the host (the report payload, the
  self-diff with a forced scope), and the fourth cannot be done cleanly at all: nothing can be
  drawn under the graph. The next host would pay the same again.
- **A second scene for graphs** (`buildGraphScene`), beside the diff scene. Two resolvers to
  keep in step with one visual language, and "the graph and its diff are one picture" would
  rest on review instead of on shared code. The identical diff reuses everything.
- **A graph input for the layout and the report, instead of the identical diff.** It would
  need its own union ids and edge order to agree with the diff engine's, in both languages; a
  definition in terms of the diff has that by construction.
- **Style callbacks instead of closed sets.** The most flexible, and the end of "every
  renderer draws it the same way": the G6 adapter, the contrast tests and HTML reports (which
  cannot carry functions) all need data.
- **Group-aware layout now, in Rust only.** The browser's `extendLayout` would not know
  groups, so an expanded group would be placed by another rule than the rest of the picture.
- **Typed input now, converting to a `Value` inside.** The public API could stay when the
  compact representation arrives, but its shape (owned strings or interned, edges by id or by
  index) is exactly what that work decides. [D-6](#open-decisions) keeps it as the fallback
  if a second host asks first.

## Open decisions

| ID  | Decision                                                     | Recommendation                                                                                                                                                                 |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | Is the plain view in scope for kgdiff at all?                | Yes, under the four rules of [Positioning](#positioning). Without it every host that embeds the diff builds the graph view beside it, on another map                           |
| D-2 | Names: `layout_graph`, `report_payload_with`, `ReportLayout` | **Taken**, as written ([#78](https://github.com/iiwish/kgdiff/pull/78), [#79](https://github.com/iiwish/kgdiff/pull/79))                                                       |
| D-3 | A hollow shape for a kind of node                            | **Taken:** no. Hollow means "not in this version" in every view, and is not lent to kinds of nodes                                                                             |
| D-4 | The shape set, and whether a type change animates the shape  | **Taken:** `circle`, `square`, `diamond`, `hexagon`; no animation, the type change already has its badge and detail                                                            |
| D-5 | 4c in 0.10, or after 1.0                                     | Decide when 4b merges, by where phase 5 stands. Default: after 1.0, with hosts coloring through an `over` layer until then                                                     |
| D-6 | A thin typed input before 1.0                                | No, unless a second host asks; the first one exports JSON anyway                                                                                                               |
| D-7 | `<kgdiff-viewer>`'s default layout for a plain view          | Not in this RFC: composed elements only. The default layout keeps its "No differences" card until a host asks for more                                                         |
| D-8 | `addLayer` on `<kgdiff-stage>`                               | **Taken:** yes, experimental ([#80](https://github.com/iiwish/kgdiff/pull/80)); otherwise the change graph inside the viewer cannot carry what the host draws on its own graph |
| D-9 | `layoutGraph` in TypeScript                                  | **Taken:** only through `@kgdiff/compute` in phase 5 ([#78](https://github.com/iiwish/kgdiff/pull/78) adds none); not in the engine phase 5 deletes                            |

## 0.9 results

Merged on 2026-11-10, in three pull requests that touch no file in common:
[#78](https://github.com/iiwish/kgdiff/pull/78) (part 1, 0a52a4d),
[#79](https://github.com/iiwish/kgdiff/pull/79) (part 2, 6c3a764) and
[#80](https://github.com/iiwish/kgdiff/pull/80) (part 4a, d3e1dac). No corpus file, layout byte
or CLI report changed. Each is checked by its own tests, and
`crates/kgdiff-report/tests/mental_map.rs` (4ef67c0, with the embedding guide) takes both
graphs of every corpus case through all three: a layout, the next version, a diff, a report
with that layout.

- **Part 1, `layout_graph`.** Implemented as the definition, literally: the graph is diffed
  with itself and the result laid out with scope `All`; `LayoutInput` is untouched. The
  contract holds byte for byte on both graphs of all 29 corpus cases (with default options,
  the case's own, and a third set with pins off the grid), on 96 seeded random graphs and on
  the fixture graphs; the same graph in another order gives the same bytes. A 3,500-node
  graph, above the default threshold, is laid out whole. The crate's documentation has the
  tested example and states the 0.01 grid.
- **Part 1, the next version.** That end-to-end test found that "how the next version of a
  graph keeps the previous version's map" needs more than the previous positions as pins.
  By id, every node the diff matched under another id moves:
  53 nodes in 9 of the 29 corpus cases. And laid out before the diff, the after version put a
  new node on a removed one once in the corpus (`dataset-data-lineage`, discs overlapping by
  0.16). `layout_diff_on` and `layout_after`
  ([#86](https://github.com/iiwish/kgdiff/pull/86)) are the way that holds, in
  `kgdiff-layout` instead of in every host: on all 29 cases, in both directions, every node
  the previous layout places stays bit for bit, no added node overlaps a removed one, and the
  after version is where its diff has it with no simulation run. The guide and its example
  use them.
- **Part 2, reports.** `ReportLayout`, `report_payload_with` and `build_report_html_with` as
  written; `Default` equals `report_payload` byte for byte. A given layout is refused with
  `invalid-input` (details: `node`) by the two rules of the design. `report.v1.json` is in
  `packages/core/schema/`, exported by `@kgdiff/core` with `layout.v2.json`; the payload of
  every corpus case validates against it, in Rust and with ajv.
- **Part 4a, layers.** `addLayer`, `RendererLayer` and `LayerView` as written, marked
  experimental, on the renderer and on `<kgdiff-stage>`. The frame's ops with a layer that
  leaves the context dirty equal the frame's ops without layers; without layers the paint path
  issues the same ops as before. The standalone viewer is 117.4 kB gzip.

**Where the implementation differs from this RFC's text, or decides what it left open:**

- Part 1: the property over random graphs is a seeded test, not `proptest`, which
  `kgdiff-layout` does not depend on. The three options that are "not read" do not affect the
  result, but a value `layout_diff` rejects (`hub_degree: -1`) is still rejected, so that one
  `LayoutOptions` is not valid for one function and invalid for the other.
- Part 1, the next version: besides scope `Changes`, both functions refuse strategy `Union`,
  which ignores known positions and would compute the whole map again. `layout_after` takes
  the layout options too (the font size is in the bounds), and refuses a layout that has no
  position for a node of the after version instead of placing that node. A host that stores
  one layout per version lays out a diff of two stored versions with `layout_diff_on` and the
  after version's positions as pins; no third function was added for the after version laid
  out before its diff.
- Part 2: the schema accepts a layout document of version 1 as well as 2, as the viewer's
  `ReportPayload` does, and a given layout read from a version 1 document is written back as
  version 1. Only `positions` is checked against the diff, not the keys of `radii`, `hidden`
  or `components`. `view` allows members the schema does not name, for parts 4b and 4c. The
  Rust additions carry no experimental mark: they follow the crates' semver
  ([Compatibility](#compatibility)).
- Part 4a: in swipe, `LayerView.viewport` is the side's part of the visible world, which is
  what a layer culls by and how it learns where the divider is. Layers are drawn when no frame
  is set yet. A `draw` that throws is caught and reported, and the rest of the frame is
  painted. Before each layer `globalAlpha` is set to 1 and the dash cleared, besides the save
  and restore. `addLayer` rejects a layer without `draw` or with another `order`. A layer gets
  the canvas's own `CanvasRenderingContext2D`, not the renderer's narrower `Ctx2D`, so where a
  canvas has no 2D context (happy-dom, jsdom without `canvas`) layers are not called. The stage
  keeps its layers across rebinding and reconnection.
- The version bump: Changesets knows no crate, so part 1's changeset is on `@kgdiff/cli`,
  whose changelog is where the crates have been mentioned so far, and part 2's on
  `@kgdiff/core`, which ships the schema. The eight npm packages share one version, and the
  crates take it.

## 4b results

Part 4b as built. No layout byte, `GENERATOR` or CLI report changes; without `shapes`, frames and
draw calls are the same as before. The geometry and how each cue follows it are in
[visual-language.md](../visual-language.md#shape-says-what-kind).

Where it decides beyond this RFC, or differs from it:

- **Edges carry their ends' shapes.** The sketch above adds `shape` to `NodeVisual` only. A
  renderer gets a frame without its scene, and an edge has no node indices, so `EdgeVisual` and
  `GlyphVisual` gain optional `shape1` and `shape2` as well, present only in scenes with
  non-circle shapes. `Scene` gains optional `shapes`, the entries in use, for legends.
- **One geometry, exported.** `@kgdiff/scene` exports the outline functions (`shapeVertices`,
  `shapeDistance`, `shapeGauge`, `shapeApothem`, `shapeVertexRadius`, `evenShapeDash`,
  `isNodeShape`, `NODE_SHAPES`), experimental, for the two renderers and for hosts' own layers.
- **The ghost's dashes tile each side,** not just the outline: a whole number of periods per
  side, a dash centered on every corner. Tiling the perimeter alone can put a gap on a corner,
  and a diamond whose tips vanish no longer reads as a diamond.
- **Badges and pivots follow the outline too,** which the list above does not name.
- **Labels do not.** They stay at `r·k + 5 px` below the center, so a square's or a flat
  hexagon's sits up to 0.134·r further from the shape. G6 places labels from the key shape's
  bounds, so there they keep their gap: up to 2 px of difference between the two renderers.
- **`buildScene` rejects an unknown shape;** the viewer drops one from a payload with a warning,
  as it does other invalid `view` members, so a report from a later version still opens.
- **`view.shapes` is read from payloads only.** `load()` has no option for it, and the CLI none
  either: shapes come from hosts, through `ReportInfo`.

## References

- [RFC 0002: A Rust compute core](./0002-rust-compute-core.md): the crates, the phases, the
  gates of 1.0, the layout decision
- [RFC 0001: Composable viewer components](./0001-viewer-components.md): the elements a host
  composes, and how experimental APIs become stable
- [architecture.md](../architecture.md), [visual-language.md](../visual-language.md)
