/**
 * Everything the CLI needs from the outside world, injected so that `main` runs in-process in
 * tests (fake streams, in-memory files, fixed clock) and for real in `bin.ts` (`nodeIO`).
 */
import type { Env } from './style.js';

/** The standalone viewer bundles an HTML report can inline. */
export type ViewerBundle = 'main' | 'compute';

/** A writable text stream (stdout / stderr). */
export interface OutputStream {
  write(chunk: string): void;
}

/** What overwrite checks need to know about an existing file. */
export interface FileStat {
  /** Device and inode: equal for the same file under any name (case variant, link). */
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

export interface CliFileSystem {
  /** Read a whole file. Rejects with a Node-style error (`code`: ENOENT, EISDIR, EACCES…). */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Create or replace a file atomically: write a temporary file in the same directory, then
   * rename it over `path` (readers never see a half-written file; a symlink at `path` is
   * replaced, not written through).
   */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Stat following symlinks; `undefined` when nothing exists at `path`. */
  stat(path: string): Promise<FileStat | undefined>;
  /** Canonical absolute path (symlinks resolved). Rejects when `path` does not exist. */
  realpath(path: string): Promise<string>;
}

export interface CliIO {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  /** Read all of stdin; rejects with a `RangeError` beyond `maxBytes`. */
  readStdin(maxBytes: number): Promise<Uint8Array>;
  readonly fs: CliFileSystem;
  readonly env: Env;
  /** Directory relative paths are resolved against. */
  readonly cwd: string;
  /** Whether stdout is a terminal. */
  readonly isTTY: boolean;
  /** Whether stderr is a terminal (colors of errors and notices). */
  readonly stderrIsTTY: boolean;
  /** Whether stdin is a terminal (nothing piped in). */
  readonly stdinIsTTY: boolean;
  /** Terminal width of stdout, when known. */
  readonly columns: number | undefined;
  /**
   * The platform and runtime, for bug reports: `darwin arm64, Node.js v24.11.0`. Optional:
   * without it the bug report link of an unexpected error names only the CLI version.
   */
  readonly runtime?: string;
  /** Clock for `generatedAt` in HTML reports. */
  now(): Date;
  /** Create a fresh private directory (`mkdtemp`) for reports opened with `--open` and no `-o`. */
  makeTempDir(): Promise<string>;
  /** Open a file with the platform's default application (the browser, for HTML). */
  openFile(path: string): Promise<void>;
  /**
   * Source of a standalone viewer bundle: `main` (`@kgdiff/viewer/standalone`, the
   * `<kgdiff-viewer>` element) or `compute` (`@kgdiff/viewer/standalone/compute`, the optional
   * diff / layout add-on). Rejects with a `CliError` (`viewer-missing`) when it is not built or
   * not installed.
   */
  loadViewerBundle(part: ViewerBundle): Promise<string>;
}
