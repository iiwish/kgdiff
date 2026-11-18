---
'@kgdiff/g6': patch
'@kgdiff/scene': patch
---

A host that draws its own change view with the G6 adapter needs no workarounds for four things it had to do by hand.

The replay steps both ways. `DiffGraphController.seekReplay(index)` puts the replay at a hunk, forwards or backwards, without rebuilding the graph: `-1` is its start, the earlier version before any hunk, and any other index is the end of that hunk with the hunk spotlighted and in view, what `selectHunk(index)` shows in the replay layer. It switches to the replay layer from another one and stops a running `playReplay`. `selectHunk` is unchanged: `selectHunk(-1)` still only clears the selection.

`DiffGraphController.hunkOf(elementId)` says which hunk a drawn G6 element belongs to (-1 for none), for a host that keeps its own selection in step with clicks. `KgdiffDatumData`, the `data` of every element the adapter generates, is now described field by field as part of the adapter's contract.

`hunkOfNode(scene, id)` in `@kgdiff/scene` gives the hunk that changes a node, from a node id of either version: the later version's node when it has one, else the earlier version's (`id@before` when the later version reuses its id).

`sceneFromReport(payload, options)` in `@kgdiff/scene` builds the scene of a `kgdiff.report` payload, and `reportFromJSON(payload)` reads it into `{ diff, layout, meta, view }`; both throw a `KgdiffError` for a value that is not a report (`invalid-input`) or is of another version (`unsupported-version`), and `sceneFromReport` for a payload without a layout. The scene is in the report's language, palette and node shapes (`view.locale`, `view.palette`, `view.shapes`) unless the options give them, as in `<kgdiff-viewer>`; the theme is the host's. `ReportPayload` and `ReportView` are its types, and `ReportPayload` of `@kgdiff/viewer` is assignable to the former.
