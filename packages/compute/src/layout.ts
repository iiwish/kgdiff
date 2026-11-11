/**
 * `@kgdiff/compute/layout`: the layout alone, on the small `layout.wasm`, without the diff engine
 * or the parsers. It takes a `DiffResult` (or a normalized `KGraph`) and gives a `LayoutResult`
 * of `@kgdiff/layout`, positions identical to the ones of the kgdiff CLI.
 *
 * ```ts
 * import { init, extendLayoutSync } from '@kgdiff/compute/layout';
 * await init(); // once; idempotent
 * const grown = extendLayoutSync(diff, layout, ['new-node']);
 * ```
 */
import type { DiffResult, KGraph, UnionId } from '@kgdiff/core';
import type { LayoutOptions, LayoutResult } from '@kgdiff/layout';
import type * as Glue from '../wasm/layout.js';
import { decode, Streams } from './layout-tables.js';
import { type InitSource, Module } from './loader.js';

export type { InitSource } from './loader.js';

/** The engine generation of the layouts this package computes, as `layoutToJSON` writes it. */
const GENERATOR = 'kgdiff-layout/1';

/** Operations of `layoutRun`, as `crates/kgdiff-wasm/src/tables.rs` numbers them. */
const LAYOUT_DIFF = 0;
const EXTEND = 1;
const LAYOUT_GRAPH = 2;
const LAYOUT_DIFF_ON = 3;
const LAYOUT_AFTER = 4;

export const layoutModule = new Module<typeof Glue>(
  'layout',
  () => import('../wasm/layout.js'),
  () => new URL('../wasm/layout.wasm', import.meta.url),
);

/**
 * Loads and compiles `layout.wasm`. Call it once before any other function; later calls return at
 * once. In Node the module is read from this package's `wasm/` directory; elsewhere it is fetched
 * from there, relative to this file, unless `source` says otherwise (an HTML report passes the
 * bytes it inlines).
 */
export function init(source?: InitSource): Promise<void> {
  return layoutModule.init(source);
}

function run(
  op: number,
  streams: Streams,
  ids: readonly UnionId[],
  extra: readonly UnionId[],
): LayoutResult | undefined {
  const start = performance.now();
  const data = layoutModule.call((e) =>
    e.layoutRun(
      op,
      streams.text,
      Uint32Array.from(streams.lengths),
      Uint32Array.from(streams.ints),
      Float64Array.from(streams.floats),
    ),
  );
  if (data.length === 0) return undefined;
  return decode(data, ids, extra, GENERATOR, performance.now() - start);
}

/**
 * `layoutDiff` of `@kgdiff/layout`, on the Rust engine.
 *
 * @throws KgdiffError `invalid-input` for invalid options.
 */
export function layoutDiffSync(diff: DiffResult, options?: LayoutOptions): LayoutResult {
  const streams = new Streams();
  const ids = streams.diff(diff);
  streams.options(options);
  return run(LAYOUT_DIFF, streams, ids, []) as LayoutResult;
}

/**
 * `extendLayout` of `@kgdiff/layout`, on the Rust engine: adds `nodes` without moving any node
 * already placed. Returns `layout` itself when no id is new.
 *
 * @throws KgdiffError `invalid-input` when an id is not a node of the diff, or for invalid options.
 */
export function extendLayoutSync(
  diff: DiffResult,
  layout: LayoutResult,
  nodes: readonly UnionId[],
  options?: LayoutOptions,
): LayoutResult {
  const streams = new Streams();
  const ids = streams.diff(diff);
  const extra = streams.layout(layout);
  streams.nodes(nodes);
  streams.options(options);
  return run(EXTEND, streams, ids, extra) ?? layout;
}

/**
 * The layout of one normalized graph: the positions `layoutDiffSync` gives its diff with itself,
 * with every node in scope (`layout_graph` of the `kgdiff-layout` crate).
 *
 * @throws KgdiffError `invalid-input` for scope `changes`, or for invalid options.
 */
export function layoutGraphSync(graph: KGraph, options?: LayoutOptions): LayoutResult {
  const streams = new Streams();
  const ids = streams.graph(graph);
  streams.options(options);
  return run(LAYOUT_GRAPH, streams, ids, []) as LayoutResult;
}

/**
 * The layout of a diff on the map of its before version: every node `previous` places stays
 * exactly where it is, through renames and changed ids (`layout_diff_on` of `kgdiff-layout`).
 *
 * @throws KgdiffError `invalid-input` for scope `changes`, strategy `union` or invalid options.
 */
export function layoutDiffOnSync(
  diff: DiffResult,
  previous: LayoutResult,
  options?: LayoutOptions,
): LayoutResult {
  const streams = new Streams();
  const ids = streams.diff(diff);
  streams.layout(previous);
  streams.options(options);
  return run(LAYOUT_DIFF_ON, streams, ids, []) as LayoutResult;
}

/**
 * The layout of the after version of a diff on the map of the diff, keyed by the ids of the after
 * version (`layout_after` of `kgdiff-layout`).
 *
 * @throws KgdiffError `invalid-input` when `layout` does not place a node of the after version,
 *   for scope `changes`, strategy `union` or invalid options.
 */
export function layoutAfterSync(
  diff: DiffResult,
  layout: LayoutResult,
  options?: LayoutOptions,
): LayoutResult {
  const streams = new Streams();
  streams.diff(diff);
  const ids = streams.graph(diff.after);
  streams.layout(layout);
  streams.options(options);
  return run(LAYOUT_AFTER, streams, ids, []) as LayoutResult;
}

/** `estimateLabelWidth` of `@kgdiff/layout`, on the Rust engine. */
export function estimateLabelWidthSync(text: string, fontSize: number): number {
  return layoutModule.call((e) => e.estimateLabelWidth(text, fontSize));
}

/** `nodeRadius` of `@kgdiff/layout`, on the Rust engine. */
export function nodeRadiusSync(degree: number): number {
  return layoutModule.call((e) => e.nodeRadius(degree));
}
