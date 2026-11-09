/**
 * Regenerates the conformance corpus: the library outputs from the TypeScript packages, what the
 * CLI produces (the CLI runs and `report.json`) from the Rust `kgdiff` (RFC 0002, §9, "Corpus
 * ownership"), which it builds first, with the viewer bundles a report embeds:
 *
 *   pnpm build:viewer-assets   # once, and after the viewer changed
 *   pnpm conformance:update
 *
 * `--bin <path>` records with that executable instead of building one.
 *
 * Writes `manifest.json`, `primitives/*` and, for every case, `case.json`, `expected/*` and the
 * inputs copied from `examples/datasets`. Of what is on disk, it only removes generated files
 * that are no longer generated (below a case's `expected/`, and `primitives/`). Authored inputs
 * are never touched; a directory under `cases/` that no case defines is reported, not deleted.
 * Review the diff before committing: a changed expected file is a behaviour change every
 * implementation has to follow.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CASES } from './cases.js';
import {
  authoredInputs,
  filesOnDisk,
  generateCorpus,
  OS_FILES,
  REPO,
  ROOT,
  recorder,
} from './corpus.js';

/** The Rust kgdiff to record with: `--bin <path>`, or the release build, built now. */
function kgdiffBinary(argv: readonly string[]): string {
  const at = argv.indexOf('--bin');
  if (at !== -1) {
    const path = argv[at + 1];
    if (path === undefined || path.startsWith('-')) {
      throw new Error('--bin needs the path of an executable');
    }
    return resolve(path);
  }
  if (!existsSync(join(REPO, 'crates/kgdiff-report/assets/kgdiff-viewer.js'))) {
    throw new Error(
      'conformance: the viewer bundles kgdiff embeds are missing; run `pnpm build:viewer-assets` first.',
    );
  }
  const build = spawnSync('cargo', ['build', '--release', '-p', 'kgdiff', '--locked'], {
    cwd: REPO,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) throw new Error('conformance: `cargo build -p kgdiff` failed.');
  return join(REPO, 'target/release', process.platform === 'win32' ? 'kgdiff.exe' : 'kgdiff');
}

const corpus = await generateCorpus(await recorder(kgdiffBinary(process.argv.slice(2))));
const keep = new Set([...corpus.keys(), ...authoredInputs()]);
const ids = new Set(CASES.map((c) => c.id));
const generated = (path: string): boolean => {
  if (path.startsWith('primitives/')) return true;
  const [top, id, sub] = path.split('/');
  return top === 'cases' && id !== undefined && ids.has(id) && sub === 'expected';
};

let removed = 0;
for (const path of filesOnDisk()) {
  if (!keep.has(path) && generated(path)) {
    rmSync(join(ROOT, path));
    removed++;
  }
}
for (const [path, data] of corpus) {
  const absolute = join(ROOT, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, data);
}
/** Removes empty directories below `dir` (deepest first). */
function pruneEmpty(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmpty(join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}
for (const id of ids) pruneEmpty(join(ROOT, 'cases', id, 'expected'));

const unknown = readdirSync(join(ROOT, 'cases')).filter(
  (name) => !ids.has(name) && !OS_FILES.has(name),
);
console.log(
  `conformance: wrote ${corpus.size} files${removed > 0 ? `, removed ${removed} stale ones` : ''}.`,
);
if (unknown.length > 0) {
  console.warn(
    `conformance: no case defines ${unknown.map((name) => `cases/${name}`).join(', ')}; remove ${unknown.length === 1 ? 'it' : 'them'} by hand if ${unknown.length === 1 ? 'it is' : 'they are'} no longer needed.`,
  );
}
