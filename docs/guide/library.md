# Use the engine in code

The CLI and the viewer are built from packages you can use directly:

| Package            | What it does                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `@kgdiff/core`     | The diff model and the parsers: parse, normalize, match, classify, hunks, invertible deltas.           |
| `@kgdiff/formats`  | Deprecated since 0.11: moved to `@kgdiff/core`, which has the same functions and types.                |
| `@kgdiff/layout`   | A deterministic, label-aware layout that both versions share.                                          |
| `@kgdiff/scene`    | Turns a diff into visual primitives: design tokens, encodings, replay timeline.                        |
| `@kgdiff/renderer` | A Canvas 2D renderer: camera, level of detail, labels, picking, minimap.                               |
| `@kgdiff/viewer`   | The [`<kgdiff-viewer>` web component](./viewer.md).                                                    |
| `@kgdiff/g6`       | Draws kgdiff scenes in AntV G6 v5 graphs.                                                              |
| `@kgdiff/compute`  | The Rust engine compiled to WebAssembly: [the same bytes as the CLI](#the-rust-engine-in-the-browser). |
| `@kgdiff/cli`      | The command-line tool, `kgdiff`: runs its native binary, exports no JavaScript API.                    |

All of them are ESM only and run in Node.js 22 or later and in evergreen browsers, and do no I/O:
you pass text and objects in and get objects out. Since 0.11, computing (`diff`, `matchNodes`,
`textSimilarity`, `parseGraph`, `detectFormat`, `layoutDiff`, `extendLayout`) runs on
`@kgdiff/compute` and is asynchronous; reading and applying (`normalize`, `hashGraph`,
`diffFromJSON`, `applyDelta`, `formatHunk`, `layoutFromJSON`, …) stays synchronous. Upgrading
from 0.10: [Migrating to 0.11](./migrating-to-0.11.md). `@kgdiff/formats` is deprecated: its
parsers are in `@kgdiff/core` since 0.11.1, so moving off it means changing the import path only.

The rule: the model packages (`@kgdiff/core`, `@kgdiff/layout`) give asynchronous entries that
load the engine on the first call. For the synchronous API, for choosing where the `.wasm` files
are loaded from, or for the low-level JSON functions, use
[`@kgdiff/compute`](#the-rust-engine-in-the-browser).

This page is about the TypeScript packages. The engine itself is written in Rust, and an
application in Rust uses its crates directly:
[Embed kgdiff in a Rust application](./embedding.md) goes from a graph to a report with your own
layout, and on to the browser.

## Diff two graphs

```sh
npm install @kgdiff/core
```

```ts
import { readFile } from 'node:fs/promises';
import { diff, formatHunk, parseGraph } from '@kgdiff/core';

const read = async (file: string) => parseGraph(await readFile(file, 'utf8'), { filename: file });
const before = await read('before.obo');
const after = await read('after.obo');

const result = await diff(before.graph, after.graph, { match: { strategy: 'id' } });

console.log(result.stats.nodes); // { added: 5, removed: 0, modified: 23, unchanged: 156 }
for (const hunk of result.hunks) {
  console.log(formatHunk(hunk, result).title);
}
// Merged “juvenile diabetes” and “insulin-dependent diabetes mellitus” into “type 1 diabetes mellitus”
// Merged “heart attack” into “myocardial infarction”
// …
```

- `parseGraph(text, { filename })` detects the format and returns the `graph` together with the
  `format` it read and `warnings` about recoverable oddities (merged named graphs, ignored
  fields). Pass `format` to skip detection.
- `diff(before, after, options)` takes parsed graphs or plain `{ nodes, edges }` objects in
  [kgdiff JSON](../formats.md#kgdiff-json).
- `formatHunk(hunk, result, locale)` words a hunk as the CLI does, as a `title` and a `subtitle`,
  in `en` (default) or `zh-CN`.

## Options

```ts
await diff(before.graph, after.graph, {
  match: { strategy: 'auto', threshold: 0.82 }, // 'id' | 'auto' | 'similarity'
  hierarchyPredicates: ['is_a'], // replaces DEFAULT_HIERARCHY_PREDICATES
  ignoreAttrs: ['creation_date'],
  detectMerges: true,
  detectSplits: true,
  edgeIdentity: 'structure', // or 'id'
});
```

They are the CLI's `--match`, `--threshold`, `--hierarchy`, `--ignore-attr`, `--no-merges`,
`--no-splits` and `--edge-identity`.

## The result

| Field                    | Contents                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `stats`                  | Nodes and edges added, removed, modified and unchanged; hunks per kind; per type; `identical`                    |
| `hunks`                  | The review units in review order, each with a `kind`: `add`, `remove`, `modify`, `merge`, `split` or `relations` |
| `nodes`, `edges`         | The union of both versions: every element with its status and what changed about it                              |
| `matches`, `suggestions` | Node pairs found by replacement hints or similarity, and near misses                                             |
| `delta`                  | The invertible patch from before to after                                                                        |
| `before`, `after`        | The two graphs, normalized                                                                                       |

Each hunk has an `id` made of its kind and its anchor node, such as `modify:Q42`. To store
something per hunk, such as review progress, read [Hunk ids](../algorithms.md#hunk-ids) first:
it says when an id stays the same and when it does not.

## Apply, invert and verify deltas

```ts
import { applyDelta, hashGraph, invertDelta, normalize } from '@kgdiff/core';

const patched = applyDelta(result.before, result.delta);
hashGraph(patched) === hashGraph(result.after); // true

const restored = applyDelta(patched, invertDelta(result.delta));
hashGraph(restored) === hashGraph(result.before); // true
```

`applyDelta` works on normalized graphs: `result.before`, or a graph you parse again and pass
through `normalize()`. It checks the content hash of its input first and throws a `KgdiffError`
with code `delta-base-mismatch` when the graph is not the delta's base:

```ts
const delta = JSON.parse(await readFile('patch.json', 'utf8'));
const graph = normalize((await read('before.obo')).graph);
const updated = applyDelta(graph, delta);
```

With `{ strict: false, onSkip }` it applies every operation whose precondition holds and reports
the others to `onSkip`. [Deltas](./deltas.md) covers the same from the command line.

## Save and load

- `diffToJSON(result)` and `diffFromJSON(json)`: the complete diff as JSON, as the CLI's
  `--json` writes it. `diffFromJSON` checks that the document is consistent (statuses, hunks,
  edge endpoints, the delta's graphs, the counts) and names the first contradiction.
- `packDiffJSON(json)` and `unpackDiffJSON(packed)`: the same diff with its unchanged elements
  packed into tables (`kgdiff.diff.packed`), as HTML reports embed it; a large, mostly unchanged
  diff shrinks to about a third, and unpacks byte for byte.
- `graphToJSON(graph)`: a graph in kgdiff JSON, which `parseGraph` reads back losslessly.
- `result.delta` is plain JSON already; [Delta format](../delta-format.md) specifies it.

Each of the three names its `format` (`kgdiff.diff`, `kgdiff.graph`, `kgdiff.delta`) and
`version`, and has a JSON Schema in `@kgdiff/core/schema/`
([Formats](../formats.md#format-marker-and-json-schema)). Readers reject a version they do not
support with `KgdiffError('unsupported-version')`.

## Lay out and draw

The viewer does all of this for you. To build your own interface:

- `layoutDiff(result)` from `@kgdiff/layout` places the union of both graphs, deterministically.
- `buildScene(result, layout)` from `@kgdiff/scene` turns the diff into visual primitives in the
  [kgdiff visual language](../visual-language.md).
- `@kgdiff/renderer` draws a scene on a canvas; `@kgdiff/g6` draws it in an AntV G6 graph.

The package READMEs show each step: [layout](../../packages/layout/README.md),
[scene](../../packages/scene/README.md), [renderer](../../packages/renderer/README.md) and
[g6](../../packages/g6/README.md).

## The Rust engine in the browser

`@kgdiff/compute` is kgdiff's Rust engine compiled to WebAssembly. Its results are byte for byte
what the kgdiff CLI computes, in every JavaScript engine. It is three modules, each loaded only
when asked for: `compute.wasm` (diff and matching, about 390 KiB gzip), `formats.wasm` (the
parsers) and `layout.wasm` (the layout of a diff, small enough to inline in a page).

```ts
import { init, diffSync, layoutDiffSync } from '@kgdiff/compute';

await init(); // compiles the modules, once; init({ modules: ['compute'] }) for some only
const result = diffSync(before, after); // a DiffResult, as diff() of @kgdiff/core gives
const layout = layoutDiffSync(result); // a LayoutResult, as layoutDiff() gives
```

The `*Sync` functions need their module loaded; `diff`, `parseGraph`, `layoutDiff` and the other
names without the suffix return promises and load their module themselves. `json.diff`,
`json.parseGraph`, `json.layoutDiff` and the rest take and return JSON text. A page that only lays
out diffs it already has imports `@kgdiff/compute/layout`, which never loads the other modules.
The [package README](../../packages/compute/README.md) lists every function.

**Bundlers.** The modules are located with `new URL('../wasm/<module>.wasm', import.meta.url)`.
Vite, webpack 5, Rollup and Node 22 or later resolve it and copy the `.wasm` files as assets;
esbuild needs a `file` loader for `.wasm`. Serve them as `application/wasm`. To serve them from
elsewhere, pass their URLs (or bytes) to `init({ sources: { compute: url } })`; they are exported
as `@kgdiff/compute/compute.wasm`, `/formats.wasm` and `/layout.wasm`.

**Content Security Policy.** Compiling WebAssembly needs `'wasm-unsafe-eval'` in `script-src`,
for example `Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'`.

Since 0.11, `diff` and `parseGraph` of `@kgdiff/core` and `layoutDiff` of `@kgdiff/layout` are
asynchronous and run on this package: `await diff(…)` loads `compute.wasm` on first use, and
`await parseGraph(…)` loads `formats.wasm`. [Migrating to 0.11](./migrating-to-0.11.md) lists every changed function.

## Errors

Every API throws `KgdiffError` for bad input, with a `code` (`invalid-input`,
`delta-base-mismatch`, `delta-conflict`, `unsupported-version`) and `details`.
