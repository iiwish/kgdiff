/**
 * Copies the standalone viewer bundles into `crates/kgdiff-report/assets/`, where the Rust
 * crate's `embed-viewer` feature compiles them into kgdiff's HTML reports (RFC 0002, §8,
 * "Build order"). `pnpm build:viewer-assets` builds the viewer first and then runs this:
 *
 *   pnpm build:viewer-assets
 *
 * The assets are git-ignored; `cargo package` takes them (the crate's `include`).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
export const VIEWER_DIST = join(ROOT, 'packages', 'viewer', 'dist', 'standalone');
export const ASSETS_DIR = join(ROOT, 'crates', 'kgdiff-report', 'assets');

/** The bundles a report inlines: the viewer, and the compute add-on that lays it out (D-10). */
export const VIEWER_BUNDLES = ['kgdiff-viewer.js', 'kgdiff-viewer-compute.js'] as const;

/** Copies every bundle from `from` to `to`; throws, naming the build, when one is missing. */
export function copyViewerAssets(from: string = VIEWER_DIST, to: string = ASSETS_DIR): string[] {
  const missing = VIEWER_BUNDLES.filter((name) => !existsSync(join(from, name)));
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} not found in ${relative(ROOT, from)}: build the viewer first (pnpm --filter "@kgdiff/viewer..." build).`,
    );
  }
  mkdirSync(to, { recursive: true });
  return VIEWER_BUNDLES.map((name) => {
    copyFileSync(join(from, name), join(to, name));
    return join(to, name);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const path of copyViewerAssets()) console.log(`wrote ${relative(ROOT, path)}`);
}
