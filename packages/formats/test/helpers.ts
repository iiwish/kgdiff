import { readFileSync } from 'node:fs';
import { KgdiffError } from '@kgdiff/core';
import { expect } from 'vitest';
import type { ParseOptions, ParseResult } from '../src/index.js';
import { parseGraph } from '../src/sync.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

/** Text of a fixture file in `test/fixtures`. */
export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/** Parses a fixture, passing its name as `filename` (format detection + meta.source). */
export function parseFixture(name: string, options: ParseOptions = {}): ParseResult {
  return parseGraph(fixture(name), { filename: name, ...options });
}

/** Runs `fn` and returns the `KgdiffError` it throws (fails the test otherwise). */
export function catchError(fn: () => unknown): KgdiffError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KgdiffError);
    return error as KgdiffError;
  }
  throw new Error('expected a KgdiffError, but nothing was thrown');
}

/** Recursively freezes a value, to prove parsers never mutate their inputs. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
