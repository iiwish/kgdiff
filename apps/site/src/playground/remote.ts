/**
 * Linked files: `?before=<url>&after=<url>` opens a diff of two public files. The browser fetches
 * them itself (nothing goes through a kgdiff server), after the visitor has seen both addresses
 * and confirmed. This module is the part without the page: reading and checking the parameters,
 * the file name of a URL, a size-limited read of a response, and what a failure was.
 */

export type SideName = 'before' | 'after';

/**
 * The most a linked file may be, downloaded and after decompression. Dropped files have no limit
 * of their own (the visitor chose them, and the browser reads them however large); a link is
 * chosen by whoever wrote it, so its files stop here rather than exhausting the tab's memory.
 */
export const MAX_LINKED_BYTES = 256 * 1024 * 1024;

export interface LinkedPair {
  readonly before: URL;
  readonly after: URL;
}

export type LinkedParams =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly pair: LinkedPair }
  | {
      readonly kind: 'invalid';
      /** The first parameter that is missing or not a usable address. */
      readonly side: SideName;
      readonly reason: 'missing' | 'invalid' | 'scheme' | 'credentials';
    };

/** An http(s) URL the browser can fetch, or why `raw` is not one. */
export function linkedUrl(raw: string): URL | 'invalid' | 'scheme' | 'credentials' {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'invalid';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'scheme';
  // `fetch` refuses URLs with credentials, and showing `https://example.org@other.host/` would
  // invite misreading the host.
  if (url.username !== '' || url.password !== '') return 'credentials';
  url.hash = '';
  return url;
}

/** The `before` / `after` pair of the page's address: absent, both usable, or what is wrong. */
export function linkedParams(params: URLSearchParams): LinkedParams {
  if (!params.has('before') && !params.has('after')) return { kind: 'none' };
  const urls: Partial<Record<SideName, URL>> = {};
  for (const side of ['before', 'after'] as const) {
    const raw = params.get(side);
    if (raw === null || raw.trim() === '') return { kind: 'invalid', side, reason: 'missing' };
    const url = linkedUrl(raw);
    if (!(url instanceof URL)) return { kind: 'invalid', side, reason: url };
    urls[side] = url;
  }
  const { before, after } = urls as Record<SideName, URL>;
  return { kind: 'ok', pair: { before, after } };
}

/** The last segment of the URL's path, decoded: what format detection reads (`onto.obo.gz`). */
export function fileNameFromUrl(url: URL): string {
  const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // A malformed escape: keep the segment as it is.
  }
  return name || url.hostname;
}

/**
 * The URL as the confirmation shows it: scheme and host always whole, the path shortened in the
 * middle (its end, the file name, kept) when the whole is longer than `max` characters.
 */
export function displayUrl(url: URL, max = 72): string {
  const head = `${url.protocol}//${url.host}`;
  const rest = `${url.pathname}${url.search}`;
  const full = rest === '/' ? head : head + rest;
  if (full.length <= max) return full;
  const room = Math.max(max - head.length - 1, 12);
  if (rest.length <= room) return full;
  const tail = Math.ceil((room * 2) / 3);
  const lead = room - tail;
  return `${head}${rest.slice(0, lead)}…${rest.slice(rest.length - tail)}`;
}

// ── Failures ───────────────────────────────────────────────────────────────

export type LinkedFailure =
  /** `fetch` rejected: CORS refused, or the host could not be reached. Browsers do not say which. */
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'http'; readonly status: number; readonly statusText: string }
  | { readonly kind: 'too-large'; readonly limit: number }
  /** Starts like gzip but does not decompress. */
  | { readonly kind: 'gzip' }
  /** Not text: neither UTF-8 nor UTF-16. */
  | { readonly kind: 'encoding' };

export class LinkedFileError extends Error {
  readonly failure: LinkedFailure;
  constructor(failure: LinkedFailure, message = failure.kind) {
    super(message);
    this.name = 'LinkedFileError';
    this.failure = failure;
  }
}

/**
 * What a failed fetch or read was. A `TypeError` from `fetch` (or from its body stream) is the
 * browser's one answer for CORS, DNS, TLS and lost connections alike: it is `unreachable`, and the
 * message has to say "maybe CORS" rather than claim it. Anything else is not a fetch failure.
 */
export function classifyFailure(error: unknown): LinkedFailure | null {
  if (error instanceof LinkedFileError) return error.failure;
  if (error instanceof TypeError) return { kind: 'unreachable' };
  return null;
}

/** Throws for a response that is not a usable file: an HTTP error, or a declared size too large. */
export function checkResponse(
  res: {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: { get(name: string): string | null };
  },
  limit = MAX_LINKED_BYTES,
): void {
  if (!res.ok) {
    throw new LinkedFileError({ kind: 'http', status: res.status, statusText: res.statusText });
  }
  // With `Content-Encoding`, the length is the compressed size and says nothing of what the
  // stream delivers; the streaming read still stops at the limit.
  const length = Number(res.headers.get('content-length'));
  if (!res.headers.get('content-encoding') && Number.isFinite(length) && length > limit) {
    throw new LinkedFileError({ kind: 'too-large', limit });
  }
}

/**
 * All bytes of `stream`, read chunk by chunk; past `limit` bytes the stream is cancelled (the
 * download stops) and a `too-large` failure thrown, without holding more than the limit.
 */
export async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit = MAX_LINKED_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new LinkedFileError({ kind: 'too-large', limit });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const isGzip = (bytes: Uint8Array): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Decompresses gzip `bytes`, stopping at `limit` decompressed bytes like `readLimited`. */
export function gunzipLimited(
  bytes: Uint8Array,
  limit = MAX_LINKED_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = source.pipeThrough(
    new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return readLimited(stream, limit);
}

/** Text in UTF-16 (with its byte order mark) or UTF-8; throws for anything else. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * A downloaded file as the parser reads it, like a dropped one: gzip (by its magic bytes) is
 * decompressed and `.gz` leaves the name format detection sees. A `.gz` name without the magic
 * bytes is a file the server already decompressed (`Content-Encoding: gzip`): `.gz` goes too.
 */
export async function decodeLinked(
  bytes: Uint8Array,
  name: string,
  limit = MAX_LINKED_BYTES,
): Promise<{ readonly text: string; readonly parseName: string }> {
  let data: Uint8Array = bytes;
  if (isGzip(bytes)) {
    try {
      data = await gunzipLimited(bytes, limit);
    } catch (error) {
      if (error instanceof LinkedFileError) throw error;
      throw new LinkedFileError({ kind: 'gzip' });
    }
  }
  const parseName = name.replace(/\.gz$/i, '');
  try {
    return { text: decodeText(data), parseName };
  } catch {
    throw new LinkedFileError({ kind: 'encoding' });
  }
}

export interface LinkedFile {
  /** The file name from the URL path: shown in the toolbar. */
  readonly name: string;
  /** For format detection (`.gz` stripped). */
  readonly parseName: string;
  readonly text: string;
}

/**
 * Downloads `url` and decodes it. Every failure is a `LinkedFileError`: `fetch` and its body
 * stream reject with `TypeError` for CORS and network failures alike (`unreachable`). Cookies and
 * other credentials are never sent: a link opens what is public, not what the visitor can see.
 */
export async function fetchLinked(
  url: URL,
  options: {
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly limit?: number;
  } = {},
): Promise<LinkedFile> {
  const { fetch: get = fetch, signal, limit = MAX_LINKED_BYTES } = options;
  const name = fileNameFromUrl(url);
  let bytes: Uint8Array;
  try {
    const res = await get(url.href, {
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    });
    checkResponse(res, limit);
    bytes = res.body ? await readLimited(res.body, limit) : new Uint8Array();
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = classifyFailure(error);
    if (!failure) throw error;
    throw error instanceof LinkedFileError ? error : new LinkedFileError(failure);
  }
  const decoded = await decodeLinked(bytes, name, limit);
  return { name, ...decoded };
}

/** `256 MB`: the limit in the failure message. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1
    ? `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
