/**
 * Pins what stays in TypeScript (`read-path.ts`): the source files of the packages are exactly
 * the listed ones, so compute code cannot come back unnoticed, and the read path takes only
 * types from the entry, whose compute functions load WebAssembly.
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

describe.each(READ_PATH)('what stays in TypeScript of $dir', ({ dir, entry, keep }) => {
  it('has exactly the listed source files', () => {
    const listed = [...entry, ...keep];
    expect(new Set(listed).size, 'a file is listed twice').toBe(listed.length);
    expect([...listed].sort()).toEqual(sourceFiles(dir));
  });

  it('keeps the read path to itself and the types of the entry', () => {
    const kept = new Set(keep);
    const entries = new Set(entry);
    const crossings: string[] = [];
    for (const file of keep) {
      const source = readFileSync(join(root, dir, file), 'utf8');
      for (const { specifier, typeOnly } of relativeImports(source)) {
        const target = resolve(file, specifier);
        if (entries.has(target)) {
          if (!typeOnly) {
            crossings.push(`${file} imports the entry ${target} for values (use \`import type\`)`);
          }
        } else if (!kept.has(target)) crossings.push(`${file} imports ${target}, not listed`);
      }
    }
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
