/**
 * The JSON Schemas in schema/ describe what kgdiff writes: graphs (`graphToJSON`), diffs
 * (`diffToJSON`) and deltas. Everything kgdiff writes must validate, and the schemas must
 * reject what it would not write.
 *
 * Layouts (`layout.v2.json`) and report payloads (`report.v1.json`) are written by the Rust
 * crates, whose tests validate them (kgdiff-layout, kgdiff-report); here, the two schemas are
 * compiled in strict mode with the others, and the report schema is checked against payloads
 * put together by hand.
 */
import { readFileSync } from 'node:fs';
import {
  type DiffOptions,
  diffToJSON,
  type GraphInput,
  graphToJSON,
  invertDelta,
  packDiffJSON,
} from '@kgdiff/core';
import { layoutToJSON } from '@kgdiff/layout';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseGraph } from '../../formats/src/sync.js';
import { layoutDiff } from '../../layout/src/sync.js';
import { diff } from '../src/sync.js';
import { versionPairArb } from './support/arbitraries.js';
import {
  enterpriseAfter,
  enterpriseBefore,
  extractionAfter,
  extractionBefore,
  oboAfter,
  oboBefore,
  taxonomyAfter,
  taxonomyBefore,
} from './support/fixtures.js';

const BASE = 'https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/';
const NAMES = [
  'graph.v1',
  'delta.v1',
  'diff.v1',
  'diff-packed.v1',
  'layout.v2',
  'report.v1',
] as const;
const schemas = NAMES.map(
  (name) =>
    JSON.parse(readFileSync(new URL(`../schema/${name}.json`, import.meta.url), 'utf8')) as Record<
      string,
      unknown
    >,
);

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: true });
ajv.addSchema(schemas);
function validator(name: (typeof NAMES)[number]): ValidateFunction {
  const validate = ajv.getSchema(`${BASE}${name}.json`);
  if (validate === undefined) throw new Error(`${name}.json is not registered`);
  return validate;
}
const graph = validator('graph.v1');
const delta = validator('delta.v1');
const diffSchema = validator('diff.v1');
const packedSchema = validator('diff-packed.v1');
const layoutSchema = validator('layout.v2');
const report = validator('report.v1');

/** Asserts validity, listing the schema errors on failure. */
function expectValid(validate: ValidateFunction, value: unknown): void {
  validate(value);
  expect(validate.errors ?? []).toEqual([]);
}

function expectAllValid(before: GraphInput, after: GraphInput, options?: DiffOptions): void {
  const result = diff(before, after, options);
  expectValid(graph, graphToJSON(result.before));
  expectValid(graph, graphToJSON(result.after));
  expectValid(diffSchema, diffToJSON(result));
  expectValid(packedSchema, packDiffJSON(diffToJSON(result)));
  expectValid(delta, result.delta);
  expectValid(delta, invertDelta(result.delta));
}

describe('JSON Schemas', () => {
  it('have the $id their file name gives them', () => {
    expect(schemas.map((schema) => schema.$id)).toEqual(NAMES.map((n) => `${BASE}${n}.json`));
  });

  it('accept the graphs, diffs and deltas of random version pairs', () => {
    const options = fc.constantFrom<DiffOptions | undefined>(
      undefined,
      { edgeIdentity: 'id' },
      { match: { strategy: 'similarity' } },
      { match: { strategy: 'id' }, detectMerges: false, detectSplits: false },
    );
    fc.assert(
      fc.property(versionPairArb(), options, ([before, after], opts) => {
        expectAllValid(before, after, opts);
      }),
      { numRuns: 200 },
    );
  });

  it('accept merges, splits, rekeys and moves', () => {
    expectAllValid(enterpriseBefore, enterpriseAfter('hint'));
    expectAllValid(enterpriseBefore, enterpriseAfter('heuristic'));
    expectAllValid(oboBefore, oboAfter);
    expectAllValid(taxonomyBefore, taxonomyAfter);
    expectAllValid(extractionBefore, extractionAfter, { match: { strategy: 'similarity' } });
  });

  it.each([
    'enterprise-kg',
    'enterprise-kg-en',
    'llm-extraction',
    'data-lineage',
    'ontology-release',
    'schema-vocab',
  ])('accept everything kgdiff writes for the example dataset %s', (dataset) => {
    const root = new URL(`../../../examples/datasets/${dataset}/`, import.meta.url);
    const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
    const meta = JSON.parse(read('meta.json')) as {
      readonly options: DiffOptions;
      readonly files: { readonly before: string; readonly after: string };
    };
    const parse = (file: string) => parseGraph(read(file), { filename: file }).graph;
    expectAllValid(parse(meta.files.before), parse(meta.files.after), meta.options);
  });
});

describe('the graph schema', () => {
  const valid = {
    format: 'kgdiff.graph',
    version: 1,
    meta: { name: 'zoo', version: 'v2', curator: { name: 'Ana' } },
    nodes: [
      { id: 'cat', label: 'Cat', type: 'Species', aliases: ['house cat'], attrs: { legs: 4 } },
      { id: 'mammal', types: ['Class'], deprecated: false, replaces: ['mammalia'] },
      { id: 'ghost', implicit: true, position: { x: 1, y: 2 } },
    ],
    edges: [
      { source: 'cat', target: 'mammal', predicate: 'subClassOf' },
      { id: 'e1', source: 'cat', target: 'ghost', label: 'haunts', attrs: { since: null } },
    ],
  };

  it('accepts a hand-written graph, with or without the marker', () => {
    expectValid(graph, valid);
    const { format: _format, version: _version, ...bare } = valid;
    expectValid(graph, bare);
    expectValid(graph, { $schema: `${BASE}graph.v1.json`, nodes: [] });
  });

  it.each([
    ['a misspelt node field', { nodes: [{ id: 'a', lable: 'A' }] }],
    ['a node without an id', { nodes: [{ label: 'A' }] }],
    ['an empty id', { nodes: [{ id: '' }] }],
    ['a numeric id', { nodes: [{ id: 1 }] }],
    ['both type and types', { nodes: [{ id: 'a', type: 'T', types: ['T'] }] }],
    ['an edge without a target', { nodes: [], edges: [{ source: 'a' }] }],
    ['a misspelt edge field', { nodes: [], edges: [{ source: 'a', target: 'b', predicat: 'p' }] }],
    ['a newer version', { format: 'kgdiff.graph', version: 2, nodes: [] }],
    ['a marker without a version', { format: 'kgdiff.graph', nodes: [] }],
    ['a version without a marker', { version: 1, nodes: [] }],
    ['another format', { format: 'kgdiff.diff', version: 1, nodes: [] }],
    ['a field at the top level', { nodes: [], name: 'zoo' }],
    ['no nodes', { edges: [] }],
  ])('rejects %s', (_case, value) => {
    expect(graph(value)).toBe(false);
  });
});

describe('the delta and diff schemas', () => {
  const result = diff(enterpriseBefore, enterpriseAfter('hint'));

  it.each([
    ['an unknown op', { ...result.delta, ops: [{ op: 'node.rename', id: 'a' }] }],
    ['a malformed hash', { ...result.delta, base: { ...result.delta.base, hash: 'abc' } }],
    ['a newer version', { ...result.delta, version: 2 }],
  ])('the delta schema rejects %s', (_case, value) => {
    expect(delta(value)).toBe(false);
  });

  it.each([
    ['an unknown status', { nodes: [{ id: 'x', status: 'gone' }] }],
    [
      'an unknown facet',
      { nodes: [{ id: 'x', status: 'modified', facets: [{ kind: 'recolor' }] }] },
    ],
    ['a delta that is not one', { delta: { ops: [] } }],
    ['a missing field', { stats: undefined }],
    [
      'an added node with a before version',
      {
        nodes: [
          { id: 'x', beforeId: 'x', afterId: 'x', after: { id: 'x' }, status: 'added', hunk: 'h' },
        ],
      },
    ],
    [
      'a removed edge with an after version',
      {
        edges: [
          {
            id: 'e',
            source: 'a',
            target: 'b',
            before: { source: 'a', target: 'b' },
            after: { source: 'a', target: 'b' },
            status: 'removed',
            hunk: 'h',
          },
        ],
      },
    ],
    [
      'an added edge with a changed endpoint',
      {
        edges: [
          {
            id: 'e',
            source: 'a',
            target: 'b',
            sourceBefore: 'c',
            after: { source: 'a', target: 'b' },
            status: 'added',
            hunk: 'h',
          },
        ],
      },
    ],
    [
      'an unchanged node in a hunk',
      {
        nodes: [
          {
            id: 'x',
            beforeId: 'x',
            afterId: 'x',
            after: { id: 'x' },
            status: 'unchanged',
            hunk: 'h',
          },
        ],
      },
    ],
    [
      'a modified node without facets',
      {
        nodes: [
          {
            id: 'x',
            beforeId: 'x',
            afterId: 'x',
            after: { id: 'x' },
            status: 'modified',
            hunk: 'h',
          },
        ],
      },
    ],
    [
      'a changed node outside every hunk',
      { nodes: [{ id: 'x', afterId: 'x', after: { id: 'x' }, status: 'added' }] },
    ],
  ])('the diff schema rejects %s', (_case, spoiled) => {
    const json = JSON.parse(JSON.stringify({ ...diffToJSON(result), ...spoiled }));
    expect(diffSchema(json)).toBe(false);
  });

  it('accept the empty facet list diffFromJSON accepts on unchanged elements', () => {
    const json = JSON.parse(JSON.stringify(diffToJSON(result)));
    for (const n of json.nodes) if (n.status === 'unchanged') n.facets = [];
    expectValid(diffSchema, json);
  });

  it('accept an identical pair', () => {
    const g = { nodes: [{ id: 'a' }], edges: [] };
    expectAllValid(g, g);
  });
});

describe('the report schema', () => {
  const result = diff(enterpriseBefore, enterpriseAfter('hint'));
  // Version 1, as this repository's TypeScript engine writes it; the Rust engine writes 2.
  const layoutV1 = layoutToJSON(layoutDiff(result));
  const layoutV2 = { ...layoutV1, version: 2, generator: 'kgdiff-layout/1' };
  const payload = {
    format: 'kgdiff.report',
    version: 1,
    diff: packDiffJSON(diffToJSON(result)),
    layout: layoutV2,
    meta: {
      title: 'v12 → v13',
      generator: 'kgdiff 0.0.0',
      generatedAt: '2026-11-10T00:00:00.000Z',
      before: { name: 'v12', format: 'json' },
      after: { name: 'v13' },
    },
    view: {
      mode: 'swipe',
      scope: 'all',
      theme: 'dark',
      palette: 'colorblind',
      locale: 'zh-CN',
      panels: { detail: 'collapsed', minimap: 'hidden' },
    },
  };
  const { layout: _layout, ...withoutLayout } = payload;
  const { view: _view, ...withoutView } = payload;

  it('accepts a layout of either version, and none', () => {
    expect(layoutV1.version).toBe(1);
    expectValid(layoutSchema, layoutV2);
    expectValid(report, payload);
    expectValid(report, { ...payload, layout: layoutV1 });
    expectValid(report, withoutLayout);
  });

  it('accepts a diff that is not packed, and a payload without view or title', () => {
    expectValid(report, { ...payload, diff: diffToJSON(result) });
    expectValid(report, withoutView);
    const { title: _title, ...meta } = payload.meta;
    expectValid(report, { ...payload, meta });
  });

  it('accepts members of view it does not know, which later versions add', () => {
    expectValid(report, {
      ...payload,
      view: { ...payload.view, shapes: { Class: 'square' }, plain: true },
    });
  });

  it('describes view.shapes: type to one of the four shapes', () => {
    const shapes = { A: 'circle', B: 'square', C: 'diamond', D: 'hexagon' };
    expectValid(report, { ...payload, view: { ...payload.view, shapes } });
    const bad = { ...payload, view: { ...payload.view, shapes: { A: 'triangle' } } };
    expect(report(bad)).toBe(false);
  });

  it.each([
    ['another format', { format: 'kgdiff.diff' }],
    ['a newer version', { version: 2 }],
    ['no diff', { diff: undefined }],
    ['a delta for a diff', { diff: result.delta }],
    ['a null layout', { layout: null }],
    ['a layout of version 3', { layout: { ...layoutV2, version: 3 } }],
    ['a version 1 layout with a generator', { layout: { ...layoutV2, version: 1 } }],
    ['a version 2 layout without a generator', { layout: { ...layoutV1, version: 2 } }],
    ['no meta', { meta: undefined }],
    ['no generator', { meta: { ...payload.meta, generator: undefined } }],
    ['a side without a name', { meta: { ...payload.meta, after: { format: 'json' } } }],
    ['a misspelt member of meta', { meta: { ...payload.meta, generatedat: 'now' } }],
    ['a member at the top level', { title: 'v12 → v13' }],
    ['an unknown mode', { view: { mode: 'sideways' } }],
    ['an unknown scope', { view: { scope: 'context' } }],
    ['an unknown theme', { view: { theme: 'sepia' } }],
    ['an unknown palette', { view: { palette: 'neon' } }],
    ['an unknown locale', { view: { locale: 'fr' } }],
    ['an unknown region', { view: { panels: { sidebar: 'open' } } }],
    ['an unknown panel state', { view: { panels: { list: 'closed' } } }],
  ])('rejects %s', (_case, spoiled) => {
    expect(report(JSON.parse(JSON.stringify({ ...payload, ...spoiled })))).toBe(false);
  });
});
