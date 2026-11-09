/**
 * Build the `ReportPayload` embedded in HTML reports: packed diff (`packDiffJSON`) + layout
 * (`layoutToJSON`) + meta + initial view preferences. `@kgdiff/layout` and `node:zlib` are
 * loaded on demand, so text outputs never pay for them.
 */
import { type DiffResult, diffToJSON, type Locale, packDiffJSON } from '@kgdiff/core';
import type {
  ReportPayload,
  ThemePreference,
  ViewerMode,
  ViewerPanels,
  ViewerScope,
} from '@kgdiff/viewer';
import { renderReportHtml } from './html.js';

export interface ReportInfo {
  readonly title: string;
  /** e.g. `kgdiff 0.1.0`. */
  readonly generator: string;
  /** ISO timestamp; omitted for reproducible reports. */
  readonly generatedAt?: string;
  readonly before: { readonly name: string; readonly format?: string };
  readonly after: { readonly name: string; readonly format?: string };
  readonly view: {
    readonly mode?: ViewerMode;
    readonly scope?: ViewerScope;
    readonly theme?: ThemePreference;
    readonly locale: Locale;
    readonly panels?: ViewerPanels;
  };
}

/** Lay out the diff and assemble the payload. Deterministic apart from `generatedAt`. */
export async function buildReportPayload(
  diff: DiffResult,
  info: ReportInfo,
): Promise<ReportPayload> {
  const { layoutDiff, layoutToJSON } = await import('@kgdiff/layout');
  const layout = layoutToJSON(layoutDiff(diff));
  const { mode, scope, theme, locale, panels } = info.view;
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: packDiffJSON(diffToJSON(diff)),
    layout,
    meta: {
      title: info.title,
      generator: info.generator,
      ...(info.generatedAt !== undefined ? { generatedAt: info.generatedAt } : {}),
      before: info.before,
      after: info.after,
    },
    view: {
      ...(mode !== undefined ? { mode } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(theme !== undefined ? { theme } : {}),
      locale,
      ...(panels !== undefined ? { panels } : {}),
    },
  };
}

/**
 * Deterministic gzip (level 9). The header's OS byte is normalized to 255 ("unknown") so the
 * bytes do not depend on the platform the report was generated on.
 */
export async function createGzip(): Promise<(data: Uint8Array) => Uint8Array> {
  const { gzipSync, constants } = await import('node:zlib');
  return (data) => {
    const out = gzipSync(data, { level: constants.Z_BEST_COMPRESSION });
    out[9] = 0xff;
    return out;
  };
}

/**
 * Whether a report should inline the compute add-on: only when the layout covers just the
 * changes (large graphs), where the viewer may need to lay out collapsed groups the user
 * expands, or when there is no layout at all. Full layouts need no browser-side computation,
 * so small reports stay small.
 */
export function needsCompute(payload: ReportPayload): boolean {
  return payload.layout === undefined || payload.layout.scope === 'changes';
}

export interface ReportBundles {
  /** The standalone viewer bundle. */
  readonly main: string;
  /**
   * Loads the compute add-on; called only when `needsCompute`. Returning `undefined` (e.g.
   * `--no-compute`) leaves it out.
   */
  readonly compute: () => Promise<string | undefined>;
}

/** Full HTML document for a diff. */
export async function buildReportHtml(
  diff: DiffResult,
  info: ReportInfo,
  bundles: ReportBundles,
  description: string,
): Promise<string> {
  const payload = await buildReportPayload(diff, info);
  const compute = needsCompute(payload) ? await bundles.compute() : undefined;
  return renderReportHtml({
    payload,
    bundle: bundles.main,
    ...(compute !== undefined ? { compute } : {}),
    description,
    gzip: await createGzip(),
  });
}
