/**
 * The real `CliIO`: process streams, the file system, the platform opener and the viewer
 * bundles resolved from `@kgdiff/viewer/standalone` and `@kgdiff/viewer/standalone/compute`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CliError, systemErrorCode } from './errors.js';
import type { CliFileSystem, CliIO, ViewerBundle } from './io.js';

async function readStdin(maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.byteLength;
    if (size > maxBytes) {
      process.stdin.destroy();
      throw new RangeError(`stdin is larger than ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Atomic replace: write `.<name>.<random>.tmp` next to `path` (exclusive create), copy the
 * permissions of an existing file, then rename over `path`. The temporary file is removed on
 * failure.
 */
async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, data, { flag: 'wx', mode: 0o666 });
    const existing = await stat(path).catch(() => undefined);
    if (existing) await chmod(temp, existing.mode & 0o7777);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The real file system (exported for tests that exercise links and case variants). */
export function nodeFileSystem(): CliFileSystem {
  return {
    readFile: (path) => readFile(path),
    writeFile: writeFileAtomic,
    stat: async (path) => {
      try {
        const s = await stat(path);
        return { dev: s.dev, ino: s.ino, size: s.size };
      } catch (error) {
        if (systemErrorCode(error) === 'ENOENT' || systemErrorCode(error) === 'ENOTDIR') {
          return undefined;
        }
        throw error;
      }
    },
    realpath: (path) => realpath(path),
  };
}

/** Command that opens a file with the default application on this platform. */
export function openCommand(
  platform: NodeJS.Platform,
  path: string,
): { command: string; args: string[]; verbatim: boolean } {
  if (platform === 'darwin') return { command: 'open', args: [path], verbatim: false };
  if (platform === 'win32') {
    // `start` takes its first quoted argument as a window title, hence the empty "". With /s,
    // cmd strips the outer quotes and runs the rest verbatim.
    return { command: 'cmd', args: ['/d', '/s', '/c', `"start "" "${path}""`], verbatim: true };
  }
  return { command: 'xdg-open', args: [path], verbatim: false };
}

function openFile(path: string): Promise<void> {
  const { command, args, verbatim } = openCommand(process.platform, path);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const VIEWER_SPECIFIERS: Readonly<Record<ViewerBundle, string>> = {
  main: '@kgdiff/viewer/standalone',
  compute: '@kgdiff/viewer/standalone/compute',
};

async function loadViewerBundle(part: ViewerBundle): Promise<string> {
  const specifier = VIEWER_SPECIFIERS[part];
  const what = part === 'main' ? 'standalone viewer bundle' : 'viewer compute add-on';
  const hint =
    'Build it with `pnpm --filter @kgdiff/viewer build` (development) or reinstall kgdiff.';
  let path: string;
  try {
    path = createRequire(import.meta.url).resolve(specifier);
  } catch (error) {
    throw new CliError(
      'viewer-missing',
      `The HTML report needs the ${what} (${specifier}), which was not found.`,
      hint,
      { cause: error },
    );
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError('viewer-missing', `Cannot read the ${what} at ${path}.`, hint, {
      cause: error,
    });
  }
}

/** `CliIO` bound to the current process. */
export function nodeIO(): CliIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    readStdin,
    fs: nodeFileSystem(),
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    columns: process.stdout.isTTY ? process.stdout.columns : undefined,
    runtime: `${process.platform} ${process.arch}, Node.js ${process.version}`,
    now: () => new Date(),
    makeTempDir: () => mkdtemp(join(tmpdir(), 'kgdiff-')),
    openFile,
    loadViewerBundle,
  };
}
