# What is kgdiff?

kgdiff is `git diff` for knowledge graphs. Give it two versions of a graph (an ontology release,
a GraphRAG extraction, a lineage DAG) and it tells you what happened in the terms a reviewer
thinks in: a term merged into another, a class moved under a new parent, a relation pointed
somewhere else, a label renamed. You get the answer in the terminal, as a pull request comment,
or in an interactive viewer that shows both versions on one stable map.

![The kgdiff viewer replaying the changes between two versions of a schema.org-style vocabulary, one hunk at a time](./images/replay-en.webp)

```sh
npx @kgdiff/cli before.obo after.obo
```

```
kgdiff  mhd 2026-09-01 → 2026-10-01                    179 → 184 nodes · 351 → 353 edges

  +3 added   ~12 modified   ⇄7 restructured                       58 changes in 22 hunks
  +++++~~~~~~~~~~~~⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄⇄

  Restructured 7
  ⊕ Merged “juvenile diabetes” and “insulin-dependent d…   identity · via replacement h…
  ⊕ Merged “heart attack” into “myocardial infarction”     identity · via replacement h…
  ⇄ Moved “Crohn disease” under “inflammatory bowel dis…   structure · from “intestinal…
  ⑂ Split “diabetes insipidus” into “arginine vasopress…   identity · inferred · 80% co…
  …
  Modified 12
  ~ Renamed “alcoholic liver disease” → “alcohol-relate…   content · ~1 attribute · +1…
  …
```

## Why not a text diff?

A text diff compares files. Rename one class in Turtle and every line that mentions it changes;
merge two terms and you see a deletion plus edits scattered across the file; serialize the same
graph again and everything looks different. kgdiff compares the graphs:

- **It matches nodes across versions**: by id, by replacement hints such as OBO `replaced_by`,
  or by label and neighbourhood when ids mean nothing, as in two LLM extraction runs.
- **It classifies what changed**: renames, id changes, types, synonyms, attributes,
  deprecation, moves in a hierarchy, merges, splits, retargeted relations and predicate changes.
- **It groups changes into hunks**, one per decision a reviewer makes, in an order that reads
  like a story: clean up (removed), restructure, refine (modified), grow (added).
- **It ignores what does not matter**: the same graph as Turtle or as N-Triples, or with its
  statements in another order, diffs as identical.

## Ways to use it

| You want to…                                  | Use                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| See what changed between two files            | the CLI: [Getting started](./getting-started.md)                        |
| Explain every pull request that edits a graph | the [GitHub Action](./guide/ci.md), or the CLI in any CI                |
| Explore a diff visually                       | an HTML report (`-o report.html`) or the [playground](/playground.html) |
| Show diffs in your own application            | the [`<kgdiff-viewer>` web component](./guide/viewer.md)                |
| Diff graphs in code                           | the [libraries](./guide/library.md)                                     |

### Which package to install

Most people need one package; it depends only on what you want to do:

| You want to…                                      | Install                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| Compare graph files in the terminal or in CI      | `@kgdiff/cli` (`npx @kgdiff/cli a.ttl b.ttl`), or the GitHub Action   |
| Show a diff in a web page, without rendering code | `@kgdiff/viewer` (the `<kgdiff-viewer>` web component)                |
| Compute diffs in your code, draw them yourself    | `@kgdiff/core`, plus `formats`, `layout`, `scene` or `g6` as you need |

`@kgdiff/cli` runs a native binary: npm installs the one for your machine with it
(`@kgdiff/cli-darwin-arm64`, `@kgdiff/cli-linux-x64-gnu`, …). Never install those yourself.
[Libraries](./guide/library.md) says what each library package does.

kgdiff reads RDF (Turtle, N-Triples, N-Quads, TriG, RDF/XML, JSON-LD), OBO and the common JSON
graph formats ([Formats](./formats.md)). Everything runs locally: the CLI on your machine, the
playground and the viewer in your browser. Nothing is uploaded.

## Next steps

- [Getting started](./getting-started.md): install the CLI and read your first diff.
- [Playground](/playground.html): try the example datasets or your own files in the browser.
- [Architecture](./architecture.md): how kgdiff matches, classifies and draws changes.
