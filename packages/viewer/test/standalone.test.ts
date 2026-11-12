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
/**
 * Ceiling of the compute add-on, gzip: kgdiff's layout-only WebAssembly module inlined as base64
 * with its glue, about 120.5 kB in 0.11 (RFC 0002 §7 measures it and optimizes it after 0.11). A
 * guard against growing by accident, not a target.
 */
const ADDON_GUARD_KB = 127;

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
    // No WebAssembly in the viewer, ever (RFC 0002 §7); the add-on carries the layout-only
    // module once, inlined, and leaves the full engine and the parsers to an import map.
    expect(viewer.text).not.toMatch(/WebAssembly|application\/wasm|\.wasm\b/);
    expect(compute.text.match(/data:application\/wasm;base64,/g)).toHaveLength(1);
    expect(compute.text).toContain('import(`@kgdiff/compute`)');
    expect(compute.text).not.toMatch(/(compute|formats)\.wasm/);
    // An IIFE has no `import.meta.url`: the inlined module must not be resolved against it.
    expect(compute.text).not.toMatch(/import\.meta|\{\}\.url/);
    expect(compute.gzip / 1024).toBeLessThan(ADDON_GUARD_KB);
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
  'elements/view-dock': 'elements/view-dock.ts',
  'elements/transport': 'elements/transport.ts',
  'elements/legend': 'elements/legend.ts',
  'elements/zoom': 'elements/zoom.ts',
  'elements/minimap': 'elements/minimap.ts',
  'elements/title': 'elements/title.ts',
  'elements/actions': 'elements/actions.ts',
  panels: 'panels.ts',
};

describe('ESM subpaths', () => {
  it('bundle on their own: the session comes with the root, the renderer with a stage', async () => {
    // `.` defines everything: the standalone build, less starting the hydration.
    // One build after another: concurrent builds of one config are not worth a rare race, and
    // a failure names its subpath.
    const sizes: { name: string; text: string; min: number; gzip: number }[] = [];
    for (const [name, entry] of Object.entries(SUBPATHS)) {
      const dir = join(outDir, 'esm', name.replace('/', '-'));
      try {
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
      } catch (error) {
        throw new Error(`building the ${name} subpath failed`, { cause: error });
      }
      const text = readFileSync(join(dir, 'entry.js'), 'utf8');
      sizes.push({
        name,
        text,
        min: Buffer.byteLength(text),
        gzip: gzipSync(text, { level: 9 }).length,
      });
    }
    const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
    console.info(
      `[subpaths] ${sizes.map((s) => `${s.name} ${kb(s.min)} min, ${kb(s.gzip)} gzip`).join(' · ')}`,
    );
    const of = (name: string) => sizes.find((s) => s.name === name) as (typeof sizes)[number];
    // Every element but the root and the stage: the regions and the chrome.
    const parts = Object.keys(SUBPATHS).filter(
      (name) =>
        name.startsWith('elements/') && name !== 'elements/root' && name !== 'elements/stage',
    );
    // The session's load pipeline and review store come with the root, not with an element.
    for (const name of parts) {
      expect(of(name).text, name).not.toContain('kgdiff:review:');
      expect(of(name).gzip, name).toBeLessThan(of('elements/root').gzip);
    }
    expect(of('elements/root').text).toContain('kgdiff:review:');
    // The renderer comes with a stage (each draws its own view), not with the root, nor with
    // the zoom buttons and the minimap, which act on a stage's view.
    const RENDERER = 'device-pixel-content-box';
    expect(of('elements/stage').text).toContain(RENDERER);
    expect(of('elements/root').text).not.toContain(RENDERER);
    for (const name of parts) expect(of(name).text, name).not.toContain(RENDERER);
    // The panels syntax is for the CLI too: no DOM, nothing else.
    expect(of('panels').text).not.toMatch(/customElements|document\.|HTMLElement/);
    expect(of('panels').gzip).toBeLessThan(1024);
    for (const s of sizes) expect(s.gzip, s.name).toBeLessThanOrEqual(of('.').gzip);
  }, 120_000);
});
