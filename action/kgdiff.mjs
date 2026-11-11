// @ts-check
/**
 * How the action runs kgdiff (RFC 0002, §8): the native binary of `@kgdiff/cli`'s platform package
 * for this runner, started directly for every file. Versions before 0.8.0, which had no platform
 * packages, are refused with an error that says how to keep using them.
 *
 * `version()` resolves the version input against npm (`npm view @kgdiff/cli@<spec> version`: a
 * version, range or tag, as npx would), downloads the platform package's tarball with `npm pack`
 * (npm's registry, proxy and cache settings), checks it against the sha512 integrity the registry
 * publishes, and unpacks the binary into the job's work directory. Nothing is installed, and no
 * npm process runs per comparison. `KGDIFF_BINARY` in the step's environment runs that binary
 * instead, as `@kgdiff/cli`'s launcher does (the action's own workflow tests a build this way).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { candidates, detectLibc } from '../packages/cli/lib/launcher.js';
import { ActionError } from './lib.mjs';

/**
 * How kgdiff runs: `version` resolves the requested version (and fetches it), `run` runs one
 * comparison. Tests replace it.
 *
 * @typedef {object} Kgdiff
 * @property {() => Promise<string>} version The exact version, e.g. `0.1.0`.
 * @property {(args: readonly string[], cwd: string) => Promise<{ code: number, stderr: string }>} run
 */

/** @typedef {{ command: string, args: string[] }} Invocation */
/** @typedef {{ code: number, stdout: string, stderr: string }} Outcome */

/**
 * An npm command (`npm` or `npx`). On Windows they are `.cmd` scripts, which Node only starts
 * through a shell; run npm's JavaScript entry point with this Node instead.
 *
 * @param {'npm' | 'npx'} tool
 * @param {readonly string[]} args
 * @returns {Invocation}
 */
export function npmTool(tool, args) {
  if (process.platform !== 'win32') return { command: tool, args: [...args] };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${tool}-cli.js`);
  return { command: process.execPath, args: [cli, ...args] };
}

/**
 * Run a command. Its stdout and stderr go to the log through this process's stdout, so they
 * stay in order with the lines around them (`::stop-commands::` in particular); stdout is
 * returned instead with `capture`, stderr is returned too (and not logged with `quiet`).
 *
 * @param {Invocation} invocation
 * @param {string} cwd
 * @param {{ capture?: boolean, quiet?: boolean }} [options]
 * @returns {Promise<Outcome>}
 */
export function run({ command, args }, cwd, { capture = false, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      if (capture) stdout += chunk.toString('utf8');
      else process.stdout.write(chunk);
    });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      if (!quiet) process.stdout.write(chunk);
      if (stderr.length < 65_536) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** The first `@kgdiff/cli` version with platform packages, and so the first the action runs. */
export const MIN_VERSION = '0.8.0';

/**
 * Whether `version` (`x.y.z`, with or without a prerelease) is at least {@link MIN_VERSION}.
 * A version that is not `x.y.z` is not refused here: npm resolved it, so it is a real release.
 *
 * @param {string} version
 */
export function supportsNative(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  const min = MIN_VERSION.split('.').map(Number);
  if (parts === undefined) return true;
  for (const [i, n] of parts.entries()) {
    if (n !== min[i]) return n > (min[i] ?? 0);
  }
  return true;
}

/**
 * The version `npm view <package>@<spec> version --json` names: the highest when a range matches
 * several, `undefined` when none does.
 *
 * @param {string} json
 * @returns {string | undefined}
 */
export function viewedVersion(json) {
  let value;
  try {
    value = JSON.parse(json || 'null');
  } catch {
    return undefined;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const last = value.at(-1);
    return typeof last === 'string' ? last : undefined;
  }
  return undefined;
}

/**
 * Whether `data` has the Subresource Integrity `integrity` (`sha512-<base64>`, as npm publishes).
 *
 * @param {Uint8Array} data
 * @param {string} integrity
 */
export function hasIntegrity(data, integrity) {
  const expected = /^sha512-(\S+)$/.exec(integrity.trim())?.[1];
  if (expected === undefined) return false;
  return createHash('sha512').update(data).digest('base64') === expected;
}

/**
 * The content of the regular file `path` in a gzip-compressed tar archive (an npm package
 * tarball, whose entries live under `package/`), or `undefined`.
 *
 * @param {Uint8Array} tgz
 * @param {string} path
 * @returns {Buffer | undefined}
 */
export function extractFile(tgz, path) {
  const tar = gunzipSync(tgz);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (/** @type {number} */ start, /** @type {number} */ length) => {
      const bytes = header.subarray(start, start + length);
      const end = bytes.indexOf(0);
      return bytes.subarray(0, end === -1 ? length : end).toString('utf8');
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const start = offset + 512;
    if ((type === '0' || type === '') && (prefix ? `${prefix}/${name}` : name) === path) {
      return tar.subarray(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/**
 * @typedef {object} NativeDeps
 * @property {(invocation: Invocation, cwd: string) => Promise<Outcome>} [npm] Runs npm, quietly.
 * @property {string} [os]
 * @property {string} [cpu]
 * @property {'glibc' | 'musl' | undefined} [libc]
 * @property {(line: string) => void} [log]
 * @property {Readonly<Record<string, string | undefined>>} [env] `KGDIFF_BINARY`.
 */

/**
 * kgdiff as the native binary of `@kgdiff/cli`'s platform package for this runner.
 *
 * @param {string} spec An npm version, range or tag.
 * @param {string} cwd The job's work directory: the binary is unpacked below it.
 * @param {NativeDeps} [deps]
 * @returns {Kgdiff}
 */
export function nativeKgdiff(spec, cwd, deps = {}) {
  const npm =
    deps.npm ?? ((invocation, dir) => run(invocation, dir, { capture: true, quiet: true }));
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const os = deps.os ?? process.platform;
  const cpu = deps.cpu ?? process.arch;
  const libc = 'libc' in deps ? deps.libc : detectLibc(/** @type {NodeJS.Platform} */ (os));
  /** @type {string | undefined} */
  let binary;

  /** @param {string} version */
  async function fetchBinary(version) {
    const scratch = mkdtempSync(join(cwd, 'kgdiff-npm-'));
    try {
      for (const platform of candidates(os, cpu, libc)) {
        const pack = await npm(
          npmTool('npm', [
            'pack',
            `${platform.name}@${version}`,
            '--json',
            '--pack-destination',
            scratch,
          ]),
          scratch,
        );
        if (pack.code !== 0) continue; // not published for this version
        /** @type {{ filename?: string, integrity?: string }[]} */
        const [packed = {}] = JSON.parse(pack.stdout);
        if (!packed.filename || !packed.integrity) {
          throw new ActionError(`npm pack ${platform.name}@${version} named no tarball.`);
        }
        const tgz = readFileSync(join(scratch, packed.filename));
        if (!hasIntegrity(tgz, packed.integrity)) {
          throw new ActionError(
            `${platform.name}@${version} does not match the integrity the npm registry publishes.`,
          );
        }
        const content = extractFile(tgz, `package/${platform.binary}`);
        if (content === undefined) {
          throw new ActionError(`${platform.name}@${version} holds no ${platform.binary}.`);
        }
        const path = join(cwd, 'kgdiff-bin', version, platform.binary);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        chmodSync(path, 0o755);
        log(`Running the native kgdiff of ${platform.name}`);
        return path;
      }
      return undefined;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return {
    async version() {
      const override = (deps.env ?? process.env).KGDIFF_BINARY;
      if (override) {
        const printed = await run({ command: override, args: ['--version'] }, cwd, {
          capture: true,
        });
        const version = /^kgdiff (\S+)/.exec(printed.stdout.trim())?.[1];
        if (printed.code !== 0 || version === undefined) {
          throw new ActionError(`KGDIFF_BINARY (${override}) does not run as kgdiff.`);
        }
        log(`Running KGDIFF_BINARY, ${override}`);
        binary = override;
        return version;
      }
      const view = await npm(
        npmTool('npm', ['view', `@kgdiff/cli@${spec}`, 'version', '--json']),
        cwd,
      );
      const version = view.code === 0 ? viewedVersion(view.stdout) : undefined;
      if (version === undefined) {
        throw new ActionError(
          `No @kgdiff/cli version matches "${spec}" on npm (npm view exited with ${view.code}).`,
          'Check the version input and that the runner can reach the npm registry.',
        );
      }
      if (!supportsNative(version)) {
        throw new ActionError(
          `@kgdiff/cli ${version} is older than ${MIN_VERSION}, the first version this action can run.`,
          `Set the version input to ${MIN_VERSION} or later, or pin an earlier release of the action ` +
            `(iiwish/kgdiff@v0.7.0 is the last one that does), which still runs those versions with npx.`,
        );
      }
      binary = await fetchBinary(version);
      if (binary === undefined) {
        throw new ActionError(
          `@kgdiff/cli ${version} has no native build for this runner (${os}, ${cpu}${libc ? `, ${libc}` : ''}).`,
          'Run the action on a macOS, Linux or Windows runner on x64 or arm64, or point KGDIFF_BINARY at a kgdiff you built.',
        );
      }
      return version;
    },
    async run(args, dir) {
      if (binary === undefined) throw new Error('kgdiff.version() resolves the binary first.');
      const { code, stderr } = await run({ command: binary, args: [...args] }, dir);
      return { code, stderr };
    },
  };
}
