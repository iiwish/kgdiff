# @kgdiff/compute

kgdiff's Rust engine compiled to WebAssembly: diff, graph file parsers and layout. It gives the
same bytes as the kgdiff CLI in every JavaScript engine.

The engine is three modules, and each is loaded only when it is asked for
([RFC 0002, §7](../../docs/rfcs/0002-rust-compute-core.md#7-size-and-performance-budgets)):

| Module         | What it holds                                                                        | Loaded by                                          |
| -------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `compute.wasm` | diff, node matching, normalization, and the layout of new diffs                      | `diffSync`, `matchNodesSync`, `diffAndLayoutSync`… |
| `formats.wasm` | the parsers: kgdiff JSON and five other JSON shapes, RDF, OBO                        | `parseGraphSync`, `detectFormatSync`               |
| `layout.wasm`  | the layout of a `DiffResult`, on typed arrays, without JSON or Unicode normalization | `layoutDiffSync`, `extendLayoutSync`…              |

The other kgdiff packages do not use it yet: in kgdiff 1.0, `diff` of `@kgdiff/core`,
`parseGraph` of `@kgdiff/formats` and `layoutDiff` of `@kgdiff/layout` become asynchronous and
delegate to it ([RFC 0002, §6](../../docs/rfcs/0002-rust-compute-core.md#6-api-changes-and-versions)).

```ts
import { init, diffSync, layoutDiffSync, parseGraphSync } from '@kgdiff/compute';

await init(); // the three modules, once; idempotent
const before = parseGraphSync(beforeText, { filename: 'before.ttl' }).graph;
const after = parseGraphSync(afterText, { filename: 'after.ttl' }).graph;
const diff = diffSync(before, after, { ignoreAttrs: ['updatedAt'] }); // a DiffResult
const layout = layoutDiffSync(diff); // a LayoutResult of @kgdiff/layout
```

`init({ modules: ['compute'] })` loads only the modules named. The asynchronous functions load
their module themselves:

```ts
import { diff, parseGraph } from '@kgdiff/compute';

const { graph } = await parseGraph(text); // loads formats.wasm on first use
const result = await diff(before, graph); // loads compute.wasm on first use
```

An application that only lays out diffs it already has, such as an HTML report expanding a
collapsed group, imports `@kgdiff/compute/layout`: it never loads, or bundles, the other two
modules.

```ts
import { init, extendLayoutSync } from '@kgdiff/compute/layout';

await init(inlinedBytes); // or no argument: fetched next to the module
const grown = extendLayoutSync(diff, layout, ['new-node']);
```

## API

Every `*Sync` function needs its module loaded and throws otherwise. Each has an asynchronous
twin without the suffix (`diff`, `matchNodes`, `textSimilarity`, `parseGraph`, `detectFormat`,
`compactIri`, `layoutDiff`, `extendLayout`, `layoutGraph`, `layoutDiffOn`, `layoutAfter`,
`diffAndLayout`), which loads the module first.

| Function                                              | Module    | What it does                                                                                                                                                                                                     |
| ----------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init({ modules?, sources? })`                        | —         | Loads and compiles modules (default: all three). `sources` gives a module's URL, bytes, `Response` or `WebAssembly.Module`.                                                                                      |
| `diffSync(before, after, options?)`                   | `compute` | `diff` of `@kgdiff/core`: the `kgdiff.diff` document read with `diffFromJSON`, every check included.                                                                                                             |
| `diffJSON(before, after, options?)`                   | `compute` | The `kgdiff.diff` document as text, as `kgdiff --json` writes it.                                                                                                                                                |
| `matchNodesSync(before, after, options?)`             | `compute` | `matchNodes` on the two graphs, each normalized with the default options.                                                                                                                                        |
| `textSimilaritySync(a, b)`                            | `compute` | `textSimilarity`.                                                                                                                                                                                                |
| `diffAndLayoutSync(before, after, options?, layout?)` | `compute` | `{ diff, layout }` in one call, for an application that starts from graphs.                                                                                                                                      |
| `parseGraphSync(text, options?)`                      | `formats` | `parseGraph` of `@kgdiff/formats`, `jsonld.documentLoader` included.                                                                                                                                             |
| `detectFormatSync(text, filename?)`                   | `formats` | `detectFormat`.                                                                                                                                                                                                  |
| `compactIriSync(iri, prefixes?)`                      | `formats` | `compactIri`.                                                                                                                                                                                                    |
| `layoutDiffSync(diff, options?)`                      | `layout`  | `layoutDiff` of `@kgdiff/layout`, on the Rust engine.                                                                                                                                                            |
| `extendLayoutSync(diff, layout, nodes, options?)`     | `layout`  | `extendLayout`: adds nodes without moving any node placed.                                                                                                                                                       |
| `layoutGraphSync(graph, options?)`                    | `layout`  | The layout of one graph (`layout_graph` of the `kgdiff-layout` crate); a `GraphInput` is normalized first.                                                                                                       |
| `layoutDiffOnSync(diff, previous, options?)`          | `layout`  | The diff on the map of its before version (`layout_diff_on`).                                                                                                                                                    |
| `layoutAfterSync(diff, layout, options?)`             | `layout`  | The after version on the map of the diff (`layout_after`).                                                                                                                                                       |
| `estimateLabelWidthSync`, `nodeRadiusSync`            | `layout`  | As `@kgdiff/layout` has them.                                                                                                                                                                                    |
| `version()`                                           | any       | The version of the kgdiff crates the modules were built from.                                                                                                                                                    |
| `json.*`                                              | each      | The low-level interface, JSON text in and out: `diff`, `matchNodes`, `normalize`, `issues`, `hashGraph`, `diffLayout`, `layoutGraph`, `parseGraph`, `layoutDiff`, `extendLayout`, `layoutDiffOn`, `layoutAfter`. |

Graphs and options can be given as objects or as JSON text. An object is written with
`JSON.stringify`, so values that JSON cannot hold (NaN, ±Infinity) arrive as `null`. Failures are
`KgdiffError`s of `@kgdiff/core`, with their `code` and `details`.

A `kgdiff.diff` document carries no node `position`. A `DiffResult` read from one (as `diffSync`
returns it) therefore lays out without the positions the graphs had; pass them as
`options.pinned`, or lay out with `diffAndLayoutSync`, which keeps them.

## Bundlers, servers and Content Security Policy

The modules are located with `new URL('../wasm/<module>.wasm', import.meta.url)`, which Vite,
webpack 5, Rollup, esbuild (with a `file` loader for `.wasm`) and Node ≥ 22 understand: the
bundler copies the three files as assets, and a page fetches only the ones it uses. A server must
send them as `application/wasm`. They are also exported as `@kgdiff/compute/compute.wasm`,
`/formats.wasm` and `/layout.wasm`, for an application that serves them itself and passes their
URL to `init({ sources })`.

Compiling WebAssembly needs `'wasm-unsafe-eval'` in the page's `script-src`:

```http
Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'
```

## Building

```sh
pnpm --filter @kgdiff/compute build:wasm   # the three modules → wasm/, the corpus build → test/wasm/
pnpm --filter @kgdiff/compute build        # the TypeScript entry points → dist/
pnpm vitest run --project compute          # the corpus and the API against the build
```

`build:wasm` builds `crates/kgdiff-wasm` once per module, with its `engine`, `parsers` or `layout`
feature, and once more with `corpus` for the tests (the read path of `kgdiff-core`, which the
browser keeps in TypeScript). It needs:

- the toolchain of `rust-toolchain.toml`, with its `wasm32-unknown-unknown` target (only what the
  stable toolchain supports: no `-Z` flags);
- the wasm-bindgen CLI, at the exact version `crates/kgdiff-wasm` pins;
- `wasm-opt` from binaryen.

It finds them on `PATH`, or where `WASM_BINDGEN` and `WASM_OPT` point. It prints the sizes and
fails when a module exceeds its limit. It also writes the hashes of the native layouts of the
corpus, which the tests compare the WebAssembly layouts with. Without a build, the package's
tests are skipped (CI's `compute` job sets `KGDIFF_COMPUTE`, so that they fail instead).

## Size and speed

Sizes are gzip level 9, in KiB (1,024 bytes), module and glue together; the glue of `layout` is
`@kgdiff/compute/layout` bundled and minified, as a report inlines it. Every module is built at
cargo opt-level `z` on the stable toolchain.

| Module         | `.wasm`   | gzip, with glue | Budget (1.0)          | CI limit |
| -------------- | --------- | --------------- | --------------------- | -------- |
| `layout.wasm`  | 216.4 KiB | 90.9 KiB        | 45 KiB, being raised  | 91 KiB   |
| `compute.wasm` | 791.6 KiB | 303.9 KiB       | 350 KiB               | 350 KiB  |
| `formats.wasm` | 621.8 KiB | 253.3 KiB       | 200 KiB, being raised | 254 KiB  |

A CI limit at a module's measured size makes a regression fail the build.

Speed, measured on 2026-11-11 (macOS, Apple M-class, Node 24, load average 5 to 7), medians:

| What                                        | Measured | Target (1.0)          |
| ------------------------------------------- | -------- | --------------------- |
| `diffSync` (with the transport), 10k / 30k  | 227 ms   | < 150 ms              |
| `diffSync`, 100k / 300k                     | 3.0 s    | < 2 s                 |
| `json.diff`, 10k / 30k                      | 139 ms   | (reported, no target) |
| `json.diff`, 100k / 300k                    | 1.78 s   | (reported, no target) |
| `json.normalize` 100k / 300k, linear memory | 265 MiB  | measured only         |
| similarity matching, 5k unmatched per side  | 269 ms   | < 800 ms              |
| `layoutDiffSync`, 2k nodes                  | 592 ms   | < 450 ms              |
| `parseGraphSync`, 50k Turtle triples        | 183 ms   | < 250 ms              |

The transport (`JSON.parse` and `diffFromJSON` of `@kgdiff/core`) takes about 70 ms of the 10k
diff and about 1 s of the 100k one.

The engine at each opt-level (alternating runs, load average about 5; gzip of the `.wasm`):

| Build of `compute.wasm` | gzip      | `json.diff` 10k | with transport | `json.diff` 100k | with transport |
| ----------------------- | --------- | --------------- | -------------- | ---------------- | -------------- |
| `z` (shipped)           | 301.4 KiB | 144 ms          | 207 ms         | 1.93 s           | 2.99 s         |
| `s`                     | 363.1 KiB | 114 ms          | 181 ms         | 1.60 s           | 2.49 s         |
| `z`, kgdiff-core at `s` | 355.5 KiB | 115 ms          | 183 ms         | 1.51 s           | 2.83 s         |
| `z`, kgdiff-core at `2` | 370.6 KiB | 91 ms           | 158 ms         | 1.38 s           | 2.37 s         |
| `2`                     | 389.1 KiB | 90 ms           | 160 ms         | 1.26 s           | 2.20 s         |
| `3`                     | 435.1 KiB | 90 ms           | 160 ms         | 1.19 s           | 2.13 s         |

Only `z` is within the 350 KiB budget.
