---
'@kgdiff/cli': patch
'@kgdiff/core': patch
'@kgdiff/compute': patch
---

kgdiff reads GraphML: `kgdiff a.graphml b.graphml`, `parseGraph(text, { format: 'graphml' })` and `FormatId::GraphMl` in Rust, detected from the `.graphml` extension and from the content. It is what NetworkX (`write_graphml`), igraph and yEd write, and what LightRAG keeps its graph in, so comparing two runs no longer needs an export to JSON first.

A GraphML document is read as the node-link data NetworkX gives the same graph, and then as every JSON graph: `label`, `name` or `title` is the label, `type` the type, `relation` the predicate, the rest attributes. Values are typed by their key's `attr.type` (numbers, booleans, also Python's `True` and `False`), and a key's `<default>` fills the elements that have no `<data>` for it. An undirected edge has its ends in one order, so that `a – b` in one run and `b – a` in the next are the same edge. yEd's node and edge labels, which it keeps in its drawing data, are the labels.

With a warning each: nested graphs are merged into one (`graphml-merged-graphs`), `<hyperedge>` and `<port>` are skipped (`graphml-unsupported-elements`), drawing data is dropped (`graphml-ignored-data`), a value that is not of its type stays text (`graphml-invalid-value`), and edge ids that edges share, as in a multigraph NetworkX writes, are not read (`graphml-shared-edge-ids`). A document whose `<default>` values would add more fields than it has bytes (a million for a small one) is refused. [Formats](https://github.com/iiwish/kgdiff/blob/main/docs/formats.md#graphml) has the mapping and says where a graph saved as GraphML and as node-link JSON still differ.

New in the types: the format `graphml` (`FormatId`, `FORMAT_EXTENSIONS`, `--format graphml`) and five warning codes (`ParseWarningCode`). A `switch` over either needs its `default` branch, as [Versioning](https://github.com/iiwish/kgdiff/blob/main/docs/versioning.md) says; in Rust the enums are `#[non_exhaustive]`. GraphML read as RDF/XML (`--format rdfxml`) now says which format to read it with.
