/**
 * Vitest setup of the projects that run in happy-dom (viewer, g6): loads kgdiff's WebAssembly
 * modules from `packages/compute/wasm/` before the tests. In happy-dom, Vite turns the modules'
 * `new URL('…wasm', import.meta.url)` into URLs of a dev server that tests do not run, so they
 * are read from disk here instead; Node-environment projects read them on their own.
 *
 * Without the build (`pnpm --filter @kgdiff/compute build:wasm`) nothing is loaded, and the tests
 * that diff, parse or lay out fail with `@kgdiff/compute`'s "not initialized" error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { init, type ModuleName } from '../src/index.js';

const WASM = resolve(import.meta.dirname, '../wasm');
const names: readonly ModuleName[] = ['compute', 'formats', 'layout'];
const present = names.filter((name) => existsSync(join(WASM, `${name}.wasm`)));
await init({
  modules: present,
  sources: Object.fromEntries(
    present.map((name) => [name, readFileSync(join(WASM, `${name}.wasm`))]),
  ),
});
