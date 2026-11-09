/**
 * Compares the HTML reports of another implementation (RFC 0002: the Rust `kgdiff`) with the
 * built TypeScript CLI's, for every corpus case: both write `-o report.html --reproducible` with
 * the arguments of the case's `summary` run, and their payloads must be equal as values, with
 * one difference accounted for: the layout is a version 2 document with a `generator` where the
 * TypeScript CLI writes version 1. Both reports must also inline the same scripts (the viewer, and
 * the compute add-on exactly when the layout covers only the changes).
 *
 *   pnpm build && cargo build --release -p kgdiff
 *   pnpm tsx conformance/compare-reports.ts --bin target/release/kgdiff
 *
 * The corpus itself records only what the report does not owe to floating-point simulation
 * (`report.json`, `layout-contract.json`); this checks the rest against the reference.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(ROOT, '..');
const TS_BIN = join(REPO, 'packages/cli/dist/bin.js');

interface Report {
  readonly payload: Record<string, unknown>;
  /** How many `<script>` elements the document has: payload, viewer and maybe the add-on. */
  readonly scripts: number;
}

function readReport(path: string): Report {
  const html = readFileSync(path, 'utf8');
  const match = /<script type="application\/kgdiff\+json"([^>]*)>([^<]*)<\/script>/.exec(html);
  if (!match) throw new Error(`${path}: no payload script`);
  const [, attrs = '', body = ''] = match;
  const json = attrs.includes('data-encoding="gzip-base64"')
    ? gunzipSync(Buffer.from(body, 'base64')).toString('utf8')
    : body;
  return {
    payload: JSON.parse(json) as Record<string, unknown>,
    scripts: (html.match(/<script\b/g) ?? []).length,
  };
}

/** The other implementation's payload as the reference writes it: its layout at version 1. */
function asVersion1(payload: Record<string, unknown>): Record<string, unknown> {
  const layout = payload.layout as Record<string, unknown> | undefined;
  if (layout?.version !== 2 || typeof layout.generator !== 'string') return payload;
  const { generator: _generator, ...rest } = layout;
  return { ...payload, layout: { ...rest, version: 1 } };
}

/** The top-level members that differ, and inside `layout` its members, for messages. */
function differences(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (isDeepStrictEqual(a[key], b[key])) continue;
    const [x, y] = [a[key], b[key]];
    if (key === 'layout' && typeof x === 'object' && typeof y === 'object' && x && y) {
      out.push(
        ...differences(x as Record<string, unknown>, y as Record<string, unknown>).map(
          (k) => `layout.${k}`,
        ),
      );
    } else out.push(key);
  }
  return out;
}

function main(argv: readonly string[]): number {
  const at = argv.indexOf('--bin');
  const bin = at === -1 ? undefined : argv[at + 1];
  if (bin === undefined) {
    console.error('conformance: --bin <path> names the executable to compare with.');
    return 1;
  }
  const other = resolve(bin);
  for (const path of [TS_BIN, other]) {
    if (!existsSync(path)) {
      console.error(`conformance: ${path} is missing.`);
      return 1;
    }
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
    cases: readonly { id: string }[];
  };
  const out = mkdtempSync(join(tmpdir(), 'kgdiff-reports-'));
  const failures: string[] = [];
  try {
    for (const { id } of manifest.cases) {
      const dir = join(ROOT, 'cases', id);
      const { cli } = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as {
        cli: readonly { name: string; args: readonly string[] }[];
      };
      const args = cli.find((run) => run.name === 'summary')?.args;
      if (!args) throw new Error(`${id}: no summary run`);
      const write = (command: string, pre: readonly string[], file: string): Report => {
        const path = join(out, `${id}.${file}`);
        const result = spawnSync(command, [...pre, ...args, '-o', path, '--reproducible', '-q'], {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '', COLUMNS: '100' },
          encoding: 'utf8',
        });
        if (result.status !== 0)
          throw new Error(`${id}: ${command} exited ${result.status}: ${result.stderr}`);
        return readReport(path);
      };
      const reference = write(process.execPath, [TS_BIN], 'ts.html');
      const report = write(other, [], 'other.html');
      const changed = differences(reference.payload, asVersion1(report.payload));
      if (changed.length > 0) failures.push(`${id}: payload differs in ${changed.join(', ')}`);
      if (reference.scripts !== report.scripts) {
        failures.push(`${id}: ${report.scripts} scripts, the reference has ${reference.scripts}`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    const cases = new Set(failures.map((failure) => failure.slice(0, failure.indexOf(':')))).size;
    console.error(
      `conformance: the reports of ${cases} of ${manifest.cases.length} cases differ from the TypeScript CLI's:`,
    );
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }
  console.log(
    `conformance: the reports of ${manifest.cases.length} cases equal the TypeScript CLI's (${other}), the layout's version 2 and generator aside.`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
