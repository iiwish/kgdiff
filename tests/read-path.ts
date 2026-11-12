/**
 * What stays in TypeScript (RFC 0002, "What stays in TypeScript"): the read path of
 * `@kgdiff/core` and `@kgdiff/layout`, file by file, and the entry of each package, including
 * `@kgdiff/formats`, whose parsers kgdiff's engine (`@kgdiff/compute`) replaced (since 0.11.1 it
 * re-exports the parsers' types and `FORMAT_EXTENSIONS` of `@kgdiff/compute`, which are
 * `@kgdiff/core`'s: core's `formats.ts`, with its asynchronous parsers in the entry). 0.11 deleted the
 * TypeScript compute code; this list is checked against the code (`read-path.test.ts`) so that
 * none comes back unnoticed: every source file of these packages is listed, and adding one means
 * adding it here, where a reviewer sees it.
 *
 * - `keep`: the read path, synchronous, without WebAssembly (what the viewer needs to read a
 *   report). Only `import type` of the entry, for the public types it declares.
 * - `entry`: the package's public entry. Its compute functions are asynchronous and run on
 *   `@kgdiff/compute`, which core and layout load with a dynamic `import()`.
 *
 * Paths are relative to the package's `src` directory.
 */
export interface ReadPathPackage {
  readonly dir: string;
  readonly entry: readonly string[];
  readonly keep: readonly string[];
}

export const READ_PATH: readonly ReadPathPackage[] = [
  {
    dir: 'packages/core/src',
    entry: ['index.ts'],
    keep: [
      'canonical.ts',
      'computed.ts',
      'consistency.ts',
      'delta.ts',
      'diff-index.ts',
      'errors.ts',
      'formats.ts',
      'graph-json.ts',
      'hunk-summary.ts',
      'i18n.ts',
      'json.ts',
      'model.ts',
      'normalize.ts',
      'options.ts',
      'packed.ts',
      'stats.ts',
      'text.ts',
      'types.ts',
      'union.ts',
      'util.ts',
    ],
  },
  {
    dir: 'packages/layout/src',
    entry: ['index.ts'],
    keep: ['json.ts', 'round.ts', 'text-metrics.ts'],
  },
  {
    dir: 'packages/formats/src',
    entry: ['index.ts'],
    keep: [],
  },
];
