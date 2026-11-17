---
'@kgdiff/cli': patch
'@kgdiff/core': patch
'@kgdiff/compute': patch
---

kgdiff reads GEXF (1.1 to 1.3), the format of Gephi, which NetworkX writes too (`write_gexf`): `kgdiff a.gexf b.gexf`, `parseGraph(text, { format: 'gexf' })` and `FormatId::Gexf` in Rust, detected from the `.gexf` extension and from the content.

Like GraphML, a GEXF document is read as node-link data and then as every JSON graph. A node's `label` is its label, unless it only repeats the id, as NetworkX writes it for a node without one. An edge has its `id`, `label` and numeric `weight`; its `kind` (GEXF 1.3) is the relation, and so is a `type` that does not name a direction, which is where NetworkX writes an edge attribute of that name. `<attvalue>` values are fields named by their attribute's `title` and typed by its `type`, with the attribute's `<default>` where a node or an edge has none, within the same limit as GraphML. An undirected edge has its ends in one order. The numbers Gephi and NetworkX give edges are read as edge ids, which play no part in a comparison unless `--edge-identity id` asks for it.

With a warning each: `viz:` elements are dropped (`gexf-ignored-viz`), a dynamic graph is read as one static graph (`gexf-dynamic`), nodes inside other nodes are plain nodes (`gexf-hierarchy`), and a value that is not of its type stays text (`gexf-invalid-value`). [Formats](https://github.com/iiwish/kgdiff/blob/main/docs/formats.md#gexf) has the mapping.

New in the types: the format `gexf` and four warning codes; with GraphML, `FormatId::ALL` has ten entries. GEXF read as RDF/XML says which format to read it with. With GraphML and GEXF read, the only formats kgdiff recognises and does not read are the OWL syntaxes other than RDF/XML.
