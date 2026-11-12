import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { alias } from '../../vitest.shared.ts';

export default defineProject({
  resolve: {
    alias: [
      ...alias,
      // The Svelte recipe's test mounts a component: Svelte's `mount` is in its browser entry,
      // and Node's resolution picks the server one.
      {
        find: /^svelte$/,
        replacement: fileURLToPath(
          new URL('../../node_modules/svelte/src/index-client.js', import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: 'viewer',
    environment: 'happy-dom',
    // kgdiff's WebAssembly modules, read from disk (happy-dom cannot fetch them).
    setupFiles: ['../compute/test/setup-dom.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // One copy of Svelte's runtime for the compiled component and `mount`.
    server: { deps: { inline: [/[\\/]svelte[\\/]/] } },
  },
});
