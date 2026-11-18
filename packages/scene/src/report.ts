/**
 * Report payloads: the `kgdiff.report` document (packages/core/schema/report.v1.json) that the
 * CLI embeds in HTML reports and `<kgdiff-viewer>` reads, read into what `buildScene` needs.
 */
import type { DiffJSON, DiffResult, Locale, PackedDiffJSON } from '@kgdiff/core';
import { diffFromJSON, KgdiffError, unpackDiffJSON } from '@kgdiff/core';
import type { LayoutJSON, LayoutResult } from '@kgdiff/layout';
import { layoutFromJSON } from '@kgdiff/layout';
import { buildScene } from './build.js';
import type { NodeShape, PaletteName, Scene, SceneOptions } from './types.js';

/**
 * A `kgdiff.report` document, version 1: a precomputed diff, with its layout or without, what
 * the report says about itself and how a viewer starts. `ReportPayload` of `@kgdiff/viewer`
 * is assignable to it.
 */
export interface ReportPayload {
  readonly format: 'kgdiff.report';
  readonly version: 1;
  /** The diff, packed (`packDiffJSON`, what the CLI writes) or not. */
  readonly diff: DiffJSON | PackedDiffJSON;
  /** The diff's layout (`layoutToJSON`); left out, the reader lays the diff out itself. */
  readonly layout?: LayoutJSON;
  readonly meta: {
    readonly title?: string;
    /** e.g. `kgdiff 0.1.0`. */
    readonly generator: string;
    /** ISO timestamp; omitted for reproducible reports. */
    readonly generatedAt?: string;
    readonly before: { readonly name: string; readonly format?: string };
    readonly after: { readonly name: string; readonly format?: string };
  };
  /** How a viewer starts. Readers ignore the members they do not know. */
  readonly view?: ReportView;
}

/** The `view` of a report payload: how a viewer starts. */
export interface ReportView {
  /** `changes` appears only in reports made before scopes existed. */
  readonly mode?: 'overlay' | 'swipe' | 'replay' | 'changes';
  readonly scope?: 'all' | 'changes';
  readonly theme?: 'auto' | 'light' | 'dark';
  readonly palette?: PaletteName;
  readonly locale?: Locale;
  /** Initial states of the regions of the viewer's default layout. */
  readonly panels?: Readonly<Record<string, 'open' | 'collapsed' | 'hidden'>>;
  /**
   * Node type → shape (`SceneOptions.shapes`).
   *
   * @experimental Stays experimental after 1.0, as `SceneOptions.shapes`.
   */
  readonly shapes?: Readonly<Record<string, NodeShape>>;
}

/** A report payload, read: what `buildScene` takes, and what the report says about itself. */
export interface ReportContent {
  readonly diff: DiffResult;
  /** The payload's layout; undefined when it has none (lay the diff out with `layoutDiff`). */
  readonly layout: LayoutResult | undefined;
  readonly meta: ReportPayload['meta'];
  readonly view: ReportView | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(message: string): never {
  throw new KgdiffError('invalid-input', `reportFromJSON: ${message}`);
}

/**
 * Read a `kgdiff.report` payload (packages/core/schema/report.v1.json): its diff with
 * `diffFromJSON` (unpacked first when packed), its layout with `layoutFromJSON`, and its `meta`
 * and `view` as they are. As the schema says: `format`, `version`, `diff` and `meta` are
 * required, a payload without a layout is valid, and members of `view` this version does not
 * know are kept, not rejected. Linear in the size of the diff.
 *
 * @throws KgdiffError `invalid-input` for a value that is not a report (another `format`, no
 *   `diff` or `meta`) or a malformed diff or layout; `unsupported-version` for a report version
 *   other than 1 (and for a diff or layout of a version their readers do not know).
 */
export function reportFromJSON(json: unknown): ReportContent {
  if (!isObject(json)) invalid('a kgdiff report payload must be an object');
  if (json.format !== 'kgdiff.report') {
    invalid(`expected format "kgdiff.report", got ${JSON.stringify(json.format)}`);
  }
  if (json.version !== 1) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported kgdiff report version ${JSON.stringify(json.version)}; this reader supports version 1`,
      { version: json.version },
    );
  }
  const diff = json.diff;
  if (!isObject(diff)) invalid('a kgdiff report needs a `diff`');
  if (json.layout !== undefined && !isObject(json.layout)) {
    invalid('the `layout` of a kgdiff report must be a kgdiff.layout document, or be left out');
  }
  const meta = json.meta;
  if (!isObject(meta) || !isObject(meta.before) || !isObject(meta.after)) {
    invalid('a kgdiff report needs a `meta` with `before` and `after`');
  }
  if (json.view !== undefined && !isObject(json.view)) {
    invalid('the `view` of a kgdiff report must be an object, or be left out');
  }
  const unpacked =
    diff.format === 'kgdiff.diff.packed'
      ? unpackDiffJSON(diff as unknown as PackedDiffJSON)
      : (diff as unknown as DiffJSON);
  return {
    diff: diffFromJSON(unpacked),
    layout:
      json.layout === undefined ? undefined : layoutFromJSON(json.layout as unknown as LayoutJSON),
    meta: meta as unknown as ReportPayload['meta'],
    view: json.view as ReportView | undefined,
  };
}

/**
 * The scene of a report payload: `reportFromJSON`, then `buildScene` on its diff and layout.
 * The payload's `view.shapes` are the scene's shapes unless `options.shapes` is given; its other
 * view preferences are a viewer's (read them from `reportFromJSON(json).view`).
 *
 * @throws KgdiffError what `reportFromJSON` and `buildScene` throw, and `invalid-input` for a
 *   payload without a layout (lay its diff out with `layoutDiff`, then call `buildScene`).
 */
export function sceneFromReport(json: unknown, options: SceneOptions = {}): Scene {
  const report = reportFromJSON(json);
  if (report.layout === undefined) {
    invalid('this report has no layout; lay its diff out with layoutDiff and call buildScene');
  }
  const shapes = options.shapes ?? report.view?.shapes;
  return buildScene(report.diff, report.layout, {
    ...options,
    ...(shapes !== undefined ? { shapes } : {}),
  });
}
