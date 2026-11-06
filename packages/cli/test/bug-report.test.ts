import { describe, expect, it } from 'vitest';
import { cliVersion, main } from '../src/index.js';
import { createTestIO, run } from './helpers.js';

describe('unexpected-error bug report hint', () => {
  it('prefills only the CLI version and runtime environment, never private error data', async () => {
    const privateMessage = '/private/secret-graph.json?token=keep-this-private';
    const { io, out } = createTestIO({
      files: { 'a.json': '{"nodes":[],"edges":[]}', 'b.json': '{"nodes":[],"edges":[]}' },
    });
    io.now = () => {
      throw new Error(privateMessage);
    };
    expect(await main(['a.json', 'b.json', '--html', 'out.html'], io)).toBe(2);
    const raw = out.stderr.match(/https:\/\/github\.com\/iiwish\/kgdiff\/issues\/new\?\S+/)?.[0];
    expect(raw).toBeDefined();
    const url = new URL(raw ?? '');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toBe(`kgdiff ${cliVersion()}`);
    expect(url.searchParams.get('environment')).toBe(
      `${process.platform} ${process.arch}, Node.js ${process.version}`,
    );
    expect([...url.searchParams.keys()].sort()).toEqual(['environment', 'template', 'version']);
    expect(decodeURIComponent(url.href)).not.toContain(privateMessage);
    expect(url.href).not.toContain('secret-graph');
    expect(url.href).not.toContain('keep-this-private');
    expect(out.stderr).toContain(`Unexpected error: ${privateMessage}`);
    expect(out.stderr).toContain('DEBUG=kgdiff');
  });

  it.each([
    ['usage', ['--not-an-option']],
    ['missing input', ['missing.json', 'other.json']],
    ['invalid graph', ['invalid.json', 'other.json']],
  ])('does not add a bug-report URL for %s errors', async (_name, argv) => {
    const result = await run(argv, {
      files: { 'invalid.json': 'not JSON', 'other.json': '{"nodes":[],"edges":[]}' },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('/issues/new?');
  });
});
