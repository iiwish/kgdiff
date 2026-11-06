/**
 * The single-file HTML report (docs/cli.md §HTML report): the standalone viewer bundle and the
 * `ReportPayload` inlined in one accessible document that works offline.
 *
 * Pure: compression is injected, so the same inputs always give the same bytes.
 */
import type { ReportPayload, ThemePreference } from '@kgdiff/viewer';
import { sanitize } from './width.js';

/** MIME type of the payload script (`PAYLOAD_SCRIPT_TYPE` in `@kgdiff/viewer`). */
export const PAYLOAD_TYPE = 'application/kgdiff+json';

/** Payloads larger than this (UTF-8 bytes of the JSON) are embedded gzip + base64. */
export const GZIP_THRESHOLD = 512 * 1024;

const VIEWER_ID = 'kgdiff';

/** Theme backgrounds (docs/visual-language.md `canvas.background`, `text.primary`). */
const DARK = { background: '#0B0E14', text: '#E7EBF3' };
const LIGHT = { background: '#F7F8FA', text: '#0F172A' };

/** Escape text for HTML element content and double-quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON that is safe inside a `<script>` element: `<` is written as `<` (so neither
 * `</script` nor `<!--` can appear), and U+2028 / U+2029 are escaped. Still valid JSON.
 */
export function scriptSafeJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Make inline JavaScript safe inside a classic `<script>` element: `</script` becomes
 * `<\/script` and `<!--` becomes `\x3C!--`. Both rewrites keep string, template and regular
 * expression literals equivalent (the only places such sequences occur in real bundles).
 */
export function scriptSafeJs(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '\\x3C!--');
}

export interface ReportHtmlOptions {
  readonly payload: ReportPayload;
  /** Source of the standalone viewer bundle (an IIFE). */
  readonly bundle: string;
  /**
   * Source of the optional compute add-on (diff / layout in the browser, an IIFE that sets
   * `globalThis.KgdiffCompute`), inlined right after the viewer bundle when given.
   */
  readonly compute?: string;
  /** gzip compressor used for large payloads. Must be deterministic. */
  readonly gzip: (data: Uint8Array) => Uint8Array;
  /** Short description for `<meta name="description">` and `<noscript>`. */
  readonly description: string;
  /** Payload size above which it is compressed. Default `GZIP_THRESHOLD`. */
  readonly gzipThreshold?: number;
}

function themeStyle(theme: ThemePreference): string {
  const rule = (c: { background: string; text: string }): string =>
    `html,body{background:${c.background};color:${c.text}}`;
  if (theme === 'dark') return `:root{color-scheme:dark}${rule(DARK)}`;
  if (theme === 'light') return `:root{color-scheme:light}${rule(LIGHT)}`;
  return `:root{color-scheme:dark light}${rule(DARK)}@media (prefers-color-scheme:light){${rule(LIGHT)}}`;
}

/** Payload as embedded text plus its `data-encoding` (none, or `gzip-base64`). */
export function encodePayload(
  payload: ReportPayload,
  gzip: (data: Uint8Array) => Uint8Array,
  threshold = GZIP_THRESHOLD,
): { readonly text: string; readonly encoding?: 'gzip-base64' } {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= threshold) return { text: scriptSafeJson(json) };
  return { text: Buffer.from(gzip(bytes)).toString('base64'), encoding: 'gzip-base64' };
}

/**
 * Render the report document: `<!doctype html>`, `lang`, charset, viewport, title, an inline
 * style that paints the theme background before the viewer loads (no white flash), a
 * full-viewport `<kgdiff-viewer>`, the payload script, the inlined viewer bundle and, when
 * given, the compute add-on.
 */
export function renderReportHtml(options: ReportHtmlOptions): string {
  const { payload } = options;
  const view = payload.view ?? {};
  const theme = view.theme ?? 'auto';
  const locale = view.locale ?? 'en';
  // Titles come from graph metadata: no control or bidi characters in the tab title.
  const title = sanitize(
    payload.meta.title ?? `${payload.meta.before.name} → ${payload.meta.after.name}`,
  );
  const description = sanitize(options.description);
  const encoded = encodePayload(payload, options.gzip, options.gzipThreshold);
  const attrs = [
    `id="${VIEWER_ID}"`,
    // The report page is the viewer: its keyboard shortcuts apply to the whole page.
    'global-shortcuts',
    // Theme, language and panels travel in the payload's `view`, not as attributes: what the
    // reader chose in an earlier report (remembered by the viewer) wins over them.
    ...(view.mode ? [`mode="${escapeHtml(view.mode)}"`] : []),
    ...(view.scope ? [`scope="${escapeHtml(view.scope)}"`] : []),
  ].join(' ');
  const encodingAttr = encoded.encoding ? ` data-encoding="${encoded.encoding}"` : '';
  const style =
    `${themeStyle(theme)}html,body{margin:0;height:100%;overflow:hidden}` +
    'kgdiff-viewer{display:block;position:fixed;inset:0;width:100%;height:100%}' +
    '.kgdiff-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;' +
    'clip:rect(0 0 0 0);white-space:nowrap;border:0}' +
    'noscript p{font:15px/1.5 system-ui,sans-serif;margin:2rem;max-width:40rem}';
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(locale)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${escapeHtml(payload.meta.generator)}">`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<title>${escapeHtml(title)} · kgdiff</title>`,
    `<style>${style}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1 class="kgdiff-sr">${escapeHtml(title)}</h1>`,
    `<kgdiff-viewer ${attrs}></kgdiff-viewer>`,
    `<noscript><p>${escapeHtml(description)}. This interactive report needs JavaScript.</p></noscript>`,
    '</main>',
    `<script type="${PAYLOAD_TYPE}" data-for="${VIEWER_ID}"${encodingAttr}>${encoded.text}</script>`,
    `<script>${scriptSafeJs(options.bundle)}</script>`,
    ...(options.compute !== undefined ? [`<script>${scriptSafeJs(options.compute)}</script>`] : []),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
