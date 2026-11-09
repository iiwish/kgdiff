/** The viewer bundles the Rust reports embed (scripts/viewer-assets.ts, RFC 0002 §8). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSETS_DIR,
  copyViewerAssets,
  VIEWER_BUNDLES,
  VIEWER_DIST,
} from '../scripts/viewer-assets.ts';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kgdiff-viewer-assets-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('viewer assets', () => {
  it('copies the viewer and the compute add-on from the standalone build to the report crate', () => {
    expect(VIEWER_DIST.replaceAll('\\', '/')).toMatch(/packages\/viewer\/dist\/standalone$/);
    expect(ASSETS_DIR.replaceAll('\\', '/')).toMatch(/crates\/kgdiff-report\/assets$/);
    const from = scratch();
    const to = join(scratch(), 'assets');
    for (const name of VIEWER_BUNDLES) writeFileSync(join(from, name), `/* ${name} */`);
    const written = copyViewerAssets(from, to);
    expect(written).toEqual(VIEWER_BUNDLES.map((name) => join(to, name)));
    for (const name of VIEWER_BUNDLES) {
      expect(readFileSync(join(to, name), 'utf8')).toBe(`/* ${name} */`);
    }
  });

  it('names the build when a bundle is missing, and writes nothing', () => {
    const from = scratch();
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, 'kgdiff-viewer.js'), '/* viewer */');
    const to = join(scratch(), 'assets');
    expect(() => copyViewerAssets(from, to)).toThrow(
      /kgdiff-viewer-compute\.js not found .*build the viewer first/,
    );
    expect(() => readFileSync(join(to, 'kgdiff-viewer.js'))).toThrow();
  });
});
