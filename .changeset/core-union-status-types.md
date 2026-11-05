---
'@kgdiff/core': minor
---

`UnionNode` and `UnionEdge` are now unions by `status`, so the types say which versions an element is in: an `added` node has `afterId` and `after` and no before version, a `removed` one only `beforeId` and `before`, an `unchanged` or `modified` one both; the same for edges, where only edges in both versions can have `sourceBefore`, `targetBefore` or `predicateBefore`. Narrow on `status` to read `before` / `after` without `?.` or casts (`AddedUnionNode`, `RemovedUnionNode`, `MatchedUnionNode` and the edge counterparts name the cases). The objects themselves are unchanged; code that builds union elements by hand (test fixtures, mocks) now has to give each status the versions it implies.
