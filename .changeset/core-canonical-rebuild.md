---
'@kgdiff/core': patch
'@kgdiff/viewer': patch
---

`diffFromJSON` is about 30% faster on large diffs, so HTML reports open about 20% sooner: a report of 100k nodes / 300k edges is ready in 1.0 s instead of 1.24 s in headless Chrome. Rebuilding the two graphs was most of `diffFromJSON`. The snapshots `diffToJSON` writes are already canonical, so they are now read straight into graphs, and each union edge keeps the edge it was read into instead of looking it up again. A document `normalize` would change (parallel edges, a repeated id, a dangling end, a hand-edited snapshot) is normalized as before, as fast as before. The result is the same, field for field and in the same order: `diffToJSON(diffFromJSON(j))` is still `j`, byte for byte, the graph hashes are unchanged, and every consistency check still runs.
