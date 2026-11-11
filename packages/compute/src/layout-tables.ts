/**
 * The typed arrays `layout.wasm` reads and writes (`crates/kgdiff-wasm/src/tables.rs`): a
 * `DiffResult` or a `KGraph` as tables of what the layout needs, and a layout as numbers.
 */
import type { DiffResult, Id, KGNode, KGraph, Point, UnionId } from '@kgdiff/core';
import type { LayoutOptions, LayoutResult } from '@kgdiff/layout';

const NONE = 0xffffffff;
const LABEL_BEFORE = 1;
const BEFORE_ID = 2;
const AFTER_ID = 4;
const POSITION = 8;
const CHANGED = 16;

const OPTIONS = [
  'strategy',
  'scope',
  'contextHops',
  'hubDegree',
  'largeGraphThreshold',
  'seed',
  'iterations',
  'linkDistance',
  'labelAware',
  'fontSize',
  'componentGap',
] as const;

/** Sorts as `JsStr` does: by UTF-16 code units. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finite(node: KGNode | undefined): Point | undefined {
  const p = node?.position;
  return p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : undefined;
}

export class Streams {
  private readonly parts: string[] = [];
  readonly lengths: number[] = [];
  readonly ints: number[] = [];
  readonly floats: number[] = [];

  get text(): string {
    return this.parts.join('');
  }

  string(text: string): void {
    this.parts.push(text);
    this.lengths.push(text.length);
  }

  /** The tables of a diff, the ids of their nodes, in the order of the table. */
  diff(diff: DiffResult): UnionId[] {
    const nodes = [...diff.nodes].sort((a, b) => compare(a.id, b.id));
    const index = new Map<UnionId, number>(nodes.map((node, i) => [node.id, i]));
    const at = (id: UnionId | undefined): number =>
      id === undefined ? NONE : (index.get(id) ?? NONE);
    this.ints.push(nodes.length);
    for (const node of nodes) {
      const rename = node.facets.find((f) => f.kind === 'rename');
      const position = finite(node.before) ?? finite(node.after);
      this.ints.push(
        (rename ? LABEL_BEFORE : 0) |
          (node.beforeId !== undefined ? BEFORE_ID : 0) |
          (node.afterId !== undefined ? AFTER_ID : 0) |
          (position ? POSITION : 0) |
          (node.status !== 'unchanged' ? CHANGED : 0),
        Math.max(node.degree.before, node.degree.after),
      );
      this.string(node.id);
      this.string(node.label);
      if (rename) this.string(rename.from);
      if (node.beforeId !== undefined) this.string(node.beforeId);
      if (node.afterId !== undefined) this.string(node.afterId);
      if (position) this.floats.push(position.x, position.y);
    }
    const edges = [...diff.edges].sort((a, b) => compare(a.id, b.id));
    this.ints.push(edges.length);
    for (const edge of edges) {
      const source = at(edge.source);
      const target = at(edge.target);
      this.ints.push(
        edge.status !== 'unchanged' ? 1 : 0,
        source,
        target,
        edge.sourceBefore === undefined ? source : at(edge.sourceBefore),
        edge.targetBefore === undefined ? target : at(edge.targetBefore),
      );
    }
    const partners: number[] = [];
    const pair = (mover: number, anchor: number): void => {
      if (mover !== NONE && anchor !== NONE) partners.push(mover, anchor);
    };
    nodes.forEach((node, i) => {
      for (const facet of node.facets) {
        if (facet.kind === 'mergedInto') pair(i, at(facet.target));
        else if (facet.kind === 'splitFrom') pair(i, at(facet.source));
        else if (facet.kind === 'mergeTarget') for (const s of facet.sources) pair(at(s), i);
        else if (facet.kind === 'splitInto') for (const t of facet.targets) pair(at(t), i);
      }
    });
    this.ints.push(partners.length / 2, ...partners);
    return nodes.map((node) => node.id);
  }

  /**
   * The tables of the diff of a normalized graph with itself: every node and edge unchanged and
   * under its own id. The corpus test checks them against `layoutGraphJSON`, which runs the diff.
   */
  graph(graph: KGraph): Id[] {
    const ids = [...graph.nodes.keys()].sort(compare);
    const index = new Map<Id, number>(ids.map((id, i) => [id, i]));
    const degree = (id: Id): number =>
      (graph.outgoing.get(id)?.length ?? 0) + (graph.incoming.get(id)?.length ?? 0);
    this.ints.push(ids.length);
    for (const id of ids) {
      const node = graph.nodes.get(id) as KGNode;
      const position = finite(node);
      this.ints.push(BEFORE_ID | AFTER_ID | (position ? POSITION : 0), degree(id));
      this.string(id);
      this.string(node.label);
      this.string(id);
      this.string(id);
      if (position) this.floats.push(position.x, position.y);
    }
    const keys = [...graph.edges.keys()].sort(compare);
    this.ints.push(keys.length);
    for (const key of keys) {
      const edge = graph.edges.get(key);
      if (edge === undefined) continue;
      const source = index.get(edge.source) ?? NONE;
      const target = index.get(edge.target) ?? NONE;
      this.ints.push(0, source, target, source, target);
    }
    this.ints.push(0);
    return ids;
  }

  /** What the functions taking a layout read of it; the ids of its positions. */
  layout(layout: LayoutResult): UnionId[] {
    const ids = [...layout.positions.keys()];
    this.ints.push(ids.length);
    for (const [id, p] of layout.positions) {
      this.string(id);
      this.floats.push(p.x, p.y);
    }
    this.ints.push(layout.radii.size);
    for (const [id, r] of layout.radii) {
      this.string(id);
      this.floats.push(r);
    }
    this.ints.push(layout.hidden.size);
    for (const [id, count] of layout.hidden) {
      this.string(id);
      this.ints.push(count);
    }
    this.ints.push(
      layout.scope === 'changes' ? 1 : 0,
      layout.stats.strategy === 'anchored' ? 1 : 0,
      layout.stats.iterations,
    );
    return ids;
  }

  nodes(ids: readonly UnionId[]): void {
    this.ints.push(ids.length);
    for (const id of ids) this.string(id);
  }

  private value(value: unknown): void {
    if (typeof value === 'number') {
      this.ints.push(0);
      this.floats.push(value);
    } else if (value === null) {
      this.ints.push(2);
    } else if (typeof value === 'boolean') {
      this.ints.push(value ? 3 : 4);
    } else {
      this.ints.push(1);
      this.string(String(value));
    }
  }

  options(options: LayoutOptions | undefined): void {
    const given = options as Record<string, unknown> | undefined;
    const present = OPTIONS.flatMap((name, i) => (given?.[name] === undefined ? [] : [i]));
    this.ints.push(present.length);
    for (const i of present) {
      this.ints.push(i);
      this.value(given?.[OPTIONS[i] as string]);
    }
    const pinned = options?.pinned;
    if (pinned === undefined) {
      this.ints.push(0);
      return;
    }
    this.ints.push(1, pinned.size);
    for (const [id, p] of pinned) {
      this.string(id);
      this.floats.push(p.x, p.y);
    }
  }
}

/** A layout from `layout.wasm`'s numbers: an id is `ids[i]`, or past them, `extra[i - ids.length]`. */
export function decode(
  data: Float64Array,
  ids: readonly UnionId[],
  extra: readonly UnionId[],
  generator: string,
  ms: number,
): LayoutResult {
  let at = 0;
  const next = (): number => data[at++] as number;
  const id = (): UnionId => {
    const i = next();
    return (i < ids.length ? ids[i] : extra[i - ids.length]) as UnionId;
  };
  const rect = () => {
    const [x, y, width, height] = [next(), next(), next(), next()];
    return { x, y, width, height };
  };
  const strategy = next() === 1 ? ('anchored' as const) : ('union' as const);
  const scope = next() === 1 ? ('changes' as const) : ('all' as const);
  const iterations = next();
  const nodes = next();
  const bounds = rect();
  const positions = new Map<UnionId, Point>();
  for (let n = next(); n > 0; n--) {
    const key = id();
    const [x, y] = [next(), next()];
    positions.set(key, { x, y });
  }
  const radii = new Map<UnionId, number>();
  for (let n = next(); n > 0; n--) {
    const key = id();
    radii.set(key, next());
  }
  const hidden = new Map<UnionId, number>();
  for (let n = next(); n > 0; n--) {
    const key = id();
    hidden.set(key, next());
  }
  const components = [];
  for (let n = next(); n > 0; n--) {
    const box = rect();
    const members: UnionId[] = [];
    for (let k = next(); k > 0; k--) members.push(id());
    components.push({ nodes: members, bounds: box });
  }
  return {
    positions,
    radii,
    bounds,
    scope,
    hidden,
    components,
    stats: { strategy, iterations, nodes, ms },
    generator,
  };
}
