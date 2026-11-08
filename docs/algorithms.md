# kgdiff algorithms

Specification of the core diff pipeline, the layout and the replay schedule. Types referenced
here are defined in `packages/core/src/types.ts`, `packages/layout/src/index.ts` and
`packages/scene/src/types.ts`.

```
normalize ─▶ match nodes ─▶ detect merges / splits ─▶ classify nodes ─▶ pair & classify edges
          ─▶ build union ─▶ group into hunks ─▶ order hunks ─▶ emit delta ─▶ stats
```

## 1. Normalization (`normalize`)

- Node: `label` defaults to the id; `types` / `aliases` / `replaces` / `replacedBy` sorted and
  de-duplicated; aliases equal to the label are dropped; labels, aliases and types (not ids)
  are composed to Unicode NFC, so precomposed and decomposed text compare equal; `attrs` keys
  kept as given (comparison is key-order-insensitive); empty ids are dropped with an `empty-id`
  issue.
- Attribute values are made JSON: NaN / ±Infinity → `"NaN"` / `"Infinity"` / `"-Infinity"`,
  bigint and Date → strings, objects with `toJSON` converted; functions, symbols and
  `undefined` are dropped (or `null` inside arrays) with an `invalid-attr` issue. Values nested
  deeper than 1000 levels (or cyclic) are rejected with `KgdiffError('invalid-input')`. Keys such
  as `__proto__` and `constructor` are ordinary data (own properties, never prototype reads).
- Duplicate node ids: merged independently of declaration order — sets united, every scalar
  (label, deprecated, position, each attribute) taken from the declaration whose value is
  largest by canonical JSON — with a `duplicate-node` issue.
- Edge key (`edgeIdentity`):
  - `structure`: `JSON.stringify([source, predicate, target])`; copies of one triple that are
    identical in content collapse into one; distinct copies get `#2`, `#3`… in canonical
    content order (so keys never depend on input order); a `duplicate-edge` issue is recorded.
  - `id`: the edge id; edges without an id fall back to the structural key. Ids and structural
    keys are grouped separately and ids are keyed first, so an id that looks like a structural
    key only pushes that key aside (`#2`). Repeated ids merge like duplicate nodes.
- Dangling endpoints: `create` (default) adds `{ id, label: id, implicit: true }`; `drop`; `error`.
- Edge `label` defaults to `predicateLabel(predicate)` (NFC).
- Indexes: `outgoing` / `incoming` keep edge insertion order.
- Complexity O(N + E); the result never depends on the order of the input nodes and edges.

`predicateLabel`: strip the IRI namespace (after the last `#`, `/` or `:`), replace `_` with a
space, keep camelCase as written. Opaque ids (local part made only of digits) stay whole, and an
opaque OBO PURL reads like its CURIE. Examples: `rdfs:subClassOf` → `subClassOf`,
`http://purl.obolibrary.org/obo/part_of` → `part of`, `…/obo/RO_0002131` → `RO:0002131`,
`BFO:0000050` → `BFO:0000050`, `投资` → `投资`. kgdiff JSON leaves an edge label out only when it
equals `predicateLabel` without its NFC step, so `diffFromJSON` restores it without Unicode tables,
and takes all other snapshot text as written (the delta's content hashes check it).

## 2. Node matching (`matchNodes`)

Goal: a 1:1 partial mapping before → after with a confidence for each pair.

1. **Exact ids** (strategies `id`, `auto`): equal ids match with score 1 (method `id`).
2. **Replacement hints** (all strategies): a before node `x` whose id no longer exists and an
   after node `y` whose id is new match with method `hint`, score 1, when `x.replacedBy ∋ y` or
   `y.replaces ∋ x`, `x` hints at no other after node and no other before node hints at `y`.
   This recognises a term that simply changed its id (OBO `alt_id`, which formats map to
   `replaces`). Several sources stay a merge, several targets a split (§3). A hint match yields
   a `rekey` facet (score 1) under strategies `id` and `auto`.
3. **Leftovers** (strategies `auto`, `similarity`): `R` = unmatched before nodes, `A` = unmatched
   after nodes. With `similarity`, `R` and `A` are all nodes not matched by a hint.
4. **Candidate generation (blocking).** Build an inverted index over `A` from _block keys_:
   normalized label and aliases (`f:`); their word tokens of length ≥ 2, stop-words removed
   (`w:`); the first 4 characters of tokens of length ≥ 4 (`p:`, catches abbreviations and
   late typos); for CJK text, character bigrams (`b:`); for text made only of punctuation, the
   text itself (`r:`); and shared types only as a tiebreaker (never alone). For each `r ∈ R`
   collect the `A` nodes sharing ≥ 1 key, rank them by IDF-weighted key overlap (a key weighs
   1 / log₂(1 + its posting-list length); keys with very long posting lists are truncated, and
   skipped once enough candidates are known; the node with the same id, possible only with
   `similarity`, is always kept), score the best `3 · maxCandidates` cheaply (label similarity
   only) and keep the top `maxCandidates`. Do the same for each `a ∈ A` over an index of `R`;
   the candidate pairs are the union of both sides, so neither version is favoured. Total work
   ~O((|R| + |A|) · k).
5. **Scoring.** For a candidate pair `(r, a)`:
   - `label` = max `textSimilarity` over {label} × {label ∪ aliases} in both directions.
   - `neighbors` = weighted Jaccard of neighbour signatures. A signature is
     `(direction, predicate, matchedCounterpart)`, weighted by 1 / log₂(2 + degree of the
     counterpart) (hubs say little about identity); neighbours of `r` are mapped through the
     current matching; unmatched neighbours contribute nothing. 0 when both have no matched
     neighbours (missing signal).
   - `types` = Jaccard of type sets (missing signal when both are empty).
   - `attrs` = |equal key-value pairs| / |union of keys|, `ignoreAttrs` skipped (missing signal
     when both are empty).
   - `score = Σ wᵢ·sᵢ / Σ wᵢ` over _present_ signals, with weights label 0.55, neighbors 0.25,
     types 0.1, attrs 0.1. A label similarity below 0.5 caps the score at 0.5 (two things with
     unrelated names are never confidently the same). Scores are rounded to 1e-6.
6. **Assignment.** Sort candidate pairs by score desc, then pairs with equal ids first, then by
   `(r.id, a.id)` for determinism. Accept `(r, a)` when both are free, `score ≥ threshold`, and
   the pair is _unambiguous_: it leads every free rival of `r` and of `a` by ≥ 0.05. Two
   refinements keep exact matches exact: a perfect pair (score 1) is never blocked by an
   imperfect rival, and an exact tie is resolved in favour of the pair whose ids are equal
   (which only arises with `similarity`, where indistinguishable nodes would otherwise turn
   `diff(A, A)` into removals and additions). Ambiguous pairs above the threshold become
   suggestions with reason `ambiguous`.

   **Deferral.** A pair is not accepted on its label alone against conflicting types while the
   neighbour evidence can still arrive. It is _deferred_ when both nodes are typed and share no
   type, no attribute agrees (`attrs` missing or 0), and the neighbour signal is missing although
   `r` or `a` has an edge to another node, so it is missing only because none of their
   neighbours is matched yet. Without this rule the missing signal drops out of the mean and an
   equal label outweighs the types (`Mercury` the planet, orbiting the Sun, against `Mercury`
   the element, with symbol `Hg`, scores 0.55 / 0.65 ≈ 0.85), which under `similarity` happens
   to every pair in the first round. A deferred pair stays free, so it still blocks its weaker
   rivals, and is scored again in the next round with the neighbours matched meanwhile (the two
   Mercurys share none: 0.55 / 0.9 ≈ 0.61, a suggestion; a planet whose type was merely
   renamed still orbits the Sun: 0.8 / 0.9 ≈ 0.89, a match). When a round accepts nothing else,
   and in the last round, deferred pairs are assigned on what is known. The scoring is
   unchanged: deferral only lets the neighbour evidence arrive before such a pair is decided.
7. **Propagation.** Neighbour similarity depends on the matching, so repeat steps 5–6 for the
   still-unmatched pairs while the previous round accepted at least one match (max 5 rounds).
8. **Suggestions.** Remaining pairs with `score ≥ suggestThreshold` (best per `r`, best per `a`)
   become `MatchSuggestion { reason: 'below-threshold' }`.

`DiffResult.matches` lists the `hint` and `similarity` matches (id matches are implied).

`textSimilarity(a, b)`: Unicode NFKC, lowercase, control / format characters removed, `_-./`
and punctuation → space, collapse whitespace. Equal → 1. Otherwise the max of (i) Sørensen–Dice
over character bigrams of the whitespace-free strings and (ii) token-set ratio (Dice over word
tokens, order-insensitive; a token written as an abbreviation with a period, such as `Univ.`,
also matches a longer token it prefixes, such as `University`, with weight 0.9); strings shorter
than 4 characters use Jaro–Winkler instead of bigrams, with the Winkler prefix bonus only when
both strings have ≥ 4 characters and comparable lengths (ratio ≥ 0.7) — so `AB` is not almost
`ABCDEFGH`. When both texts mention numbers and the numbers differ (digit runs, leading zeros
ignored: `Type 1` / `Type 2`, `B1` / `B12`, `Windows 10` / `11`), the result is capped at 0.5;
a number on one side only (`stg_orders` → `stg_orders_v2`) is an ordinary edit. Strings made
only of punctuation are 1 when equal as written, else 0. Result clamped to [0, 1], rounded to
1e-6, exactly symmetric.

## 3. Merges and splits

Run after matching, before classification (`detectMerges`, `detectSplits`).

**Merge** (N → 1): a set of before nodes `S` (|S| ≥ 2 counting a survivor) that collapse into
one after node `T`.

- _Hint evidence_ (confidence 1): a before node `x` with `replacedBy ∋ T.afterId`, or an after
  node `T` with `replaces ∋ x`, where `x` is unmatched **or** deprecated in the after version,
  and `T` also corresponds to some other before node (its match) or to ≥ 2 hinted sources.
- _Heuristic evidence_: an unmatched before node `x` and an after node `T` that is matched to a
  different before node `y`, such that `textSimilarity(x.label, any of T.label ∪ T.aliases) ≥ 0.9`
  **or** `x.label ∈ T.aliases` (new synonym); **and** edge carry-over ≥ 0.5: of `x`'s edges
  `(x, p, n)`, the fraction for which `T` has `(T, p, map(n))` in the after version (same for
  incoming). Confidence = 0.5·labelEvidence + 0.5·carryOver; accept ≥ 0.75, else a suggestion.
- Overlaps: a target that itself merges away forwards its sources — a chain `a → n → m`
  collapses onto the final target `m` (sources `a` and `n`); nodes that replace each other in a
  cycle (`a ↔ b`) are not merges. A hint already present (and acted upon) in the before version
  is not a change.
- Result: sources get facet `mergedInto { target, confidence, via }`; `T` gets
  `mergeTarget { sources }` (sorted). A deprecated-but-present source keeps status `modified`
  and also gets `deprecate`.

**Split** (1 → N): mirror image — one before node `x` whose content goes to ≥ 2 after nodes:
`x`'s own match (if any) plus unmatched after nodes `t` with `replaces ∋ x` / `x.replacedBy ∋ t`
(hint), or (heuristic) label evidence **and** edge carry-over:
- label evidence: `textSimilarity(t.label, l) ≥ 0.9` for some `l ∈ {x.label} ∪ x.aliases`, or
  `t.label ∈ x.aliases`, or `x.label ∈ t.aliases` — symmetric with the merge rule;
- carry-over: the fraction of **`t`'s** edges `(t, p, n)` (both directions) for which `x` had
  `(x, p, map⁻¹(n))` in the before version — "the new node took its edges from `x`".
  Confidence = 0.5·labelEvidence + 0.5·carryOver; accept ≥ 0.75. Targets get `splitFrom`, `x`
  gets `splitInto`. A merge source cannot split and a merge target cannot be a new split target;
  a merge target may split (its merge and split are reviewed as one hunk, §7).

**Heuristic candidates.** Carry-over ≥ 0.5 implies that a counterpart shares at least one edge
pattern `(p, n)` with the node, so candidates are searched in those neighbourhoods only (the
nodes with an edge `p` to / from the mapped neighbour): exhaustively when a neighbourhood has
≤ 32 members, otherwise through a per-neighbourhood name index (exact normalized text, words and
word prefixes; keys shared by more than 32 members are not followed — a near-identical name
always shares a rarer key, and many equally named members would make any choice a guess).
Carry-over is then counted per candidate with O(degree) edge lookups, so hubs never cause
quadratic work.

## 4. Node classification

For every matched pair (before `b`, after `a`), compute facets in **canonical facet order**:

`rekey` → `rename` → `mergedInto` → `mergeTarget` → `splitFrom` → `splitInto` → `move` →
`deprecate` → `replacement` → `types` → `aliases` → `attrs`

- `rekey`: `b.id ≠ a.id` (hint or similarity match), with the match score — **only when ids
  are meaningful** (strategies `id` and `auto`). With strategy `similarity` ids are declared
  meaningless, so an id difference is not a change (`beforeId` / `afterId` are still recorded).
- `rename`: labels differ (exact string comparison).
- `types` / `aliases`: set differences.
- `attrs`: keys in `ignoreAttrs` skipped; values compared by canonical JSON (object keys sorted;
  arrays compared in order, except arrays of primitives coming from RDF/OBO multi-values which
  formats emit pre-sorted). Changes sorted by key.
- `move`: for each hierarchy predicate `p`, parents(b) mapped to union ids vs parents(a); if the
  sets differ → `move { predicate: p, from, to }` (one facet per predicate with changes).
  Exception: a node that becomes deprecated (or merged into / split into others) and merely
  loses parents (`to` empty) gets no `move` — dropping parents is part of the obsoletion; the
  removed hierarchy edges stay in the node's hunk.
- `deprecate`: `deprecated` flag changed.
- `replacement`: `replaces` and / or `replacedBy` changed (ids as written); each side is a
  `SetChange`, empty when that side did not change.

Status: matched + ≥ 1 facet → `modified` (a modified node always has a facet); matched + none →
`unchanged`; before-only →
`removed`; after-only → `added`. Merge sources that disappear are `removed` (with `mergedInto`);
split targets that are new are `added` (with `splitFrom`).

## 5. Edge pairing and classification

Map every before edge into union-id space (endpoints through the node mapping). Then:

1. **Exact**: same union key (or same id in `id` mode) → candidate `unchanged`; compare `label`
   and `attrs` → facets `label`, `attrs` → `modified` if any. Parallel copies of one triple are
   paired content-first (identical copies stay `unchanged`), then in key order. In `id` mode an
   id keeps its identity even when its endpoints or predicate change (→ `retarget` /
   `predicate` facets).
2. **Carried by merge / split**: a remaining before edge with an endpoint in a merge source `x`
   (→ `T`) pairs with a remaining after edge having `T` at that end and the same predicate and
   other endpoint. → one union edge, status `modified`, facet `retarget { cause: 'merge' }` with
   `sourceBefore` / `targetBefore` set. If `T` already had the same edge before, the source's edge
   is `removed` with facet `collapsed { into }`. Splits analogously (`cause: 'split'`).
3. **Predicate change**: remaining edges grouped by (source, target); a group with exactly one
   removed and one added edge → `modified` with facet `predicate`.
4. **Retarget**: remaining edges grouped by (source, predicate); exactly one removed and one
   added → `retarget { end: 'target' }` — also when the old target is removed or the new one
   added (the subject's statement was redirected; `Hunk.requires` orders the dependency). Then
   by (target, predicate) → `retarget { end: 'source' }`, but only when both the old and the new
   source exist in both versions: a statement belongs to its subject, so a new subject's
   statement is an addition and a removed subject's statement a removal (they stay in the add /
   remove hunks). `cause: 'move'` when the predicate is hierarchical and the source is a moved
   node, else `'edit'`. Groups with other cardinalities stay as adds / removes (never guess).
5. Everything left: before-only → `removed`, after-only → `added`.

`hierarchical` = predicate ∈ `hierarchyPredicates`.

## 6. Union ids

See `UnionId` in `types.ts`. Nodes: after id, else before id (+`@before` on collision). Edges:
computed from union endpoint ids so unchanged edges get the same id in both versions; a retarget
uses the after key. Union nodes and edges are sorted by id (UTF-16 code unit order).

## 7. Hunks

Every changed union element belongs to exactly one hunk. Seeding order (first claim wins):

1. **merge** — per target `T`: sources, `T`, carried and collapsed edges, every other changed
   edge incident to a source, and (when `T` is new) every changed edge incident to `T`.
   Anchor `T`.
2. **split** — per source `x`: `x`, its targets, carried edges, and every other changed edge
   incident to `x` or to a _new_ target (status `added`). Anchor `x`. When `x` is also a merge
   target, its split joins the merge hunk (one restructuring, anchor still first).
3. **add** — connected components of added nodes over added edges (union-find), plus every added
   edge incident to them. Anchor: the highest-degree node of the component (tie → smallest id).
4. **remove** — the same for removed nodes / removed edges.
5. **modify** — every remaining modified node, plus remaining changed edges whose **source** is
   that node (subject-centric, like a file in git), including the hierarchy edges of its moves.
6. **relations** — remaining changed edges grouped by source node; anchor = that source.

`context`: the nodes needed to read the hunk that it does not own — endpoints (old and new) of
its edges, the parents named in `move` facets, and for merges / splits the neighbours of the
target / source — sorted. They may be unchanged, or changed and owned by another hunk.

`phase`: remove → `remove`; merge, split, relations → `restructure`; modify → `modify` (but
`restructure` when its only node facets are `move`); add → `add`.

**Dependencies** (`requires`): from the delta. Each op reads and writes resources — a node id,
the edges incident to a node, an edge identity — following its precondition and effect
(docs/delta-format.md). In delta order, an op depends on the last writer of everything it reads
and, when it writes, on the readers since that write; removing edges at one node commutes, so
only the node's removal waits for them. Lifted to hunks: `A.requires ∋ B` when an op of `A`
depends on an op of `B` (an edge to a node added in `B`, a node whose edges `B` removes, a node
`B` renames, …). Ops in no hunk (id-only rekeys under `similarity`) form a preamble at the
start of the delta that never depends on a hunk: a hunk-owned node in its way is parked on a
temporary id within the preamble. A cycle of hunks that require each other (rare) is merged
into one hunk, which keeps the identity (id, kind, anchor, phase) of its best-ranked member.

**Default order** (`order`): a topological order of `requires` — Kahn's algorithm that, among
the hunks ready at each step, takes the earliest phase (remove, restructure, modify, add), then
the larger hunk (nodes + edges), then the anchor label (code-unit order), then the id. Applying
the preamble and then each hunk's ops in this order succeeds strictly and yields the after
graph (property-tested). Phases are a preference, not a guarantee: a removal that waits for a
relation retargeted to a new node comes after that addition.

Hunk ids: `${kind}:${anchor}`; collisions get `#2`, `#3`.

## 8. Delta

Built from the classified union. Canonical op order — each op's ids refer to the graph state
reached by the previous ops:

1. `node.rekey`: every before id whose union id differs (matches with another id, removed nodes
   that need `@before`). Sorted by `from` when no rename blocks another (always the case unless
   ids are ignored for matching); otherwise chains run back to front and cycles go through a
   temporary id. Renames that belong to no hunk come first (the preamble, §7).
2. `edge.remove` (sorted by key), including removed sides of retargets / predicate changes / carries
3. `node.remove` (sorted by id)
4. `node.set` (by id, then field in order label, types, aliases, deprecated, replaces, replacedBy)
5. `node.attr` (by id, then key)
6. `node.add` (sorted by id)
7. `edge.add` (sorted by key)
8. `edge.set`, then `edge.attr` (by key, then field / attr key)

`applyDelta` (strict): checks `base.hash`, then each precondition (node exists / absent, current
value equals `from`, edge exists / absent) and throws `KgdiffError('delta-conflict', …,
{ opIndex, op, reason })` on the first failure. Non-strict skips ops whose precondition fails.
`invertDelta` reverses the op list, inverts each op (add↔remove, swap from/to, rekey to→from)
and swaps base/target. Invariants (property-tested):

- `hashGraph(applyDelta(A, diff(A, B).delta)) === hashGraph(B)`
- `hashGraph(applyDelta(B, invertDelta(diff(A, B).delta))) === hashGraph(A)`
- `diff(A, A).delta.ops.length === 0` and `diff(A, A).stats.identical`

With strategy `similarity`, `node.rekey` ops of nodes whose only difference is their id belong
to no hunk (the node is `unchanged`), so `stats.identical` can be true while the delta is not
empty.

`hashGraph`: each node and edge is encoded canonically (attrs keys sorted) and hashed with
cyrb53; the 64-bit element digests are summed (a multiset hash: order-independent, no sorting,
no giant strings) and the sum is hashed once more, rendered `c53:` + 14 hex digits. Excluded:
positions, meta, `implicit`, and edge ids in `structure` mode — a delta cannot express changes
to them, so including them would break the round-trip invariants. These fields are likewise
never compared by `diff`.

## 9. Stats

Counts per status for nodes and edges; facet counts (per element carrying the facet); hunks per
kind; `byType` per node type (`types[0]` of the union node, '' when untyped).

## 10. Hunk ordering for review and replay (scene)

Order hunks as a short spatial tour so the camera travels little, while respecting `requires`:
at each step consider only _ready_ hunks (all requirements already placed) and, among them,
those of the earliest phase; the first pick is the largest hunk, every later pick the one whose
anchor is nearest the previous anchor (grid-accelerated), ties broken by core's `order`. Phase
is therefore a preference, not a barrier: a hunk may follow a later-phase hunk it requires. A
dependency cycle (impossible by construction, core merges cycles) would be broken at the
smallest `order`. In `chapters` mode each phase present forms one chapter; a hunk that requires
a hunk of a later chapter moves into that chapter, and within a chapter the stagger follows the
tour, so every hunk starts after its requirements.

Timeline: hunks play one at a time in `hunks` mode with duration
`pace · kindFactor · clamp(√size, 1, 2.2)` (`kindFactor`: add/remove 0.85, modify 0.8,
relations 0.95, merge/split 1.3) plus a 160 ms gap. Above `chapterThreshold` hunks, `chapters`
mode plays every hunk of a phase together over `pace · clamp(1.2 + log₂(n), 1.2, 4)`, with a
small stagger (≤ 35% of the chapter) in tour order.

## 11. Focus (changes-only view)

`computeFocus` applies the same rule as the layout's `changes` scope (§12 **Scope**), so the
changes-only view and a `changes` layout show the same nodes:

- Visible: changed nodes (distance 0); both versions' endpoints of every changed edge (distance
  1, visible even with `hops` 0); context from a BFS over both versions' edges from the changed
  nodes, `hops` deep (default 1; edge endpoints continue from hop 1), that never expands **from**
  a hub (degree, max over both versions, above `hubDegree`, default 40; `Infinity` disables);
  plus `expanded` nodes (not expanded from). With `hunk`, that hunk's nodes and edges are the
  changes. Edges are visible when both endpoints are.
- `context`: visible nodes outside the change set (drawn quieter).
- Hidden nodes are grouped into `CollapsedGroup` pills: next to a visible hub that was not
  expanded from (its skipped neighbours), else next to the lowest-index visible neighbour; nodes
  further out join the group of the frontier node that reaches them first (BFS through hidden
  nodes); components touching nothing visible form one group each. Ids are stable:
  `near:<union id>` / `component:<smallest union id>`. A pill sits at the centroid of its hidden
  members (or just outside its node, away from its visible neighbours, when every member is out of
  the layout), also counts neighbours left out of the layout (`SceneNode.hidden`), and is labelled
  in the scene locale: “+38 unchanged” / “+38 个未变节点” (“+3 hidden” / “+3 个隐藏节点” when a
  hunk-restricted focus also hides changed nodes).

## 12. Layout (`layoutDiff`)

**Scope.** `all`, or `changes` (changed + `contextHops` context) for graphs larger than
`largeGraphThreshold`. In `changes`, changed nodes are always in scope (distance 0), and so are
both versions' endpoints of every changed edge (distance 1: they are needed to draw the edge).
Context is a BFS over both versions' edges from the changed nodes, `contextHops` deep (edge
endpoints continue from hop 1), that never expands **from** a hub — a node whose degree (max over
both versions) exceeds `hubDegree` (default 40). A hub stays in scope when it is changed or within
reach, but neighbours that could only enter through it do not, so one changed class with
thousands of instances does not pull its whole neighbourhood into the layout. Out-of-scope
neighbours are counted in `hidden`, which only lists nodes with a non-zero count.

**Strategy.**
- `anchored` when positions are known (pins, or `position` on before / after nodes): known nodes
  are fixed; each new node starts at the barycenter of its placed neighbours plus a deterministic
  jitter (or near its merge / split partner), then a force simulation runs with known nodes fixed.
- `union` otherwise: one simulation over the union graph so neither version is favoured.
  Merge sources get a weak spring (strength 0.08) towards their target and split targets towards
  their source, so replay travel distances stay short. Removed and added nodes are laid out like
  any other node — the union layout already reserves their space.

**Simulation** (d3-force with `randomSource` from a seeded mulberry32; never `Math.random`):
- initial positions: phyllotaxis spiral in BFS order from the highest-degree node per component
  (deterministic, avoids the hairball start);
- `forceLink` distance `linkDistance · (1 + 0.15·log₂(1 + min(deg_s, deg_t)))`, strength
  `1 / min(deg_s, deg_t)`;
- `forceManyBody` strength `−(220 + 40·√degree)`, `theta 0.9`, `distanceMax 900`;
- label-aware collision: a custom rectangle-vs-rectangle collision force over node + label boxes
  (label box below the node, width from `estimateLabelWidth`), resolved with a quadtree;
- iterations: `clamp(300 − 25·log₂(N), 120, 300)` unless overridden; alpha decay to match.

**Components.** Lay out each connected component independently (largest first), then pack them
with a skyline / shelf packer sorted by height into a roughly 16:10 overall aspect ratio with
`componentGap` between them. Isolated nodes are packed as a compact grid at the end.

**Refinements** (implemented in `packages/layout/src/forces/params.ts`):
- many-body strength scales with `(linkDistance / 56)²`, so `linkDistance` changes the drawing's
  scale (identical to the formula above at the default);
- crowded labels: repulsion × `clamp(labelArea / 1.5L², 1, 3)` for very large label boxes, and
  link strength relaxes around hubs whose neighbours' labels cannot fit at link distance;
- a weak, size-decaying centering force; PCA orientation normalization (union only) so
  re-layouts of similar graphs face the same way;
- staged collision: nodes only for the first 35% of ticks, then label boxes grow from 50% to
  100% over 25% of ticks; a final Jacobi de-overlap pass (≤ 150 rounds) and, as a last resort,
  uniform expansion by 3–15%;
- merge / split partners further than `L` apart after the simulation are docked into the
  nearest free spot next to their partner;
- anchored mode simulates only a window around new nodes (quadtree range query) and keeps known
  positions bit-exact (no rounding, no centering).

Only `+ − × ÷ √` are used inside the simulation (core's `log2`, exact rotation constants),
so results are byte-identical across JavaScript engines.

**Post-processing.** Center the result at the origin (union strategy); round to 0.01; compute
bounds including label boxes (labels capped at 32 em).

`extendLayout`: like anchored, with every already placed node fixed and only `nodes` free.

`estimateLabelWidth`: sum of per-character advances — CJK / full-width / emoji 1.0em, digits
0.6em, uppercase 0.68em, other Latin 0.56em, space 0.3em.

## Determinism checklist

- Sort before iterating any Map/Set whose order could depend on input order _when that order
  affects output_.
- Seeded PRNG only. Fixed iteration counts. No time-based termination.
- Floating-point results rounded at the API boundary (layout 0.01, scores 1e-6).
- Only exactly rounded arithmetic (`+ − × ÷`, `Math.sqrt`) in what core, formats and the layout
  compute: `log₂` is core's `log2`, built from those (matching's weights, the layout), never
  `Math.log2`; no `Math.pow`, `Math.exp` or trigonometric functions, which engines approximate
  differently. (The renderer's camera and animations may use them: they compute no result.)
- Snapshot tests assert identical `diffToJSON` / `layoutToJSON` for shuffled inputs.
