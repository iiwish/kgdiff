# pykgdiff

**git diff for knowledge graphs.** Compare two versions of a graph — RDF, OBO or JSON — in the
terminal, in CI, or as a single-file interactive HTML report. kgdiff understands what changed:
a merge is a merge, a rename is a rename, a moved class is a move.

```sh
pipx install pykgdiff                    # or: pip install pykgdiff, uv tool install pykgdiff
kgdiff before.ttl after.ttl

uvx --from pykgdiff kgdiff before.ttl after.ttl   # without installing
```

This package is the **kgdiff command line**, nothing else: a wheel per platform that holds the
native `kgdiff` binary (written in Rust, no Python code runs), the same binary as the npm package
`@kgdiff/cli` and the GitHub release. Installing it puts `kgdiff` on your `PATH`; it needs no
Node.js and no Rust. There is no Python API yet: `import pykgdiff` and `python -m pykgdiff` are
reserved for one, planned after kgdiff 1.0. The command line follows kgdiff's
[versioning promise](https://github.com/iiwish/kgdiff/blob/main/docs/versioning.md).

Wheels exist for macOS (Apple silicon, Intel), Linux x64 and Arm64 (glibc and musl) and
Windows x64. On another platform, `cargo install kgdiff` builds the same program from source.

## Usage

```
kgdiff <before> <after> [options]
kgdiff apply <graph> <delta> [-o <file>] [--no-strict [--verbose]]
kgdiff --help | --version
```

```sh
kgdiff v12.json v13.json                          # colored summary
kgdiff old.obo new.obo -o report.html --open      # interactive report, opened in the browser
kgdiff a.ttl b.ttl --stat                         # diffstat only
kgdiff a.json b.json --json diff.json             # full machine-readable diff
kgdiff a.ttl b.ttl --exit-code --quiet            # exit 1 when the graphs differ
```

Inputs are JSON (kgdiff, d3 / NetworkX, Cytoscape.js, G6, graphology, vis-network), JSON-LD,
Turtle, N-Triples, N-Quads, TriG, RDF/XML and OBO, detected from the extension and the content.

The full guide to the command line: https://github.com/iiwish/kgdiff/blob/main/docs/cli.md

## License

MIT
