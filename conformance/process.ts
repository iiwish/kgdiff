/**
 * Runs `kgdiff` as a real process, as the corpus's CLI runs are defined (README, "CLI runs"): the
 * run's arguments, a working directory, the run's environment and only what starting a process
 * needs besides it, stdin piped from bytes (empty when absent), stdout and stderr through pipes.
 * `corpus.ts` records the runs this way and `replay.ts` checks them.
 */
import { spawn } from 'node:child_process';

/** A run that takes longer than this is reported as hanging. */
export const TIMEOUT_MS = 60_000;

export interface ProcessOutcome {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut: boolean;
}

/** What a process needs to start, beside the recorded environment. */
export function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) {
    env.SystemRoot = process.env.SystemRoot;
  }
  return env;
}

export function execute(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: Uint8Array;
  },
): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...processEnv(), ...options.env },
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
    child.stdin.end(options.stdin ?? new Uint8Array());
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
