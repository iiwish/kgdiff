import { defineProject } from 'vitest/config';
import { alias } from '../vitest.shared.ts';

export default defineProject({
  resolve: { alias },
  test: {
    name: 'conformance',
    environment: 'node',
    include: ['*.test.ts'],
    testTimeout: 120_000,
  },
});
