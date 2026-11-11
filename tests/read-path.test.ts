/**
 * Pins the boundary between the read path and the compute code phase 5 deletes
 * (`read-path.ts`): deleting the `remove` files must not break any `keep` file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { READ_PATH } from './read-path.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Relative imports and re-exports of a module, with whether they are type-only (`import type`,
 * `export type`). Inline `type` modifiers count as value imports. Package imports are skipped.
 */
function relativeImports(source: string): { specifier: string; typeOnly: boolean }[] {
  const statement = /^(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?'(\.[^']*)';/gm;
  const dynamic = /\bimport\(\s*'(\.[^']*)'\s*\)/g;
  return [
    ...[...source.matchAll(statement)].map((m) => ({
      specifier: m[2] as string,
      typeOnly: m[1] !== undefined,
    })),
    ...[...source.matchAll(dynamic)].map((m) => ({ specifier: m[1] as string, typeOnly: false })),
  ];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.split('\\').join('/'))
    .sort();
}

/** `./x.js` imported from `from` (a path relative to the package's `src`) → `x.ts`. */
function resolve(from: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(from), specifier.replace(/\.js$/, '.ts')));
}

describe.each(READ_PATH)('read path of $dir', ({ dir, entry, keep, remove }) => {
  it('assigns every source file to exactly one group', () => {
    const listed = [...entry, ...keep, ...remove];
    expect(new Set(listed).size, 'a file is listed twice').toBe(listed.length);
    expect([...listed].sort()).toEqual(sourceFiles(dir));
  });

  it('keeps every file of the read path free of imports of the compute code', () => {
    const removed = new Set(remove);
    const entries = new Set(entry);
    const crossings: string[] = [];
    for (const file of keep) {
      const source = readFileSync(join(root, dir, file), 'utf8');
      for (const { specifier, typeOnly } of relativeImports(source)) {
        const target = resolve(file, specifier);
        if (removed.has(target)) crossings.push(`${file} imports ${target}`);
        else if (entries.has(target) && !typeOnly) {
          crossings.push(`${file} imports the entry ${target} for values (use \`import type\`)`);
        }
      }
    }
    // Every keep file is checked, so the transitive closure of `keep` stays inside `keep` and
    // the entry's types: no chain of imports reaches a removed file.
    expect(crossings, relative(root, join(root, dir))).toEqual([]);
  });
});

describe('relativeImports', () => {
  it('finds multi-line, type-only, re-export and dynamic imports', () => {
    const source = [
      "import { a } from './a.js';",
      'import type {',
      '  B,',
      "} from './b.js';",
      "import { type C, d } from './c.js';",
      "export * from './e.js';",
      "export type { F } from './f.js';",
      "import './g.js';",
      "import { h } from '@kgdiff/core';",
      "export function x(): string { return 'from ./y.js'; }",
      "const lazy = () => import('./z.js');",
    ].join('\n');
    expect(relativeImports(source)).toEqual([
      { specifier: './a.js', typeOnly: false },
      { specifier: './b.js', typeOnly: true },
      { specifier: './c.js', typeOnly: false },
      { specifier: './e.js', typeOnly: false },
      { specifier: './f.js', typeOnly: true },
      { specifier: './g.js', typeOnly: false },
      { specifier: './z.js', typeOnly: false },
    ]);
  });
});
