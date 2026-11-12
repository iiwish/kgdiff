/**
 * Cross-package acceptance: every example dataset goes through the whole pipeline
 * (parse → diff → layout → scene → visuals) and every stage keeps its promises.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DiffOptions, diff, diffFromJSON, diffToJSON, type Locale } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';
import { layoutDiff, layoutToJSON } from '@kgdiff/layout';
import {
  buildScene,
  createViewState,
  createVisualResolver,
  type FrameVisuals,
  type ThemeName,
} from '@kgdiff/scene';
import { describe, expect, it } from 'vitest';

const DATASETS = join(import.meta.dirname, '..', 'examples', 'datasets');

interface DatasetMeta {
  readonly id: string;
  readonly files: { readonly before: string; readonly after: string };
  readonly options?: DiffOptions;
}

const index = JSON.parse(readFileSync(join(DATASETS, 'index.json'), 'utf8')) as {
  datasets: { id: string }[];
};

async function load(id: string) {
  const meta = JSON.parse(readFileSync(join(DATASETS, id, 'meta.json'), 'utf8')) as DatasetMeta;
  const read = async (file: string) =>
    (await parseGraph(readFileSync(join(DATASETS, id, file), 'utf8'), { filename: file })).graph;
  return { meta, before: await read(meta.files.before), after: await read(meta.files.after) };
}

function assertFiniteFrame(frame: FrameVisuals): void {
  for (const node of frame.nodes) {
    if (!node.visible) continue;
    expect(Number.isFinite(node.x) && Number.isFinite(node.y) && node.r >= 0).toBe(true);
    expect(node.alpha).toBeGreaterThanOrEqual(0);
    expect(node.alpha).toBeLessThanOrEqual(1);
  }
  for (const edge of frame.edges) {
    if (!edge.visible) continue;
    for (const v of [edge.x1, edge.y1, edge.x2, edge.y2, edge.width, edge.progress]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(edge.alpha).toBeGreaterThanOrEqual(0);
    expect(edge.alpha).toBeLessThanOrEqual(1);
  }
}

// Diff and layout are asynchronous: each dataset is computed before the tests are collected.
const computed = new Map(
  await Promise.all(
    index.datasets.map(async ({ id }) => {
      const { meta, before, after } = await load(id);
      const result = await diff(before, after, meta.options);
      return [id, { meta, result, layout: await layoutDiff(result) }] as const;
    }),
  ),
);

describe.each(index.datasets.map((d) => d.id))('dataset %s', (id) => {
  const { meta, result, layout } = computed.get(id)!;

  it('finds a non-empty, partitioned set of changes', () => {
    expect(result.stats.identical).toBe(false);
    expect(result.hunks.length).toBeGreaterThan(0);
    const owned = new Set<string>();
    for (const hunk of result.hunks) {
      for (const n of hunk.nodes) owned.add(`n:${n}`);
      for (const e of hunk.edges) owned.add(`e:${e}`);
    }
    for (const n of result.nodes) {
      expect(owned.has(`n:${n.id}`)).toBe(n.status !== 'unchanged');
    }
    for (const e of result.edges) {
      expect(owned.has(`e:${e.id}`)).toBe(e.status !== 'unchanged');
    }
  });

  it('is deterministic and survives JSON transport', async () => {
    const again = await diff((await load(id)).before, (await load(id)).after, meta.options);
    const json = JSON.stringify(diffToJSON(result));
    expect(JSON.stringify(diffToJSON(again))).toBe(json);
    expect(JSON.stringify(diffToJSON(diffFromJSON(JSON.parse(json))))).toBe(json);
    expect(JSON.stringify(layoutToJSON(await layoutDiff(again)))).toBe(
      JSON.stringify(layoutToJSON(layout)),
    );
  });

  it('places every union node at a finite position', () => {
    expect(layout.positions.size).toBe(result.nodes.length);
    for (const p of layout.positions.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it.each<[ThemeName, Locale]>([
    ['dark', 'en'],
    ['light', 'zh-CN'],
  ])('renders sane visuals in every layer (%s, %s)', (theme, locale) => {
    const scene = buildScene(result, layout, { theme, locale });
    expect(scene.hunks.map((h) => h.id).sort()).toEqual(result.hunks.map((h) => h.id).sort());
    for (const hunk of scene.hunks) expect(hunk.title.length).toBeGreaterThan(0);

    const resolver = createVisualResolver(scene);
    let frame: FrameVisuals | undefined;
    for (const layer of ['union', 'before', 'after'] as const) {
      frame = resolver.resolve(createViewState({ layer }), frame);
      assertFiniteFrame(frame);
    }
    const { duration } = scene.timeline;
    for (let i = 0; i <= 24; i++) {
      frame = resolver.resolve(createViewState({ layer: 'replay', t: (duration * i) / 24 }), frame);
      assertFiniteFrame(frame);
    }
    frame = resolver.resolve(createViewState({ layer: 'union', selectedHunk: 0 }), frame);
    assertFiniteFrame(frame);
  });
});
