// @vitest-environment node
/**
 * The standalone IIFE builds, stays self-contained (no parsers, no compute module inside) and
 * within its size budget. Prints the minified and gzip sizes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'kgdiff-viewer-standalone-'));

/** Target for the standalone viewer, min + gzip, without formats: not met yet. */
const BUDGET_KB = 90;
/**
 * Enforced ceiling (docs/architecture.md §Budgets). zlib builds compress differently: the
 * official Node binaries CI installs produce about 0.6 kB more than a Node linked against the
 * system zlib (Homebrew's), so the ceiling leaves room above both. Raised from 100 kB for the
 * consistency checks of diffs read from JSON and the decoder of packed report payloads.
 */
const GUARD_KB = 105;

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
