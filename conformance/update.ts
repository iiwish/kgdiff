/**
 * Regenerates the conformance corpus from the TypeScript implementation:
 *
 *   pnpm conformance:update
 *
 * Writes `manifest.json`, `primitives/*` and, for every case, `case.json`, `expected/*` and the
 * inputs copied from `examples/datasets`. Of what is on disk, it only removes generated files
 * that are no longer generated (below a case's `expected/`, and `primitives/`). Authored inputs
 * are never touched; a directory under `cases/` that no case defines is reported, not deleted.
 * Review the diff before committing: a changed expected file is a behaviour change every
 * implementation has to follow.
 */
import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CASES } from './cases.js';
import { authoredInputs, filesOnDisk, generateCorpus, OS_FILES, ROOT } from './corpus.js';

const corpus = await generateCorpus();
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
