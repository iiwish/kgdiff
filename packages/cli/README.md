# kgdiff

**git diff for knowledge graphs.** Compare two versions of a graph — RDF, OBO or JSON — in the
terminal, in CI, or as a single-file interactive HTML report. kgdiff understands what changed:
a merge is a merge, a rename is a rename, a moved class is a move.

```sh
npx @kgdiff/cli before.ttl after.ttl
```

## Install

```sh
npm install --global @kgdiff/cli      # or: pnpm add -g @kgdiff/cli
kgdiff --version
```

`npx @kgdiff/cli …` works without installing. kgdiff is a native program, written in Rust:
this package holds only a small launcher (Node.js ≥ 22) that runs the binary of your platform,
which npm installs with it as an optional dependency, one of

| Platform                                   | Package                                                       |
| ------------------------------------------ | ------------------------------------------------------------- |
| macOS, Apple silicon / Intel               | `@kgdiff/cli-darwin-arm64`, `@kgdiff/cli-darwin-x64`          |
| Linux x64, glibc / musl (Alpine)           | `@kgdiff/cli-linux-x64-gnu`, `@kgdiff/cli-linux-x64-musl`     |
| Linux Arm64, glibc / musl                  | `@kgdiff/cli-linux-arm64-gnu`, `@kgdiff/cli-linux-arm64-musl` |
| Windows x64 (and Arm64, through emulation) | `@kgdiff/cli-win32-x64`                                       |

An install without optional dependencies (`--omit=optional`, `--no-optional`) has no binary
to run, and `kgdiff` says so. `KGDIFF_BINARY=/path/to/kgdiff` makes the launcher run another
binary. Without Node.js, build the same kgdiff from crates.io: `cargo install kgdiff`.

## Usage

```
kgdiff <before> <after> [options]
kgdiff apply <graph> <delta> [-o <file>] [--no-strict [--verbose]]
kgdiff --help | --version
```

Inputs are JSON (kgdiff, d3 / NetworkX, Cytoscape.js, G6, graphology, vis-network), JSON-LD,
Turtle, N-Triples, N-Quads, TriG, RDF/XML (`.rdf`, `.owl` from Protégé or ROBOT) and OBO,
detected from the extension and the content. Gzip-compressed files (`.ttl.gz`) work too. `-`
reads one side from stdin. JSON-LD contexts must be inline: remote ones are never fetched.

```sh
kgdiff v12.json v13.json                          # colored summary
kgdiff old.obo new.obo -o report.html --open      # interactive report, opened in the browser
kgdiff a.ttl b.ttl --stat                         # diffstat only
kgdiff a.ttl b.ttl --name-status | grep '^G'      # merges, one per line (tab-separated)
kgdiff a.json b.json --json diff.json             # full machine-readable diff
kgdiff a.json b.json --delta patch.json           # invertible delta …
kgdiff apply a.json patch.json -o b.json          # … and apply it
curl -s https://example.org/latest.ttl | kgdiff pinned.ttl -
```

Outputs combine: `kgdiff a.ttl b.ttl -o report.html --markdown summary.md --json diff.json`
writes three files and still prints the summary. At most one output can go to stdout.

Files are written atomically (temporary file + rename). kgdiff never overwrites its inputs: an
output that is an input under another name — a case variant, a symlink, a hard link — is refused,
in `kgdiff apply` too. An empty input is an error unless `--allow-empty` (an empty graph, e.g.
before a first release), so a failed upstream command cannot pass for "everything removed".

### In CI

On GitHub, the kgdiff action runs the CLI on pull requests: it compares each file with its
version on the base branch, writes the summary into the job summary and a pull request comment
(updated in place on later pushes) and uploads the report as an artifact. Setup and options:
https://github.com/iiwish/kgdiff/blob/main/docs/guide/ci.md

```yaml
- uses: iiwish/kgdiff@v0
  with:
    files: ontology/onto.ttl
```

Anywhere else, run the CLI yourself:

```yaml
# Fail the job when the ontology changed, and explain what changed in the job summary.
- run: npx @kgdiff/cli main/ontology.ttl ontology.ttl --markdown >> "$GITHUB_STEP_SUMMARY"
- run: npx @kgdiff/cli main/ontology.ttl ontology.ttl --exit-code --quiet
```

`--markdown` is GitHub-flavoured Markdown (a diffstat table, a family legend, the hunk list
and the possible matches in collapsible `<details>` groups), safe to paste into PR comments:
labels are escaped and can never mention people, link issues or inject HTML.

## Output

The default summary: a header with node and edge totals, counters per replay phase, a diffstat
bar, and the hunks grouped by phase (Removed, Restructured, Modified, Added). Glyphs keep it
readable without color: `+` added, `−` removed, `~` modified, `⇄` structure (moves,
relations), `⊕` merge, `⑂` split.

```
kgdiff  mhd 2026-09-01 → 2026-10-01                                179 → 184 nodes · 351 → 353 edges

  +3 added   ~12 modified   ⇄7 restructured                                   58 changes in 22 hunks
  +++++~~~~~~~~~~~~⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄

  Restructured 7
  ⑂ Split “obsolete diabetes insipidus” into “obsolete diabetes i…   identity · inferred · 80% conf…
  ⊕ Merged “juvenile diabetes” and “insulin-dependent diabetes me…   identity · via replacement hin…
  ⊕ Merged “heart attack” into “myocardial infarction”               identity · via replacement hin…
  ⇄ Moved “Crohn disease” under “inflammatory bowel disease”         structure · from “intestinal d…
  Modified 12
  ~ Renamed “alcoholic liver disease” → “alcohol-related liver di…   content · ~1 attribute · +1 sy…
  …
```

Counters count hunks (reviewable changes); "58 changes" counts changed nodes and edges, which
the bar splits by phase. Colors follow kgdiff's meaning families (green added, red removed,
amber content, blue structure, violet identity) in truecolor, 256 or 16 colors. Lines fit the
terminal down to 40 columns; CJK and emoji are measured correctly, and control, bidi and
invisible characters in labels are shown as `␛` / `⟨U+202E⟩` instead of being interpreted. `--limit <n>` caps the list (default 50, `0`
lists all). Hunk titles and the summary are localized (`--locale zh-CN`, or from `LANG`).

Changes to **watched attributes** are flagged ⚑ for review first: a line under the bar counts
the hunks that change one, and their rows say so before the summary
(`content · ⚑ definition · ~2 attributes`). By default kgdiff watches definitions (`def`,
`definition`, `IAO:0000115`, `skos:definition`); `--watch-attr <key>` (repeatable) replaces
them. `--markdown` lists the same hunks in a ⚑ _Review first_ block before the others.

The summary ends with the **possible matches**: pairings kgdiff considered but did not apply,
between a node listed as removed and one listed as added, with the score, why it was not
applied and the evidence, so that "removed X, added Y" can be read as "maybe X became Y":

```
  Possible matches 1
  ≈ “pitchblende” → “uraninite (pitchblende)”   72% · below the 82% threshold · name 69% · neighbours 55%
  Not paired, so listed as removed or added. To pair one, add a synonym or a replacement link, or
  lower --threshold.
```

`--stat` adds a nodes / edges table and changes by node type:

```
         added  removed  modified  unchanged
  nodes      5        0        23        156
  edges     10        8        12        331

  By type
  Term  28 +++++~~~~~~~~~~~~~~~~~~~~~~~
```

`--name-status` prints one line per hunk: a letter (`A` added, `D` removed, `M` modified,
`R` renamed, `V` moved, `G` merged, `S` split, `E` relations), the anchor node id and the
title, tab-separated when piped:

```
S	MHD:0000067	Split “obsolete diabetes insipidus” into …
G	MHD:0000062	Merged “juvenile diabetes” and “insulin-dependent diabetes mellitus” into …
V	MHD:0000087	Moved “Crohn disease” under “inflammatory bowel disease”
```

### HTML report

`-o report.html` writes one self-contained file: the viewer plus the precomputed diff and
layout (gzip-compressed above 512 kB). It opens instantly, works offline and can be attached to
a PR or an e-mail. `--theme`, `--mode`, `--locale` and `--title` set the initial view;
`--reproducible` omits the timestamp so identical inputs give byte-identical reports.

Large graphs are laid out around their changes, with unchanged neighbourhoods collapsed. For
those reports kgdiff also inlines the viewer's small compute add-on, so collapsed groups can be
expanded in the browser; reports with a full layout leave it out. `--no-compute` always leaves
it out (smaller file, groups stay collapsed).

### Applying deltas

`kgdiff apply` applies a delta (from `--delta`, or the delta inside `--json` output) and writes
the patched graph as kgdiff JSON. By default it checks that the graph is the delta's base and
that every operation's precondition holds. Parse the graph as when the delta was made (same
`--format` / `--lang`), or its hash will differ. `--no-strict` applies every operation that fits
and reports how many were skipped; add `--verbose` to list them.

## Options

Run `kgdiff --help` for the full list. The most useful:

| Option                         | Meaning                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `--match id\|auto\|similarity` | How nodes are paired (default `auto`: ids, then similarity)                   |
| `--hierarchy <predicate>`      | Hierarchy predicate, repeatable (e.g. `--hierarchy is_a`)                     |
| `--ignore-attr <key>`          | Ignore an attribute when comparing, repeatable                                |
| `-f, --format <fmt>`           | Force the input format (`json jsonld turtle ntriples nquads trig rdfxml obo`) |
| `--lang zh,en`                 | RDF label language preference                                                 |
| `--exit-code`, `-q`            | Exit 1 on differences; print nothing on stdout                                |
| `--color auto\|always\|never`  | Colors (auto: only on a terminal, honours `NO_COLOR`)                         |

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| `0`  | Success (and, with `--exit-code`, no differences)                         |
| `1`  | The graphs differ (only with `--exit-code`)                               |
| `2`  | Usage or input error: one line on stderr with a hint, never a stack trace |

## Environment

| Variable                         | Effect                                                                  |
| -------------------------------- | ----------------------------------------------------------------------- |
| `NO_COLOR`                       | Disable colors (unless `--color always`)                                |
| `FORCE_COLOR`                    | `0` disables; `1` / `2` / `3` force exactly 16 / 256 / truecolor colors |
| `COLORTERM`, `TERM`, `COLORFGBG` | Color depth and light-background detection                              |
| `LC_ALL`, `LC_MESSAGES`, `LANG`  | Default locale (`zh*` → `zh-CN`, otherwise `en`)                        |
| `COLUMNS`                        | Line width when stdout is not a terminal (default 120)                  |
| `KGDIFF_MAX_INPUT`               | Input size limit after decompression (default `1G`; e.g. `4G`, `512M`)  |
| `DEBUG=kgdiff`                   | Print stack traces with errors                                          |

## Programmatic use

This package exports no JavaScript API since 0.8.0: it only runs `kgdiff`. In JavaScript, diff
graphs with [`@kgdiff/core`](https://www.npmjs.com/package/@kgdiff/core) and
[`@kgdiff/formats`](https://www.npmjs.com/package/@kgdiff/formats), and show them with
[`@kgdiff/viewer`](https://www.npmjs.com/package/@kgdiff/viewer). In Rust, the crates
[`kgdiff`](https://crates.io/crates/kgdiff) (the command line as a library, `kgdiff::cli::run`
behind an I/O trait) and [`kgdiff-report`](https://crates.io/crates/kgdiff-report) (the
summary, Markdown and HTML reports) are what this binary is built from.

## Development

The command line is `crates/kgdiff`; from the repository root:

```sh
pnpm build:viewer-assets              # the viewer bundles HTML reports embed
cargo run -p kgdiff -- examples/datasets/ontology-release/before.obo \
  examples/datasets/ontology-release/after.obo --hierarchy is_a
cargo test -p kgdiff                  # tests, including golden outputs in tests/snapshots
pnpm vitest run --project cli         # the launcher
```

Golden snapshots follow the diff engine; after an intended change run
`KGDIFF_UPDATE_SNAPSHOTS=1 cargo test -p kgdiff --test golden` and review the snapshot diff.
The release assembles the platform packages from the GitHub release's archives
(`scripts/npm-platforms.ts`).

## License

MIT
