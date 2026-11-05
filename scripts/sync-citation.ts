/**
 * Keeps the `version` of CITATION.cff at the version the packages share (one fixed Changesets
 * group). `pnpm version-packages` runs it after `changeset version`:
 *
 *   pnpm tsx scripts/sync-citation.ts
 *
 * tests/release.test.ts fails when the two drift apart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
export const CITATION_FILE = join(ROOT, 'CITATION.cff');

/** Top-level `version:` line (nested keys are indented). */
const VERSION_LINE = /^version:[ \t]*(.*)$/m;

/** The version of the published packages, read from the CLI's package.json. */
export function packagesVersion(root: string = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string') throw new Error('packages/cli/package.json has no version.');
  return pkg.version;
}

/** The top-level `version` of a CITATION.cff, unquoted, or `undefined`. */
export function citationVersion(citation: string): string | undefined {
  const value = VERSION_LINE.exec(citation)?.[1]?.trim();
  return value?.replace(/^(["'])(.*)\1$/, '$2');
}

/** `citation` with its top-level `version` set to `version`. */
export function withCitationVersion(citation: string, version: string): string {
  if (!VERSION_LINE.test(citation)) {
    throw new Error('CITATION.cff has no top-level `version:` line.');
  }
  return citation.replace(VERSION_LINE, `version: ${version}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = readFileSync(CITATION_FILE, 'utf8');
  const next = withCitationVersion(text, packagesVersion());
  if (next !== text) writeFileSync(CITATION_FILE, next);
}
