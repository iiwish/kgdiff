/**
 * Builds the WebAssembly engine of @kgdiff/compute into `wasm/` (RFC 0002, §7 and §8):
 *
 * 1. `cargo build -p kgdiff-wasm` for wasm32-unknown-unknown, optimized for size;
 * 2. wasm-bindgen's glue for the web target, without its TypeScript types (`wasm/` keeps the
 *    hand-written `kgdiff_compute.d.ts`, and the build fails when the functions differ);
 * 3. `wasm-opt -Oz`.
 *
 * It then reports the sizes, gzip level 9, and fails when the module exceeds its limit.
 *
 *   pnpm --filter @kgdiff/compute build:wasm
 *
 * Needs the toolchain of rust-toolchain.toml with its wasm32 target, the wasm-bindgen CLI at the
 * exact version crates/kgdiff-wasm pins, and wasm-opt (binaryen). They are looked up on PATH, or
 * named by the WASM_BINDGEN and WASM_OPT environment variables. With GITHUB_STEP_SUMMARY set, the
 * size table is added to the job summary.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const PACKAGE = resolve(import.meta.dirname, '..');
const ROOT = resolve(PACKAGE, '../..');
const OUT = join(PACKAGE, 'wasm');
const NAME = 'kgdiff_compute';

/**
 * The limit of the module, gzipped. It sits a little above the size of the core-only preview,
 * so that a regression is noticed. RFC 0002 §7 budgets < 250 kB gzip for the full engine
 * (`compute.wasm`, core and layout) after phase 5; the core alone does not meet it yet.
 */
const LIMIT_GZIP = 330 * 1024;
const BUDGET_GZIP = 250 * 1024;

/** The cargo profile of the build: release, optimized for size, one codegen unit, LTO. */
const PROFILE = [
  '--config',
  'profile.compute.inherits="release"',
  '--config',
  'profile.compute.opt-level="z"',
  '--config',
  'profile.compute.lto=true',
  '--config',
  'profile.compute.codegen-units=1',
  '--profile',
  'compute',
];

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** The exact wasm-bindgen version crates/kgdiff-wasm depends on. */
function pinnedBindgen(): string {
  const manifest = readFileSync(join(ROOT, 'crates/kgdiff-wasm/Cargo.toml'), 'utf8');
  const version = /^wasm-bindgen = "=([^"]+)"/m.exec(manifest)?.[1];
  if (version === undefined) throw new Error('crates/kgdiff-wasm pins no wasm-bindgen version');
  return version;
}

/** The engine's `export function` declarations of a .d.ts (not `initSync`), sorted. */
function functions(declarations: string): string[] {
  return declarations
    .split('\n')
    .filter((line) => line.startsWith('export function ') && !line.includes(' initSync('))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .sort();
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const bindgen = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
const wasmOpt = process.env.WASM_OPT ?? 'wasm-opt';

const pinned = pinnedBindgen();
const installed = run(bindgen, ['--version']).trim().split(/\s+/)[1];
if (installed !== pinned) {
  throw new Error(`${bindgen} is ${installed}; crates/kgdiff-wasm needs exactly ${pinned}`);
}

run('cargo', [
  'build',
  '-p',
  'kgdiff-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--locked',
  ...PROFILE,
]);
const built = join(ROOT, 'target/wasm32-unknown-unknown/compute/kgdiff_wasm.wasm');

const staging = mkdtempSync(join(tmpdir(), 'kgdiff-compute-'));
try {
  run(bindgen, ['--target', 'web', '--out-dir', staging, '--out-name', NAME, built]);
  const generated = functions(readFileSync(join(staging, `${NAME}.d.ts`), 'utf8'));
  const kept = functions(readFileSync(join(OUT, `${NAME}.d.ts`), 'utf8'));
  if (generated.join('\n') !== kept.join('\n')) {
    throw new Error(
      `wasm/${NAME}.d.ts does not declare the functions wasm-bindgen generates:\n` +
        generated.join('\n'),
    );
  }
  copyFileSync(join(staging, `${NAME}.js`), join(OUT, `${NAME}.js`));
  run(wasmOpt, ['-Oz', '-o', join(OUT, `${NAME}_bg.wasm`), join(staging, `${NAME}_bg.wasm`)]);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const sizes = [`${NAME}_bg.wasm`, `${NAME}.js`].map((file) => {
  const path = join(OUT, file);
  return {
    file,
    bytes: statSync(path).size,
    gzip: gzipSync(readFileSync(path), { level: 9 }).length,
  };
});
writeFileSync(join(OUT, 'sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);

const table = [
  '| @kgdiff/compute | Size | gzip -9 |',
  '| --- | --- | --- |',
  ...sizes.map((s) => `| \`${s.file}\` | ${kib(s.bytes)} | ${kib(s.gzip)} |`),
  '',
  `Limit of the module: ${kib(LIMIT_GZIP)} gzip. RFC 0002 §7 budget of the full engine after ` +
    `phase 5 (core and layout): ${kib(BUDGET_GZIP)} gzip.`,
].join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);

const module = sizes[0];
if (module !== undefined && module.gzip > LIMIT_GZIP) {
  console.error(
    `${module.file} is ${kib(module.gzip)} gzip, above its limit of ${kib(LIMIT_GZIP)}`,
  );
  process.exitCode = 1;
}
