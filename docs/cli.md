# kgdiff CLI

`kgdiff` compares two graph files the way `git diff` compares two text files — in the terminal,
in CI, or as a shareable single-file HTML report.

```sh
npx @kgdiff/cli before.ttl after.ttl                 # colored summary + change list
npx @kgdiff/cli before.obo after.obo -o report.html  # self-contained interactive report
npx @kgdiff/cli a.json b.json --json > diff.json     # full machine-readable diff
npx @kgdiff/cli a.json b.json --delta > patch.json   # invertible delta only
npx @kgdiff/cli a.json b.json --markdown             # PR comment / job summary
npx @kgdiff/cli a.obo b.obo --kgcl > changes.kgcl    # KGCL commands (experimental)
npx @kgdiff/cli apply a.json patch.json -o b.json    # apply a delta
```

`npx @kgdiff/cli` needs Node.js ≥ 22. The same `kgdiff` installs without it from PyPI, as
`pykgdiff` (the command line only), or from crates.io; the examples below call it `kgdiff`:

```sh
npm install --global @kgdiff/cli     # Node.js
pipx install pykgdiff                # Python tools: or uv tool install pykgdiff, pip install pykgdiff
uvx --from pykgdiff kgdiff a.ttl b.ttl   # run it once, without installing
cargo install kgdiff                 # Rust
```

## Usage

```
kgdiff <before> <after> [options]
kgdiff apply <graph> <delta> [-o <file>] [--no-strict [--verbose]] [--verify-target] [--allow-empty]
kgdiff completion <bash|zsh|fish>
kgdiff --help | --version | help [apply|completion]
```

`<before>` / `<after>` are file paths, or `-` for stdin (one side at most). An empty input
(0 bytes or whitespace only, file or stdin) is an input error unless `--allow-empty`, which
reads it as an empty graph — a silently empty side would otherwise report "everything removed".

### Input formats

The format comes from the extension — `.json`, `.jsonld`, `.ttl`, `.nt`, `.nq`, `.trig`, `.rdf`,
`.owl`, `.obo`, `.graphml`, `.gexf`, also behind `.gz` — or, for other names and stdin, from the content. Two
extensions get a second look at the content: `.json` holding JSON-LD (a top-level `@context`,
`@graph`, `@id`, …) is read as JSON-LD, and `.owl`, which Protégé also writes in Turtle, OWL/XML
or Functional Syntax, is read in whatever syntax it contains. Formats kgdiff recognises but does
not read — OWL/XML, OWL Functional and Manchester Syntax — fail with a conversion
hint. JSON-LD contexts must be inline: kgdiff never fetches a remote `@context` (that keeps runs
offline and reproducible), so a document that references one fails with a hint to inline it.

### Output selection (default: summary to stdout)

| Option              | Output                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| _(none)_            | Header, diffstat, then the hunk list (like `git diff --stat` + `--name-status`, but semantic)                         |
| `--stat`            | Diffstat only                                                                                                         |
| `--name-status`     | One line per hunk: `A` added, `D` removed, `M` modified, `R` renamed, `V` moved, `G` merged, `S` split, `E` relations |
| `--json [file]`     | `DiffJSON` (pretty with `--pretty`)                                                                                   |
| `--delta [file]`    | `Delta`                                                                                                               |
| `--markdown [file]` | GitHub-flavoured Markdown: title, diffstat table, collapsible hunk list                                               |
| `--kgcl [file]`     | The changes as [KGCL](#kgcl-export) commands, for OBO tooling (experimental)                                          |
| `-o, --html <file>` | Self-contained HTML report (viewer + embedded payload; works offline)                                                 |
| `--open`            | Open the HTML report in the default browser                                                                           |

Several outputs may be combined (`-o report.html --markdown summary.md`); at most one goes to
stdout. `--json`, `--delta`, `--markdown` and `--kgcl` take an optional file (`-` or no value = stdout;
`--json=-x.json` or `--json ./-x.json` for names starting with `-`).

Output files are written atomically (a temporary file in the same directory, then rename;
existing permissions are kept). An output that exists and is not a regular file, such as
`/dev/null` or a named pipe, is written in place instead. Outputs never overwrite an input —
compared by (device, inode), so case variants on case-insensitive file systems, symlinks and hard
links are caught — and two outputs never share a file; `kgdiff apply` applies the same rule to
`-o`. `--open` without `-o` writes into a fresh private temporary directory (`mkdtemp`).

### Diff options

| Option                              | Meaning                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `-f, --format <fmt>`                | Input format for both files (`json`, `jsonld`, `turtle`, `ntriples`, `nquads`, `trig`, `rdfxml`, `obo`); default auto |
| `--before-format`, `--after-format` | Per-side override                                                                                                     |
| `--match <strategy>`                | `id`, `auto` (default), `similarity`                                                                                  |
| `--threshold <n>`                   | Similarity acceptance threshold (default 0.82)                                                                        |
| `--edge-identity <mode>`            | `structure` (default) or `id`                                                                                         |
| `--hierarchy <predicate>`           | Hierarchy predicate (repeatable); replaces the defaults when given                                                    |
| `--ignore-attr <key>`               | Ignore an attribute when comparing (repeatable)                                                                       |
| `--no-merges`, `--no-splits`        | Disable merge / split detection                                                                                       |
| `--lang <tags>`                     | RDF label language preference, comma-separated (e.g. `zh,en`)                                                         |

### Report options

| Option                            | Meaning                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `--title <text>`                  | Report title (default `<before> → <after>`)                                |
| `--theme <auto\|light\|dark>`     | Initial theme (default auto)                                               |
| `--locale <en\|zh-CN>`            | UI and hunk-title language (default from `LANG`, else `en`)                |
| `--mode <overlay\|swipe\|replay>` | Initial viewer mode (`changes`: overlay + `--scope changes`)               |
| `--scope <all\|changes>`          | Whole graph or only the changes, in any mode (default `changes` if large)  |
| `--panels <spec>`                 | Initial panel states, e.g. `"detail:collapsed minimap:hidden"` (see below) |
| `--reproducible`                  | Omit the generation timestamp (byte-identical reports for identical input) |
| `--no-compute`                    | Never inline the viewer's compute add-on (see §HTML report)                |

`--panels` takes the syntax of the viewer's
[`panels` attribute](interaction.md#panels): `region:state` pairs separated by spaces or
commas, and it can be repeated (a region named twice takes the last state). Regions are
`list`, `detail`, `search`, `filters`, `dock`, `transport`, `legend`, `zoom`, `minimap`,
`title` and `actions`; states are `open`, `collapsed` and `hidden`. Regions not named keep the
default layout. A pair that names no region or state is a usage error (exit 2) with a
suggestion: `Unknown panel region "detials" in --panels. Did you mean "detail"?`.

`--theme`, `--locale`, `--mode`, `--scope` and `--panels` are the report's initial view. The
viewer remembers what a reader chooses (theme, palette, language, panels, sizes; per origin,
in `localStorage`), and those choices win over the report's theme, language and panels in the
next report they open.

### Behaviour

| Option                          | Meaning                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `--exit-code`                   | Exit 1 when the graphs differ (like `git diff --exit-code`) |
| `-q, --quiet`                   | No stdout output (useful with `--exit-code`)                |
| `--color <auto\|always\|never>` | Default auto (TTY and `NO_COLOR` aware)                     |
| `--limit <n>`                   | Max hunks listed in the summary (default 50; `0` = all)     |
| `--watch-attr <key>`            | Attribute to flag ⚑ for review first (repeatable)           |
| `--allow-empty`                 | Read an empty input as an empty graph instead of failing    |

Environment: `NO_COLOR`; `FORCE_COLOR` (`0` off, `1` / `2` / `3` exactly 16 / 256 / truecolor
colors even on a truecolor terminal, other values on at the terminal's depth); `COLORTERM`,
`TERM`, `COLORFGBG` (depth, light background); `LC_ALL` / `LC_MESSAGES` / `LANG` (locale);
`COLUMNS`; `KGDIFF_MAX_INPUT` (input size limit after decompression, bytes or `K` / `M` / `G`,
default `1G`; larger inputs and gzip bombs are input errors); `DEBUG=kgdiff` (stack traces).

Exit codes: `0` success (and no differences with `--exit-code`), `1` differences with
`--exit-code`, `2` usage or input error (message on stderr, never a stack trace unless `DEBUG=kgdiff`).

Unexpected errors include a link to the bug-report form, prefilled with the CLI version,
operating-system platform and architecture. The link never includes the error message or input
paths; review any diagnostic output before sharing it. Expected usage, input and output errors
keep their existing hints.

### Shell completion

`kgdiff completion <bash|zsh|fish>` prints a completion script for the shell on stdout. Load it
when the shell starts:

```sh
eval "$(kgdiff completion bash)"     # in ~/.bashrc
source <(kgdiff completion zsh)      # in ~/.zshrc, after compinit
kgdiff completion fish | source      # in ~/.config/fish/config.fish
```

In bash, write `eval`, not `source <(…)`: the bash 3.2 that macOS ships reads nothing from a
process substitution, and says nothing about it.

Or write the script once to a directory the shell reads completions from, and write it again
after upgrading kgdiff, since a newer version may have new options:

```sh
# bash, with the bash-completion package (version 2) installed; bash alone does not read it
kgdiff completion bash > ~/.local/share/bash-completion/completions/kgdiff

# zsh: a directory of your own on fpath, set in ~/.zshrc before compinit
mkdir -p ~/.zfunc && kgdiff completion zsh > ~/.zfunc/_kgdiff
#   fpath=(~/.zfunc $fpath)

# fish
kgdiff completion fish > ~/.config/fish/completions/kgdiff.fish
```

The scripts complete the options (long and short), the values of the options that take one of a
fixed set (`--format`, `--before-format`, `--after-format`, `--match`, `--edge-identity`,
`--theme`, `--mode`, `--scope`, `--color`, `--locale`), file names for the two graphs and for the
options that take a file, and the `apply`, `help` and `completion` commands with their own
options. They are generated from the same tables the command line is parsed with, so they list
exactly the options of the version that printed them. `apply`, `help` and `completion` are
commands only as the first argument: to compare a file with one of these names, write it as a
path (`./completion`).

## Terminal summary

```
kgdiff  企业信用知识图谱本体 v12 → v13                                节点 74 · 关系 171

  +1 新增   −1 删除   ~6 修改   ⇄4 结构调整                            12 组共 23 处变化
  ++++−−−~~~~~~~⇄⇄⇄⇄⇄⇄⇄⇄⇄

  删除 1
  − 删除「抽查检查」及 2 条关系                          删除 · 类型 事件 · 原关联「经营风险」
  结构调整 4
  ⊕ 「法人代表」合并入「法定代表人」                     身份 · 依据替代声明 · 迁移 1 条关系
  ⇄ 「股权出质」移至「股权投资」下                       结构 · 原属「经营风险」
  ⇄ 「十大股东」的「持股」改为指向「上市公司」（原为「企业」）  结构
  …
  修改 6
  ~ 「高管任职」改名为「董监高任职」                     内容 · 别名 +1
  ~ 修改「企业」                                         内容 · 属性 +2 −1 · 关系 ~1
  …
  新增 1
  + 新增「受益所有人」及 3 条关系                        新增 · 类型 角色
```

- **Header**: graph names and versions; node / edge totals (`before → after` when they differ).
- **Counters**: hunks per phase, colored by family; on the right, changed elements and hunks.
- **Bar**: changed elements per phase, proportional (largest-remainder rounding); `+ − ~ ⇄`
  without color, family-colored `█` with color.
- **Groups** follow the replay phase order everywhere (CLI, Markdown, viewer): Removed →
  Restructured → Modified → Added — clean up, restructure, refine, grow. Within a group, hunks
  keep core's `order`. A modify hunk whose only change is a hierarchy move shows as structure.
- **Right column**: family, then the hunk subtitle (truncated first; the title wins space).
- **Review first**: changes to watched attributes can change what existing data means while
  the diff looks small, so they are flagged ⚑. A line under the bar counts the hunks that
  change one (`⚑ Review first: definition changed in 9 hunks`), and each of those rows says so
  before its summary (`content · ⚑ definition · ~2 attributes`). By default kgdiff watches
  definitions under the keys the formats give them: `def` (OBO), `definition` (kgdiff JSON),
  `IAO:0000115` (OBO ontologies in RDF) and `skos:definition`, all shown as “definition”.
  `--watch-attr <key>` (repeatable) replaces that list, e.g. `--watch-attr rdfs:comment` for
  vocabularies that define terms in `rdfs:comment`, as schema.org does. Only attributes of
  nodes that are in both versions count, and `--ignore-attr` wins. `--stat` shows the line too.
- **Possible matches** come last: pairings kgdiff considered but did not apply, between a node
  listed as removed and one listed as added, so that "removed X, added Y" can be read as "maybe
  X became Y". Each line gives both names (with their ids when the names are equal), the score,
  why it was not applied (below the `--threshold`, or too close to another candidate), and the
  label and neighbourhood evidence, highest score first; at most 10 (all with `--limit 0`,
  every suggestion in `--json`). A closing line says how to pair one. The section has columns
  of its own and is absent when there is nothing to list.

  ```
    Possible matches 1
    ≈ “pitchblende” → “uraninite (pitchblende)”   72% · below the 82% threshold · name 69% · neighbours 55%
    Not paired, so listed as removed or added. To pair one, add a synonym or a replacement link, or
    lower --threshold.
  ```
- Width: the terminal width on a TTY (`COLUMNS`, then 80, when it reports none), else
  `COLUMNS`, else 120; clamped to 40–120 (narrower terminals get the 40-column layout). Down to
  40 columns every line fits: counters wrap, table columns and type names give way, titles and
  summaries truncate with `…`. Layout is measured on plain text (East-Asian width, grapheme
  clusters) before coloring, so alignment is identical with and without color.
- Untrusted text (labels, ids, file names, parser messages in errors) never reaches the terminal
  raw: C0 controls become control pictures (`␛`), C1 controls `�`, and bidirectional or
  invisible format characters (U+202A–U+202E, U+2066–U+2069, U+200B, U+2060, U+FEFF, …) a
  visible `⟨U+202E⟩`; emoji joiners stay.

`--name-status` prints aligned columns on a TTY and TSV (`letter`, anchor id, title) otherwise.
`--stat` adds a nodes / edges × added / removed / modified / unchanged table and per-type rows.

Colors follow the families of `docs/visual-language.md` (truecolor, ANSI 256 or 16 colors,
`NO_COLOR` / `FORCE_COLOR` aware); glyphs keep the output readable without color.

## Inputs and `apply`

Inputs may be gzip-compressed or UTF-16 (detected); invalid UTF-8 is an error. `kgdiff apply`
accepts a `Delta` or a full `DiffJSON` (from `--json`) as the patch, from a file or stdin, and
writes kgdiff JSON (`graphToJSON`, with its `kgdiff.graph` format marker), so apply chains
round-trip losslessly. A diff or a delta given where a graph is expected is refused with a message
that says what the file is. `kgdiff help` and `-v`
are aliases of `--help` and `--version`.

A graph that is not the delta's base is refused (exit 2); the hint explains that the graph must
be parsed as when the delta was made (same `--format` / `--lang`). `--no-strict` applies every
operation whose precondition holds and reports how many were skipped on stderr; `--verbose`
lists them (`#index op: reason`).

When the result's hash is not the delta's `target.hash` and no operation was skipped, `apply`
warns on stderr and still writes the result (exit 0): the delta was cut short or edited, or it
comes from a version of kgdiff that left changes out. With `--verify-target` such a result is an
input error instead (exit 2) and nothing is written; the message gives both hashes. With
`--no-strict` as well, the same holds whether or not operations were skipped: a result that
skipped operations passes only if it is the target all the same (a graph that already had those
changes). A delta without `target.hash` cannot be checked, so `--verify-target` refuses it.

With `--ignore-attr`, the delta still carries the changes of the ignored attributes, though the
diff does not show them, so applying it reaches the delta's target
([Delta format](delta-format.md#ignored-attributes)).

## Markdown summary

For PR comments and `$GITHUB_STEP_SUMMARY`: a title, a diffstat table (nodes / edges ×
added / removed / modified), a family legend, the hunk list grouped by phase inside
`<details>` blocks (first 100, then "and N more"), preceded by a ⚑ _Review first_ block of the
hunks that change a watched attribute (first 20; the same items are marked ⚑ in the groups,
which may start collapsed), and the possible matches in a `<details>`
block of their own, with the same content as in the terminal (first 20; expanded when there
are at most 10). No HTML beyond `<details>/<summary>`.
Labels are escaped (Markdown punctuation including `$` for math; `<`, `>`, `&` as entities;
invisible and bidi characters made visible; control characters dropped), and GitHub's
post-Markdown filters are defused with a zero-width space before escaping: `:emoji:`
shortcodes, `@mentions`, `#123` / `org/repo#123` / `GH-123` references, bare `scheme://` URLs
and `www.` autolinks — a summary never pings people, links issues or turns labels into links.

## KGCL export

**Experimental**: the mapping may change in a minor release.

`--kgcl` writes the changes as [KGCL](https://github.com/INCATools/kgcl) (Knowledge Graph Change
Language), the change language OBO tools read: one command per line, hunk by hunk in the order of
the summary and, inside a hunk, in the order of its delta operations. The same inputs give the
same bytes. The library function is `kgdiff_report::render_kgcl`.

```sh
kgdiff mhd-2026-09.obo mhd-2026-10.obo --kgcl changes.kgcl
runoak -i simpleobo:mhd-2026-09.obo apply --changes-input changes.kgcl -o mhd-applied.obo   # OAK
```

| kgdiff                                 | KGCL                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| node added                             | `create node X 'label'` (`create X` for a node without a label) |
| node removed                           | `delete X`                                                      |
| edge added / removed                   | `create edge S P O` / `delete edge S P O`                       |
| moved: one parent replaced by another  | `move S P OLD from OLD to NEW`                                  |
| label changed                          | `rename X from 'old' to 'new'`                                  |
| synonym (alias) added                  | `create [exact\|narrow\|broad\|related] synonym 'a' for X`      |
| synonym removed                        | `remove synonym 'a' for X`                                      |
| deprecated (with one new `replacedBy`) | `obsolete X [with replacement Y]`                               |
| no longer deprecated                   | `unobsolete X`                                                  |
| definition added                       | `add definition 'd' to X`                                       |
| definition changed                     | `change definition of X from 'a' to 'b'`                        |
| definition removed                     | `remove definition for X`                                       |
| type added / removed (RDF inputs)      | `create edge X rdf:type T` / `delete edge X rdf:type T`         |

Definitions are the attributes `def` (OBO), `definition`, `IAO:0000115` and `skos:definition`.

The rest has no KGCL command and becomes a **comment**, a line `# <why>: <JSON>` that holds the
delta operation (or the hunk) it stands for, so nothing is dropped: other attribute changes
(`xref`, `comment`, `rdfs:comment`, …), id changes, edge labels and attributes, `replaces` and a
`replacedBy` change without obsoletion, type changes outside RDF, splits (one comment before the
split's own changes), merges that are not an obsoletion with replacement, implicit nodes (edge
endpoints the file does not declare), and the fields of a new node or edge that its command
cannot carry. A text KGCL cannot quote is a comment too: KGCL's strings are single-quoted with no
escapes, so a label, synonym or definition that is empty or holds a `'` or a line break cannot be
written (`Alzheimer's disease`). kgdiff prints one warning on stderr with the number of comments.
OAK (`runoak apply`) skips `#` lines; KGCL itself has no comments, so other readers may need them
removed first (`grep -v '^#'`).

Ids are written as KGCL takes them: an IRI as a CURIE with the prefixes the two files declare
(plus the well-known ones and the OBO PURL rule, `http://purl.obolibrary.org/obo/GO_0008150` →
`GO:0008150`), else in angle brackets (`<https://example.org/x>`); any other id as it is. An id
with whitespace, or one that starts with a quote or `<`, cannot be written, and its change is a
comment. With OBO inputs `is_a` is written `rdfs:subClassOf`, synonyms carry their scope, and the
stanza type `Term` goes without saying.

The commands follow the grammar [`src/kgcl_schema/grammar/kgcl.lark`](https://github.com/INCATools/kgcl/blob/1849f9cbb3ebb4a5ee0e6c62b11238841eb81d66/src/kgcl_schema/grammar/kgcl.lark) of INCATools/kgcl at commit `1849f9c` (2026-11-18),
restricted to those the released `kgcl-schema` 0.7.0 parses too (it has no `add label`, so a
label given to a node that had none is a comment). The parser of `kgcl-schema` resolves a full
IRI in angle brackets only when its namespace is one it knows (OBO, Bioregistry, common linked
data prefixes); other IRIs it reads as empty, which is a limit of that parser, not of the syntax.

## HTML report

A single file: the standalone viewer bundle (`@kgdiff/viewer/standalone`) plus the
`ReportPayload` in `<script type="application/kgdiff+json">` (gzip + base64 above 512 kB,
decoded with `DecompressionStream`). No network access needed; opens instantly because diff and
layout were computed by the CLI. `--reproducible` makes it byte-identical for identical inputs.

When the layout covers only the changes (graphs above the layout's large-graph threshold,
`layout.scope: "changes"`), the CLI also inlines the viewer's compute add-on
(`@kgdiff/viewer/standalone/compute`, sets `globalThis.KgdiffCompute`) right after the viewer
bundle, so collapsed groups can be expanded and laid out in the browser. Reports with a full
layout skip it to stay small; `--no-compute` always skips it. A missing add-on is a warning
(the report is still written), a missing viewer bundle an error (exit 2).

Document structure: `<!doctype html>`, `lang` from the locale, charset, viewport, `<title>`, an
inline style that paints the theme background (per `prefers-color-scheme` unless `--theme` forces
one) to avoid a white flash, a visually hidden `<h1>` and a `<kgdiff-viewer global-shortcuts>` (the page is the viewer, so its
keyboard shortcuts apply page-wide) filling the viewport inside `<main>`, a `<noscript>` summary, the payload script, then the bundle(s).
The viewer element carries `mode` and `scope` when they were given; theme, language and panel
states travel only in the payload's `view` (an attribute would outrank what the reader chose
before), and the viewer applies them as soon as the payload is read.

The payload (`ReportPayload`, `format: "kgdiff.report"`, `version: 1`; JSON Schema
[`report.v1.json`](../packages/core/schema/report.v1.json)) holds the packed diff, the
layout, `meta` (title, generator, timestamp, the two sides' names and formats) and `view`: `mode`,
`scope`, `theme`, `locale` and, from kgdiff 0.6, `panels` (an object of region → state, e.g.
`{ "detail": "collapsed" }`). Every `view` field is optional; a viewer ignores the ones it does
not know or that are invalid (with a console warning), so older reports without `panels` open
with the default layout. From kgdiff 0.7 the `layout` is optional too: a viewer reads a payload
without one (the member left out) by laying the diff out when it opens, with the compute add-on
(`globalThis.KgdiffCompute`), and shows an error that says so when the add-on is missing. This
CLI always writes the layout.
`</script` and `<!--` never appear inside inline JSON or JavaScript.
