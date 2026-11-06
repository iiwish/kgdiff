import { describe, expect, it } from 'vitest';
import { bugReportUrl } from '../src/errors.js';
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
    expect(url.searchParams.get('environment')).toBe('testos x64, Node.js v0.0.0');
    expect([...url.searchParams.keys()].sort()).toEqual(['environment', 'template', 'version']);
    expect(decodeURIComponent(url.href)).not.toContain(privateMessage);
    expect(url.href).not.toContain('secret-graph');
    expect(url.href).not.toContain('keep-this-private');
    expect(out.stderr).toContain(`Unexpected error: ${privateMessage}`);
    expect(out.stderr).toContain('DEBUG=kgdiff');
  });

  it('names only the CLI version when the host gives no runtime', async () => {
    const { io, out } = createTestIO({
      files: { 'a.json': '{"nodes":[],"edges":[]}', 'b.json': '{"nodes":[],"edges":[]}' },
    });
    const { runtime: _, ...rest } = io;
    const bare = {
      ...rest,
      now: () => {
        throw new Error('boom');
      },
    };
    expect(await main(['a.json', 'b.json', '--html', 'out.html'], bare)).toBe(2);
    const raw = out.stderr.match(/https:\/\/github\.com\/iiwish\/kgdiff\/issues\/new\?\S+/)?.[0];
    expect([...new URL(raw ?? '').searchParams.keys()].sort()).toEqual(['template', 'version']);
  });

  it('bugReportUrl encodes the values and leaves out an empty runtime', () => {
    expect(bugReportUrl('1.2.3', 'linux x64, Node.js v24.0.0')).toBe(
      'https://github.com/iiwish/kgdiff/issues/new?template=bug_report.yml&version=kgdiff+1.2.3&environment=linux+x64%2C+Node.js+v24.0.0',
    );
    expect(bugReportUrl('1.2.3')).toBe(
      'https://github.com/iiwish/kgdiff/issues/new?template=bug_report.yml&version=kgdiff+1.2.3',
    );
    expect(bugReportUrl('1.2.3', '')).not.toContain('environment');
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
