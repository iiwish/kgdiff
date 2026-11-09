#!/usr/bin/env node
/**
 * `kgdiff`: runs the native kgdiff of this platform (lib/launcher.js) with the same arguments,
 * stdin, stdout and stderr, and exits as it does.
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { findBinary, LauncherError } from '../lib/launcher.js';

/** @type {string} */
let binary;
try {
  binary = findBinary();
} catch (error) {
  if (!(error instanceof LauncherError)) throw error;
  process.stderr.write(`kgdiff: ${error.message}\n`);
  process.exit(2);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`kgdiff: cannot run ${binary}: ${result.error.message}\n`);
  process.exit(2);
}
if (result.signal) {
  // Die of the same signal, as a shell expects; 128 + its number where Node.js ignores it.
  process.kill(process.pid, result.signal);
  process.exit(128 + (constants.signals[result.signal] ?? 0));
}
process.exit(result.status ?? 2);
