/**
 * Checks what `pnpm publish` would upload, after `pnpm build`:
 *
 *   pnpm build && pnpm check:packages
 *
 * Every public package under packages/ is packed with `pnpm pack` (workspace ranges rewritten,
 * the root LICENSE added), then its tarball must
 *
 * - contain package.json, README.md and LICENSE, and for @kgdiff/compute its three WebAssembly
 *   modules and their glue (`pnpm --filter @kgdiff/compute build:wasm`). Without that build,
 *   @kgdiff/compute is left out with a notice, unless KGDIFF_COMPUTE is set (the `compute` job of
 *   CI and the release), where it fails;
 * - resolve every source map it references: each `sourceMappingURL` of an emitted .js / .d.ts
 *   is in the tarball, and so is every map source (`../src/*.ts`) without inline content;
 * - pass publint (strict: warnings fail) and Are the Types Wrong? (ESM-only profile).
 *
 * Exits 1 with the list of problems. Tarballs are left in node_modules/.cache/kgdiff-packs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, resolve } from 'node:path';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'kgdiff-packs');
const REQUIRED_FILES = ['package.json', 'README.md', 'LICENSE'];
/** Entry points that are not typed modules: scripts for `<script>` tags, JSON Schemas. */
const UNTYPED_ENTRYPOINTS: Readonly<Record<string, readonly string[]>> = {
  '@kgdiff/core': [
    './schema/graph.v1.json',
    './schema/diff.v1.json',
    './schema/diff-packed.v1.json',
    './schema/delta.v1.json',
    './schema/layout.v2.json',
    './schema/report.v1.json',
  ],
  '@kgdiff/viewer': ['./standalone', './standalone/compute'],
};
/** The modules @kgdiff/compute must ship (RFC 0002, §7). */
const COMPUTE_FILES = ['compute', 'layout', 'formats'].flatMap((name) => [
  `wasm/${name}.wasm`,
  `wasm/${name}.js`,
  `wasm/${name}.d.ts`,
]);
const SOURCE_MAPPING_URL = /\/\/# sourceMappingURL=(\S+)\s*$/;

interface PackResult {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

interface SourceMap {
  readonly sourceRoot?: string;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
}

function packageDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const entry of readdirSync(join(ROOT, 'packages'))) {
    const file = join(ROOT, 'packages', entry, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name: string; private?: boolean };
    if (pkg.private) continue;
    const dir = join(ROOT, 'packages', entry);
    if (
      pkg.name === '@kgdiff/compute' &&
      process.env.KGDIFF_COMPUTE === undefined &&
      !existsSync(join(dir, 'wasm', 'compute.wasm'))
    ) {
      console.info('- @kgdiff/compute: no WebAssembly build, not packed (KGDIFF_COMPUTE unset)');
      continue;
    }
    dirs.set(pkg.name, dir);
  }
  return dirs;
}

/** Packs the given packages. */
function pack(names: Iterable<string>): PackResult[] {
  rmSync(OUT, { recursive: true, force: true });
  const filters = [...names].flatMap((name) => ['--filter', name]);
  const json = execFileSync(
    'pnpm',
    ['-r', ...filters, 'pack', '--json', '--pack-destination', OUT],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  return JSON.parse(json) as PackResult[];
}

/** Problems with the source maps referenced by the packed files; returns the number of maps. */
function checkSourceMaps(dir: string, files: ReadonlySet<string>, problems: string[]): number {
  let maps = 0;
  for (const file of files) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
    const url = SOURCE_MAPPING_URL.exec(readFileSync(join(dir, file), 'utf8'))?.[1];
    if (url === undefined || url.startsWith('data:')) continue;
    const mapPath = posix.join(posix.dirname(file), url);
    if (!files.has(mapPath)) {
      problems.push(`${file} points to ${mapPath}, which is not packed`);
      continue;
    }
    maps++;
    const map = JSON.parse(readFileSync(join(dir, mapPath), 'utf8')) as SourceMap;
    map.sources.forEach((source, i) => {
      if (typeof map.sourcesContent?.[i] === 'string') return;
      const path = posix.join(posix.dirname(mapPath), map.sourceRoot ?? '', source);
      if (!files.has(path)) problems.push(`${mapPath} needs ${path}, which is not packed`);
    });
  }
  return maps;
}

async function runPublint(tarball: string, problems: string[]): Promise<void> {
  const data = readFileSync(tarball);
  const { messages, pkg } = await publint({
    pack: { tarball: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) },
    strict: true,
  });
  for (const message of messages) {
    const text = formatMessage(message, pkg, { color: false }) ?? message.code;
    if (message.type === 'error') problems.push(`publint: ${text}`);
    else console.info(`  publint ${message.type}: ${text}`);
  }
}

function runAttw(name: string, tarball: string, problems: string[]): void {
  const require = createRequire(import.meta.url);
  const cliPackage = require.resolve('@arethetypeswrong/cli/package.json');
  const bin = (JSON.parse(readFileSync(cliPackage, 'utf8')) as { bin: { attw: string } }).bin.attw;
  const exclude = UNTYPED_ENTRYPOINTS[name] ?? [];
  const result = spawnSync(
    process.execPath,
    [
      join(cliPackage, '..', bin),
      tarball,
      '--profile',
      'esm-only',
      '--format',
      'ascii',
      ...(exclude.length > 0 ? ['--exclude-entrypoints', ...exclude] : []),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) problems.push(`attw:\n${result.stdout}${result.stderr}`);
}

const dirs = packageDirs();
const failures: string[] = [];
for (const result of pack(dirs.keys())) {
  const dir = dirs.get(result.name);
  if (dir === undefined) throw new Error(`Packed ${result.name}, which is not under packages/`);
  const files = new Set(result.files.map((file) => file.path));
  const problems: string[] = [];
  for (const file of [
    ...REQUIRED_FILES,
    ...(result.name === '@kgdiff/compute' ? COMPUTE_FILES : []),
  ]) {
    if (!files.has(file)) problems.push(`${file} is not packed`);
  }
  const maps = checkSourceMaps(dir, files, problems);
  await runPublint(result.filename, problems);
  runAttw(result.name, result.filename, problems);
  const label = `${result.name}@${result.version}: ${files.size} files, ${maps} source maps`;
  if (problems.length === 0) {
    console.info(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    failures.push(result.name);
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} package(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
