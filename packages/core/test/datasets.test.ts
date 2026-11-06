/**
 * Runs the example datasets (examples/datasets/*) through `diff` — JSON directly, OBO and
 * Turtle through `@kgdiff/formats` — and checks the expectations of their `expected.json`
 * (schema: examples/datasets/expected.schema.json). Lists are exhaustive; edges listed under
 * `edges.uncertain` and items marked `heuristic` are not enforced.
 */
import { readFileSync } from 'node:fs';
import {
  type DiffOptions,
  type DiffResult,
  diff,
  type GraphInput,
  type UnionEdge,
} from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';
import { describe, expect, it } from 'vitest';

type Triple = [string, string, string];

interface Expected {
  readonly nodes: Record<'added' | 'removed' | 'modified', string[]>;
  readonly edges: Record<'added' | 'removed' | 'modified', Triple[]> & {
    readonly uncertain?: Triple[];
  };
  readonly counts?: {
    before: { nodes: number; edges: number };
    after: { nodes: number; edges: number };
  };
  readonly matches?: { before: string; after: string }[];
  readonly rekeys?: { from: string; to: string }[];
  readonly merges?: { target: string; sources: string[]; via: string; heuristic?: boolean }[];
  readonly splits?: { source: string; targets: string[]; via: string; heuristic?: boolean }[];
  readonly renames?: { id: string; from: string; to: string }[];
  readonly moves?: { id: string; predicate: string; from: string[]; to: string[] }[];
  readonly deprecations?: { id: string; deprecated: boolean }[];
  readonly replacements?: {
    id: string;
    replaces: { added: string[]; removed: string[] };
    replacedBy: { added: string[]; removed: string[] };
  }[];
  readonly typeChanges?: { id: string; added: string[]; removed: string[] }[];
  readonly aliasChanges?: { id: string; added: string[]; removed: string[] }[];
  readonly attrChanges?: { id: string; keys?: string[]; changes?: { key: string }[] }[];
  readonly retargets?: { edge: Triple; end: string; from: string; to: string; cause: string }[];
  readonly predicateChanges?: { edge: Triple; from: string; to: string }[];
  readonly collapsed?: { edge: Triple; into: Triple }[];
  readonly edgeAttrChanges?: { edge: Triple; changes: { key: string }[] }[];
  readonly suggestions?: { before: string; after: string; reason: string }[];
  readonly hunks?: { id: string; kind: string; phase: string; anchor: string }[];
}

const root = new URL('../../../examples/datasets/', import.meta.url);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as T;

const triple = (e: UnionEdge): string => JSON.stringify([e.source, e.predicate, e.target]);
const sorted = (values: Iterable<string>): string[] => [...values].sort();

const DATASETS = [
  'enterprise-kg',
  'enterprise-kg-en',
  'llm-extraction',
  'data-lineage',
  'ontology-release',
  'schema-vocab',
];

interface Meta {
  readonly options: DiffOptions;
  readonly files: { readonly before: string; readonly after: string };
}

function load(dataset: string, file: string): GraphInput {
  if (file.endsWith('.json')) return read<GraphInput>(`${dataset}/${file}`);
  return parseGraph(readFileSync(new URL(`${dataset}/${file}`, root), 'utf8'), { filename: file })
    .graph;
}

describe.each(DATASETS)('example dataset %s', (dataset) => {
  const meta = read<Meta>(`${dataset}/meta.json`);
  const expected = read<Expected>(`${dataset}/expected.json`);
  const d: DiffResult = diff(
    load(dataset, meta.files.before),
    load(dataset, meta.files.after),
    meta.options,
  );
  const uncertain = new Set((expected.edges.uncertain ?? []).map((t) => JSON.stringify(t)));
  const certain = (triples: readonly Triple[]): string[] =>
    sorted(triples.map((t) => JSON.stringify(t)).filter((t) => !uncertain.has(t)));
  const nodeFacets = <K extends string>(kind: K) =>
    d.nodes.flatMap((n) =>
      n.facets.filter((f) => f.kind === kind).map((f) => ({ node: n, facet: f })),
    );
  const edgeFacets = <K extends string>(kind: K) =>
    d.edges
      .filter((e) => !uncertain.has(triple(e)))
      .flatMap((e) => e.facets.filter((f) => f.kind === kind).map((f) => ({ edge: e, facet: f })));

  it('parses to the expected sizes', () => {
    if (expected.counts)
      expect({ before: d.stats.before, after: d.stats.after }).toEqual(expected.counts);
  });

  it('classifies nodes', () => {
    for (const status of ['added', 'removed', 'modified'] as const) {
      expect(sorted(d.nodes.filter((n) => n.status === status).map((n) => n.id)), status).toEqual(
        sorted(expected.nodes[status]),
      );
    }
  });

  it('classifies edges', () => {
    for (const status of ['added', 'removed', 'modified'] as const) {
      const got = sorted(
        d.edges
          .filter((e) => e.status === status)
          .map(triple)
          .filter((t) => !uncertain.has(t)),
      );
      expect(got, status).toEqual(certain(expected.edges[status]));
    }
  });

  it('matches, merges and splits as expected', () => {
    if (expected.matches) {
      expect(sorted(d.matches.map((m) => `${m.before}→${m.after}`))).toEqual(
        sorted(expected.matches.map((m) => `${m.before}→${m.after}`)),
      );
    }
    const merges = nodeFacets('mergeTarget').map(({ node, facet }) => {
      const sources = facet.kind === 'mergeTarget' ? facet.sources : [];
      const via = d.index.node(sources[0] ?? '')?.facets.find((f) => f.kind === 'mergedInto');
      return `${node.id} ← ${sources.join(', ')} (${via?.kind === 'mergedInto' ? via.via : '?'})`;
    });
    for (const m of expected.merges ?? []) {
      const want = `${m.target} ← ${[...m.sources].sort().join(', ')} (${m.via})`;
      if (!m.heuristic || merges.includes(want)) expect(merges).toContain(want);
    }
    expect(merges.length).toBeLessThanOrEqual(expected.merges?.length ?? 0);
    const splits = nodeFacets('splitInto').map(({ node, facet }) =>
      facet.kind === 'splitInto' ? `${node.id} → ${facet.targets.join(', ')}` : '',
    );
    for (const s of expected.splits ?? []) {
      const want = `${s.source} → ${[...s.targets].sort().join(', ')}`;
      if (!s.heuristic || splits.includes(want)) expect(splits).toContain(want);
    }
    expect(splits.length).toBeLessThanOrEqual(expected.splits?.length ?? 0);
  });

  it('reports the expected node facets', () => {
    const facts = (kind: string, format: (f: Record<string, unknown>, id: string) => string) =>
      sorted(
        nodeFacets(kind).map(({ node, facet }) =>
          format(facet as unknown as Record<string, unknown>, node.id),
        ),
      );
    if (expected.renames) {
      expect(facts('rename', (f, id) => `${id}: ${f.from} → ${f.to}`)).toEqual(
        sorted(expected.renames.map((r) => `${r.id}: ${r.from} → ${r.to}`)),
      );
    }
    if (expected.rekeys) {
      expect(facts('rekey', (f) => `${f.from} → ${f.to}`)).toEqual(
        sorted(expected.rekeys.map((r) => `${r.from} → ${r.to}`)),
      );
    }
    if (expected.moves) {
      expect(facts('move', (f, id) => `${id} ${f.predicate}: ${f.from} → ${f.to}`)).toEqual(
        sorted(expected.moves.map((m) => `${m.id} ${m.predicate}: ${m.from} → ${m.to}`)),
      );
    }
    if (expected.deprecations) {
      expect(facts('deprecate', (f, id) => `${id}: ${f.deprecated}`)).toEqual(
        sorted(expected.deprecations.map((x) => `${x.id}: ${x.deprecated}`)),
      );
    }
    if (expected.replacements) {
      const side = (c: unknown): string => {
        const { added, removed } = c as { added: string[]; removed: string[] };
        return `+${added} −${removed}`;
      };
      expect(
        facts('replacement', (f, id) => `${id}: ${side(f.replaces)} | ${side(f.replacedBy)}`),
      ).toEqual(
        sorted(
          expected.replacements.map((r) => `${r.id}: ${side(r.replaces)} | ${side(r.replacedBy)}`),
        ),
      );
    }
    for (const [kind, list] of [
      ['types', expected.typeChanges],
      ['aliases', expected.aliasChanges],
    ] as const) {
      if (!list) continue;
      expect(
        facts(kind, (f, id) => `${id}: +${f.added} −${f.removed}`),
        kind,
      ).toEqual(sorted(list.map((c) => `${c.id}: +${c.added} −${c.removed}`)));
    }
    if (expected.attrChanges) {
      const keysOf = (changes: unknown): string =>
        (changes as { key: string }[]).map((c) => c.key).join(', ');
      expect(facts('attrs', (f, id) => `${id}: ${keysOf(f.changes)}`)).toEqual(
        sorted(
          expected.attrChanges.map(
            (c) => `${c.id}: ${(c.keys ?? c.changes?.map((x) => x.key) ?? []).join(', ')}`,
          ),
        ),
      );
    }
  });

  it('reports the expected edge facets', () => {
    if (expected.retargets) {
      const got = edgeFacets('retarget').map(({ edge, facet }) =>
        facet.kind === 'retarget'
          ? `${triple(edge)} ${facet.end}: ${facet.from} → ${facet.to} (${facet.cause})`
          : '',
      );
      const want = expected.retargets
        .filter((r) => !uncertain.has(JSON.stringify(r.edge)))
        .map((r) => `${JSON.stringify(r.edge)} ${r.end}: ${r.from} → ${r.to} (${r.cause})`);
      expect(sorted(got)).toEqual(sorted(want));
    }
    if (expected.predicateChanges) {
      const got = edgeFacets('predicate').map(({ edge, facet }) =>
        facet.kind === 'predicate' ? `${triple(edge)}: ${facet.from} → ${facet.to}` : '',
      );
      expect(sorted(got)).toEqual(
        sorted(
          expected.predicateChanges.map((p) => `${JSON.stringify(p.edge)}: ${p.from} → ${p.to}`),
        ),
      );
    }
    if (expected.collapsed) {
      const got = edgeFacets('collapsed').map(({ edge, facet }) => {
        const into = facet.kind === 'collapsed' ? d.index.edge(facet.into) : undefined;
        return `${triple(edge)} → ${into ? triple(into) : '?'}`;
      });
      expect(sorted(got)).toEqual(
        sorted(
          expected.collapsed.map((c) => `${JSON.stringify(c.edge)} → ${JSON.stringify(c.into)}`),
        ),
      );
    }
  });

  it('reports the expected edge attribute changes', () => {
    if (!expected.edgeAttrChanges) return;
    const got = edgeFacets('attrs').map(({ edge, facet }) =>
      facet.kind === 'attrs'
        ? `${triple(edge)}: ${facet.changes.map((c) => c.key).join(', ')}`
        : '',
    );
    expect(sorted(got)).toEqual(
      sorted(
        expected.edgeAttrChanges.map(
          (c) => `${JSON.stringify(c.edge)}: ${c.changes.map((x) => x.key).join(', ')}`,
        ),
      ),
    );
  });

  it('suggests and orders hunks as expected', () => {
    if (expected.suggestions) {
      expect(sorted(d.suggestions.map((s) => `${s.before} ~ ${s.after} (${s.reason})`))).toEqual(
        sorted(expected.suggestions.map((s) => `${s.before} ~ ${s.after} (${s.reason})`)),
      );
    }
    if (expected.hunks) {
      expect(
        d.hunks.map((h) => ({ id: h.id, kind: h.kind, phase: h.phase, anchor: h.anchor })),
      ).toEqual(expected.hunks);
    }
  });
});

/**
 * enterprise-kg-en is enterprise-kg in English: the same ids, edges, flags and column mappings,
 * with every text translated one for one, so both report the same changes. Editing one of the
 * two without the other fails here.
 */
describe('enterprise-kg-en translates enterprise-kg', () => {
  interface Node {
    readonly id: string;
    readonly label?: string;
    readonly type?: string | string[];
    readonly aliases?: string[];
    readonly attrs?: Record<string, unknown>;
    readonly [key: string]: unknown;
  }
  interface Edge {
    readonly source: string;
    readonly predicate: string;
    readonly target: string;
    readonly label?: string;
  }
  interface Graph {
    readonly nodes: Node[];
    readonly edges: Edge[];
  }
  const graphs = (id: string): Graph[] =>
    ['before.json', 'after.json'].map((f) => read<Graph>(`${id}/${f}`));
  const zh = graphs('enterprise-kg');
  const en = graphs('enterprise-kg-en');
  const chinese = /[\u3000-\u9fff]/;

  /** One English text per Chinese text, and no two Chinese texts with the same English one. */
  function translation(role: string): (from: unknown, to: unknown) => void {
    const forward = new Map<string, string>();
    const backward = new Map<string, string>();
    return (from, to) => {
      const a = JSON.stringify(from);
      const b = JSON.stringify(to);
      expect(chinese.test(b), `${role} ${b} is not translated`).toBe(false);
      expect(forward.get(a) ?? b, `${role} ${a}`).toBe(b);
      expect(backward.get(b) ?? a, `${role} ${b}`).toBe(a);
      forward.set(a, b);
      backward.set(b, a);
    };
  }

  it('has the same nodes, flags and column mappings', () => {
    const label = translation('label');
    const type = translation('type');
    const alias = translation('alias');
    for (const [i, g] of zh.entries()) {
      const other = en[i]!;
      expect(other.nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id));
      for (const [j, n] of g.nodes.entries()) {
        const m = other.nodes[j]!;
        expect(Object.keys(m)).toEqual(Object.keys(n));
        for (const key of ['deprecated', 'replacedBy', 'replaces']) expect(m[key]).toEqual(n[key]);
        label(n.label, m.label);
        type(n.type, m.type);
        expect(m.aliases?.length).toBe(n.aliases?.length);
        for (const [k, a] of (n.aliases ?? []).entries()) alias(a, m.aliases?.[k]);
        const values = (node: Node): unknown[] => Object.values(node.attrs ?? {});
        expect(values(m).length).toBe(values(n).length);
        for (const [k, v] of values(n).entries()) {
          if (typeof v !== 'string' || !chinese.test(v)) expect(values(m)[k], n.id).toEqual(v);
        }
      }
    }
  });

  it('has the same edges, predicates translated one for one', () => {
    const predicate = translation('predicate');
    for (const [i, g] of zh.entries()) {
      const other = en[i]!;
      expect(other.edges.length).toBe(g.edges.length);
      for (const [j, e] of g.edges.entries()) {
        const f = other.edges[j]!;
        expect([f.source, f.target]).toEqual([e.source, e.target]);
        predicate(e.predicate, f.predicate);
      }
    }
  });

  it('reports the same changes', () => {
    const run = (id: string): DiffResult => {
      const meta = read<Meta>(`${id}/meta.json`);
      return diff(load(id, meta.files.before), load(id, meta.files.after), meta.options);
    };
    const facets = (fs: readonly { kind: string }[]): string => fs.map((f) => f.kind).join(' ');
    const shape = (d: DiffResult) => ({
      nodes: sorted(d.nodes.map((n) => `${n.id} ${n.status} ${facets(n.facets)}`)),
      edges: sorted(d.edges.map((e) => `${e.source} ${e.target} ${e.status} ${facets(e.facets)}`)),
      // Ties in the review order go by the anchor's label, so only the set of hunks is the same.
      hunks: sorted(d.hunks.map((h) => `${h.id} ${h.kind} ${h.phase}`)),
    });
    expect(shape(run('enterprise-kg-en'))).toEqual(shape(run('enterprise-kg')));
  });
});
