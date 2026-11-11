---
'@kgdiff/cli': minor
---

Rust crates: a compact graph in `kgdiff-core`, read through methods, and two more ways to build
one. Breaking for Rust callers; no output changes by a byte.

- **Memory.** `normalize` of 100k nodes and 300k edges now adds 42 MiB of resident memory
  instead of 150 MiB (RFC 0002 §7: under 50 MB), and the graph retains 23 MB of heap instead of
  100 MB. Edges are rows of positions into the nodes and into one table of predicates and labels;
  their structural keys are written when asked for. Nodes keep what few of them have
  (aliases, `replaces`, `replacedBy`, a position) apart.
- **`normalize_input`** builds the graph from Rust values (`GraphInput`, `NodeInput`,
  `EdgeInput`, the members of `graph.v1.json`; attribute values stay `js::Value`) — the graph
  `normalize(&input.to_value(), …)` gives, with the same `graph_to_json` bytes, hash and issues,
  checked on every graph of the conformance corpus (RFC 0003, part 3).
- **`normalize_json`** builds it from JSON text, element by element, without a tree of the whole
  document.
- **Breaking: `KGraph`, `KGNode` and `KGEdge` have no public fields.** Read them through methods:
  `graph.nodes()`, `node(id)`, `node_at(i)`, `node_index(id)`, `contains_node(id)`,
  `node_count()`, `edges()` (`EdgeRef`s), `edge(key)`, `edge_at(i)`, `edge_index(key)`,
  `contains_edge(key)`, `edge_count()`, `meta()`, `edge_identity()`, `issues()`; `node.id()`,
  `label()`, `types()`, `aliases()`, `attrs()`, `is_deprecated()`, `replaces()`, `replaced_by()`,
  `is_implicit()`, `position()`; `edge.key()`, `id()`, `source()`, `target()`, `predicate()`,
  `label()`, `attrs()`, and `EdgeRef::to_edge()` for an edge on its own. `outgoing` and
  `incoming` yield `EdgeRef`s instead of `&Arc<KGEdge>`. A `KGNode` or `KGEdge` can no longer be
  built field by field: build graphs with `normalize_input`.
