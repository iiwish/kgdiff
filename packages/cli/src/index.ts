/**
 * kgdiff CLI: `kgdiff <before> <after>` and `kgdiff apply <graph> <delta>` (docs/cli.md).
 *
 * `main` runs the CLI in-process against an injected `CliIO` (see `nodeIO` for the real one);
 * the building blocks below are pure and reusable: argument parsing, terminal rendering,
 * Markdown, the HTML report and the width / color helpers they rest on.
 */

export { readDelta } from './apply-command.js';
export {
  type ApplyCommandOptions,
  type Command,
  type CommonOptions,
  DEFAULT_LIMIT,
  type DiffCommandOptions,
  parseCommandLine,
  STDIO,
} from './args.js';
export { defaultTitle, describeDiff, graphLabel, outputWidth } from './diff-command.js';
export { CliError, type CliErrorCode, describeError, formatError } from './errors.js';
export { renderHelp } from './help.js';
export {
  encodePayload,
  escapeHtml,
  GZIP_THRESHOLD,
  PAYLOAD_TYPE,
  type ReportHtmlOptions,
  renderReportHtml,
  scriptSafeJs,
  scriptSafeJson,
} from './html.js';
export type { CliFileSystem, CliIO, OutputStream } from './io.js';
export { formatInt, matchLocale, messages, resolveLocale } from './locale.js';
export { main } from './main.js';
export {
  escapeMarkdown,
  MARKDOWN_HUNK_LIMIT,
  type MarkdownOptions,
  renderMarkdown,
} from './markdown.js';
export {
  type ChangeFamily,
  DEFAULT_WATCH_ATTRS,
  hunkFamily,
  hunkGlyph,
  KIND_FAMILY,
  type NameStatus,
  nameStatus,
  type Overview,
  overview,
  watchedChanges,
} from './model.js';
export { nodeIO, openCommand } from './node-io.js';
export { buildReportHtml, buildReportPayload, createGzip, type ReportInfo } from './report.js';
export {
  type ColorLevel,
  type ColorMode,
  createPainter,
  type Painter,
  resolveColorLevel,
  stripAnsi,
  type Tone,
} from './style.js';
export {
  diffstatBar,
  renderNameStatus,
  renderStat,
  renderSummary,
  type TextContext,
  totalsText,
} from './summary.js';
export { cliVersion } from './version.js';
export { graphemeWidth, padEnd, padStart, sanitize, stringWidth, truncate, wrap } from './width.js';
