/**
 * The notes of the GitHub release `v<version>`, which release.yml creates once per version:
 *
 *   pnpm tsx scripts/release-notes.ts 0.4.0 > notes.md
 *
 * All packages share one version (a fixed Changesets group), and a changeset that touches several
 * packages appears in each of their CHANGELOG.md files. The notes list every change once, with the
 * packages it changed, the most significant bump first, and leave out the "Updated dependencies"
 * entries, which only restate the shared version.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const REPOSITORY = 'iiwish/kgdiff';

export type Bump = 'major' | 'minor' | 'patch';

export interface PackageChangelog {
  readonly name: string;
  readonly changelog: string;
}

export interface ChangelogEntry {
  /** The entry without its `- ` marker, continuation lines unindented: `86fe0da: …`. */
  readonly text: string;
  /** `note`: a paragraph outside the change lists, such as "Initial release." */
  readonly bump: Bump | 'note';
}

const HEADINGS: Readonly<Record<string, Bump>> = {
  'Major Changes': 'major',
  'Minor Changes': 'minor',
  'Patch Changes': 'patch',
};
const ORDER = ['note', 'major', 'minor', 'patch'] as const;
const TITLES: Readonly<Record<Bump, string>> = {
  major: 'Major changes',
  minor: 'Minor changes',
  patch: 'Patch changes',
};

/**
 * A bumped dependency, `- @kgdiff/core@0.4.0`. Changesets lists them under "Updated
 * dependencies", or on their own (and then sometimes right after a change, indented like its
 * continuation) when the dependency moved only because the group did.
 */
const DEPENDENCY_LINE = /^\s*- (?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\S*\s*$/;
/** Entries that say nothing a reader of the release needs. */
const SKIPPED = /^(?:Updated dependencies\b|No changes in this release\.?$)/;

/** The lines of the `## <version>` section of a changelog, or `undefined` when it has none. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) return undefined;
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, next < 0 ? lines.length : next).join('\n');
}

/**
 * The entries of a changelog section, each with the bump of the heading it is under, and the
 * paragraphs outside the lists as notes. Bumped dependency lines are left out.
 */
export function sectionEntries(section: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let bump: Bump | 'note' = 'note';
  let current: { lines: string[]; bump: Bump | 'note' } | undefined;
  const flush = (): void => {
    const text = current?.lines.join('\n').trim();
    if (current !== undefined && text) entries.push({ text, bump: current.bump });
    current = undefined;
  };
  for (const line of section.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line)?.[1];
    if (DEPENDENCY_LINE.test(line)) {
      if (!line.startsWith(' ')) flush();
    } else if (heading !== undefined) {
      flush();
      bump = HEADINGS[heading] ?? 'note';
    } else if (line.startsWith('- ')) {
      flush();
      current = { lines: [line.slice(2)], bump };
    } else if (line.trim() === '') {
      current?.lines.push('');
    } else if (current !== undefined && (current.bump === 'note' || line.startsWith('  '))) {
      current.lines.push(current.bump === 'note' ? line : line.slice(2));
    } else {
      flush();
      current = { lines: [line], bump: 'note' };
    }
  }
  flush();
  return entries;
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : `  ${line}`))
    .join('\n');

/**
 * Markdown release notes for `version`, from the changelogs of the packages in display order.
 *
 * @throws Error when a package's changelog has no section for `version`.
 */
export function releaseNotes(version: string, packages: readonly PackageChangelog[]): string {
  const changes = new Map<string, { bump: Bump | 'note'; packages: string[] }>();
  const missing: string[] = [];
  for (const { name, changelog } of packages) {
    const section = changelogSection(changelog, version);
    if (section === undefined) {
      missing.push(name);
      continue;
    }
    for (const entry of sectionEntries(section)) {
      if (SKIPPED.test(entry.text)) continue;
      const seen = changes.get(entry.text);
      if (seen === undefined) changes.set(entry.text, { bump: entry.bump, packages: [name] });
      else {
        if (!seen.packages.includes(name)) seen.packages.push(name);
        if (ORDER.indexOf(entry.bump) < ORDER.indexOf(seen.bump)) seen.bump = entry.bump;
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`No "## ${version}" section in the changelog of ${missing.join(', ')}.`);
  }

  const out: string[] = [];
  for (const bump of ORDER) {
    const group = [...changes].filter(([, change]) => change.bump === bump);
    if (group.length === 0) continue;
    if (bump !== 'note') out.push(`## ${TITLES[bump]}`, '');
    for (const [text, change] of group) {
      const all = change.packages.length === packages.length;
      const where = all ? 'All packages' : change.packages.map((name) => `\`${name}\``).join(' · ');
      if (bump === 'note') out.push(text, '', ...(all ? [] : [where, '']));
      else out.push(`- ${indent(text)}`, '', `  ${where}`, '');
    }
  }
  if (out.length === 0) out.push('No changes in this release.', '');

  const links = packages.map(
    ({ name }) => `[\`${name}\`](https://www.npmjs.com/package/${name}/v/${version})`,
  );
  out.push(
    '---',
    '',
    `Every package is at ${version}: ${links.join(' · ')}.`,
    '',
    `GitHub Action: \`uses: ${REPOSITORY}@v${version}\`.`,
    '',
  );
  return out.join('\n');
}

/** The changelogs of the published packages, in the order of the fixed Changesets group. */
export function readChangelogs(root: string = ROOT): PackageChangelog[] {
  const config = JSON.parse(readFileSync(join(root, '.changeset', 'config.json'), 'utf8')) as {
    fixed?: string[][];
  };
  const order = (config.fixed ?? []).flat();
  const rank = (name: string): number => {
    const i = order.indexOf(name);
    return i < 0 ? order.length : i;
  };
  const packages: PackageChangelog[] = [];
  for (const dir of readdirSync(join(root, 'packages'))) {
    const base = join(root, 'packages', dir);
    let pkg: { name?: unknown; private?: unknown };
    try {
      pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')) as typeof pkg;
    } catch {
      continue;
    }
    if (typeof pkg.name !== 'string' || pkg.private === true) continue;
    packages.push({ name: pkg.name, changelog: readFileSync(join(base, 'CHANGELOG.md'), 'utf8') });
  }
  return packages.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (version === undefined || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    process.stderr.write('Usage: tsx scripts/release-notes.ts <version>\n');
    process.exit(2);
  }
  process.stdout.write(releaseNotes(version, readChangelogs()));
}
