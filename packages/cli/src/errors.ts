/**
 * Error reporting: every failure becomes one friendly line on stderr (plus a hint), exit code 2.
 * Stack traces only with `DEBUG=kgdiff`.
 */
import type { Painter } from './style.js';
import { sanitize, sanitizeLines } from './width.js';

export type CliErrorCode =
  /** Bad command line. */
  | 'usage'
  /** A file or stdin could not be read, or its content is not a graph / delta. */
  | 'input'
  /** An output file could not be written. */
  | 'output'
  /** The standalone viewer bundle is missing. */
  | 'viewer-missing';

/** An error with a message meant for the user and an optional hint on how to fix it. */
export class CliError extends Error {
  override readonly name = 'CliError';
  constructor(
    readonly code: CliErrorCode,
    message: string,
    readonly hint?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Shape of `KgdiffError` (checked structurally so `--help` never loads `@kgdiff/core`). */
interface KgdiffErrorLike {
  readonly name: 'KgdiffError';
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function isKgdiffError(error: unknown): error is KgdiffErrorLike {
  return (
    error instanceof Error &&
    error.name === 'KgdiffError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** Node.js system error code (`ENOENT`, `EACCES`…), if any. */
export function systemErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : undefined;
}

const SYSTEM_REASONS: Readonly<Record<string, string>> = {
  ENOENT: 'no such file or directory',
  EISDIR: 'is a directory',
  ENOTDIR: 'a path component is not a directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
  ENOSPC: 'no space left on device',
  EMFILE: 'too many open files',
  EEXIST: 'file already exists',
};

/** Short human reason for a system error code. */
export function systemReason(error: unknown): string {
  const code = systemErrorCode(error);
  return (code && SYSTEM_REASONS[code]) ?? (error instanceof Error ? error.message : String(error));
}

const KGDIFF_HINTS: Readonly<Record<string, string>> = {
  'delta-base-mismatch':
    'The delta was made for a different version of this graph. Use --no-strict to apply it anyway.',
  'delta-conflict':
    'The graph changed since the delta was made. --no-strict skips the failing operations.',
  'unsupported-version':
    'Upgrade kgdiff (npm install -g @kgdiff/cli@latest), or check that the file is a kgdiff delta.',
  'dangling-edge': 'An edge refers to a node the graph does not define.',
};

/** User-facing message and hint for any thrown value. */
export function describeError(
  error: unknown,
  bugReportUrl?: string,
): { message: string; hint?: string } {
  if (error instanceof CliError) {
    return error.hint ? { message: error.message, hint: error.hint } : { message: error.message };
  }
  if (isKgdiffError(error)) {
    const hint = KGDIFF_HINTS[error.code];
    return hint ? { message: error.message, hint } : { message: error.message };
  }
  const code = systemErrorCode(error);
  if (code) return { message: systemReason(error) };
  return {
    message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    hint: bugReportUrl
      ? `This is a bug in kgdiff. Run again with DEBUG=kgdiff and report it: ${bugReportUrl}`
      : 'This is a bug in kgdiff. Run again with DEBUG=kgdiff and report the output.',
  };
}

/** True when `DEBUG` enables kgdiff diagnostics (`kgdiff`, `kgdiff*`, `*`, comma-separated). */
export function debugEnabled(debug: string | undefined): boolean {
  return (debug ?? '')
    .split(/[\s,]+/)
    .some((d) => d === '*' || d === 'kgdiff' || d === 'kgdiff*' || d === 'kgdiff:*');
}

/** The text written to stderr for an error (ends with a newline). */
export function formatError(
  error: unknown,
  paint: Painter,
  debug: boolean,
  bugReportUrl?: string,
): string {
  // Messages quote user input (paths, parser snippets, JSON.parse excerpts): never let it
  // carry escape sequences or bidi controls to the terminal.
  const { message, hint } = describeError(error, bugReportUrl);
  const lines = [`${paint.bold(paint.tone('removed', 'error:'))} ${sanitize(message)}`];
  if (hint) lines.push(`${paint.tone('accent', 'hint:')} ${sanitize(hint)}`);
  if (debug) {
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      lines.push(
        '',
        paint.dim(sanitizeLines(current.stack ?? `${current.name}: ${current.message}`)),
      );
      if (isKgdiffError(current) && current.details) {
        lines.push(paint.dim(sanitize(`details: ${JSON.stringify(current.details)}`)));
      }
      current = (current as Error).cause;
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A warning line for stderr. */
export function formatWarning(message: string, paint: Painter): string {
  return `${paint.bold(paint.tone('content', 'warning:'))} ${sanitize(message)}\n`;
}
