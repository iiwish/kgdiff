/**
 * Replays every CLI run the corpus records with the real `kgdiff` process, as another
 * implementation would run them (README, "CLI runs"): `node packages/cli/dist/bin.js` with the
 * run's arguments, the case directory as working directory, the run's environment and only what
 * starting a process needs besides it, stdin piped from the recorded file or empty, stdout and
 * stderr through pipes. The corpus itself is generated with `main()` in-process; this checks that
 * a real process prints the same bytes and exits with the same code.
 *
 *   pnpm build && pnpm conformance:replay
 *
 * `--bin <path>` replays the runs with another implementation's executable instead, started
 * directly with the run's arguments (RFC 0002: the Rust `kgdiff`):
 *
 *   cargo build --release -p kgdiff && pnpm conformance:replay --bin target/release/kgdiff
 *
 * It reads only the corpus files and the CLI it runs, not the TypeScript sources.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(ROOT, '..');
const BIN = join(REPO, 'packages/cli/dist/bin.js');

/** `--bin <path>`: the executable to replay with; the built TypeScript CLI without it. */
function binArgument(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--bin');
  if (at === -1) return undefined;
  const path = argv[at + 1];
  if (path === undefined || path.startsWith('-'))
    throw new Error('--bin needs the path of an executable');
  return resolve(path);
}
const OTHER_BIN = binArgument(process.argv.slice(2));
/** The command and the arguments before a run's own. */
const COMMAND: readonly [string, readonly string[]] = OTHER_BIN
  ? [OTHER_BIN, []]
  : [process.execPath, [BIN]];
/** A run that takes longer than this is reported as hanging. */
const TIMEOUT_MS = 60_000;

interface Run {
  readonly name: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: { readonly file: string };
  readonly stdout: { readonly file: string } | { readonly text: string };
  readonly versionPlaceholder?: true;
  readonly stderr: { readonly text: string };
  readonly exit: number;
}

interface Outcome {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut: boolean;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** What a process needs to start, beside the recorded environment. */
function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) {
    env.SystemRoot = process.env.SystemRoot;
  }
  return env;
}

function execute(run: Run, cwd: string, input: Buffer): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(COMMAND[0], [...COMMAND[1], ...run.args], {
      cwd,
      env: { ...processEnv(), ...run.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A run that does not read stdin may exit before it is written: not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut });
    });
  });
}

/** Where two byte strings first differ, by line. */
function firstDifference(actual: Buffer, expected: Buffer): string {
  const a = actual.toString('utf8').split('\n');
  const b = expected.toString('utf8').split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      const show = (s: string | undefined) =>
        s === undefined ? '<end>' : JSON.stringify(s.slice(0, 200));
      return `line ${i + 1}: got ${show(a[i])}, expected ${show(b[i])}`;
    }
  }
  return `${actual.byteLength} bytes, expected ${expected.byteLength}`;
}

async function main(): Promise<number> {
  if (!existsSync(OTHER_BIN ?? BIN)) {
    console.error(
      OTHER_BIN
        ? `conformance: ${OTHER_BIN} is missing.`
        : `conformance: ${BIN} is missing; run \`pnpm build\` first.`,
    );
    return 1;
  }
  const manifest = readJson(join(ROOT, 'manifest.json')) as {
    format: string;
    version: number;
    versionPlaceholder: string;
    cases: readonly { id: string }[];
  };
  if (manifest.format !== 'kgdiff.conformance' || manifest.version !== 1) {
    console.error('conformance: manifest.json is not a version 1 kgdiff.conformance manifest.');
    return 1;
  }
  const { version } = readJson(join(REPO, 'packages/cli/package.json')) as { version: string };

  const jobs: { id: string; dir: string; run: Run }[] = [];
  for (const { id } of manifest.cases) {
    const dir = join(ROOT, 'cases', id);
    const { cli } = readJson(join(dir, 'case.json')) as { cli: readonly Run[] };
    for (const run of cli) jobs.push({ id, dir, run });
  }

  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let job = jobs[next++]; job !== undefined; job = jobs[next++]) {
      const { id, dir, run } = job;
      const input = run.stdin ? readFileSync(join(dir, run.stdin.file)) : Buffer.alloc(0);
      const outcome = await execute(run, dir, input);
      let stdout =
        'file' in run.stdout
          ? readFileSync(join(dir, run.stdout.file))
          : Buffer.from(run.stdout.text, 'utf8');
      if (run.versionPlaceholder) {
        stdout = Buffer.from(
          stdout.toString('utf8').replaceAll(manifest.versionPlaceholder, `kgdiff ${version}`),
          'utf8',
        );
      }
      const stderr = Buffer.from(run.stderr.text, 'utf8');
      const problems: string[] = [];
      if (outcome.timedOut) problems.push(`did not finish within ${TIMEOUT_MS / 1000} s`);
      if (outcome.code !== run.exit)
        problems.push(`exit code ${outcome.code}, expected ${run.exit}`);
      if (!outcome.stdout.equals(stdout)) {
        problems.push(`stdout differs (${firstDifference(outcome.stdout, stdout)})`);
      }
      if (!outcome.stderr.equals(stderr)) {
        problems.push(`stderr differs (${firstDifference(outcome.stderr, stderr)})`);
      }
      if (problems.length > 0) failures.push(`${id} / ${run.name}: ${problems.join('; ')}`);
    }
  };
  const workers = Math.max(1, Math.min(8, availableParallelism()));
  await Promise.all(Array.from({ length: workers }, worker));

  if (failures.length > 0) {
    console.error(
      `conformance: ${failures.length} of ${jobs.length} recorded runs differ with the real kgdiff process (${OTHER_BIN ?? BIN}):`,
    );
    for (const failure of failures.sort()) console.error(`  ${failure}`);
    return 1;
  }
  console.log(
    `conformance: ${jobs.length} recorded runs of ${manifest.cases.length} cases replayed with the real kgdiff process (${OTHER_BIN ?? BIN}); all match.`,
  );
  return 0;
}

process.exitCode = await main();
