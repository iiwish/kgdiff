---
'@kgdiff/viewer': patch
---

The viewer's saved review progress is versioned. New writes carry `v: 1` in the value (the key is unchanged, so saved progress stays). Progress saved without a version is read as before and upgraded on the next write; a value from a newer viewer is read but never overwritten.
