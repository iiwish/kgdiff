/**
 * How the corpus decodes a case's input bytes, as `kgdiff` does (README, "Library outputs",
 * step 1): gunzip when gzip-compressed, UTF-16 by byte order mark, else strict UTF-8, without
 * the byte order mark. For checks that read the inputs themselves, such as
 * `packages/compute/test/corpus.test.ts`.
 */
import { gunzipSync } from 'node:zlib';

/** The text of an input file. */
export function decodeInput(bytes: Uint8Array): string {
  const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const encoding =
    data[0] === 0xff && data[1] === 0xfe
      ? 'utf-16le'
      : data[0] === 0xfe && data[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(data);
}
