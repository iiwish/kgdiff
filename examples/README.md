# kgdiff examples

Example graph pairs for the demo site, the README screenshots and the end-to-end acceptance tests.
Each dataset is a realistic before / after pair that exercises the semantic changes kgdiff detects
(merges, splits, renames, rekeys, moves, retargets, predicate / type / alias / attribute changes,
deprecations, suggestions) together with a machine-checkable list of what kgdiff must report.

## Datasets

Listed in display order in [`datasets/index.json`](datasets/index.json).

| Dataset                                            | Format             | Nodes (before → after) | What it shows                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`enterprise-kg`](datasets/enterprise-kg/) ★       | kgdiff JSON (中文) | 74 → 74                | Enterprise-credit KG ontology v12 → v13: hinted merge 法人代表 → 法定代表人, domain move, retarget, rename, added / removed concepts, attribute-to-column mapping edits, predicate and type changes |
| [`enterprise-kg-en`](datasets/enterprise-kg-en/) ★ | kgdiff JSON        | 74 → 74                | `enterprise-kg` in English: the same graphs and changes with every text translated (merge Legal person representative → Legal representative, …)                                                    |
| [`ontology-release`](datasets/ontology-release/) ★ | OBO 1.4            | 179 → 184              | Monthly release of a mini disease ontology: obsoletion with `replaced_by` (2 → 1 and 1 → 1 merges), a `consider:` split, renames, `is_a` moves, namespace / synonym / definition / xref edits       |
| [`llm-extraction`](datasets/llm-extraction/) ★     | kgdiff JSON        | 39 → 40                | Two LLM extraction runs with random ids: similarity matching, label variants, a hallucination, new entities, an ambiguous pair left as a suggestion                                                 |
| [`data-lineage`](datasets/data-lineage/)           | kgdiff JSON        | 43 → 44                | dbt lineage refactor: rekeyed model (`stg_orders` → `stg_orders_v2`), model split, removed / new models, dependency retargets, `table` → `incremental`, tag changes                                 |
| [`schema-vocab`](datasets/schema-vocab/)           | Turtle             | 66 → 71                | schema.org-style vocabulary: new intermediate classes, class moves, `owl:deprecated` + `IAO:0100001` replacements, label / comment edits, an OWL existential restriction                            |

★ featured on the demo site. `enterprise-kg` and `enterprise-kg-en` are one dataset in two
languages: the site shows the one in the reader's language, and a test keeps them identical
apart from their texts.

Every dataset folder contains:

| File                  | Content                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `before.*`, `after.*` | the two versions, in the dataset's native format                                                                                                |
| `meta.json`           | `id`, `title` / `description` (`en`, `zh-CN`), `format`, `files`, `versions`, `options` (the `DiffOptions` to diff with), `featured`, `license` |
| `expected.json`       | the changes kgdiff must report, see below                                                                                                       |
| `README.md`           | what the data models and a table of its changes                                                                                                 |

Try one with the CLI (`kgdiff <before> <after>`, see `packages/cli/README.md`):

```sh
kgdiff examples/datasets/enterprise-kg-en/before.json examples/datasets/enterprise-kg-en/after.json
```

## expected.json

The acceptance format is specified by [`datasets/expected.schema.json`](datasets/expected.schema.json).
In short, after `diff(parse(before), parse(after), meta.options)`:

- Ids are **union ids** (docs/algorithms.md §6): the after id of every node present after, the
  before id of removed nodes. Edges are `[source, predicate, target]` triples in union-id space
  (so a removed edge whose endpoint was rekeyed points at the new id).
- `nodes.added / removed / modified` and `edges.added / removed / modified` are exhaustive: every
  other element is unchanged. Edges in `edges.uncertain` depend on a heuristic and are skipped by
  all edge checks.
- Facet lists (`matches`, `rekeys`, `merges`, `splits`, `renames`, `moves`, `deprecations`,
  `replacements`, `typeChanges`, `aliasChanges`, `attrChanges`, `retargets`, `predicateChanges`,
  `edgeAttrChanges`, `collapsed`, `suggestions`) are exhaustive too. Items marked `"heuristic": true` may be missed (warn, do not
  fail). `attrChanges` give exact values for JSON datasets and only the changed keys for OBO /
  RDF, whose value shapes are parser-defined.
- `matches` lists hint and similarity matches. `rekeys` lists `rekey` facets, which exist only
  under strategies `id` / `auto`: with `similarity` ids are meaningless, so a node that differs
  only by its id is unchanged.
- `counts` are the node / edge counts of the parsed versions; `hunks` (enterprise-kg and enterprise-kg-en only) are in
  the default review order of docs/algorithms.md §7.
- `notes` record the parser conventions each file relies on.

All five files were checked against an independent re-implementation of docs/algorithms.md and
against the `@kgdiff/core` + `@kgdiff/formats` sources, including variants of the text-similarity
details (set vs multiset bigrams, stop-word handling) for the similarity-matched datasets.

## Synthetic graphs

[`scripts/gen-synthetic.ts`](../scripts/gen-synthetic.ts) generates larger pairs for benchmarks and
stress tests (output goes to the git-ignored `examples/generated/`):

```sh
pnpm tsx scripts/gen-synthetic.ts --nodes 10000 --seed 7 --out examples/generated/synth-10k
pnpm tsx scripts/gen-synthetic.ts --nodes 2000 --cjk --rates rename=0.1,merge=0.02
pnpm tsx scripts/gen-synthetic.ts --help
```

- Deterministic: same arguments → byte-identical files (seeded mulberry32, one stream per phase,
  so the before graph does not depend on the mutation rates).
- Before graph: a class taxonomy under eight root kinds (`is_a`), entities joining by preferential
  attachment (scale-free degree distribution, ≈ 3 edges per node), syllable or CJK labels,
  attributes and occasional aliases. 10k nodes ≈ 30k edges in well under a second.
- Mutation pass with configurable rates (`--rates`): renames, attribute edits, merges (half with
  removed sources + `replaces`, half with deprecated sources + `replacedBy`), entity and class
  moves, retargets, edge adds / removes, node adds / removes, rekeys and deprecations. Each entity
  takes part in at most one node-level mutation.
- `meta.json` follows the dataset format and adds `generator` (the exact command and rates),
  `counts` and `truth`, the full list of mutations applied.

## License

The example datasets are released under CC0-1.0 (see each `meta.json`). Identifiers, catalogs and
projects are fictional; cross-references to real vocabularies are illustrative.
