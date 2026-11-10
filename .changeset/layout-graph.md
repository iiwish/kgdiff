---
"@kgdiff/cli": minor
---

The Rust crate `kgdiff-layout` lays out one graph: `layout_graph(&graph, &options)` gives the positions `layout_diff` gives the diff of that graph with itself, with every node in scope whatever the size of the graph, so an application that shows a graph and then a diff of it moves no node between the two (RFC 0003, part 1). The two are held to the same `kgdiff.layout` bytes on both graphs of every case of the conformance corpus. Known positions, as pins or as `position` on the nodes, are kept exactly and only the other nodes are placed, which is how the next version of a graph keeps the previous version's map; scope `Changes` is `invalid-input`. The function is experimental for one minor release. `@kgdiff/layout` has no counterpart: `@kgdiff/compute` will export it with the rest of the layout (RFC 0002, phase 5).
