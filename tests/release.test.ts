/**
 * Release housekeeping: the merged GitHub release notes (scripts/release-notes.ts) and the
 * version in CITATION.cff (scripts/sync-citation.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changelogSection,
  type PackageChangelog,
  readChangelogs,
  releaseNotes,
  sectionEntries,
} from '../scripts/release-notes.ts';
import {
  CITATION_FILE,
  citationVersion,
  packagesVersion,
  withCitationVersion,
} from '../scripts/sync-citation.ts';

const ROOT = join(import.meta.dirname, '..');

const changelog = (name: string, ...sections: string[]): PackageChangelog => ({
  name,
  changelog: `# ${name}\n\n${sections.join('\n')}`,
});

describe('CITATION.cff', () => {
  it('carries the version of the packages', () => {
    expect(citationVersion(readFileSync(CITATION_FILE, 'utf8'))).toBe(packagesVersion());
  });

  it('sets the top-level version only', () => {
    const cff = 'cff-version: 1.2.0\nversion: 0.1.0\nreferences:\n  - version: 9.9.9\n';
    const next = withCitationVersion(cff, '0.5.0');
    expect(next).toBe('cff-version: 1.2.0\nversion: 0.5.0\nreferences:\n  - version: 9.9.9\n');
    expect(citationVersion(next)).toBe('0.5.0');
    expect(citationVersion('version: "1.0.0"\n')).toBe('1.0.0');
  });

  it('refuses a file without a version', () => {
    expect(() => withCitationVersion('cff-version: 1.2.0\n', '0.5.0')).toThrow(/version/);
  });
});

describe('release notes', () => {
  const shared = ['- abc1234: A change in two packages.', '', '  Its second paragraph.'].join('\n');

  it('reads one version section of a changelog', () => {
    const { changelog: text } = changelog('a', '## 0.2.0\n\nTwo.\n', '## 0.1.0\n\nOne.\n');
    expect(changelogSection(text, '0.2.0')?.trim()).toBe('Two.');
    expect(changelogSection(text, '0.1.0')?.trim()).toBe('One.');
    expect(changelogSection(text, '0.3.0')).toBeUndefined();
  });

  it('keeps continuation paragraphs and drops bumped dependencies', () => {
    const section = [
      '### Minor Changes',
      '',
      shared,
      '  - @kgdiff/core@0.2.0',
      '',
      '### Patch Changes',
      '',
      '- Updated dependencies [abc1234]',
      '  - @kgdiff/core@0.2.0',
      '- @kgdiff/layout@0.2.0',
    ].join('\n');
    expect(sectionEntries(section)).toEqual([
      { text: 'abc1234: A change in two packages.\n\nIts second paragraph.', bump: 'minor' },
      { text: 'Updated dependencies [abc1234]', bump: 'patch' },
    ]);
  });

  it('lists a change once, with the packages it changed and its largest bump', () => {
    const notes = releaseNotes('0.2.0', [
      changelog('@kgdiff/cli', `## 0.2.0\n\n### Minor Changes\n\n${shared}\n`),
      changelog('@kgdiff/core', '## 0.2.0\n\nNo changes in this release.\n'),
      changelog(
        '@kgdiff/viewer',
        `## 0.2.0\n\n### Patch Changes\n\n${shared}\n- def5678: A viewer fix.\n- Updated dependencies [abc1234]\n  - @kgdiff/core@0.2.0\n`,
      ),
    ]);
    expect(notes).toBe(
      [
        '## Minor changes',
        '',
        '- abc1234: A change in two packages.',
        '',
        '  Its second paragraph.',
        '',
        '  `@kgdiff/cli` · `@kgdiff/viewer`',
        '',
        '## Patch changes',
        '',
        '- def5678: A viewer fix.',
        '',
        '  `@kgdiff/viewer`',
        '',
        '---',
        '',
        'Every package is at 0.2.0: [`@kgdiff/cli`](https://www.npmjs.com/package/@kgdiff/cli/v/0.2.0) · [`@kgdiff/core`](https://www.npmjs.com/package/@kgdiff/core/v/0.2.0) · [`@kgdiff/viewer`](https://www.npmjs.com/package/@kgdiff/viewer/v/0.2.0).',
        '',
        'GitHub Action: `uses: iiwish/kgdiff@v0.2.0`.',
        '',
      ].join('\n'),
    );
  });

  it('keeps notes outside the lists, and says when nothing changed', () => {
    const initial = releaseNotes('0.1.0', [
      changelog('a', '## 0.1.0\n\nInitial release.\n'),
      changelog('b', '## 0.1.0\n\nInitial release.\n'),
    ]);
    expect(initial.startsWith('Initial release.\n\n---')).toBe(true);
    const empty = releaseNotes('0.3.0', [
      changelog('a', '## 0.3.0\n\nNo changes in this release.\n'),
    ]);
    expect(empty.startsWith('No changes in this release.\n\n---')).toBe(true);
  });

  it('fails when a package has no section for the version', () => {
    expect(() => releaseNotes('0.2.0', [changelog('a', '## 0.1.0\n')])).toThrow(/changelog of a/);
  });

  it('covers every published package at the current version', () => {
    const packages = readChangelogs(ROOT);
    expect(packages.map((p) => p.name)[0]).toBe('@kgdiff/cli');
    expect(packages.length).toBeGreaterThanOrEqual(8);
    const notes = releaseNotes(packagesVersion(), packages);
    expect(notes).toContain(`GitHub Action: \`uses: iiwish/kgdiff@v${packagesVersion()}\`.`);
    expect(notes).not.toMatch(/Updated dependencies|^- @kgdiff\//m);
  });
});
