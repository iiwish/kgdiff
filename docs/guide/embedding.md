# Embed kgdiff in a Rust application

kgdiff's engine is a set of Rust crates, and its pictures are a set of npm packages. This guide
follows an application that uses both: a server in Rust that keeps the versions of a graph, and
web pages that show the graph and what changed in it. It is written in the order such a host
does things, around the one promise it leans on: **one mental map**. Going from a version to
the next one, and from either to the diff of the two, must not move a node.

Every Rust function below is quoted from
[`examples/embedding.rs`](../../crates/kgdiff-report/examples/embedding.rs) of `kgdiff-report`
(`cargo run -p kgdiff-report --example embedding`). A test runs those functions on both graphs
of every case of the [conformance corpus](../../conformance/README.md) and checks the claims
this page makes about them ([`tests/mental_map.rs`](../../crates/kgdiff-report/tests/mental_map.rs)).

`layout_graph`, `layout_diff_on`, `layout_after`, `report_payload_with` and the renderer's
`addLayer` are new in 0.9 and experimental until 1.0, when they become stable
([RFC 0003](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0003-embedding-hosts.md), parts
1, 2 and 4a). [What is not there yet](#what-is-not-there-yet) lists the rest of that RFC.

## What you depend on

| Where   | Package                                | For                                                             |
| ------- | -------------------------------------- | --------------------------------------------------------------- |
| Server  | `kgdiff-core`                          | graphs, the diff, the delta                                     |
| Server  | `kgdiff-layout`                        | the layout of a graph and of a diff, the layout document        |
| Server  | `kgdiff-report`                        | the summaries, the report payload, the HTML report              |
| Server  | `kgdiff-formats` (optional)            | reading RDF, OBO and other JSON shapes into kgdiff graphs       |
| Browser | `@kgdiff/viewer`                       | the whole review interface, `<kgdiff-viewer>`                   |
| Browser | `@kgdiff/scene` and `@kgdiff/renderer` | your own interface: the visual model and a canvas that draws it |
| Browser | `@kgdiff/core` and `@kgdiff/layout`    | reading the diff and the layout out of a payload, for the scene |

```toml
[dependencies]
kgdiff-core = "0.9"
kgdiff-layout = "0.9"
kgdiff-report = "0.9"
```

- **The crates move together.** Each crate requires the others at exactly its own version
  (`kgdiff-report` 0.9.0 depends on `kgdiff-core = "=0.9.0"`), so Cargo resolves the three to
  one release, and refuses requirements that allow no common one. Give all of them the same
  requirement and update them together.
- **The npm packages have the same version number** as the crates: kgdiff 0.9.0 names one
  consistent set, tested together. Install the packages at the version of your crates
  (`npm install @kgdiff/viewer@^0.9.0`).
- Before 1.0 a minor release may change an API. `"0.9"` in Cargo and `^0.9.0` in npm both stay
  within 0.9.
- The documents that cross from the server to the browser are versioned on their own
  (`kgdiff.report` 1, `kgdiff.diff.packed` 1, `kgdiff.layout` 2) and have JSON Schemas in
  [`@kgdiff/core/schema/`](../formats.md#format-marker-and-json-schema).

The functions on this page share these imports:

```rust
use std::error::Error;

use kgdiff_core::js::{Value, json};
use kgdiff_core::{
    DiffOptions, DiffResult, KGraph, Locale, NormalizeOptions, Result, diff_graphs, normalize,
};
use kgdiff_layout::{
    LayoutOptions, LayoutResult, layout_after, layout_diff_on, layout_from_json, layout_graph,
    layout_to_json,
};
use kgdiff_report::{
    MarkdownOptions, Painter, ReportInfo, ReportLayout, ReportSide, TextContext, ViewerBundles,
    build_report_html_with, embedded_viewer, needs_compute, render_markdown, render_summary,
    report_payload_with,
};
```

## Export a version and normalize it

A graph enters kgdiff as [kgdiff JSON](../formats.md#kgdiff-json): `{ "nodes": […], "edges": […] }`.
Your export writes that, as text or as a `kgdiff_core::js::Value`, and `normalize` turns it into
the `KGraph` every other function takes:

```rust
pub fn read_graph(export: &str) -> std::result::Result<KGraph, Box<dyn Error>> {
    let value = json::parse(export)?;
    Ok(normalize(&value, NormalizeOptions::default())?)
}
```

- `normalize` validates and indexes: labels default to the id, duplicate nodes are merged,
  dangling edge ends become implicit nodes. What it had to repair is in `graph.issues`.
- A `KGraph` cannot be built from typed values yet; that is
  [part 3 of RFC 0003](#what-is-not-there-yet). Until then the export goes through JSON.
- Files in other formats (Turtle, OBO, JSON-LD, …) are read with `parse_graph` of
  [`kgdiff-formats`](../../crates/kgdiff-formats/README.md), whose result holds the same JSON.

## Lay out the first version

`layout_graph` gives one graph its positions. They are, by definition and by test, the positions
`layout_diff` gives the diff of that graph with itself: a graph and a diff of it are laid out by
one engine with one result.

```rust
pub fn first_map(graph: &KGraph) -> Result<(LayoutResult, String)> {
    let layout = layout_graph(graph, &LayoutOptions::default())?;
    let document = json::to_string(&layout_to_json(&layout));
    Ok((layout, document))
}
```

Store the document next to the version it belongs to, and read it back when you need it:

```rust
pub fn stored_map(document: &str) -> std::result::Result<LayoutResult, Box<dyn Error>> {
    Ok(layout_from_json(&json::parse(document)?)?)
}
```

- The layout is deterministic: the same graph and options give the same document, byte for
  byte, on every platform.
- **The 0.01 grid.** A layout document rounds coordinates to 0.01. The positions a layout
  computes are on that grid already, so they come back from a document unchanged, through any
  number of versions. A position from somewhere else (`300.125`) is kept exactly in a
  `LayoutResult` and written as `300.13`: round your own positions to 0.01 before you hand them
  to kgdiff if you compare them later.
- The scope is always every node, whatever the size of the graph.

## Keep the map for the next version

When the next version arrives, diff it against the previous one, lay the **diff** out on the
previous version's map, and give the next version the positions of its diff:

```rust
pub fn changes(before: &KGraph, after: &KGraph) -> Result<DiffResult> {
    diff_graphs(before.clone(), after.clone(), DiffOptions::default())
}
```

```rust
pub fn diff_map_first(diff: &DiffResult, previous: &LayoutResult) -> Result<LayoutResult> {
    layout_diff_on(diff, previous, &LayoutOptions::default())
}
```

```rust
pub fn next_map_of(diff: &DiffResult, both: &LayoutResult) -> Result<LayoutResult> {
    layout_after(diff, both, &LayoutOptions::default())
}
```

- `layout_diff_on` keeps every node the previous map has exactly where it is, whether the node
  continues or was removed, and places only the new nodes. The scope is every node, whatever
  the size of the diff.
- `layout_after` computes nothing: every node of the next version is where the diff has it. Its
  result is keyed by the next version's ids and is the layout to store with that version, as
  the previous map of the version after it.
- The diff's layout is keyed by **union id**. A node of the after version has its own id as
  union id; a removed node has its before id, or that id with `@before` appended when the after
  version uses the id for something else. Both functions read positions through a union
  node's `before_id` and `after_id`, so you never translate ids yourself.

That is the whole promise: going from a version to the next one, and from either to their diff,
moves no node. The test checks it bit for bit on every corpus case, with merges, splits and
changed ids among them.

The positions are carried **through the diff**, and not by id. Laying the next version out with
`layout_graph` and the previous positions as pins is the short form, and it is not the same
thing:

| Between the versions                                                         | Carried through the diff  | Carried by id (`pinned: previous.positions.clone()`) |
| ---------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------- |
| a node keeps its id                                                          | stays                     | stays                                                |
| a node continues under another id (a `replaces` hint, a match by similarity) | stays                     | is placed again, as if it were new                   |
| an id is reused for another node (graphs without stable ids)                 | each node keeps its place | the other node is pinned where the old one was       |

On the conformance corpus, carrying by id moves every node whose id changes: 53 nodes in 9 of
its 29 cases when this was written, 37 of them in one graph extracted by a language model.

**The diff comes first** for the sake of the removed nodes. The layout of the next version alone
cannot see them, so it may place a new node where one of them was (once in the corpus when this
was written: laid out that way, the discs of an added and a removed node of
`dataset-data-lineage` overlap by 0.16 world units). On the diff, the new nodes are placed clear
of the removed ones, and no pair of them overlaps on any corpus case.

Positions can also live in your export, as the `position` member of a node
([`graph.v1.json`](../../packages/core/schema/graph.v1.json)): a layout treats it as a known
position, and it is never part of the diff. `layout_diff_on` reads it for a node the previous
map does not place; the previous map wins over it, and a pin in `options.pinned` (keyed by union
id) wins over both.

## Lay out a diff of two versions that have their maps

With one layout stored per version, a diff needs no layout of its own. Whenever a diff of two
stored versions is shown, the same two as before or two that are further apart, every node
already has its position:

```rust
pub fn diff_map(
    diff: &DiffResult,
    before: &LayoutResult,
    after: &LayoutResult,
) -> Result<LayoutResult> {
    let options = LayoutOptions {
        // Pins are keyed by union id, which is its own id for a node of the after version.
        // They win over the before version's positions, which are left for the removed nodes.
        pinned: after.positions.clone(),
        ..LayoutOptions::default()
    };
    layout_diff_on(diff, before, &options)
}
```

A node of the after version is where the after version has it, and a removed node stays where
the before version had it. Nothing is simulated.

- For a version and the next one this gives the positions `layout_diff_on` gave when the next
  version arrived, so there is no need to store the diff's layout.
- Between versions further apart nothing moves either, but a removed node and a node added
  since were never placed with each other in view, and may sit close together.
- If both exports carry their positions as `position`, the default `layout_diff` (and so
  `report_payload`, and the `kgdiff` command line) lays the diff out on them without any pins:
  the same layout, and the same report, byte for byte. That holds up to the large-graph
  threshold of 3,000 nodes; above it the default layout covers the changes only.

## Summaries and reports

`kgdiff-report` renders what the `kgdiff` command prints, without its argument parsing and
files: the terminal summary and the Markdown summary (and `render_stat`, `render_name_status`),
in English or Simplified Chinese.

```rust
pub fn summaries(diff: &DiffResult, title: &str) -> Result<(String, String)> {
    let context = TextContext {
        paint: Painter::plain(),
        locale: Locale::En,
        width: 80,
        limit: 50,
        watch: None,
    };
    let text = render_summary(diff, title, &context)?;
    let options = MarkdownOptions {
        locale: Locale::En,
        title,
        generator: "my-app 1.0",
        watch: None,
    };
    let markdown = render_markdown(diff, &options)?;
    Ok((text, markdown))
}
```

A report is a `kgdiff.report` payload: the diff, its layout, and what the report says about
itself. `report_payload_with` takes the layout you already have, so the report shows your map
and nothing is laid out twice:

```rust
pub fn report_info(title: &str, before: &str, after: &str) -> ReportInfo {
    let side = |name: &str| ReportSide {
        name: name.to_owned(),
        format: None,
    };
    ReportInfo {
        title: title.to_owned(),
        generator: "my-app 1.0".to_owned(),
        generated_at: None,
        before: side(before),
        after: side(after),
        mode: None,
        scope: None,
        theme: None,
        locale: Locale::En,
        panels: None,
    }
}
```

```rust
pub fn report(diff: &DiffResult, layout: &LayoutResult, info: &ReportInfo) -> Result<Value> {
    report_payload_with(diff, ReportLayout::Given(layout), info)
}
```

- A given layout is checked against the diff, and the layout of another diff is refused with
  `invalid-input`: every position must belong to a union node, and a layout of scope `all` must
  place every union node.
- The payload validates against
  [`report.v1.json`](../../packages/core/schema/report.v1.json). Do not put one together by hand.
- `ReportLayout::Default` is what `report_payload` does (the layout of the default options);
  `ReportLayout::None` leaves the layout to the browser.

For a file a reader opens offline, `build_report_html_with` inlines the payload and the viewer:

```rust
pub fn report_page(
    diff: &DiffResult,
    layout: &LayoutResult,
    info: &ReportInfo,
    viewer: ViewerBundles<'_>,
) -> Result<String> {
    build_report_html_with(diff, ReportLayout::Given(layout), info, viewer)
}
```

`embedded_viewer()` returns the viewer bundles when `kgdiff-report` is built with the feature
`embed-viewer`; otherwise pass the standalone bundles of `@kgdiff/viewer`
(`dist/standalone/kgdiff-viewer.js`, and `kgdiff-viewer-compute.js`, which a report with a full
layout does not inline).

One version on its own goes to the browser the same way, as the diff of the graph with itself
and the graph's layout:

```rust
pub fn graph_payload(graph: &KGraph, layout: &LayoutResult, info: &ReportInfo) -> Result<Value> {
    let options = DiffOptions {
        edge_identity: graph.edge_identity,
        ..DiffOptions::default()
    };
    let unchanged = diff_graphs(graph.clone(), graph.clone(), options)?;
    report_payload_with(&unchanged, ReportLayout::Given(layout), info)
}
```

## In the browser

### Hand the payload to the viewer

```html
<kgdiff-viewer theme="auto" style="height: 640px"></kgdiff-viewer>

<script type="module">
  import '@kgdiff/viewer';

  const viewer = document.querySelector('kgdiff-viewer');
  viewer.payload = await (await fetch('/changes/42/report.json')).json();
</script>
```

A payload with a full layout opens without computing anything: the diff engine and the layout
stay out of the page. [Embed the viewer](./viewer.md) covers the element, its panels, its events
and the elements it is made of.

### Or draw it yourself

For an interface of your own, read the diff and the layout out of the payload, build a scene and
give its frames to the renderer:

```ts
import { diffFromJSON, unpackDiffJSON } from '@kgdiff/core';
import { layoutFromJSON } from '@kgdiff/layout';
import { createRenderer } from '@kgdiff/renderer';
import { buildScene, createViewState, createVisualResolver, getTheme } from '@kgdiff/scene';

const payload = await (await fetch('/changes/42/report.json')).json();
const result = diffFromJSON(unpackDiffJSON(payload.diff)); // kgdiff-report packs the diff
const layout = layoutFromJSON(payload.layout);

const scene = buildScene(result, layout, { theme: 'light' });
const resolver = createVisualResolver(scene);
const container = document.getElementById('graph') as HTMLElement; // give it a size
const renderer = createRenderer(container, { theme: getTheme('light') });
renderer.setFrame(resolver.resolve(createViewState()));
```

The same code draws one version on its own from the payload of `graph_payload`: a diff without
changes is drawn in the neutral color, at the positions the diff of that version will use.
(`<kgdiff-viewer>` shows such a payload as a "No differences" card; see
[below](#what-is-not-there-yet).) The READMEs of [scene](../../packages/scene/README.md) and
[renderer](../../packages/renderer/README.md) cover selection, replay, swipe and the minimap.

### Draw your own marks: layers

What only your application knows about (a background behind a business domain, a certification
mark, a count on a node) you draw on the renderer's canvas, under or over the graph, from the
positions you already have:

```ts
// Under the graph: after the background and the dot grid, before everything else.
renderer.addLayer({
  order: 'under',
  draw(ctx, view) {
    const k = view.camera.k;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.10)'; // keep it soft, see below
    for (const domain of domains) {
      const corner = view.worldToScreen(domain); // { x, y, width, height } in world units
      ctx.beginPath();
      ctx.roundRect(corner.x, corner.y, domain.width * k, domain.height * k, 12);
      ctx.fill();
    }
  },
});

// Over the graph: after the labels.
const removeMarks = renderer.addLayer({
  order: 'over',
  draw(ctx, view) {
    ctx.fillStyle = '#16a34a';
    for (const id of certified) {
      const position = layout.positions.get(id);
      if (!position) continue;
      const p = view.worldToScreen(position);
      ctx.beginPath();
      ctx.arc(p.x + 8, p.y - 8, 4, 0, Math.PI * 2); // 4 px at every zoom
      ctx.fill();
    }
  },
});
```

- A layer draws in CSS pixels: convert positions with `view.worldToScreen`, and multiply sizes
  that should grow with the zoom by `view.camera.k`. It is drawn with every frame, clipped per
  side in a swipe view, and is part of `toDataURL`. Call `renderer.requestRender()` when your
  own data changes, and the function `addLayer` returned to remove the layer.
- Layers are not picked, and their text takes no part in label placement. Hit-test your marks
  with `renderer.camera.screenToWorld` and the `click` event's `world`.
- **Known limit: label halos over a tinted background.** Labels carry a halo in the canvas
  background color, which shows as a faint outline over an area an `under` layer has tinted.
  Soft tints, about 10% alpha like the theme's `soft` colors, keep it unnoticeable.
- Inside the viewer, `<kgdiff-stage>` has the same method (`stage.addLayer(…)`), so the change
  graph can carry the marks your own graph page draws.

The rules in full are in the
[renderer's README](../../packages/renderer/README.md#layers-drawing-under-and-over-the-graph).

## What is not there yet

[RFC 0003](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0003-embedding-hosts.md) plans
four more parts. None of them exists in 0.9, and the RFC is a draft: releases and details may
change.

| Part | What                                                                     | Planned for        | Until then                                                                                                                   |
| ---- | ------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 3    | Typed graph input: build a `KGraph` from Rust values (`normalize_input`) | 1.0                | write kgdiff JSON and call `normalize`                                                                                       |
| 4b   | Node shapes by type (circle, square, diamond, hexagon)                   | 0.10               | every node is a disc; draw your own shapes or marks on an `over` layer                                                       |
| 4c   | The plain view: one graph in the viewer, colored by your categories      | 0.10, or after 1.0 | scene and renderer draw an unchanged diff in neutral; `<kgdiff-viewer>` shows a "No differences" card; color through a layer |
| 4d   | Groups: a background per group, and a layout that keeps a group together | after 1.0          | draw backgrounds on an `under` layer from the positions; the layout does not know groups                                     |

Also not there: `layout_graph`, `layout_diff_on` and `layout_after` in TypeScript.
`@kgdiff/layout` has no counterpart of them; `layoutGraph` is planned for `@kgdiff/compute`,
with the rest of the layout. In the browser, lay out the diff of a graph with itself, or better,
compute layouts on the server as above.
