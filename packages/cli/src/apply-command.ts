/**
 * `kgdiff apply <graph> <delta>`: apply a delta (docs/delta-format.md) and write the patched
 * graph as kgdiff JSON.
 */
import { basename } from 'node:path';
import {
  applyDelta,
  type Delta,
  type EdgeIdentity,
  type GraphJSON,
  graphToJSON,
  hashGraph,
  type KGraph,
  normalize,
} from '@kgdiff/core';
import { type ApplyCommandOptions, STDIO } from './args.js';
import { CliError, formatWarning, isKgdiffError } from './errors.js';
import { parseInput, type RawInput, readInput, readPair } from './inputs.js';
import type { CliIO } from './io.js';
import { formatInt } from './locale.js';
import { outputContext, writeOutputFile } from './output.js';
import { checkNoOverwrite } from './overwrite.js';
import { sanitize } from './width.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The four hex digits at `at` as a UTF-16 unit, or -1. */
function hexUnit(text: string, at: number): number {
  const digits = text.slice(at, at + 4);
  return /^[0-9a-fA-F]{4}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
}

/**
 * Offset of the first `\uD800`–`\uDFFF` escape in valid JSON text that is not half of an
 * escaped surrogate pair, or -1. `JSON.parse` accepts such a lone surrogate; kgdiff does not, in
 * any input (RFC 0002, D-2; `@kgdiff/formats` reads graphs the same way).
 */
function loneSurrogateEscape(text: string): number {
  if (!/\\u[dD][89a-fA-F]/.test(text)) return -1;
  for (let i = text.indexOf('\\'); i !== -1; i = text.indexOf('\\', i)) {
    if (text[i + 1] !== 'u') {
      i += 2;
      continue;
    }
    const unit = hexUnit(text, i + 2);
    if (unit >= 0xd800 && unit <= 0xdbff && text.startsWith('\\u', i + 6)) {
      const low = hexUnit(text, i + 8);
      if (low >= 0xdc00 && low <= 0xdfff) {
        i += 12;
        continue;
      }
    }
    if (unit >= 0xd800 && unit <= 0xdfff) return i;
    i += 6;
  }
  return -1;
}

/**
 * Read a delta from JSON text. Accepts a `kgdiff.delta` document, or a `kgdiff.diff` document
 * (`--json` output), whose delta is used. Version checks are left to `applyDelta`.
 */
export function readDelta(input: RawInput): Delta {
  const where = input.display === 'stdin' ? 'stdin' : `"${input.display}"`;
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch (error) {
    throw new CliError(
      'input',
      `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      'Create a delta with `kgdiff <before> <after> --delta <file>`.',
      { cause: error },
    );
  }
  const lone = loneSurrogateEscape(input.text);
  if (lone !== -1) {
    const before = input.text.slice(0, lone);
    const line = before.split('\n').length;
    const column = lone - before.lastIndexOf('\n');
    throw new CliError(
      'input',
      `${where} is not valid JSON: on line ${line}, column ${column}, the escape ${input.text.slice(lone, lone + 6)} is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept.`,
      'Create a delta with `kgdiff <before> <after> --delta <file>`.',
    );
  }
  if (isRecord(value) && value.format === 'kgdiff.diff' && isRecord(value.delta)) {
    return value.delta as unknown as Delta;
  }
  if (!isRecord(value) || value.format !== 'kgdiff.delta') {
    throw new CliError(
      'input',
      `${where} is not a kgdiff delta (expected "format": "kgdiff.delta").`,
      'Create one with `kgdiff <before> <after> --delta <file>`. Is the order <graph> <delta>?',
    );
  }
  return value as unknown as Delta;
}

/**
 * The patched graph as kgdiff JSON (`graphToJSON`, which `kgdiff` reads back losslessly).
 *
 * Meta: `name` / `version` come from the delta's target (`applyDelta`); `source` names the
 * output file (`source` argument), or is dropped when writing to stdout, so the result never
 * claims to be the input file.
 */
export function graphOutputJSON(graph: KGraph, source?: string): GraphJSON {
  const { format, version, meta, nodes, edges } = graphToJSON(graph);
  const { source: _inputSource, ...rest } = meta ?? {};
  const outMeta = source !== undefined ? { ...rest, source } : rest;
  return Object.keys(outMeta).length > 0
    ? { format, version, meta: outMeta, nodes, edges }
    : { format, version, nodes, edges };
}

const EDGE_IDENTITIES: readonly unknown[] = ['structure', 'id'];

export interface SkippedOp {
  /** Index in `delta.ops`. */
  readonly index: number;
  readonly op: string;
  readonly reason: string;
}

/**
 * `--no-strict`: apply every operation whose precondition holds, in one pass, and collect the
 * skipped ones (core's `onSkip`, in op order).
 */
export function applyLeniently(
  graph: KGraph,
  delta: Delta,
): { readonly result: KGraph; readonly skipped: readonly SkippedOp[] } {
  const skipped: SkippedOp[] = [];
  const result = applyDelta(graph, delta, {
    strict: false,
    onSkip: ({ index, op, reason }) => skipped.push({ index, op: String(op.op), reason }),
  });
  return { result, skipped };
}

const PARSE_OPTIONS_HINT =
  'If it is the same graph, parse it as when the delta was made: --format and --lang must match ' +
  'the options given to `kgdiff … --delta` (they change what the graph contains).';

/** Run the apply command. Returns the exit code. */
export async function runApply(o: ApplyCommandOptions, io: CliIO): Promise<number> {
  const ctx = outputContext(io, o);
  await checkNoOverwrite(
    io,
    [
      { role: '<graph>', path: o.graph },
      { role: '<delta>', path: o.delta },
    ],
    [{ role: '-o', path: o.output }],
  );
  const [graphInput, deltaInput] = await readPair(
    readInput(io, o.graph, '<graph>', { allowEmpty: o.allowEmpty }),
    readInput(io, o.delta, '<delta>', {
      emptyHint: 'Create a delta with `kgdiff <before> <after> --delta <file>`.',
    }),
  );
  const delta = readDelta(deltaInput);
  const parsed = parseInput(graphInput, {
    format: o.format,
    formatFlag: '--format',
    ...(o.languages ? { languages: o.languages } : {}),
  });
  const edgeIdentity = EDGE_IDENTITIES.includes(delta.edgeIdentity)
    ? { edgeIdentity: delta.edgeIdentity as EdgeIdentity }
    : {};
  const graph = normalize(parsed.graph, edgeIdentity);

  let result: KGraph;
  let skipped: readonly SkippedOp[] = [];
  if (o.strict) {
    try {
      result = applyDelta(graph, delta, { strict: true });
    } catch (error) {
      if (isKgdiffError(error) && error.code === 'delta-base-mismatch') {
        const { expected, actual } = error.details ?? {};
        const where = o.graph === STDIO ? '<graph> (stdin)' : `<graph> "${o.graph}"`;
        throw new CliError(
          'input',
          `${where} is not the base of this delta (graph ${String(actual)}, delta base ${String(expected)}).`,
          `${PARSE_OPTIONS_HINT} Otherwise --no-strict applies what fits and reports the rest.`,
          { cause: error },
        );
      }
      if (isKgdiffError(error) && error.code === 'delta-conflict') {
        throw new CliError(
          'input',
          error.message,
          `The graph differs from the delta's base. --no-strict applies the operations that fit and reports the others. ${PARSE_OPTIONS_HINT}`,
          { cause: error },
        );
      }
      throw error;
    }
  } else {
    const lenient = applyLeniently(graph, delta);
    result = lenient.result;
    skipped = lenient.skipped;
    if (skipped.length > 0) {
      const total = delta.ops.length;
      const count = formatInt(skipped.length);
      ctx.notice(
        formatWarning(
          `Skipped ${count} of ${formatInt(total)} ${total === 1 ? 'operation' : 'operations'} that do not fit this graph${o.verbose ? ':' : ' (--verbose lists them).'}`,
          ctx.errPaint,
        ),
      );
      if (o.verbose) {
        for (const s of skipped) {
          ctx.notice(`  #${s.index} ${sanitize(s.op)}: ${sanitize(s.reason)}\n`);
        }
      }
    }
  }

  const hash = hashGraph(result);
  const target = isRecord(delta.target) ? delta.target.hash : undefined;
  if (typeof target === 'string' && hash !== target && skipped.length === 0) {
    ctx.notice(
      formatWarning(
        `The result (${hash}) differs from the delta's target (${target}).`,
        ctx.errPaint,
      ),
    );
  }
  const source = o.output === STDIO ? undefined : basename(o.output);
  const text = `${JSON.stringify(graphOutputJSON(result, source), null, o.pretty ? 2 : undefined)}\n`;
  if (o.output === STDIO) {
    ctx.stdout(text);
  } else {
    const ops = delta.ops.length - skipped.length;
    await writeOutputFile(
      ctx,
      o.output,
      text,
      `patched graph (${formatInt(ops)} ${ops === 1 ? 'operation' : 'operations'} applied, ${hash})`,
    );
  }
  return 0;
}
