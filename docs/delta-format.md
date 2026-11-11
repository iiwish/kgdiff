# kgdiff delta format (v1)

A **delta** is a low-level, invertible, verifiable patch that turns one graph version into
another — the "unified diff" of graphs. Semantics (merges, moves, renames…) live in the diff's
hunks; the delta only needs primitive operations, which keeps `apply` and `invert` simple and
exact. Types: `Delta`, `DeltaOp` in `packages/core/src/types.ts`.

## Envelope

```json
{
  "format": "kgdiff.delta",
  "version": 1,
  "edgeIdentity": "structure",
  "base":   { "name": "go", "version": "2026-09-01", "hash": "c53:001f3a9c4b7e21", "nodes": 512, "edges": 1490 },
  "target": { "name": "go", "version": "2026-10-01", "hash": "c53:0a77c1e09f3d55", "nodes": 518, "edges": 1502 },
  "ops": [ … ]
}
```

- `hash` is `hashGraph` of the normalized graph (positions and meta excluded).
- Readers must reject unknown `format` and any `version` greater than they support
  (`KgdiffError('unsupported-version')`).
- The JSON Schema is [`delta.v1.json`](../packages/core/schema/delta.v1.json), shipped as
  `@kgdiff/core/schema/delta.v1.json` and served at
  `https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/delta.v1.json`.

## Operations

Each op carries the information needed to check its precondition and to invert it.
Ids always refer to the graph state reached by the previous ops.

| op            | fields                                 | precondition                                      | inverse                  |
| ------------- | -------------------------------------- | ------------------------------------------------- | ------------------------ |
| `node.rekey`  | `from`, `to`                           | `from` exists, `to` absent                        | `node.rekey` `to → from` |
| `edge.remove` | `edge` (EdgeJSON)                      | edge exists and equals `edge`                     | `edge.add`               |
| `node.remove` | `node` (NodeJSON, full snapshot)       | node exists, equals `node`, has no edges          | `node.add`               |
| `node.set`    | `id`, `field`, `from`, `to`            | current value equals `from`                       | swap `from` / `to`       |
| `node.attr`   | `id`, `key`, `from?`, `to?`            | current value equals `from` (absent when omitted) | swap                     |
| `node.add`    | `node`                                 | node absent                                       | `node.remove`            |
| `edge.add`    | `edge`                                 | both endpoints exist, edge absent                 | `edge.remove`            |
| `edge.set`    | `edge`, `field: 'label'`, `from`, `to` | current label equals `from`                       | swap                     |
| `edge.attr`   | `edge`, `key`, `from?`, `to?`          | current value equals `from`                       | swap                     |

`node.rekey` renames a node's identity and re-keys its incident edges (in `structure` mode their
keys change because the endpoints change). Edges are located by their identity: the structural
key computed from `edge` (`structure` mode) or `edge.id` (`id` mode). Values are compared with
canonical JSON equality (object keys sorted).

## Canonical order

`node.rekey` → `edge.remove` → `node.remove` → `node.set` → `node.attr` → `node.add` →
`edge.add` → `edge.set` → `edge.attr`, each group sorted as specified in
[algorithms.md §8](algorithms.md#8-delta). Deltas produced by `diff` are always canonical;
`applyDelta` accepts any order that satisfies the preconditions. Changes of
[ignored attributes](#ignored-attributes), when there are any, come before all of these.

## Guarantees

- `apply(A, diff(A, B).delta) ≅ B` and `apply(B, invert(diff(A, B).delta)) ≅ A` (≅: equal hashes).
- Strict apply fails fast on the first violated precondition with
  `KgdiffError('delta-conflict', …, { opIndex, op, reason })`; a base hash mismatch raises
  `KgdiffError('delta-base-mismatch')`.
- Non-strict apply (`strict: false`) skips the base hash check and every op whose precondition
  fails, and reports each skipped op to `ApplyOptions.onSkip({ index, op, reason })`, in op
  order, with the same `reason` text strict mode would raise. Malformed ops (unknown kind,
  ill-typed fields) are input errors in both modes: `KgdiffError('invalid-input')`.

## Ignored attributes

`ignoreAttrs` (`--ignore-attr`) only narrows what the diff matches on and shows: the ignored
attributes take no part in similarity and their changes produce no facet, status, count or
summary line. The delta still carries those changes, so the guarantees above hold with any
`ignoreAttrs`, and `target.hash` is the hash of the whole after graph.

These ops belong to no hunk and head the delta, ahead of `node.rekey`, each addressing the base
graph: `node.attr`, then `edge.remove` and `edge.add` for a parallel copy (which has no locator
of its own), then `edge.attr`. Added, removed and replaced elements need none of them: their
snapshots hold every attribute. Deltas from earlier versions, which left these changes out, still
apply; their result differs from their `target.hash` as it always did.

## Relation to other formats

| kgdiff                               | KGCL (INCAtools)              | RDF Patch                       |
| ------------------------------------ | ----------------------------- | ------------------------------- |
| `node.add` / `node.remove`           | `create node` / `delete`      | `A` / `D` of the node's triples |
| `node.set label`                     | `rename`                      | `D` + `A` of the label triple   |
| `node.set deprecated` + `replacedBy` | `obsolete … with replacement` | triples                         |
| `edge.add` / `edge.remove`           | `create edge` / `delete edge` | `A` / `D`                       |
| hunk `move` (diff level)             | `move … from … to …`          | `D` + `A`                       |
| hunk `merge` (diff level)            | obsoletion with replacement   | triples                         |

Exporters to KGCL and RDF Patch can be built on top of hunks + ops without changing this format.
