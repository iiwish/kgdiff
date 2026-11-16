---
'@kgdiff/cli': patch
'@kgdiff/core': patch
'@kgdiff/compute': patch
---

kgdiff reads GraphML: `kgdiff a.graphml b.graphml`, `parseGraph(text, { format: 'graphml' })` and `FormatId::GraphMl` in Rust, detected from the `.graphml` extension and from the content. It is what NetworkX (`write_graphml`), igraph, yEd and Gephi write, and what LightRAG keeps its graph in, so comparing two runs no longer needs an export to JSON first.

A GraphML document is read as the node-link data NetworkX gives the same graph, and then as every JSON graph: `label`, `name` or `title` is the label, `type` the type, `relation` the predicate, the rest attributes. One graph saved as GraphML and as node-link JSON is the same graph to kgdiff. Values are typed by their key's `attr.type` (numbers, booleans, also Python's `True` and `False`), a key's `<default>` fills the elements that have no `<data>` for it, and edges keep their ends as written. Nested graphs are merged into one, `<hyperedge>` and `<port>` are skipped, the drawing data of yEd is dropped and a value that is not of its type stays text, each with a warning (`graphml-merged-graphs`, `graphml-unsupported-elements`, `graphml-ignored-data`, `graphml-invalid-value`). [Formats](https://github.com/iiwish/kgdiff/blob/main/docs/formats.md#graphml) has the mapping.

New in the types: the format `graphml` (`FormatId`, `FORMAT_EXTENSIONS`, `--format graphml`) and four warning codes (`ParseWarningCode`). A `switch` over either needs its `default` branch, as [Versioning](https://github.com/iiwish/kgdiff/blob/main/docs/versioning.md) says; in Rust the enums are `#[non_exhaustive]`, and `FormatId::ALL` has nine entries. GraphML read as RDF/XML (`--format rdfxml`) now says which format to read it with. GEXF is still recognised and not read.
