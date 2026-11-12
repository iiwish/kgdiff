/**
 * Build-time data for the site (runs in Node through Vite's module runner, see `plugins.ts`):
 * every example dataset is parsed, diffed and laid out once, exactly like `kgdiff -o report.html`
 * does, so the landing page ships a precomputed `ReportPayload` instead of parsers, the diff
 * engine and the force layout. Deterministic: same sources → byte-identical payloads.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diff, init, layoutDiff, parseGraph } from '@kgdiff/compute';
import { type DiffOptions, diffToJSON, type Locale, packDiffJSON } from '@kgdiff/core';
import { layoutToJSON } from '@kgdiff/layout';
import { buildScene, type ChangeFamily, getTheme } from '@kgdiff/scene';
import type { ReportPayload } from '@kgdiff/viewer';

// kgdiff's engine (`@kgdiff/compute`), loaded while this module is imported: Vite's module runner
// is closed afterwards, so nothing may be imported on demand later (as `diff` of `@kgdiff/core`
// would import the engine on its first call).
await init();

/** `examples/datasets/<id>/meta.json`. */
export interface DatasetMeta {
  readonly id: string;
  readonly title: Readonly<Record<Locale, string>>;
  readonly description: Readonly<Record<Locale, string>>;
  readonly format: string;
  readonly files: { readonly before: string; readonly after: string };
  readonly versions?: { readonly before?: string; readonly after?: string };
  readonly options?: DiffOptions;
  readonly featured?: boolean;
  readonly license?: string;
}

/** Summary numbers shown on the dataset cards (no payload needed). */
export interface DatasetStats {
  readonly id: string;
  readonly hunks: number;
  /** Hunks per change family. */
  readonly families: Readonly<Record<ChangeFamily, number>>;
  readonly nodes: { readonly before: number; readonly after: number };
  readonly edges: { readonly before: number; readonly after: number };
}

interface IndexFile {
  readonly datasets: readonly { readonly id: string }[];
}

const FAMILIES: readonly ChangeFamily[] = ['added', 'removed', 'content', 'structure', 'identity'];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Dataset ids in display order (`examples/datasets/index.json`). */
export function datasetIds(root: string): string[] {
  return readJson<IndexFile>(join(root, 'index.json')).datasets.map((d) => d.id);
}

export function readMeta(root: string, id: string): DatasetMeta {
  return readJson<DatasetMeta>(join(root, id, 'meta.json'));
}

interface Computed {
  readonly payload: ReportPayload;
  readonly stats: DatasetStats;
}

const cache = new Map<string, Promise<Computed>>();

function compute(root: string, id: string): Promise<Computed> {
  let hit = cache.get(id);
  if (!hit) {
    hit = run(root, id);
    cache.set(id, hit);
    hit.catch(() => cache.delete(id));
  }
  return hit;
}

async function run(root: string, id: string): Promise<Computed> {
  const meta = readMeta(root, id);
  const side = async (name: 'before' | 'after') => {
    const filename = meta.files[name];
    const text = readFileSync(join(root, id, filename), 'utf8');
    return { filename, parsed: await parseGraph(text, { filename }) };
  };
  const before = await side('before');
  const after = await side('after');
  const result = await diff(before.parsed.graph, after.parsed.graph, meta.options);
  const layout = await layoutDiff(result);
  const families = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<ChangeFamily, number>;
  // The scene's family per hunk is what the viewer's change list shows (a move-only modify is
  // structure, not content).
  const scene = buildScene(result, layout, { theme: getTheme('dark'), locale: 'en' });
  for (const hunk of scene.hunks) families[hunk.family] += 1;
  const payload: ReportPayload = {
    format: 'kgdiff.report',
    version: 1,
    diff: packDiffJSON(diffToJSON(result)),
    layout: layoutToJSON(layout),
    meta: {
      title: meta.title.en,
      generator: 'kgdiff site (build time)',
      before: { name: meta.title.en, format: before.parsed.format },
      after: { name: meta.title.en, format: after.parsed.format },
    },
  };
  const computed: Computed = {
    payload,
    stats: {
      id,
      hunks: result.hunks.length,
      families,
      nodes: { before: result.stats.before.nodes, after: result.stats.after.nodes },
      edges: { before: result.stats.before.edges, after: result.stats.after.edges },
    },
  };
  return computed;
}

/** The precomputed report payload of a dataset (default options from its meta.json). */
export async function payloadOf(root: string, id: string): Promise<ReportPayload> {
  return (await compute(root, id)).payload;
}

/** Card numbers for every dataset, in display order. */
export async function allStats(root: string): Promise<DatasetStats[]> {
  const all = await Promise.all(datasetIds(root).map((id) => compute(root, id)));
  return all.map((c) => c.stats);
}
