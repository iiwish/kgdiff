/**
 * The launcher: which platform package it looks for, what it says when none is installed, and
 * that `bin/kgdiff.js` passes arguments, stdio and the exit code through.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { candidates, detectLibc, findBinary, LauncherError, PLATFORMS } from '../lib/launcher.js';

const BIN = join(import.meta.dirname, '..', 'bin', 'kgdiff.js');
const names = (os: string, cpu: string, libc?: 'glibc' | 'musl') =>
  candidates(os, cpu, libc).map((p) => p.name);

describe('candidates', () => {
  it('picks the exact platform on macOS and Windows x64', () => {
    expect(names('darwin', 'x64')).toEqual(['@kgdiff/cli-darwin-x64']);
    expect(names('win32', 'x64')).toEqual(['@kgdiff/cli-win32-x64']);
  });

  it('falls back to x64 on Arm64 macOS (Rosetta 2) and Windows (emulation)', () => {
    expect(names('darwin', 'arm64')).toEqual([
      '@kgdiff/cli-darwin-arm64',
      '@kgdiff/cli-darwin-x64',
    ]);
    expect(names('win32', 'arm64')).toEqual(['@kgdiff/cli-win32-x64']);
  });

  it('prefers the glibc build on glibc Linux, with the static musl build as a fallback', () => {
    expect(names('linux', 'x64', 'glibc')).toEqual([
      '@kgdiff/cli-linux-x64-gnu',
      '@kgdiff/cli-linux-x64-musl',
    ]);
    expect(names('linux', 'arm64', 'glibc')).toEqual([
      '@kgdiff/cli-linux-arm64-gnu',
      '@kgdiff/cli-linux-arm64-musl',
    ]);
  });

  it('takes only the musl build on musl Linux (Alpine)', () => {
    expect(names('linux', 'x64', 'musl')).toEqual(['@kgdiff/cli-linux-x64-musl']);
    expect(names('linux', 'arm64', 'musl')).toEqual(['@kgdiff/cli-linux-arm64-musl']);
  });

  it('has nothing for other platforms', () => {
    expect(names('freebsd', 'x64')).toEqual([]);
    expect(names('linux', 'ppc64', 'glibc')).toEqual([]);
    expect(names('linux', 'ia32', 'glibc')).toEqual([]);
  });

  it('covers every platform package exactly once', () => {
    const reachable = new Set(
      PLATFORMS.flatMap((p) => candidates(p.os, p.cpu, p.libc).slice(0, 1)).map((p) => p.name),
    );
    expect([...reachable].sort()).toEqual(PLATFORMS.map((p) => p.name).sort());
  });
});

describe('detectLibc', () => {
  it('is only defined on Linux', () => {
    expect(detectLibc('darwin')).toBeUndefined();
    expect(detectLibc('win32')).toBeUndefined();
    if (process.platform === 'linux') expect(['glibc', 'musl']).toContain(detectLibc('linux'));
  });
});

describe('findBinary', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /** A fake `node_modules` with the given platform packages, binaries included unless `empty`. */
  function installed(packages: readonly string[], empty = false) {
    const root = mkdtempSync(join(tmpdir(), 'kgdiff-launcher-'));
    dirs.push(root);
    for (const name of packages) {
      const platform = PLATFORMS.find((p) => p.name === name);
      if (!platform) throw new Error(name);
      const dir = join(root, name);
      mkdirSync(join(dir, 'bin'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{}');
      if (!empty) writeFileSync(join(dir, platform.binary), '');
    }
    return {
      root,
      resolve: (request: string) => {
        const name = request.replace(/\/package\.json$/, '');
        if (!packages.includes(name)) throw new Error(`Cannot find module '${request}'`);
        return join(root, name, 'package.json');
      },
    };
  }

  it('returns the binary of the best installed platform package', () => {
    const { root, resolve } = installed([
      '@kgdiff/cli-linux-x64-gnu',
      '@kgdiff/cli-linux-x64-musl',
    ]);
    const options = { env: {}, os: 'linux', cpu: 'x64', resolve };
    expect(findBinary({ ...options, libc: 'glibc' })).toBe(
      join(root, '@kgdiff/cli-linux-x64-gnu', 'bin', 'kgdiff'),
    );
    expect(findBinary({ ...options, libc: 'musl' })).toBe(
      join(root, '@kgdiff/cli-linux-x64-musl', 'bin', 'kgdiff'),
    );
  });

  it('falls back to the next candidate when the best one is not installed', () => {
    const { root, resolve } = installed(['@kgdiff/cli-linux-x64-musl']);
    expect(findBinary({ env: {}, os: 'linux', cpu: 'x64', libc: 'glibc', resolve })).toBe(
      join(root, '@kgdiff/cli-linux-x64-musl', 'bin', 'kgdiff'),
    );
  });

  it('finds kgdiff.exe on Windows', () => {
    const { root, resolve } = installed(['@kgdiff/cli-win32-x64']);
    expect(findBinary({ env: {}, os: 'win32', cpu: 'arm64', libc: undefined, resolve })).toBe(
      join(root, '@kgdiff/cli-win32-x64', 'bin', 'kgdiff.exe'),
    );
  });

  it('says how to reinstall when the platform package is missing or holds no binary', () => {
    for (const { resolve } of [installed([]), installed(['@kgdiff/cli-darwin-arm64'], true)]) {
      const find = () =>
        findBinary({ env: {}, os: 'darwin', cpu: 'arm64', libc: undefined, resolve });
      expect(find).toThrow(LauncherError);
      expect(find).toThrow(
        /^@kgdiff\/cli-darwin-arm64, the native kgdiff for darwin-arm64, is not installed\.\n.*--omit=optional/s,
      );
    }
  });

  it('names the supported platforms and cargo install elsewhere', () => {
    const find = () =>
      findBinary({ env: {}, os: 'linux', cpu: 'riscv64', libc: 'glibc', resolve: () => '' });
    expect(find).toThrow(/^There is no native kgdiff for linux-riscv64 \(glibc\)\./);
    expect(find).toThrow(/cargo install kgdiff$/);
  });

  it('runs KGDIFF_BINARY when it is set, and refuses one that does not exist', () => {
    const { root } = installed([]);
    const binary = join(root, 'kgdiff');
    writeFileSync(binary, '');
    expect(findBinary({ env: { KGDIFF_BINARY: binary }, os: 'freebsd', cpu: 'x64' })).toBe(binary);
    expect(() => findBinary({ env: { KGDIFF_BINARY: join(root, 'missing') } })).toThrow(
      /^KGDIFF_BINARY names .*missing, which does not exist\.$/,
    );
  });
});

describe('bin/kgdiff.js', () => {
  // Node.js itself stands in for the native binary: `-e` scripts read the arguments and stdin.
  const launch = (args: readonly string[], input = '') =>
    spawnSync(process.execPath, [BIN, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, KGDIFF_BINARY: process.execPath },
    });

  it('passes the arguments, stdin, stdout and stderr through and exits with the exit code', () => {
    const script =
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(process.argv.slice(1).join(",")+":"+s);process.stderr.write("warn");process.exit(3)})';
    const result = launch(['-e', script, 'a b', '--json'], 'piped');
    expect(result.stdout).toBe('a b,--json:piped');
    expect(result.stderr).toBe('warn');
    expect(result.status).toBe(3);
  });

  it('exits 2 with the reason when there is no binary', () => {
    const result = spawnSync(process.execPath, [BIN, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, KGDIFF_BINARY: join(tmpdir(), 'kgdiff-does-not-exist') },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^kgdiff: KGDIFF_BINARY names .*, which does not exist\.\n$/);
  });

  it.skipIf(process.platform === 'win32')('dies of the signal that killed the binary', () => {
    const result = launch(['-e', 'process.kill(process.pid, "SIGTERM")']);
    expect(result.signal).toBe('SIGTERM');
  });
});
