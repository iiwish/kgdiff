# kgdiff architecture

> **git diff for knowledge graphs.** kgdiff tells you, at a glance, what changed between two
> versions of a graph — and lets you review it like a pull request.

This document is the source of truth for how the project is put together. Algorithms are
specified in [algorithms.md](algorithms.md), the visual language in
[visual-language.md](visual-language.md), the viewer's behaviour in
[interaction.md](interaction.md) and the patch format in [delta-format.md](delta-format.md).

## Positioning

AI systems now write and rewrite knowledge graphs: GraphRAG pipelines, agent memories,
ontology assistants, semantic layers. Humans have to review those changes the way they review
AI-written code. Existing tools show ontology changes as tables or trees, or recolor nodes on a
re-run force layout so everything jumps. kgdiff is built around four ideas:

1. **Semantic, not syntactic.** A merge is a merge, a rename is a rename, a moved class is a
   move — not "one node deleted, one node added".
2. **One mental map.** Both versions share one stable layout. Nothing moves unless it changed.
3. **Color is meaning.** Five meaning families (added, removed, content, structure, identity)
   and gray for context. Nothing else gets a color.
4. **Review is a workflow.** Changes are grouped into hunks you can step through, replay,
   mark as reviewed and export as an invertible delta.

## Design principles

- **Deterministic.** Same input + same options → byte-identical output (diff JSON, layout,
  hunk order). Seeded PRNGs only; no `Math.random`, no `Date.now()` in results.
- **Pure core, thin shells.** Algorithms are pure functions over immutable data. I/O, DOM and
  timers live only in `renderer`, `viewer` and `cli`.
- **Contracts first.** Each package exposes a small typed API (`src/index.ts`). Internals are
  free to change; contracts change only with this document.
- **Zero-config, fully configurable.** Good defaults for every option, every default documented.
- **Accessible by construction.** Contrast is tested, color is never the only cue, motion
  respects `prefers-reduced-motion`, everything is keyboard-operable.
- **Small and fast.** Budgets below are enforced by benchmarks, a heap check and size checks.
- **Isomorphic.** `core`, `formats`, `layout` and `scene` run unchanged in browsers, Node,
  Deno, Bun and workers.

## Packages

```
@kgdiff/core       diff engine: normalize → match → classify → hunk → delta     (no deps)
@kgdiff/formats    RDF (Turtle, N-Triples, N-Quads, TriG, RDF/XML, JSON-LD), OBO, JSON → GraphInput   (n3)
@kgdiff/layout     stable union layout, label-aware, deterministic                (d3-force)
@kgdiff/scene      diff semantics → visual primitives: tokens, encodings, replay, focus
@kgdiff/renderer   Canvas 2D engine: camera, LOD, labels, picking, swipe, minimap (DOM)
@kgdiff/viewer     <kgdiff-viewer> web component: modes, change list, details, review (DOM)
@kgdiff/g6         AntV G6 v5 adapter: render a kgdiff scene inside a G6 graph   (peer: @antv/g6)
kgdiff             CLI: terminal diff, JSON / delta / Markdown, single-file HTML report
apps/site          landing page + playground (drag two files in, get a diff)
```

Dependency graph (arrows point at dependencies):

```
core ◀── formats
core ◀── layout ◀── scene ◀── renderer ◀── viewer ◀── cli
                    scene ◀── g6                      ▲
          formats ◀──────────────────────── viewer ───┘
```

## Data flow

```
text ──formats.parseGraph──▶ GraphInput ×2
     ──core.diff──────────▶ DiffResult        (union graph + facets + hunks + delta + stats)
     ──layout.layoutDiff──▶ LayoutResult      (one position per union node)
     ──scene.buildScene───▶ Scene             (indices, roles, families, titles, timeline)
     ──resolver.resolve(view)──▶ FrameVisuals (per frame: what to draw)
     ──renderer.setFrame──▶ pixels
```

The CLI runs everything up to `layoutDiff` in Node and embeds `packDiffJSON(diffToJSON(…))` +
`layoutToJSON` in the HTML report (`ReportPayload`), so the browser only builds the scene and
renders. Reports are reproducible and open instantly. The packed diff stores the unchanged
elements (most of a large diff) as tables of indices into one string table: for 100k nodes /
300k edges, 28% of the bytes and 46% once gzipped (edges with a label or attributes of their own
are not packed, so diffs of such graphs shrink less). The viewer unpacks it and reads it with `diffFromJSON`,
which checks that the document is consistent before anything is drawn.

## Package contracts (summary)

| Package  | Main API                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core     | `normalize`, `diff`, `matchNodes`, `applyDelta`, `invertDelta`, `hashGraph`, `diffToJSON`/`diffFromJSON`, `packDiffJSON`/`unpackDiffJSON`, `formatHunk`, `facetLabel`, `textSimilarity`, `predicateLabel` |
| formats  | `parseGraph`, `detectFormat`, `compactIri`                                                                                                                                                                |
| layout   | `layoutDiff`, `extendLayout`, `nodeRadius`, `estimateLabelWidth`, `layoutToJSON`/`layoutFromJSON`                                                                                                         |
| scene    | `getTheme`, `buildScene`, `createVisualResolver`, `createViewState`, `computeFocus`, `frameBounds`, `contrastRatio`, `hunkFamily`                                                                         |
| renderer | `createRenderer`, `createMinimap`                                                                                                                                                                         |
| viewer   | `<kgdiff-viewer>` (`load`, `payload`, `selectHunk`, `next`, `prev`, `play`, …), `defineViewer`                                                                                                            |
| g6       | `toG6Data`, `createDiffGraph`                                                                                                                                                                             |
| cli      | `kgdiff <before> <after> [options]`, `kgdiff apply <graph> <delta>`                                                                                                                                       |

The full, documented signatures live in each package's `src/index.ts` (and `src/types.ts`).

The JSON documents kgdiff writes are contracts too: graphs (`kgdiff.graph`), diffs
(`kgdiff.diff`), packed diffs (`kgdiff.diff.packed`, in reports) and deltas (`kgdiff.delta`) each
carry their `format` and `version`, and each has a JSON Schema in `packages/core/schema/`
(`graph.v1.json`, `diff.v1.json`, `diff-packed.v1.json`, `delta.v1.json`, published with
`@kgdiff/core`). Tests validate everything kgdiff writes against them, so a
change to these formats changes its schema in the same commit; an incompatible change bumps the
version.

## Formats: mapping conventions

All parsers produce the same `GraphInput` shape:

| Concept    | RDF (Turtle, N-Triples, N-Quads, TriG, RDF/XML, JSON-LD)                                                                      | OBO                                      | JSON                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| node id    | IRI; OBO PURLs → CURIE (`GO:0008150`); blank nodes (`[]`, `rdf:nodeID`, JSON-LD `_:` or no `@id`) → hashed `_:b…` (see below) | `id:`                                    | `id` / `key` / `data.id`             |
| label      | `rdfs:label`, `skos:prefLabel`, `schema:name`, … (language preference over `@en`, `xml:lang`, `@language`)                    | `name:`                                  | `label` / `name` / `title`           |
| types      | `rdf:type`, typed node elements, `@type` (not edges by default)                                                               | stanza type (`Term`, `Instance`)         | `type` / `types` / `category` / …    |
| aliases    | `skos:altLabel`, oboInOwl synonyms                                                                                            | `synonym:`                               | `aliases` / `synonyms`               |
| attrs      | other literal-valued properties (compact predicate → value; repeated → sorted array)                                          | `def`, `namespace`, `xref`, `comment`, … | remaining fields                     |
| edges      | IRI-valued properties (`rdf:resource`, JSON-LD `@id` values and `@reverse`); OWL existential restrictions → `C –R→ D`         | `is_a`, `relationship:`                  | `edges` / `links` / `elements.edges` |
| deprecated | `owl:deprecated true`                                                                                                         | `is_obsolete: true`                      | `deprecated`                         |
| replacedBy | `IAO:0100001` (term replaced by)                                                                                              | `replaced_by:`                           | `replacedBy`                         |

Every RDF syntax is first read into RDF quads — Turtle, N-Triples, N-Quads and TriG by n3,
RDF/XML and JSON-LD by kgdiff's own synchronous readers (`rdfxml.ts` on a small XML parser,
`jsonld.ts`) — and one mapper (`rdf.ts`) turns quads into `GraphInput`, treating the graph as a
set (repeated triples count once). The same graph in any RDF syntax therefore gives the same
`GraphInput`, `hashGraph` and diff.

- **RDF/XML** follows the whole RDF 1.1 XML Syntax: `rdf:about` / `rdf:ID` / `rdf:nodeID`,
  typed node elements, property attributes, `rdf:li`, `xml:base` and `xml:lang` scoping,
  `rdf:parseType` `Resource`, `Collection` and `Literal` (an exclusive-canonical XML literal),
  and reification by `rdf:ID`. Entities declared in the DTD (as older Protégé versions write
  them) are expanded; external entities and DTDs are never loaded, and expansion is capped.
  An OWL/XML or GraphML document read as RDF/XML fails with a conversion hint.
- **JSON-LD** 1.1 is expanded and converted to RDF per the W3C algorithms. Contexts are inline
  or come from the caller's synchronous `jsonld.documentLoader`; nothing is fetched, so a
  remote `@context` without a loader is an error. Without a base IRI, relative IRIs stay
  relative (as in Turtle) instead of being dropped. Keys that expand to no IRI are dropped with
  a `jsonld-unmapped-terms` warning, `@direction` is not represented, named graphs are merged
  (`named-graphs`), and documents nested deeper than 200 levels are rejected.

Predicates and types are compacted **only with well-known prefixes** (plus prefixes the caller
passes in `rdf.prefixes`), so their identity never depends on the `@prefix` declarations of a
particular file: the same graph serialized as Turtle or as N-Triples diffs as identical.
Prefixes declared in a file (`@prefix`, `xmlns:`, JSON-LD prefix terms) are returned in
`ParseResult.prefixes` for display only.

Edge `label`s derive from the predicate alone (`rdfs:subClassOf` → `subClassOf`, `part_of` →
`part of`; opaque ids such as `BFO:0000050` stay whole), so a property declaration appearing or
disappearing never relabels edges. Names a file gives its relations (an RDF property's own
`rdfs:label`, OBO `[Typedef]` names) are returned as `ParseResult.predicateLabels` and
`graph.meta.predicateLabels` for display.

Blank nodes used by exactly one subject / predicate and not on a cycle are skolemized by
context: `_:b` + hash(parent id, predicate, content), so `alice :knows []` and `bob :knows []`
stay two nodes. Shared, unreferenced and cyclic blank nodes are identified by content alone
(cycles by colour refinement); structurally identical ones share an id.

Statement annotations (`owl:Axiom`, `rdf:Statement`, RDF 1.2 `{| |}`) are folded into the attrs
of the annotated edge (or node, for literal statements) instead of becoming nodes
(`rdf.foldAnnotations`, default true). OBO `alt_id` also populates `replaces`, so merged terms
are recognised from their alternative ids.

kgdiff JSON reads core's `graphToJSON` output losslessly (`types`, `implicit`; a `label` is
never taken for the predicate). Its optional marker (`format: "kgdiff.graph"`, `version: 1`)
skips shape detection; another `kgdiff.*` format (a diff, a delta) or graph version is rejected
with `unsupported-version`, while a `format` field outside the `kgdiff.` namespace is ignored.
Fields a JSON dialect does not map (rendering state, G6 shape types, …) are dropped with a
`json-ignored-fields` warning. Values nested deeper than 1000 levels are rejected with
`invalid-input`.

## Budgets

| What                                                                      | Budget                                |
| ------------------------------------------------------------------------- | ------------------------------------- |
| `diff`, exact ids, 10k nodes / 30k edges                                  | < 150 ms (Node, M-class laptop)       |
| `diff`, exact ids, 100k nodes / 300k edges                                | < 2 s                                 |
| `normalize` heap retained, 100k nodes / 300k edges                        | < 135 MB (Node; ~111 MB today)        |
| similarity matching, 5k unmatched on each side                            | < 1.5 s                               |
| `layoutDiff`, 2k nodes                                                    | < 800 ms                              |
| `buildScene`, 10k nodes                                                   | < 50 ms                               |
| `resolve` per frame, 5k nodes / 10k edges                                 | < 4 ms, zero steady-state allocations |
| pan / zoom, 5k nodes / 10k edges                                          | 60 fps                                |
| viewer standalone bundle (min + gzip, without formats and compute add-on) | < 130 kB (target 90 kB)               |
| HTML report overhead (without data)                                       | < 120 kB gzip                         |

## Engineering conventions

- TypeScript 7, strict, `noUncheckedIndexedAccess`, ESM only, Node ≥ 22, evergreen browsers.
- Relative imports use `.js` extensions (NodeNext). Cross-package imports use the package name;
  in development `@kgdiff/*` resolves to `packages/*/src/index.ts` (see `tsconfig.base.json`,
  `vitest.shared.ts`), so nothing needs building before tests.
- Tests: Vitest, colocated in `packages/*/test`. Core uses property-based tests (fast-check).
  Unit tests assert no wall-clock times; the budgets above are checked by Vitest benchmarks
  (`test/*.bench.ts`, `pnpm bench`), which run the TypeScript source through Vite's module
  runner and so measure upper bounds.
- Lint / format: Biome (`pnpm lint`, `pnpm format`).
- No new runtime dependency without a written justification in the PR / review.
- Errors: throw `KgdiffError` with a stable `code`; never throw strings.
- Public functions have TSDoc that states defaults, complexity when non-obvious, and edge cases.
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm check` (all three),
  `pnpm bench`, `pnpm check:packages` (the packed tarballs, after `pnpm build`).
