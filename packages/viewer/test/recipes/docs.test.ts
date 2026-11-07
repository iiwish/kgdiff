// @vitest-environment node
/**
 * The framework recipes in docs/guide/viewer.md (en, zh) are the files the recipe tests run:
 * edit `GraphDiff.tsx`, `GraphDiff.vue` or `GraphDiff.svelte`, then the guides.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recipe } from './frameworks.js';

const guide = (path: string): string =>
  readFileSync(new URL(`../../../../docs/${path}`, import.meta.url), 'utf8');

describe('the framework recipes in the guides', () => {
  for (const path of ['guide/viewer.md', 'zh/guide/viewer.md']) {
    it(`are the tested files, in ${path}`, () => {
      const text = guide(path);
      expect(text).toContain(`\`\`\`tsx\n${recipe('GraphDiff.tsx')}\`\`\``);
      expect(text).toContain(`\`\`\`vue\n${recipe('GraphDiff.vue')}\`\`\``);
      expect(text).toContain(`\`\`\`svelte\n${recipe('GraphDiff.svelte')}\`\`\``);
    });
  }
});
