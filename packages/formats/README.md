# @kgdiff/formats

> **Deprecated since 0.11: moved to [`@kgdiff/core`](../core).** Since 0.11.1 `@kgdiff/core`
> exports everything this package does (`parseGraph`, `detectFormat`, `compactIri`,
> `FORMAT_EXTENSIONS` and the types), with the same signatures and results: change the import path
> from `@kgdiff/formats` to `@kgdiff/core` and nothing else. They run kgdiff's Rust parsers compiled
> to WebAssembly (`@kgdiff/compute`, which also has their synchronous forms), the same results as
> the kgdiff CLI. This package's functions are asynchronous wrappers over them
> (`await parseGraph(…)`); its types and `FORMAT_EXTENSIONS` are the same declarations, re-exported
> here until it is removed in 2.0. No other kgdiff package depends on it. See
> [Migrating to 0.11](../../docs/guide/migrating-to-0.11.md).

Parsers that turn real-world graph files into [`@kgdiff/core`](../core) graphs: RDF (Turtle,
N-Triples, N-Quads, TriG, RDF/XML, JSON-LD), OBO 1.4 and the common JSON graph shapes (kgdiff,
d3 / NetworkX node-link, Cytoscape.js, AntV G6 v5, graphology, vis-network). Deterministic,
with no file-system or network access: you pass text, so it works the same in
browsers and Node.

## Install

```sh
pnpm add @kgdiff/formats @kgdiff/core
```

ESM only. Node.js ≥ 22 or any evergreen browser.

## Quick start

```ts
import { diff, formatHunk } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';

const v1 = `
@prefix ex: <https://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:Organization rdfs:label "Organization"@en .
ex:Company rdfs:subClassOf ex:Organization ; rdfs:label "Company"@en .
`;
const v2 = `
@prefix ex: <https://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:Organization rdfs:label "Organisation"@en .
ex:Company rdfs:subClassOf ex:Organization ; rdfs:label "Company"@en .
ex:Startup rdfs:subClassOf ex:Company ; rdfs:label "Startup"@en .
`;

const before = await parseGraph(v1, { filename: 'v1.ttl' });
const after = await parseGraph(v2, { filename: 'v2.ttl' });
before.format; // 'turtle': detected from the file name and the content
before.graph.nodes.map((node) => node.label); // ['Company', 'Organization']
before.warnings; // recoverable oddities (merged named graphs, unsupported OBO stanzas, …)

const result = await diff(before.graph, after.graph);
for (const hunk of result.hunks) console.log(formatHunk(hunk, result).title);
// Renamed “Organization” → “Organisation”
// Added “Startup” and 1 relation
```

In Node, read files first: `parseGraph(await readFile('v1.ttl', 'utf8'), { filename: 'v1.ttl' })`.

- `format` defaults to `'auto'`. Pass `'turtle'`, `'ntriples'`, `'nquads'`, `'trig'`, `'rdfxml'`,
  `'jsonld'`, `'obo'` or `'json'` to skip detection; `detectFormat(text, filename)` tells you what
  `auto` would pick.
- Syntax errors throw a `KgdiffError` with code `invalid-input` and the line number.
- JSON-LD contexts must be inline unless you pass a synchronous `jsonld.documentLoader`; nothing is
  ever fetched, and RDF/XML never loads external entities.
- Formats it recognises but does not read (OWL/XML, OWL functional and Manchester syntax, GraphML,
  GEXF) throw an `invalid-input` error that says how to convert them.
- The same graph in different serializations diffs as identical.

## Learn more

- [Mapping conventions](../../docs/architecture.md#formats-mapping-conventions): ids, labels,
  types, blank nodes, OWL restrictions and statement annotations.
- [CLI](../../docs/cli.md): diff graph files from the terminal without writing code.

## License

[MIT](../../LICENSE)
