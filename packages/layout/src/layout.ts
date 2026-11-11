/**
 * `layoutDiff`: scope → layout graph → strategy → simulation → packing → result.
 */
import type { DiffResult, Point, UnionId } from '@kgdiff/core';
import { type EngineContext, placeAnchored, placeFree } from './engine.js';
import { buildLayoutGraph, type LayoutGraph } from './graph.js';
import type { LayoutOptions, LayoutResult } from './index.js';
import { type ResolvedLayoutOptions, resolveLayoutOptions } from './options.js';
import { assemble, now } from './result.js';
import { round2 } from './round.js';
import { selectScope } from './scope.js';
import { buildUnionGraph } from './union.js';

const finitePoint = (p: Point | undefined): p is Point =>
  p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * Known positions, by priority: explicit pins, then the before version's `position` (the mental
 * map the reviewer already has), then the after version's.
 */
function knownPositions(
  graph: LayoutGraph,
  options: ResolvedLayoutOptions,
): { fixed: Uint8Array; x: Float64Array; y: Float64Array; count: number } {
  const fixed = new Uint8Array(graph.n);
  const x = new Float64Array(graph.n);
  const y = new Float64Array(graph.n);
  let count = 0;
  for (let i = 0; i < graph.n; i++) {
    const node = graph.nodes[i]!;
    const candidates = [options.pinned.get(node.id), node.before?.position, node.after?.position];
    const p = candidates.find(finitePoint);
    if (p === undefined) continue;
    fixed[i] = 1;
    x[i] = p.x;
    y[i] = p.y;
    count++;
  }
  return { fixed, x, y, count };
}

export function computeLayout(
  diff: DiffResult,
  options: LayoutOptions | undefined,
  nodeRadius: (degree: number) => number,
): LayoutResult {
  const started = now();
  const opts = resolveLayoutOptions(options);
  const union = buildUnionGraph(diff);
  const scope = opts.scope ?? (union.nodes.length > opts.largeGraphThreshold ? 'changes' : 'all');
  const selection = selectScope(union, scope, opts.contextHops, opts.hubDegree);
  const graph = buildLayoutGraph(union, selection.visible, { fontSize: opts.fontSize, nodeRadius });

  const known = knownPositions(graph, opts);
  const strategy = opts.strategy ?? (known.count > 0 ? 'anchored' : 'union');
  const anchored = strategy === 'anchored' && known.count > 0;
  const ctx: EngineContext = {
    graph,
    options: opts,
    x: anchored ? known.x : new Float64Array(graph.n),
    y: anchored ? known.y : new Float64Array(graph.n),
  };
  const iterations = anchored ? placeAnchored(ctx, known.fixed) : placeFree(ctx);

  const positions = new Map<UnionId, Point>();
  const radii = new Map<UnionId, number>();
  for (let i = 0; i < graph.n; i++) {
    const id = graph.nodes[i]!.id;
    // Known positions are preserved exactly; computed ones are rounded to 0.01.
    const exact = anchored && known.fixed[i] === 1;
    const x = exact ? ctx.x[i]! : round2(ctx.x[i]!);
    const y = exact ? ctx.y[i]! : round2(ctx.y[i]!);
    positions.set(id, Object.freeze({ x, y }));
    radii.set(id, graph.radius[i]!);
  }

  return assemble({
    graph,
    positions,
    radii,
    hidden: selection.hidden,
    scope,
    strategy,
    iterations,
    started,
  });
}
