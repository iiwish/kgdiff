# Roadmap: what is planned, and what waits for what

The [README](../README.md#roadmap) says where kgdiff is going in a paragraph. This page is the
working list behind it: what the next patch release holds, what is gathered for the next
breaking release and why each item has to wait for it, and what is not scheduled. It is kept
with the code, and a pull request that settles an item removes it here.

Rules that decide where an item goes ([Versioning](versioning.md)): a patch release (0.12.x)
carries fixes and additions, breaks no public API and changes no output byte; a change that
breaks the API, or that changes what kgdiff writes for an input it already reads, waits for the
next minor (0.13). Patch releases come on Tuesdays, and on Thursdays when a fix that users run into or an
addition a host is waiting for is ready ([Releasing](releasing.md#day-to-day)).

Last reviewed 2026-11-19, after 0.12.3.

## Released

- **0.12.3** (2026-11-19): a delta that did not apply to its own base, `apply --verify-target`,
  `DiffResult` lookups, large integers in GraphML and GEXF, the sidebar's 28 px buttons, and
  what the two hosts asked of `@kgdiff/scene` and `@kgdiff/g6`
  ([release notes](https://github.com/iiwish/kgdiff/releases/tag/v0.12.3)).
- **0.12.2** (2026-11-17): shell completions, GraphML and GEXF, the canvas's focus ring and the
  region instead of a nested main landmark.

## 0.12.4

From the reviews before 0.12.3; small, and none of them a defect in what was released:

- **`sceneFromReport` and a node shape it does not know.** A `view.locale` or `view.palette` of
  a later version is passed over, but an unknown shape in `view.shapes` is an `invalid-input`
  error from `buildScene`, where `<kgdiff-viewer>` drops the entry with a warning. Filter the
  entries as the viewer does (`shapes` is experimental, so this may change).
- **Three assertions missing** in `packages/scene/test/report.test.ts`: `options.palette` over
  the payload's, `{ locale: undefined }`, and `unsupported-version` for a diff or a layout of
  another version. All three behave as documented; nothing pins them.
- **A hidden edge's colour**, `kgdiff apply -o /dev/null`, the G6 adapter's dev page and the
  slow property tests, below.

## 0.12.x, not started

- **A hidden edge's colour is the empty string**, which `parseColor` refuses. A host that
  parses every edge's colour has to look at `visible` first. Giving hidden elements a colour
  that parses is an addition.
- **`kgdiff apply … -o /dev/null` fails** with "operation not permitted": the output is written
  to a temporary file and renamed, which a device does not allow. Found while testing
  `--verify-target`, whose use in automation is exactly "check, and keep nothing".
- **Two property tests are slow.** `packages/core/test/properties.test.ts` takes over a minute
  on its own, and two of its tests passed their 5 s limit when the machine was busy (a
  pre-release run on 2026-11-18); they have not failed in CI. Give them the limit the two heavy
  tests already have, or fewer cases.
- **The G6 adapter's dev page is broken** (`packages/g6/dev/main.ts`): it calls `diff` and
  `layoutDiff` without awaiting them, which they have needed since 0.11, and stops with
  "diff.nodes is not iterable". It is the only page that draws the adapter with a real G6 in
  a browser, and it has no entry in `.claude/launch.json`.
- **GEXF as NetworkX writes it**: node and edge attributes named `start`, `end` and `pid` are
  written as XML attributes, where kgdiff reads them as time and hierarchy and drops the
  values, with a warning. Undecided whether to keep them as fields.
- **Fixtures written by the tools.** The NetworkX fixtures of the GraphML and GEXF readers were
  written by hand; `crates/kgdiff-formats/tests/fixtures/networkx.py` writes them and has not
  been run. Nothing was run through yEd or Gephi either.
- **Native binaries on GitHub releases and a Homebrew formula.** The workflow is ready
  ([Releasing](releasing.md#native-binaries-and-crates)); it needs the `native` environment,
  its token and `NATIVE_RELEASE_ENABLED`.

- Additions with an issue: KGCL export (#10), an MCP server (#13), playground links that diff
  two URLs (#11), the GraphRAG (#18) and ODK (#17) guides.

## 0.13, the next breaking release

Not before the end of December 2026: a breaking release comes no more often than about every
six to eight weeks, and 0.12.0 was 2026-11-13. Three of these are about what a graph holds
(direction, ids, edge identity) and are better designed together, in one short document, before
any of them is written.

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why it waits for 0.13                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Direction is part of an edge.** GraphML and GEXF use an edge's direction only to order its ends and then drop it, so an edge that becomes undirected, or `mutual`, compares as unchanged. Node-link JSON's `directed: false` is not read at all, and its undirected edges keep their ends as written, unlike GraphML's. graphology's undirected edges already carry an `undirected` attribute; the same for every format is the likely answer. | Changes the graph, and so the hash, of every undirected input                   |
| **Whole numbers as ids beyond 2^53.** JSON ids `9007199254740992` and `…993` are one double and become one node (reported as a duplicate declaration). Refuse them, or keep their digits.                                                                                                                                                                                                                                                        | Refusing breaks inputs that are read today; keeping digits changes their output |
| **A graph file says how its edges are identified.** A graph written with edges identified by id and read back with the default loses its parallel edges: `kgdiff.graph` does not record the identity.                                                                                                                                                                                                                                            | A member of the graph document; may turn out to be an addition                  |
| **`DiffResult` behind accessors** (Rust). Its vectors are public and its lookups index them lazily: changing a vector after a lookup makes the next one miss (#155). Read-only accessors, as `KGraph` has.                                                                                                                                                                                                                                       | Removes public fields                                                           |
| **`CliIo` in Rust's idiom** (`columns() -> Option<f64>`, `now() -> String`, paths as `&str`).                                                                                                                                                                                                                                                                                                                                                    | Changes a public trait (marked experimental)                                    |
| **`entity_type` as a type field** (what LightRAG calls an entity's type).                                                                                                                                                                                                                                                                                                                                                                        | Changes the output for JSON inputs that have such a field                       |
| **Parallel edges under `--ignore-attr`.** Copies of an edge that differ only in an ignored attribute are not paired first as identical, because the comparison includes the ignored attributes: two copies whose ignored attribute is swapped are reported as two modified edges. The delta is right and applies.                                                                                                                                | Changes the diff reported for such inputs                                       |

## Not scheduled

- **The plain view of one graph (RFC 0003, part 4c) and groups in the layout (part 4d).** Both
  were asked for by Semlia when kgdiff was to draw its ontology map; it now draws that map
  itself, and no host asks for either. They were planned for 0.13 and 0.14 and left the plan on
  2026-11-18 ([RFC 0003, Revision 2026-11-18](rfcs/0003-embedding-hosts.md#revision-2026-11-18));
  they come back when a host needs them.
- **Partitions**: which layer or subgraph a node belongs to, so that changing it is a move
  (asked by kgstrata; [RFC 0003, Revision 2026-11-17](rfcs/0003-embedding-hosts.md#revision-2026-11-17)).
  A new kind of change in the diff model; to be designed with part 4d if either is taken up.
- A Python API and Jupyter (#14), Cytoscape.js (#12) and Sigma.js adapters, RDF Patch export,
  accepting or rejecting hunks into a filtered delta, three-way merge, a Web Worker pipeline
  and a WebGL renderer, a third UI language (#15).

## Hosts

What the two embedding hosts use, since it decides the above.

- **Semlia** (pinned to 0.12.1; 0.12.2 needs no change): `layout_graph`, `layout_diff_on`,
  `report_payload_with`, the report's `shapes`, and `@kgdiff/g6` with `@kgdiff/scene` for its
  change view, which can drop four workarounds with 0.12.3 (#158). It does not use the
  renderer, `addLayer` or the composed elements. Of the experimental APIs, node shapes are the
  one a host has used, and they were enough.
- **kgstrata** (pinned to 0.12.1; a concept page, not published): `diff`, `buildScene` and the
  frame resolver, drawn in 3D by its own renderer. With 0.12.3 it can drop three workarounds:
  the layout object it fakes, the search for the node nearest to a glyph, and its own colour
  parser.

## Conditions for 1.0

The five conditions are in the [README](../README.md#roadmap). Where they stand:

1. A real host for about a month: Semlia has run on 0.12.1 since mid-November 2026.
2. Experimental APIs used or settled: node shapes used; `addLayer` and the embedding interface
   of the `kgdiff` crate not used by anyone.
3. The Python API settled, or only the command line promised: only the command line is shipped
   (`pykgdiff`); not stated as the promise yet.
4. The accessibility review: done. Checks in Chrome and a pass with VoiceOver by the maintainer;
   three things were fixed in 0.12.2 and 0.12.3 ([#16](https://github.com/iiwish/kgdiff/issues/16), closed 2026-11-18).
   Not done: a review by someone who uses a screen reader every day.
5. No breaking change for about a month or two minor releases: 0.13 will restart this.
