/**
 * The site's viewers: what one remembers (`persist`, shared by every viewer of the origin) must
 * come from the playground only, never from a landing page demo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SITE = join(import.meta.dirname, '..', 'apps', 'site');

const viewers = (page: string): string[] =>
  readFileSync(join(SITE, page), 'utf8').match(/<kgdiff-viewer\b[^>]*>/g) ?? [];

describe('site viewers', () => {
  it('landing page demos remember nothing', () => {
    const demos = viewers('index.html');
    expect(demos.length).toBeGreaterThanOrEqual(2);
    for (const tag of demos) expect(tag, tag).toContain('persist="none"');
  });

  it('the playground remembers the visitor’s layout', () => {
    const [playground] = viewers('playground.html');
    expect(playground).toBeDefined();
    expect(playground).not.toContain('persist=');
  });
});
