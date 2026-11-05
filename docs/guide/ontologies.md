# Ontologies: OBO and OWL

## Formats

kgdiff reads OBO 1.4, and OWL ontologies serialized as RDF: RDF/XML (the `.owl` files Protégé
and ROBOT write by default), Turtle, N-Triples and JSON-LD. OWL/XML, Functional Syntax and
Manchester Syntax are recognised and rejected with a hint. Convert them to RDF/XML or Turtle
first, for example with [ROBOT](https://robot.obolibrary.org):

```sh
robot convert --input onto.owx --output onto.owl
```

## Recommended options

```sh
kgdiff release-1.obo release-2.obo --match id
```

- **`--match id`**: ontology ids (CURIEs, IRIs) are stable by design, so pair terms by id only.
  Obsolete terms still pair with their replacements through `replaced_by` (OBO) or `IAO:0100001`
  (OWL, "term replaced by") and are reported as merges. The default, `auto`, may also pair a
  removed term with a new one by label similarity.
- **`--hierarchy <predicate>`**: the predicates that place a term under a parent, so that a
  changed parent reads "Moved … under …". The defaults are `rdfs:subClassOf`,
  `rdfs:subPropertyOf`, `skos:broader`, `is_a`, `subClassOf` and `parent`. Giving `--hierarchy`
  replaces them; repeat it for several, e.g. `--hierarchy is_a --hierarchy part_of` to read
  partonomy as hierarchy too.
- **`--lang <tags>`** (RDF): which language's label to show when a term has several, e.g.
  `--lang en` or `--lang zh,en`.
- **`--ignore-attr <key>`**: leave out annotations that change in every release (repeatable).
  Keys are OBO tag names such as `creation_date`, or compact predicates such as `dcterms:date`
  in RDF; the detail panel of the report shows them.
- **`--watch-attr <key>`**: changes to definitions are flagged ⚑ for review first, in the
  summary and in pull request comments: `def` in OBO, `IAO:0000115` and `skos:definition` in
  RDF. A reworded definition can change what existing annotations mean. Name other keys to
  watch instead, e.g. `--watch-attr rdfs:comment` for a schema.org-style vocabulary.

## What kgdiff reports

| You edit                                                    | kgdiff reports                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| Obsolete a term with `replaced_by` or `IAO:0100001`         | Merged “old term” into “new term” (identity)                |
| Obsolete a term without a replacement                       | Deprecated “term” (content)                                 |
| Change a term's parent (`is_a`, `rdfs:subClassOf`)          | Moved “term” under “new parent”, from “old parent”          |
| Change a label                                              | Renamed “old label” → “new label” (content)                 |
| Edit synonyms, definitions, cross-references, comments      | Edited “term” or Updated attributes of “term” (content)     |
| Replace a term with several new ones                        | Split “term” into “a” and “b” (identity), with a confidence |
| Add or remove an existential restriction (`part_of some X`) | a relation added, removed or retargeted (structure)         |

The [ontology-release example](../../examples/datasets/ontology-release) shows most of them:

```
  Restructured 7
  ⊕ Merged “juvenile diabetes” and “insulin-dependent d…   identity · via replacement h…
  ⊕ Merged “heart attack” into “myocardial infarction”     identity · via replacement h…
  ⊕ Merged “chronic obstructive airway disease” into “c…   identity · via replacement h…
  ⇄ Moved “Crohn disease” under “inflammatory bowel dis…   structure · from “intestinal…
  ⇄ Moved “Hashimoto thyroiditis” under “autoimmune thy…   structure · from “hypothyroi…
  ⇄ Moved “tuberculosis” under “bacterial infectious di…   structure · from “lung disea…
  ⑂ Split “diabetes insipidus” into “arginine vasopress…   identity · inferred · 80% co…
```

The merges come from `replaced_by`: the obsolete terms are kept as deprecated and their
relations carried over. The split has no `replaced_by` (the obsolete term only says `consider`):
kgdiff infers it because the new terms are named after the old term's synonyms and took over its
relations, and it reports how confident it is. `--no-merges` and `--no-splits` turn the detection
off.

## Limits

kgdiff diffs the graph an ontology describes: terms, labels, synonyms, annotations, the hierarchy
and existential restrictions (`SubClassOf R some C` becomes an edge from the term to `C`). It does
not run a reasoner, and other class expressions (unions, universal restrictions,
equivalent-class definitions) appear as anonymous nodes rather than as readable axioms. To review
logical axioms, use an axiom-level tool such as `robot diff` next to kgdiff.
