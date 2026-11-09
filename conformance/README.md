# kgdiff conformance corpus

A language-neutral specification by example of what kgdiff computes and prints. Every case holds
input graphs, the options to diff them with, and the outputs of the reference implementations
(the TypeScript packages of this repository for the library outputs, the Rust `kgdiff` for what
the CLI produces; "Changing the corpus" below): the diff, the packed diff, the delta and its
inverse, the content hashes, the normalized graphs, the parse results, the hunk titles, the report
payload's metadata, the layout's combinatorial part, and the CLI's text outputs, warnings, error
messages and exit codes. Primitive vectors pin the JavaScript built-ins those outputs depend on.

An implementation conforms when it reproduces every expected file of every case and passes every
primitive vector. The Rust port described in
[RFC 0002](../docs/rfcs/0002-rust-compute-core.md) is checked against it; so is the TypeScript
implementation, on every CI run (`pnpm test`).

## Layout

```
conformance/
  manifest.json                 format marker, the list of cases and primitive vectors
  cases/<id>/
    case.json                   what the case is, how to parse and diff it, the CLI runs
    <inputs>                    the input files, as bytes (UTF-16, gzip and CRLF included)
    expected/
      parse.before.json         ParseResult of each input                             (value)
      parse.after.json
      graph.before.json         graphToJSON of each normalized graph                  (bytes)
      graph.after.json
      issues.json               normalize's issues of each graph                      (value)
      hashes.json               hashGraph of each normalized graph                    (value)
      diff.json                 kgdiff --json  = diffToJSON                           (bytes)
      diff.packed.json          packDiffJSON(diffToJSON(…))                           (bytes)
      delta.json                kgdiff --delta = the diff's delta                     (bytes)
      delta.inverse.json        invertDelta(delta)                                    (bytes)
      apply.json                kgdiff apply <before> expected/delta.json             (bytes)
      titles.json               formatHunk of every hunk, in English and Chinese      (value)
      report.json               the HTML report payload without its diff and layout  (value)
      layout-contract.json      the part of layoutDiff that is not floating point     (value)
      cli/*                     stdout of the other CLI runs listed in case.json      (bytes)
  primitives/*.json             vectors for number formatting, string order, log2, …
  cases.ts, corpus.ts, …        the generator (TypeScript); not part of the format
```

**Bytes** files must be reproduced exactly. **Value** files — `parse.*`, `issues`, `hashes`,
`titles`, `report` and `layout-contract` — are compared as JSON values: parse both, then compare
recursively (object key order does not matter, arrays are ordered, numbers are compared as IEEE
754 doubles). Expected files and vectors are UTF-8, and every non-empty one ends with a newline
(an empty `--name-status` listing is an empty file); inputs are just bytes. The recorded graphs,
diffs, packed diffs and deltas also validate against their JSON Schemas in
[`packages/core/schema/`](../packages/core/schema/) (`graph.v1`, `diff.v1`, `diff-packed.v1`,
`delta.v1`); the check verifies that too.

## manifest.json

```json
{
  "format": "kgdiff.conformance",
  "version": 1,
  "versionPlaceholder": "kgdiff <version>",
  "cases": [{ "id": "dataset-enterprise-kg", "covers": ["dataset", "kgdiff-json", "…"] }, …],
  "primitives": ["primitives/number-to-string.json", …]
}
```

A reader rejects another `format` and a `version` greater than it supports. `covers` lists short
tags of what a case exercises (free text, for filtering and coverage reports).

## case.json

| Field             | Meaning                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `id`              | the directory name                                                                           |
| `description`     | what the case is about                                                                       |
| `inputs`          | `{ "before": <file>, "after": <file> }`, names inside the case directory                     |
| `extraInputs`     | further input files that only CLI runs read (error cases)                                    |
| `copiedFrom`      | for the dataset cases: the repository paths the inputs are byte-for-byte copies of           |
| `parse`           | per side: `format` (`auto` or a format id), `filename`, `languages` (optional), `allowEmpty` |
| `options`         | the `DiffOptions` as given (only what the CLI can express)                                   |
| `resolvedOptions` | the same options with every default filled in (`resolveOptions`)                             |
| `locale`          | locale of the standard CLI runs                                                              |
| `layoutOptions`   | the `LayoutOptions` of `layout-contract.json`                                                |
| `identical`       | `stats.identical` of the diff                                                                |
| `cli`             | the CLI runs, below                                                                          |

### Library outputs

With `before` and `after` the two inputs:

1. **Decode** each input as the CLI does: gunzip when it starts with `1f 8b`; then UTF-16LE when
   it starts with `ff fe`, UTF-16BE with `fe ff`, else UTF-8 — strictly (invalid sequences are
   errors) and without the byte order mark.
2. **Parse** it. When `allowEmpty` is true and the text is empty or only JavaScript whitespace,
   the result is `parseGraph('{"nodes":[],"edges":[]}', { format: 'json', filename })`. Otherwise
   `parseGraph(text, { format, filename, rdf: { languages } })` (`rdf` only when `languages` is
   given). `parse.<side>.json` is `JSON.stringify(result)` of that `ParseResult`. Two rules of
   the JSON reader matter here (RFC 0002, D-2 and D-11): a number JSON can write but a double
   cannot hold (`1e400`, which `JSON.parse` reads as `Infinity`) becomes the string `"Infinity"`
   or `"-Infinity"`, in attributes, arrays and `meta`, with one `json-non-finite` warning
   (`json-numbers-and-keys`); and a lone surrogate escape (`"\ud800"`, half of a surrogate pair
   without its other half), which `JSON.parse` accepts, is an `invalid-input` error located at
   its backslash (`cli-errors`).
3. **Diff** the two parsed graphs: `result = diff(parse.before.graph, parse.after.graph, options)`.
   Then:
   - `graph.<side>.json` = `JSON.stringify(graphToJSON(result.<side>)) + "\n"`;
   - `issues.json` = `{ before: result.before.issues, after: result.after.issues }`;
   - `hashes.json` = `{ before: hashGraph(result.before), after: hashGraph(result.after) }` (equal
     to the delta's `base.hash` and `target.hash`);
   - `diff.json` = `JSON.stringify(diffToJSON(result)) + "\n"`;
   - `diff.packed.json` = `JSON.stringify(packDiffJSON(diffToJSON(result))) + "\n"`;
   - `delta.json` = `JSON.stringify(result.delta) + "\n"`;
   - `delta.inverse.json` = `JSON.stringify(invertDelta(result.delta)) + "\n"`;
   - `titles.json` = for `en` and `zh-CN`,
     `result.hunks.map(h => ({ id: h.id, ...formatHunk(h, result, locale) }))`;
   - `report.json` = `format`, `version`, `meta` and `view` of the `ReportPayload` embedded in
     the report that the arguments of the `summary` run plus `-o report.html --reproducible`
     write, with `meta.generator` written `kgdiff <version>`. The payload's `diff` is
     `diff.packed.json`; its `layout` is not normative;
   - `layout-contract.json`: from `layout = layoutDiff(result, layoutOptions)` and
     `json = layoutToJSON(layout)`: `options`, `strategy`, `scope`, `iterations` (union layouts
     only: an anchored layout simulates a window found by a range query on positions, so its tick
     count depends on geometry), `nodes` (the laid-out node ids, sorted by UTF-16 code units),
     `radii`, `hidden` and `components` (each component's node ids, in `json.components` order).
     Positions, bounds and the layout document's version are left out: a conforming layout
     reproduces everything here, not the positions (RFC 0002, "Layout decision").

`JSON.stringify` here means ECMAScript's, in particular: numbers in the shortest round-trip form
of `Number::toString` (`1e+21`, `1e-7`, `0.000001`, `1` for `1.0`, `0` for `-0`); object keys
in the order JavaScript enumerates them — keys that are canonical array indices (`"0"`, `"2"`,
`"10"`, …, up to `"4294967294"`; not `"01"` or `"-1"`) first in ascending numeric order, then
the others in insertion order; strings escaped as `JSON.stringify` does. `primitives/` pins each
of these rules.

### CLI runs

Each entry of `cli` is one run of `kgdiff`:

```json
{
  "name": "summary-stdin",
  "args": ["-", "after.json", "--match", "id", "--locale", "en", "--color", "never"],
  "env": { "COLUMNS": "100" },
  "stdin": { "file": "before.json" },
  "stdout": { "file": "expected/cli/summary.stdin.txt" },
  "stderr": { "text": "" },
  "exit": 0
}
```

| Field                | Meaning                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `name`               | unique within the case                                                                        |
| `args`               | the arguments after the program name; paths are relative to the case directory                |
| `env`                | the complete environment of the run                                                           |
| `stdin`              | optional: a file of the case directory whose bytes are piped to stdin; else stdin is empty    |
| `stdout`             | `{ "file": … }` (a bytes file) or `{ "text": … }` (the exact text, usually `""`)              |
| `versionPlaceholder` | optional, `true`: stdout contains `kgdiff <version>` where kgdiff prints its name and version |
| `stderr`             | `{ "text": … }`: the exact text                                                               |
| `exit`               | the exit code: 0, 1 (differences with `--exit-code`) or 2 (usage or input error)              |

Run `kgdiff` with `args`, the case directory as working directory, an environment holding `env`
and nothing else an implementation reads (on a real system only what is needed to start the
process, such as `PATH`, or `SystemRoot` on Windows), stdin from `stdin` or empty and never a
terminal, stdout and stderr captured through pipes. Then compare the exit code with `exit`, and
the bytes of stdout and stderr with the recorded file, or with the UTF-8 encoding of the recorded
text — the reference writes UTF-8, so a lone surrogate in a message reached the pipe as U+FFFD,
and that is what is recorded (`cli-errors`, `obo-clipped-line`). With `versionPlaceholder`,
replace `kgdiff <version>` by the implementation's `kgdiff X.Y.Z` before comparing.

The generator records the runs exactly this way, with the Rust `kgdiff` as a real process
(`pnpm conformance:update`), and CI replays every one of them with it on Linux, macOS and Windows
(`pnpm conformance:replay`, after `cargo build --release -p kgdiff`). Another implementation is
replayed with `pnpm conformance:replay --bin <executable>`.

The HTML report of every case, which no run records, is written by the generator too, with the
arguments of the `summary` run and `-o report.html --reproducible`: `report.json` records what its
payload says besides the diff and the layout; the generator checks that its diff is
`diff.packed.json`, that its layout (a version 2 document with a `generator`) is the one
`@kgdiff/layout` computes, version and generator aside, and that it inlines the compute add-on
exactly when that layout covers only the changes.

Every case has the standard runs `summary` (no output option), `stat` (`--stat`), `name-status`
(`--name-status`), `markdown` (`--markdown`), `json` (`--json`, stdout = `expected/diff.json`),
`delta` (`--delta`, stdout = `expected/delta.json`), `exit-code` (`--exit-code --quiet`: empty
stdout, exit 1 unless the graphs are identical) and `apply` (`kgdiff apply <before>
expected/delta.json`, with the before side's format and languages). Some cases add runs in the
other locale, at other widths, with `--pretty`, from stdin, or for error paths. The
reproducibility switches are always on: `--color never`, an explicit `--locale`, a fixed
`COLUMNS`, no terminal; no run writes an HTML report, so `--reproducible` and the clock never
come into play (`report.json` pins what the report payload says instead).

The recorded stderr holds kgdiff's own warnings and error messages, with their hints. Error
messages of third-party parsers (n3's Turtle syntax errors, for one) are not contracts, so no case
records one.

## Primitive vectors

Doubles are written as 16 hex digits of their IEEE 754 bits (big-endian), so checking number
formatting never depends on number formatting. Each file has a `description`. `label-width.json`
belongs to the layout (RFC 0002 phase 4); the others to the core (phase 2).

| File                      | Content                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number-to-string.json`   | `{ bits, string, json, exponential, fixed }`: `String(x)`, `JSON.stringify(x)`, `x.toExponential()` and `x.toFixed(0 / 1 / 2)` for curated and pseudo-random doubles |
| `number-from-string.json` | `{ text, number, json }`: bits of `Number(text)` (or `"NaN"`) and of `JSON.parse(text)` (or `null` for a syntax error)                                               |
| `js-math.json`            | `Math.round` (half up, keeping `-0`), `ToUint32` (`x >>> 0`), `ToInt32` (`x \| 0`)                                                                                   |
| `log2.json`               | core's exact `log2` (its operations are in the file) for n = 1…1024, inputs C libraries round differently and special values; a SHA-256 over all n up to 2²²         |
| `string-order.json`       | strings in JavaScript's default sort order (UTF-16 code units)                                                                                                       |
| `json-roundtrip.json`     | `JSON.stringify(JSON.parse(text))`, compact and with `null, 2`; `null` when the text is not JSON or holds a lone surrogate escape (RFC 0002, D-2)                    |
| `text-similarity.json`    | `[a, b, textSimilarity(a, b)]`                                                                                                                                       |
| `predicate-label.json`    | `[predicate, predicateLabel(predicate)]`                                                                                                                             |
| `label-width.json`        | `[text, fontSize, estimateLabelWidth(text, fontSize)]` and `[degree, nodeRadius(degree)]`                                                                            |
| `facet-labels.json`       | `facetLabel(kind, locale)` for every facet kind                                                                                                                      |

## Cases

| Case                                                          | What it covers                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataset-*` (6)                                               | the example datasets with the options of their `meta.json` (read from it): kgdiff JSON in Chinese and English, OBO, similarity matching, dbt lineage, Turtle                                                                                             |
| `match-id-hints`                                              | `--match id` with `replaces` / `replacedBy`: rekeys, a hinted merge and split, a deprecation, a move, a rekeyed self-loop; the before graph read from stdin as well                                                                                      |
| `match-auto-heuristics`                                       | heuristic merge and split, collapsed edges, move, retarget, predicate change, a below-threshold suggestion                                                                                                                                               |
| `self-loops`                                                  | self-loops added, removed, retargeted, relabelled, parallel, carried by a merge                                                                                                                                                                          |
| `unicode-text`                                                | astral, private-use and fullwidth characters, NFC / NFKC, case folding, emoji, CJK, bidi and control characters, narrow terminals                                                                                                                        |
| `json-numbers-and-keys`                                       | numbers JavaScript and Rust print differently, numbers beyond the double range (`json-non-finite`), integer-like and duplicate keys, `__proto__`, nested values, `--pretty`                                                                              |
| `dangling-and-duplicates`                                     | numeric ids, duplicate nodes, an empty id, dangling endpoints, parallel edges                                                                                                                                                                            |
| `edge-identity-id`                                            | `--edge-identity id`                                                                                                                                                                                                                                     |
| `options-ignore-watch`                                        | every CLI diff option, `--watch-attr`                                                                                                                                                                                                                    |
| `identical`, `empty-before`, `similarity-rekey-preamble`      | no change; `--allow-empty`; an identical diff whose delta renames ids, in a cycle                                                                                                                                                                        |
| `rdf-turtle-ntriples`, `rdf-nquads-trig`, `rdf-xml`, `jsonld` | the RDF syntaxes, typed literals, languages, blank nodes, named graphs, DTD entities, XML literals, annotations, JSON-LD contexts                                                                                                                        |
| `obo-variants`                                                | OBO with CRLF line endings, alt_id, obsoletion, typedefs, and every lenient-parse warning                                                                                                                                                                |
| `json-dialects-a`, `-b`, `-c`                                 | Cytoscape.js, d3 / NetworkX, AntV G6, graphology, vis-network, kgdiff JSON with positions (an anchored layout)                                                                                                                                           |
| `encodings`, `encodings-be`                                   | UTF-16LE with a byte order mark and CRLF, gzip; UTF-16BE, UTF-8 with a byte order mark and CRLF                                                                                                                                                          |
| `cli-errors`                                                  | exit code 2 and kgdiff's messages: invalid JSON, lone surrogate escapes in a graph and a delta, an OBO line clipped inside a surrogate pair, undetectable, empty, missing and oversized inputs, usage errors, `apply` on the wrong base, lenient `apply` |
| `synthetic-600`                                               | 600 synthetic nodes with CJK labels (`scripts/gen-synthetic.ts --nodes 600 --seed 7 --cjk`); a changes-only layout scope                                                                                                                                 |

One recorded behaviour is worth knowing, since a port might "fix" it by accident; it is a known
issue of the reference (RFC 0002, §11): with `ignoreAttrs` (`options-ignore-watch`), the delta
leaves the changes of ignored attributes out while `hashGraph` covers them, so `kgdiff apply`
warns that its result differs from the delta's target.

## Unicode

The TypeScript implementation takes Unicode data (normalization, case mapping, character
properties, grapheme clusters) from the runtime's ICU, whose Unicode version differs between Node
releases. The corpus therefore only uses characters assigned by Unicode 13 whose properties have
not changed since, so that it holds on every supported Node (22, 24, 26). An implementation pinned
to another Unicode version agrees with it on these characters; behaviour for characters assigned
or changed in newer versions is outside the corpus.

## Using the corpus from another implementation

```text
manifest = read_json("conformance/manifest.json"); assert manifest.format == "kgdiff.conformance"
for case in manifest.cases:
    dir = "conformance/cases/" + case.id; c = read_json(dir + "/case.json")
    parsed = { side: parse(decode(read_bytes(dir + "/" + c.inputs[side])), c.parse[side]) }
    assert_json_value(parsed.before, dir + "/expected/parse.before.json")   # and after
    result = diff(parsed.before.graph, parsed.after.graph, c.options)
    assert_bytes(js_json(diff_to_json(result)) + "\n", dir + "/expected/diff.json")
    …                                                                        # every file above
    for run in c.cli:
        out = run_cli(run.args, cwd=dir, env=run.env, stdin=read_bytes_or_empty(dir, run.stdin))
        assert out.exit == run.exit and out.stderr == utf8(run.stderr.text)
        expected = read_bytes(dir + "/" + run.stdout.file) if "file" in run.stdout else utf8(run.stdout.text)
        assert out.stdout == (expected with "kgdiff <version>" replaced, if run.versionPlaceholder)
```

An implementation that is not complete yet runs the parts it has: a core library alone starts from
`parse.<side>.json`'s `graph`, without parsing; a CLI that cannot write HTML reports yet skips
`report.json`.

## Changing the corpus

The corpus is generated; never edit an expected file by hand.

```sh
pnpm build:viewer-assets                 # once: the viewer bundles kgdiff's reports embed
pnpm conformance:update                  # regenerate everything (builds the Rust kgdiff first)
pnpm vitest run --project conformance    # check the TypeScript packages (also part of pnpm test)
cargo test --workspace                   # check the Rust crates against it
cargo build --release -p kgdiff && pnpm conformance:replay
```

- The library outputs (everything below `expected/` but `cli/`, `apply.json` and `report.json`)
  come from the TypeScript packages; the CLI runs (`case.json`'s `cli`, their stdout files, which
  include `diff.json` and `delta.json`) and `report.json` from the Rust `kgdiff`, which `pnpm
  conformance:update` builds with `cargo build --release -p kgdiff` and runs as a real process
  (`--bin <path>` records with another executable). Where both write a file, or the report embeds
  one, the generator checks that they agree.
- `pnpm test` regenerates the library outputs and `case.json`'s definitions, and reads the CLI's
  outputs as given, so it needs no Rust toolchain; CI regenerates the whole corpus with the Rust
  `kgdiff` and fails on any difference, and replays every run on each OS.
- A behaviour change shows up as a failing `pnpm test` (TypeScript packages) or `cargo test` and
  replay (Rust); regenerate, review the diff of `conformance/` (it is the change every
  implementation must follow) and commit it with the code.
- A new case: add its inputs under `cases/<id>/` (or point `copiedFrom` at a dataset), add a
  definition to `cases.ts`, regenerate. Keep inputs small and their characters Unicode-stable.
- `pnpm conformance:update` rewrites `case.json`, `expected/`, copied inputs, `primitives/` and the
  manifest, removes expected files no longer generated, and never touches authored inputs; a
  directory under `cases/` that no case defines is reported, for removal by hand.
- Inputs are committed as bytes: `.gitattributes` disables line-ending conversion below
  `conformance/cases/`, and Biome does not format the corpus.
- Generated outputs never depend on the time, the machine or the kgdiff version (the Markdown
  footer's version is replaced by `kgdiff <version>`), so the corpus only changes when behaviour
  does.

**Who generates the corpus.** The reference moves to the Rust port one part at a time, and only
after the Rust part reproduces the corpus as it stands. Since phase 4 the Rust `kgdiff` records
what the CLI produces (the CLI runs and `report.json`); the TypeScript packages still generate the
library outputs, the layout contract among them, until phase 5 moves everything else. From then
on the TypeScript check covers only what TypeScript keeps (the read path). RFC 0002, §9, "Corpus
ownership", has the details.

The corpus data is released under CC0-1.0, like the example datasets it copies.
