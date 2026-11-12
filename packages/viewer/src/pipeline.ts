/**
 * Load pipeline: sources → (parse) → diff → layout, or a precomputed report → diff + layout
 * (laid out here when the report has none).
 * Each step is announced through `onStep`, which the controller awaits so the loading state
 * can paint between the (CPU-bound) steps. Parsing, diffing and laying out run kgdiff's engine in
 * WebAssembly (`@kgdiff/compute`: diffing and laying out through `compute.ts`, parsing directly).
 */
import {
  type DiffResult,
  diffFromJSON,
  type GraphInput,
  type GraphMeta,
  isKGraph,
  type KGraph,
  KgdiffError,
  unpackDiffJSON,
} from '@kgdiff/core';
import { type LayoutOptions, type LayoutResult, layoutFromJSON } from '@kgdiff/layout';
import { type Compute, loadCompute } from './compute-loader.js';
import { translate } from './i18n.js';
import type { GraphSource, LoadOptions, ReportPayload } from './index.js';
import { sanitizeView } from './prefs.js';

export type LoadStep = 'parse' | 'match' | 'layout' | 'scene';

export interface LoadedDiff {
  readonly diff: DiffResult;
  readonly layout: LayoutResult;
  /** Options to reuse when the layout is extended. */
  readonly layoutOptions: LayoutOptions | undefined;
  readonly names: { readonly before: string; readonly after: string };
  readonly versions: { readonly before?: string; readonly after?: string };
  readonly title?: string;
  /** Initial view preferences from a report. */
  readonly view?: ReportPayload['view'];
}

type TextSource = Extract<GraphSource, { readonly text: string }>;

function isTextSource(source: GraphSource): source is TextSource {
  return typeof (source as Partial<TextSource>).text === 'string';
}

function isGraphInput(value: unknown): value is GraphInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<GraphInput>;
  return Array.isArray(v.nodes) && (v.edges === undefined || Array.isArray(v.edges));
}

type Parsers = Pick<typeof import('@kgdiff/compute'), 'parseGraph'>;

let parsersPromise: Promise<Parsers> | null = null;

/**
 * `@kgdiff/compute`, loaded lazily so the standalone bundle (reports) never pays for the parsers:
 * it stays external there (an import map entry), and its `formats` module is compiled on the
 * first `parseGraph`.
 */
function loadParsers(): Promise<Parsers> {
  parsersPromise ??= import('@kgdiff/compute').catch((error: unknown) => {
    parsersPromise = null;
    throw new KgdiffError('invalid-input', translate('en', 'error.formats'), {
      cause: error instanceof Error ? error.message : String(error),
    });
  });
  return parsersPromise;
}

interface Resolved {
  readonly graph: GraphInput | KGraph;
  readonly meta: GraphMeta;
  readonly filename?: string;
}

async function resolveSource(source: GraphSource, side: 'before' | 'after'): Promise<Resolved> {
  if (typeof source !== 'object' || source === null) {
    throw new KgdiffError(
      'invalid-input',
      `load(): \`${side}\` must be a GraphInput, a KGraph or { text, filename }.`,
    );
  }
  if (isTextSource(source)) {
    const { parseGraph } = await loadParsers();
    const parsed = await parseGraph(source.text, {
      ...source.parse,
      ...(source.filename !== undefined ? { filename: source.filename } : {}),
    });
    return {
      graph: parsed.graph,
      meta: parsed.graph.meta ?? {},
      ...(source.filename !== undefined ? { filename: source.filename } : {}),
    };
  }
  if (isKGraph(source)) return { graph: source, meta: source.meta };
  if (isGraphInput(source)) return { graph: source, meta: source.meta ?? {} };
  throw new KgdiffError(
    'invalid-input',
    `load(): \`${side}\` must be a GraphInput ({ nodes, edges }), a KGraph or { text, filename }.`,
  );
}

function baseName(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path;
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1) || path;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Display name of a version: explicit name, graph name, file name, else the side. */
function versionName(
  meta: GraphMeta,
  side: 'before' | 'after',
  explicit?: string,
  filename?: string,
): string {
  return (
    str(explicit) ??
    str(meta.name) ??
    (filename ? baseName(filename) : undefined) ??
    (str(meta.source) ? baseName(meta.source as string) : undefined) ??
    side
  );
}

export async function runLoad(
  options: LoadOptions,
  onStep: (step: LoadStep) => Promise<void>,
): Promise<LoadedDiff> {
  if (typeof options !== 'object' || options === null) {
    throw new KgdiffError('invalid-input', 'load() expects { before, after, … }.');
  }
  const { before, after } = options;
  if (before === undefined || after === undefined) {
    throw new KgdiffError('invalid-input', 'load() needs both `before` and `after`.');
  }
  const computing = loadCompute();
  if (isTextSource(before) || isTextSource(after)) await onStep('parse');
  const b = await resolveSource(before, 'before');
  const a = await resolveSource(after, 'after');
  const compute = await computing;
  await onStep('match');
  const diff = await compute.diff(b.graph, a.graph, options.diff);
  await onStep('layout');
  const layout = await compute.layoutDiff(diff, options.layout);
  const vb = str(diff.before.meta.version);
  const va = str(diff.after.meta.version);
  return {
    diff,
    layout,
    layoutOptions: options.layout,
    names: {
      before: versionName(b.meta, 'before', options.names?.before, b.filename),
      after: versionName(a.meta, 'after', options.names?.after, a.filename),
    },
    versions: { ...(vb ? { before: vb } : {}), ...(va ? { after: va } : {}) },
    ...(str(options.title) ? { title: str(options.title) as string } : {}),
  };
}

/** The compute module, for a payload without a layout: rejects with what is missing. */
async function layoutEngine(): Promise<Compute> {
  try {
    return await loadCompute();
  } catch (error) {
    throw new KgdiffError('invalid-input', translate('en', 'error.noLayout'), {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readPayload(
  payload: ReportPayload,
  onStep: (step: LoadStep) => Promise<void>,
): Promise<LoadedDiff> {
  // A payload without a layout is laid out here; the layout engine loads while the diff is
  // read. A payload with one never loads it.
  const engine = payload.layout === undefined ? layoutEngine() : null;
  // Awaited below; a diff that fails to read first must not leave a rejection unhandled.
  engine?.catch(() => {});
  await onStep('match');
  const json =
    payload.diff.format === 'kgdiff.diff.packed' ? unpackDiffJSON(payload.diff) : payload.diff;
  const diff = diffFromJSON(json);
  await onStep('layout');
  const layout = engine ? await (await engine).layoutDiff(diff) : layoutFromJSON(payload.layout!);
  const vb = str(diff.before.meta.version);
  const va = str(diff.after.meta.version);
  const meta = payload.meta;
  const view = sanitizeView(payload.view);
  return {
    diff,
    layout,
    layoutOptions: undefined,
    names: {
      before: versionName(diff.before.meta, 'before', meta?.before?.name),
      after: versionName(diff.after.meta, 'after', meta?.after?.name),
    },
    versions: { ...(vb ? { before: vb } : {}), ...(va ? { after: va } : {}) },
    ...(str(meta?.title) ? { title: str(meta?.title) as string } : {}),
    ...(view ? { view } : {}),
  };
}
