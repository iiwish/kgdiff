# How kgdiff tells changes apart

Before kgdiff can say that a node was renamed, moved or merged, it has to decide which node in
the new version is which node in the old one. Most surprises in a diff come from that pairing.
This page goes through the questions reviewers ask most, with what kgdiff does in each case.
Every example was run with the CLI; [Algorithms](../algorithms.md) has the exact rules.

## How pairing works

1. **Equal ids** pair first (`--match id` and the default `auto`).
2. **Replacement links** pair a node with the one that replaces it: OBO `replaced_by` and
   `alt_id`, RDF `IAO:0100001`, `replacedBy` / `replaces` in kgdiff JSON.
3. **Similarity** pairs what is left (`auto`), or everything (`--match similarity`, for graphs
   whose ids change on every run). The score weighs the name most (55%), then the neighbours
   that are already paired (25%), the types (10%) and the attributes (10%). A pair is
   accepted when it reaches `--threshold` (0.82 by default) **and** beats every rival by at
   least 0.05.

Pairing is one to one. A node that is not paired is reported as removed or added. A pair that
came close, scoring between 0.6 and the threshold or tying with a rival, is listed as a
**possible match**: at the end of the terminal and Markdown summaries, and in the viewer's
detail panel.

## Renamed, or removed and added?

Two extraction runs call the same company “Saudi Aramco” and “Aramco”, with fresh ids and the
same four neighbours. The names share only one word, so the pair scores 0.80, just under the
threshold:

```
  Removed 1
  − Removed “Saudi Aramco” and 3 relations   removed · type Organization · was linked to …
  …
  Added 1
  + Added “Aramco” and 3 relations           added · type Organization · linked to …

  Possible matches 1
  ≈ “Saudi Aramco” → “Aramco”   80% · below the 82% threshold · name 67% · neighbours 100%
```

kgdiff does not guess: it reports what it can prove and shows the pair for a reviewer to
decide. Any of these makes it a rename (`~ Renamed “Saudi Aramco” → “Aramco”`):

- the new version keeps the old name as a synonym (`aliases`, `skos:altLabel`, OBO `synonym`);
- a replacement link names the old node;
- a lower `--threshold`, here `0.79`. It applies to every pair, so lower it with care.

## Renamed, or merged?

A rename is a pair whose label changed. A merge needs more than shared neighbours. Either an
explicit replacement link names the target, or two things hold together: the old node's name
nearly equals the target's, or is kept as one of its synonyms, **and** at least half of the old
node's relations now start or end at the target. That evidence must reach a confidence of
0.75; a weaker case is listed for the reviewer instead of reported as a merge.

## Renamed and moved in the same change

With stable ids, a node that changed both its name and its parent is one change:

```
  ~ Renamed “Customer Support” → “Customer Success”   content · moved under “Sales”
```

When the ids are fresh as well, and both the name and the neighbours changed, nothing is left
that says it is the same node, so it is reported as removed and added. Keeping ids stable, or
writing a replacement link, is what keeps such a change readable.

## Same name, different things

When both versions contain an “Apple” company and an “Apple” fruit, types and neighbours keep
them apart: each pairs with its own counterpart, and removing the fruit later does not merge it
into the company.

When each version has a single “Mercury”, a planet before and a chemical element after, the
outcome depends on the ids around them. With `auto`, the nodes whose ids did not change are
paired first, so the neighbours count, the two do not agree, and the pair is only a possible
match. Both sides show their ids because the names are equal:

```
  ≈ “Mercury” (m1) → “Mercury” (x1)   61% · below the 82% threshold · name 100% · neighbours 0%
```

### Limit

With `--match similarity` every node is paired from scratch. In the first round no neighbour is
paired yet, so equal names outweigh different types (10%), and the two “Mercury”s are paired
and reported as one node whose type changed (`~ Edited “Mercury”`, `+1 −1 types`). Read type
changes on renamed or edited nodes with that in mind, and use `auto` or `id` when ids are
stable.

## Symmetric graphs

Where names repeat and the structure is symmetric, several pairings are equally good. kgdiff
refuses to pick one. Six atoms all named “C”, bonded in a ring in one version and as two
triangles in the other, with fresh ids: every candidate pair ties, so none is accepted. The ring
is reported as removed and the two triangles as added, and the tied pairs are listed as
possible matches that are “too close to another candidate”.

## Moves and changes in meaning

- A move in the hierarchy is its own kind of change: _restructured_, in the structure colour,
  listed before the other edits. Renames and attribute edits are _content_. `--hierarchy`
  decides which relations count as the hierarchy (`subClassOf`, `is_a`, `skos:broader`, … by
  default).
- A reworded definition is an attribute change. The viewer shows it as a character-level diff
  in the node's detail panel.
- kgdiff does not judge whether a meaning shifted. It makes such edits visible, and leaves the
  judgement to the reviewer.
