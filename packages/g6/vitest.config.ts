import { defineProject } from 'vitest/config';
import { alias } from '../../vitest.shared.ts';

export default defineProject({
  resolve: { alias },
  test: {
    name: 'g6',
    environment: 'happy-dom',
    // kgdiff's WebAssembly modules, read from disk (happy-dom cannot fetch them).
    setupFiles: ['../compute/test/setup-dom.ts'],
    include: ['test/**/*.test.ts'],
  },
});
