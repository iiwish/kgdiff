/**
 * Command-line parsing and validation (docs/cli.md §Usage).
 *
 * Built on `node:util` `parseArgs` (tokens mode) with three additions: options with an
 * optional value (`--json [file]`, `--delta [file]`, `--markdown [file]`), "did you mean"
 * suggestions for unknown options and values, and validation into typed commands. Pure: no I/O.
 *
 * Optional values: `--json=out.json` always binds; `--json out.json` binds when the next
 * argument does not start with `-`, unless it is needed as one of the two graph files
 * (`kgdiff --json a.ttl b.ttl` writes JSON to stdout).
 */
import { parseArgs } from 'node:util';
import type { DiffOptions, EdgeIdentity, Locale, MatchOptions } from '@kgdiff/core';
import type { FormatId } from '@kgdiff/formats';
import type { ThemePreference, ViewerMode, ViewerPanels, ViewerScope } from '@kgdiff/viewer';
// The viewer's own panels syntax (no DOM): `--panels` reads exactly what `panels` does.
import { PANEL_REGIONS, PANEL_STATES, parsePanels } from '@kgdiff/viewer/panels';
import { CliError } from './errors.js';
import { matchLocale } from './locale.js';
import type { ColorMode } from './style.js';

/** Path value meaning "write to stdout" / "read from stdin". */
export const STDIO = '-';

export const FORMATS: readonly (FormatId | 'auto')[] = [
  'auto',
  'json',
  'jsonld',
  'turtle',
  'ntriples',
  'nquads',
  'trig',
  'rdfxml',
  'obo',
];
const MATCH_STRATEGIES = ['id', 'auto', 'similarity'] as const;
const EDGE_IDENTITIES: readonly EdgeIdentity[] = ['structure', 'id'];
const THEMES: readonly ThemePreference[] = ['auto', 'light', 'dark'];
/** `changes` is the viewer's legacy mode: overlay + `--scope changes`. */
const MODES: readonly (ViewerMode | 'changes')[] = ['overlay', 'swipe', 'replay', 'changes'];
const SCOPES: readonly ViewerScope[] = ['all', 'changes'];
const COLOR_MODES: readonly ColorMode[] = ['auto', 'always', 'never'];
/** Default `--limit`. */
export const DEFAULT_LIMIT = 50;

export interface CommonOptions {
  readonly color: ColorMode;
  readonly quiet: boolean;
  readonly locale?: Locale;
}

export interface DiffCommandOptions extends CommonOptions {
  /** Paths, or `-` for stdin. */
  readonly before: string;
  readonly after: string;
  readonly beforeFormat: FormatId | 'auto';
  readonly afterFormat: FormatId | 'auto';
  /** `--lang`: RDF label language preference. */
  readonly languages?: readonly string[];
  readonly diff: DiffOptions;
  readonly stat: boolean;
  readonly nameStatus: boolean;
  /** Output path, or `-` for stdout. */
  readonly json?: string;
  readonly delta?: string;
  readonly markdown?: string;
  readonly html?: string;
  readonly open: boolean;
  readonly pretty: boolean;
  readonly title?: string;
  readonly theme?: ThemePreference;
  readonly mode?: ViewerMode;
  readonly scope?: ViewerScope;
  /** `--panels`: the report's initial panel states (`view.panels`). */
  readonly panels?: ViewerPanels;
  readonly reproducible: boolean;
  /** `--allow-empty`: an empty input is an empty graph instead of an error. */
  readonly allowEmpty: boolean;
  /** Inline the viewer's compute add-on when the report needs it (`--no-compute` disables). */
  readonly compute: boolean;
  readonly exitCode: boolean;
  /** Max hunks in the summary; 0 = all. */
  readonly limit: number;
  /**
   * `--watch-attr`: attributes whose changes are flagged ⚑ for review first, replacing the
   * default definitions. Absent when not given.
   */
  readonly watchAttrs?: readonly string[];
}

export interface ApplyCommandOptions extends CommonOptions {
  readonly graph: string;
  readonly delta: string;
  /** Output path, or `-` for stdout. */
  readonly output: string;
  readonly strict: boolean;
  readonly format: FormatId | 'auto';
  readonly languages?: readonly string[];
  readonly pretty: boolean;
  /** `--allow-empty`: an empty <graph> is an empty graph instead of an error. */
  readonly allowEmpty: boolean;
  /** `--verbose`: list the operations `--no-strict` skipped. */
  readonly verbose: boolean;
}

export type Command =
  | { readonly kind: 'help'; readonly topic: 'main' | 'apply'; readonly color: ColorMode }
  | { readonly kind: 'version' }
  | { readonly kind: 'diff'; readonly options: DiffCommandOptions }
  | { readonly kind: 'apply'; readonly options: ApplyCommandOptions };

interface OptionSpec {
  readonly type: 'boolean' | 'string';
  readonly short?: string;
  readonly multiple?: boolean;
  /** `--json [file]`: a string option whose value may be omitted. */
  readonly optionalValue?: boolean;
}

const COMMON: Readonly<Record<string, OptionSpec>> = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  color: { type: 'string' },
  locale: { type: 'string' },
  lang: { type: 'string' },
  pretty: { type: 'boolean' },
};

/** Options of `kgdiff <before> <after>`. */
export const DIFF_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  ...COMMON,
  stat: { type: 'boolean' },
  'name-status': { type: 'boolean' },
  json: { type: 'string', optionalValue: true },
  delta: { type: 'string', optionalValue: true },
  markdown: { type: 'string', optionalValue: true },
  html: { type: 'string', short: 'o' },
  open: { type: 'boolean' },
  format: { type: 'string', short: 'f' },
  'before-format': { type: 'string' },
  'after-format': { type: 'string' },
  match: { type: 'string' },
  threshold: { type: 'string' },
  'edge-identity': { type: 'string' },
  hierarchy: { type: 'string', multiple: true },
  'ignore-attr': { type: 'string', multiple: true },
  'no-merges': { type: 'boolean' },
  'no-splits': { type: 'boolean' },
  title: { type: 'string' },
  theme: { type: 'string' },
  mode: { type: 'string' },
  scope: { type: 'string' },
  panels: { type: 'string', multiple: true },
  reproducible: { type: 'boolean' },
  'no-compute': { type: 'boolean' },
  'allow-empty': { type: 'boolean' },
  'exit-code': { type: 'boolean' },
  limit: { type: 'string' },
  'watch-attr': { type: 'string', multiple: true },
};

/** Options of `kgdiff apply <graph> <delta>`. */
export const APPLY_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  ...COMMON,
  output: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f' },
  'no-strict': { type: 'boolean' },
  'allow-empty': { type: 'boolean' },
  verbose: { type: 'boolean' },
};

/** Edit distance (insertions, deletions, substitutions, adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** Closest candidate within a small edit distance (or sharing a prefix), if any. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  const needle = input.toLowerCase();
  for (const c of candidates) {
    const distance = editDistance(needle, c.toLowerCase());
    const limit = Math.max(1, Math.min(3, Math.floor(c.length / 3)));
    const score = c.startsWith(needle) && needle.length >= 2 ? 0.5 : distance;
    if (score <= limit && score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

const HELP_HINT = 'Run `kgdiff --help` for usage.';

/** Options whose value is a file path (a leading `-` can be written `./-name`). */
function looksLikePath(name: string): boolean {
  return (
    name === 'html' ||
    name === 'output' ||
    name === 'json' ||
    name === 'delta' ||
    name === 'markdown'
  );
}

function usageError(message: string, hint = HELP_HINT): CliError {
  return new CliError('usage', message, hint);
}

/**
 * `--panels "detail:collapsed minimap:hidden"` (pairs separated by spaces or commas, the option
 * repeatable), read by the viewer's own parser; a region named twice takes the last state. The
 * first pair it rejects becomes a usage error that says what is wrong with it.
 */
function panelsOption(values: readonly string[]): ViewerPanels | undefined {
  const { panels, invalid } = parsePanels(values.join(' '));
  const [token] = invalid;
  if (token !== undefined) throw panelsError(token);
  return Object.keys(panels).length > 0 ? panels : undefined;
}

/** Why `parsePanels` rejected `token`: not a pair, an unknown region, or an unknown state. */
function panelsError(token: string): CliError {
  const regions = `Regions: ${PANEL_REGIONS.join(', ')}; states: ${PANEL_STATES.join(', ')}.`;
  const [region = '', state, ...rest] = token.split(':');
  if (state === undefined || rest.length > 0) {
    return usageError(
      `Invalid value "${token}" for --panels.`,
      `Expected region:state pairs, e.g. --panels "detail:collapsed minimap:hidden". ${regions}`,
    );
  }
  if (!(PANEL_REGIONS as readonly string[]).includes(region)) {
    const close = suggest(region, PANEL_REGIONS);
    return usageError(
      `Unknown panel region "${region}" in --panels.`,
      `${close ? `Did you mean "${close}"? ` : ''}${regions}`,
    );
  }
  const close = suggest(state, PANEL_STATES);
  return usageError(
    `Invalid state "${state}" for the ${region} panel in --panels.`,
    `${close ? `Did you mean "${close}"? ` : ''}Expected one of: ${PANEL_STATES.join(', ')}.`,
  );
}

function choice<T extends string>(name: string, value: string, choices: readonly T[]): T {
  if ((choices as readonly string[]).includes(value)) return value as T;
  const close = suggest(value, choices);
  throw usageError(
    `Invalid value "${value}" for --${name}.`,
    `${close ? `Did you mean "${close}"? ` : ''}Expected one of: ${choices.join(', ')}.`,
  );
}

interface RawToken {
  readonly kind: 'option' | 'positional' | 'option-terminator';
  readonly index: number;
  readonly name?: string;
  readonly rawName?: string;
  readonly value?: string;
  readonly inlineValue?: boolean;
}

interface RawParse {
  readonly values: Map<string, (string | true)[]>;
  readonly positionals: string[];
}

/**
 * Tokenize with `parseArgs` and apply kgdiff's rules: known options only, string options need a
 * value (one that starts with `-` must be attached with `=`), booleans take none, optional-value
 * options take the next argument unless it is needed as a positional.
 */
function rawParse(
  argv: readonly string[],
  spec: Readonly<Record<string, OptionSpec>>,
  positionalsNeeded: number,
): RawParse {
  const options: Record<
    string,
    { type: 'boolean' | 'string'; short?: string; multiple?: boolean }
  > = {};
  for (const [name, s] of Object.entries(spec)) {
    options[name] = {
      type: s.optionalValue ? 'boolean' : s.type,
      ...(s.short ? { short: s.short } : {}),
      multiple: true,
    };
  }
  let tokens: RawToken[];
  try {
    tokens = parseArgs({
      args: [...argv],
      options,
      strict: false,
      allowPositionals: true,
      tokens: true,
    }).tokens as RawToken[];
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const known = Object.keys(spec);
  let afterTerminator = false;
  const positionals: { index: number; value: string; candidateFor?: number }[] = [];
  const optionTokens: { token: RawToken; value?: string }[] = [];
  for (const token of tokens) {
    if (token.kind === 'option-terminator') {
      afterTerminator = true;
      continue;
    }
    if (token.kind === 'positional') {
      const prev = optionTokens[optionTokens.length - 1];
      const candidate =
        !afterTerminator &&
        prev !== undefined &&
        prev.token.index === token.index - 1 &&
        spec[prev.token.name ?? '']?.optionalValue === true &&
        prev.token.value === undefined &&
        (!(token.value ?? '').startsWith('-') || token.value === STDIO);
      positionals.push({
        index: token.index,
        value: token.value ?? '',
        ...(candidate ? { candidateFor: optionTokens.length - 1 } : {}),
      });
      continue;
    }
    const name = token.name ?? '';
    const s = spec[name];
    if (!s) {
      const raw = token.rawName ?? name;
      const display = raw.startsWith('-') ? raw : `--${raw}`;
      const close = raw.startsWith('--') || raw.length > 2 ? suggest(name, known) : undefined;
      throw usageError(
        `Unknown option ${display}.`,
        close ? `Did you mean --${close}? ${HELP_HINT}` : HELP_HINT,
      );
    }
    const flag = token.rawName ?? `--${name}`;
    if (s.type === 'boolean' && token.value !== undefined) {
      throw usageError(`Option ${flag} does not take a value.`);
    }
    if (s.type === 'string' && !s.optionalValue) {
      if (token.value === undefined) throw usageError(`Option ${flag} needs a value.`);
      if (!token.inlineValue && token.value.startsWith('-') && token.value !== STDIO) {
        throw usageError(
          `Option ${flag} needs a value, got "${token.value}".`,
          `If that is the value, write --${name}=${token.value}${looksLikePath(name) ? ` or ${flag} ./${token.value}` : ''}. ${HELP_HINT}`,
        );
      }
    }
    optionTokens.push({ token, ...(token.value !== undefined ? { value: token.value } : {}) });
  }
  // Optional values bind greedily; give them back (earliest first) while positionals are missing.
  const free = (): number => positionals.filter((p) => p.candidateFor === undefined).length;
  for (const p of positionals) {
    if (free() >= positionalsNeeded) break;
    if (p.candidateFor !== undefined) delete p.candidateFor;
  }
  for (const p of positionals) {
    const owner = p.candidateFor !== undefined ? optionTokens[p.candidateFor] : undefined;
    if (owner) owner.value = p.value;
  }
  const values = new Map<string, (string | true)[]>();
  for (const { token, value } of optionTokens) {
    const name = token.name as string;
    const list = values.get(name) ?? [];
    list.push(value ?? true);
    values.set(name, list);
  }
  return {
    values,
    positionals: positionals.filter((p) => p.candidateFor === undefined).map((p) => p.value),
  };
}

class Values {
  constructor(private readonly raw: RawParse) {}
  flag(name: string): boolean {
    return this.raw.values.has(name);
  }
  /** Last value of a string option. */
  string(name: string): string | undefined {
    const v = this.raw.values.get(name)?.at(-1);
    return typeof v === 'string' ? v : undefined;
  }
  /** Optional-value option: `undefined` when absent, `-` (stdout) when given without a value. */
  target(name: string): string | undefined {
    const list = this.raw.values.get(name);
    if (!list) return undefined;
    const v = list.at(-1);
    return typeof v === 'string' && v !== '' ? v : STDIO;
  }
  strings(name: string): string[] {
    return (this.raw.values.get(name) ?? []).filter((v): v is string => typeof v === 'string');
  }
}

function parseCommon(v: Values): CommonOptions {
  const color = v.string('color');
  const locale = v.string('locale');
  let resolvedLocale: Locale | undefined;
  if (locale !== undefined) {
    resolvedLocale = matchLocale(locale);
    if (!resolvedLocale) {
      throw usageError(`Unsupported locale "${locale}".`, 'Expected en or zh-CN.');
    }
  }
  return {
    color: color === undefined ? 'auto' : choice('color', color, COLOR_MODES),
    quiet: v.flag('quiet'),
    ...(resolvedLocale ? { locale: resolvedLocale } : {}),
  };
}

function parseLanguages(v: Values): readonly string[] | undefined {
  const lang = v.string('lang');
  if (lang === undefined) return undefined;
  const tags = lang.split(',').map((t) => t.trim());
  if (tags.some((t) => !/^[A-Za-z0-9-]*$/.test(t))) {
    throw usageError(`Invalid --lang "${lang}".`, 'Use comma-separated language tags, e.g. zh,en.');
  }
  return tags;
}

function parseFormat(name: string, value: string | undefined): FormatId | 'auto' | undefined {
  return value === undefined ? undefined : choice(name, value, FORMATS);
}

function parseNumber(
  name: string,
  value: string,
  min: number,
  max: number,
  integer: boolean,
): number {
  const n = Number(value);
  if (
    value.trim() === '' ||
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  ) {
    const range = integer ? `an integer ≥ ${min}` : `a number between ${min} and ${max}`;
    throw usageError(`Invalid value "${value}" for --${name}.`, `Expected ${range}.`);
  }
  return n;
}

function missingGraphs(found: number, names: readonly [string, string]): CliError {
  const missing = names.slice(found).map((n) => `<${n}>`);
  return usageError(
    `Missing ${missing.join(' and ')} ${missing.length === 1 ? 'argument' : 'arguments'}.`,
    `Usage: kgdiff ${names[0] === 'graph' ? 'apply ' : ''}<${names[0]}> <${names[1]}> [options]. ${HELP_HINT}`,
  );
}

function checkPositionals(
  positionals: readonly string[],
  names: readonly [string, string],
): [string, string] {
  if (positionals.length < 2) throw missingGraphs(positionals.length, names);
  if (positionals.length > 2) {
    const extra = positionals
      .slice(2)
      .map((p) => `"${p}"`)
      .join(', ');
    throw usageError(
      `Unexpected ${positionals.length > 3 ? 'arguments' : 'argument'} ${extra}.`,
      `kgdiff ${names[0] === 'graph' ? 'apply ' : ''}takes exactly two files: <${names[0]}> <${names[1]}>. ${HELP_HINT}`,
    );
  }
  const [a, b] = positionals as [string, string];
  if (a === STDIO && b === STDIO) {
    throw usageError(
      'Only one input can be read from stdin.',
      'Pass a file path for the other side.',
    );
  }
  return [a, b];
}

function parseDiff(argv: readonly string[]): Command {
  const raw = rawParse(argv, DIFF_OPTIONS, 2);
  const v = new Values(raw);
  const common = parseCommon(v);
  if (v.flag('help')) return { kind: 'help', topic: 'main', color: common.color };
  if (v.flag('version')) return { kind: 'version' };
  const [before, after] = checkPositionals(raw.positionals, ['before', 'after']);

  const format = parseFormat('format', v.string('format')) ?? 'auto';
  const match: { -readonly [K in keyof MatchOptions]: MatchOptions[K] } = {};
  const strategy = v.string('match');
  if (strategy !== undefined) match.strategy = choice('match', strategy, MATCH_STRATEGIES);
  const threshold = v.string('threshold');
  if (threshold !== undefined) match.threshold = parseNumber('threshold', threshold, 0, 1, false);
  const edgeIdentity = v.string('edge-identity');
  const hierarchy = v.strings('hierarchy');
  const ignore = v.strings('ignore-attr');
  const diff: DiffOptions = {
    ...(Object.keys(match).length > 0 ? { match } : {}),
    ...(edgeIdentity !== undefined
      ? { edgeIdentity: choice('edge-identity', edgeIdentity, EDGE_IDENTITIES) }
      : {}),
    ...(hierarchy.length > 0 ? { hierarchyPredicates: hierarchy } : {}),
    ...(ignore.length > 0 ? { ignoreAttrs: ignore } : {}),
    ...(v.flag('no-merges') ? { detectMerges: false } : {}),
    ...(v.flag('no-splits') ? { detectSplits: false } : {}),
  };

  const theme = v.string('theme');
  const modeArg = v.string('mode');
  const mode = modeArg === undefined ? undefined : choice('mode', modeArg, MODES);
  const scopeArg = v.string('scope');
  const scope =
    scopeArg !== undefined
      ? choice('scope', scopeArg, SCOPES)
      : mode === 'changes'
        ? 'changes'
        : undefined;
  const panels = panelsOption(v.strings('panels'));
  const limit = v.string('limit');
  const languages = parseLanguages(v);
  const title = v.string('title');
  const json = v.target('json');
  const delta = v.target('delta');
  const markdown = v.target('markdown');
  const html = v.string('html');
  const watchAttrs = v.strings('watch-attr');
  if (watchAttrs.some((key) => key.trim() === '')) {
    throw usageError(
      '--watch-attr needs an attribute key.',
      'e.g. --watch-attr rdfs:comment. Attribute keys are listed in the JSON output (--json).',
    );
  }
  const options: DiffCommandOptions = {
    ...common,
    before,
    after,
    beforeFormat: parseFormat('before-format', v.string('before-format')) ?? format,
    afterFormat: parseFormat('after-format', v.string('after-format')) ?? format,
    ...(languages ? { languages } : {}),
    diff,
    stat: v.flag('stat'),
    nameStatus: v.flag('name-status'),
    ...(json !== undefined ? { json } : {}),
    ...(delta !== undefined ? { delta } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
    ...(html !== undefined ? { html } : {}),
    open: v.flag('open'),
    pretty: v.flag('pretty'),
    ...(title !== undefined ? { title } : {}),
    ...(theme !== undefined ? { theme: choice('theme', theme, THEMES) } : {}),
    ...(mode !== undefined ? { mode: mode === 'changes' ? 'overlay' : mode } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(panels !== undefined ? { panels } : {}),
    reproducible: v.flag('reproducible'),
    compute: !v.flag('no-compute'),
    allowEmpty: v.flag('allow-empty'),
    exitCode: v.flag('exit-code'),
    limit:
      limit === undefined
        ? DEFAULT_LIMIT
        : parseNumber('limit', limit, 0, Number.MAX_SAFE_INTEGER, true),
    ...(watchAttrs.length > 0 ? { watchAttrs } : {}),
  };
  checkOutputs(options);
  return { kind: 'diff', options };
}

/** At most one output may go to stdout (`--stat` and `--name-status` combine). */
function checkOutputs(o: DiffCommandOptions): void {
  const toStdout = [
    o.json === STDIO ? '--json' : undefined,
    o.delta === STDIO ? '--delta' : undefined,
    o.markdown === STDIO ? '--markdown' : undefined,
    o.stat || o.nameStatus ? (o.stat ? '--stat' : '--name-status') : undefined,
  ].filter((x): x is string => x !== undefined);
  if (toStdout.length > 1) {
    throw usageError(
      `${toStdout.slice(0, -1).join(', ')} and ${toStdout.at(-1)} would all write to stdout.`,
      `Send all but one to a file, e.g. ${toStdout[0]} out.${toStdout[0] === '--markdown' ? 'md' : 'json'}.`,
    );
  }
  if (o.html === STDIO) {
    throw usageError('The HTML report must be written to a file.', 'Use -o report.html.');
  }
}

function parseApply(argv: readonly string[]): Command {
  const raw = rawParse(argv, APPLY_OPTIONS, 2);
  const v = new Values(raw);
  const common = parseCommon(v);
  if (v.flag('help')) return { kind: 'help', topic: 'apply', color: common.color };
  if (v.flag('version')) return { kind: 'version' };
  const [graph, delta] = checkPositionals(raw.positionals, ['graph', 'delta']);
  const languages = parseLanguages(v);
  return {
    kind: 'apply',
    options: {
      ...common,
      graph,
      delta,
      output: v.string('output') ?? STDIO,
      strict: !v.flag('no-strict'),
      format: parseFormat('format', v.string('format')) ?? 'auto',
      ...(languages ? { languages } : {}),
      pretty: v.flag('pretty'),
      allowEmpty: v.flag('allow-empty'),
      verbose: v.flag('verbose'),
    },
  };
}

/**
 * Parse `argv` (without `node` and the script) into a command.
 *
 * @throws CliError `usage` with a message and a hint for any invalid command line.
 */
export function parseCommandLine(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === 'apply') return parseApply(rest);
  if (first === 'help') {
    // `kgdiff help [apply] [--color <when>]`
    const raw = rawParse(rest, { color: COMMON.color as OptionSpec }, 0);
    const topic = raw.positionals.join(' ');
    if (raw.positionals.length > 1 || (topic !== '' && topic !== 'apply')) {
      throw usageError(
        `Unknown help topic "${topic}".`,
        'Try `kgdiff help` or `kgdiff help apply`.',
      );
    }
    return {
      kind: 'help',
      topic: topic === 'apply' ? 'apply' : 'main',
      color: parseCommon(new Values(raw)).color,
    };
  }
  return parseDiff(argv);
}

/** Best-effort `--color` value for printing an error about the command line itself. */
export function peekColorMode(argv: readonly string[]): ColorMode {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i] as string;
    const value = arg.startsWith('--color=')
      ? arg.slice(8)
      : arg === '--color'
        ? argv[i + 1]
        : undefined;
    if (value === 'always' || value === 'never' || value === 'auto') return value;
  }
  return 'auto';
}
