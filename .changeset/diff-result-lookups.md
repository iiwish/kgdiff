---
'@kgdiff/cli': patch
'@kgdiff/core': patch
'@kgdiff/compute': patch
---

For Rust callers of `kgdiff-core`: the lookups of a `DiffResult` (`node`, `node_by_before`, `node_by_after`, `edge`, `hunk` and `edges_of`) no longer panic, and no longer return the wrong element, when the caller has changed the public `nodes`, `edges` or `hunks` vectors after a first lookup. The lookups index the vectors as they were at that first lookup, so an element that was moved, removed or added since is not found; the documentation of `DiffResult` says so. A later release reads these fields through accessors. Code that does not change a `DiffResult` gets the same results as before; what the CLI and the JavaScript packages compute and print does not change.
