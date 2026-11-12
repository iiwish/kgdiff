/**
 * The TypeScript read path (RFC 0002, "What stays in TypeScript") versus the compute code that
 * phase 5 (kgdiff 1.0) deletes, file by file, for `@kgdiff/core` and `@kgdiff/layout`.
 * `@kgdiff/formats` is deleted as a whole and is not listed.
 *
 * This list is checked against the code (`read-path.test.ts`): every source file is in exactly
 * one group, and no file in `keep` imports a file in `remove`, directly or through other files.
 * Where it disagrees with the RFC's prose, the code wins and this list is the reference.
 *
 * - `keep`: stays in TypeScript after 1.0.
 * - `remove`: deleted in phase 5; may import `keep` files.
 * - `entry`: the package's public entry. It declares the public API, so phase 5 edits it rather
 *   than deleting it (its compute functions go or become asynchronous). `keep` files may import
 *   it only with `import type`, for the public types it declares.
 *
 * Paths are relative to the package's `src` directory.
 */
export interface ReadPathPackage {
  readonly dir: string;
  readonly entry: readonly string[];
  readonly keep: readonly string[];
  readonly remove: readonly string[];
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
    remove: [
      'classify.ts',
      'delta-emit.ts',
      'diff.ts',
      'edges.ts',
      'engine-util.ts',
      'hunks.ts',
      'match.ts',
      'math.ts',
      'merge-split.ts',
      'order.ts',
      'pipeline.ts',
      'similarity.ts',
      'sync.ts',
    ],
  },
  {
    dir: 'packages/layout/src',
    entry: ['index.ts'],
    keep: ['json.ts', 'round.ts', 'text-metrics.ts'],
    remove: [
      'components.ts',
      'engine.ts',
      'extend.ts',
      'forces/collide-rect.ts',
      'forces/free-spot.ts',
      'forces/params.ts',
      'forces/springs.ts',
      'geometry.ts',
      'graph.ts',
      'init.ts',
      'label-box.ts',
      'layout.ts',
      'math.ts',
      'options.ts',
      'pack.ts',
      'prng.ts',
      'result.ts',
      'scope.ts',
      'simulate.ts',
      'sync.ts',
      'union.ts',
    ],
  },
];
