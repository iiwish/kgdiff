/**
 * Replays every CLI run the corpus records with a real `kgdiff` process, as another
 * implementation would run them (README, "CLI runs"): the executable with the run's arguments,
 * the case directory as working directory, the run's environment and only what starting a
 * process needs besides it, stdin piped from the recorded file or empty, stdout and stderr
 * through pipes. The corpus records the runs with the Rust `kgdiff` (corpus.ts); this checks
 * that an implementation, on this machine, prints the same bytes and exits with the same code.
 *
 *   cargo build --release -p kgdiff && pnpm conformance:replay
 *
 * `--bin <path>` replays the runs with another executable than `target/release/kgdiff`, such as
 * another implementation's or `@kgdiff/cli`'s launcher. It reads only the corpus files and the
 * CLI it runs, not the TypeScript sources.
 */
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, TIMEOUT_MS } from './process.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(ROOT, '..');
const BIN = join(REPO, 'target/release', process.platform === 'win32' ? 'kgdiff.exe' : 'kgdiff');

/** `--bin <path>`: the executable to replay with; the release build of the Rust kgdiff without it. */
function binArgument(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--bin');
  if (at === -1) return undefined;
  const path = argv[at + 1];
  if (path === undefined || path.startsWith('-'))
    throw new Error('--bin needs the path of an executable');
  return resolve(path);
}
const COMMAND = binArgument(process.argv.slice(2)) ?? BIN;
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

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

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
  if (!existsSync(COMMAND)) {
    console.error(
      COMMAND === BIN
        ? `conformance: ${BIN} is missing; run \`cargo build --release -p kgdiff\` first.`
        : `conformance: ${COMMAND} is missing.`,
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
  // The implementation's own `kgdiff X.Y.Z`, for the runs that print it.
  const printed = await execute(COMMAND, ['--version'], { cwd: ROOT, env: {} });
  const version = /^kgdiff (\S+)/.exec(printed.stdout.toString('utf8'))?.[1];
  if (printed.code !== 0 || version === undefined) {
    console.error(`conformance: ${COMMAND} --version exited with ${printed.code}.`);
    return 1;
  }

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
      const outcome = await execute(COMMAND, run.args, {
        cwd: dir,
        env: run.env,
        stdin: input,
      });
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
      `conformance: ${failures.length} of ${jobs.length} recorded runs differ with the real kgdiff process (${COMMAND}):`,
    );
    for (const failure of failures.sort()) console.error(`  ${failure}`);
    return 1;
  }
  console.log(
    `conformance: ${jobs.length} recorded runs of ${manifest.cases.length} cases replayed with the real kgdiff process (${COMMAND}); all match.`,
  );
  return 0;
}

process.exitCode = await main();
