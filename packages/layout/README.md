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

const result = await diff(before, after);
const layout = await layoutDiff(result);

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

`layoutFromJSON` reads a stored layout back. It reads version 2 of the document, which kgdiff's
Rust layout engine writes (every layout this package computes since 0.11, and the `kgdiff` CLI's
reports): version 1's members plus `generator` (for example `"kgdiff-layout/1"`), which names
the engine generation that computed the positions and becomes `layout.generator`. It also reads
version 1, which 0.x wrote for the layouts of its TypeScript engine. Positions from either version
can be `pinned`. `layoutToJSON` writes a layout with a `generator` as version 2 and one without as
version 1, so a stored layout keeps saying which engine computed it.

## Learn more

- [Algorithms § Layout](../../docs/algorithms.md#12-layout-layoutdiff): the simulation, label
  awareness, component packing and quality bars.
- [Architecture](../../docs/architecture.md): budgets and how the packages fit together.

## License

[MIT](../../LICENSE)
