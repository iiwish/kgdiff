# @kgdiff/core

## 0.6.0

No changes in this release.

## 0.5.0

### Minor Changes

- f957a49: `diffFromJSON` checks that a diff document is consistent before it returns, and throws `invalid-input` naming the first contradiction: an element whose versions do not fit its status (an added node with a before id, a removed edge with an after snapshot), an unchanged element with facets or a hunk, a changed one outside every hunk, a repeated id, an edge whose endpoints are not union nodes or disagree with its snapshots, a hunk that lists elements that are not its own, delta ops owned by two hunks or out of range, hunks out of review order, a summary or stats that do not match the elements, or a delta whose base or target is another graph (by content hash). Until now such a document was read as it was, and a viewer could show wrong counts or export a delta for other graphs. Everything kgdiff writes passes. `diffFromJSON` is also about 10% faster on large diffs: edges are found by their key instead of by a canonical JSON fingerprint. `schema/diff.v1.json` states the same rules per element (versions by status; facets and hunk by status).
- 212c48c: `UnionNode` and `UnionEdge` are now unions by `status`, so the types say which versions an element is in: an `added` node has `afterId` and `after` and no before version, a `removed` one only `beforeId` and `before`, an `unchanged` or `modified` one both; the same for edges, where only edges in both versions can have `sourceBefore`, `targetBefore` or `predicateBefore`. Narrow on `status` to read `before` / `after` without `?.` or casts (`AddedUnionNode`, `RemovedUnionNode`, `MatchedUnionNode` and the edge counterparts name the cases). The objects themselves are unchanged; code that builds union elements by hand (test fixtures, mocks) now has to give each status the versions it implies.
- 6ed2b9c: HTML reports are smaller: they embed the diff packed (`packDiffJSON`, format `kgdiff.diff.packed`, schema `schema/diff-packed.v1.json`), with its unchanged elements, which are most of a large diff, stored as tables of indices into one string table. For 100k nodes / 300k edges the embedded diff goes from 68.7 MB to 19.3 MB, 6.8 MB to 3.2 MB gzipped, and the report opens as fast. `unpackDiffJSON` gives the `DiffJSON` back byte for byte; the viewer reads packed and unpacked payloads (`ReportPayload.diff` is either), so older reports still open. The standalone viewer bundle budget goes from 100 kB to 105 kB (min + gzip) for the unpacking and the consistency checks of `diffFromJSON`.

### Patch Changes

- 638c617: `diffFromJSON` is about 30% faster on large diffs, so HTML reports open about 20% sooner: a report of 100k nodes / 300k edges is ready in 1.0 s instead of 1.24 s in headless Chrome. Rebuilding the two graphs was most of `diffFromJSON`. The snapshots `diffToJSON` writes are already canonical, so they are now read straight into graphs, and each union edge keeps the edge it was read into instead of looking it up again. A document `normalize` would change (parallel edges, a repeated id, a dangling end, a hand-edited snapshot) is normalized as before, as fast as before. The result is the same, field for field and in the same order: `diffToJSON(diffFromJSON(j))` is still `j`, byte for byte, the graph hashes are unchanged, and every consistency check still runs.
- ed1c3c9: Normalized graphs take about 30% less memory: a graph of 100k nodes and 300k edges now keeps about 111 MB of heap instead of 157 MB. Structural edge keys were built by concatenation, which V8 stores as a rope of many small strings that stays allocated behind every key; they are now built as flat strings, which are also quicker to hash. Keys, diffs, deltas and their JSON are unchanged, byte for byte.
- f02bc72: Similarity matching no longer pairs two same-named nodes on their label alone when their types conflict. With `--match similarity` nothing is matched in the first round, so the neighbour evidence was missing for every pair and an equal label outweighed disjoint types: “Mercury” the planet (orbiting the Sun) and “Mercury” the element (with symbol Hg) were reported as one node whose type changed. Such a pair (both nodes typed, no type and no attribute in common, neighbours not matched yet) now waits for the next round, when propagation brings in the neighbours; the two Mercurys share none, so they are reported as removed and added with a possible match below the threshold, as `--match auto` already did. A type change that the neighbours confirm is still matched, and nodes without edges are matched as before.
- 6d34966: The standalone viewer bundle, which every HTML report inlines, no longer carries the facet names
  of `facetLabel`: they are kept apart from the hunk phrasebooks that `formatHunk` reads, which
  saves 0.2 kB (min + gzip). Behaviour is unchanged. The bundle's size ceiling goes from 105 kB to
  130 kB, so a feature no longer has to raise it, and the HTML report overhead budget (without data
  or compute add-on) from 120 kB to 135 kB gzip, so it still covers the bundle.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- 0330630: kgdiff JSON names its format like diffs and deltas do: `graphToJSON` and `kgdiff apply` write `"format": "kgdiff.graph", "version": 1` first. Files without the marker are still read by their shape. With it, a file is read as kgdiff JSON without guessing, a newer version is refused, and so is a diff or a delta given where a graph is expected, with a message that says what the file is. JSON Schemas for graphs, diffs and deltas ship with `@kgdiff/core` (`@kgdiff/core/schema/graph.v1.json`, `diff.v1.json`, `delta.v1.json`), and tests validate everything kgdiff writes against them.

## 0.1.0

Initial release.
