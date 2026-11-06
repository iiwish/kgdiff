// @vitest-environment node
/**
 * The standalone IIFE builds, stays self-contained (no parsers, no compute module inside) and
 * within its size budget. Prints the minified and gzip sizes, and those of each ESM subpath
 * bundled on its own (what a host that imports only it ships).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const src = (file: string): string => fileURLToPath(new URL(`../src/${file}`, import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'kgdiff-viewer-standalone-'));

/** Target for the standalone viewer, min + gzip, without formats: not met yet. */
const BUDGET_KB = 90;
/**
 * Enforced ceiling (docs/architecture.md §Budgets). zlib builds compress differently: the
 * official Node binaries CI installs produce about 0.6 kB more than a Node linked against the
 * system zlib (Homebrew's), so the ceiling leaves room above both. Set well above today's size
 * (about 103 kB) so a feature fits without raising it each time; it still catches the parsers or
 * the compute module (tens of kB each) slipping into the bundle.
 */
const GUARD_KB = 130;

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function size(file: string): { min: number; gzip: number; text: string } {
  const text = readFileSync(join(outDir, file), 'utf8');
  return { min: Buffer.byteLength(text), gzip: gzipSync(text, { level: 9 }).length, text };
}

describe('standalone bundle', () => {
  it('builds the viewer IIFE and the compute add-on', async () => {
    await build({ configFile, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    await build({
      configFile,
      mode: 'compute',
      logLevel: 'silent',
      build: { outDir, emptyOutDir: false },
    });
    const viewer = size('kgdiff-viewer.js');
    const compute = size('kgdiff-viewer-compute.js');
    const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
    console.info(
      `[standalone] kgdiff-viewer.js ${kb(viewer.min)} min, ${kb(viewer.gzip)} gzip (budget ${BUDGET_KB} kB)` +
        ` · kgdiff-viewer-compute.js ${kb(compute.min)} min, ${kb(compute.gzip)} gzip`,
    );
    expect(viewer.text.startsWith('var KgdiffViewer=')).toBe(true);
    // Parsers and the compute module are loaded on demand, never bundled.
    expect(viewer.text).toContain('import(`@kgdiff/formats`)');
    expect(viewer.text).toContain('import(`@kgdiff/viewer/compute`)');
    expect(viewer.text).not.toMatch(/forceSimulation|N3\.Parser/);
    expect(viewer.text).toContain('customElements.define');
    expect(viewer.gzip / 1024).toBeLessThan(GUARD_KB);
    expect(compute.text).toContain('KgdiffCompute');
  }, 60_000);
});

/** The package's entry points (`exports`), by subpath. */
const SUBPATHS: Readonly<Record<string, string>> = {
  '.': 'index.ts',
  'elements/root': 'elements/root.ts',
  'elements/stage': 'elements/stage.ts',
  'elements/change-list': 'elements/change-list.ts',
  'elements/change-detail': 'elements/change-detail.ts',
  'elements/search': 'elements/search.ts',
  'elements/filters': 'elements/filters.ts',
  session: 'headless.ts',
  panels: 'panels.ts',
};

describe('ESM subpaths', () => {
  it('bundle on their own; an element without the root leaves the session out', async () => {
    // `.` defines everything: the standalone build, less starting the hydration.
    const sizes = await Promise.all(
      Object.entries(SUBPATHS).map(async ([name, entry]) => {
        const dir = join(outDir, 'esm', name.replace('/', '-'));
        await build({
          configFile,
          logLevel: 'silent',
          build: {
            outDir: dir,
            emptyOutDir: true,
            // One minified file each (as a host's bundler would ship it), not ESM chunks.
            lib: {
              entry: src(entry),
              formats: ['iife'],
              name: 'Entry',
              fileName: () => 'entry.js',
            },
          },
        });
        const text = readFileSync(join(dir, 'entry.js'), 'utf8');
        return {
          name,
          text,
          min: Buffer.byteLength(text),
          gzip: gzipSync(text, { level: 9 }).length,
        };
      }),
    );
    const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
    console.info(
      `[subpaths] ${sizes.map((s) => `${s.name} ${kb(s.min)} min, ${kb(s.gzip)} gzip`).join(' · ')}`,
    );
    const of = (name: string) => sizes.find((s) => s.name === name) as (typeof sizes)[number];
    // The session's load pipeline and review store come with the root, not with an element.
    for (const name of ['elements/change-list', 'elements/search', 'elements/filters']) {
      expect(of(name).text, name).not.toContain('kgdiff:review:');
      expect(of(name).gzip, name).toBeLessThan(of('elements/root').gzip);
    }
    expect(of('elements/root').text).toContain('kgdiff:review:');
    expect(of('session').text).not.toContain('customElements.define');
    // The panels syntax is for the CLI too: no DOM, nothing else.
    expect(of('panels').text).not.toMatch(/customElements|document\.|HTMLElement/);
    expect(of('panels').gzip).toBeLessThan(1024);
    for (const s of sizes) expect(s.gzip, s.name).toBeLessThanOrEqual(of('.').gzip);
  }, 120_000);
});
