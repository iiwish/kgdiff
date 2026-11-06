import { fileURLToPath } from 'node:url';

/** Repository root (absolute, with trailing slash). */
export const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * During development and tests every `@kgdiff/*` import resolves to the package's
 * TypeScript source, so no package has to be built before another can be tested.
 */
export const alias = [
  // The DOM-free panels syntax the CLI shares with the viewer (`@kgdiff/viewer/panels`).
  {
    find: /^@kgdiff\/viewer\/panels$/,
    replacement: `${root}packages/viewer/src/panels.ts`,
  },
  {
    find: /^@kgdiff\/([\w-]+)$/,
    replacement: `${root}packages/$1/src/index.ts`,
  },
];
