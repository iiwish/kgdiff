# @kgdiff/cli

## 0.2.0

### Minor Changes

- 0330630: kgdiff JSON names its format like diffs and deltas do: `graphToJSON` and `kgdiff apply` write `"format": "kgdiff.graph", "version": 1` first. Files without the marker are still read by their shape. With it, a file is read as kgdiff JSON without guessing, a newer version is refused, and so is a diff or a delta given where a graph is expected, with a message that says what the file is. JSON Schemas for graphs, diffs and deltas ship with `@kgdiff/core` (`@kgdiff/core/schema/graph.v1.json`, `diff.v1.json`, `delta.v1.json`), and tests validate everything kgdiff writes against them.

### Patch Changes

- d88fc85: The detail panel (and the HTML report) leads with what changed: one row per changed facet, before → after. A lone removed and added synonym, type or parent reads as one edit (`老赖 → 失信人`), similar ones pair up, and unchanged attributes fold behind a toggle. Added and removed nodes now show their synonyms.
- Updated dependencies [d88fc85]
- Updated dependencies [0330630]
  - @kgdiff/viewer@0.2.0
  - @kgdiff/core@0.2.0
  - @kgdiff/formats@0.2.0
  - @kgdiff/layout@0.2.0
  - @kgdiff/scene@0.2.0

## 0.1.0

Initial release.
