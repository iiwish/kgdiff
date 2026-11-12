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

It is the binary npm's [`@kgdiff/cli`](https://www.npmjs.com/package/@kgdiff/cli) runs. Every CLI
run of the conformance corpus is replayed against it on Linux, macOS and Windows
(`pnpm conformance:replay`): the same arguments give the same messages, outputs and exit codes on
each. `docs/cli.md` in the repository lists every option.

HTML reports carry the layout of [`kgdiff-layout`](https://crates.io/crates/kgdiff-layout) and
open instantly; the viewer's compute add-on is inlined only for layouts that cover just the
changes of a large graph, and `--no-compute` leaves it out. The viewer bundles are compiled in by
the feature `embed-viewer` (on by default) after `pnpm build:viewer-assets` in the repository; a
build without them works for everything but `-o` / `--open`, which then names the missing step.

As a library, `kgdiff::cli::run(argv, io)` runs the command line against any
`kgdiff::io::CliIo`, so that a host can embed kgdiff; `kgdiff::testing::MemoryIo` keeps files and
streams in memory:

```rust
use kgdiff::testing::MemoryIo;

let mut io = MemoryIo::new("/work")
    .file("a.json", r#"{"nodes":[{"id":"ada","label":"Ada"}],"edges":[]}"#)
    .file("b.json", r#"{"nodes":[{"id":"ada","label":"Ada Lovelace"}],"edges":[]}"#);
let code = kgdiff::cli::run(&["a.json".into(), "b.json".into(), "--name-status".into()], &mut io);
assert_eq!(code, 0);
assert_eq!(io.stdout, "R	ada	Renamed “Ada” → “Ada Lovelace”
");
```

Licensed under the MIT license.
