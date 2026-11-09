/**
 * @kgdiff/layout: stable, deterministic, label-aware layout for graph diffs.
 *
 * Both versions are drawn on ONE set of coordinates (the union layout), so
 * nothing jumps when switching between before / after / overlay / replay.
 * See docs/algorithms.md §Layout for the algorithm and quality bars.
 *
 * Signatures are the package contract; bodies live in the modules imported below.
 */
import type { DiffResult, Point, Rect, UnionId } from '@kgdiff/core';
import { extend } from './extend.js';
import { fromJSON, toJSON } from './json.js';
import { computeLayout } from './layout.js';
import { labelWidth } from './text-metrics.js';

export type LayoutStrategy = 'union' | 'anchored';
export type LayoutScope = 'all' | 'changes';

export interface LayoutOptions {
  /**
   * - `union`: lay out the union graph so neither version is favoured (default when no node is pinned).
   * - `anchored`: keep existing positions (pins, or `position` on before-version nodes) fixed and
   *   place only the remaining nodes (default when at least one position is known).
   */
  readonly strategy?: LayoutStrategy;
  /**
   * - `all`: every union node gets a position.
   * - `changes`: only changed nodes, the endpoints of changed edges and `contextHops` of unchanged
   *   context around changed nodes, not expanded through hubs (see `hubDegree`). Default when the
   *   union has more than `largeGraphThreshold` nodes. Hidden neighbours are counted in `hidden`.
   */
  readonly scope?: LayoutScope;
  /** Context hops kept around changes when `scope` is `changes`. Default 1. */
  readonly contextHops?: number;
  /**
   * Scope `changes`: context is never expanded FROM a node whose degree (max over both
   * versions) exceeds this, so one changed hub (a class with thousands of instances) does not pull
   * its whole neighbourhood into the layout. The hub itself stays in scope when it is a seed or
   * within reach; neighbours that could only enter through it are counted in `hidden`. Changed
   * nodes are always in scope. Default 40; `Infinity` disables the rule.
   */
  readonly hubDegree?: number;
  /** Default 3000 nodes. */
  readonly largeGraphThreshold?: number;
  /** PRNG seed. Same seed + same input → identical positions. Default 1. */
  readonly seed?: number;
  /** Simulation ticks. Default: chosen from graph size (docs/algorithms.md). */
  readonly iterations?: number;
  /** Target edge length in world units. Default 56. */
  readonly linkDistance?: number;
  /** Reserve room for labels so they do not overlap. Default true. */
  readonly labelAware?: boolean;
  /** Font size used to estimate label boxes (world units at zoom 1). Default 12. */
  readonly fontSize?: number;
  /** Explicit positions; they win over `position` found on graph nodes. */
  readonly pinned?: ReadonlyMap<UnionId, Point>;
  /** Gap between packed connected components. Default 96. */
  readonly componentGap?: number;
}

export interface LayoutComponent {
  readonly nodes: readonly UnionId[];
  readonly bounds: Rect;
}

export interface LayoutResult {
  /** Positions of every node in scope (world units, y down). */
  readonly positions: ReadonlyMap<UnionId, Point>;
  /** Radius of every node in scope (`nodeRadius` of its max degree across versions). */
  readonly radii: ReadonlyMap<UnionId, number>;
  /** Bounds of all nodes in scope, including estimated label boxes. */
  readonly bounds: Rect;
  readonly scope: LayoutScope;
  /** For scope `changes`: per visible node, number of neighbours left out of the layout. */
  readonly hidden: ReadonlyMap<UnionId, number>;
  /** Connected components after packing, largest first. */
  readonly components: readonly LayoutComponent[];
  readonly stats: {
    readonly strategy: LayoutStrategy;
    readonly iterations: number;
    readonly nodes: number;
    /** Wall-clock time. The only non-deterministic field; never serialized. */
    readonly ms: number;
  };
  /**
   * The layout engine generation that computed the positions, as a version 2 document names it
   * (`layoutFromJSON`), e.g. `"kgdiff-layout/1"`. Absent for layouts read from version 1 and for
   * the ones this package computes (`layoutDiff`, and `extendLayout` once it places a node).
   */
  readonly generator?: string;
}

/**
 * A layout document, as `layoutFromJSON` reads it and `layoutToJSON` writes it: version 1, for
 * this package's layouts, or version 2, written by kgdiff's Rust layout engine.
 */
export type LayoutJSON = LayoutJSONV1 | LayoutJSONV2;

/** Deterministic JSON transport (no timing information), version 1: this package's layouts. */
export interface LayoutJSONV1 {
  readonly format: 'kgdiff.layout';
  readonly version: 1;
  readonly strategy: LayoutStrategy;
  readonly scope: LayoutScope;
  readonly iterations: number;
  /** Coordinates rounded to 0.01. */
  readonly positions: Readonly<Record<UnionId, readonly [number, number]>>;
  readonly radii: Readonly<Record<UnionId, number>>;
  readonly hidden: Readonly<Record<UnionId, number>>;
  readonly bounds: Rect;
  readonly components: readonly LayoutComponent[];
}

/**
 * Version 2 of the layout document: version 1's members plus `generator`. kgdiff's Rust layout
 * engine (RFC 0002, phase 4) writes it; its positions differ from this package's for the same
 * input. Positions from either version are valid pins (`pinned`, `extendLayout`).
 */
export interface LayoutJSONV2 extends Omit<LayoutJSONV1, 'version'> {
  readonly version: 2;
  /**
   * The layout engine generation that computed the positions, e.g. `"kgdiff-layout/1"`: it
   * changes whenever an algorithm change moves positions for the same input, so that caches can
   * tell layouts apart. A non-empty string.
   */
  readonly generator: string;
}

/**
 * Compute the shared layout for a diff. Pure and deterministic: same diff + same options →
 * identical `layoutToJSON` output, in Node and in every browser.
 *
 * Steps (docs/algorithms.md §12): select the scope (`changes` above `largeGraphThreshold`
 * nodes), pick the strategy (`anchored` when any position is known), lay out every connected
 * component with a seeded force simulation (BFS phyllotaxis start, degree-aware links, many-body,
 * label-aware rectangle collision, weak merge / split springs), pack components to ~16:10
 * (isolated nodes in a compact grid last), center at the origin (union only) and round to 0.01.
 *
 * - The graph laid out has one link per node pair connected in either version (retargeted and
 *   carried edges contribute their before form too), so neither version is favoured.
 * - Scope `changes` keeps changed nodes, both endpoints of changed edges (either version) and
 *   the nodes within `contextHops` of a changed node, never expanding from hubs (degree >
 *   `hubDegree`); `hidden` only lists visible nodes with ≥ 1 hidden neighbour.
 * - Known positions (`pinned`, then the before node's `position`, then the after node's) are kept
 *   exactly (unrounded) in `anchored` mode; `union` ignores them. Nothing is centered when
 *   anchored, and components without any known node are packed beside the anchored region.
 * - Label boxes: centered below the node (`r + 5` below its center), `estimateLabelWidth` wide
 *   (capped at 32 em), one line of 1.25 em, plus the struck old name for renamed nodes. Without
 *   `labelAware` only node circles collide, but bounds still include the labels.
 * - Label-aware extras beyond the spec values (docs in `forces/params.ts`): many-body strength
 *   scaled by `(linkDistance / 56)²` and, for long labels, by their box area; links of hubs
 *   crowded with labelled neighbours relax; a weak size-dependent pull keeps components compact;
 *   merge sources / split targets left far from their partner are docked next to it.
 *
 * Ticks per simulation (one per connected component, or the window around new nodes): the spec
 * formula up to 2000 nodes, then `max(30, 120 · 2000 / N)` so large components stay within
 * budget (`iterations` overrides both; `stats.iterations` reports the largest simulation's).
 *
 * Complexity: O(I · N log N) for I iterations (Barnes–Hut charge, quadtree collision).
 * Budget: 2k nodes < 800 ms (measured ~0.6–0.7 s on an M-class laptop; 5k ≈ 1 s, 10k ≈ 1.6 s).
 *
 * @throws KgdiffError `invalid-input` for invalid options (negative distances, non-integer
 *   iterations, non-finite pins…).
 */
export function layoutDiff(diff: DiffResult, options?: LayoutOptions): LayoutResult {
  return computeLayout(diff, options, nodeRadius);
}

/**
 * Add `nodes` (currently outside the layout) next to their placed neighbours without moving any
 * node already placed. Used when the user expands a collapsed group in changes-only views.
 *
 * Already placed ids are ignored (returns `layout` itself when nothing is new). New nodes with no
 * path to a placed node are laid out on their own and packed beside the existing bounds. `hidden`
 * is recounted for scope `changes`; `stats.strategy` / `stats.iterations` are kept from `layout`.
 *
 * @throws KgdiffError `invalid-input` when an id is not a node of `diff`.
 */
export function extendLayout(
  diff: DiffResult,
  layout: LayoutResult,
  nodes: readonly UnionId[],
  options?: LayoutOptions,
): LayoutResult {
  return extend(diff, layout, nodes, options, nodeRadius);
}

/** Node radius in world units from degree: `clamp(4 + 2.2·√degree, 4, 14)`. Shared by every renderer. */
export function nodeRadius(degree: number): number {
  return Math.min(14, Math.max(4, 4 + 2.2 * Math.sqrt(Math.max(0, degree))));
}

/**
 * Deterministic label width estimate (no DOM): CJK/full-width = 1em, Latin ≈ 0.56em, digits 0.6em.
 *
 * Sum of per-code-point advances × `fontSize`: CJK / full-width / emoji 1.0em, digits 0.6em,
 * uppercase 0.68em, space 0.3em, other characters 0.56em; combining marks, joiners and variation
 * selectors 0em; a regional-indicator pair (flag) 1em. O(length).
 */
export function estimateLabelWidth(text: string, fontSize: number): number {
  return labelWidth(text, fontSize);
}

/**
 * Deterministic JSON form: keys sorted by id, coordinates and radii rounded to 0.01, no timing.
 * Version 1 for the layouts this package computes; version 2 with the `generator` for a layout
 * that has one (read from version 2, and not extended since), as kgdiff's Rust layout engine
 * writes it. `layoutToJSON(layoutFromJSON(json))` reproduces `json` of either version.
 */
export function layoutToJSON(layout: LayoutResult): LayoutJSON {
  return toJSON(layout);
}

/**
 * Rebuild a `LayoutResult` from a layout document (`stats.ms` is 0): version 1 (`layoutToJSON`
 * output) or version 2, whose `generator` becomes the result's.
 *
 * @throws KgdiffError `invalid-input` for malformed input, `unsupported-version` for a version
 *   other than 1 and 2.
 */
export function layoutFromJSON(json: LayoutJSON): LayoutResult {
  return fromJSON(json);
}
