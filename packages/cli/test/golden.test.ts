/**
 * Golden outputs for the featured datasets, with each dataset's meta.json options (the LLM
 * extraction runs also cover the possible matches after the hunk list). Review the
 * files under `__snapshots__/` when the diff engine or the layout of the summary changes
 * (`pnpm vitest run packages/cli -u` updates them). The CLI version reads `<version>` in them,
 * so that a release leaves them alone.
 */
import { describe, expect, it } from 'vitest';
import { cliVersion } from '../src/version.js';
import { dataset, run } from './helpers.js';

/** The Markdown footer names the CLI version, which every release changes. */
const VERSION = `kgdiff ${cliVersion()}`;

const CASES = [
  { id: 'enterprise-kg', locale: 'zh-CN' },
  { id: 'enterprise-kg-en', locale: 'en' },
  { id: 'ontology-release', locale: 'en' },
  { id: 'llm-extraction', locale: 'en' },
] as const;

const OUTPUTS = [
  { name: 'summary', flags: [] as string[], ext: 'txt' },
  { name: 'stat', flags: ['--stat'], ext: 'txt' },
  { name: 'name-status', flags: ['--name-status'], ext: 'tsv' },
  { name: 'markdown', flags: ['--markdown'], ext: 'md.snap' },
] as const;

describe.each(CASES)('$id ($locale)', ({ id, locale }) => {
  const d = dataset(id);
  const base = [d.before, d.after, ...d.flags, '--locale', locale];

  it.each(OUTPUTS)('$name', async ({ name, flags, ext }) => {
    const r = await run([...base, ...flags], { env: { COLUMNS: '100' } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    const out = r.stdout.replaceAll(VERSION, 'kgdiff <version>');
    await expect(out).toMatchFileSnapshot(`__snapshots__/${id}.${name}.${ext}`);
  });

  it('summary in color (truecolor)', async () => {
    const r = await run([...base, '--color', 'always'], {
      env: { COLUMNS: '100', COLORTERM: 'truecolor' },
    });
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(`__snapshots__/${id}.summary.color.ansi`);
  });

  it('summary in a narrow terminal (64 columns, 256 colors off)', async () => {
    const r = await run(base, { isTTY: true, columns: 64, env: { NO_COLOR: '1' } });
    await expect(r.stdout).toMatchFileSnapshot(`__snapshots__/${id}.summary.64.txt`);
  });
});
