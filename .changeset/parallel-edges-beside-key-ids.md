---
'@kgdiff/cli': patch
'@kgdiff/core': patch
'@kgdiff/compute': patch
---

With edges identified by id (`--edge-identity id`), a delta now applies to the graph it was made from when an edge's id is the structural key of a triple, such as `["a","p","b"]`, and that triple also has parallel copies without ids. Such an id pushes the copies' keys aside to `#2#2` and the like, and the diff paired copies of one triple as if they belonged to different triples: it reported unchanged copies as modified, and with `--ignore-attr` it could write a delta that `kgdiff apply` refused with "edge already exists". The copies are now paired by the triple they connect. Graphs without such ids give the same diff and delta as before.
