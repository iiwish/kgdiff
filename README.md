<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html"><img src="docs/images/replay-en.webp" alt="The kgdiff viewer replaying the changes between two versions of a schema.org-style vocabulary, one hunk at a time" width="880"></a>
</p>

<h1 align="center">kgdiff</h1>

<p align="center">
  <b>git diff for knowledge graphs.</b><br>
  See what changed between two versions of a graph — and review it like a pull request.
</p>

<p align="center">
  <a href="https://github.com/iiwish/kgdiff/actions/workflows/ci.yml"><img src="https://github.com/iiwish/kgdiff/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@kgdiff/cli"><img src="https://img.shields.io/npm/v/@kgdiff/cli?label=npm&color=3B5BDB" alt="npm"></a>
  <a href="https://crates.io/crates/kgdiff"><img src="https://img.shields.io/crates/v/kgdiff?color=3B5BDB" alt="crates.io"></a>
  <a href="https://iiwish.github.io/kgdiff/docs/"><img src="https://img.shields.io/badge/docs-English%20%C2%B7%20%E4%B8%AD%E6%96%87-3B5BDB" alt="Documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3B5BDB" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html"><b>Try it in your browser</b></a> ·
  <a href="https://iiwish.github.io/kgdiff/docs/getting-started">Get started</a> ·
  <a href="https://iiwish.github.io/kgdiff/docs/">Docs</a> ·
  <a href="https://iiwish.github.io/kgdiff/">Website</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

---

AI systems now write and rewrite knowledge graphs: GraphRAG pipelines, agent memories, ontology
assistants, semantic layers. Someone has to review those changes. Text diffs show triples
appearing and disappearing; most visual tools recolor nodes on a fresh force layout, so
everything jumps. **kgdiff shows what actually happened** — a merge, a rename, a class moved
under a new parent, a relation that now points somewhere else — on one stable map, in a viewer
built for review.

```sh
npx @kgdiff/cli before.ttl after.ttl -o report.html --open
```

Or install nothing: the [playground](https://iiwish.github.io/kgdiff/playground.html) diffs the
example datasets, or two files of your own, in your browser. Nothing is uploaded.

## Why not a text diff?

Two releases of a [schema.org-style vocabulary](examples/datasets/schema-vocab), in Turtle.
This is what `git` can tell you:

```console
$ git diff --no-index --stat before.ttl after.ttl
 before.ttl => after.ttl | 68 +++++++++++++++++++++++++++++++++++++++----------
 1 file changed, 54 insertions(+), 14 deletions(-)
```

and this is what kgdiff tells you, one line per decision a reviewer has to make (the node ids
are cut out here to fit):

```console
$ kgdiff before.ttl after.ttl --name-status | cut -f1,3
G	Merged “Code” into “Software source code”
G	Merged “employees” into “employee”
E	Added “Review” —itemReviewed→ “Thing”
M	Updated synonyms of “Corporation”
M	Updated attributes of “Dataset”
M	Updated attributes of “Event”
R	Renamed “NGO” → “Non-governmental organization”
R	Renamed “Scholarly artcle” → “Scholarly article”
A	Added “Food establishment”, “Cafe or coffee shop” and 2 relations
V	Moved “Restaurant” under “Food establishment”
M	Edited “serves cuisine”
A	Added “Social media posting”, “Discussion forum posting” and 2 relations
V	Moved “Blog posting” under “Social media posting”
A	Added “Virtual location” and 2 relations
```

`G` merged, `R` renamed, `V` moved, `E` relations, `M` modified, `A` added. The same graph
written as N-Triples, with its statements in another order or its prefixes renamed, diffs as
identical: kgdiff compares graphs, not files.

## Four ideas

- **Semantic, not syntactic.** Nodes are matched across versions — by id, by replacement hints
  such as OBO `replaced_by`, or by label and neighbourhood when ids mean nothing, as in two LLM
  extraction runs — and every change gets a name: rename, rekey, types, synonyms, attributes,
  deprecation, hierarchy move, merge, split, retarget, predicate change.
- **One mental map.** Both versions share one deterministic, label-aware layout. Nothing moves
  unless it changed; removed things stay where they were, as hollow ghosts.
- **Color is meaning.** Five families and nothing else — added, removed, content, structure,
  identity — plus gray for context. Every color has a non-color cue too, and a color-blind-safe
  palette is built in.
- **Review is a workflow.** Changes are grouped into hunks in dependency order. Step through
  them, replay the before → after morph, mark them reviewed, and export the invertible delta.

<p align="center">
  <img src="docs/images/viewer-en.webp" alt="The kgdiff viewer: both versions on one map, changes colored by kind, and the list of changes to review" width="880">
</p>

## Quick start

### In the terminal

```sh
npx @kgdiff/cli v12.json v13.json                 # colored summary
npx @kgdiff/cli old.obo new.obo --stat            # diffstat
npx @kgdiff/cli a.ttl b.ttl -o report.html        # single-file interactive report, works offline
npx @kgdiff/cli a.ttl b.ttl --exit-code -q        # exit 1 when the graphs differ
```

kgdiff is a native program for macOS, Linux (glibc and musl) and Windows. `npx` needs
Node.js ≥ 22 and installs the binary for your machine. Without Node.js, the same binary comes
from PyPI as `pykgdiff` (the command line only), or build it with `cargo install kgdiff`:

```sh
pipx install pykgdiff                             # or: uv tool install pykgdiff, pip install pykgdiff
uvx --from pykgdiff kgdiff a.ttl b.ttl            # run it without installing
```

<p align="center">
  <img src="docs/images/terminal-en.webp" alt="kgdiff's terminal summary of an OBO ontology release: merges, moves, a split, renames and additions, colored by kind of change" width="720">
</p>

Every option: [CLI reference](docs/cli.md). With `git diff` and `git difftool`:
[Use kgdiff with git](docs/guide/git.md).

### On pull requests

```yaml
jobs:
  kgdiff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # the comment
    steps:
      - uses: actions/checkout@v7
      - uses: iiwish/kgdiff@v0
        with:
          files: ontology/*.ttl
```

The action compares each file with its version on the base branch, writes the summary into the
job summary and into a pull request comment that later pushes update in place, and uploads the
interactive report as an artifact. Pull requests from forks get the job summary and the report.
Options, several graphs, failing the check: [Review changes in CI](docs/guide/ci.md).

### In a web page

```html
<kgdiff-viewer theme="auto" locale="en" style="height: 640px"></kgdiff-viewer>
<script type="module">
  import '@kgdiff/viewer';
  const viewer = document.querySelector('kgdiff-viewer');
  await viewer.load({
    before: { text: await (await fetch('v1.ttl')).text(), filename: 'v1.ttl' },
    after: { text: await (await fetch('v2.ttl')).text(), filename: 'v2.ttl' },
  });
</script>
```

Three ways to compare — _Overlay_, _Swipe_ (drag a divider between before and after) and
_Replay_ (the old graph morphs into the new one, hunk by hunk) — each with or without _Changes
only_; a searchable change list, a detail panel with character-level diffs, review progress,
deep links, keyboard shortcuts, light and dark themes, English and Chinese. Use the whole
viewer, or [compose your own layout](docs/guide/viewer.md#compose-your-own-layout) from its
elements. Behaviour and events: [Viewer: interaction and API](docs/interaction.md).

### In code

```ts
import { diff, formatHunk, parseGraph } from '@kgdiff/core';

const before = (await parseGraph(beforeText, { filename: 'v1.obo' })).graph;
const after = (await parseGraph(afterText, { filename: 'v2.obo' })).graph;
const result = await diff(before, after);

for (const hunk of result.hunks) console.log(formatHunk(hunk, result, 'en').title);
// Merged “juvenile diabetes” and “insulin-dependent diabetes mellitus” into “type 1 diabetes mellitus”
// Merged “heart attack” into “myocardial infarction”
// …
```

`npm install @kgdiff/core` is all it takes. The engine is written in Rust; in JavaScript it runs
as WebAssembly (`@kgdiff/compute`, loaded on the first call), with the same bytes out as the CLI.
[Use the engine in code](docs/guide/library.md) ·
[Embed kgdiff in a Rust application](docs/guide/embedding.md) ·
[Migrating to 0.11](docs/guide/migrating-to-0.11.md).

## What it reports

| Family        | Symbol  | Changes                                                           |
| ------------- | ------- | ----------------------------------------------------------------- |
| **added**     | `+`     | new nodes and their relations                                     |
| **removed**   | `−`     | deleted nodes and their relations                                 |
| **content**   | `~`     | renames, types, synonyms, attributes, deprecation                 |
| **structure** | `⇄`     | moves in a hierarchy, retargeted relations, predicate changes     |
| **identity**  | `⊕` `⑂` | merges, splits and id changes, from replacement hints or inferred |

Pairs of nodes kgdiff was not sure enough about are not matched: they are listed as possible
matches, in the summary and in the viewer, for you to check. How it decides: [How kgdiff tells changes apart](docs/guide/matching.md),
and the exact rules in [Algorithms](docs/algorithms.md).

## Use it for

| You work with…                                      | Start here                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ontology releases (OBO, OWL)                        | [Ontologies: OBO and OWL](docs/guide/ontologies.md)                                                                        |
| LLM and GraphRAG extractions, ids that mean nothing | [Graphs without stable ids](docs/guide/llm-graphs.md)                                                                      |
| Graph files kept in git                             | [Use kgdiff with git](docs/guide/git.md) · [Review changes in CI](docs/guide/ci.md)                                        |
| A product that shows graph changes to its users     | [Embed the viewer](docs/guide/viewer.md) · [Embed in a Rust application](docs/guide/embedding.md)                          |
| A graph drawn with AntV G6                          | [Browse a graph with G6](docs/guide/g6.md) · [`@kgdiff/g6`](packages/g6)                                                   |
| Patches between versions                            | [Deltas: apply and invert](docs/guide/deltas.md) · [Delta format](docs/delta-format.md) · [Versioning](docs/versioning.md) |

## Formats

| Family | Formats                                                                                                                                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDF    | Turtle, N-Triples, N-Quads, TriG, RDF/XML (`.rdf`, `.owl` from Protégé / ROBOT), JSON-LD 1.1 (inline contexts; nothing is fetched) — labels by language preference, OWL existential restrictions as edges, blank nodes identified by content and context, statement annotations folded |
| OBO    | OBO 1.4 — synonyms, `is_a`, relationships, obsoletion with `replaced_by`, `alt_id`                                                                                                                                                                                                     |
| JSON   | kgdiff native, d3 / NetworkX node-link, Cytoscape.js, AntV G6 v5, graphology, vis-network                                                                                                                                                                                              |

The format is detected from the file name and the content. Mapping conventions:
[Formats](docs/formats.md). Missing yours? [Request a format](https://github.com/iiwish/kgdiff/issues/new?template=format_request.yml).

## How it compares

|                                                      | Text diff               | Ontology diff tools (ROBOT diff, …)  | kgdiff                           |
| ---------------------------------------------------- | ----------------------- | ------------------------------------ | -------------------------------- |
| Names merges, splits, renames, moves                 | lines added and removed | axiom- or entity-level, some renames | yes, grouped into hunks          |
| Ignores serialization (order, prefixes, blank nodes) | no                      | axiom-level                          | yes, on a normalized graph model |
| Any graph, not only OWL                              | any text                | OWL                                  | RDF, OBO and JSON graph formats  |
| Both versions on one stable map                      | —                       | text, tables or trees                | yes, with replay                 |
| Review workflow                                      | line by line in a PR    | reports                              | hunks, reviewed state, keyboard  |
| Invertible patch                                     | `git apply -R`          | varies                               | yes, hash-checked                |

kgdiff does not reason over OWL axioms: for axiom-level review, run `robot diff` alongside it
([Limits](docs/guide/ontologies.md#limits)).

## Correctness and performance

- **Deterministic.** The same inputs give byte-identical diffs, deltas, layouts and reports
  (`--reproducible` drops the report's timestamp). CI checks that layouts hash the same on Linux,
  macOS, Windows and in WebAssembly.
- **Invertible.** `apply(A, diff(A, B).delta) ≅ B`, and the inverse delta restores `A`; applying
  hunks one by one in review order always succeeds. Property-tested with fast-check.
- **One engine.** The CLI, the libraries, the viewer and the playground run the same Rust code.
  A [conformance corpus](conformance/README.md) generated by the Rust crates is checked by the
  TypeScript read path on every commit, and every [example dataset](examples/datasets) runs
  through the whole pipeline against the changes it should produce.
- **Measured** (Apple M5, kgdiff 0.11; WebAssembly under Node 24 unless marked native):

  | What                                      | Time                     |
  | ----------------------------------------- | ------------------------ |
  | diff, 10k nodes / 30k edges               | ≈ 0.14 s (native: 30 ms) |
  | diff, 100k nodes / 300k edges, native     | ≈ 0.47 s                 |
  | parse 50k Turtle triples                  | ≈ 0.11 s                 |
  | layout of a 10k-node diff (changes scope) | ≈ 0.5 s                  |
  | visual resolution per frame, 5k nodes     | < 1 ms                   |

  The standalone viewer is ≈ 119 kB gzip and carries no WebAssembly; the engine (≈ 390 kB gzip)
  loads only when something has to be computed. Every figure, with the targets still missed:
  [RFC 0002, Phase 5 results](docs/rfcs/0002-rust-compute-core.md#phase-5-results).

## Packages

**Most people need one.** It depends only on what you want to do:

| You want to…                                      | Install                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Compare graph files in the terminal or in CI      | `@kgdiff/cli` (`npx @kgdiff/cli a.ttl b.ttl`), or the GitHub Action  |
| … with Python tools, without Node.js              | `pykgdiff` from PyPI (`pipx install pykgdiff`): the same `kgdiff`    |
| Show a diff in a web page, without rendering code | `@kgdiff/viewer` (the `<kgdiff-viewer>` web component)               |
| Compute diffs in your code, draw them yourself    | `@kgdiff/core` and `@kgdiff/compute`, plus `layout`, `scene` or `g6` |
| Embed the engine in a Rust application            | the crates `kgdiff-core`, `kgdiff-layout`, `kgdiff-report`           |

<details>
<summary><b>All packages and crates</b></summary>

| npm                                     |                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| [`@kgdiff/cli`](packages/cli)           | The command-line tool: installs and runs the native `kgdiff` of your platform.        |
| [`@kgdiff/viewer`](packages/viewer)     | The `<kgdiff-viewer>` web component and the elements it is made of.                   |
| [`@kgdiff/core`](packages/core)         | Diff model: `parseGraph`, `diff`, JSON transports, invertible delta, hunk titles.     |
| [`@kgdiff/compute`](packages/compute)   | kgdiff's Rust engine in WebAssembly: diff, parsers, layout.                           |
| [`@kgdiff/layout`](packages/layout)     | Deterministic, label-aware union layout; anchored and changes-only modes.             |
| [`@kgdiff/scene`](packages/scene)       | Diff semantics → visual primitives: design tokens, encodings, replay timeline, focus. |
| [`@kgdiff/renderer`](packages/renderer) | Canvas 2D engine: smooth camera, LOD, label placement, picking, swipe, minimap.       |
| [`@kgdiff/g6`](packages/g6)             | Render kgdiff scenes inside AntV G6 v5 graphs.                                        |

| crates.io                                 |                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| [`kgdiff`](crates/kgdiff)                 | The command line, also usable as a library behind an I/O trait.        |
| [`kgdiff-core`](crates/kgdiff-core)       | Matching, change classification, hunks and invertible deltas.          |
| [`kgdiff-formats`](crates/kgdiff-formats) | The parsers: RDF, OBO and the JSON graph formats.                      |
| [`kgdiff-layout`](crates/kgdiff-layout)   | The stable layout of a graph and of a diff, the layout document.       |
| [`kgdiff-report`](crates/kgdiff-report)   | Terminal summary, `--stat`, Markdown, report payload and HTML reports. |

Also: the GitHub Action ([`action.yml`](action.yml), `uses: iiwish/kgdiff@v0`) and the
website with the playground ([`apps/site`](apps/site)). `@kgdiff/cli` brings its platform
package (`@kgdiff/cli-darwin-arm64`, `@kgdiff/cli-linux-x64-gnu`, …) with it: never install
those yourself. Every npm package and crate of a release has the same version number.

</details>

## Documentation

|               |                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Start**     | [What is kgdiff?](docs/index.md) · [Getting started](docs/getting-started.md) · [FAQ](docs/faq.md)                                                                                                                                                                             |
| **Guides**    | [CI](docs/guide/ci.md) · [git](docs/guide/git.md) · [Ontologies](docs/guide/ontologies.md) · [LLM graphs](docs/guide/llm-graphs.md) · [Matching](docs/guide/matching.md) · [Viewer](docs/guide/viewer.md) · [Library](docs/guide/library.md) · [Rust](docs/guide/embedding.md) |
| **Reference** | [CLI](docs/cli.md) · [Formats](docs/formats.md) · [Viewer API](docs/interaction.md) · [Viewer elements](docs/viewer-elements.md) · [Delta format](docs/delta-format.md)                                                                                                        |
| **Concepts**  | [Architecture](docs/architecture.md) · [Algorithms](docs/algorithms.md) · [Visual language](docs/visual-language.md) · [RFCs](docs/rfcs)                                                                                                                                       |

The same documentation, in English and Chinese, is published at
[iiwish.github.io/kgdiff/docs](https://iiwish.github.io/kgdiff/docs/).

## Roadmap

**0.11** (2026-11-12) moved all computing onto the Rust engine: the CLI natively, everything
else through `@kgdiff/compute`. **0.12** prepares the public API for 1.0: the Rust API makes room
for the additions after 1.0, so that they need no major release, and the JavaScript API keeps
only what is documented ([Migrating to 0.12](docs/guide/migrating-to-0.12.md)); it is the last
release with breaking changes, and was published on 2026-11-13. **1.0** is 0.12 unchanged,
once two weeks with only patch releases have passed and at least one real host runs on 0.12.
The experimental APIs, designed for embedding hosts, stay experimental after 1.0 until a host has
used them ([RFC 0002](docs/rfcs/0002-rust-compute-core.md#kgdiff-10),
[Versioning](docs/versioning.md#experimental-apis)).

After 1.0, additive: GraphML and GEXF input · KGCL and RDF Patch export · an MCP server, so
agents can review the graph edits they make · Python and Jupyter · a plain view of one graph and
group backgrounds for embedding hosts ([RFC 0003](docs/rfcs/0003-embedding-hosts.md)) ·
Cytoscape.js and Sigma.js adapters · three-way merge with conflict visualization · a Web Worker
pipeline and a WebGL renderer for very large graphs. Follow along, or pick something up, in the
[roadmap issue](https://github.com/iiwish/kgdiff/issues/21).

## Contributing

Bug reports, format requests, guides and code are all welcome. Good places to start are the
issues labelled
[good first issue](https://github.com/iiwish/kgdiff/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
and [help wanted](https://github.com/iiwish/kgdiff/issues?q=is%3Aopen+label%3A%22help+wanted%22);
questions and ideas go to [Discussions](https://github.com/iiwish/kgdiff/discussions).

```sh
pnpm install                               # Node.js ≥ 22, pnpm 11
pnpm --filter @kgdiff/compute build:wasm   # the engine's WebAssembly, once and after changes under crates/
pnpm check                                 # lint + typecheck + tests
cargo test --workspace                     # the Rust crates
pnpm dev:site                              # landing page and playground
cargo run -p kgdiff -- examples/datasets/enterprise-kg-en/before.json \
  examples/datasets/enterprise-kg-en/after.json
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) first (the WebAssembly build needs a few tools), then
[Architecture](docs/architecture.md). Please follow the
[code of conduct](.github/CODE_OF_CONDUCT.md), and report vulnerabilities privately as
[SECURITY.md](.github/SECURITY.md) describes.

## Citing

If you use kgdiff in research, please cite it: GitHub's _Cite this repository_ button reads
[CITATION.cff](CITATION.cff).

## License

[MIT](LICENSE). The example datasets are CC0.
