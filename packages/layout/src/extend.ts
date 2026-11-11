/**
 * `extendLayout`: add nodes to an existing layout without moving anything already placed.
 */
import { type DiffResult, KgdiffError, type Point, type UnionId } from '@kgdiff/core';
import { type EngineContext, placeAnchored } from './engine.js';
import { buildLayoutGraph } from './graph.js';
import type { LayoutOptions, LayoutResult } from './index.js';
import { resolveLayoutOptions } from './options.js';
import { assemble, now } from './result.js';
import { round2 } from './round.js';
import { countHidden } from './scope.js';
import { buildUnionGraph } from './union.js';

export function extend(
  diff: DiffResult,
  layout: LayoutResult,
  nodes: readonly UnionId[],
  options: LayoutOptions | undefined,
  nodeRadius: (degree: number) => number,
): LayoutResult {
  const started = now();
  const opts = resolveLayoutOptions(options);
  const union = buildUnionGraph(diff);

  const added = new Set<UnionId>();
  for (const id of nodes) {
    if (!union.indexOf.has(id)) {
      throw new KgdiffError('invalid-input', `extendLayout: node "${id}" is not in the diff`, {
        node: id,
      });
    }
    if (!layout.positions.has(id)) added.add(id);
  }
  if (added.size === 0) return layout;

  const visible = new Uint8Array(union.nodes.length);
  for (const id of layout.positions.keys()) {
    const u = union.indexOf.get(id);
    if (u !== undefined) visible[u] = 1;
  }
  for (const id of added) visible[union.indexOf.get(id)!] = 1;
  const graph = buildLayoutGraph(union, visible, { fontSize: opts.fontSize, nodeRadius });

  const fixed = new Uint8Array(graph.n);
  const x = new Float64Array(graph.n);
  const y = new Float64Array(graph.n);
  for (let i = 0; i < graph.n; i++) {
    const p = layout.positions.get(graph.nodes[i]!.id);
    if (p === undefined) continue;
    fixed[i] = 1;
    x[i] = p.x;
    y[i] = p.y;
  }
  const ctx: EngineContext = { graph, options: opts, x, y };
  placeAnchored(ctx, fixed);

  const positions = new Map<UnionId, Point>(layout.positions);
  const radii = new Map<UnionId, number>(layout.radii);
  for (const id of added) {
    const i = graph.indexOf.get(id)!;
    positions.set(id, Object.freeze({ x: round2(x[i]!), y: round2(y[i]!) }));
    radii.set(id, graph.radius[i]!);
  }

  return assemble({
    graph,
    positions,
    radii,
    hidden: layout.scope === 'changes' ? countHidden(union, visible) : layout.hidden,
    scope: layout.scope,
    strategy: layout.stats.strategy,
    iterations: layout.stats.iterations,
    started,
  });
}
