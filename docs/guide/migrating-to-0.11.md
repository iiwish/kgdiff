# Migrating to 0.11

kgdiff 0.11 runs every computation in the browser and in Node on kgdiff's Rust engine compiled to
WebAssembly, [`@kgdiff/compute`](../../packages/compute/README.md): the same engine, and the same
bytes, as the kgdiff CLI. Compiling WebAssembly is asynchronous, so the functions that compute
return promises. 0.12 then readies the public API for 1.0, the Rust API above all
([Migrating to 0.12](./migrating-to-0.12.md));
it is the last release with breaking changes, and 1.0 is 0.12 after a stable period
([RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md#6-api-changes-and-versions)).

## The functions that became asynchronous

| Package           | 0.10                                                        | 0.11                                                                 |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `@kgdiff/core`    | `diff(before, after, options?): DiffResult`                 | `diff(before, after, options?): Promise<DiffResult>`                 |
| `@kgdiff/core`    | `matchNodes(before, after, options?): MatchResult`          | `matchNodes(before, after, options?): Promise<MatchResult>`          |
| `@kgdiff/core`    | `textSimilarity(a, b): number`                              | `textSimilarity(a, b): Promise<number>`                              |
| `@kgdiff/formats` | `parseGraph(text, options?): ParseResult`                   | `parseGraph(text, options?): Promise<ParseResult>` (deprecated)      |
| `@kgdiff/formats` | `detectFormat(text, filename?): FormatId`                   | `detectFormat(text, filename?): Promise<FormatId>` (deprecated)      |
| `@kgdiff/formats` | `compactIri(iri, prefixes?): string`                        | `compactIri(iri, prefixes?): Promise<string>` (deprecated)           |
| `@kgdiff/layout`  | `layoutDiff(diff, options?): LayoutResult`                  | `layoutDiff(diff, options?): Promise<LayoutResult>`                  |
| `@kgdiff/layout`  | `extendLayout(diff, layout, nodes, options?): LayoutResult` | `extendLayout(diff, layout, nodes, options?): Promise<LayoutResult>` |

New in `@kgdiff/layout`, asynchronous too: `layoutGraph(graph, options?)`,
`layoutDiffOn(diff, previous, options?)` and `layoutAfter(diff, layout, options?)`, the layouts
that keep one map across versions ([Embed kgdiff in a Rust application](./embedding.md) explains
them; the TypeScript functions are the same).

`log2` of `@kgdiff/core` is removed, with the TypeScript engine that used it; use `Math.log2`.
`@kgdiff/formats` keeps `FORMAT_EXTENSIONS` (synchronous) and its types; its TypeScript parsers
are removed, and its three functions run kgdiff's parsers (above).

### Two ways to migrate

**Await the call.** Put `await` in front of each function of the table, in an `async` function or
at the top level of a module:

```ts
import { diff } from '@kgdiff/core';
import { layoutDiff } from '@kgdiff/layout';

const result = await diff(before, after, options); // was: diff(before, after, options)
const layout = await layoutDiff(result);
```

The first call loads and compiles the module it needs (`compute.wasm` for `diff`, `layout.wasm`
for the layouts, `formats.wasm` for the parsers); later calls only run it.

**Initialize once, then call synchronously.** For a loop over many pairs, or code that must stay
synchronous, `await init()` of `@kgdiff/compute` once and use its `*Sync` functions, which return
the same objects:

```ts
import { init, diffSync, layoutDiffSync, parseGraphSync } from '@kgdiff/compute';

await init(); // all three modules; init({ modules: ['compute'] }) for some only
const result = diffSync(before, after, options);
const layout = layoutDiffSync(result);
```

A search and replace that finds the calls: `\b(diff|matchNodes|textSimilarity|parseGraph|detectFormat|compactIri|layoutDiff|extendLayout)\(`;
TypeScript then reports every place where a `Promise` is used as the value it resolves to.

## Workers

Initialize in the worker that computes: each worker compiles its own modules (`await init()`, or
the first asynchronous call). Pass the `kgdiff.diff` document between threads, as JSON text
(`json.diff` of `@kgdiff/compute`, or `JSON.stringify(diffToJSON(result))`), not `DiffResult`
objects, which hold maps and closures; read it on the other side with `diffFromJSON`, which is
synchronous.

## Bundlers and serving the `.wasm` files

`@kgdiff/compute` locates its modules with `new URL('../wasm/<module>.wasm', import.meta.url)`.
Vite, webpack 5, Rollup and Node 22 or later resolve it and copy the files as assets; esbuild needs
the `file` loader for `.wasm`. Serve them as `application/wasm`. To serve them from elsewhere,
pass their URLs or bytes: `init({ sources: { compute: url } })`. They are exported as
`@kgdiff/compute/compute.wasm`, `/formats.wasm` and `/layout.wasm`.

A bundle that only reads diffs (`diffFromJSON`, `layoutFromJSON`, the viewer showing a report)
contains no WebAssembly: the packages import `@kgdiff/compute` with a dynamic `import()` only when
a computing function is called.

## Content Security Policy

Compiling WebAssembly needs `'wasm-unsafe-eval'` in `script-src`, for example
`Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'`. A page showing a report with its
layout does not compile anything; expanding a collapsed group of a report laid out around its
changes does.

## Layouts

Positions are computed by kgdiff's Rust layout engine, the one the CLI has used since 0.7. For
the same input and options they are the positions 0.10's TypeScript engine computed: through
0.10 the conformance corpus checked on every case that the two engines agreed, and RFC 0002
records the same on synthetic graphs of 1,000 to 10,000 nodes, so a stored layout needs no
recomputing. What changes is the document: layouts written since 0.11 are layout documents of
version 2, with a `generator`; `layoutFromJSON` reads versions 1 and 2. Positions stored by 0.10 stay valid pins
(`pinned`, `layoutDiffOn`). Graphs whose nodes carry a `position` are still laid out anchored on
them: `diff` keeps the positions of its graphs on the nodes of the result.

## `@kgdiff/formats` is deprecated

Its functions are asynchronous wrappers over the parsers of `@kgdiff/compute` now. Since 0.11.1
`@kgdiff/core` exports everything it does (`parseGraph`, `detectFormat`, `compactIri`,
`FORMAT_EXTENSIONS` and the parsers' types), with the same signatures and results, so moving off it
means changing the import path only: `@kgdiff/formats` → `@kgdiff/core`. For the synchronous forms
(`parseGraphSync` and the others, after `init()`), use `@kgdiff/compute`. The types and
`FORMAT_EXTENSIONS` are the same declarations in every package: `@kgdiff/core` defines them,
`@kgdiff/compute` re-exports them, and so does `@kgdiff/formats`; no other kgdiff package depends
on it since 0.11.1. 1.0 is not published for `@kgdiff/formats`: 0.11.x stays on npm and keeps
working, so change the import before you upgrade the other packages to 1.0. `@kgdiff/cli` is no longer a
JavaScript library since 0.10: use `@kgdiff/compute` for the computations, the kgdiff CLI or the
`kgdiff-report` crate for reports.

## The viewer

`<kgdiff-viewer>`'s API is unchanged. `load()` parses, diffs and lays out on `@kgdiff/compute`.
The standalone add-on `kgdiff-viewer-compute.js` carries the layout-only module inlined, so a
single-file report expands collapsed groups offline; `load()` with graphs in the standalone viewer
also needs `@kgdiff/compute` in the page's import map, and so do text sources (in 0.11.0 they
imported `@kgdiff/formats`, which imports `@kgdiff/compute`).

## What does not change

- Every JSON document (graphs, diffs, packed diffs, deltas, layouts), every hash, hunk title,
  summary and delta is byte-identical to the CLI's, and to 0.10's except that layouts are written
  as version 2 documents (their positions are unchanged).
- Error codes and messages: failures are `KgdiffError`s with the same `code`.
- The read path stays synchronous and needs no WebAssembly: `normalize`, `isKGraph`,
  `graphToJSON`, `hashGraph`, `diffFromJSON`, `diffToJSON`, `packDiffJSON`, `unpackDiffJSON`,
  `applyDelta`, `invertDelta`, `formatHunk`, `facetLabel`, `predicateLabel`, `resolveOptions`,
  `layoutFromJSON`, `layoutToJSON`, `nodeRadius` and `estimateLabelWidth`.
- The scene, renderer, viewer and G6 packages.

## Support

0.x releases before 0.11 receive security fixes for six months after 0.11 is published.
