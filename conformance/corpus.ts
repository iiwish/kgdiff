/**
 * Generates the conformance corpus from the TypeScript implementation: for every case in
 * `cases.ts`, `case.json` and the files under `expected/`; the primitive vectors; the manifest.
 * Everything is computed in memory (`generateCorpus`), so the test can compare it with the files
 * on disk byte for byte, and `update.ts` can write it. Nothing here writes anywhere else.
 *
 * Library outputs come from the package APIs; CLI outputs from `main()` of `@kgdiff/cli`, run
 * in-process with `corpusIO` (no TTY, fixed environment), and so does `report.json`, which is
 * read back from the HTML report a `-o report.html --reproducible` run writes. Where both exist
 * (`--json`, `--delta`, the report's packed diff) the generator checks that they agree, so the
 * README's definitions hold. `replay.ts` replays the recorded runs with the real process.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { cliVersion, main } from '@kgdiff/cli';
import {
  type DiffOptions,
  type DiffResult,
  diff,
  diffToJSON,
  formatHunk,
  graphToJSON,
  hashGraph,
  invertDelta,
  type Locale,
  normalize,
  packDiffJSON,
  resolveOptions,
} from '@kgdiff/core';
import type { ParseResult } from '@kgdiff/formats';
import { layoutDiff, layoutToJSON } from '@kgdiff/layout';
import { parseInput, readInput } from '../packages/cli/src/inputs.js';
import { CASES, type CaseDefinition } from './cases.js';
import { corpusIO } from './io.js';
import { generatePrimitives } from './primitives.js';

/** The `conformance/` directory. */
export const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const REPO = resolve(ROOT, '..');

/** Corpus files by path relative to `conformance/` (always `/`-separated). */
export type Corpus = Map<string, Uint8Array>;

/** Format marker and version of the corpus layout described in README.md. */
export const CORPUS_FORMAT = { format: 'kgdiff.conformance', version: 1 } as const;

/** Environment of every CLI run unless a run overrides it. */
const BASE_ENV: Readonly<Record<string, string>> = { COLUMNS: '100' };

/** How the CLI's version appears in recorded output (Markdown footers name it). */
export const VERSION_PLACEHOLDER = 'kgdiff <version>';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
/** What kgdiff writes: compact JSON and a newline. */
const compact = (value: unknown): string => `${JSON.stringify(value)}\n`;
/** The text a process writes as UTF-8: lone surrogates replaced by U+FFFD. */
const wellFormed = (text: string): string => decoder.decode(encoder.encode(text));
/** Value files of the corpus: two-space indentation and a newline. */
export const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function caseDir(id: string): string {
  return join(ROOT, 'cases', id);
}

/** CLI flags equivalent to the case's diff options; anything the CLI cannot express is refused. */
function optionFlags(o: DiffOptions): string[] {
  const known = new Set([
    'match',
    'hierarchyPredicates',
    'edgeIdentity',
    'ignoreAttrs',
    'detectMerges',
    'detectSplits',
  ]);
  for (const key of Object.keys(o)) {
    if (!known.has(key)) throw new Error(`The CLI cannot express the diff option "${key}".`);
  }
  for (const key of Object.keys(o.match ?? {})) {
    if (key !== 'strategy' && key !== 'threshold') {
      throw new Error(`The CLI cannot express the match option "${key}".`);
    }
  }
  const flags: string[] = [];
  if (o.match?.strategy) flags.push('--match', o.match.strategy);
  if (o.match?.threshold !== undefined) flags.push('--threshold', String(o.match.threshold));
  for (const p of o.hierarchyPredicates ?? []) flags.push('--hierarchy', p);
  if (o.edgeIdentity) flags.push('--edge-identity', o.edgeIdentity);
  for (const k of o.ignoreAttrs ?? []) flags.push('--ignore-attr', k);
  if (o.detectMerges === false) flags.push('--no-merges');
  if (o.detectSplits === false) flags.push('--no-splits');
  return flags;
}

function inputFlags(def: CaseDefinition): string[] {
  const flags: string[] = [];
  const b = def.formats?.before;
  const a = def.formats?.after;
  if (b !== undefined && b === a) flags.push('--format', b);
  else {
    if (b) flags.push('--before-format', b);
    if (a) flags.push('--after-format', a);
  }
  if (def.languages) flags.push('--lang', def.languages.join(','));
  if (def.allowEmpty) flags.push('--allow-empty');
  return flags;
}

/** Arguments of the apply run: the before graph, parsed as it was for the diff. */
function applyFlags(def: CaseDefinition): string[] {
  const flags: string[] = [];
  if (def.formats?.before) flags.push('--format', def.formats.before);
  if (def.languages) flags.push('--lang', def.languages.join(','));
  if (def.allowEmpty) flags.push('--allow-empty');
  return flags;
}

interface RunSpec {
  readonly name: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Path relative to the case directory, or undefined when stdout must be empty. */
  readonly file: string | undefined;
  /** A file of the case directory piped to stdin. */
  readonly stdin?: string;
  /** Expected exit code; undefined for the standard runs (0, or 1 for `exit-code`). */
  readonly exit?: number;
}

interface RunRecord {
  readonly name: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: { readonly file: string };
  readonly stdout: { readonly file: string } | { readonly text: string };
  readonly versionPlaceholder?: true;
  readonly stderr: { readonly text: string };
  readonly exit: number;
}

/** Arguments of the case's diff runs: inputs, how they are read, diff options, text and locale. */
function diffArgs(def: CaseDefinition): string[] {
  return [
    def.inputs.before,
    def.inputs.after,
    ...inputFlags(def),
    ...optionFlags(def.options),
    ...(def.textFlags ?? []),
    '--locale',
    def.locale,
    '--color',
    'never',
  ];
}

function runSpecs(def: CaseDefinition): RunSpec[] {
  const base = diffArgs(def);
  const run = (name: string, flags: readonly string[], file: string | undefined): RunSpec => ({
    name,
    args: [...base, ...flags],
    env: BASE_ENV,
    file,
  });
  return [
    run('summary', [], 'expected/cli/summary.txt'),
    run('stat', ['--stat'], 'expected/cli/stat.txt'),
    run('name-status', ['--name-status'], 'expected/cli/name-status.tsv'),
    run('markdown', ['--markdown'], 'expected/cli/summary.md'),
    run('json', ['--json'], 'expected/diff.json'),
    run('delta', ['--delta'], 'expected/delta.json'),
    run('exit-code', ['--exit-code', '--quiet'], undefined),
    ...(def.extraRuns ?? []).map((extra) => ({
      name: extra.name,
      args: [...base, ...extra.flags],
      env: { ...BASE_ENV, ...extra.env },
      file: `expected/cli/${extra.file}`,
    })),
    {
      name: 'apply',
      args: [
        'apply',
        def.inputs.before,
        'expected/delta.json',
        ...applyFlags(def),
        '--color',
        'never',
      ],
      env: BASE_ENV,
      file: 'expected/apply.json',
    },
    ...(def.customRuns ?? []).map((custom) => ({
      name: custom.name,
      args: custom.args,
      env: { ...BASE_ENV, ...custom.env },
      file: custom.file === undefined ? undefined : `expected/cli/${custom.file}`,
      ...(custom.stdin !== undefined ? { stdin: custom.stdin } : {}),
      exit: custom.exit,
    })),
  ];
}

/** Reads a case input: the authored file, or the dataset file it is a copy of. */
function inputBytes(def: CaseDefinition, side: 'before' | 'after'): Uint8Array {
  const source = def.copiedFrom
    ? join(REPO, def.copiedFrom[side])
    : join(caseDir(def.id), def.inputs[side]);
  return readFileSync(source);
}

/** Parses one side exactly as `kgdiff` does (decoding, `--allow-empty`, format, languages). */
async function parseSide(
  def: CaseDefinition,
  side: 'before' | 'after',
  overlay: ReadonlyMap<string, Uint8Array>,
): Promise<ParseResult> {
  const { io } = corpusIO({ cwd: caseDir(def.id), env: BASE_ENV, overlay });
  const raw = await readInput(io, def.inputs[side], `<${side}>`, {
    allowEmpty: def.allowEmpty ?? false,
  });
  return parseInput(raw, {
    format: def.formats?.[side] ?? 'auto',
    formatFlag: '--format',
    ...(def.languages ? { languages: def.languages } : {}),
  });
}

function parseOptionsRecord(def: CaseDefinition, side: 'before' | 'after') {
  return {
    format: def.formats?.[side] ?? 'auto',
    filename: basename(def.inputs[side]).replace(/\.gz$/i, ''),
    ...(def.languages ? { languages: def.languages } : {}),
    allowEmpty: def.allowEmpty ?? false,
  };
}

function titles(result: DiffResult): Record<Locale, unknown[]> {
  const out = {} as Record<Locale, unknown[]>;
  for (const locale of ['en', 'zh-CN'] as const) {
    out[locale] = result.hunks.map((hunk) => ({
      id: hunk.id,
      ...formatHunk(hunk, result, locale),
    }));
  }
  return out;
}

/**
 * The part of the layout that does not depend on floating-point simulation. Iteration counts
 * only for union layouts: an anchored layout simulates a window found by a range query on
 * positions, so its tick count depends on geometry.
 */
function layoutContract(def: CaseDefinition, result: DiffResult) {
  const layout = layoutDiff(result, def.layout);
  const json = layoutToJSON(layout);
  return {
    options: def.layout ?? {},
    strategy: json.strategy,
    scope: json.scope,
    ...(json.strategy === 'union' ? { iterations: json.iterations } : {}),
    nodes: [...layout.positions.keys()].sort(),
    radii: json.radii,
    hidden: json.hidden,
    components: json.components.map((c) => c.nodes),
  };
}

/** The parts of the report payload the corpus reads (the viewer's `ReportPayload`). */
interface EmbeddedPayload {
  readonly format: string;
  readonly version: number;
  readonly diff: unknown;
  readonly meta: { readonly generator: string } & Readonly<Record<string, unknown>>;
  readonly view: unknown;
}

/** The payload script of an HTML report: plain JSON, or gzip + base64 (`data-encoding`). */
function embeddedPayload(html: string): EmbeddedPayload | undefined {
  const match = /<script type="application\/kgdiff\+json"([^>]*)>([^<]*)<\/script>/.exec(html);
  if (!match) return undefined;
  const [, attrs = '', body = ''] = match;
  const json = attrs.includes('data-encoding="gzip-base64"')
    ? decoder.decode(gunzipSync(Buffer.from(body, 'base64')))
    : body;
  return JSON.parse(json) as EmbeddedPayload;
}

/** Stand-ins for the viewer bundles: the payload does not depend on them. */
const VIEWER_STUBS = { main: '/* viewer */', compute: '/* compute add-on */' } as const;

/**
 * What `kgdiff <diff arguments> -o report.html --reproducible` embeds in its report besides the
 * packed diff (checked to be `diff.packed.json`) and the layout (not normative): format, version,
 * meta (with the generator's version replaced) and view. The run is in-process, with the
 * report written to memory and stand-ins for the viewer bundles.
 */
async function reportRecord(
  def: CaseDefinition,
  overlay: ReadonlyMap<string, Uint8Array>,
  packedText: string,
  version: string,
) {
  const dir = caseDir(def.id);
  const writes = new Map<string, Uint8Array>();
  const { io, out } = corpusIO({
    cwd: dir,
    env: BASE_ENV,
    overlay,
    writes,
    viewerBundles: VIEWER_STUBS,
  });
  const code = await main([...diffArgs(def), '-o', 'report.html', '--reproducible'], io);
  if (code !== 0) fail(def, `the report run exited with ${code}:\n${out.stderr}`);
  const html = writes.get(resolve(dir, 'report.html'));
  if (writes.size !== 1 || html === undefined) {
    fail(def, `the report run wrote ${[...writes.keys()].join(', ') || 'nothing'}`);
  }
  const payload = embeddedPayload(decoder.decode(html));
  if (!payload) fail(def, 'the report has no payload script');
  if (compact(payload.diff) !== packedText) {
    fail(def, "the report's diff differs from JSON.stringify(packDiffJSON(diffToJSON(diff(…))))");
  }
  if (payload.meta.generator !== version) {
    fail(def, `the report names its generator "${payload.meta.generator}", not "${version}"`);
  }
  return {
    format: payload.format,
    version: payload.version,
    meta: { ...payload.meta, generator: VERSION_PLACEHOLDER },
    view: payload.view,
  };
}

function fail(def: CaseDefinition, message: string): never {
  throw new Error(`conformance case ${def.id}: ${message}`);
}

/** Generates the files of one case, keyed by path relative to `conformance/`. */
export async function generateCase(def: CaseDefinition): Promise<Corpus> {
  const dir = caseDir(def.id);
  const prefix = `cases/${def.id}/`;
  const files: Corpus = new Map();
  /** Generated files by absolute path, visible to later CLI runs (apply reads the delta). */
  const overlay = new Map<string, Uint8Array>();
  const put = (path: string, data: Uint8Array): void => {
    files.set(prefix + path, data);
    overlay.set(resolve(dir, path), data);
  };

  if (def.copiedFrom) {
    put(def.inputs.before, inputBytes(def, 'before'));
    put(def.inputs.after, inputBytes(def, 'after'));
  }

  // Library outputs.
  const parsed = {
    before: await parseSide(def, 'before', overlay),
    after: await parseSide(def, 'after', overlay),
  };
  const result = diff(parsed.before.graph, parsed.after.graph, def.options);
  const diffText = compact(diffToJSON(result));
  const packedText = compact(packDiffJSON(diffToJSON(result)));
  const deltaText = compact(result.delta);
  const version = `kgdiff ${cliVersion()}`;
  const hashes = { before: hashGraph(result.before), after: hashGraph(result.after) };
  if (result.delta.base.hash !== hashes.before || result.delta.target.hash !== hashes.after) {
    fail(def, 'the delta does not name the hashes of the two graphs');
  }
  put('expected/parse.before.json', bytes(pretty(parsed.before)));
  put('expected/parse.after.json', bytes(pretty(parsed.after)));
  put('expected/graph.before.json', bytes(compact(graphToJSON(result.before))));
  put('expected/graph.after.json', bytes(compact(graphToJSON(result.after))));
  put(
    'expected/issues.json',
    bytes(pretty({ before: result.before.issues, after: result.after.issues })),
  );
  put('expected/hashes.json', bytes(pretty(hashes)));
  put('expected/diff.packed.json', bytes(packedText));
  put('expected/delta.inverse.json', bytes(compact(invertDelta(result.delta))));
  put('expected/titles.json', bytes(pretty(titles(result))));
  put('expected/layout-contract.json', bytes(pretty(layoutContract(def, result))));
  put('expected/report.json', bytes(pretty(await reportRecord(def, overlay, packedText, version))));

  // CLI outputs.
  const records: RunRecord[] = [];
  for (const spec of runSpecs(def)) {
    const stdin = spec.stdin === undefined ? undefined : readFileSync(join(dir, spec.stdin));
    const { io, out } = corpusIO({ cwd: dir, env: spec.env, overlay, ...(stdin ? { stdin } : {}) });
    const code = await main(spec.args, io);
    const expectedCode =
      spec.exit ?? (spec.name === 'exit-code' && !result.stats.identical ? 1 : 0);
    if (code !== expectedCode) {
      fail(def, `run "${spec.name}" exited with ${code}, expected ${expectedCode}:\n${out.stderr}`);
    }
    const markdown = spec.file?.endsWith('.md') ?? false;
    // What a process writes is UTF-8: a lone surrogate in a JavaScript string becomes U+FFFD.
    const written = wellFormed(out.stdout);
    const stdout = markdown ? written.replaceAll(version, VERSION_PLACEHOLDER) : written;
    if (spec.file === undefined) {
      if (stdout !== '') fail(def, `run "${spec.name}" printed to stdout`);
    } else {
      if (spec.file === 'expected/diff.json' && stdout !== diffText) {
        fail(def, 'kgdiff --json differs from JSON.stringify(diffToJSON(diff(…)))');
      }
      if (spec.file === 'expected/delta.json' && stdout !== deltaText) {
        fail(def, 'kgdiff --delta differs from JSON.stringify(diff(…).delta)');
      }
      put(spec.file, bytes(stdout));
    }
    records.push({
      name: spec.name,
      args: spec.args,
      env: spec.env,
      ...(spec.stdin !== undefined ? { stdin: { file: spec.stdin } } : {}),
      stdout: spec.file === undefined ? { text: stdout } : { file: spec.file },
      ...(markdown ? { versionPlaceholder: true as const } : {}),
      stderr: { text: wellFormed(out.stderr) },
      exit: code,
    });
  }

  // `kgdiff apply` must reproduce the after graph — except under `ignoreAttrs`: the delta leaves
  // changes of ignored attributes out while `hashGraph` covers them, so apply warns that the
  // result differs from the delta's target (recorded in the apply run's stderr).
  const applied = JSON.parse(decoder.decode(files.get(`${prefix}expected/apply.json`)));
  const appliedHash = hashGraph(normalize(applied, { edgeIdentity: result.options.edgeIdentity }));
  if ((def.options.ignoreAttrs ?? []).length === 0 && appliedHash !== hashes.after) {
    fail(def, 'kgdiff apply does not reproduce the after graph');
  }

  const record = {
    id: def.id,
    description: def.description,
    covers: def.covers,
    inputs: def.inputs,
    ...(def.extraInputs ? { extraInputs: def.extraInputs } : {}),
    ...(def.copiedFrom ? { copiedFrom: def.copiedFrom } : {}),
    parse: { before: parseOptionsRecord(def, 'before'), after: parseOptionsRecord(def, 'after') },
    options: def.options,
    resolvedOptions: resolveOptions(def.options),
    locale: def.locale,
    layoutOptions: def.layout ?? {},
    identical: result.stats.identical,
    cli: records,
  };
  put('case.json', bytes(pretty(record)));
  return files;
}

/** Every file of the corpus. */
export async function generateCorpus(): Promise<Corpus> {
  const corpus: Corpus = new Map();
  for (const def of CASES)
    for (const [path, data] of await generateCase(def)) corpus.set(path, data);
  for (const [path, data] of generateShared()) corpus.set(path, data);
  return corpus;
}

/** The primitive vectors and the manifest. */
export function generateShared(): Corpus {
  const corpus: Corpus = new Map();
  const primitives = generatePrimitives();
  for (const [name, text] of primitives) corpus.set(`primitives/${name}`, bytes(text));
  const manifest = {
    ...CORPUS_FORMAT,
    description:
      'Language-neutral conformance corpus of kgdiff: inputs, options and the expected outputs of the reference (TypeScript) implementation. See README.md.',
    versionPlaceholder: VERSION_PLACEHOLDER,
    cases: CASES.map((c) => ({ id: c.id, covers: c.covers })),
    primitives: [...primitives.keys()].map((name) => `primitives/${name}`),
  };
  corpus.set('manifest.json', bytes(pretty(manifest)));
  return corpus;
}

/** Authored inputs (present on disk, never generated), of one case or of all. */
export function authoredInputs(def?: CaseDefinition): string[] {
  return (def ? [def] : CASES)
    .filter((c) => !c.copiedFrom)
    .flatMap((c) =>
      [c.inputs.before, c.inputs.after, ...(c.extraInputs ?? [])].map((f) => `cases/${c.id}/${f}`),
    );
}

/** Files operating systems drop into directories (Finder, Explorer): never part of the corpus. */
export const OS_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Every file below `conformance/<top>` on disk, relative to `conformance/`, `/`-separated. */
export function filesOnDisk(top = ''): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(ROOT, relative)).sort()) {
      if (OS_FILES.has(name)) continue;
      const path = `${relative}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  for (const dir of top === '' ? ['cases', 'primitives'] : [top]) {
    // A directory that is not there yet (nothing generated) holds no files.
    if (existsSync(join(ROOT, dir))) walk(dir);
  }
  return out;
}
