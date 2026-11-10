# @kgdiff/formats

## 0.8.0

### Patch Changes

- @kgdiff/core@0.8.0

## 0.7.0

### Minor Changes

- cca58f9: JSON input with a lone surrogate escape is rejected. `JSON.parse` accepts `"\ud800"`, half of a UTF-16 surrogate pair escaped without its other half, and kgdiff used to carry it through ids and labels into its diffs and deltas; such text is not Unicode, and the Rust implementation (RFC 0002) cannot hold it. `parseGraph` now throws `invalid-input` for one in JSON and JSON-LD, located at the escape (`Invalid JSON on line 6, column 35: the escape \ud83d is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept.`), and so does a JSON-LD context text a `documentLoader` returns; `kgdiff apply` refuses a delta that has one. Escaped surrogate pairs (`"😀"`) read as before.
- cca58f9: Numbers beyond the range of a double in JSON graphs are kept instead of lost. JSON may write `1e400`, which `JSON.parse` reads as `Infinity`; the JSON reader used to drop such a number without a word (an attribute or `meta` member disappeared, an array item became `null`), so a diff could report nothing for a value that changed, or a change that did not happen. It now keeps the value as the string `"Infinity"` or `"-Infinity"`, as `normalize` keeps a non-finite number an API caller passes, and reports how many with a `json-non-finite` warning (`ParseWarningCode`), in every JSON dialect.

### Patch Changes

- Updated dependencies [d01c4e0]
- Updated dependencies [7586808]
  - @kgdiff/core@0.7.0

## 0.6.0

### Patch Changes

- @kgdiff/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [638c617]
- Updated dependencies [f957a49]
- Updated dependencies [ed1c3c9]
- Updated dependencies [212c48c]
- Updated dependencies [f02bc72]
- Updated dependencies [6ed2b9c]
- Updated dependencies [6d34966]
  - @kgdiff/core@0.5.0

## 0.4.0

### Patch Changes

- @kgdiff/core@0.4.0

## 0.3.0

### Patch Changes

- @kgdiff/core@0.3.0

## 0.2.0

### Minor Changes

- 0330630: kgdiff JSON names its format like diffs and deltas do: `graphToJSON` and `kgdiff apply` write `"format": "kgdiff.graph", "version": 1` first. Files without the marker are still read by their shape. With it, a file is read as kgdiff JSON without guessing, a newer version is refused, and so is a diff or a delta given where a graph is expected, with a message that says what the file is. JSON Schemas for graphs, diffs and deltas ship with `@kgdiff/core` (`@kgdiff/core/schema/graph.v1.json`, `diff.v1.json`, `delta.v1.json`), and tests validate everything kgdiff writes against them.

### Patch Changes

- Updated dependencies [0330630]
  - @kgdiff/core@0.2.0

## 0.1.0

Initial release.
