# FAQ

## Does kgdiff upload my data?

No. The CLI runs on your machine, and the playground and the viewer compute in your browser.
kgdiff does not fetch anything either: remote JSON-LD contexts are refused and external entities
in RDF/XML are never loaded. Reports are single files that work offline.

## How large can my graphs be?

The diff engine handles graphs with hundreds of thousands of nodes: the budget for 100,000 nodes
and 300,000 edges with exact ids is under 2 seconds. Memory grows with the size of the graphs and
with how much changed; expect several gigabytes around a million triples, with the HTML report
needing the most. For very large graphs, `--stat` and `--markdown` are the lightest outputs, and
the viewer opens with Changes only on. [Architecture: budgets](./architecture.md#budgets) lists the
targets.

## Why is a change reported as a merge or a move rather than as removed and added?

Because kgdiff matched the nodes across versions and classified what happened to them. If it
paired nodes you consider different, use `--match id` to pair by id only, raise `--threshold`,
or turn off merge and split detection with `--no-merges` and `--no-splits`.

## Why didn't kgdiff pair two nodes I consider the same?

Their similarity was below the threshold (0.82 by default), or another candidate was about as
likely. Such near misses are listed as possible matches: at the end of the terminal summary and
of the Markdown summary (so in pull request comments too), and in the viewer's detail panel.
Lower `--threshold`, add the old name as a synonym, or state the pairing explicitly with a
replacement link (`replaced_by` in OBO, `IAO:0100001` in RDF, `replacedBy` in kgdiff JSON).
[How kgdiff tells changes apart](./guide/matching.md) walks through examples, and [Graphs
without stable ids](./guide/llm-graphs.md) explains the scoring.

## Is the output deterministic?

Yes. The same inputs and options give byte-identical diffs, deltas and layouts. HTML reports
include a timestamp unless you pass `--reproducible`.

## Can kgdiff diff OWL axioms?

kgdiff diffs the graph an ontology describes, existential restrictions included, but it does not
reason, and other class expressions appear as anonymous nodes. For axiom-level review, use a tool
such as `robot diff` alongside it. See [Ontologies](./guide/ontologies.md#limits).

## How do I ignore attributes that always change?

`--ignore-attr <key>`, repeated for each key. Ignored attributes are still shown in the details
but never count as changes.

## Which languages does kgdiff speak?

English and Chinese: `--locale zh-CN` for the CLI and the reports, the `locale` attribute for the
viewer. By default the CLI follows `LANG` and the viewer the browser's language.

## How does kgdiff compare with other tools?

Text diffs compare serializations; ontology tools such as ROBOT diff list changed axioms as text.
kgdiff matches nodes, names the changes (merges, splits, moves, renames) and shows both versions
on one stable map for review. The [comparison on the home page](/#compare) goes into more detail.

## Can kgdiff show a single graph?

No. kgdiff always compares two versions, and its colors mean change, so a graph on its own would
be drawn all in gray. To explore one graph, use a graph visualization library: [Browse a graph
with G6](./guide/g6.md) reads any file kgdiff reads and draws it with AntV G6. While you review a
diff, the viewer already lets you look around: search the whole graph with `/`, click an
unchanged node to see its details, and widen the context in Changes only.

## What does kgdiff need?

Node.js 22 or later for the CLI and the libraries in Node, and an evergreen browser for the
viewer.
