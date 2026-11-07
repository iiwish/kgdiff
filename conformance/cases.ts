/**
 * The corpus cases. Each one names its input files (authored under `cases/<id>/`, or copied there
 * from `examples/datasets`), how they are parsed, the diff options and the CLI runs whose output
 * is recorded. `corpus.ts` turns a definition into `case.json` and the expected outputs; the
 * README documents the format for other implementations.
 */
import { readFileSync } from 'node:fs';
import type { DiffOptions, Locale } from '@kgdiff/core';
import type { FormatId } from '@kgdiff/formats';
import type { LayoutOptions } from '@kgdiff/layout';

/** An extra CLI run of a case, beyond the standard ones (see `corpus.ts`). */
export interface ExtraRun {
  readonly name: string;
  /** Appended to the case's diff arguments. */
  readonly flags: readonly string[];
  /** Overrides of the case environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** File name under `expected/cli/`. */
  readonly file: string;
}

/**
 * A CLI run with arguments of its own (paths relative to the case directory), for error paths,
 * stdin and `apply` variants. Its exit code is part of the expectation.
 */
export interface CustomRun {
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** A file of the case directory piped to stdin. */
  readonly stdin?: string;
  readonly exit: number;
  /** File name under `expected/cli/` for stdout; omitted when stdout must be empty. */
  readonly file?: string;
}

export interface CaseDefinition {
  readonly id: string;
  readonly description: string;
  /** Short tags of what the case exercises (free text, for humans and filtering). */
  readonly covers: readonly string[];
  /** Input file names inside the case directory. */
  readonly inputs: { readonly before: string; readonly after: string };
  /** Repository paths the inputs are copied from (example datasets). */
  readonly copiedFrom?: { readonly before: string; readonly after: string };
  /** `--before-format` / `--after-format`; omitted means `auto`. */
  readonly formats?: { readonly before?: FormatId; readonly after?: FormatId };
  /** `--lang`. */
  readonly languages?: readonly string[];
  /** `--allow-empty`. */
  readonly allowEmpty?: boolean;
  /** Diff options; only what the CLI can express (match strategy and threshold, edge identity, hierarchy predicates, ignored attributes, merge / split detection). */
  readonly options: DiffOptions;
  /** CLI-only flags that shape the text outputs (`--watch-attr`, `--limit`). */
  readonly textFlags?: readonly string[];
  /** Locale of the text outputs. */
  readonly locale: Locale;
  /** Options of the layout whose combinatorial part is recorded. */
  readonly layout?: LayoutOptions;
  readonly extraRuns?: readonly ExtraRun[];
  readonly customRuns?: readonly CustomRun[];
  /** Further authored files the custom runs read. */
  readonly extraInputs?: readonly string[];
}

/** A case on an example dataset, diffed with the options its `meta.json` gives. */
const dataset = (
  id: string,
  ext: string,
  locale: Locale,
  description: string,
  covers: readonly string[],
  extra: Partial<CaseDefinition> = {},
): CaseDefinition => {
  const meta = JSON.parse(
    readFileSync(new URL(`../examples/datasets/${id}/meta.json`, import.meta.url), 'utf8'),
  ) as { files: { before: string; after: string }; options?: DiffOptions };
  if (meta.files.before !== `before.${ext}` || meta.files.after !== `after.${ext}`) {
    throw new Error(`examples/datasets/${id}: unexpected file names`);
  }
  return {
    id: `dataset-${id}`,
    description,
    covers: ['dataset', ...covers],
    inputs: { before: `before.${ext}`, after: `after.${ext}` },
    copiedFrom: {
      before: `examples/datasets/${id}/before.${ext}`,
      after: `examples/datasets/${id}/after.${ext}`,
    },
    options: meta.options ?? {},
    locale,
    ...extra,
  };
};

export const CASES: readonly CaseDefinition[] = [
  dataset(
    'enterprise-kg',
    'json',
    'zh-CN',
    'The enterprise-credit KG ontology v12 → v13 (examples/datasets/enterprise-kg), in Chinese.',
    ['kgdiff-json', 'zh-CN', 'merge:hint', 'move', 'retarget', 'rename', 'predicate', 'types'],
    {
      extraRuns: [
        { name: 'summary-en', flags: ['--locale', 'en'], file: 'summary.en.txt' },
        { name: 'markdown-en', flags: ['--locale', 'en', '--markdown'], file: 'summary.en.md' },
      ],
    },
  ),
  dataset(
    'enterprise-kg-en',
    'json',
    'en',
    'The same ontology with every text in English (examples/datasets/enterprise-kg-en).',
    ['kgdiff-json', 'merge:hint', 'move', 'retarget', 'rename'],
  ),
  dataset(
    'ontology-release',
    'obo',
    'en',
    'A monthly OBO release of a mini disease ontology (examples/datasets/ontology-release).',
    ['obo', 'match:id', 'merge:replaced_by', 'split', 'deprecate', 'move', 'synonyms', 'xrefs'],
  ),
  dataset(
    'llm-extraction',
    'json',
    'en',
    'Two LLM extraction runs with random ids, aligned by similarity (examples/datasets/llm-extraction).',
    ['kgdiff-json', 'match:similarity', 'suggestions', 'label-variants'],
  ),
  dataset(
    'data-lineage',
    'json',
    'en',
    'A dbt lineage refactor: rekey, split, retargets (examples/datasets/data-lineage).',
    ['kgdiff-json', 'match:auto', 'rekey', 'split', 'retarget', 'attrs'],
  ),
  dataset(
    'schema-vocab',
    'ttl',
    'en',
    'A schema.org-style vocabulary in Turtle with deprecations (examples/datasets/schema-vocab).',
    ['turtle', 'match:id', 'deprecate', 'replacement', 'owl-restriction', 'move'],
  ),
  {
    id: 'match-id-hints',
    description:
      'A semantic-layer skeleton → enriched export matched by id: 1:1 rekeys through `replaces`, a merge of two hinted sources, a split of one source into two hinted targets, a deprecation with `replacedBy`, a move, a rename, a watched definition change and a self-loop that is rekeyed.',
    covers: [
      'kgdiff-json',
      'match:id',
      'hint:replaces',
      'hint:replacedBy',
      'rekey',
      'merge:hint',
      'split:hint',
      'deprecate',
      'move',
      'rename',
      'self-loop',
      'retarget:merge',
      'watch',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'id' }, hierarchyPredicates: ['subClassOf'] },
    locale: 'en',
    extraRuns: [
      { name: 'summary-zh', flags: ['--locale', 'zh-CN'], file: 'summary.zh-CN.txt' },
      { name: 'markdown-zh', flags: ['--locale', 'zh-CN', '--markdown'], file: 'summary.zh-CN.md' },
    ],
    customRuns: [
      {
        name: 'summary-stdin',
        args: [
          '-',
          'after.json',
          '--match',
          'id',
          '--hierarchy',
          'subClassOf',
          '--locale',
          'en',
          '--color',
          'never',
        ],
        stdin: 'before.json',
        exit: 0,
        file: 'summary.stdin.txt',
      },
      {
        name: 'apply-stdin',
        args: ['apply', '-', 'expected/delta.json', '--color', 'never'],
        stdin: 'before.json',
        exit: 0,
        file: 'apply.stdin.json',
      },
    ],
  },
  {
    id: 'match-auto-heuristics',
    description:
      'Matching by id, then similarity, with no hints: a heuristic merge (synonym and edge carry-over) with collapsed edges, a heuristic split by synonyms, a move under a new class, a retarget, a predicate change, a rename, type and alias changes, an edge attribute change, a deprecation, additions, removals and a below-threshold suggestion.',
    covers: [
      'kgdiff-json',
      'match:auto',
      'merge:heuristic',
      'collapsed',
      'split:heuristic',
      'move',
      'retarget',
      'predicate',
      'rename',
      'types',
      'aliases',
      'edge-attrs',
      'deprecate',
      'suggestions',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'auto' }, hierarchyPredicates: ['is_a'] },
    locale: 'en',
  },
  {
    id: 'self-loops',
    description:
      'Self-loops in every role: unchanged, removed, added, retargeted to another node, relabelled, with changed attributes, parallel self-loops, a self-loop on a renamed node and one carried by a merge.',
    covers: ['kgdiff-json', 'self-loop', 'parallel-edges', 'retarget', 'edge-label', 'merge:hint'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'auto' } },
    locale: 'en',
  },
  {
    id: 'unicode-text',
    description:
      'Ids and labels outside the Basic Multilingual Plane, private-use and fullwidth characters (UTF-16 vs code point order), NFC / NFD and NFKC equivalence, final sigma, emoji sequences, CJK, bidi and control characters that the terminal and Markdown must neutralize, and narrow terminals.',
    covers: [
      'kgdiff-json',
      'astral',
      'utf16-order',
      'nfc',
      'nfkc',
      'case-folding',
      'emoji',
      'cjk',
      'bidi',
      'controls',
      'width',
      'truncation',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'auto' } },
    locale: 'en',
    extraRuns: [
      { name: 'summary-40', flags: [], env: { COLUMNS: '40' }, file: 'summary.40.txt' },
      {
        name: 'summary-zh-60',
        flags: ['--locale', 'zh-CN'],
        env: { COLUMNS: '60' },
        file: 'summary.zh-CN.60.txt',
      },
      { name: 'markdown-zh', flags: ['--locale', 'zh-CN', '--markdown'], file: 'summary.zh-CN.md' },
    ],
  },
  {
    id: 'json-numbers-and-keys',
    description:
      'Attribute values that JavaScript and Rust print differently (1e21, 1e-7, 0.000001, -0, 1.0, 2^53 + 1, values beyond the double range, the shortest round-trip digits), integer-like object keys that JavaScript lists first, duplicate keys, `__proto__`, nested objects and arrays, numbers and integer-like keys in `meta`.',
    covers: [
      'kgdiff-json',
      'numbers',
      'key-order',
      'duplicate-keys',
      '__proto__',
      'nested-values',
      'meta',
      'pretty',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'id' } },
    locale: 'en',
    extraRuns: [{ name: 'json-pretty', flags: ['--json', '--pretty'], file: 'diff.pretty.json' }],
  },
  {
    id: 'dangling-and-duplicates',
    description:
      'Loose JSON input: numeric ids (10, 2, 1.0, 1e21), duplicate node declarations merged by canonical JSON, an empty id, dangling edge endpoints that become implicit nodes, identical and distinct parallel edges.',
    covers: [
      'json',
      'numeric-ids',
      'duplicate-node',
      'empty-id',
      'dangling-edge',
      'implicit',
      'parallel-edges',
      'issues',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'auto' } },
    locale: 'en',
  },
  {
    id: 'edge-identity-id',
    description:
      'Edges identified by their ids (`--edge-identity id`): an edge that keeps its id while its target and its predicate change, a label change, an attribute change, edges without ids, an id that looks like a structural key and a repeated edge id.',
    covers: [
      'kgdiff-json',
      'edge-identity:id',
      'retarget',
      'predicate',
      'edge-label',
      'edge-attrs',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'auto' }, edgeIdentity: 'id' },
    locale: 'en',
  },
  {
    id: 'options-ignore-watch',
    description:
      'Every CLI-expressible diff option at once: a custom hierarchy predicate, ignored attributes, merge and split detection off, a stricter threshold, plus watched attributes in the text outputs.',
    covers: [
      'kgdiff-json',
      'hierarchy',
      'ignore-attr',
      'no-merges',
      'no-splits',
      'threshold',
      'watch-attr',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    options: {
      match: { strategy: 'auto', threshold: 0.9 },
      hierarchyPredicates: ['broader'],
      ignoreAttrs: ['updated_at', 'etag'],
      detectMerges: false,
      detectSplits: false,
    },
    textFlags: ['--watch-attr', 'definition', '--watch-attr', 'rdfs:comment'],
    locale: 'en',
  },
  {
    id: 'identical',
    description:
      'The same graph twice, with nodes, edges, attribute keys and set members in another order and a label in another normalization form: no change, an empty delta, exit code 0 with --exit-code.',
    covers: ['kgdiff-json', 'identical', 'order-independence', 'nfc', 'exit-code'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: {},
    locale: 'en',
  },
  {
    id: 'empty-before',
    description: 'A first release: an empty before file read with --allow-empty.',
    covers: ['allow-empty', 'add'],
    inputs: { before: 'before.json', after: 'after.json' },
    allowEmpty: true,
    options: {},
    locale: 'en',
  },
  {
    id: 'similarity-rekey-preamble',
    description:
      'Random ids that change between runs, matched by similarity: nodes that differ only by id are unchanged, so the diff is identical while the delta renames them in its preamble, two of them in a cycle through a temporary id.',
    covers: ['kgdiff-json', 'match:similarity', 'rekey-preamble', 'rekey-cycle', 'identical'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'similarity' } },
    locale: 'en',
  },
  {
    id: 'rdf-turtle-ntriples',
    description:
      'Turtle before, N-Triples after: typed literals (integer, decimal, double, boolean, an unsafe integer, an ill-formed integer), language-tagged labels with a language preference, synonyms, blank nodes, an OWL existential restriction, owl:deprecated with IAO:0100001.',
    covers: [
      'turtle',
      'ntriples',
      'typed-literals',
      'languages',
      'blank-nodes',
      'owl-restriction',
      'deprecate',
      'cross-format',
    ],
    inputs: { before: 'before.ttl', after: 'after.nt' },
    languages: ['zh', 'en'],
    options: { match: { strategy: 'id' } },
    locale: 'en',
  },
  {
    id: 'rdf-nquads-trig',
    description:
      'N-Quads before, TriG after: named graphs merged (with a warning), repeated triples counted once.',
    covers: ['nquads', 'trig', 'named-graphs', 'warnings', 'cross-format'],
    inputs: { before: 'before.nq', after: 'after.trig' },
    options: { match: { strategy: 'id' } },
    locale: 'en',
  },
  {
    id: 'rdf-xml',
    description:
      'Protégé-style RDF/XML: DTD entities, xml:base, rdf:ID and rdf:nodeID, xml:lang, an XML literal, an rdf:parseType Collection, an OWL restriction and an owl:Axiom annotation folded into its edge.',
    covers: [
      'rdfxml',
      'dtd-entities',
      'xml-base',
      'xml-literal',
      'collection',
      'owl-restriction',
      'annotations',
    ],
    inputs: { before: 'before.owl', after: 'after.rdf' },
    options: { match: { strategy: 'id' } },
    locale: 'en',
  },
  {
    id: 'jsonld',
    description:
      'JSON-LD 1.1 with an inline context (@vocab, typed terms, @json, @reverse, language maps), native numbers that become xsd:integer / xsd:double literals, and an after file that is JSON-LD under a .json name.',
    covers: ['jsonld', 'json-ld-detection', 'json-literal', 'reverse', 'numbers', 'languages'],
    inputs: { before: 'before.jsonld', after: 'after.json' },
    options: { match: { strategy: 'id' } },
    locale: 'en',
  },
  {
    id: 'obo-variants',
    description:
      'OBO 1.4 with CRLF line endings before: header tags, synonyms, relationships, xrefs, alt_id (a rekey), is_obsolete with replaced_by (a merge), a typedef name, an instance, and the lenient cases that warn (unknown stanza, several names, unquoted def, a tag without value, duplicate stanzas).',
    covers: [
      'obo',
      'crlf',
      'alt_id',
      'replaced_by',
      'typedef',
      'instance',
      'warnings',
      'merge:replaced_by',
      'watch',
    ],
    inputs: { before: 'before.obo', after: 'after.obo' },
    options: { match: { strategy: 'id' }, hierarchyPredicates: ['is_a'] },
    locale: 'en',
  },
  {
    id: 'json-dialects-a',
    description:
      'Cytoscape.js JSON before (a compound parent becomes a `parent` edge; positions, classes and selection are dropped with a warning), d3 / NetworkX node-link after.',
    covers: ['json', 'cytoscape', 'd3', 'ignored-fields', 'compound-parent'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'id' } },
    locale: 'en',
  },
  {
    id: 'json-dialects-b',
    description: 'AntV G6 v5 JSON (with combos and styles) before, graphology after.',
    covers: ['json', 'g6', 'graphology', 'ignored-fields', 'self-loop'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'id' } },
    locale: 'en',
  },
  {
    id: 'json-dialects-c',
    description:
      'vis-network JSON with numeric ids before, kgdiff JSON with its format marker, node positions (an anchored layout) and a replacement after.',
    covers: ['json', 'vis', 'kgdiff-json', 'numeric-ids', 'positions', 'layout:anchored', 'rekey'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'auto' } },
    locale: 'en',
  },
  {
    id: 'encodings',
    description:
      'Input decoding: UTF-16LE with a byte order mark and CRLF line endings before, gzip-compressed UTF-8 with a byte order mark after.',
    covers: ['utf-16', 'bom', 'crlf', 'gzip'],
    inputs: { before: 'before.json', after: 'after.json.gz' },
    options: {},
    locale: 'en',
  },
  {
    id: 'synthetic-600',
    description:
      'A 600-node synthetic pair with CJK labels from `pnpm tsx scripts/gen-synthetic.ts --nodes 600 --seed 7 --cjk` (inputs committed as generated): merges, moves, retargets, rekeys and deprecations at scale; the layout record covers a changes-only scope.',
    covers: ['kgdiff-json', 'synthetic', 'cjk', 'scale', 'layout:changes'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: { match: { strategy: 'auto' } },
    locale: 'zh-CN',
    layout: { scope: 'changes' },
  },
  {
    id: 'encodings-be',
    description:
      'Input decoding, the other way round: UTF-16BE with a byte order mark before, UTF-8 with a byte order mark and CRLF line endings after.',
    covers: ['utf-16be', 'bom', 'crlf'],
    inputs: { before: 'before.json', after: 'after.json' },
    options: {},
    locale: 'en',
  },
  {
    id: 'cli-errors',
    description:
      "kgdiff's own error paths, with their messages and exit codes: invalid JSON at a character outside the BMP (the message quotes one UTF-16 unit), an OBO line clipped in the middle of a surrogate pair, an unreadable format, an empty input, a missing file, the input size limit (a size printed with toFixed), usage errors, a diff given where a graph is expected, and apply on the wrong base, strict and lenient.",
    covers: [
      'errors',
      'exit-codes',
      'usage',
      'utf16-units',
      'toFixed',
      'apply:mismatch',
      'apply:lenient',
    ],
    inputs: { before: 'before.json', after: 'after.json' },
    extraInputs: ['bad-astral.json', 'bad-line.obo', 'garbage.txt', 'empty.json'],
    options: {},
    locale: 'en',
    customRuns: [
      {
        name: 'invalid-json-astral',
        args: ['bad-astral.json', 'after.json', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'obo-clipped-line',
        args: ['bad-line.obo', 'after.json', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'undetectable-format',
        args: ['garbage.txt', 'after.json', '--color', 'never'],
        exit: 2,
      },
      { name: 'empty-input', args: ['empty.json', 'after.json', '--color', 'never'], exit: 2 },
      { name: 'missing-file', args: ['missing.json', 'after.json', '--color', 'never'], exit: 2 },
      {
        name: 'input-size-limit',
        args: ['before.json', 'after.json', '--color', 'never'],
        env: { KGDIFF_MAX_INPUT: '1280' },
        exit: 2,
      },
      {
        name: 'unknown-format-flag',
        args: ['before.json', 'after.json', '--format', 'nope', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'threshold-out-of-range',
        args: ['before.json', 'after.json', '--threshold', '2', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'two-outputs-on-stdout',
        args: ['before.json', 'after.json', '--json', '--delta', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'unknown-option',
        args: ['before.json', 'after.json', '--frobnicate', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'diff-given-as-graph',
        args: ['expected/diff.json', 'after.json', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'apply-wrong-base',
        args: ['apply', 'after.json', 'expected/delta.json', '--color', 'never'],
        exit: 2,
      },
      {
        name: 'apply-lenient',
        args: [
          'apply',
          'after.json',
          'expected/delta.json',
          '--no-strict',
          '--verbose',
          '--color',
          'never',
        ],
        exit: 0,
        file: 'apply.lenient.json',
      },
    ],
  },
];
