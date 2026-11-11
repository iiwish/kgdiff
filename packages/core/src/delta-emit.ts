/**
 * Delta emission in canonical op order (docs/delta-format.md, docs/algorithms.md §8).
 */
import { tripleKey } from './canonical.js';
import { fieldValuesEqual, NODE_FIELDS } from './delta.js';
import { edgeToJSON, hashGraph, nodeToJSON } from './graph-json.js';
import type { EdgeRecord, NodeRecord } from './model.js';
import type { PipelineContext } from './pipeline.js';
import type {
  Delta,
  DeltaOp,
  EdgeIdentity,
  EdgeJSON,
  GraphRef,
  Id,
  KGEdge,
  KGNode,
  KGraph,
  NodeField,
  NodeFieldValue,
  UnionId,
} from './types.js';
import { compareStrings } from './util.js';

// ─── Emission ────────────────────────────────────────────────────────────────

function graphRef(graph: KGraph): GraphRef {
  const { name, version } = graph.meta;
  return {
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof version === 'string' ? { version } : {}),
    hash: hashGraph(graph),
    nodes: graph.nodes.size,
    edges: graph.edges.size,
  };
}

/** Identity of an edge snapshot: its id (`id` identity) or its structural key. */
function identityKey(edge: EdgeJSON, mode: EdgeIdentity): string {
  return mode === 'id' && edge.id !== undefined
    ? edge.id
    : tripleKey(edge.source, edge.predicate ?? '', edge.target);
}

/** Minimal locator of an edge for in-place updates: identity fields only. */
function edgeLocator(edge: KGEdge, mode: EdgeIdentity): EdgeJSON {
  const { source, target, predicate } = edge;
  const locator: { -readonly [K in keyof EdgeJSON]: EdgeJSON[K] } =
    mode === 'id' && edge.id !== undefined ? { id: edge.id, source, target } : { source, target };
  if (predicate !== '') locator.predicate = predicate;
  return locator;
}

function nodeFieldValue(node: KGNode, field: NodeField): NodeFieldValue {
  return node[field];
}

/**
 * Sequences renames so that every `to` is free when its rekey runs: chains run back to front,
 * cycles are broken through a temporary id. Without conflicts (always the case unless ids are
 * ignored for matching) the order is simply by `from`. Occupancy carries over between runs.
 */
class RenamePlanner {
  readonly plan: [Id, Id][] = [];
  private readonly vacated = new Set<Id>();
  private readonly filled = new Set<Id>();

  constructor(
    private readonly occupiedAtStart: (id: Id) => boolean,
    private readonly reserved: (id: Id) => boolean,
  ) {}

  occupied(id: Id): boolean {
    return this.filled.has(id) || (this.occupiedAtStart(id) && !this.vacated.has(id));
  }

  /** A fresh temporary id derived from `id`. */
  temporary(id: Id): Id {
    let temp = `${id}@tmp`;
    while (this.occupied(temp) || this.reserved(temp)) temp += '@tmp';
    return temp;
  }

  move(from: Id, to: Id): void {
    this.plan.push([from, to]);
    this.vacated.add(from);
    this.filled.delete(from);
    this.filled.add(to);
  }

  /** Plans a set of renames `from → to`. */
  run(renames: ReadonlyMap<Id, Id>): void {
    /** Renames blocked on the node currently holding their target, keyed by that holder. */
    const waiting = new Map<Id, [Id, Id]>();
    const queue: [Id, Id][] = [];
    for (const from of [...renames.keys()].sort()) {
      const to = renames.get(from) as Id;
      if (this.occupied(to)) waiting.set(to, [from, to]);
      else queue.push([from, to]);
    }
    const release = (holder: Id): void => {
      const next = waiting.get(holder);
      if (next) {
        waiting.delete(holder);
        queue.push(next);
      }
    };
    for (;;) {
      while (queue.length) {
        const [from, to] = queue.shift() as [Id, Id];
        this.move(from, to);
        release(from);
      }
      if (waiting.size === 0) return;
      // Only cycles remain: park the smallest member on a temporary id to free its slot.
      let pick: [Id, Id] | undefined;
      for (const entry of waiting.values()) if (!pick || entry[0] < pick[0]) pick = entry;
      const [from, to] = pick as [Id, Id];
      const temp = this.temporary(from);
      this.move(from, temp);
      waiting.set(to, [temp, to]);
      release(from);
    }
  }
}

/** One-shot planning of a set of renames (see `RenamePlanner`). */
export function planRenames(
  renames: ReadonlyMap<Id, Id>,
  occupiedAtStart: (id: Id) => boolean,
  reserved: (id: Id) => boolean,
): [Id, Id][] {
  const planner = new RenamePlanner(occupiedAtStart, reserved);
  planner.run(renames);
  return planner.plan;
}

interface Emitted {
  readonly op: DeltaOp;
  readonly hunk: string | undefined;
}

/**
 * Builds the canonical delta of a classified union. Returns, per op, the hunk of the union
 * element the op implements.
 */
export function buildDelta(
  ctx: PipelineContext,
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
): { readonly delta: Delta; readonly opHunks: readonly (string | undefined)[] } {
  const mode = ctx.options.edgeIdentity;
  const ub = ctx.unionOfBefore;
  const nodeByUnion = new Map<UnionId, NodeRecord>();
  for (const n of nodes) nodeByUnion.set(n.id, n);

  // 1. node.rekey — in two stages. Renames of nodes that belong to no hunk (id-only changes
  // under strategy `similarity`) come first, as a preamble that never depends on a hunk: a
  // hunk-owned node in their way is parked on a temporary id (also part of the preamble), and
  // its hunk later renames it from there.
  const renamedTo = new Set(ctx.renamed.values());
  const planner = new RenamePlanner(
    (id) => ctx.before.nodes.has(id),
    (id) => ctx.after.nodes.has(id) || renamedTo.has(id) || ctx.before.nodes.has(id),
  );
  const preamble = new Map<Id, Id>();
  const owned = new Map<Id, Id>();
  for (const [from, to] of ctx.renamed) {
    (nodeByUnion.get(to)?.hunk === undefined ? preamble : owned).set(from, to);
  }
  for (const to of [...preamble.values()].sort()) {
    const final = owned.get(to); // the hunk-owned node currently holding `to`, if any
    if (final === undefined) continue;
    const temp = planner.temporary(to);
    planner.move(to, temp);
    owned.delete(to);
    owned.set(temp, final);
  }
  planner.run(preamble);
  const preambleLength = planner.plan.length;
  planner.run(owned);
  const ops: Emitted[] = [];
  const unionOfRenamed = new Map<Id, UnionId>();
  planner.plan.forEach(([from, to], i) => {
    const origin = unionOfRenamed.get(from) ?? ub(from);
    unionOfRenamed.set(to, origin);
    const hunk = i < preambleLength ? undefined : nodeByUnion.get(origin)?.hunk;
    ops.push({ op: { op: 'node.rekey', from, to }, hunk });
  });

  const replaced = (e: EdgeRecord): boolean => e.status === 'modified' && !e.inPlace;
  const sortEdges = (
    list: { op: DeltaOp; edge: EdgeJSON; hunk: string | undefined }[],
  ): Emitted[] =>
    list
      .map((x) => ({ ...x, key: `${identityKey(x.edge, mode)}\u0000${JSON.stringify(x.edge)}` }))
      .sort((a, b) => compareStrings(a.key, b.key))
      .map(({ op, hunk }) => ({ op, hunk }));

  // 2. edge.remove
  const removals: { op: DeltaOp; edge: EdgeJSON; hunk: string | undefined }[] = [];
  for (const e of edges) {
    if (!e.before || !(e.status === 'removed' || replaced(e))) continue;
    const edge = edgeToJSON(e.before, ub(e.before.source), ub(e.before.target));
    removals.push({ op: { op: 'edge.remove', edge }, edge, hunk: e.hunk });
  }
  // Appended one at a time: spreading 10^5+ elements into a call overflows the stack.
  for (const x of sortEdges(removals)) ops.push(x);

  // 3. node.remove (records are sorted by union id)
  for (const n of nodes) {
    if (n.status === 'removed' && n.before) {
      ops.push({ op: { op: 'node.remove', node: nodeToJSON(n.before, n.id) }, hunk: n.hunk });
    }
  }
  // 4. node.set, 5. node.attr
  const attrOps: Emitted[] = [];
  for (const n of nodes) {
    if (n.status !== 'modified' || !n.before || !n.after) continue;
    for (const field of NODE_FIELDS) {
      const from = nodeFieldValue(n.before, field);
      const to = nodeFieldValue(n.after, field);
      if (!fieldValuesEqual(from, to)) {
        ops.push({ op: { op: 'node.set', id: n.id, field, from, to }, hunk: n.hunk });
      }
    }
    for (const f of n.facets) {
      if (f.kind !== 'attrs') continue;
      for (const c of f.changes) {
        const op: DeltaOp = {
          op: 'node.attr',
          id: n.id,
          key: c.key,
          ...(c.before === undefined ? {} : { from: c.before }),
          ...(c.after === undefined ? {} : { to: c.after }),
        };
        attrOps.push({ op, hunk: n.hunk });
      }
    }
  }
  for (const x of attrOps) ops.push(x);
  // 6. node.add
  for (const n of nodes) {
    if (n.status === 'added' && n.after)
      ops.push({ op: { op: 'node.add', node: nodeToJSON(n.after) }, hunk: n.hunk });
  }
  // 7. edge.add
  const additions: { op: DeltaOp; edge: EdgeJSON; hunk: string | undefined }[] = [];
  for (const e of edges) {
    if (!e.after || !(e.status === 'added' || replaced(e))) continue;
    const edge = edgeToJSON(e.after);
    additions.push({ op: { op: 'edge.add', edge }, edge, hunk: e.hunk });
  }
  for (const x of sortEdges(additions)) ops.push(x);
  // 8. edge.set, then edge.attr
  const inPlace = edges
    .filter((e) => e.status === 'modified' && e.inPlace && e.before && e.after)
    .map((e) => ({ e, locator: edgeLocator(e.after as KGEdge, mode) }))
    .map((x) => ({ ...x, key: identityKey(x.locator, mode) }))
    .sort((a, b) => compareStrings(a.key, b.key));
  for (const { e, locator } of inPlace) {
    const b = e.before as KGEdge;
    const a = e.after as KGEdge;
    if (b.label !== a.label) {
      ops.push({
        op: { op: 'edge.set', edge: locator, field: 'label', from: b.label, to: a.label },
        hunk: e.hunk,
      });
    }
  }
  for (const { e, locator } of inPlace) {
    for (const f of e.facets) {
      if (f.kind !== 'attrs') continue;
      for (const c of f.changes) {
        const op: DeltaOp = {
          op: 'edge.attr',
          edge: locator,
          key: c.key,
          ...(c.before === undefined ? {} : { from: c.before }),
          ...(c.after === undefined ? {} : { to: c.after }),
        };
        ops.push({ op, hunk: e.hunk });
      }
    }
  }

  return {
    delta: {
      format: 'kgdiff.delta',
      version: 1,
      edgeIdentity: mode,
      base: graphRef(ctx.before),
      target: graphRef(ctx.after),
      ops: ops.map((x) => x.op),
    },
    opHunks: ops.map((x) => x.hunk),
  };
}
