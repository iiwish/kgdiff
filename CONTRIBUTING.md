# Contributing to kgdiff

Thanks for helping make graph changes reviewable.

## Setup

```sh
pnpm install
pnpm --filter @kgdiff/compute build:wasm   # once, and after a change under crates/
pnpm check        # lint + typecheck + test
pnpm dev:site     # landing page and playground
pnpm dev:docs     # documentation site (docs/)
```

Since 0.11 kgdiff's engine (diff, parsers, layout) exists only in Rust, so the tests that compute
a diff or a layout, of the read path and the viewer included, run it from its WebAssembly build
in `packages/compute/wasm/`. Build it once before `pnpm test`, whatever you change: without it,
those test files fail with a message that names the command, and none of them is skipped. The
build needs the Rust toolchain below, the wasm-bindgen CLI at the version `crates/kgdiff-wasm`
pins and `wasm-opt` (binaryen), found on `PATH` or through `WASM_BINDGEN` and `WASM_OPT`
([`@kgdiff/compute`](packages/compute/README.md#building)). The modules CI built for a commit
can be used instead: they are the `compute-wasm` artifact of its CI run (`gh run download <run>
-n compute-wasm -D packages/compute`).

Node.js ≥ 22 (the `engines` range; CI tests 22, 24 and 26 on Linux, and 24 on Windows and
macOS) and pnpm 11 (`packageManager`; `corepack enable` installs the pinned version).

More commands:

```sh
pnpm bench                            # performance budgets (vitest bench), not part of `check`
pnpm build && pnpm check:packages     # what `pnpm publish` would ship: publint, attw, source maps
pnpm build && pnpm api:check          # the API reports match the built declarations (see below)
pnpm build && pnpm api:update         # write the API reports again
pnpm changeset                        # describe a change to a published package (see below)
```

The Rust workspace (`crates/`, [RFC 0002](docs/rfcs/0002-rust-compute-core.md)) needs
[rustup](https://rustup.rs); the first `cargo` command installs the toolchain that
`rust-toolchain.toml` pins. Contributors who only touch TypeScript need it only for the
WebAssembly build above (or CI's artifact instead).

```sh
cargo test --workspace                          # the crates' tests and the conformance corpus
cargo test -p kgdiff-core --test conformance    # which parts of the corpus kgdiff-core passes
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
cargo deny check                                # licenses, advisories, duplicates (.cargo/deny.toml)
cargo bench -p kgdiff-core                      # the native targets of RFC 0002 §7
pnpm build:viewer-assets                        # the viewer bundles the Rust HTML reports embed
cargo test -p kgdiff-report --features embed-viewer
```

The conformance corpus is generated in Rust (`conformance/README.md`, "Changing the corpus"):

```sh
pnpm build:viewer-assets                        # once: the viewer bundles kgdiff's reports embed
cargo xtask conformance                         # regenerate it (also `pnpm conformance:update`)
cargo xtask conformance --check                 # compare it with the files instead of writing
cargo build --release -p kgdiff && pnpm conformance:replay
```

### Fuzzing

`fuzz/` holds [cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html) targets for what
kgdiff reads from untrusted files: `parse_graph` (every format, and auto-detection), `detect_format`,
`json_parse`, `diff_from_json`, `unpack_diff_json`, `delta` (read, invert, apply) and `diff`. It is
outside the workspace, so `cargo build` and `cargo test` never need it. It needs a nightly
toolchain and `cargo install cargo-fuzz --locked`.

```sh
cd fuzz
./seed-corpus.sh                                        # seeds from conformance/ and examples/datasets/
cargo +nightly fuzz run parse_graph -- -max_total_time=300 -timeout=10 -rss_limit_mb=2048
cargo +nightly fuzz run parse_graph artifacts/parse_graph/crash-…   # replay one finding
```

A crash, a hang (`-timeout`) or an out-of-memory (`-rss_limit_mb`) leaves its input in
`fuzz/artifacts/<target>/`. Fix it and add the input as a regression test in the crate's `tests/`
(it has to pass in the normal `cargo test`). The `Fuzz` workflow runs every target weekly and on
demand (Actions → Fuzz → Run workflow) and uploads the inputs that failed.

## Where things live

- `packages/core`: the diff engine. Start with `src/types.ts` and `docs/algorithms.md`.
- `packages/layout`, `packages/scene`, `packages/renderer`: layout, visual model, Canvas engine.
- `packages/viewer`: the `<kgdiff-viewer>` web component.
- `packages/g6`: the AntV G6 adapter.
- `crates/kgdiff`: the `kgdiff` command; `packages/cli`: its npm launcher (`npx @kgdiff/cli`).
- `action.yml`, `action/`: the GitHub Action (`uses: iiwish/kgdiff@v0`); its tests run in
  `pnpm test`, and `.github/workflows/action.yml` runs it on the example datasets.
- `apps/site`: landing page and playground. `examples/datasets`: demo and acceptance data.
- `conformance/`: the language-neutral conformance corpus — inputs, options and the expected
  diffs, deltas, hashes and CLI outputs of every case ([README](conformance/README.md)). The
  Rust crates generate it (`cargo xtask conformance`, from `conformance/definitions.json`) and
  `cargo test` checks them against it; `pnpm test` checks the TypeScript read path against it.
  After an intended behaviour change, regenerate it; its diff is part of the review.
- `crates/`: the Rust port of the compute packages ([RFC 0002](docs/rfcs/0002-rust-compute-core.md)),
  checked against `conformance/`. `clippy.toml` forbids the methods and types whose Rust
  defaults differ from JavaScript; everything JavaScript-specific lives in `kgdiff_core::js`.
- `docs/`: architecture, algorithms, visual language, interaction, delta format, CLI.

## Ground rules

- Read `docs/architecture.md` first; contracts in each package's `src/index.ts` change only
  together with the docs.
- Every change passes `docs/review-checklist.md`.
- Determinism is a feature: no `Math.random` or wall-clock time in results.
- Tests are the specification: name them after behaviour, cover edge cases, add property tests
  where an invariant exists.
- Unit tests never assert wall-clock times: they run in parallel, under coverage and on slow CI
  machines. Timings go in `test/*.bench.ts` (`pnpm bench`), next to the budgets in
  `docs/architecture.md`.
- No new runtime dependency without a short justification in the PR.

## Changesets and releases

Every pull request that changes a published package (`kgdiff`, `@kgdiff/*`) adds a changeset:
run `pnpm changeset`, pick the bump (all packages share one version) and describe the change for
the changelog. Before 1.0, which kgdiff is until its [conditions](README.md#roadmap) are met,
pick `patch` for fixes and additions and `minor` for a breaking change (`major` is not used);
CI's cargo-semver-checks and the API reports fail a break under a `patch` changeset. Docs-,
test- and tooling-only changes need none. On `main`, the release workflow
collects the changesets into a "Version Packages" pull request; merging it publishes to npm.
Details: [docs/releasing.md](docs/releasing.md).

Each entry point of a published npm package has an API report, `packages/<name>/api/*.api.md`:
its exported names and type signatures as the built declarations have them, written by
[API Extractor](https://api-extractor.com/), with `// @experimental` and `// @deprecated` above
the items marked so. CI fails when a report differs from the build (`pnpm api:check`), so a
change to the public types is visible in review. When a report changes, the pull request changes
the public API: check that the change is meant, run `pnpm build && pnpm api:update`, commit the
reports and say in the changeset what changed. Lines added to a report are additions; lines
removed or changed break code that uses them. From 1.0 on, a removal or a change in a report
outside the items marked `// @experimental` is a breaking change and needs a major release of
every package ([docs/versioning.md](docs/versioning.md)); before 1.0 it is a `minor` one. Doc
comments are left out of the reports, so a documentation fix does not change them.

## Commit messages

Conventional style: `feat(core): detect splits from replaces hints`, `fix(renderer): …`,
`docs: …`, `test(layout): …`.
