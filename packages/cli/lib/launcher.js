/**
 * Which native `kgdiff` to run (RFC 0002, §6, "npm package names"). `@kgdiff/cli` ships no
 * engine of its own: npm installs one optional dependency `@kgdiff/cli-<platform>` per supported
 * platform, selected by its `os`, `cpu` and `libc` fields, and that package holds the binary
 * built for it (the same binary as the GitHub release's and `cargo install kgdiff`'s).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * @typedef {object} Platform
 * @property {string} target The Rust target the binary is built for (dist-workspace.toml).
 * @property {string} name The npm package that holds it.
 * @property {NodeJS.Platform} os `process.platform`.
 * @property {string} cpu `process.arch`.
 * @property {'glibc' | 'musl'} [libc] On Linux: the C library it links (musl binaries are static).
 * @property {string} binary The binary's path inside the package.
 */

/**
 * Every platform with a native kgdiff, in the order of dist-workspace.toml's targets.
 * tests/release.test.ts checks this list against the targets, the platform packages under
 * `npm/` and the optional dependencies of `@kgdiff/cli`.
 *
 * @type {readonly Platform[]}
 */
export const PLATFORMS = [
  {
    target: 'aarch64-apple-darwin',
    name: '@kgdiff/cli-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    binary: 'bin/kgdiff',
  },
  {
    target: 'x86_64-apple-darwin',
    name: '@kgdiff/cli-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    binary: 'bin/kgdiff',
  },
  {
    target: 'aarch64-unknown-linux-gnu',
    name: '@kgdiff/cli-linux-arm64-gnu',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
    binary: 'bin/kgdiff',
  },
  {
    target: 'x86_64-unknown-linux-gnu',
    name: '@kgdiff/cli-linux-x64-gnu',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
    binary: 'bin/kgdiff',
  },
  {
    target: 'aarch64-unknown-linux-musl',
    name: '@kgdiff/cli-linux-arm64-musl',
    os: 'linux',
    cpu: 'arm64',
    libc: 'musl',
    binary: 'bin/kgdiff',
  },
  {
    target: 'x86_64-unknown-linux-musl',
    name: '@kgdiff/cli-linux-x64-musl',
    os: 'linux',
    cpu: 'x64',
    libc: 'musl',
    binary: 'bin/kgdiff',
  },
  {
    target: 'x86_64-pc-windows-msvc',
    name: '@kgdiff/cli-win32-x64',
    os: 'win32',
    cpu: 'x64',
    binary: 'bin/kgdiff.exe',
  },
];

/** The launcher cannot find a binary to run; the message says why and what to do. */
export class LauncherError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LauncherError';
  }
}

/**
 * The C library of this Linux system: `glibc` when Node.js runs on one (its diagnostic report
 * names the glibc version), else `musl`; `undefined` elsewhere.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {'glibc' | 'musl' | undefined}
 */
export function detectLibc(platform = process.platform) {
  if (platform !== 'linux') return undefined;
  const report = /** @type {{ header?: { glibcVersionRuntime?: string } } | undefined} */ (
    process.report?.getReport()
  );
  return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/**
 * The platforms whose binary can run here, best first: the exact match; on Linux with glibc the
 * static musl build too; x64 builds on Arm64 macOS (Rosetta 2) and Windows (emulation).
 *
 * @param {string} os `process.platform`
 * @param {string} cpu `process.arch`
 * @param {'glibc' | 'musl' | undefined} libc
 * @returns {Platform[]}
 */
export function candidates(os, cpu, libc) {
  const find = (/** @type {string} */ arch, /** @type {string | undefined} */ c) =>
    PLATFORMS.filter((p) => p.os === os && p.cpu === arch && (c === undefined || p.libc === c));
  const libcs = os !== 'linux' ? [undefined] : libc === 'musl' ? ['musl'] : ['glibc', 'musl'];
  const arches = (os === 'darwin' || os === 'win32') && cpu === 'arm64' ? [cpu, 'x64'] : [cpu];
  return arches.flatMap((arch) => libcs.flatMap((c) => find(arch, c)));
}

/** A readable name of a platform: `linux-x64 (glibc)`. */
function describe(
  /** @type {string} */ os,
  /** @type {string} */ cpu,
  /** @type {string | undefined} */ libc,
) {
  return `${os}-${cpu}${libc ? ` (${libc})` : ''}`;
}

/**
 * @typedef {object} FindOptions
 * @property {Readonly<Record<string, string | undefined>>} [env] `KGDIFF_BINARY` overrides the search.
 * @property {string} [os]
 * @property {string} [cpu]
 * @property {'glibc' | 'musl' | undefined} [libc]
 * @property {(request: string) => string} [resolve] Resolves `<package>/package.json`; throws when absent.
 */

/**
 * The path of the kgdiff binary to run: `KGDIFF_BINARY` when set, else the binary of the first
 * installed platform package among `candidates`.
 *
 * @param {FindOptions} [options]
 * @returns {string}
 * @throws {LauncherError} when no binary can be found.
 */
export function findBinary(options = {}) {
  const env = options.env ?? process.env;
  const override = env.KGDIFF_BINARY;
  if (override) {
    if (!existsSync(override)) {
      throw new LauncherError(`KGDIFF_BINARY names ${override}, which does not exist.`);
    }
    return override;
  }
  const os = options.os ?? process.platform;
  const cpu = options.cpu ?? process.arch;
  const libc = 'libc' in options ? options.libc : detectLibc(/** @type {NodeJS.Platform} */ (os));
  const resolve = options.resolve ?? createRequire(import.meta.url).resolve;
  const platforms = candidates(os, cpu, libc);
  if (platforms.length === 0) {
    throw new LauncherError(
      [
        `There is no native kgdiff for ${describe(os, cpu, libc)}.`,
        'kgdiff is built for macOS (arm64, x64), Linux (arm64, x64; glibc or musl) and Windows (x64).',
        'Elsewhere, build it with Rust: cargo install kgdiff',
      ].join('\n'),
    );
  }
  for (const platform of platforms) {
    let manifest;
    try {
      manifest = resolve(`${platform.name}/package.json`);
    } catch {
      continue;
    }
    const binary = join(dirname(manifest), platform.binary);
    if (existsSync(binary)) return binary;
  }
  const [best] = /** @type {[Platform]} */ (platforms);
  throw new LauncherError(
    [
      `${best.name}, the native kgdiff for ${describe(os, cpu, libc)}, is not installed.`,
      'npm installs it with @kgdiff/cli as an optional dependency: reinstall @kgdiff/cli without',
      '--omit=optional (or --no-optional), or point KGDIFF_BINARY at a kgdiff binary.',
    ].join('\n'),
  );
}
