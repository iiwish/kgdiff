/**
 * The TypeScript layout engine, synchronous, for the TypeScript corpus generator (`conformance/`)
 * until it moves to Rust (RFC 0002, phase 5). Not exported by the package, whose layouts run
 * kgdiff's layout engine through `@kgdiff/compute`. Deleted with the engine (`tests/read-path.ts`).
 */
import type { DiffResult, UnionId } from '@kgdiff/core';
import { extend } from './extend.js';
import { type LayoutOptions, type LayoutResult, nodeRadius } from './index.js';
import { computeLayout } from './layout.js';

/** `layoutDiff` of `@kgdiff/layout` up to 0.10, on the TypeScript engine. */
export function layoutDiff(diff: DiffResult, options?: LayoutOptions): LayoutResult {
  return computeLayout(diff, options, nodeRadius);
}

/** `extendLayout` of `@kgdiff/layout` up to 0.10, on the TypeScript engine. */
export function extendLayout(
  diff: DiffResult,
  layout: LayoutResult,
  nodes: readonly UnionId[],
  options?: LayoutOptions,
): LayoutResult {
  return extend(diff, layout, nodes, options, nodeRadius);
}
