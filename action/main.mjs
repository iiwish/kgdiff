// @ts-check
/**
 * The kgdiff GitHub Action (../action.yml), one sub-command per step:
 *
 *   node main.mjs diff      compare every file with its version in the base commit, write the
 *                           job summary, the HTML reports and the state the next steps read
 *   node main.mjs comment   create the pull request comment, or update it in place
 *   node main.mjs finish    link the report from the job summary; fail when a file could not
 *                           be compared or, with fail-on-changes, when a graph changed
 *
 * Inputs arrive as INPUT_* environment variables that action.yml sets from `${{ inputs.* }}`,
 * never expanded into a script; branch names are read from the event payload. kgdiff runs as
 * the native binary of its npm platform package for the runner (kgdiff.mjs), without the token
 * in its environment.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitHubError, upsertComment } from './github.mjs';
import { nativeKgdiff } from './kgdiff.mjs';
import {
  ActionError,
  commentMarker,
  composeComment,
  composeSummary,
  fileSection,
  isGlob,
  messages,
  parseBase,
  parseBoolean,
  parseFiles,
  parseLocale,
  parseName,
  parseVersion,
  pullRequestBase,
  pullRequestInfo,
  reportLine,
  shortSha,
  splitArgs,
  titleFor,
  unchangedNote,
  workflowCommand,
} from './lib.mjs';

/** @typedef {import('./lib.mjs').FileResult} FileResult */
/** @typedef {import('./lib.mjs').Locale} Locale */
/** @typedef {import('./lib.mjs').PullRequest} PullRequest */

/**
 * What the `diff` step leaves for `comment` and `finish`.
 *
 * @typedef {object} State
 * @property {Locale} locale
 * @property {string} repository
 * @property {string} apiUrl
 * @property {string} runUrl
 * @property {number | null} issue The pull request to comment on.
 * @property {string} marker
 * @property {string[]} sections
 * @property {string | undefined} note
 * @property {boolean} create Comment even when no comment exists yet: something changed.
 * @property {string} artifactName
 * @property {boolean} multiple Several reports, uploaded as a zip.
 * @property {string[]} changed
 * @property {string[]} errors
 * @property {boolean} failOnChanges
 */

/** @typedef {import('./kgdiff.mjs').Kgdiff} Kgdiff */

const ACTION_DIR = dirname(fileURLToPath(import.meta.url));

/** @param {string} line */
function log(line) {
  process.stdout.write(`${line}\n`);
}

/** @param {'error' | 'warning' | 'notice'} kind @param {string} message */
function annotate(kind, message) {
  log(workflowCommand(kind, message, { title: 'kgdiff' }));
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {string} value
 */
function setOutput(env, name, value) {
  if (/[\r\n]/.test(value)) throw new Error(`Output ${name} has a line break.`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// ─── Git ─────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {readonly string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: number }} [options] `stdout`: a file descriptor
 *   that receives the output instead of the return value.
 */
function tryGit(args, options = {}) {
  const result = spawnSync('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    stdio: ['ignore', options.stdout ?? 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    throw new ActionError(`Could not run git: ${result.error.message}.`, 'Put Git on the PATH.');
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ? result.stdout.toString('utf8') : '',
    stderr: result.stderr ? result.stderr.toString('utf8').trim() : '',
  };
}

/**
 * @param {readonly string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: number }} [options]
 */
function git(args, options) {
  const result = tryGit(args, options);
  if (!result.ok) throw new ActionError(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

/** The commit `ref` names in the checkout, if it is there. */
function localCommit(/** @type {string} */ ref) {
  const result = tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok ? result.stdout.trim() : undefined;
}

/** Fetch `ref` (a branch, tag or commit) from origin; its commit, or why that failed. */
function fetchCommit(/** @type {string} */ ref) {
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  const fetched = tryGit([
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-recurse-submodules',
    ...(shallow ? ['--depth=1'] : []),
    'origin',
    ref,
  ]);
  if (!fetched.ok) return { error: fetched.stderr };
  return { sha: localCommit('FETCH_HEAD') };
}

/** The commit `ref` names, from the checkout or else from origin. */
function commit(/** @type {string} */ ref) {
  const sha = localCommit(ref);
  if (sha) return sha;
  const fetched = fetchCommit(ref);
  if (fetched.sha) return fetched.sha;
  throw new ActionError(
    `Cannot find the base ${ref}: it is not in the checkout, and fetching it from origin failed${fetched.error ? ` (${fetched.error})` : ''}.`,
    'Check the base input. For a private repository, keep the credentials actions/checkout persists by default, or check out with fetch-depth: 0.',
  );
}

/** Parents of a commit, read from the commit object (they need not be in a shallow clone). */
function parents(/** @type {string} */ sha) {
  const text = git(['cat-file', '-p', sha]);
  /** @type {string[]} */
  const list = [];
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('parent ')) list.push(line.slice('parent '.length).trim());
  }
  return list;
}

/**
 * The base commit and its label.
 *
 * @param {string} input The base input.
 * @param {string} eventName
 * @param {any} event
 * @param {PullRequest | undefined} pr
 * @param {string} head The checked-out commit.
 * @returns {{ sha: string, label: string } | undefined} `undefined`: nothing to compare with (a
 *   push that created its branch).
 */
function resolveBase(input, eventName, event, pr, head) {
  if (input) {
    return { sha: commit(input), label: /^[0-9a-f]{40}$/i.test(input) ? shortSha(input) : input };
  }
  if (pr) {
    return { sha: commit(pullRequestBase(pr, parents(head))), label: pr.baseRef };
  }
  if (eventName === 'merge_group' && typeof event?.merge_group?.base_sha === 'string') {
    const ref = String(event.merge_group.base_ref ?? '').replace(/^refs\/heads\//, '');
    return { sha: commit(event.merge_group.base_sha), label: ref || 'base' };
  }
  if (eventName === 'push' && typeof event?.before === 'string') {
    if (/^0+$/.test(event.before)) return undefined;
    return { sha: commit(event.before), label: shortSha(event.before) };
  }
  throw new ActionError(
    `There is no base to compare with on a ${eventName || 'local'} event.`,
    'Set the base input to a branch, tag or commit, e.g. base: main.',
  );
}

// ─── Files ───────────────────────────────────────────────────────────────────────────────────

/**
 * A file to compare.
 *
 * @typedef {object} Entry
 * @property {string} path Relative to the working directory, `/`-separated.
 * @property {string} [baseMode] Its mode in the base commit; absent when it is not there.
 * @property {string} [problem] Why it cannot be compared.
 */

/** Git modes of regular files (`120000` is a symbolic link, `160000` a submodule). */
const FILE_MODES = new Set(['100644', '100755']);

/**
 * List the files to compare: paths as given, glob patterns matched (with Git's `:(glob)`
 * pathspecs, so `**` crosses directories) against the files in the checkout and in the base
 * commit, so that a deleted file is still compared.
 *
 * @param {readonly string[]} patterns
 * @param {string} baseSha
 * @param {string} work A private directory for the base commit's index.
 * @returns {{ entries: Entry[], unmatched: string[] }}
 */
function listFiles(patterns, baseSha, work) {
  const index = join(work, 'base.index');
  git(['read-tree', baseSha], { env: { GIT_INDEX_FILE: index } });
  /** @param {string} spec @returns {Map<string, string>} path → mode */
  const inBase = (spec) => {
    const out = git(['ls-files', '--stage', '-z', '--', spec], { env: { GIT_INDEX_FILE: index } });
    const files = new Map();
    for (const record of out.split('\0')) {
      const match = /^(\d+) [0-9a-f]+ \d+\t(.*)$/s.exec(record);
      if (match?.[1] && match[2] !== undefined) files.set(match[2], match[1]);
    }
    return files;
  };
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {string[]} */
  const unmatched = [];
  for (const pattern of patterns) {
    if (!isGlob(pattern)) {
      const found = inBase(`:(literal)${pattern}`);
      const mode = found.get(pattern);
      const directory = found.size > 0 && mode === undefined;
      entries.set(pattern, {
        path: pattern,
        ...(mode ? { baseMode: mode } : {}),
        ...(directory
          ? { problem: 'It is a directory: list its files, or use a glob such as dir/**/*.ttl.' }
          : {}),
      });
      continue;
    }
    const spec = `:(glob)${pattern}`;
    const base = inBase(spec);
    const head = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', spec])
      .split('\0')
      .filter(Boolean);
    const paths = [...new Set([...base.keys(), ...head])].sort();
    if (paths.length === 0) unmatched.push(pattern);
    for (const path of paths) {
      const mode = base.get(path);
      if (!entries.has(path)) entries.set(path, { path, ...(mode ? { baseMode: mode } : {}) });
    }
  }
  return { entries: [...entries.values()], unmatched };
}

/** True when two files have the same bytes. */
function sameContent(/** @type {string} */ a, /** @type {string} */ b) {
  if (statSync(a).size !== statSync(b).size) return false;
  const fa = openSync(a, 'r');
  const fb = openSync(b, 'r');
  try {
    const ba = Buffer.alloc(1 << 20);
    const bb = Buffer.alloc(1 << 20);
    for (;;) {
      const na = readSync(fa, ba, 0, ba.length, null);
      const nb = readSync(fb, bb, 0, bb.length, null);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (na === 0) return true;
    }
  } finally {
    closeSync(fa);
    closeSync(fb);
  }
}

/** Path of `path` inside a private directory: `..` segments cannot climb out of it. */
function inside(/** @type {string} */ path) {
  return path
    .split('/')
    .map((segment) => (segment === '..' ? '__' : segment))
    .join('/');
}

/**
 * Put both versions of `entry` under `work`: `before/<path>` from the base commit (empty when
 * the file is new) and `after/<path>` from the working tree (empty when it was deleted).
 *
 * @param {Entry} entry
 * @param {string} baseSha
 * @param {string} work
 * @returns {{ before: string, after: string, problem?: string, same?: boolean }} Paths relative
 *   to `work`.
 */
function stage(entry, baseSha, work) {
  const rel = inside(entry.path);
  const before = `before/${rel}`;
  const after = `after/${rel}`;
  if (entry.problem) return { before, after, problem: entry.problem };
  if (entry.baseMode && !FILE_MODES.has(entry.baseMode)) {
    return {
      before,
      after,
      problem: `In the base commit it is ${entry.baseMode === '120000' ? 'a symbolic link' : 'a submodule'}, not a file.`,
    };
  }
  /** @type {import('node:fs').Stats | undefined} */
  let stats;
  try {
    stats = lstatSync(entry.path);
  } catch {
    stats = undefined;
  }
  if (stats && !stats.isFile()) {
    return {
      before,
      after,
      problem: stats.isSymbolicLink()
        ? 'It is a symbolic link: kgdiff compares regular files only.'
        : stats.isDirectory()
          ? 'It is a directory: list its files, or use a glob such as dir/**/*.ttl.'
          : 'It is not a regular file.',
    };
  }
  if (!stats && !entry.baseMode) {
    return { before, after, problem: 'There is no such file, in the checkout or in the base.' };
  }
  for (const file of [before, after]) mkdirSync(dirname(join(work, file)), { recursive: true });
  const fd = openSync(join(work, before), 'w');
  try {
    if (entry.baseMode)
      git(['cat-file', '--filters', `${baseSha}:./${entry.path}`], { stdout: fd });
  } finally {
    closeSync(fd);
  }
  if (stats) {
    try {
      linkSync(entry.path, join(work, after));
    } catch {
      copyFileSync(entry.path, join(work, after));
    }
  } else {
    writeFileSync(join(work, after), '');
  }
  return {
    before,
    after,
    same: Boolean(stats && entry.baseMode) && sameContent(join(work, before), join(work, after)),
  };
}

// ─── kgdiff ──────────────────────────────────────────────────────────────────────────────────

/**
 * Compare one staged file. kgdiff runs with `--exit-code`: 0 the graphs are identical, 1 they
 * differ, anything else (or a missing summary) is an error. Its output is fenced with
 * `::stop-commands::` so that nothing in a graph can pass for a workflow command.
 *
 * @param {Kgdiff} kgdiff
 * @param {Entry} entry
 * @param {{ before: string, after: string }} staged
 * @param {object} options
 * @param {string} options.work
 * @param {string} options.title
 * @param {Locale} options.locale
 * @param {readonly string[]} options.args The args input.
 * @returns {Promise<FileResult & { report?: string }>}
 */
async function compare(kgdiff, entry, staged, { work, title, locale, args }) {
  const rel = inside(entry.path);
  const markdown = `markdown/${rel}.md`;
  const report = `reports/${rel}.html`;
  for (const file of [markdown, report]) mkdirSync(dirname(join(work, file)), { recursive: true });
  const token = randomUUID();
  log(`::stop-commands::${token}`);
  const { code, stderr } = await kgdiff.run(
    [
      `--title=${title}`,
      `--locale=${locale}`,
      '--color=always',
      ...args,
      `--markdown=${markdown}`,
      `--html=${report}`,
      '--reproducible',
      '--allow-empty',
      '--exit-code',
      '--',
      staged.before,
      staged.after,
    ],
    work,
  );
  log(`::${token}::`);
  /** @type {string | undefined} */
  let summary;
  try {
    summary = readFileSync(join(work, markdown), 'utf8');
  } catch {
    summary = undefined;
  }
  if ((code === 0 || code === 1) && summary !== undefined) {
    if (code === 0) rmSync(join(work, report), { force: true });
    return {
      path: entry.path,
      status: code === 1 ? 'changed' : 'identical',
      markdown: summary,
      ...(code === 1 ? { report: join(work, report) } : {}),
    };
  }
  return { path: entry.path, status: 'error', error: stderr || `kgdiff exited with code ${code}.` };
}

// ─── Steps ───────────────────────────────────────────────────────────────────────────────────

/** @param {string | undefined} path */
function readEvent(path) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** @param {NodeJS.ProcessEnv} env */
function runUrl(env) {
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? '1');
  return `${server}/${env.GITHUB_REPOSITORY ?? ''}/actions/runs/${env.GITHUB_RUN_ID ?? ''}${attempt > 1 ? `/attempts/${attempt}` : ''}`;
}

/**
 * The `diff` step.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ kgdiff?: (spec: string, cwd: string) => Kgdiff }} [deps]
 * @returns {Promise<number>} The exit code.
 */
export async function diffStep(env, deps = {}) {
  const files = parseFiles(env.INPUT_FILES);
  const baseInput = parseBase(env.INPUT_BASE);
  const args = splitArgs(env.INPUT_ARGS);
  const comment = parseBoolean('comment', env.INPUT_COMMENT, true);
  const failOnChanges = parseBoolean('fail-on-changes', env.INPUT_FAIL_ON_CHANGES, false);
  const name = parseName(env.INPUT_NAME || 'kgdiff-report');
  const locale = parseLocale(env.INPUT_LOCALE);
  const m = messages(locale);
  const spec =
    parseVersion(env.INPUT_VERSION) ||
    JSON.parse(readFileSync(join(ACTION_DIR, '..', 'packages', 'cli', 'package.json'), 'utf8'))
      .version;

  const eventName = env.GITHUB_EVENT_NAME ?? '';
  const event = readEvent(env.GITHUB_EVENT_PATH);
  const repository = env.GITHUB_REPOSITORY ?? '';
  const pr = pullRequestInfo(eventName, event, repository);

  if (!tryGit(['rev-parse', '--is-inside-work-tree']).ok) {
    throw new ActionError(
      `${process.cwd()} is not a Git checkout.`,
      'Run actions/checkout first, and set working-directory if the repository is checked out into a subdirectory.',
    );
  }
  const head = git(['rev-parse', 'HEAD']).trim();
  const work = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'kgdiff-'));
  const statePath = join(work, 'state.json');
  const summaryPath = join(work, 'summary.md');
  const base = resolveBase(baseInput, eventName, event, pr, head);

  /** @type {FileResult[]} */
  const results = [];
  /** @type {string[]} */
  const reports = [];
  let baseLabel = '';
  if (!base) {
    annotate('notice', m.branchCreated);
  } else {
    baseLabel = base.label;
    const headLabel = base.sha === head ? m.workingTree : pr ? pr.headLabel : shortSha(head);
    const { entries, unmatched } = listFiles(files, base.sha, work);
    for (const pattern of unmatched) annotate('warning', `No file matches ${pattern}.`);
    if (entries.length === 0) {
      throw new ActionError('No file to compare.', 'Check the files input.');
    }
    const kgdiff = (deps.kgdiff ?? nativeKgdiff)(spec, work);
    let installed = false;
    const short = shortSha(base.sha);
    log(
      `Comparing ${entries.length} ${entries.length === 1 ? 'file' : 'files'} with ${base.label}${base.label === short ? '' : ` (${short})`}`,
    );
    for (const entry of entries) {
      log(workflowCommand('group', entry.path));
      const staged = stage(entry, base.sha, work);
      /** @type {FileResult & { report?: string }} */
      let result;
      if (staged.problem) {
        result = { path: entry.path, status: 'error', error: staged.problem };
        log(staged.problem);
      } else if (staged.same) {
        result = { path: entry.path, status: 'unchanged' };
        log('Unchanged: the same bytes as in the base.');
      } else {
        // Fetch kgdiff only when a file needs it.
        if (!installed) log(`kgdiff ${await kgdiff.version()}`);
        installed = true;
        const title = titleFor(entry.path, base.label, headLabel);
        result = await compare(kgdiff, entry, staged, { work, title, locale, args });
      }
      log('::endgroup::');
      if (result.report) reports.push(result.report);
      results.push({
        path: result.path,
        status: result.status,
        ...(result.markdown !== undefined ? { markdown: result.markdown } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    }
  }

  const sections = results
    .filter((r) => r.status !== 'unchanged')
    .map((r) => fileSection(r, locale));
  const note = base ? unchangedNote(results, locale, baseLabel) : `## kgdiff\n\n${m.branchCreated}`;
  const summary = composeSummary(sections, note, locale);
  writeFileSync(summaryPath, summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);

  // One report is uploaded as is, as <name>.html; several as a zip named <name>.
  let reportPath = '';
  if (reports.length === 1) {
    reportPath = join(work, 'artifact', `${name}.html`);
    mkdirSync(dirname(reportPath), { recursive: true });
    renameSync(/** @type {string} */ (reports[0]), reportPath);
  } else if (reports.length > 1) {
    reportPath = join(work, 'reports');
  }

  const changed = results.filter((r) => r.status === 'changed').map((r) => r.path);
  const errors = results.filter((r) => r.status === 'error').map((r) => r.path);
  if (comment && pr?.readOnly) {
    annotate(
      'notice',
      'A pull request from a fork gets a read-only token: the summary is in the job summary, not in a comment.',
    );
  }
  /** @type {State} */
  const state = {
    locale,
    repository,
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    runUrl: runUrl(env),
    issue: pr ? pr.number : null,
    marker: commentMarker(env.GITHUB_WORKFLOW ?? '', name),
    sections,
    note,
    create: changed.length > 0 || errors.length > 0,
    artifactName: reports.length > 1 ? name : `${name}.html`,
    multiple: reports.length > 1,
    changed,
    errors,
    failOnChanges,
  };
  writeFileSync(statePath, JSON.stringify(state));
  setOutput(env, 'state', statePath);
  setOutput(env, 'summary-file', summaryPath);
  setOutput(env, 'changed', String(changed.length > 0));
  setOutput(env, 'report-path', reportPath);
  setOutput(env, 'archive', String(reports.length > 1));
  setOutput(env, 'comment', String(comment && pr !== undefined && !pr.readOnly));
  return 0;
}

/** @param {string | undefined} path @returns {State} */
function readState(path) {
  if (!path) throw new ActionError('The diff step left no state.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The `comment` step. Commenting is best effort: a failure is a warning (the job summary has
 * the same text), never a failed job.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ fetch?: typeof fetch, retryDelay?: number }} [deps]
 * @returns {Promise<number>}
 */
export async function commentStep(env, deps = {}) {
  const state = readState(env.KGDIFF_STATE);
  if (state.issue === null) return 0;
  const token = env.INPUT_TOKEN ?? '';
  if (!token) {
    annotate('warning', 'No token to comment with: set the token input, or comment: false.');
    return 0;
  }
  const footer = reportLine({
    locale: state.locale,
    artifactName: state.artifactName,
    artifactUrl: env.ARTIFACT_URL,
    multiple: state.multiple,
    runUrl: state.runUrl,
  });
  const body = composeComment({
    marker: state.marker,
    sections: state.sections,
    note: state.note,
    footer,
    runUrl: state.runUrl,
    locale: state.locale,
  });
  try {
    const result = await upsertComment({
      apiUrl: state.apiUrl,
      token,
      repository: state.repository,
      issue: state.issue,
      marker: state.marker,
      body,
      create: state.create,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.retryDelay !== undefined ? { retryDelay: deps.retryDelay } : {}),
    });
    if (result.action === 'skipped') {
      log('No graph changed and there is no comment to update: not commenting.');
    } else if (result.url) {
      log(`${result.action === 'created' ? 'Created' : 'Updated'} the comment ${result.url}`);
      setOutput(env, 'comment-url', result.url);
    }
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    const hint =
      error.status === 403 || error.status === 404
        ? ' Give the job `permissions: pull-requests: write`, or set comment: false. A pull request from a fork, or from Dependabot, gets a read-only token.'
        : '';
    annotate(
      'warning',
      `Could not comment on pull request #${state.issue}: ${error.message}.${hint} The summary is in the job summary.`,
    );
  }
  return 0;
}

/**
 * The `finish` step.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function finishStep(env) {
  const state = readState(env.KGDIFF_STATE);
  const line = reportLine({
    locale: state.locale,
    artifactName: state.artifactName,
    artifactUrl: env.ARTIFACT_URL,
    multiple: state.multiple,
  });
  if (line && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${line}\n`);
  const list = (/** @type {readonly string[]} */ paths) => paths.join(', ');
  if (state.errors.length > 0) {
    annotate('error', `kgdiff could not compare ${list(state.errors)}: see the job summary.`);
    return 1;
  }
  if (state.failOnChanges && state.changed.length > 0) {
    annotate(
      'error',
      `${state.changed.length === 1 ? 'A graph changed' : `${state.changed.length} graphs changed`} (fail-on-changes): ${list(state.changed)}.`,
    );
    return 1;
  }
  return 0;
}

/** @param {string | undefined} command */
async function main(command) {
  const env = process.env;
  try {
    if (command === 'diff') return await diffStep(env);
    if (command === 'comment') return await commentStep(env);
    if (command === 'finish') return finishStep(env);
    throw new ActionError(`Unknown step "${command}".`);
  } catch (error) {
    if (!(error instanceof ActionError)) throw error;
    annotate('error', error.hint ? `${error.message} ${error.hint}` : error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv[2]);
}
