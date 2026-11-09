# Getting started

## Try it in the browser

The [playground](/playground.html) diffs the example datasets, or two files of your own,
entirely in your browser: nothing is uploaded. It is the quickest way to see what kgdiff reports
and what the viewer can do.

## Install the CLI

Run it without installing anything, with [Node.js](https://nodejs.org) 22 or later:

```sh
npx @kgdiff/cli before.ttl after.ttl
```

or install it:

```sh
npm install --global @kgdiff/cli     # a kgdiff command everywhere
npm install --save-dev @kgdiff/cli   # a pinned version in one project, run with npx @kgdiff/cli
```

kgdiff is a native program for macOS, Linux (glibc and musl) and Windows: npm installs the
binary of your platform with `@kgdiff/cli`. Without Node.js, build it from crates.io:
`cargo install kgdiff`.

## Your first diff

The examples on this page use two monthly releases of a small disease ontology in OBO format,
from the [example datasets](../examples/datasets/ontology-release) in the repository. Any two
versions of your own graph work the same way: kgdiff detects the format from the file name and
the content ([Formats](./formats.md)).

```sh
kgdiff before.obo after.obo
```

```
kgdiff  mhd 2026-09-01 → 2026-10-01                    179 → 184 nodes · 351 → 353 edges

  +3 added   ~12 modified   ⇄7 restructured                       58 changes in 22 hunks
  +++++~~~~~~~~~~~~⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄

  Restructured 7
  ⊕ Merged “juvenile diabetes” and “insulin-dependent d…   identity · via replacement h…
  ⊕ Merged “heart attack” into “myocardial infarction”     identity · via replacement h…
  ⊕ Merged “chronic obstructive airway disease” into “c…   identity · via replacement h…
  ⇄ Moved “Crohn disease” under “inflammatory bowel dis…   structure · from “intestinal…
  ⇄ Moved “Hashimoto thyroiditis” under “autoimmune thy…   structure · from “hypothyroi…
  ⇄ Moved “tuberculosis” under “bacterial infectious di…   structure · from “lung disea…
  ⑂ Split “diabetes insipidus” into “arginine vasopress…   identity · inferred · 80% co…
  Modified 12
  ~ Renamed “alcoholic liver disease” → “alcohol-relate…   content · ~1 attribute · +1…
  ~ Renamed “Alzheimer's disease” → “Alzheimer disease”    content · ~1 attribute · +1…
  …
  Added 3
  + Added “arginine vasopressin disorder” and 1 relation   added · type Term · linked t…
  …
```

From the top:

- **Header**: the names and versions of the two graphs (from their metadata, otherwise the file
  names) and how many nodes and edges each has.
- **Counters**: how many hunks of each kind and, on the right, how many elements changed in how
  many hunks. The bar shows the same proportions.
- **Hunks**: one line per change, worded the way you would describe it. They are grouped in the
  order that reads best (Removed, Restructured, Modified, Added), and the symbol and the word on
  the right name the family of the change:

  | Symbol  | Family    | Changes                                 |
  | ------- | --------- | --------------------------------------- |
  | `+`     | added     | new nodes and their relations           |
  | `−`     | removed   | deleted nodes and their relations       |
  | `~`     | content   | renames, attributes, types, synonyms    |
  | `⇄`     | structure | moves in a hierarchy, changed relations |
  | `⊕` `⑂` | identity  | merges and splits                       |

Lines are truncated to fit the terminal; `--name-status` and the other outputs below show the
full titles.

## Open the interactive report

```sh
kgdiff before.obo after.obo -o report.html --open
```

writes a single HTML file and opens it in your browser. The viewer and the diff are both inside,
so the report works offline and can be attached to an issue, kept as a CI artifact or published
as a static page.

In the report:

- Pick how to compare with `1` to `3` in the dock at the bottom: **Overlay** (both versions on
  one map), **Swipe** (drag a divider between before and after) or **Replay** (the old graph
  morphs into the new one, hunk by hunk). `4` turns **Changes only** on or off in any of them
  (on by default for large graphs).
- Step through the changes with `j` and `k`, mark one reviewed with `x`, search with `/`.
- Select a change to see the before and after of every label, attribute and relation.
- Press `?` for all shortcuts.

[Viewer: interaction and API](./interaction.md) describes everything the viewer does.

## Other outputs

| Option              | Output                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `--stat`            | The counters, a nodes / edges table and one row per node type          |
| `--name-status`     | One line per hunk: a letter, the node id and the title (TSV in a pipe) |
| `--markdown [file]` | GitHub-flavoured Markdown for pull request comments and job summaries  |
| `--json [file]`     | The complete diff, machine-readable                                    |
| `--delta [file]`    | An invertible patch, for [`kgdiff apply`](./guide/deltas.md)           |
| `-o, --html <file>` | The interactive HTML report                                            |

```sh
kgdiff before.obo after.obo --stat
```

```
kgdiff  mhd 2026-09-01 → 2026-10-01    179 → 184 nodes · 351 → 353 edges

  +3 added   ~12 modified   ⇄7 restructured       58 changes in 22 hunks
  +++++~~~~~~~~~~~~⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄

         added  removed  modified  unchanged
  nodes      5        0        23        156
  edges     10        8        12        331

  By type
  Term  28 +++++~~~~~~~~~~~~~~~~~~~~~~~
```

Outputs combine: `kgdiff a.ttl b.ttl -o report.html --markdown summary.md` writes both files and
still prints the summary. At most one output goes to standard output.

## Choose how nodes are matched

`--match` decides which node of the new version is the same as a node of the old one:

- `auto` (default): equal ids first, then replacement hints, then label and neighbourhood
  similarity for the nodes left over.
- `id`: ids and replacement hints only. Best when ids are authoritative, as in ontologies: see
  [Ontologies](./guide/ontologies.md).
- `similarity`: ignore ids. Best when they are random, as in LLM extractions: see
  [Graphs without stable ids](./guide/llm-graphs.md).

## Use it in scripts

`--exit-code` makes kgdiff exit with 1 when the graphs differ, like `git diff --exit-code`, and
`-q` silences standard output:

```sh
kgdiff committed.ttl regenerated.ttl --exit-code -q && echo "up to date"
```

| Exit code | Meaning                                                |
| --------- | ------------------------------------------------------ |
| `0`       | Success (with `--exit-code`: the graphs are identical) |
| `1`       | The graphs differ (only with `--exit-code`)            |
| `2`       | Usage or input error, explained on standard error      |

## Next steps

- [Review changes in CI](./guide/ci.md): a summary and a comment on every pull request, the
  report as an artifact.
- [Use kgdiff with git](./guide/git.md): `git diff` and `git difftool` for graph files.
- [CLI reference](./cli.md): every option.
