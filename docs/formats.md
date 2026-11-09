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

Any of them may be gzip-compressed (`.gz`) and encoded in UTF-8 or UTF-16.

## Detection

The format comes from the extension or, for other names and for standard input (`-`), from the
content. Two extensions get a second look: a `.json` file holding JSON-LD is read as JSON-LD, and
an `.owl` file is read in whatever syntax it contains, since Protégé also saves Turtle, OWL/XML
and Functional Syntax under that extension.

To skip detection, pass `--format <fmt>` for both inputs or `--before-format` /
`--after-format` for one: `json`, `jsonld`, `turtle`, `ntriples`, `nquads`, `trig`, `rdfxml` or
`obo`.

## Recognised but not read

| Format                                            | What to do                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| OWL/XML, OWL Functional Syntax, Manchester Syntax | Convert to RDF/XML or Turtle: `robot convert --input onto.owx --output onto.owl` |
| GraphML, GEXF                                     | Export JSON instead, e.g. NetworkX node-link data or Cytoscape.js JSON           |

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
`diff.v1.json` and `delta.v1.json` next to it describe what `--json` and `--delta` write, and
`diff-packed.v1.json` the packed diff HTML reports embed.

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
