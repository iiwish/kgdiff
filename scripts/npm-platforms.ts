/**
 * The platform packages of `@kgdiff/cli` (RFC 0002, §6, "npm package names"): one npm package per
 * native kgdiff (`PLATFORMS` in packages/cli/lib/launcher.js), each holding the binary of dist's
 * archive for its target. They are not part of the workspace: the release assembles them from
 * the archives, publishes them before `@kgdiff/cli`, and only then lists them as optional
 * dependencies of `@kgdiff/cli`, at the release's exact version (as napi-rs does).
 *
 *   pnpm tsx scripts/npm-platforms.ts assemble <dist dir> [<out dir>]
 *   pnpm tsx scripts/npm-platforms.ts publish [<out dir>]
 *
 * `assemble` finds `kgdiff-<target>.tar.xz` / `.zip` below <dist dir> (at any depth, as
 * actions/download-artifact leaves them), checks that dist's manifests name the version of
 * `@kgdiff/cli` and each archive against its `.sha256`, writes
 * `<out>/<package>/` (package.json, README.md, LICENSE, bin/kgdiff or bin/kgdiff.exe) and packs
 * it into `<out>/kgdiff-cli-<platform>-<version>.tgz`; it also packs `@kgdiff/cli` with its
 * optional dependencies into `<out>/kgdiff-cli-<version>.tgz`, for scripts/npm-smoke.mjs. The
 * out dir is `target/npm` by default.
 *
 * `publish` (release.yml, inside `pnpm release`, before `changeset publish`) does nothing when
 * `@kgdiff/cli` is on npm at its version already. Otherwise it publishes each platform tarball of
 * <out dir> npm does not have yet (npm trusted publishing: every platform package needs a first
 * version published by hand and a trusted publisher, docs/releasing.md), then writes the optional
 * dependencies into packages/cli/package.json, which `changeset publish` uploads next.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS as PLATFORM_LIST } from '../packages/cli/lib/launcher.js';

const ROOT = resolve(import.meta.dirname, '..');
export const CLI_DIR = join(ROOT, 'packages/cli');
const CLI_MANIFEST = join(CLI_DIR, 'package.json');

export interface Platform {
  readonly target: string;
  readonly name: string;
  readonly os: string;
  readonly cpu: string;
  readonly libc?: 'glibc' | 'musl';
  readonly binary: string;
}

export const PLATFORMS = PLATFORM_LIST as readonly Platform[];

type Manifest = Record<string, unknown> & { readonly name: string; readonly version: string };

export function cliManifest(): Manifest {
  return JSON.parse(readFileSync(CLI_MANIFEST, 'utf8')) as Manifest;
}

/** `@kgdiff/cli-darwin-arm64` → `darwin-arm64`. */
export function platformId(platform: Platform): string {
  return platform.name.replace(/^@kgdiff\/cli-/, '');
}

/** The package.json of a platform package at `version`. */
export function platformManifest(platform: Platform, version: string): Record<string, unknown> {
  const id = platformId(platform);
  return {
    name: platform.name,
    version,
    description: `The native kgdiff for ${id} (${platform.target}), run by @kgdiff/cli.`,
    keywords: ['kgdiff'],
    homepage: 'https://github.com/iiwish/kgdiff/tree/main/packages/cli#readme',
    bugs: { url: 'https://github.com/iiwish/kgdiff/issues' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/iiwish/kgdiff.git',
      directory: 'packages/cli',
    },
    license: 'MIT',
    author: 'iiwish',
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: [platform.libc] } : {}),
    files: ['bin'],
    preferUnplugged: true,
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  };
}

function platformReadme(platform: Platform): string {
  const id = platformId(platform);
  return `# ${platform.name}

The native [kgdiff](https://github.com/iiwish/kgdiff) for ${id} (Rust target \`${platform.target}\`),
\`${platform.binary}\`. Install [\`@kgdiff/cli\`](https://www.npmjs.com/package/@kgdiff/cli)
instead: npm installs this package with it on ${id}, and \`kgdiff\` runs its binary.

\`\`\`sh
npx @kgdiff/cli before.json after.json
\`\`\`

The binary is the one of the GitHub release's archive for \`${platform.target}\`, and this
package has the version of \`@kgdiff/cli\` it was released with.
`;
}

/** `@kgdiff/cli`'s package.json with every platform package as an optional dependency. */
export function withOptionalDependencies(manifest: Manifest): Manifest {
  const optionalDependencies = Object.fromEntries(
    PLATFORMS.map((platform) => [platform.name, manifest.version]),
  );
  return { ...manifest, optionalDependencies };
}

/** Every file below `dir`, by base name. */
function filesBelow(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else out.set(name, child);
    }
  };
  walk(dir);
  return out;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The archive of `target` below `dist`, checked against its `.sha256` file. */
function archiveOf(files: ReadonlyMap<string, string>, platform: Platform): string {
  const name = `kgdiff-${platform.target}.${platform.os === 'win32' ? 'zip' : 'tar.xz'}`;
  const archive = files.get(name);
  const checksum = files.get(`${name}.sha256`);
  if (archive === undefined || checksum === undefined) {
    throw new Error(`npm-platforms: ${name} or its .sha256 is missing.`);
  }
  const expected = readFileSync(checksum, 'utf8').trim().split(/\s+/)[0];
  if (sha256(archive) !== expected) throw new Error(`npm-platforms: ${name} fails its checksum.`);
  return archive;
}

/** Extracts the binary of `archive` to `to`, executable. */
function extractBinary(archive: string, platform: Platform, to: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'kgdiff-npm-'));
  try {
    const executable = platform.os === 'win32' ? 'kgdiff.exe' : 'kgdiff';
    let extracted: string;
    if (archive.endsWith('.zip')) {
      execFileSync('unzip', ['-q', '-o', archive, executable, '-d', scratch]);
      extracted = join(scratch, executable);
    } else {
      execFileSync('tar', ['-xJf', archive, '-C', scratch]);
      extracted = join(scratch, `kgdiff-${platform.target}`, executable);
    }
    copyFileSync(extracted, to);
    execFileSync('chmod', ['755', to]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `npm pack <dir>` into `out`; the tarball's path. */
function pack(dir: string, out: string): string {
  const json = execFileSync('npm', ['pack', dir, '--json', '--pack-destination', out], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const [result] = JSON.parse(json) as { filename: string }[];
  if (result === undefined) throw new Error(`npm-platforms: npm pack ${dir} packed nothing.`);
  return join(out, result.filename);
}

/**
 * The kgdiff version dist built the archives below `dist` for, from their dist manifests
 * (`releases[].app_version`); every manifest must name the same one.
 */
export function distVersion(files: ReadonlyMap<string, string>): string {
  const versions = new Set<string>();
  for (const [name, path] of files) {
    if (!name.endsWith('-dist-manifest.json')) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      releases?: readonly { app_name?: string; app_version?: string }[];
    };
    for (const release of manifest.releases ?? []) {
      if (release.app_name === 'kgdiff' && release.app_version) versions.add(release.app_version);
    }
  }
  const [version, ...others] = versions;
  if (version === undefined || others.length > 0) {
    throw new Error(
      `npm-platforms: the dist manifests name ${versions.size === 0 ? 'no kgdiff version' : `the versions ${[...versions].join(', ')}`}.`,
    );
  }
  return version;
}

export function assemble(dist: string, out: string): string[] {
  const { version } = cliManifest();
  const files = filesBelow(dist);
  // A platform package says which kgdiff it holds by its version: never another one's binary.
  const built = distVersion(files);
  if (built !== version) {
    throw new Error(
      `npm-platforms: the archives hold kgdiff ${built}, but @kgdiff/cli is at ${version}; assemble from the release run of ${version}.`,
    );
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const tarballs: string[] = [];
  for (const platform of PLATFORMS) {
    const dir = join(out, `cli-${platformId(platform)}`);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify(platformManifest(platform, version), null, 2)}\n`,
    );
    writeFileSync(join(dir, 'README.md'), platformReadme(platform));
    copyFileSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
    extractBinary(archiveOf(files, platform), platform, join(dir, platform.binary));
    tarballs.push(pack(dir, out));
  }
  // The launcher as the release publishes it, for the smoke test.
  const cli = join(out, 'cli');
  cpSync(CLI_DIR, cli, {
    recursive: true,
    filter: (path) => !path.includes('node_modules'),
  });
  copyFileSync(join(ROOT, 'LICENSE'), join(cli, 'LICENSE'));
  writeFileSync(
    join(cli, 'package.json'),
    `${JSON.stringify(withOptionalDependencies(cliManifest()), null, 2)}\n`,
  );
  tarballs.push(pack(cli, out));
  return tarballs;
}

/** Whether npm has `name` at `version`. */
function published(name: string, version: string): boolean {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return result.status === 0 && result.stdout.trim() !== '';
}

export function publish(out: string): void {
  const manifest = cliManifest();
  const { version } = manifest;
  if (published(manifest.name, version)) {
    console.log(`npm-platforms: ${manifest.name}@${version} is on npm; nothing to publish.`);
    return;
  }
  for (const platform of PLATFORMS) {
    const tarball = join(out, `kgdiff-cli-${platformId(platform)}-${version}.tgz`);
    if (!existsSync(tarball)) {
      throw new Error(
        `npm-platforms: ${tarball} is missing; assemble the platform packages first.`,
      );
    }
    if (published(platform.name, version)) {
      console.log(`npm-platforms: ${platform.name}@${version} is on npm already.`);
      continue;
    }
    execFileSync('npm', ['publish', tarball, '--access', 'public'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
  writeFileSync(CLI_MANIFEST, `${JSON.stringify(withOptionalDependencies(manifest), null, 2)}\n`);
  console.log(`npm-platforms: ${manifest.name}@${version} lists its platform packages.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  const defaultOut = join(ROOT, 'target/npm');
  if (command === 'assemble' && first !== undefined) {
    for (const tarball of assemble(resolve(first), resolve(second ?? defaultOut))) {
      console.log(tarball);
    }
  } else if (command === 'publish') {
    publish(resolve(first ?? defaultOut));
  } else {
    console.error('usage: npm-platforms.ts assemble <dist dir> [<out dir>] | publish [<out dir>]');
    process.exitCode = 2;
  }
}
