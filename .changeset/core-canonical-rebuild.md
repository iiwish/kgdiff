---
'@kgdiff/core': patch
'@kgdiff/viewer': patch
---

`diffFromJSON` is about a third faster on large diffs, so HTML reports open faster: a report of 100k nodes / 300k edges is ready in 0.95 s instead of 1.22 s in headless Chrome, and `diffFromJSON` takes 0.57 s instead of 0.88 s in Node. Rebuilding the two graphs was most of its time. The snapshots `diffToJSON` writes are already canonical, so they are now read straight into graphs, and each union edge keeps the edge it was read into instead of looking it up again. A document `normalize` would change (parallel edges, a repeated id, a dangling end, a hand-edited snapshot) is normalized as before. The result is the same, field for field and in the same order: `diffToJSON(diffFromJSON(j))` is still `j`, byte for byte, the graph hashes are unchanged, and every consistency check still runs.
