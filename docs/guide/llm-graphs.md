# Graphs without stable ids

LLM extraction pipelines, GraphRAG and the like, usually mint new ids on every run. Diffing two
runs by id then reports every node as removed and re-added, which tells you nothing.

The [llm-extraction example](../../examples/datasets/llm-extraction) holds two runs of an extractor
over the same article. Compare the three matching strategies on it:

| `--match`        | Result                 | Why                                                           |
| ---------------- | ---------------------- | ------------------------------------------------------------- |
| `id`             | 193 changes in 2 hunks | No id is shared: every node removed, every node added         |
| `auto` (default) | 58 changes in 42 hunks | Nodes pair up by similarity, but each pair reports its new id |
| `similarity`     | 45 changes in 30 hunks | Ids are ignored: what remains is what the runs disagree on    |

So when ids carry no meaning, match by similarity:

```sh
kgdiff run-a.json run-b.json --match similarity
```

```
kgdiff  curie-extraction run-a → run-b                     39 → 40 nodes · 55 → 59 edges

  +3 added   −2 removed   ~24 modified   ⇄1 restructured          45 changes in 30 hunks
  +++++++++−−−−−~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~⇄

  Removed 2
  − Removed “Albert Einstein” and 1 relation               removed · type Person · was…
  − Removed “pitchblende” and 2 relations                  removed · type Mineral · was…
  Restructured 1
  ⇄ Removed “Pierre Curie” —discovered→ “Thorium”          structure · relation removed
  Modified 24
  ~ Renamed “Marie Curie” → “Marie Skłodowska-Curie”       content · ~1 attribute · +2…
  ~ Renamed “polonium (Po)” → “Polonium”                   content
  ~ Renamed “uranic rays” → “Becquerel rays”               content · +2 synonyms
  …
  Added 3
  + Added “uraninite (pitchblende)” and 2 relations        added · type Mineral · linke…
  + Added “French Academy of Sciences” and 2 relations     added · type Organization ·…
  + Added “Gustave Bémont” and 2 relations                 added · type Person · linked…
```

“Albert Einstein” is a hallucination the second run dropped; the renames are spellings of the
same entities; “French Academy of Sciences” and “Gustave Bémont” are entities only the second run
found.

## How similarity matching works

kgdiff compares each unmatched node with likely candidates in the other version. The score
weighs the labels most (aliases count too), then the neighbourhood (how many of the node's
already matched neighbours agree), then types and attributes. A pair matches when it scores at
least the threshold and clearly beats every rival; [Algorithms](../algorithms.md) gives the
exact procedure.

- **`--threshold <n>`** (default 0.82): lower it to pair more variants, at the risk of pairing
  different entities; raise it to pair only near-identical labels.
- **Near misses become suggestions.** A pair below the threshold but above 0.6, or one that ties
  with a rival, is not matched. The terminal summary and the Markdown summary list it under
  _Possible matches_, and the viewer in the node's detail panel. Above, “pitchblende” and
  “uraninite (pitchblende)” are such a pair:

  ```
    Possible matches 1
    ≈ “pitchblende” → “uraninite (pitchblende)”   72% · below the 82% threshold · name 69% · neighbours 55%
  ```

  [How kgdiff tells changes apart](./matching.md) has more examples.
- **Edges are identified by structure**, that is by source, predicate and target
  (`--edge-identity structure`, the default), so random edge ids do not matter. Use
  `--edge-identity id` when edge ids are meaningful.

## Volatile attributes

Extractors often attach values that change on every run: confidence scores, chunk ids,
timestamps. Ignore them so that they do not show up as changes:

```sh
kgdiff run-a.json run-b.json --match similarity --ignore-attr confidence --ignore-attr chunk_id
```

## Property graph formats

kgdiff reads the JSON most graph libraries export: kgdiff's own format, d3 and NetworkX
node-link data, Cytoscape.js, AntV G6 v5, graphology and vis-network. [Formats](../formats.md)
lists the fields it maps. From Python with NetworkX:

```python
import json

import networkx as nx

with open("run-a.json", "w") as f:
    json.dump(nx.node_link_data(graph), f)
```
