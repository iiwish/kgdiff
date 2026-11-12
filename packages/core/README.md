# @kgdiff/core

The semantic diff engine behind [kgdiff](../../README.md). It matches nodes across two versions
of a knowledge graph, classifies what changed (rename, rekey, merge, split, hierarchy move,
retarget, …), groups the changes into reviewable hunks and emits an invertible delta.
Deterministic, zero dependencies, and it runs unchanged in browsers, Node, Deno, Bun and workers.

## Install

```sh
pnpm add @kgdiff/core
```

ESM only. Node.js ≥ 22 or any evergreen browser.

## Quick start

```ts
import { applyDelta, diff, formatHunk, hashGraph, invertDelta } from '@kgdiff/core';

const v1 = {
  nodes: [
    { id: 'org', label: 'Organization' },
    { id: 'company', label: 'Company' },
    { id: 'ngo', label: 'NGO' },
  ],
  edges: [
    { source: 'company', target: 'org', predicate: 'subClassOf' },
    { source: 'ngo', target: 'org', predicate: 'subClassOf' },
  ],
};
const v2 = {
  nodes: [
    { id: 'org', label: 'Organisation' },
    { id: 'company', label: 'Company' },
    { id: 'startup', label: 'Startup' },
  ],
  edges: [
    { source: 'company', target: 'org', predicate: 'subClassOf' },
    { source: 'startup', target: 'company', predicate: 'subClassOf' },
  ],
};

const result = await diff(v1, v2);
for (const hunk of result.hunks) console.log(formatHunk(hunk, result).title);
// Removed “NGO” and 1 relation
// Renamed “Organization” → “Organisation”
// Added “Startup” and 1 relation

result.stats.nodes; // { added: 1, removed: 1, modified: 1, unchanged: 1 }

// The delta is invertible: undoing it gives the first version back.
const undone = applyDelta(result.after, invertDelta(result.delta));
hashGraph(undone) === hashGraph(result.before); // true
```

- Graph files (RDF, OBO, JSON graph formats): parse them with [`@kgdiff/formats`](../formats).
- Ids that mean nothing across versions, such as two LLM extraction runs: match by label and
  neighbourhood with `diff(a, b, { match: { strategy: 'similarity' } })`.
- `formatHunk(hunk, result, 'zh-CN')` gives Chinese titles.

## JSON formats

`graphToJSON(graph)`, `diffToJSON(result)` and `result.delta` are JSON documents that name their
format and version: `kgdiff.graph`, `kgdiff.diff` and `kgdiff.delta`, all version 1. Their JSON
Schemas ship with this package, to validate what other tools write before kgdiff reads it:

```ts
import graphSchema from '@kgdiff/core/schema/graph.v1.json' with { type: 'json' };
```

They are also served at `https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/graph.v1.json`
(`diff.v1.json`, `diff-packed.v1.json`, `delta.v1.json`). `report.v1.json` and `layout.v2.json`
next to them describe the payload of an HTML report (`kgdiff.report`) and the layout in it
(`kgdiff.layout` version 2), which kgdiff's Rust crates write.

`diffFromJSON(json)` checks that a document is consistent (every element has the versions its
status implies and lies in the hunk it names, edges join union nodes, the delta goes from the
before to the after graph, the counts match) and names the first contradiction it finds.
`packDiffJSON(json)` stores the unchanged elements as tables of indices into one string table,
as HTML reports do (edges with a label or attributes of their own stay as they are). A large,
mostly unchanged diff shrinks to about a third (100k nodes / 300k edges: 28%, 46% gzipped);
`unpackDiffJSON` gives the document back, byte for byte.

## Learn more

- [Algorithms](../../docs/algorithms.md): normalization, matching, classification, hunks, delta.
- [Delta format](../../docs/delta-format.md): the JSON patch format and its guarantees.
- [Architecture](../../docs/architecture.md): how the kgdiff packages fit together.

## License

[MIT](../../LICENSE)
