/**
 * Entry point logic: parse the command line, dispatch, map every failure to a friendly message
 * on stderr and an exit code. Commands are loaded on demand so `--help` and `--version` never
 * load the diff engine.
 */
import { parseCommandLine, peekColorMode } from './args.js';
import { bugReportUrl, debugEnabled, formatError } from './errors.js';
import { renderHelp } from './help.js';
import type { CliIO } from './io.js';
import { createPainter, isLightBackground, resolveColorLevel } from './style.js';
import { cliVersion } from './version.js';

/**
 * Run the CLI with `argv` (without `node` and the script path).
 *
 * Exit codes: 0 success (and no differences with `--exit-code`), 1 differences with
 * `--exit-code`, 2 usage or input error (message on stderr; stack trace only with
 * `DEBUG=kgdiff`). Never throws.
 */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const light = isLightBackground(io.env);
  try {
    const command = parseCommandLine(argv);
    switch (command.kind) {
      case 'help': {
        const paint = createPainter(resolveColorLevel(command.color, io.env, io.isTTY), light);
        io.stdout.write(
          renderHelp(command.topic, cliVersion(), paint, io.isTTY && io.columns ? io.columns : 80),
        );
        return 0;
      }
      case 'version':
        io.stdout.write(`kgdiff ${cliVersion()}\n`);
        return 0;
      case 'diff': {
        const { runDiff } = await import('./diff-command.js');
        return await runDiff(command.options, io);
      }
      case 'apply': {
        const { runApply } = await import('./apply-command.js');
        return await runApply(command.options, io);
      }
      default: {
        const exhaustive: never = command;
        throw new Error(`Unknown command ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    const paint = createPainter(
      resolveColorLevel(peekColorMode(argv), io.env, io.stderrIsTTY),
      light,
    );
    // The platform comes from `io` like every other side effect, so `main` stays runnable
    // in-process and its output deterministic in tests.
    const report = bugReportUrl(cliVersion(), io.runtime);
    io.stderr.write(formatError(error, paint, debugEnabled(io.env.DEBUG), report));
    return 2;
  }
}
