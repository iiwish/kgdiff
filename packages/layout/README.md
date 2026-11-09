# @kgdiff/layout

Stable, deterministic, label-aware layout for graph diffs. Both versions of a graph share one
set of coordinates, the union layout, so nothing jumps when a viewer switches between before,
after, overlay and replay: only what changed moves, and removed nodes stay where they were.

## Install

```sh
pnpm add @kgdiff/layout @kgdiff/core
```

ESM only. Node.js ≥ 22 or any evergreen browser.

## Quick start

```ts
import { diff } from '@kgdiff/core';
import { layoutDiff, layoutToJSON } from '@kgdiff/layout';

const result = diff(before, after);
const layout = layoutDiff(result);

layout.positions.get('company'); // { x, y } in world units, keyed by union node id
layout.scope; // 'all', or 'changes' above 3000 nodes: the changes and their context only

// Same input and seed → identical output, so a layout can be cached or embedded in a report.
const json = JSON.stringify(layoutToJSON(layout));
```

Options worth knowing:

- `scope` (`'all'` | `'changes'`), `contextHops` and `hubDegree` decide which nodes are placed.
- `strategy: 'anchored'` with `pinned` positions keeps an existing layout and places only new
  nodes.
- `extendLayout(result, layout, ids)` adds nodes next to their neighbours without moving any node
  already placed, e.g. when a user expands a collapsed group.

`layoutFromJSON` reads a stored layout back. It reads version 1 of the document, which
`layoutToJSON` writes for this package's layouts, and version 2, which kgdiff's Rust layout engine
writes (the `kgdiff` CLI's reports carry it): the same members plus `generator` (for example
`"kgdiff-layout/1"`), which names the engine generation that computed the positions and becomes
`layout.generator`. Positions from either version can be `pinned`. `layoutToJSON` writes a layout
with a `generator` back as version 2, so a stored layout keeps saying which engine computed it;
once `extendLayout` places a node, the layout is this package's and is written as version 1.

## Learn more

- [Algorithms § Layout](../../docs/algorithms.md#12-layout-layoutdiff): the simulation, label
  awareness, component packing and quality bars.
- [Architecture](../../docs/architecture.md): budgets and how the packages fit together.

## License

[MIT](../../LICENSE)
