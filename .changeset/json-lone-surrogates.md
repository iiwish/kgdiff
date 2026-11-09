---
'@kgdiff/formats': minor
'@kgdiff/cli': minor
---

JSON input with a lone surrogate escape is rejected. `JSON.parse` accepts `"\ud800"`, half of a UTF-16 surrogate pair escaped without its other half, and kgdiff used to carry it through ids and labels into its diffs and deltas; such text is not Unicode, and the Rust implementation (RFC 0002) cannot hold it. `parseGraph` now throws `invalid-input` for one in JSON and JSON-LD, located at the escape (`Invalid JSON on line 6, column 35: the escape \ud83d is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept.`), and so does a JSON-LD context text a `documentLoader` returns; `kgdiff apply` refuses a delta that has one. Escaped surrogate pairs (`"😀"`) read as before.
