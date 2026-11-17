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

Last reviewed 2026-11-17, after 0.12.2.

## 0.12.3

Merged, waiting for the release:

- `@kgdiff/scene`: a scene from the host's own positions (`SceneLayout`), glyphs that name the
  nodes they run between, `parseColor` (#148).
- The viewer's sidebar buttons are 28 px targets (#149).
- GraphML and GEXF: a whole number too large for a double is not reported as mistyped (#150).

From an audit of the diff and apply paths on 2026-11-17:

- **A delta kgdiff made applies to its own base** when an edge's explicit id equals a
  structural key and the same triple has parallel edges (`--edge-identity id`); before, `apply`
  stopped with "edge already exists". A fix in how edges are paired; output changes only for
  inputs where an id took a key parallel copies would have used (#153).
- **`kgdiff apply --verify-target`**: fail when the result is not the delta's target. Without
  it, a result that differs from `target.hash` stays a warning and exit 0, the contract (#154).
- **`DiffResult` lookups do not panic** after its public vectors were changed (#155). The
  lookups miss then rather than answer wrongly; reading the fields through accessors is in 0.13
  (below).

## 0.12.x, not started

- **`@kgdiff/g6`, for the change view of a host** (read from Semlia's code, not yet confirmed
  as wanted): a replay that can seek backwards (today the controller only plays forward, and
  the host rebuilds the graph to go back); the hunk an element belongs to, as documented data or
  an event (the host reads an undocumented `data.hunk`); the hunk of a node id; a typed reader
  of the report payload.
- **A hidden edge's colour is the empty string**, which `parseColor` refuses. A host that
  parses every edge's colour has to look at `visible` first. Giving hidden elements a colour
  that parses is an addition.
- **`kgdiff apply … -o /dev/null` fails** with "operation not permitted": the output is written
  to a temporary file and renamed, which a device does not allow. Found while testing
  `--verify-target`, whose use in automation is exactly "check, and keep nothing".
- **Parallel edges under `--ignore-attr`**: copies of an edge that differ only in an ignored
  attribute are not paired first as identical, because the comparison includes the ignored
  attributes. The delta is right; the diff may report a change of pairing that a reader does
  not expect.
- **GEXF as NetworkX writes it**: node and edge attributes named `start`, `end` and `pid` are
  written as XML attributes, where kgdiff reads them as time and hierarchy and drops the
  values, with a warning. Undecided whether to keep them as fields.
- **Fixtures written by the tools.** The NetworkX fixtures of the GraphML and GEXF readers were
  written by hand; `crates/kgdiff-formats/tests/fixtures/networkx.py` writes them and has not
  been run. Nothing was run through yEd or Gephi either.
- **Native binaries on GitHub releases and a Homebrew formula.** The workflow is ready
  ([Releasing](releasing.md#native-binaries-and-crates)); it needs the `native` environment,
  its token and `NATIVE_RELEASE_ENABLED`.
- **The accessibility review ([#16](https://github.com/iiwish/kgdiff/issues/16)).** Checks in
  Chrome on 2026-11-17 (names, contrast in both themes, tab order, targets, landmarks) found
  the canvas's missing focus ring and the nested main landmark, both fixed in 0.12.2. A pass
  with VoiceOver by the maintainer found nothing to fix. One thing was not confirmed either
  way: whether marking a change reviewed (`x`) is announced, since the state only changes the
  label of the option that already has focus.
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
| What the accessibility review asks to change in an interface                                                                                                                                                                                                                                                                                                                                                                                     | Nothing so far                                                                  |

## Not scheduled

- **The plain view of one graph (RFC 0003, part 4c) and groups in the layout (part 4d).** The
  README lists them under 0.13 and 0.14. Both were asked for by Semlia when kgdiff was to draw
  its ontology map; it now draws that map itself, and no host asks for either. Open decision:
  take them out of the plan until a host does.
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
  change view. It does not use the renderer, `addLayer` or the composed elements. Of the
  experimental APIs, node shapes are the one a host has used, and they were enough.
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
4. The accessibility review: see above; #16 is still open.
5. No breaking change for about a month or two minor releases: 0.13 will restart this.
