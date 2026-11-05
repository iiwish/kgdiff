/**
 * `kgdiff <before> <after>`: read, parse, diff, then write every requested output.
 */
import { join } from 'node:path';
import {
  type DiffResult,
  diff,
  diffToJSON,
  type GraphIssue,
  type GraphMeta,
  type Locale,
} from '@kgdiff/core';
import type { ParseResult, ParseWarning } from '@kgdiff/formats';
import { type DiffCommandOptions, STDIO } from './args.js';
import { CliError, describeError, formatWarning, isKgdiffError } from './errors.js';
import { parseInput, type RawInput, readInput, readPair, resolvePath } from './inputs.js';
import type { CliIO } from './io.js';
import { messages } from './locale.js';
import { overview } from './model.js';
import { type OutputContext, outputContext, writeOutputFile } from './output.js';
import { checkNoOverwrite } from './overwrite.js';
import {
  renderNameStatus,
  renderStat,
  renderSummary,
  type TextContext,
  totalsText,
} from './summary.js';
import { cliVersion } from './version.js';
import { sanitize } from './width.js';

/** Upper bound of the layout width, however wide the terminal. */
const MAX_WIDTH = 120;
/** Narrowest layout: below it lines are laid out for 40 columns (and wrap in the terminal). */
export const MIN_WIDTH = 40;
/** Width assumed when stdout is not a terminal and `COLUMNS` is unset. */
const PIPE_WIDTH = 120;

/**
 * Columns available for text output: the terminal width on a TTY (falling back to `COLUMNS`,
 * then 80, when the terminal reports none), else `COLUMNS` or 120; clamped to 40–120.
 */
export function outputWidth(io: CliIO): number {
  const fromEnv = Number(io.env.COLUMNS);
  const env = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined;
  const terminal = io.columns !== undefined && io.columns > 0 ? io.columns : undefined;
  const columns = io.isTTY ? (terminal ?? env ?? 80) : (env ?? PIPE_WIDTH);
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(columns)));
}

/** Display name of one side: `name version` from graph meta, else the file name. */
export function graphLabel(meta: GraphMeta | undefined, input: RawInput): string {
  const name = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : undefined;
  const version =
    typeof meta?.version === 'string' && meta.version.trim() ? meta.version.trim() : undefined;
  if (name && version) return `${name} ${version}`;
  return name ?? input.display;
}

/**
 * Default title: `name v1 → v2` when both sides share a name, `label → label` when their
 * labels differ, else the inputs as given (`a/g.json → b/g.json`).
 */
export function defaultTitle(
  before: { meta: GraphMeta | undefined; input: RawInput },
  after: { meta: GraphMeta | undefined; input: RawInput },
): string {
  const lb = graphLabel(before.meta, before.input);
  const la = graphLabel(after.meta, after.input);
  const nb = before.meta?.name;
  const vb = before.meta?.version;
  const va = after.meta?.version;
  if (
    typeof nb === 'string' &&
    nb.trim() &&
    nb === after.meta?.name &&
    typeof vb === 'string' &&
    typeof va === 'string' &&
    vb.trim() &&
    va.trim() &&
    vb !== va
  ) {
    return `${nb.trim()} ${vb.trim()} → ${va.trim()}`;
  }
  return lb !== la ? `${lb} → ${la}` : `${before.input.display} → ${after.input.display}`;
}

function reportParseWarnings(
  ctx: OutputContext,
  input: RawInput,
  warnings: readonly ParseWarning[],
): void {
  const byCode = new Map<string, ParseWarning[]>();
  for (const w of warnings) byCode.set(w.code, [...(byCode.get(w.code) ?? []), w]);
  for (const list of byCode.values()) {
    const first = list[0] as ParseWarning;
    const where = first.line !== undefined ? `${input.display}:${first.line}` : input.display;
    const more = list.length > 1 ? ` (and ${list.length - 1} more like this)` : '';
    ctx.notice(formatWarning(`${where}: ${sanitize(first.message)}${more}`, ctx.errPaint));
  }
}

function reportIssues(ctx: OutputContext, input: RawInput, issues: readonly GraphIssue[]): void {
  const byCode = new Map<string, GraphIssue[]>();
  for (const issue of issues) byCode.set(issue.code, [...(byCode.get(issue.code) ?? []), issue]);
  for (const list of byCode.values()) {
    const first = list[0] as GraphIssue;
    const more = list.length > 1 ? ` (and ${list.length - 1} more like this)` : '';
    ctx.notice(formatWarning(`${input.display}: ${sanitize(first.message)}${more}`, ctx.errPaint));
  }
}

function checkOutputPaths(o: DiffCommandOptions, io: CliIO): Promise<void> {
  return checkNoOverwrite(
    io,
    [
      { role: '<before>', path: o.before },
      { role: '<after>', path: o.after },
    ],
    [
      { role: '--json', path: o.json },
      { role: '--delta', path: o.delta },
      { role: '--markdown', path: o.markdown },
      { role: '--html', path: o.html },
    ],
  );
}

function json(value: unknown, pretty: boolean): string {
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}

function runDiffEngine(before: ParseResult, after: ParseResult, o: DiffCommandOptions): DiffResult {
  try {
    return diff(before.graph, after.graph, o.diff);
  } catch (error) {
    if (isKgdiffError(error) && error.code === 'invalid-input') {
      throw new CliError(
        'input',
        error.message,
        'Check the diff options. Run `kgdiff --help` for usage.',
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

/** Short description of the diff (HTML meta description and `<noscript>`). */
export function describeDiff(result: DiffResult, locale: Locale): string {
  const m = messages(locale);
  const ov = overview(result);
  const totals = totalsText(result, m);
  return ov.hunks === 0
    ? `${m.identical} · ${totals}`
    : `${m.changes(ov.changes, ov.hunks)} · ${totals}`;
}

/**
 * The viewer's compute add-on for reports laid out around their changes, unless
 * `--no-compute`. A missing add-on only costs the ability to expand collapsed groups, so it is
 * a warning, not an error.
 */
async function loadCompute(
  o: DiffCommandOptions,
  io: CliIO,
  ctx: OutputContext,
): Promise<string | undefined> {
  if (!o.compute) return undefined;
  try {
    return await io.loadViewerBundle('compute');
  } catch (error) {
    ctx.notice(
      formatWarning(
        `${describeError(error).message} The report is written without it: collapsed groups cannot be expanded. Pass --no-compute to skip it.`,
        ctx.errPaint,
      ),
    );
    return undefined;
  }
}

/** Run the diff command. Returns the exit code. */
export async function runDiff(o: DiffCommandOptions, io: CliIO): Promise<number> {
  const ctx = outputContext(io, o);
  await checkOutputPaths(o, io);
  const wantsHtml = o.html !== undefined || o.open;
  // Fail fast, before any parsing, when the HTML report cannot be built.
  const bundle = wantsHtml ? await io.loadViewerBundle('main') : undefined;

  const [beforeInput, afterInput] = await readPair(
    readInput(io, o.before, '<before>', { allowEmpty: o.allowEmpty }),
    readInput(io, o.after, '<after>', { allowEmpty: o.allowEmpty }),
  );
  const before = parseInput(beforeInput, {
    format: o.beforeFormat,
    formatFlag: o.beforeFormat === o.afterFormat ? '--format' : '--before-format',
    ...(o.languages ? { languages: o.languages } : {}),
  });
  const after = parseInput(afterInput, {
    format: o.afterFormat,
    formatFlag: o.beforeFormat === o.afterFormat ? '--format' : '--after-format',
    ...(o.languages ? { languages: o.languages } : {}),
  });
  reportParseWarnings(ctx, beforeInput, before.warnings);
  reportParseWarnings(ctx, afterInput, after.warnings);

  const result = runDiffEngine(before, after, o);
  reportIssues(ctx, beforeInput, result.before.issues);
  reportIssues(ctx, afterInput, result.after.issues);

  const title =
    o.title ??
    defaultTitle(
      { meta: before.graph.meta, input: beforeInput },
      { meta: after.graph.meta, input: afterInput },
    );
  const generator = `kgdiff ${cliVersion()}`;

  // HTML: written to -o, or to a temporary file when only --open was given.
  let htmlPath = o.html;
  if (htmlPath === undefined && o.open) {
    // A fresh private directory (mkdtemp): no predictable path another user could pre-create.
    htmlPath = join(await io.makeTempDir(), 'kgdiff-report.html');
  }
  const files: { path: string; content: string; label: string }[] = [];
  let stdoutText: string | undefined;
  if (o.json !== undefined && o.json !== STDIO) {
    files.push({ path: o.json, content: json(diffToJSON(result), o.pretty), label: 'diff' });
  }
  if (o.delta !== undefined && o.delta !== STDIO) {
    files.push({ path: o.delta, content: json(result.delta, o.pretty), label: 'delta' });
  }
  if (o.markdown !== undefined) {
    const { renderMarkdown } = await import('./markdown.js');
    const md = renderMarkdown(result, {
      locale: ctx.locale,
      title,
      generator,
      ...(o.watchAttrs ? { watch: o.watchAttrs } : {}),
    });
    if (o.markdown !== STDIO)
      files.push({ path: o.markdown, content: md, label: 'Markdown summary' });
    else stdoutText = md;
  }
  if (bundle !== undefined && htmlPath !== undefined) {
    const { buildReportHtml } = await import('./report.js');
    const html = await buildReportHtml(
      result,
      {
        title,
        generator,
        ...(o.reproducible ? {} : { generatedAt: io.now().toISOString() }),
        before: { name: graphLabel(before.graph.meta, beforeInput), format: before.format },
        after: { name: graphLabel(after.graph.meta, afterInput), format: after.format },
        view: {
          ...(o.mode ? { mode: o.mode } : {}),
          ...(o.scope ? { scope: o.scope } : {}),
          ...(o.theme ? { theme: o.theme } : {}),
          locale: ctx.locale,
        },
      },
      { main: bundle, compute: () => loadCompute(o, io, ctx) },
      describeDiff(result, ctx.locale),
    );
    files.push({ path: htmlPath, content: html, label: 'report' });
  }

  for (const file of files) await writeOutputFile(ctx, file.path, file.content, file.label);

  if (o.open && htmlPath !== undefined) {
    try {
      await io.openFile(resolvePath(io, htmlPath));
    } catch (error) {
      ctx.notice(
        formatWarning(
          `Could not open the report (${error instanceof Error ? error.message : String(error)}). Open ${sanitize(htmlPath)} manually.`,
          ctx.errPaint,
        ),
      );
    }
  }

  if (stdoutText === undefined && !o.quiet) {
    const text: TextContext = {
      paint: ctx.paint,
      locale: ctx.locale,
      width: outputWidth(io),
      limit: o.limit,
      ...(o.watchAttrs ? { watch: o.watchAttrs } : {}),
    };
    if (o.json === STDIO) stdoutText = json(diffToJSON(result), o.pretty);
    else if (o.delta === STDIO) stdoutText = json(result.delta, o.pretty);
    else if (o.stat || o.nameStatus) {
      const parts: string[] = [];
      if (o.stat) parts.push(renderStat(result, title, text));
      if (o.nameStatus) parts.push(renderNameStatus(result, text, io.isTTY));
      stdoutText = parts.filter(Boolean).join('\n');
    } else stdoutText = renderSummary(result, title, text);
  }
  if (stdoutText !== undefined) ctx.stdout(stdoutText);

  return o.exitCode && !result.stats.identical ? 1 : 0;
}
