/**
 * How the action gets kgdiff (kgdiff.mjs): the version npm names, the platform package's tarball
 * checked against its integrity and unpacked, the candidates tried in order, npx for versions
 * without platform packages. npm itself is a stand-in here.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { extractFile, hasIntegrity, nativeKgdiff, viewedVersion } from '../kgdiff.mjs';
import { ActionError } from '../lib.mjs';

/** A gzip-compressed tar archive of `files` (name → content), as npm packs a package. */
function tgz(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000755\0', 100);
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    blocks.push(header);
    const body = Buffer.from(content, 'utf8');
    blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

describe('viewedVersion', () => {
  it('takes the version, or the highest of a range', () => {
    expect(viewedVersion('"0.8.0"')).toBe('0.8.0');
    expect(viewedVersion('["0.8.0","0.8.1","0.9.0"]')).toBe('0.9.0');
  });

  it('is undefined when nothing matches', () => {
    expect(viewedVersion('')).toBeUndefined();
    expect(viewedVersion('[]')).toBeUndefined();
    expect(viewedVersion('{"error":{"code":"E404"}}')).toBeUndefined();
    expect(viewedVersion('npm ERR!')).toBeUndefined();
  });
});

describe('hasIntegrity', () => {
  it('checks the sha512 npm publishes', () => {
    const data = Buffer.from('kgdiff');
    expect(hasIntegrity(data, integrity(data))).toBe(true);
    expect(hasIntegrity(Buffer.from('kgdifF'), integrity(data))).toBe(false);
    expect(hasIntegrity(data, `sha1-${createHash('sha1').update(data).digest('base64')}`)).toBe(
      false,
    );
  });
});

describe('extractFile', () => {
  it('finds a file of a package tarball, whatever comes before it', () => {
    const archive = tgz({
      'package/package.json': '{}',
      'package/README.md': 'x'.repeat(1000),
      'package/bin/kgdiff': '#!/bin/sh\n',
    });
    expect(extractFile(archive, 'package/bin/kgdiff')?.toString('utf8')).toBe('#!/bin/sh\n');
    expect(extractFile(archive, 'package/README.md')?.length).toBe(1000);
    expect(extractFile(archive, 'package/bin/kgdiff.exe')).toBeUndefined();
  });
});

describe('nativeKgdiff', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });
  const workDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'kgdiff-action-native-'));
    dirs.push(dir);
    return dir;
  };

  const binary = '#!/bin/sh\necho "native $*"\nexit 1\n';

  /**
   * npm with `published` platform packages (name → binary text, or a tarball to serve as is):
   * `npm view` answers `version`, `npm pack` writes the tarball where it is asked to.
   */
  function fakeNpm(version: string | undefined, published: Record<string, string | Buffer>) {
    const calls: string[][] = [];
    const npm = async ({ args }: { command: string; args: string[] }) => {
      const npmArgs = process.platform === 'win32' ? args.slice(1) : args;
      calls.push(npmArgs);
      const [command, spec = ''] = npmArgs;
      if (command === 'view') {
        return version === undefined
          ? { code: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' }
          : { code: 0, stdout: JSON.stringify(version), stderr: '' };
      }
      const name = spec.slice(0, spec.lastIndexOf('@'));
      const entry = published[name];
      if (entry === undefined) return { code: 1, stdout: '', stderr: 'E404' };
      const data =
        typeof entry === 'string'
          ? tgz({ 'package/package.json': '{}', 'package/bin/kgdiff': entry })
          : entry;
      const filename = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
      writeFileSync(join(npmArgs[npmArgs.indexOf('--pack-destination') + 1] ?? '', filename), data);
      const reported =
        typeof entry === 'string' ? integrity(data) : integrity(Buffer.from('other'));
      return { code: 0, stdout: JSON.stringify([{ filename, integrity: reported }]), stderr: '' };
    };
    return { npm, calls };
  }

  const linux = {
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc' as const,
    log: () => undefined,
    env: {},
  };

  it('resolves the version with npm view and unpacks the binary of the platform package', async () => {
    const work = workDir();
    const { npm, calls } = fakeNpm('0.8.1', { '@kgdiff/cli-linux-x64-gnu': binary });
    const kgdiff = nativeKgdiff('^0.8.0', work, { ...linux, npm });
    expect(await kgdiff.version()).toBe('0.8.1');
    expect(calls[0]).toEqual(['view', '@kgdiff/cli@^0.8.0', 'version', '--json']);
    expect(calls[1]?.slice(0, 2)).toEqual(['pack', '@kgdiff/cli-linux-x64-gnu@0.8.1']);
    expect(readFileSync(join(work, 'kgdiff-bin', '0.8.1', 'bin', 'kgdiff'), 'utf8')).toBe(binary);
  });

  it.skipIf(process.platform === 'win32')('runs the binary directly for every file', async () => {
    const work = workDir();
    const { npm, calls } = fakeNpm('0.8.0', { '@kgdiff/cli-linux-x64-gnu': binary });
    const kgdiff = nativeKgdiff('0.8.0', work, { ...linux, npm });
    await kgdiff.version();
    const first = await kgdiff.run(['a.json', 'b.json'], work);
    const second = await kgdiff.run(['c.json', 'd.json'], work);
    expect([first.code, second.code]).toEqual([1, 1]);
    expect(calls).toHaveLength(2); // one view, one pack: no npm per file
  });

  it('takes the next candidate when the best one is not published', async () => {
    const work = workDir();
    const { npm, calls } = fakeNpm('0.8.0', { '@kgdiff/cli-linux-x64-musl': binary });
    await nativeKgdiff('0.8.0', work, { ...linux, npm }).version();
    expect(calls.slice(1).map((c) => c[1])).toEqual([
      '@kgdiff/cli-linux-x64-gnu@0.8.0',
      '@kgdiff/cli-linux-x64-musl@0.8.0',
    ]);
  });

  it('falls back to npx for a version without platform packages', async () => {
    const work = workDir();
    const { npm } = fakeNpm('0.7.0', {});
    const ran: string[] = [];
    const fallback = (spec: string) => ({
      version: async () => {
        ran.push(`version ${spec}`);
        return spec;
      },
      run: async (args: readonly string[]) => {
        ran.push(`run ${args.join(' ')}`);
        return { code: 0, stderr: '' };
      },
    });
    const kgdiff = nativeKgdiff('0.7', work, { ...linux, npm, fallback });
    expect(await kgdiff.version()).toBe('0.7.0');
    await kgdiff.run(['a', 'b'], work);
    expect(ran).toEqual(['version 0.7.0', 'run a b']);
  });

  it('refuses a tarball that does not match its integrity', async () => {
    const work = workDir();
    const archive = tgz({ 'package/bin/kgdiff': binary });
    const { npm } = fakeNpm('0.8.0', { '@kgdiff/cli-linux-x64-gnu': archive });
    const version = nativeKgdiff('0.8.0', work, { ...linux, npm }).version();
    await expect(version).rejects.toThrow(ActionError);
    await expect(version).rejects.toThrow(/does not match the integrity/);
  });

  it.skipIf(process.platform === 'win32')('runs KGDIFF_BINARY instead, without npm', async () => {
    const work = workDir();
    const path = join(work, 'kgdiff');
    writeFileSync(path, '#!/bin/sh\necho "kgdiff 1.2.3"\n', { mode: 0o755 });
    const { npm, calls } = fakeNpm('0.8.0', {});
    const kgdiff = nativeKgdiff('0.8.0', work, { ...linux, npm, env: { KGDIFF_BINARY: path } });
    expect(await kgdiff.version()).toBe('1.2.3');
    expect(calls).toEqual([]);
  });

  it('says so when no version matches the input', async () => {
    const { npm } = fakeNpm(undefined, {});
    await expect(nativeKgdiff('9.9.9', workDir(), { ...linux, npm }).version()).rejects.toThrow(
      /^No @kgdiff\/cli version matches "9.9.9" on npm/,
    );
  });
});
