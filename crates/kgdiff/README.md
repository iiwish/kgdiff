# kgdiff

`git diff` for knowledge graphs: the [kgdiff](https://github.com/iiwish/kgdiff) command line in
Rust. It reads two versions of a graph — kgdiff JSON and five other JSON graph shapes, RDF
(Turtle, N-Triples, N-Quads, TriG, RDF/XML, JSON-LD) or OBO, gzip-compressed or not — and prints a
summary, `--stat`, `--name-status`, `--json`, a `--delta` for `kgdiff apply`, GitHub Markdown, or
writes a self-contained interactive HTML report.

```sh
kgdiff v12.json v13.json                         # coloured summary
kgdiff old.obo new.obo -o report.html --open     # interactive report
kgdiff a.ttl b.ttl --markdown >> "$GITHUB_STEP_SUMMARY"
kgdiff a.json b.json --delta patch.json && kgdiff apply a.json patch.json -o b.json
```

It is a drop-in for the TypeScript CLI [`@kgdiff/cli`](https://www.npmjs.com/package/@kgdiff/cli):
the same arguments, messages, outputs and exit codes, byte for byte. Every CLI run the
conformance corpus records is replayed against it (`pnpm conformance:replay --bin
target/release/kgdiff`), and the CLI's test suites are ported (`cargo test -p kgdiff`).

Part of [RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md):
HTML reports carry the layout of [`kgdiff-layout`](https://crates.io/crates/kgdiff-layout) and
open instantly; the viewer's compute add-on is inlined only for layouts that cover just the
changes of a large graph, and `--no-compute` leaves it out. The viewer bundles are compiled in by
the feature `embed-viewer` (on by default) after `pnpm build:viewer-assets` in the repository; a
build without them works for everything but `-o` / `--open`, which then names the missing step.

As a library, `kgdiff::cli::run(argv, io)` runs the command line against any
`kgdiff::io::CliIo`; `kgdiff::testing::MemoryIo` keeps files and streams in memory.

Licensed under the MIT license.
