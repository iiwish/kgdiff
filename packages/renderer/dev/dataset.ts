/// <reference types="vite/client" />
/**
 * DEV ONLY: the real pipeline for the harness — example dataset files → core `parseGraph` →
 * core `diff` → layout `layoutDiff` → scene `buildScene` → `createVisualResolver`.
 * Diff and layout are computed once per dataset; the scene is rebuilt for theme / locale.
 */
import { type DiffOptions, type DiffResult, diff, type Locale, parseGraph } from '@kgdiff/core';
import { type LayoutResult, layoutDiff } from '@kgdiff/layout';
import {
  buildScene,
  createVisualResolver,
  type Scene,
  type ThemeName,
  type VisualResolver,
} from '@kgdiff/scene';

/** Every example file, loaded lazily as text. */
const files = import.meta.glob<string>('../../../examples/datasets/*/*', {
  query: '?raw',
  import: 'default',
});

const ROOT = '../../../examples/datasets/';

export interface DatasetMeta {
  readonly id: string;
  readonly title: { readonly en: string; readonly 'zh-CN': string };
  readonly format: string;
  readonly files: { readonly before: string; readonly after: string };
  readonly versions?: { readonly before: string; readonly after: string };
  readonly options?: DiffOptions;
}

export interface Dataset {
  readonly meta: DatasetMeta;
  readonly diff: DiffResult;
  readonly layout: LayoutResult;
  /** ms per stage. */
  readonly timings: { readonly parse: number; readonly diff: number; readonly layout: number };
}

export interface SceneBundle {
  readonly scene: Scene;
  readonly resolver: VisualResolver;
  readonly ms: number;
}

/** Ids of the datasets present in examples/datasets (those with a meta.json). */
export function datasetIds(): string[] {
  return Object.keys(files)
    .filter((p) => p.endsWith('/meta.json'))
    .map((p) => p.slice(ROOT.length, -'/meta.json'.length))
    .sort((a, b) => (a === 'enterprise-kg' ? -1 : b === 'enterprise-kg' ? 1 : a.localeCompare(b)));
}

async function text(id: string, name: string): Promise<string> {
  const load = files[`${ROOT}${id}/${name}`];
  if (!load) throw new Error(`examples/datasets/${id}/${name} not found`);
  return load();
}

/** Parse both versions, diff and lay out a dataset. */
export async function loadDataset(id: string): Promise<Dataset> {
  const meta = JSON.parse(await text(id, 'meta.json')) as DatasetMeta;
  const [beforeText, afterText] = await Promise.all([
    text(id, meta.files.before),
    text(id, meta.files.after),
  ]);
  const t0 = performance.now();
  const before = (await parseGraph(beforeText, { filename: meta.files.before })).graph;
  const after = (await parseGraph(afterText, { filename: meta.files.after })).graph;
  const t1 = performance.now();
  const result = await diff(before, after, meta.options);
  const t2 = performance.now();
  const layout = await layoutDiff(result);
  const t3 = performance.now();
  return {
    meta,
    diff: result,
    layout,
    timings: { parse: t1 - t0, diff: t2 - t1, layout: t3 - t2 },
  };
}

const DEMO_SHAPES = { K0: 'circle', K1: 'square', K2: 'diamond', K3: 'hexagon' } as const;

/** The diff with its nodes typed round-robin, so every state occurs in every shape. */
function demoTyped(result: DiffResult): DiffResult {
  return {
    ...result,
    nodes: result.nodes.map((n, i) => ({ ...n, types: [`K${i % 4}`] })),
  } as DiffResult;
}

/** Scene + resolver for a theme and locale; `shapes` mixes all four shapes (`?shapes=1`). */
export function sceneFor(
  data: Dataset,
  theme: ThemeName,
  locale: Locale,
  shapes = false,
): SceneBundle {
  const t0 = performance.now();
  const scene = shapes
    ? buildScene(demoTyped(data.diff), data.layout, { theme, locale, shapes: DEMO_SHAPES })
    : buildScene(data.diff, data.layout, { theme, locale });
  const resolver = createVisualResolver(scene);
  return { scene, resolver, ms: performance.now() - t0 };
}
