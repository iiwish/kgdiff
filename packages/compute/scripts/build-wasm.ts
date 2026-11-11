/**
 * Builds the three WebAssembly modules of @kgdiff/compute into `wasm/` (RFC 0002, §7 and §8), and
 * the corpus build its tests also run into `test/wasm/`:
 *
 * | module    | crates/kgdiff-wasm features | what                                       |
 * | --------- | --------------------------- | ------------------------------------------ |
 * | `compute` | `engine`                    | diff, matching, normalization, layout      |
 * | `layout`  | `layout`                    | the layout on typed arrays, for reports    |
 * | `formats` | `parsers`                   | the graph file parsers                     |
 * | `corpus`  | `corpus`                    | `compute` and the read path, tests only    |
 *
 * Each is `cargo build -p kgdiff-wasm` for wasm32-unknown-unknown, optimized for size, then
 * wasm-bindgen's glue for the web target (without its TypeScript types: `wasm/` keeps hand-written
 * ones, and the build fails when the functions differ), then `wasm-opt -Oz`.
 *
 * It then reports the sizes, gzip level 9, writes them to `wasm/sizes.json`, and fails when a
 * module exceeds its limit. It also writes the SHA-256 of the native layouts of the corpus
 * (`kgdiff-layout`'s `corpus_hashes` example) to `test/wasm/native-layouts.txt`, which the corpus
 * test compares the WebAssembly layouts with.
 *
 *   pnpm --filter @kgdiff/compute build:wasm
 *
 * Needs the toolchain of rust-toolchain.toml with its wasm32 target and its `rust-src` component
 * (the standard library is rebuilt for size: `-Zbuild-std`, allowed on the stable toolchain by
 * RUSTC_BOOTSTRAP), the wasm-bindgen CLI at the exact version crates/kgdiff-wasm pins, and
 * wasm-opt (binaryen). They are looked up on PATH, or named by the WASM_BINDGEN and WASM_OPT
 * environment variables. With GITHUB_STEP_SUMMARY set, the size table is added to the job
 * summary.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const PACKAGE = resolve(import.meta.dirname, '..');
const ROOT = resolve(PACKAGE, '../..');
const KIB = 1024;

interface ModuleSpec {
  readonly name: string;
  readonly features: string;
  readonly out: string;
  /** RFC 0002 §7, gzip, of the module and its glue. */
  readonly budget?: number;
  /**
   * The limit CI holds, gzip, of the module and its glue: the budget, or for a module that does
   * not meet it yet, a little above its size, so that a regression is noticed.
   */
  readonly limit?: number;
  /** For `layout`, inlined in reports: the entry whose bundled JavaScript counts as glue. */
  readonly entry?: string;
  /** The cargo opt-level of the module's own code; default `"z"`, optimized for size. */
  readonly optLevel?: string;
}

const MODULES: readonly ModuleSpec[] = [
  {
    name: 'layout',
    features: 'layout',
    out: join(PACKAGE, 'wasm'),
    budget: 45 * KIB,
    limit: 70 * KIB,
    entry: 'src/layout.ts',
  },
  {
    name: 'compute',
    features: 'engine',
    out: join(PACKAGE, 'wasm'),
    // Raised from 250 for 1.0 by the maintainer (2026-11-11), so that the engine can be built
    // for speed: the diff including the transport to a DiffResult is the gate.
    budget: 350 * KIB,
    limit: 350 * KIB,
    // Measured against `z` and `3` (README, "Size and speed"): as fast as `3`, 4% smaller.
    optLevel: '2',
  },
  { name: 'corpus', features: 'corpus', out: join(PACKAGE, 'test/wasm'), optLevel: '2' },
  {
    name: 'formats',
    features: 'parsers',
    out: join(PACKAGE, 'wasm'),
    budget: 200 * KIB,
    limit: 223 * KIB,
  },
];

/**
 * The cargo profile and flags: release, optimized for size unless a module says otherwise
 * (`optLevel`), one codegen unit, LTO; the standard
 * library rebuilt with `optimize_for_size` and panics that abort at once (a panic in WebAssembly
 * traps either way; this leaves out the formatting of its message). The standard library itself
 * keeps opt-level 3, as the prebuilt one has it: at `z` the diff is about 15% slower, for 2% of
 * size.
 */
const CARGO = [
  '--config',
  'profile.compute.inherits="release"',
  '--config',
  'profile.compute.lto=true',
  '--config',
  'profile.compute.codegen-units=1',
  '--config',
  'profile.compute.panic="immediate-abort"',
  ...['core', 'alloc', 'std'].flatMap((name) => [
    '--config',
    `profile.compute.package.${name}.opt-level=3`,
  ]),
  '--profile',
  'compute',
  '-Zpanic-immediate-abort',
  '-Zbuild-std=std,panic_abort',
  '-Zbuild-std-features=optimize_for_size',
];
// getrandom's backend for oxrdf's blank-node names (formats only; the others never call it).
const RUSTFLAGS = '-Zunstable-options -Cpanic=immediate-abort --cfg getrandom_backend="wasm_js"';
const TARGET_DIR = join(ROOT, 'target/compute');

function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The exact wasm-bindgen version crates/kgdiff-wasm depends on. */
function pinnedBindgen(): string {
  const manifest = readFileSync(join(ROOT, 'crates/kgdiff-wasm/Cargo.toml'), 'utf8');
  const version = /^wasm-bindgen = "=([^"]+)"/m.exec(manifest)?.[1];
  if (version === undefined) throw new Error('crates/kgdiff-wasm pins no wasm-bindgen version');
  return version;
}

/**
 * The engine's functions in a .d.ts (not `initSync`), as `name(parameter, …)`, sorted: the kept
 * declarations may type a parameter more precisely than wasm-bindgen does (a callback's shape).
 */
function functions(declarations: string): string[] {
  const out: string[] = [];
  for (const match of declarations.matchAll(/export function (\w+)\(/g)) {
    if (match[1] === 'initSync') continue;
    // The parameter names, at the top level of the parentheses.
    const names: string[] = [];
    let depth = 0;
    let start = true;
    for (let i = (match.index ?? 0) + match[0].length; i < declarations.length; i++) {
      const c = declarations[i] as string;
      if (c === '(') depth++;
      else if (c === ')' && depth-- === 0) break;
      else if (c === ',' && depth === 0) start = true;
      else if (start && /\w/.test(c)) {
        names.push(/^\w+/.exec(declarations.slice(i))?.[0] ?? '');
        start = false;
      }
    }
    out.push(`${match[1]}(${names.join(', ')})`);
  }
  return out.sort();
}

function kib(bytes: number): string {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

function gzip(data: Uint8Array | string): number {
  return gzipSync(data, { level: 9 }).length;
}

const bindgen = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
const wasmOpt = process.env.WASM_OPT ?? 'wasm-opt';

const pinned = pinnedBindgen();
const installed = run(bindgen, ['--version']).trim().split(/\s+/)[1];
if (installed !== pinned) {
  throw new Error(`${bindgen} is ${installed}; crates/kgdiff-wasm needs exactly ${pinned}`);
}

interface Size {
  readonly module: string;
  readonly wasm: number;
  readonly wasmGzip: number;
  readonly glueGzip: number;
  readonly gzip: number;
  readonly budget?: number;
  readonly limit?: number;
}

const sizes: Size[] = [];
for (const spec of MODULES) {
  run(
    'cargo',
    [
      'build',
      '-p',
      'kgdiff-wasm',
      '--no-default-features',
      '--features',
      spec.features,
      '--target',
      'wasm32-unknown-unknown',
      '--target-dir',
      TARGET_DIR,
      '--locked',
      ...CARGO,
      '--config',
      `profile.compute.opt-level=${/^\d$/.test(spec.optLevel ?? 'z') ? spec.optLevel : `"${spec.optLevel ?? 'z'}"`}`,
    ],
    { RUSTC_BOOTSTRAP: '1', RUSTFLAGS },
  );
  const built = join(TARGET_DIR, 'wasm32-unknown-unknown/compute/kgdiff_wasm.wasm');
  mkdirSync(spec.out, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), 'kgdiff-compute-'));
  try {
    run(bindgen, ['--target', 'web', '--out-dir', staging, '--out-name', spec.name, built]);
    const typed = join(spec.out, `${spec.name}.d.ts`);
    if (spec.out === join(PACKAGE, 'wasm')) {
      const generated = functions(readFileSync(join(staging, `${spec.name}.d.ts`), 'utf8'));
      const kept = functions(readFileSync(typed, 'utf8'));
      if (generated.join('\n') !== kept.join('\n')) {
        throw new Error(
          `wasm/${spec.name}.d.ts does not declare the functions wasm-bindgen generates:\n` +
            generated.join('\n'),
        );
      }
    }
    // The module is `<name>.wasm`, the name the glue's own default URL then points to.
    const glue = readFileSync(join(staging, `${spec.name}.js`), 'utf8').replaceAll(
      `${spec.name}_bg.wasm`,
      `${spec.name}.wasm`,
    );
    writeFileSync(join(spec.out, `${spec.name}.js`), glue);
    run(wasmOpt, [
      '-Oz',
      '--strip-debug',
      '--strip-producers',
      '-o',
      join(spec.out, `${spec.name}.wasm`),
      join(staging, `${spec.name}_bg.wasm`),
    ]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  if (spec.budget === undefined) continue;
  const wasm = readFileSync(join(spec.out, `${spec.name}.wasm`));
  let glue = readFileSync(join(spec.out, `${spec.name}.js`), 'utf8');
  if (spec.entry !== undefined) {
    // What a report inlines: the entry and everything it imports, minified, the glue included.
    const bundle = await build({
      entryPoints: [join(PACKAGE, spec.entry)],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
    });
    glue = bundle.outputFiles[0]?.text ?? '';
  }
  const wasmGzip = gzip(wasm);
  const glueGzip = gzip(glue);
  sizes.push({
    module: spec.name,
    wasm: statSync(join(spec.out, `${spec.name}.wasm`)).size,
    wasmGzip,
    glueGzip,
    gzip: wasmGzip + glueGzip,
    budget: spec.budget,
    limit: spec.limit,
  });
}
writeFileSync(join(PACKAGE, 'wasm/sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);

// The native layouts the corpus test compares the WebAssembly ones with.
const hashes = run('cargo', [
  'run',
  '--release',
  '--locked',
  '-q',
  '-p',
  'kgdiff-layout',
  '--example',
  'corpus_hashes',
  '--',
  'conformance',
]);
writeFileSync(join(PACKAGE, 'test/wasm/native-layouts.txt'), hashes);

const table = [
  '| @kgdiff/compute | `.wasm` | `.wasm` gzip -9 | glue gzip -9 | gzip in all | limit | RFC 0002 §7 budget |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...sizes.map(
    (s) =>
      `| \`${s.module}.wasm\` | ${kib(s.wasm)} | ${kib(s.wasmGzip)} | ${kib(s.glueGzip)} | ` +
      `${kib(s.gzip)} | ${s.limit === undefined ? '—' : kib(s.limit)} | ` +
      `${s.budget === undefined ? '—' : kib(s.budget)} |`,
  ),
  '',
  'The glue of `layout` is `@kgdiff/compute/layout` bundled and minified, as a report inlines it.',
].join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);

for (const s of sizes) {
  if (s.limit !== undefined && s.gzip > s.limit) {
    console.error(`${s.module}: ${kib(s.gzip)} gzip, above its limit of ${kib(s.limit)}`);
    process.exitCode = 1;
  }
}
