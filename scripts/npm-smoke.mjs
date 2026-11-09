/**
 * Smoke test of the npm packages `scripts/npm-platforms.ts assemble` packed: unpacks every
 * tarball of <dir> into a fresh `node_modules` (the launcher and all platform packages, so the
 * launcher has to pick the right one for this machine: musl on Alpine, the exact architecture
 * elsewhere), then runs `kgdiff` through the launcher on an example dataset. No npm registry is
 * involved, so it works before anything is published. Plain Node.js, no dependencies:
 *
 *   node scripts/npm-smoke.mjs target/npm
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'target/npm');
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));

const project = mkdtempSync(join(tmpdir(), 'kgdiff-npm-smoke-'));
try {
  const modules = join(project, 'node_modules', '@kgdiff');
  mkdirSync(modules, { recursive: true });
  for (const tarball of readdirSync(dir).filter((name) => name.endsWith('.tgz'))) {
    const scratch = mkdtempSync(join(project, 'unpack-'));
    execFileSync('tar', ['-xzf', join(dir, tarball), '-C', scratch]);
    const { name } = JSON.parse(readFileSync(join(scratch, 'package', 'package.json'), 'utf8'));
    renameSync(join(scratch, 'package'), join(modules, name.replace('@kgdiff/', '')));
    rmSync(scratch, { recursive: true, force: true });
  }
  const launcher = join(modules, 'cli', 'bin', 'kgdiff.js');
  const run = (/** @type {string[]} */ args) => {
    const result = spawnSync(process.execPath, [launcher, ...args], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, KGDIFF_BINARY: '' },
    });
    if (result.error) throw result.error;
    return result;
  };

  const v = run(['--version']);
  if (v.status !== 0 || v.stdout.trim() !== `kgdiff ${version}`) {
    throw new Error(`kgdiff --version: exit ${v.status}, ${JSON.stringify(v.stdout + v.stderr)}`);
  }
  const data = join(root, 'examples/datasets/enterprise-kg');
  const args = [join(data, 'before.json'), join(data, 'after.json'), '--match', 'auto'];
  const stat = run([...args, '--stat', '--color', 'never']);
  if (stat.status !== 0 || !stat.stdout.includes('nodes')) {
    throw new Error(`kgdiff --stat: exit ${stat.status}, ${stat.stderr}`);
  }
  const changed = run([...args, '--exit-code', '--quiet']);
  if (changed.status !== 1) throw new Error(`kgdiff --exit-code: exit ${changed.status}`);
  const report = join(project, 'report.html');
  const html = run([...args, '-o', report, '--reproducible', '--quiet']);
  if (html.status !== 0 || !readFileSync(report, 'utf8').includes('application/kgdiff+json')) {
    throw new Error(`kgdiff -o: exit ${html.status}, ${html.stderr}`);
  }
  console.log(
    `npm-smoke: kgdiff ${version} runs through @kgdiff/cli on ${process.platform}-${process.arch}.`,
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}
