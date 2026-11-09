/**
 * Self-contained HTML reports written in the browser, in the exact shape `kgdiff -o report.html`
 * produces (crates/kgdiff-report/src/html.rs): the standalone viewer bundle (IIFE) inlined next to a
 * `<script type="application/kgdiff+json">` payload. The bundle is the site's own build of
 * `packages/viewer/src/standalone.ts` (see build/plugins.ts), fetched from the same origin only
 * when a report is requested, so reports open offline and match the site's viewer version.
 *
 * Mirrors the CLI's `render_report_html`; the differences are browser-only details: base64 via
 * `btoa` instead of `Buffer`, and gzip via `CompressionStream` (non-deterministic header bytes
 * do not matter here, the report carries a timestamp anyway).
 */
import type { ReportPayload, ThemePreference } from '@kgdiff/viewer';

const PAYLOAD_TYPE = 'application/kgdiff+json';
/** Payloads larger than this (UTF-8 bytes of the JSON) are embedded gzip + base64. */
const GZIP_THRESHOLD = 512 * 1024;
const VIEWER_ID = 'kgdiff';
const DARK = { background: '#0B0E14', text: '#E7EBF3' };
const LIGHT = { background: '#F7F8FA', text: '#0F172A' };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe inside <script>: `<` → `\u003c`, U+2028 / U+2029 escaped. Still valid JSON. */
function scriptSafeJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Inline JavaScript safe inside a classic <script>. */
function scriptSafeJs(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '\\x3C!--');
}

function themeStyle(theme: ThemePreference): string {
  const rule = (c: { background: string; text: string }): string =>
    `html,body{background:${c.background};color:${c.text}}`;
  if (theme === 'dark') return `:root{color-scheme:dark}${rule(DARK)}`;
  if (theme === 'light') return `:root{color-scheme:light}${rule(LIGHT)}`;
  return `:root{color-scheme:dark light}${rule(DARK)}@media (prefers-color-scheme:light){${rule(LIGHT)}}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(
      new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodePayload(
  payload: ReportPayload,
): Promise<{ readonly text: string; readonly encoding?: 'gzip-base64' }> {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= GZIP_THRESHOLD || typeof CompressionStream !== 'function') {
    return { text: scriptSafeJson(json) };
  }
  return { text: bytesToBase64(await gzip(bytes)), encoding: 'gzip-base64' };
}

export interface ReportHtmlOptions {
  readonly payload: ReportPayload;
  /** Source of the standalone viewer bundle. */
  readonly bundle: string;
  /** Source of the compute add-on, for reports whose layout covers only the changes. */
  readonly compute?: string;
  readonly description: string;
}

export async function renderReportHtml(options: ReportHtmlOptions): Promise<string> {
  const { payload } = options;
  const view = payload.view ?? {};
  const theme = view.theme ?? 'auto';
  const locale = view.locale ?? 'en';
  const title = payload.meta.title ?? `${payload.meta.before.name} → ${payload.meta.after.name}`;
  const encoded = await encodePayload(payload);
  const attrs = [
    `id="${VIEWER_ID}"`,
    // Theme and language travel in the payload's view: a reader's earlier choice wins.
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
    `<meta name="description" content="${escapeHtml(options.description)}">`,
    `<title>${escapeHtml(title)} · kgdiff</title>`,
    `<style>${style}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1 class="kgdiff-sr">${escapeHtml(title)}</h1>`,
    `<kgdiff-viewer ${attrs}></kgdiff-viewer>`,
    `<noscript><p>${escapeHtml(options.description)}. This interactive report needs JavaScript.</p></noscript>`,
    '</main>',
    `<script type="${PAYLOAD_TYPE}" data-for="${VIEWER_ID}"${encodingAttr}>${encoded.text}</script>`,
    `<script>${scriptSafeJs(options.bundle)}</script>`,
    ...(options.compute !== undefined ? [`<script>${scriptSafeJs(options.compute)}</script>`] : []),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Save `text` as a file through a temporary object URL. */
export function downloadText(text: string, filename: string, type = 'text/html'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file-system friendly slug. */
export function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'kgdiff'
  );
}
