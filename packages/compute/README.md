# @kgdiff/compute

kgdiff's Rust diff engine, [`kgdiff-core`](../../crates/kgdiff-core), compiled to WebAssembly.
It produces the same bytes as the kgdiff CLI in every JavaScript engine.

> **Preview** of [RFC 0002](../../docs/rfcs/0002-rust-compute-core.md), phase 2. It covers the
> core only: diffs, node matching and text similarity. It is not published yet; the package is
> marked `private` until a preview release (`0.7.0-preview.N`) is made. The API will change before
> 1.0, where `@kgdiff/core`'s `diff` becomes asynchronous and delegates to this package
> (RFC 0002, §6).

```ts
import { init, diffSync, diffJSON } from '@kgdiff/compute';

await init(); // once; idempotent
const result = diffSync(before, after, { ignoreAttrs: ['updatedAt'] }); // a DiffResult
const document = diffJSON(before, after); // the kgdiff.diff document, as `kgdiff --json` writes it
```

## API

| Function                                  | What it does                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init(source?)`                           | Loads and compiles the engine. In Node it reads `wasm/kgdiff_compute_bg.wasm` from this package; elsewhere it fetches that file relative to the module, or loads `source` (a URL, a `Response`, bytes or a `WebAssembly.Module`).                       |
| `diffSync(before, after, options?)`       | `diff` of `@kgdiff/core`, computed by the engine. It returns a `DiffResult` (read with `diffFromJSON`, every consistency check included).                                                                                                               |
| `diffJSON(before, after, options?)`       | The `kgdiff.diff` document as text, in one call (`diff`, then `diffToJSON`).                                                                                                                                                                            |
| `matchNodesSync(before, after, options?)` | `matchNodes` on the two graphs, each normalized with the default options.                                                                                                                                                                               |
| `textSimilaritySync(a, b)`                | `textSimilarity`.                                                                                                                                                                                                                                       |
| `version()`                               | The version of the kgdiff crates the engine was built from.                                                                                                                                                                                             |
| `json.*`                                  | The engine's other JSON-text entry points: normalize, issues, hash, apply and invert deltas, pack and unpack, hunk titles. `@kgdiff/core` keeps TypeScript versions of these; they are here so the build can be checked against the conformance corpus. |

Graphs and options can be given as objects or as JSON text. An object is written with
`JSON.stringify`, so values that JSON cannot hold (NaN, ±Infinity) arrive as `null`. Failures are
`KgdiffError`s of `@kgdiff/core`, with their `code` and `details`.

## Building

```sh
pnpm --filter @kgdiff/compute build:wasm   # cargo, wasm-bindgen, wasm-opt -Oz → wasm/
pnpm --filter @kgdiff/compute build        # the TypeScript entry point → dist/
pnpm vitest run --project compute          # the corpus and the API against the build
```

`build:wasm` needs:

- the toolchain of `rust-toolchain.toml`, with its `wasm32-unknown-unknown` target;
- the wasm-bindgen CLI, at the exact version `crates/kgdiff-wasm` pins;
- `wasm-opt` from binaryen.

It finds them on `PATH`, or where `WASM_BINDGEN` and `WASM_OPT` point. It prints the sizes and
fails when the module exceeds its limit. Without a build, the package's tests are skipped (CI's
`compute` job sets `KGDIFF_COMPUTE`, so that they fail instead).

## Size and speed

Measured on 2026-11-09 (macOS, Apple M-class, Node 24) from `main`, before
[#56](https://github.com/iiwish/kgdiff/pull/56):

| What                                                             | Measured                                                                                  | RFC 0002 §7                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `kgdiff_compute_bg.wasm` (opt-level `z`, `wasm-opt -Oz`)         | 774.5 KiB, **306.2 KiB gzip**                                                             | full engine with the layout, after phase 5: < 250 kB gzip |
| glue (`kgdiff_compute.js`)                                       | 18.9 KiB, 2.9 KiB gzip                                                                    |                                                           |
| `diffJSON`, 10k nodes / 30k edges (parsing and writing included) | median ~214 ms (load average 8); opt-level 3 instead: ~145 ms, 451 KiB gzip               | < 80 ms; < 150 ms including the transport                 |
| `normalize` 100k / 300k, linear memory                           | 402 MiB high-water mark, holding the input text, the parsed graph and the output together | < 80 MB                                                   |

The preview does not meet §7's WebAssembly targets yet. About 80% of the module is code, much of
it generic code instantiated many times (sorts and maps in particular). The rest is data: ICU's
tables and the strings.
