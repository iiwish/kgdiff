# Formats

| Format      | Extensions                         | Notes                                                                              |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| Turtle      | `.ttl`                             |                                                                                    |
| N-Triples   | `.nt`                              |                                                                                    |
| N-Quads     | `.nq`                              | named graphs are merged, with a warning                                            |
| TriG        | `.trig`                            | named graphs are merged, with a warning                                            |
| RDF/XML     | `.rdf`, `.owl`                     | the whole RDF 1.1 XML syntax, as Protégé and ROBOT write it                        |
| JSON-LD 1.1 | `.jsonld`, `.json` with `@context` | contexts must be inline: nothing is fetched                                        |
| OBO 1.4     | `.obo`                             | synonyms, `is_a`, relationships, obsoletion with `replaced_by`, `alt_id`           |
| JSON graphs | `.json`                            | kgdiff, d3 / NetworkX node-link, Cytoscape.js, AntV G6 v5, graphology, vis-network |
| GraphML     | `.graphml`                         | as NetworkX, igraph, yEd, Gephi and LightRAG write it; read as node-link data      |
| GEXF        | `.gexf`                            | 1.1 to 1.3, as Gephi and NetworkX write it; read as node-link data                 |

Any of them may be gzip-compressed (`.gz`) and encoded in UTF-8 or UTF-16.

## Detection

The format comes from the extension or, for other names and for standard input (`-`), from the
content. Two extensions get a second look: a `.json` file holding JSON-LD is read as JSON-LD, and
an `.owl` file is read in whatever syntax it contains, since Protégé also saves Turtle, OWL/XML
and Functional Syntax under that extension.

To skip detection, pass `--format <fmt>` for both inputs or `--before-format` /
`--after-format` for one: `json`, `jsonld`, `turtle`, `ntriples`, `nquads`, `trig`, `rdfxml`,
`obo`, `graphml` or `gexf`.

## Recognised but not read

| Format                                            | What to do                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| OWL/XML, OWL Functional Syntax, Manchester Syntax | Convert to RDF/XML or Turtle: `robot convert --input onto.owx --output onto.owl` |

kgdiff names the format and the way out in its error message.

## kgdiff JSON

kgdiff's own format, and what `kgdiff apply` writes:

```json
{
  "format": "kgdiff.graph",
  "version": 1,
  "meta": { "name": "zoo", "version": "v2" },
  "nodes": [
    { "id": "animal", "label": "Animal" },
    { "id": "mammal", "label": "Mammal" },
    {
      "id": "cat",
      "label": "Domestic cat",
      "type": "Species",
      "aliases": ["house cat"],
      "attrs": { "legs": 4 }
    },
    { "id": "dog", "label": "Dog", "type": "Species" }
  ],
  "edges": [
    { "source": "mammal", "target": "animal", "predicate": "subClassOf" },
    { "source": "cat", "target": "mammal", "predicate": "subClassOf" },
    { "source": "dog", "target": "mammal", "predicate": "subClassOf" }
  ]
}
```

| Field                                    | Meaning                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `format`, `version`                      | `"kgdiff.graph"` and `1`: optional, but together; see below                                |
| `meta.name`, `meta.version`              | Shown in headers and titles                                                                |
| `nodes[].id`                             | Required and unique                                                                        |
| `nodes[].label`                          | The display name; a changed label is a rename                                              |
| `nodes[].type`                           | A type, or an array of types                                                               |
| `nodes[].aliases`                        | Synonyms                                                                                   |
| `nodes[].attrs`                          | Any other values: strings, numbers, booleans, arrays                                       |
| `nodes[].deprecated`                     | `true` for an obsolete node                                                                |
| `nodes[].replacedBy`, `nodes[].replaces` | Ids of replacement nodes, which turn removals into merges                                  |
| `edges[].source`, `edges[].target`       | Node ids, required                                                                         |
| `edges[].predicate`                      | The relation; [hierarchy predicates](./guide/ontologies.md#recommended-options) make moves |
| `edges[].id`, `label`, `attrs`           | Optional                                                                                   |

Against a first version where cats and dogs were directly under “Animal” and the cat was just
“Cat”, this reports:

```
kgdiff  zoo v1 → v2                                    3 → 4 nodes · 2 → 3 edges

  +1 added   ~1 modified   ⇄1 restructured                  6 changes in 3 hunks
  ++~~⇄⇄

  Restructured 1
  ⇄ Moved “Dog” under “Mammal”       structure · from “Animal”
  Modified 1
  ~ Renamed “Cat” → “Domestic cat”   content · +1 synonym · moved under “Mammal”
  Added 1
  + Added “Mammal” and 1 relation    added · linked to “Animal”
```

### Format marker and JSON Schema

kgdiff writes `"format": "kgdiff.graph"` and `"version": 1` first, as it does for its diffs and
deltas. A file without them is still read, by its shape. A file with them is read as kgdiff JSON
without guessing, a version kgdiff does not support is refused, and so is a diff or a delta given
where a graph is expected, with a message that says what the file is.

[`graph.v1.json`](../packages/core/schema/graph.v1.json) is the JSON Schema of kgdiff JSON.
`@kgdiff/core` ships it as `@kgdiff/core/schema/graph.v1.json`, and it is served at
`https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/graph.v1.json`. Name it in `$schema` for
completion and checks in your editor, or validate what a pipeline writes, such as an LLM's
structured output, before kgdiff reads it. The schema describes the canonical form: kgdiff also
reads looser files, with numeric ids, the label in `name` or other fields folded into `attrs`.
`diff.v1.json` and `delta.v1.json` next to it describe what `--json` and `--delta` write,
`report.v1.json` the payload HTML reports embed, and `diff-packed.v1.json` and `layout.v2.json`
the packed diff and the layout inside that payload.

## Other JSON graph shapes

kgdiff recognises the shape of the JSON (d3 / NetworkX node-link, Cytoscape.js, AntV G6 v5,
graphology, vis-network) and reads these fields:

| Concept                  | Fields                             |
| ------------------------ | ---------------------------------- |
| node id                  | `id`, `key`, `data.id`             |
| label                    | `label`, `name`, `title`           |
| types                    | `type`, `types`, `category`, …     |
| aliases                  | `aliases`, `synonyms`              |
| edges                    | `edges`, `links`, `elements.edges` |
| deprecation, replacement | `deprecated`, `replacedBy`         |

Other node fields become attributes. Fields that only matter for drawing (rendering state, styles,
shape types) are dropped with a warning.

In every JSON shape, a number too large for a double (`1e400`) is kept as the string `"Infinity"`
or `"-Infinity"`, with a warning, rather than lost. A string with half of a surrogate pair escaped
on its own (`"\ud800"`) is an error: kgdiff only reads well-formed Unicode.

## GraphML

A GraphML document is read as the node-link data NetworkX would give the same graph, and then as
every other JSON graph: the fields above mean the same.

| GraphML                                      | Becomes                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `<node id>`                                  | the node id                                                                     |
| `<edge source target>`, `<edge id>`          | an edge, and its id                                                             |
| `<data key>` of a node or an edge            | a field named by the key's `attr.name`: label, type, predicate, or an attribute |
| `<data key>` of the graph: `name`, `version` | the graph's name and version                                                    |
| `attr.type` `int`, `long`, `float`, `double` | a number                                                                        |
| `attr.type` `boolean`                        | a boolean (`true`, `false`, `1`, `0`, and Python's `True` and `False`)          |
| `<default>` of a key                         | the value of every node or edge that has no `<data>` for the key                |
| yEd's `<y:NodeLabel>`, `<y:EdgeLabel>`       | the label of the node or the edge, when no field is                             |

**Direction.** A directed edge keeps its ends as written. An undirected one
(`edgedefault="undirected"`, or `directed="false"` on the edge) has them in one order, so that
`a – b` and `b – a` are the same edge: a library writes the ends in the order it met the nodes,
which differs between two runs of an extraction.

**The same graph as node-link JSON.** A directed graph that NetworkX saves as GraphML and as
node-link JSON is the same graph to kgdiff, and comparing the two files shows no change. Two
cases differ, until kgdiff 0.13 reads node-link JSON the same way: an undirected graph whose
JSON writes an edge as `b – a` (JSON keeps the ends as written), and a multigraph, whose
parallel edges carry a `key` field in JSON and none in GraphML.

**Edge ids.** NetworkX writes the keys of a multigraph's parallel edges as `<edge id>`, counted
from 0 for every pair of nodes. Ids that two edges share are not ids: kgdiff then reads no edge
id from the file, with a warning (`graphml-shared-edge-ids`).

The node id and an edge's ends and id are the element's own: a field named `id`, `source` or
`target` does not replace them.

What kgdiff does not read is left out with a warning, never an error:

- nested graphs (the groups of yEd) and `<graph>` elements after the first are merged into one
  graph (`graphml-merged-graphs`);
- `<hyperedge>` and `<port>` are skipped (`graphml-unsupported-elements`);
- `<data>` with XML content, which is where yEd and other editors keep geometry and styles, is
  dropped, except yEd's labels (`graphml-ignored-data`);
- a value that is not of its key's type (`about 175` for a `long`, `inf` for a `double`) stays
  text (`graphml-invalid-value`). A `long` beyond what a double holds exactly
  (`9007199254740993`) stays text too, so that no digit is lost, as in RDF; it is of its type,
  so it has no warning.

One limit: the `<default>` values of a document may add as many fields as the file has bytes
(a million for a small file). A file whose defaults add more is refused, because a default costs
the file one line and the graph a field on every node.

LightRAG keeps the type of an entity in `entity_type`, which is not one of the type fields: it is
an attribute unless you name it, with `json.fields.type` of `parseGraph` (the field overrides of
the JSON reader apply to GraphML too).

## GEXF

GEXF (1.1 to 1.3) is read the same way as GraphML: into node-link data, then as every other JSON
graph.

| GEXF                                            | Becomes                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `<node id label>`                               | the node id and its label                                            |
| `<edge source target>`, `id`, `label`, `weight` | an edge, its id, its label and a numeric `weight` attribute          |
| `<edge kind>` (GEXF 1.3)                        | the relation; without it, the edge's label is                        |
| `<edge type>`                                   | the direction; any other value is the relation (see below)           |
| `<attvalue for value>`                          | a field named by the attribute's `title`, typed by its `type`        |
| `type` `integer`, `long`, `float`, `double`     | a number                                                             |
| `type` `boolean`                                | a boolean                                                            |
| `<default>` of an attribute                     | the value of every node or edge of its class without an `<attvalue>` |
| `<graph name>`                                  | the graph's name                                                     |

Two things follow what NetworkX writes. It puts `label` on every node, the id when the node has
none: a label that only repeats the id is no label, and the node's `name` or `title` is then
its label, as in node-link JSON. And it writes an edge attribute named `type` as the edge's
`type`: a `type` that is not `directed`, `undirected` or `mutual` is read as that attribute,
which is the relation.

Direction is as in GraphML: an undirected edge (the graph's `defaultedgetype`, or the edge's
`type`) has its ends in one order. The numbers Gephi and NetworkX give edges as ids are read as
edge ids; they play no part in a comparison unless you ask for `--edge-identity id`. So a
directed graph saved as GEXF and as node-link JSON is the same graph; an undirected graph and a
multigraph differ as described for GraphML. The limit on what `<default>` values may add is
GraphML's.

Left out with a warning:

- `viz:` elements, which hold position, colour, size and shape (`gexf-ignored-viz`);
- time: a dynamic graph is read as one static graph, and of an attribute that changes over time
  the value that comes last in the file is read (`gexf-dynamic`);
- the hierarchy: nodes inside other nodes, or with a `pid` or `<parents>`, are plain nodes
  (`gexf-hierarchy`);
- a value that is not of its attribute's type stays text (`gexf-invalid-value`); a whole number
  beyond what a double holds exactly stays text without a warning, as in GraphML.

## RDF and OBO

- Subjects become nodes. OBO PURLs are shortened to CURIEs such as `GO:0008150`.
- Labels come from `rdfs:label`, `skos:prefLabel`, `schema:name` and similar; `--lang` picks the
  language. OBO uses `name`.
- `rdf:type` gives the node types; types are not edges.
- Literal values become attributes; values that are IRIs become edges.
- OWL existential restrictions (`C SubClassOf R some D`) become edges from `C` to `D`.
- `owl:deprecated` and `IAO:0100001` ("term replaced by"), and OBO `is_obsolete`, `replaced_by`
  and `alt_id`, become deprecation and replacement links.
- Blank nodes get stable ids derived from their content and context.
- Annotations on statements (`owl:Axiom`, `rdf:Statement`) are folded into the edge they
  annotate.

The same graph in any RDF syntax gives the same result. [Architecture: mapping
conventions](./architecture.md#formats-mapping-conventions) has the complete rules.

## Inputs and limits

- One side may come from standard input, as `-`.
- An empty input is an error unless `--allow-empty`, which reads it as an empty graph.
- Inputs may be up to 1 GB after decompression; `KGDIFF_MAX_INPUT` raises the limit, e.g.
  `KGDIFF_MAX_INPUT=4G`.
- Invalid UTF-8 is an error, and syntax errors report the line.
