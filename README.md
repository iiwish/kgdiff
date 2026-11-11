<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html"><img src="docs/images/replay-en.webp" alt="The kgdiff viewer replaying the changes between two versions of a schema.org-style vocabulary, one hunk at a time" width="880"></a>
</p>

<p align="center">
  <b>git diff for knowledge graphs.</b><br>
  See what changed between two versions of a graph — and review it like a pull request.
</p>

<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html"><b>Try it in your browser</b></a> ·
  <a href="https://iiwish.github.io/kgdiff/">Website</a> ·
  <a href="https://iiwish.github.io/kgdiff/docs/">Docs</a>
</p>

<p align="center">
  <a href="README.zh-CN.md">中文</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/visual-language.md">Visual language</a> ·
  <a href="docs/delta-format.md">Delta format</a>
</p>

---

AI systems now write and rewrite knowledge graphs: GraphRAG pipelines, agent memories, ontology
assistants, semantic layers. Someone has to review those changes. Text diffs show triples
appearing and disappearing; most visual tools recolor nodes on a fresh force layout so
everything jumps. **kgdiff shows what actually happened**: a merge, a rename, a class moved under
a new parent, a relation that now points somewhere else — on one stable map, in a viewer built
for review.

```sh
npx @kgdiff/cli before.ttl after.ttl -o report.html --open
```

Or install nothing: the [playground](https://iiwish.github.io/kgdiff/playground.html) diffs the
example datasets, or two files of your own, in your browser. Nothing is uploaded.

## Four ideas

|                             |                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Semantic, not syntactic** | Nodes are matched across versions (by id, by replacement hints, or by label/neighbourhood similarity when ids are meaningless, e.g. two LLM extractions). Changes are classified: rename, rekey, types, aliases, attributes, deprecation, replacement links, hierarchy move, merge, split, retarget, predicate change. |
| **One mental map**          | Both versions share one deterministic, label-aware layout. Nothing moves unless it changed. Removed things stay where they were, as hollow ghosts.                                                                                                                                                                     |
| **Color is meaning**        | Five families and nothing else: added, removed, content, structure, identity — plus gray for context. Every color has a non-color cue too, and a color-blind-safe palette ships built in.                                                                                                                              |
| **Review is a workflow**    | Changes are grouped into hunks in dependency order. Step through them, replay the before → after morph, mark them reviewed, export the invertible delta.                                                                                                                                                               |

## What you get

- **`<kgdiff-viewer>`**: a framework-agnostic web component with three ways to compare —
  _Overlay_, _Swipe_ (drag a divider between before and after) and _Replay_ (the old graph morphs
  into the new one, hunk by hunk) — each with or without _Changes only_ (on by default for large
  graphs), plus a searchable, filterable change
  list, a detail panel with character-level diffs, review progress, deep links, keyboard
  shortcuts, light/dark themes, English and Chinese.
- **`kgdiff` CLI**: colored terminal summaries, `--stat`, `--name-status`, `--json`, `--delta`,
  GitHub-flavoured `--markdown` for PR comments, `--exit-code` for CI, `apply` for deltas, and
  single-file offline HTML reports (`-o report.html`, byte-identical with `--reproducible`).
- **Libraries**: a zero-dependency diff engine, parsers (RDF through `n3`), a stable layout
  engine, a renderer-agnostic visual model, a Canvas renderer and an AntV G6 adapter.

## Quick start

### Terminal and CI

```sh
npx @kgdiff/cli v12.json v13.json                 # colored summary
npx @kgdiff/cli old.obo new.obo --stat            # diffstat
npx @kgdiff/cli a.ttl b.ttl --markdown >> "$GITHUB_STEP_SUMMARY"
npx @kgdiff/cli a.ttl b.ttl --exit-code -q        # exit 1 when the graphs differ
```

`npx` needs Node.js ≥ 22; kgdiff itself is a native program for macOS, Linux and Windows, also
on crates.io (`cargo install kgdiff`).

<p align="center">
  <img src="docs/images/terminal-en.webp" alt="kgdiff's terminal summary of an OBO ontology release: merges, moves, a split, renames and additions, colored by kind of change" width="720">
</p>

See [docs/cli.md](docs/cli.md) and [packages/cli/README.md](packages/cli/README.md).

### On pull requests (GitHub Actions)

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
job summary and a pull request comment that later pushes update in place, and uploads the
interactive report as an artifact. Pull requests from forks get the job summary and the report.
Options, several graphs, failing the check: [docs/guide/ci.md](docs/guide/ci.md).

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

Events: `kgdiff-ready`, `kgdiff-select`, `kgdiff-mode`, `kgdiff-review`, `kgdiff-error`, `kgdiff-replay-end`.
Behaviour: [docs/interaction.md](docs/interaction.md).

<p align="center">
  <img src="docs/images/viewer-en.webp" alt="The kgdiff viewer: both versions on one map, changes colored by kind, and the list of changes to review" width="880">
</p>

### As a library

```ts
import { diff, formatHunk, applyDelta, invertDelta } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';

const before = parseGraph(beforeText, { filename: 'v1.obo' }).graph;
const after = parseGraph(afterText, { filename: 'v2.obo' }).graph;
const result = diff(before, after);

for (const hunk of result.hunks) console.log(formatHunk(hunk, result, 'en').title);
// Merged “juvenile diabetes” and “insulin-dependent diabetes mellitus” into “type 1 diabetes mellitus”
// Merged “heart attack” into “myocardial infarction”
// …
```

## Formats

| Family | Formats                                                                                                                                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDF    | Turtle, N-Triples, N-Quads, TriG, RDF/XML (`.rdf`, `.owl` from Protégé / ROBOT), JSON-LD 1.1 (inline contexts; nothing is fetched) — labels by language preference, OWL existential restrictions as edges, blank nodes identified by content and context, statement annotations folded |
| OBO    | OBO 1.4 — synonyms, `is_a`, relationships, obsoletion with `replaced_by`, `alt_id`                                                                                                                                                                                                     |
| JSON   | kgdiff native, d3 / NetworkX node-link, Cytoscape.js, AntV G6 v5, graphology, vis-network                                                                                                                                                                                              |

The same graph in different serializations diffs as identical. Mapping conventions:
[docs/architecture.md](docs/architecture.md#formats-mapping-conventions).

## Packages

**Which one to install.** Most people need one package; it depends only on what you want to do:

| You want to…                                      | Install                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| Compare graph files in the terminal or in CI      | `@kgdiff/cli` (`npx @kgdiff/cli a.ttl b.ttl`), or the GitHub Action   |
| Show a diff in a web page, without rendering code | `@kgdiff/viewer` (the `<kgdiff-viewer>` web component)                |
| Compute diffs in your code, draw them yourself    | `@kgdiff/core`, plus `formats`, `layout`, `scene` or `g6` as you need |

`@kgdiff/cli` runs a native binary: npm installs the one for your machine with it
(`@kgdiff/cli-darwin-arm64`, `@kgdiff/cli-linux-x64-gnu`, …). Never install those yourself.

All packages:

| Package                                 |                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`@kgdiff/core`](packages/core)         | Diff engine: normalize → match → classify → hunks → invertible delta. Zero dependencies. |
| [`@kgdiff/formats`](packages/formats)   | RDF / OBO / JSON parsers.                                                                |
| [`@kgdiff/layout`](packages/layout)     | Deterministic, label-aware union layout; anchored and changes-only modes.                |
| [`@kgdiff/scene`](packages/scene)       | Diff semantics → visual primitives: design tokens, encodings, replay timeline, focus.    |
| [`@kgdiff/renderer`](packages/renderer) | Canvas 2D engine: smooth camera, LOD, label placement, picking, swipe, minimap.          |
| [`@kgdiff/viewer`](packages/viewer)     | The `<kgdiff-viewer>` web component.                                                     |
| [`@kgdiff/g6`](packages/g6)             | Render kgdiff scenes inside AntV G6 v5 graphs.                                           |
| [`@kgdiff/cli`](packages/cli)           | The command-line tool.                                                                   |
| [`action.yml`](action.yml)              | The GitHub Action (`uses: iiwish/kgdiff@v0`): graph diffs on pull requests.              |
| [`apps/site`](apps/site)                | Landing page and playground.                                                             |

## Correctness and performance

- **Deterministic**: the same inputs give byte-identical diffs, layouts and reports.
- **Invertible**: `apply(A, diff(A, B).delta) ≅ B` and the inverse delta restores `A`;
  applying hunks one by one in review order always succeeds. Property-tested with fast-check.
- **Tested**: ~2,200 tests across packages, including acceptance tests that run every example
  dataset through the whole pipeline.
- **Measured** (M-class laptop, `pnpm bench`): diff of 10k nodes / 30k edges ≈ 0.1 s; 50k RDF
  triples parsed in ≈ 0.1 s; layout of a 10k-node diff (changes scope) ≈ 1.1 s; per-frame visual
  resolution < 1 ms for 5k nodes; standalone viewer ≈ 116 kB gzip.

## Examples

[`examples/datasets`](examples/datasets) holds six realistic before/after pairs with the exact
changes kgdiff should report: an enterprise credit KG ontology (in Chinese and in English), an OBO disease
ontology release, two LLM extraction runs with random ids, a dbt-style lineage DAG, and a
schema.org-like Turtle vocabulary. `scripts/gen-synthetic.ts` generates large synthetic pairs.

## Development

```sh
pnpm install                    # Node.js ≥ 22, pnpm 11
pnpm check                      # lint + typecheck + tests
pnpm bench                      # performance budgets
pnpm dev:site                   # landing page and playground
pnpm dev:docs                   # documentation site (docs/)
pnpm build:viewer-assets        # the viewer bundles kgdiff's HTML reports embed
cargo run -p kgdiff -- examples/datasets/enterprise-kg-en/before.json \
  examples/datasets/enterprise-kg-en/after.json
```

Start with [docs/architecture.md](docs/architecture.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

1.0: `@kgdiff/compute` replaces the TypeScript compute modules in the browser
([RFC 0002](docs/rfcs/0002-rust-compute-core.md), phase 5) · the remaining parts of
[RFC 0003](docs/rfcs/0003-embedding-hosts.md) for embedding hosts · KGCL and RDF Patch export ·
three-way merge with conflict visualization · Web Worker pipeline and a WebGL renderer for very large graphs ·
Cytoscape.js and Sigma.js adapters · Python bindings.

## License

[MIT](LICENSE). Example datasets are CC0.
