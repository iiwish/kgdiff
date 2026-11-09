# Use the engine in code

The CLI and the viewer are built from packages you can use directly:

| Package            | What it does                                                                            |
| ------------------ | --------------------------------------------------------------------------------------- |
| `@kgdiff/core`     | The diff engine: normalize, match, classify, hunks, invertible deltas. No dependencies. |
| `@kgdiff/formats`  | Parsers from RDF, OBO and JSON graph formats into kgdiff graphs.                        |
| `@kgdiff/layout`   | A deterministic, label-aware layout that both versions share.                           |
| `@kgdiff/scene`    | Turns a diff into visual primitives: design tokens, encodings, replay timeline.         |
| `@kgdiff/renderer` | A Canvas 2D renderer: camera, level of detail, labels, picking, minimap.                |
| `@kgdiff/viewer`   | The [`<kgdiff-viewer>` web component](./viewer.md).                                     |
| `@kgdiff/g6`       | Draws kgdiff scenes in AntV G6 v5 graphs.                                               |
| `@kgdiff/cli`      | The command-line tool, `kgdiff`: runs its native binary, exports no JavaScript API.     |

All of them are ESM only and run in Node.js 22 or later and in evergreen browsers. Core and
formats are synchronous and do no I/O: you pass text and objects in and get objects out.

## Diff two graphs

```sh
npm install @kgdiff/core @kgdiff/formats
```

```ts
import { readFile } from 'node:fs/promises';
import { diff, formatHunk } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';

const read = async (file: string) => parseGraph(await readFile(file, 'utf8'), { filename: file });
const before = await read('before.obo');
const after = await read('after.obo');

const result = diff(before.graph, after.graph, { match: { strategy: 'id' } });

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
diff(before.graph, after.graph, {
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

## Errors

Every API throws `KgdiffError` for bad input, with a `code` (`invalid-input`,
`delta-base-mismatch`, `delta-conflict`, `unsupported-version`) and `details`.
