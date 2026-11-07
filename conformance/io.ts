/**
 * A `CliIO` for running the CLI in-process on the corpus: real files under the case directory
 * (overlaid with outputs generated earlier in the same run), stdin from a file, captured stdout and
 * stderr, no TTY, a fixed clock and environment, and no way to open browsers or create
 * directories. Writing files and loading the viewer bundles are refused, except for the report
 * run, which captures what it writes in memory and gets stand-ins for the bundles.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliIO } from '@kgdiff/cli';

/** `main` (the viewer) or `compute` (the add-on). */
export type ViewerBundle = Parameters<CliIO['loadViewerBundle']>[0];

export interface CapturedRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CorpusIOOptions {
  /** Working directory: the case directory. */
  readonly cwd: string;
  /** Only these variables are visible to the CLI. */
  readonly env: Readonly<Record<string, string>>;
  /** Files generated earlier in this run, by absolute path; they win over the disk. */
  readonly overlay: ReadonlyMap<string, Uint8Array>;
  /** Bytes piped to stdin (empty when absent); stdin is never a terminal. */
  readonly stdin?: Uint8Array;
  /** Where written files go, by absolute path; without it, writing a file is an error. */
  readonly writes?: Map<string, Uint8Array>;
  /** Sources of the viewer bundles; without them, building an HTML report is an error. */
  readonly viewerBundles?: Readonly<Record<ViewerBundle, string>>;
}

const encoder = new TextEncoder();

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: 'ENOENT',
  });
}

export function corpusIO(options: CorpusIOOptions): {
  io: CliIO;
  out: { stdout: string; stderr: string };
} {
  const out = { stdout: '', stderr: '' };
  const read = (path: string): Uint8Array | undefined => {
    const hit = options.overlay.get(resolve(path));
    if (hit) return hit;
    try {
      return readFileSync(path);
    } catch {
      return undefined;
    }
  };
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`The conformance corpus never ${what}.`);
  };
  const { writes, viewerBundles } = options;
  const io: CliIO = {
    stdout: {
      write: (chunk) => {
        out.stdout += chunk;
      },
    },
    stderr: {
      write: (chunk) => {
        out.stderr += chunk;
      },
    },
    readStdin: async (maxBytes) => {
      const data = options.stdin ?? new Uint8Array();
      if (data.byteLength > maxBytes) throw new RangeError('stdin is larger than the input limit');
      return data;
    },
    fs: {
      readFile: async (path) => {
        const data = read(path);
        if (!data) throw enoent(path);
        return data;
      },
      writeFile: writes
        ? async (path, data) => {
            writes.set(resolve(path), typeof data === 'string' ? encoder.encode(data) : data);
          }
        : refuse('writes files'),
      stat: async (path) => {
        const data = read(path);
        if (!data) return undefined;
        try {
          const s = statSync(path);
          return { dev: s.dev, ino: s.ino, size: data.byteLength };
        } catch {
          // A generated file that is not on disk yet: give it an inode of its own.
          return { dev: -1, ino: options.overlay.size, size: data.byteLength };
        }
      },
      realpath: async (path) => {
        if (options.overlay.has(resolve(path))) return resolve(path);
        return realpathSync(path);
      },
    },
    env: options.env,
    cwd: options.cwd,
    isTTY: false,
    stderrIsTTY: false,
    stdinIsTTY: false,
    columns: undefined,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    makeTempDir: refuse('creates directories'),
    openFile: refuse('opens files'),
    loadViewerBundle: viewerBundles
      ? async (part) => viewerBundles[part]
      : refuse('builds HTML reports outside the report run'),
  };
  return { io, out };
}
