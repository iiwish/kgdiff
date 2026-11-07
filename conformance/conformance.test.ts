/**
 * The TypeScript implementation reproduces the conformance corpus byte for byte: every expected
 * file, every primitive vector and the manifest are generated again in memory and compared with
 * the files on disk, and nothing else lives under `cases/` or `primitives/`.
 *
 * Every recorded document also validates against its JSON Schema in `packages/core/schema/`.
 *
 * When this fails after an intended behaviour change, run `pnpm conformance:update` and review
 * the diff: the corpus is what every other implementation is checked against.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { CASES } from './cases.js';
import {
  authoredInputs,
  type Corpus,
  filesOnDisk,
  generateCase,
  generateShared,
  OS_FILES,
  REPO,
  ROOT,
} from './corpus.js';

const decoder = new TextDecoder();

const SCHEMA_BASE = 'https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/';
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: true });
for (const name of ['graph', 'delta', 'diff', 'diff-packed']) {
  ajv.addSchema(
    JSON.parse(readFileSync(join(REPO, 'packages/core/schema', `${name}.v1.json`), 'utf8')),
  );
}
/** The JSON Schema of each recorded document, by path below `expected/`. */
const SCHEMA_OF: Readonly<Record<string, string>> = {
  'graph.before.json': 'graph',
  'graph.after.json': 'graph',
  'apply.json': 'graph',
  'diff.json': 'diff',
  'cli/diff.pretty.json': 'diff',
  'diff.packed.json': 'diff-packed',
  'delta.json': 'delta',
  'delta.inverse.json': 'delta',
};

/** Where two byte strings first differ, as a readable message (line, generated, on disk). */
function describeMismatch(path: string, generated: Uint8Array, disk: Uint8Array): string {
  const a = decoder.decode(generated).split('\n');
  const b = decoder.decode(disk).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      const clip = (s: string | undefined) => (s === undefined ? '<end of file>' : s.slice(0, 300));
      return `${path}:${i + 1} differs\n  generated: ${clip(a[i])}\n  on disk:   ${clip(b[i])}`;
    }
  }
  return `${path} differs (${generated.byteLength} bytes generated, ${disk.byteLength} on disk)`;
}

/** Every generated file is on disk with the same bytes, and the directory holds nothing else. */
function expectReproduced(files: Corpus, top: string, extra: readonly string[] = []): void {
  const problems: string[] = [];
  for (const [path, data] of files) {
    const absolute = join(ROOT, path);
    if (!existsSync(absolute)) {
      problems.push(`${path} is missing`);
      continue;
    }
    const disk = readFileSync(absolute);
    if (!Buffer.from(data).equals(disk)) problems.push(describeMismatch(path, data, disk));
  }
  const known = new Set([...files.keys(), ...extra]);
  for (const path of filesOnDisk(top)) {
    if (!known.has(path)) problems.push(`${path} is not part of the corpus`);
  }
  for (const path of extra) if (!existsSync(join(ROOT, path))) problems.push(`${path} is missing`);
  expect(
    problems,
    `${problems.join('\n')}\n\nRun \`pnpm conformance:update\` if the change is intended, and review the diff.`,
  ).toEqual([]);
}

describe('conformance corpus', () => {
  it.each(CASES.map((c) => c.id))('reproduces case %s', async (id) => {
    const def = CASES.find((c) => c.id === id);
    if (!def) throw new Error(`unknown case ${id}`);
    expectReproduced(await generateCase(def), `cases/${id}`, authoredInputs(def));
  });

  it('reproduces the primitive vectors and the manifest', () => {
    const shared = generateShared();
    const primitives: Corpus = new Map([...shared].filter(([p]) => p.startsWith('primitives/')));
    expectReproduced(primitives, 'primitives');
    const manifest = shared.get('manifest.json');
    expect(
      manifest && Buffer.from(manifest).equals(readFileSync(join(ROOT, 'manifest.json'))),
    ).toBe(true);
  });

  it.each(CASES.map((c) => c.id))('case %s: its documents validate against their schemas', (id) => {
    const errors: string[] = [];
    for (const [file, schema] of Object.entries(SCHEMA_OF)) {
      const path = join(ROOT, 'cases', id, 'expected', file);
      if (!existsSync(path)) continue;
      const validate = ajv.getSchema(`${SCHEMA_BASE}${schema}.v1.json`);
      if (!validate) throw new Error(`${schema}.v1.json is not registered`);
      if (!validate(JSON.parse(readFileSync(path, 'utf8')))) {
        errors.push(`${file}: ${ajv.errorsText(validate.errors)}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('has one directory per case', () => {
    const dirs = readdirSync(join(ROOT, 'cases'))
      .filter((name) => !OS_FILES.has(name))
      .sort();
    expect(dirs).toEqual(CASES.map((c) => c.id).sort());
  });
});
