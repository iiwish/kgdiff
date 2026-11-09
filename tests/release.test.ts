/**
 * Release housekeeping: the merged GitHub release notes (scripts/release-notes.ts), the version
 * in CITATION.cff (scripts/sync-citation.ts), the version of the Rust workspace
 * (scripts/sync-versions.ts) and the platform packages of @kgdiff/cli (scripts/npm-platforms.ts).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cliManifest,
  distVersion,
  PLATFORMS,
  platformId,
  platformManifest,
  withOptionalDependencies,
} from '../scripts/npm-platforms.ts';
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
import {
  CARGO_LOCK,
  CARGO_TOML,
  internalRequirements,
  lockedWorkspaceCrates,
  withInternalRequirements,
  withLockedVersion,
  withWorkspaceVersion,
  workspaceVersion,
} from '../scripts/sync-versions.ts';

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

describe('the Rust workspace', () => {
  it('carries the version of the packages, in Cargo.toml and Cargo.lock', () => {
    expect(workspaceVersion(readFileSync(CARGO_TOML, 'utf8'))).toBe(packagesVersion());
    const crates = lockedWorkspaceCrates(readFileSync(CARGO_LOCK, 'utf8'));
    expect(crates.map((c) => c.name)).toContain('kgdiff-core');
    for (const crate of crates) expect(crate).toEqual({ ...crate, version: packagesVersion() });
    // The published crates require each other at exactly that version.
    const requirements = internalRequirements(readFileSync(CARGO_TOML, 'utf8'));
    expect(requirements.map((r) => r.name)).toEqual(
      expect.arrayContaining(['kgdiff-core', 'kgdiff-formats', 'kgdiff-report', 'kgdiff-layout']),
    );
    for (const r of requirements) expect(r).toEqual({ ...r, version: packagesVersion() });
  });

  it('sets the exact requirements on the workspace crates, not on registry crates', () => {
    const toml = [
      '[workspace.package]',
      'version = "0.1.0"',
      '',
      '[workspace.dependencies]',
      'serde_json = "1.0.149"',
      'regex = { version = "=1.0.0" }',
      'kgdiff-core = { version = "=0.1.0", path = "crates/kgdiff-core" }',
      'kgdiff-formats = { version = "=0.1.0", path = "crates/kgdiff-formats" }',
      '',
      '[workspace.lints.rust]',
      'kgdiff-x = { version = "=0.1.0", path = "crates/kgdiff-x" }',
      '',
    ].join('\n');
    const next = withInternalRequirements(toml, '0.5.0');
    expect(internalRequirements(next)).toEqual([
      { name: 'kgdiff-core', version: '0.5.0' },
      { name: 'kgdiff-formats', version: '0.5.0' },
    ]);
    expect(next.replaceAll('"=0.5.0"', '"=0.1.0"')).toBe(toml);
    expect(withInternalRequirements('[workspace]\n', '0.5.0')).toBe('[workspace]\n');
  });

  it('sets the version of [workspace.package] only', () => {
    const toml = [
      '[workspace]',
      'members = ["crates/*"]',
      '',
      '[workspace.package]',
      '# One version.',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[workspace.dependencies]',
      'version = "9.9.9"',
      '',
    ].join('\n');
    const next = withWorkspaceVersion(toml, '0.5.0');
    expect(next).toBe(toml.replace('0.1.0', '0.5.0'));
    expect(workspaceVersion(next)).toBe('0.5.0');
    expect(() => withWorkspaceVersion('[workspace]\n', '0.5.0')).toThrow(/workspace\.package/);
  });

  it('sets the locked version of the workspace crates, not of registry crates', () => {
    const lock = [
      'version = 4',
      '',
      '[[package]]',
      'name = "indexmap"',
      'version = "0.1.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      '',
      '[[package]]',
      'name = "kgdiff-core"',
      'version = "0.1.0"',
      'dependencies = [',
      ' "indexmap",',
      ']',
      '',
    ].join('\n');
    const next = withLockedVersion(lock, '0.5.0');
    expect(lockedWorkspaceCrates(next)).toEqual([{ name: 'kgdiff-core', version: '0.5.0' }]);
    expect(next.replace('"0.5.0"', '"0.1.0"')).toBe(lock);
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

describe('the platform packages of @kgdiff/cli', () => {
  it('cover the targets dist builds, in its order', () => {
    const toml = readFileSync(join(ROOT, 'dist-workspace.toml'), 'utf8');
    const targets = /^targets = \[([^\]]*)\]/m.exec(toml)?.[1] ?? '';
    expect(PLATFORMS.map((p) => p.target)).toEqual(
      [...targets.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    );
  });

  it('are named after the platform npm selects them on', () => {
    for (const p of PLATFORMS) {
      const libc = p.libc === 'glibc' ? '-gnu' : p.libc === 'musl' ? '-musl' : '';
      expect(platformId(p)).toBe(`${p.os}-${p.cpu}${libc}`);
      expect(p.libc !== undefined).toBe(p.os === 'linux');
      expect(p.binary).toBe(p.os === 'win32' ? 'bin/kgdiff.exe' : 'bin/kgdiff');
    }
  });

  it('carry the version, os, cpu and libc, and only the binary', () => {
    const linux = PLATFORMS.find((p) => p.name === '@kgdiff/cli-linux-arm64-musl');
    if (!linux) throw new Error('no linux-arm64-musl');
    expect(platformManifest(linux, '1.2.3')).toMatchObject({
      name: '@kgdiff/cli-linux-arm64-musl',
      version: '1.2.3',
      license: 'MIT',
      os: ['linux'],
      cpu: ['arm64'],
      libc: ['musl'],
      files: ['bin'],
      publishConfig: { access: 'public' },
    });
    const mac = PLATFORMS.find((p) => p.os === 'darwin');
    if (!mac) throw new Error('no darwin');
    expect(platformManifest(mac, '1.2.3')).not.toHaveProperty('libc');
  });

  it('become optional dependencies of @kgdiff/cli at its exact version, only when released', () => {
    const manifest = cliManifest();
    expect(manifest.version).toBe(packagesVersion());
    // Committed without them, so the workspace never installs a version npm does not have yet.
    expect(manifest).not.toHaveProperty('dependencies');
    expect(manifest).not.toHaveProperty('optionalDependencies');
    expect(withOptionalDependencies(manifest).optionalDependencies).toEqual(
      Object.fromEntries(PLATFORMS.map((p) => [p.name, manifest.version])),
    );
  });

  it('come from the archives of the version they are published at', () => {
    const manifest = (version: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'kgdiff-dist-'));
      const path = join(dir, `${version}-dist-manifest.json`);
      writeFileSync(
        path,
        JSON.stringify({ releases: [{ app_name: 'kgdiff', app_version: version }] }),
      );
      return path;
    };
    const a = manifest('0.8.0');
    expect(distVersion(new Map([['a-dist-manifest.json', a]]))).toBe('0.8.0');
    const b = manifest('0.7.0');
    expect(() =>
      distVersion(
        new Map([
          ['a-dist-manifest.json', a],
          ['b-dist-manifest.json', b],
        ]),
      ),
    ).toThrow(/the versions 0.8.0, 0.7.0/);
    expect(() => distVersion(new Map())).toThrow(/no kgdiff version/);
  });
});
