/**
 * How the corpus reads a case's inputs, as `kgdiff` does (README, "Library outputs", step 1):
 * gunzip when gzip-compressed, UTF-16 by byte order mark, else strict UTF-8; an empty or
 * whitespace-only input with `allowEmpty` is the empty graph; then `parseGraph` with the case's
 * format, the file name without `.gz` and the RDF languages. Only inputs that parse are read
 * here: the corpus records the CLI's errors through its CLI runs.
 */
import { gunzipSync } from 'node:zlib';
import type { FormatId, ParseResult } from '@kgdiff/formats';
import { parseGraph } from '../packages/formats/src/sync.js';

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

export interface InputOptions {
  readonly format: FormatId | 'auto';
  /** The file name without directories and without `.gz`. */
  readonly filename: string;
  readonly languages?: readonly string[];
  readonly allowEmpty: boolean;
}

/** Parses one input exactly as `kgdiff <before> <after>` reads it. */
export function parseInput(bytes: Uint8Array, options: InputOptions): ParseResult {
  const text = decodeInput(bytes);
  const parseOptions = {
    format: options.format,
    filename: options.filename,
    ...(options.languages ? { rdf: { languages: options.languages } } : {}),
  };
  if (options.allowEmpty && text.trim() === '') {
    // --allow-empty: the empty graph, without asking a parser to guess the format of nothing.
    return parseGraph('{"nodes":[],"edges":[]}', { ...parseOptions, format: 'json' });
  }
  return parseGraph(text, parseOptions);
}
