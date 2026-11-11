/**
 * Small, dependency-free helpers shared by every module of the engine.
 */
import type { Id, KGraph } from './types.js';

/** Three-way comparison of strings by UTF-16 code units (the order of `Array#sort`). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted (UTF-16 code unit order), de-duplicated copy. Empty strings are dropped. */
export function sortedUnique(values: readonly string[]): string[] {
  if (values.length <= 1) {
    const only = values[0];
    return only === undefined || only === '' ? [] : [only];
  }
  const out = [...new Set(values)].filter((v) => v !== '');
  if (out.length > 1) out.sort();
  return out;
}

/** Element-wise equality of two string arrays. */
export function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The value stored under `key`, created with `create` on first use. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

/** Pushes `value` onto the array stored under `key`, creating it on first use. */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export const EMPTY: readonly never[] = Object.freeze([]);

/** Number of edge ends at a node (a self-loop counts twice); 0 for an absent id. */
export function degree(graph: KGraph, id: Id | undefined): number {
  if (id === undefined) return 0;
  return (graph.outgoing.get(id)?.length ?? 0) + (graph.incoming.get(id)?.length ?? 0);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
