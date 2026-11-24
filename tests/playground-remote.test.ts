/**
 * The playground's linked files (`?before=<url>&after=<url>`): which addresses it accepts, the
 * file name format detection reads, how it shows an address, and what each failure is.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  checkResponse,
  classifyFailure,
  decodeLinked,
  displayUrl,
  fetchLinked,
  fileNameFromUrl,
  formatBytes,
  type LinkedFailure,
  LinkedFileError,
  linkedParams,
  linkedUrl,
  MAX_LINKED_BYTES,
  readLimited,
} from '../apps/site/src/playground/remote.ts';

const RAW = 'https://raw.githubusercontent.com/iiwish/kgdiff/main/examples/datasets';

const failureOf = async (p: Promise<unknown>): Promise<LinkedFailure> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof LinkedFileError) return error.failure;
    throw error;
  }
  throw new Error('expected a LinkedFileError');
};

/** A stream of `chunks`, recording how many were pulled and whether it was cancelled. */
function chunked(chunks: readonly Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => i, cancelled: () => cancelled };
}

describe('linked file parameters', () => {
  it('are absent without before and after', () => {
    expect(linkedParams(new URLSearchParams('dataset=x&mode=swipe'))).toEqual({ kind: 'none' });
  });

  it('accept two http(s) URLs', () => {
    const p = new URLSearchParams({
      before: `${RAW}/a/before.ttl`,
      after: 'http://example.org/after.ttl',
    });
    const result = linkedParams(p);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.pair.before.href).toBe(`${RAW}/a/before.ttl`);
    expect(result.pair.after.href).toBe('http://example.org/after.ttl');
  });

  it('need both sides', () => {
    expect(linkedParams(new URLSearchParams({ before: `${RAW}/a.ttl` }))).toEqual({
      kind: 'invalid',
      side: 'after',
      reason: 'missing',
    });
    expect(linkedParams(new URLSearchParams({ before: ' ', after: `${RAW}/a.ttl` }))).toEqual({
      kind: 'invalid',
      side: 'before',
      reason: 'missing',
    });
  });

  it('refuse other schemes, non-URLs and credentials', () => {
    expect(linkedUrl('javascript:alert(1)')).toBe('scheme');
    expect(linkedUrl('data:text/turtle,<a> <b> <c> .')).toBe('scheme');
    expect(linkedUrl('file:///etc/passwd')).toBe('scheme');
    expect(linkedUrl('ftp://example.org/a.ttl')).toBe('scheme');
    expect(linkedUrl('/relative/a.ttl')).toBe('invalid');
    expect(linkedUrl('not a url')).toBe('invalid');
    expect(linkedUrl('https://raw.githubusercontent.com@evil.example/a.ttl')).toBe('credentials');
    expect(linkedUrl('https://user:pw@example.org/a.ttl')).toBe('credentials');
    const p = new URLSearchParams({ before: `${RAW}/a.ttl`, after: 'javascript:alert(1)' });
    expect(linkedParams(p)).toEqual({ kind: 'invalid', side: 'after', reason: 'scheme' });
  });

  it('drop the fragment, which is never sent', () => {
    const url = linkedUrl('https://example.org/a.ttl#section');
    expect(url instanceof URL && url.href).toBe('https://example.org/a.ttl');
  });
});

describe('file name from a URL', () => {
  it('is the last path segment, decoded, query ignored', () => {
    expect(fileNameFromUrl(new URL(`${RAW}/go/before.obo.gz?raw=1`))).toBe('before.obo.gz');
    expect(fileNameFromUrl(new URL('https://example.org/dir/my%20onto.ttl'))).toBe('my onto.ttl');
    expect(fileNameFromUrl(new URL('https://example.org/dir/onto.owl/'))).toBe('onto.owl');
  });

  it('falls back to the host without a path, and keeps a malformed escape', () => {
    expect(fileNameFromUrl(new URL('https://purl.example.org/'))).toBe('purl.example.org');
    expect(fileNameFromUrl(new URL('https://example.org/a%E0%A4%A.ttl'))).toBe('a%E0%A4%A.ttl');
  });
});

describe('displayed URL', () => {
  it('is the whole address when it fits', () => {
    expect(displayUrl(new URL('https://example.org/a.ttl'))).toBe('https://example.org/a.ttl');
    expect(displayUrl(new URL('https://example.org/'))).toBe('https://example.org');
  });

  it('shortens the path in the middle, keeping the host and the file name', () => {
    const url = new URL(`https://raw.githubusercontent.com/${'org/'.repeat(30)}v1.1/onto.obo`);
    const shown = displayUrl(url, 72);
    expect(shown.length).toBeLessThanOrEqual(72);
    expect(shown.startsWith('https://raw.githubusercontent.com/')).toBe(true);
    expect(shown.endsWith('v1.1/onto.obo')).toBe(true);
    expect(shown).toContain('…');
  });

  it('never shortens the host, however long', () => {
    const host = `${'sub.'.repeat(30)}example.org`;
    const shown = displayUrl(new URL(`https://${host}/${'x'.repeat(100)}/a.ttl`), 40);
    expect(shown.startsWith(`https://${host}/`)).toBe(true);
    expect(shown.endsWith('a.ttl')).toBe(true);
  });
});

describe('failures', () => {
  it('a TypeError from fetch is "unreachable": CORS or network, which browsers do not tell apart', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'unreachable' });
    expect(classifyFailure(new Error('other'))).toBeNull();
    expect(classifyFailure(new LinkedFileError({ kind: 'encoding' }))).toEqual({
      kind: 'encoding',
    });
  });

  it('an HTTP error keeps its status', async () => {
    const res = new Response('nope', { status: 404, statusText: 'Not Found' });
    expect(await failureOf(Promise.resolve().then(() => checkResponse(res)))).toEqual({
      kind: 'http',
      status: 404,
      statusText: 'Not Found',
    });
  });

  it('a declared length over the limit fails before reading', async () => {
    const res = new Response('x', { headers: { 'content-length': String(MAX_LINKED_BYTES + 1) } });
    expect(await failureOf(Promise.resolve().then(() => checkResponse(res)))).toEqual({
      kind: 'too-large',
      limit: MAX_LINKED_BYTES,
    });
    const encoded = new Response('x', {
      headers: { 'content-length': String(MAX_LINKED_BYTES + 1), 'content-encoding': 'gzip' },
    });
    expect(() => checkResponse(encoded)).not.toThrow();
  });

  it('formats the limit', () => {
    expect(formatBytes(MAX_LINKED_BYTES)).toBe('256 MB');
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB');
    expect(formatBytes(2000)).toBe('2 KB');
  });
});

describe('size-limited reading', () => {
  it('reads a stream within the limit', async () => {
    const { stream } = chunked([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect([...(await readLimited(stream, 3))]).toEqual([1, 2, 3]);
  });

  it('stops and cancels the download as soon as the limit is passed', async () => {
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(10));
    const s = chunked(chunks);
    expect(await failureOf(readLimited(s.stream, 25))).toEqual({ kind: 'too-large', limit: 25 });
    expect(s.cancelled()).toBe(true);
    expect(s.pulled()).toBeLessThan(10);
  });
});

describe('decoding a linked file', () => {
  it('decompresses gzip and strips .gz for format detection, as for dropped files', async () => {
    const bytes = gzipSync(Buffer.from('<a> <b> <c> .\n'));
    expect(await decodeLinked(new Uint8Array(bytes), 'g.nt.gz')).toEqual({
      text: '<a> <b> <c> .\n',
      parseName: 'g.nt',
    });
  });

  it('strips .gz when the server already decompressed the file', async () => {
    const plain = new TextEncoder().encode('format-version: 1.4\n');
    expect((await decodeLinked(plain, 'go.obo.gz')).parseName).toBe('go.obo');
  });

  it('limits the decompressed size too', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(10_000)));
    expect(await failureOf(decodeLinked(bomb, 'a.ttl.gz', 1000))).toEqual({
      kind: 'too-large',
      limit: 1000,
    });
  });

  it('reports a broken gzip and non-text', async () => {
    const broken = new Uint8Array([0x1f, 0x8b, 0x08, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await failureOf(decodeLinked(broken, 'a.ttl.gz'))).toEqual({ kind: 'gzip' });
    expect(await failureOf(decodeLinked(new Uint8Array([0xc3, 0x28]), 'a.ttl'))).toEqual({
      kind: 'encoding',
    });
  });
});

describe('fetching a linked file', () => {
  const url = new URL(`${RAW}/demo/before.ttl`);

  it('fetches without credentials and names the file from the path', async () => {
    let init: RequestInit | undefined;
    const fake = (async (_input: unknown, i?: RequestInit) => {
      init = i;
      return new Response('<a> <b> <c> .');
    }) as typeof fetch;
    const file = await fetchLinked(url, { fetch: fake });
    expect(file).toEqual({ name: 'before.ttl', parseName: 'before.ttl', text: '<a> <b> <c> .' });
    expect(init?.credentials).toBe('omit');
  });

  it('turns each failure into a LinkedFileError', async () => {
    const refused = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect(await failureOf(fetchLinked(url, { fetch: refused }))).toEqual({ kind: 'unreachable' });

    const missing = (async () => new Response('', { status: 404 })) as typeof fetch;
    expect((await failureOf(fetchLinked(url, { fetch: missing }))).kind).toBe('http');

    const big = (async () => new Response('x'.repeat(100))) as typeof fetch;
    expect(await failureOf(fetchLinked(url, { fetch: big, limit: 10 }))).toEqual({
      kind: 'too-large',
      limit: 10,
    });

    const cut = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('network error'));
          },
        }),
      )) as typeof fetch;
    expect(await failureOf(fetchLinked(url, { fetch: cut }))).toEqual({ kind: 'unreachable' });
  });

  it('lets an abort through as it is', async () => {
    const abort = new AbortController();
    abort.abort();
    const fake = (async (_input: unknown, i?: RequestInit) => {
      i?.signal?.throwIfAborted();
      return new Response('');
    }) as typeof fetch;
    await expect(
      fetchLinked(url, { fetch: fake, signal: abort.signal }),
    ).rejects.not.toBeInstanceOf(LinkedFileError);
  });
});
