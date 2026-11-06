/**
 * Test harness: runs `main` in-process against a fake `CliIO` (captured streams, in-memory
 * writes, read-through to repository files, fixed clock, injected viewer bundle).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { CliError, type CliIO, main } from '../src/index.js';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const DATASETS = resolve(REPO, 'examples/datasets');
export const CWD = '/work';
export const FAKE_COMPUTE = '/* fake compute */ globalThis.KgdiffCompute = {};';
export const FAKE_BUNDLE =
  '/* fake viewer */ customElements.define("kgdiff-viewer", class extends HTMLElement {});';

export interface TestIOOptions {
  /** Files by path (relative to `CWD` or absolute). */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly stdin?: string | Uint8Array;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly stdinIsTTY?: boolean;
  readonly columns?: number;
  readonly now?: Date;
  /** Viewer bundle source, or an error to reject with. */
  readonly bundle?: string | Error;
  /** Compute add-on source, or an error to reject with. */
  readonly computeBundle?: string | Error;
  readonly openFile?: (path: string) => Promise<void>;
  /** Aliases (symlinks / hard links): path → the file it names (both relative to `CWD`). */
  readonly links?: Readonly<Record<string, string>>;
  /** Simulate a case-insensitive file system. */
  readonly caseInsensitive?: boolean;
}

export interface TestRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Files written, by absolute path. */
  readonly written: ReadonlyMap<string, Uint8Array>;
  readonly opened: readonly string[];
  /** Text of a written file (relative to `CWD` or absolute). */
  file(path: string): string;
}

/** Paths in a `missing-dir` directory do not exist (`resolve` gives `\` separators on Windows). */
const MISSING_DIR = /[\\/]missing-dir([\\/]|$)/;

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: 'ENOENT',
  });
}

export function createTestIO(options: TestIOOptions = {}): {
  io: CliIO;
  out: { stdout: string; stderr: string };
  written: Map<string, Uint8Array>;
  opened: string[];
} {
  const out = { stdout: '', stderr: '' };
  const memory = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(options.files ?? {})) {
    memory.set(
      resolve(CWD, path),
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    );
  }
  const links = new Map(
    Object.entries(options.links ?? {}).map(([from, to]) => [resolve(CWD, from), resolve(CWD, to)]),
  );
  const canon = (path: string): string => {
    const target = links.get(path) ?? path;
    return options.caseInsensitive ? target.toLowerCase() : target;
  };
  if (options.caseInsensitive) {
    for (const [path, data] of [...memory]) {
      memory.delete(path);
      memory.set(canon(path), data);
    }
  }
  const written = new Map<string, Uint8Array>();
  const opened: string[] = [];
  const inodes = new Map<string, number>();
  const lookup = (path: string): Uint8Array | undefined => {
    const key = canon(path);
    const hit = written.get(key) ?? memory.get(key);
    if (hit) return hit;
    if (isAbsolute(path) && path.startsWith(REPO) && existsSync(path)) return readFileSync(path);
    return undefined;
  };
  let temps = 0;
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
      const data =
        typeof options.stdin === 'string'
          ? new TextEncoder().encode(options.stdin)
          : (options.stdin ?? new Uint8Array());
      if (data.byteLength > maxBytes) throw new RangeError('stdin too large');
      return data;
    },
    fs: {
      readFile: async (path) => {
        const hit = lookup(path);
        if (!hit) throw enoent(path);
        return hit;
      },
      writeFile: async (path, data) => {
        if (MISSING_DIR.test(path)) throw enoent(path);
        // Atomic replace: a link at `path` is replaced, not written through.
        links.delete(path);
        written.set(canon(path), typeof data === 'string' ? new TextEncoder().encode(data) : data);
      },
      stat: async (path) => {
        const data = lookup(path);
        if (!data) return undefined;
        const key = canon(path);
        if (!inodes.has(key)) inodes.set(key, inodes.size + 1);
        return { dev: 1, ino: inodes.get(key) as number, size: data.byteLength };
      },
      realpath: async (path) => {
        if (MISSING_DIR.test(path)) throw enoent(path);
        return links.get(path) ?? path;
      },
    },
    env: options.env ?? {},
    cwd: CWD,
    isTTY: options.isTTY ?? false,
    stderrIsTTY: options.stderrIsTTY ?? false,
    stdinIsTTY: options.stdinIsTTY ?? false,
    columns: options.columns,
    runtime: 'testos x64, Node.js v0.0.0',
    now: () => options.now ?? new Date('2026-11-01T12:00:00.000Z'),
    makeTempDir: async () => `/tmp/kgdiff-${++temps}`,
    openFile: options.openFile ?? (async (path) => void opened.push(path)),
    loadViewerBundle: async (part) => {
      const bundle =
        part === 'compute'
          ? (options.computeBundle ?? FAKE_COMPUTE)
          : (options.bundle ?? FAKE_BUNDLE);
      if (bundle instanceof Error) throw bundle;
      return bundle;
    },
  };
  return { io, out, written, opened };
}

export async function run(argv: readonly string[], options: TestIOOptions = {}): Promise<TestRun> {
  const { io, out, written, opened } = createTestIO(options);
  const code = await main(argv, io);
  return {
    code,
    stdout: out.stdout,
    stderr: out.stderr,
    written,
    opened,
    file(path) {
      const absolute = resolve(CWD, path);
      const data = written.get(absolute) ?? written.get(absolute.toLowerCase());
      if (!data)
        throw new Error(`${path} was not written (have: ${[...written.keys()].join(', ')})`);
      return new TextDecoder().decode(data);
    },
  };
}

export interface Dataset {
  readonly before: string;
  readonly after: string;
  /** CLI flags equivalent to meta.json `options`. */
  readonly flags: readonly string[];
}

/** Paths and flags of an example dataset (`examples/datasets/<id>`). */
export function dataset(id: string): Dataset {
  const dir = resolve(DATASETS, id);
  const meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as {
    files: { before: string; after: string };
    options?: {
      match?: { strategy?: string; threshold?: number };
      hierarchyPredicates?: string[];
      edgeIdentity?: string;
      ignoreAttrs?: string[];
      detectMerges?: boolean;
      detectSplits?: boolean;
    };
  };
  const o = meta.options ?? {};
  const flags: string[] = [];
  if (o.match?.strategy) flags.push('--match', o.match.strategy);
  if (o.match?.threshold !== undefined) flags.push('--threshold', String(o.match.threshold));
  for (const p of o.hierarchyPredicates ?? []) flags.push('--hierarchy', p);
  if (o.edgeIdentity) flags.push('--edge-identity', o.edgeIdentity);
  for (const k of o.ignoreAttrs ?? []) flags.push('--ignore-attr', k);
  if (o.detectMerges === false) flags.push('--no-merges');
  if (o.detectSplits === false) flags.push('--no-splits');
  return { before: resolve(dir, meta.files.before), after: resolve(dir, meta.files.after), flags };
}

/** Decode the payload embedded in an HTML report. */
export function extractPayload(html: string): { encoding?: string; payload: unknown } {
  const match = /<script type="application\/kgdiff\+json"([^>]*)>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('no payload script');
  const attrs = match[1] ?? '';
  const body = match[2] ?? '';
  if (attrs.includes('data-encoding="gzip-base64"')) {
    const json = gunzipSync(Buffer.from(body, 'base64')).toString('utf8');
    return { encoding: 'gzip-base64', payload: JSON.parse(json) };
  }
  return { payload: JSON.parse(body) };
}

export { CliError };
