import { gunzipSync } from 'node:zlib';
import { type DiffJSON, unpackDiffJSON } from '@kgdiff/core';
import type { ReportPayload } from '@kgdiff/viewer';
import { describe, expect, it } from 'vitest';
import {
  createGzip,
  encodePayload,
  escapeHtml,
  renderReportHtml,
  scriptSafeJs,
  scriptSafeJson,
} from '../src/index.js';
import { CliError, dataset, extractPayload, FAKE_BUNDLE, FAKE_COMPUTE, run } from './helpers.js';

const BEFORE = JSON.stringify({
  meta: { name: 'kg', version: '1' },
  nodes: [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
  ],
  edges: [{ source: 'a', target: 'b', predicate: 'knows' }],
});
const AFTER = JSON.stringify({
  meta: { name: 'kg', version: '2' },
  nodes: [
    { id: 'a', label: 'Alpha</script><script>alert(1)</script>' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: '<!-- Gamma -->' },
  ],
  edges: [
    { source: 'a', target: 'b', predicate: 'knows' },
    { source: 'c', target: 'a', predicate: 'knows' },
  ],
});
const files = { 'v1.json': BEFORE, 'v2.json': AFTER };

/** The diff a report embeds, unpacked. */
const diffOf = (payload: ReportPayload): DiffJSON =>
  payload.diff.format === 'kgdiff.diff.packed' ? unpackDiffJSON(payload.diff) : payload.diff;

async function report(extra: string[] = [], options: Parameters<typeof run>[1] = {}) {
  const r = await run(['v1.json', 'v2.json', '-o', 'report.html', '-q', ...extra], {
    files,
    ...options,
  });
  expect(r.code, r.stderr).toBe(0);
  return r.file('report.html');
}

describe('HTML report', () => {
  it('is a complete, accessible single-file document', async () => {
    const html = await report(['--locale', 'zh-CN']);
    expect(
      html.startsWith('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">'),
    ).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<title>kg 1 → 2 · kgdiff</title>');
    expect(html).toContain('<meta name="generator" content="kgdiff ');
    expect(html).toMatch(
      /<meta name="description" content="2 组共 \d+ 处变化 · 节点 2 → 3 · 关系 1 → 2">/,
    );
    expect(html).toContain('<main>\n<h1 class="kgdiff-sr">kg 1 → 2</h1>');
    // Theme and language travel in the payload's view (a reader's earlier choice wins).
    expect(html).toContain('<kgdiff-viewer id="kgdiff" global-shortcuts></kgdiff-viewer>');
    expect((extractPayload(html) as { payload: ReportPayload }).payload.view).toEqual({
      locale: 'zh-CN',
    });
    expect(html).toContain('<noscript>');
    expect(html).toContain('<script type="application/kgdiff+json" data-for="kgdiff">');
    expect(html).toContain(`<script>${FAKE_BUNDLE}</script>`);
    expect(html.indexOf('application/kgdiff+json')).toBeLessThan(html.indexOf(FAKE_BUNDLE));
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('paints the theme background before the viewer loads', async () => {
    const auto = await report();
    expect(auto).toContain('html,body{background:#0B0E14;color:#E7EBF3}');
    expect(auto).toContain(
      '@media (prefers-color-scheme:light){html,body{background:#F7F8FA;color:#0F172A}}',
    );
    const light = await report(['--theme', 'light']);
    expect(light).toContain(':root{color-scheme:light}html,body{background:#F7F8FA');
    expect(light).not.toContain('#0B0E14');
    expect(light).not.toContain('theme=');
    expect((extractPayload(light) as { payload: ReportPayload }).payload.view?.theme).toBe('light');
    const dark = await report(['--theme', 'dark', '--mode', 'replay']);
    expect(dark).not.toContain('prefers-color-scheme');
    expect(dark).toContain('mode="replay"');
    expect(dark).not.toContain('scope=');
  });

  it('sets the scope, and reads the legacy --mode changes as overlay + --scope changes', async () => {
    const scoped = await report(['--mode', 'swipe', '--scope', 'changes']);
    expect(scoped).toContain('mode="swipe" scope="changes"');
    expect((extractPayload(scoped) as { payload: ReportPayload }).payload.view).toMatchObject({
      mode: 'swipe',
      scope: 'changes',
    });
    const legacy = await report(['--mode', 'changes']);
    expect(legacy).toContain('mode="overlay" scope="changes"');
    // An explicit --scope wins over the one the legacy mode implies.
    expect(await report(['--mode', 'changes', '--scope', 'all'])).toContain(
      'mode="overlay" scope="all"',
    );
  });

  it('embeds the precomputed diff, layout, meta and view preferences', async () => {
    const html = await report(['--mode', 'swipe', '--title', 'Release <2>']);
    const { encoding, payload } = extractPayload(html) as {
      encoding?: string;
      payload: ReportPayload;
    };
    expect(encoding).toBeUndefined();
    expect(payload.format).toBe('kgdiff.report');
    expect(payload.version).toBe(1);
    expect(payload.diff.format).toBe('kgdiff.diff.packed');
    expect(diffOf(payload).nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(payload.layout?.format).toBe('kgdiff.layout');
    expect(Object.keys(payload.layout!.positions).sort()).toEqual(['a', 'b', 'c']);
    expect(payload.meta).toMatchObject({
      title: 'Release <2>',
      generatedAt: '2026-11-01T12:00:00.000Z',
      before: { name: 'kg 1', format: 'json' },
      after: { name: 'kg 2', format: 'json' },
    });
    expect(payload.meta.generator).toMatch(/^kgdiff \d+\.\d+\.\d+$/);
    expect(payload.view).toEqual({ mode: 'swipe', locale: 'en' });
    expect(html).toContain('<title>Release &lt;2&gt; · kgdiff</title>');
  });

  it('embeds --panels in the view, not as an attribute', async () => {
    const html = await report(['--panels', 'detail:collapsed', '--panels', 'minimap:hidden']);
    expect(html).not.toContain('panels=');
    expect((extractPayload(html) as { payload: ReportPayload }).payload.view).toEqual({
      locale: 'en',
      panels: { detail: 'collapsed', minimap: 'hidden' },
    });
  });

  it('cannot be broken out of by labels', async () => {
    const html = await report();
    const scripts = html.match(/<script\b/gi) ?? [];
    expect(scripts).toHaveLength(2);
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).not.toContain('<!--');
    const { payload } = extractPayload(html) as { payload: ReportPayload };
    const labels = diffOf(payload).nodes.map((n) => n.after?.label ?? n.id);
    expect(labels).toContain('Alpha</script><script>alert(1)</script>');
  });

  it('escapes </script and <!-- in the inlined bundle', async () => {
    const bundle =
      'const a = "</script><script>x()</script>"; const b = "<!--"; const c = /<\\/SCRIPT/;';
    const html = await report([], { bundle });
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).toContain('const a = "<\\/script><script>x()<\\/script>"');
    expect(html).toContain('const b = "\\x3C!--"');
    // The rewritten code still means the same thing.
    const inlined = /<script>([\s\S]*)<\/script>\n<\/body>/.exec(html)?.[1] ?? '';
    const evaluate = new Function(`${inlined}; return [a, b];`) as () => string[];
    expect(evaluate()).toEqual(['</script><script>x()</script>', '<!--']);
  });

  it('is byte-identical for identical input with --reproducible', async () => {
    const first = await report(['--reproducible'], { now: new Date('2020-01-01T00:00:00Z') });
    const second = await report(['--reproducible'], { now: new Date('2030-06-15T08:30:00Z') });
    expect(first).toBe(second);
    expect(first).not.toContain('generatedAt');
    const stamped = await report([], { now: new Date('2030-06-15T08:30:00Z') });
    expect(stamped).toContain('"generatedAt":"2030-06-15T08:30:00.000Z"');
  });

  it('gzips and base64-encodes payloads above 512 kB', async () => {
    const nodes = Array.from({ length: 900 }, (_, i) => ({
      id: `n${i}`,
      label: `Node ${i}`,
      attrs: { note: `${'lorem ipsum dolor sit amet '.repeat(12)}${i}` },
    }));
    const edges = nodes
      .slice(1)
      .map((n, i) => ({ source: n.id, target: `n${i}`, predicate: 'next' }));
    const big = JSON.stringify({ nodes, edges });
    const r = await run(['empty.json', 'big.json', '-o', 'big.html', '-q', '--reproducible'], {
      files: { 'empty.json': JSON.stringify({ nodes: [], edges: [] }), 'big.json': big },
    });
    expect(r.code, r.stderr).toBe(0);
    const html = r.file('big.html');
    expect(html).toContain('data-encoding="gzip-base64"');
    const { encoding, payload } = extractPayload(html) as {
      encoding?: string;
      payload: ReportPayload;
    };
    expect(encoding).toBe('gzip-base64');
    expect(diffOf(payload).nodes).toHaveLength(900);
    const body = /data-encoding="gzip-base64">([^<]*)</.exec(html)?.[1] ?? '';
    const bytes = Buffer.from(body, 'base64');
    expect(bytes[9]).toBe(0xff); // platform-independent gzip header
    expect(JSON.stringify(payload).length).toBeGreaterThan(512 * 1024);
  }, 30_000);
});

describe('compute add-on', () => {
  // Above the layout's large-graph threshold (3,000 nodes) the layout covers only the changes.
  const many = (renamed: boolean) =>
    JSON.stringify({
      nodes: Array.from({ length: 3200 }, (_, i) => ({
        id: `n${i}`,
        label: renamed && i === 7 ? 'Renamed seven' : `Node ${i}`,
      })),
      edges: Array.from({ length: 3199 }, (_, i) => ({
        source: `n${i + 1}`,
        target: `n${i}`,
        predicate: 'next',
      })),
    });
  const large = { 'big1.json': many(false), 'big2.json': many(true) };

  it('is left out of reports whose layout covers the whole graph', async () => {
    const html = await report();
    expect(html).not.toContain(FAKE_COMPUTE);
    expect(extractPayload(html).payload).toMatchObject({ layout: { scope: 'all' } });
  });

  it('is inlined right after the viewer when the layout covers only the changes', async () => {
    const r = await run(['big1.json', 'big2.json', '-o', 'r.html', '-q'], { files: large });
    expect(r.code, r.stderr).toBe(0);
    const html = r.file('r.html');
    expect(extractPayload(html).payload).toMatchObject({ layout: { scope: 'changes' } });
    expect(html).toContain(
      `<script>${FAKE_BUNDLE}</script>\n<script>${FAKE_COMPUTE}</script>\n</body>`,
    );
  }, 30_000);

  it('is skipped with --no-compute', async () => {
    const r = await run(['big1.json', 'big2.json', '-o', 'r.html', '-q', '--no-compute'], {
      files: large,
    });
    expect(r.file('r.html')).not.toContain(FAKE_COMPUTE);
  }, 30_000);

  it('only warns when the add-on is missing', async () => {
    const r = await run(['big1.json', 'big2.json', '-o', 'r.html'], {
      files: large,
      computeBundle: new CliError('viewer-missing', 'The compute add-on was not found.'),
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      'warning: The compute add-on was not found. The report is written without it',
    );
    expect(r.file('r.html')).not.toContain(FAKE_COMPUTE);
  }, 30_000);
});

describe('HTML building blocks', () => {
  const payload: ReportPayload = {
    format: 'kgdiff.report',
    version: 1,
    diff: {} as ReportPayload['diff'],
    layout: {} as ReportPayload['layout'],
    meta: { generator: 'kgdiff 0.0.0', before: { name: 'a' }, after: { name: 'b' } },
  };

  it('escapes HTML text and attributes', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('keeps JSON valid while removing every <', () => {
    const json = JSON.stringify({ s: '</script><!-- \u2028' });
    const safe = scriptSafeJson(json);
    expect(safe).not.toContain('<');
    expect(JSON.parse(safe)).toEqual(JSON.parse(json));
  });

  it('rewrites script terminators case-insensitively', () => {
    expect(scriptSafeJs('"</SCRIPT>"')).toBe('"<\\/SCRIPT>"');
  });

  it('switches to gzip above the threshold and round-trips', async () => {
    const gzip = await createGzip();
    expect(encodePayload(payload, gzip).encoding).toBeUndefined();
    const encoded = encodePayload(payload, gzip, 10);
    expect(encoded.encoding).toBe('gzip-base64');
    expect(JSON.parse(gunzipSync(Buffer.from(encoded.text, 'base64')).toString())).toEqual(payload);
  });

  it('inlines the compute add-on after the viewer, escaped', async () => {
    const gzip = await createGzip();
    const html = renderReportHtml({
      payload,
      bundle: 'main()',
      compute: 'x = "</script>"',
      gzip,
      description: 'd',
    });
    expect(html).toContain('<script>main()</script>\n<script>x = "<\\/script>"</script>\n</body>');
  });

  it('renders deterministically and defaults the title', async () => {
    const gzip = await createGzip();
    const options = { payload, bundle: '/**/', gzip, description: 'd' };
    expect(renderReportHtml(options)).toBe(renderReportHtml(options));
    expect(renderReportHtml(options)).toContain('<title>a → b · kgdiff</title>');
    expect(renderReportHtml(options)).toContain('<html lang="en">');
  });
});

describe('HTML report from a dataset', () => {
  it('builds the ontology-release report', async () => {
    const d = dataset('ontology-release');
    const r = await run([d.before, d.after, ...d.flags, '-o', 'r.html', '-q', '--reproducible']);
    expect(r.code, r.stderr).toBe(0);
    const { payload } = extractPayload(r.file('r.html')) as { payload: ReportPayload };
    expect(payload.diff.hunks).toHaveLength(22);
    expect(payload.meta.before).toEqual({ name: 'mhd 2026-09-01', format: 'obo' });
  }, 30_000);
});
