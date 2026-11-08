# Contributing to kgdiff

Thanks for helping make graph changes reviewable.

## Setup

```sh
pnpm install
pnpm check        # lint + typecheck + test
pnpm dev:site     # landing page and playground
pnpm dev:docs     # documentation site (docs/)
```

Node.js ≥ 22 (the `engines` range; CI tests 22, 24 and 26 on Linux, and 24 on Windows and
macOS) and pnpm 11 (`packageManager`; `corepack enable` installs the pinned version).

More commands:

```sh
pnpm bench                            # performance budgets (vitest bench), not part of `check`
pnpm build && pnpm check:packages     # what `pnpm publish` would ship: publint, attw, source maps
pnpm changeset                        # describe a change to a published package (see below)
```

The Rust workspace (`crates/`, [RFC 0002](docs/rfcs/0002-rust-compute-core.md)) needs
[rustup](https://rustup.rs); the first `cargo` command installs the toolchain that
`rust-toolchain.toml` pins. Contributors who only touch TypeScript need none of it.

```sh
cargo test --workspace                          # the crates' tests and the conformance corpus
cargo test -p kgdiff-core --test conformance    # which parts of the corpus kgdiff-core passes
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
cargo deny check                                # licenses, advisories, duplicates (deny.toml)
```

## Where things live

- `packages/core`: the diff engine. Start with `src/types.ts` and `docs/algorithms.md`.
- `packages/formats`: RDF / OBO / JSON parsers.
- `packages/layout`, `packages/scene`, `packages/renderer`: layout, visual model, Canvas engine.
- `packages/viewer`: the `<kgdiff-viewer>` web component.
- `packages/g6`: the AntV G6 adapter.
- `packages/cli`: the `kgdiff` command.
- `action.yml`, `action/`: the GitHub Action (`uses: iiwish/kgdiff@v0`); its tests run in
  `pnpm test`, and `.github/workflows/action.yml` runs it on the example datasets.
- `apps/site`: landing page and playground. `examples/datasets`: demo and acceptance data.
- `conformance/`: the language-neutral conformance corpus — inputs, options and the expected
  diffs, deltas, hashes and CLI outputs of every case ([README](conformance/README.md)). It runs
  in `pnpm test`; after an intended behaviour change, `pnpm conformance:update` regenerates it
  and its diff is part of the review.
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
the changelog. Docs-, test- and tooling-only changes need none. On `main`, the release workflow
collects the changesets into a "Version Packages" pull request; merging it publishes to npm.
Details: [docs/releasing.md](docs/releasing.md).

## Commit messages

Conventional style: `feat(core): detect splits from replaces hints`, `fix(renderer): …`,
`docs: …`, `test(layout): …`.
