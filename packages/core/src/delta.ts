/**
 * The delta (docs/delta-format.md, docs/algorithms.md §8): emission in canonical op order,
 * strict / lenient application, and inversion.
 */
import {
  attrsEqual,
  attrValueEquals,
  canonicalJSON,
  emptyAttrMap,
  ownAttr,
  setAttr,
  tripleKey,
} from './canonical.js';
import { KgdiffError } from './errors.js';
import { edgeToJSON, hashGraph, nodeContentEquals, nodeToJSON } from './graph-json.js';
import type { EdgeRecord, NodeRecord, PipelineContext } from './model.js';
import { normalize } from './normalize.js';
import { resolveEdgeIdentity } from './options.js';
import { predicateLabel } from './text.js';
import type {
  ApplyOptions,
  Attrs,
  AttrValue,
  Delta,
  DeltaOp,
  EdgeIdentity,
  EdgeInput,
  EdgeJSON,
  GraphMeta,
  GraphRef,
  Id,
  KGEdge,
  KGNode,
  KGraph,
  NodeField,
  NodeFieldValue,
  NodeInput,
  NodeJSON,
  UnionId,
} from './types.js';
import {
  compareStrings,
  getOrCreate,
  isRecord,
  pushTo,
  sortedUnique,
  stringArraysEqual,
} from './util.js';

const NODE_FIELDS: readonly NodeField[] = [
  'label',
  'types',
  'aliases',
  'deprecated',
  'replaces',
  'replacedBy',
];

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

function fieldValuesEqual(a: NodeFieldValue | undefined, b: NodeFieldValue | undefined): boolean {
  if (typeof a === 'object' && typeof b === 'object') return stringArraysEqual(a, b);
  return a === b;
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

// ─── Validation ──────────────────────────────────────────────────────────────

/** Validates the envelope and the shape of every op (values are checked when applied). */
export function checkDelta(delta: Delta): void {
  if (!isRecord(delta) || delta.format !== 'kgdiff.delta') {
    throw new KgdiffError(
      'unsupported-version',
      'Not a kgdiff delta (expected format "kgdiff.delta")',
      {
        format: isRecord(delta) ? delta.format : undefined,
      },
    );
  }
  if (delta.version !== 1) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported delta version ${String(delta.version)}; this reader supports version 1`,
      { version: delta.version },
    );
  }
  resolveEdgeIdentity(delta.edgeIdentity);
  if (!isRecord(delta.base) || typeof delta.base.hash !== 'string') {
    throw new KgdiffError('invalid-input', 'delta.base must describe the base graph (with a hash)');
  }
  if (!Array.isArray(delta.ops))
    throw new KgdiffError('invalid-input', 'delta.ops must be an array');
  delta.ops.forEach(checkOp);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every(isString);
const optional = (v: unknown, test: (v: unknown) => boolean): boolean => v === undefined || test(v);

/** Shape of a node / edge snapshot (field types only; values are checked when applied). */
function validNode(v: unknown): boolean {
  return (
    isRecord(v) &&
    isString(v.id) &&
    optional(v.label, isString) &&
    optional(v.types, isStringList) &&
    optional(v.aliases, isStringList) &&
    optional(v.attrs, isRecord) &&
    optional(v.deprecated, (d) => typeof d === 'boolean') &&
    optional(v.replaces, isStringList) &&
    optional(v.replacedBy, isStringList)
  );
}

function validEdge(v: unknown): boolean {
  return (
    isRecord(v) &&
    isString(v.source) &&
    isString(v.target) &&
    optional(v.id, isString) &&
    optional(v.predicate, isString) &&
    optional(v.label, isString) &&
    optional(v.attrs, isRecord)
  );
}

function validFieldValue(field: unknown, value: unknown): boolean {
  if (field === 'label') return isString(value);
  if (field === 'deprecated') return typeof value === 'boolean';
  return NODE_FIELDS.includes(field as NodeField) && isStringList(value);
}

/** Rejects malformed ops up front (strict or not): they are input errors, not conflicts. */
function checkOp(op: unknown, opIndex: number): void {
  const fail = (what: string): never => {
    throw new KgdiffError('invalid-input', `delta.ops[${opIndex}] ${what}`, { opIndex, op });
  };
  if (!isRecord(op)) fail('is not an op');
  const o = op as Record<string, unknown>;
  switch (o.op) {
    case 'node.rekey':
      if (!isString(o.from) || !isString(o.to)) fail('needs string "from" and "to"');
      return;
    case 'node.remove':
    case 'node.add':
      if (!validNode(o.node)) fail('needs a valid "node" snapshot');
      return;
    case 'node.set':
      if (!isString(o.id)) fail('needs a string "id"');
      if (!validFieldValue(o.field, o.from) || !validFieldValue(o.field, o.to)) {
        fail(`has values that do not fit the field ${JSON.stringify(o.field)}`);
      }
      return;
    case 'node.attr':
      if (!isString(o.id) || !isString(o.key)) fail('needs a string "id" and "key"');
      return;
    case 'edge.remove':
    case 'edge.add':
      if (!validEdge(o.edge)) fail('needs a valid "edge" snapshot');
      return;
    case 'edge.set':
      if (!validEdge(o.edge) || o.field !== 'label' || !isString(o.from) || !isString(o.to)) {
        fail('needs an "edge", field "label" and string "from" / "to"');
      }
      return;
    case 'edge.attr':
      if (!validEdge(o.edge) || !isString(o.key)) fail('needs an "edge" and a string "key"');
      return;
    default:
      fail(`has an unknown op ${JSON.stringify(o.op)}`);
  }
}

// ─── Application ─────────────────────────────────────────────────────────────

/** A JSON node snapshot as a node (arrays normalized, defaults applied). */
function nodeFromJSON(json: NodeJSON): KGNode {
  const label = json.label === undefined || json.label === '' ? json.id : json.label;
  const aliases = sortedUnique(json.aliases ?? []).filter((a) => a !== label);
  return {
    id: json.id,
    label,
    types: sortedUnique(json.types ?? []),
    aliases,
    attrs: json.attrs ?? {},
    deprecated: json.deprecated ?? false,
    replaces: sortedUnique(json.replaces ?? []),
    replacedBy: sortedUnique(json.replacedBy ?? []),
    implicit: json.implicit ?? false,
  };
}

/** A JSON edge snapshot as an edge (defaults applied; the key is not meaningful here). */
function edgeFromJSON(json: EdgeJSON): KGEdge {
  const predicate = json.predicate ?? '';
  const base = {
    key: '',
    source: json.source,
    target: json.target,
    predicate,
    label: json.label ?? predicateLabel(predicate),
    attrs: json.attrs ?? {},
  };
  return json.id === undefined ? base : { ...base, id: json.id };
}

/** Mutable working copy of a graph used while applying a delta. Elements are copied on write. */
/** The copies of one edge identity, by content (parallel copies differ in content). */
interface EdgeGroup {
  readonly byContent: Map<string, KGEdge[]>;
  size: number;
}

/**
 * Mutable working copy of a graph used while applying a delta. Elements are copied on write.
 * Edges are grouped by identity, and within a group by content, so every edge op is O(1)
 * whatever the number of parallel copies.
 */
class WorkingGraph {
  readonly nodes = new Map<Id, KGNode>();
  private readonly groups = new Map<string, EdgeGroup>();
  private readonly incident = new Map<Id, Set<string>>();

  constructor(
    graph: KGraph,
    private readonly mode: EdgeIdentity,
  ) {
    for (const node of graph.nodes.values()) this.nodes.set(node.id, node);
    for (const edge of graph.edges.values()) this.attach(edge);
  }

  identity(edge: {
    readonly id?: Id;
    readonly source: Id;
    readonly predicate?: string;
    readonly target: Id;
  }): string {
    return this.mode === 'id' && edge.id !== undefined
      ? `i${edge.id}`
      : `t${tripleKey(edge.source, edge.predicate ?? '', edge.target)}`;
  }

  /** Everything an edge snapshot is compared on (the id only under `id` identity). */
  private content(edge: KGEdge): string {
    const id = this.mode === 'id' ? (edge.id ?? null) : null;
    return canonicalJSON([edge.source, edge.predicate, edge.target, edge.label, edge.attrs, id]);
  }

  private attach(edge: KGEdge): void {
    const id = this.identity(edge);
    const group = getOrCreate(
      this.groups,
      id,
      (): EdgeGroup => ({ byContent: new Map(), size: 0 }),
    );
    pushTo(group.byContent, this.content(edge), edge);
    group.size++;
    getOrCreate(this.incident, edge.source, () => new Set<string>()).add(id);
    getOrCreate(this.incident, edge.target, () => new Set<string>()).add(id);
  }

  /** Removes one copy with the given content; false when there is none. */
  private detachOne(id: string, content: string): KGEdge | undefined {
    const group = this.groups.get(id);
    const copies = group?.byContent.get(content);
    const edge = copies?.pop();
    if (!group || !copies || !edge) return undefined;
    if (copies.length === 0) group.byContent.delete(content);
    if (--group.size === 0) {
      this.groups.delete(id);
      this.incident.get(edge.source)?.delete(id);
      this.incident.get(edge.target)?.delete(id);
    }
    return edge;
  }

  /** Removes a whole identity group, returning its edges. */
  private detachAll(id: string): KGEdge[] {
    const group = this.groups.get(id);
    if (!group) return [];
    this.groups.delete(id);
    const edges = [...group.byContent.values()].flat();
    for (const edge of edges) {
      this.incident.get(edge.source)?.delete(id);
      this.incident.get(edge.target)?.delete(id);
    }
    return edges;
  }

  /** Finds the edge a locator refers to; `label` / `attrs` disambiguate parallel copies. */
  private locate(json: EdgeJSON): KGEdge | string {
    const group = this.groups.get(this.identity(json));
    if (!group) return 'edge not found';
    const copies = [...group.byContent.values()].flat();
    if (copies.length === 1) return copies[0] as KGEdge;
    const fits = copies.filter(
      (e) =>
        (json.label === undefined || e.label === json.label) &&
        (json.attrs === undefined || attrsEqual(e.attrs, json.attrs)),
    );
    if (fits.length !== 1)
      return fits.length ? 'edge is ambiguous (parallel copies)' : 'edge not found';
    return fits[0] as KGEdge;
  }

  /** Replaces `edge` by `next` (same identity, new content). */
  private replace(edge: KGEdge, next: KGEdge): void {
    this.detachOne(this.identity(edge), this.content(edge));
    this.attach(next);
  }

  /** Applies one op; returns the reason it cannot be applied, or undefined on success. */
  apply(op: DeltaOp): string | undefined {
    switch (op.op) {
      case 'node.rekey': {
        const node = this.nodes.get(op.from);
        if (!node) return `node "${op.from}" does not exist`;
        if (this.nodes.has(op.to)) return `node "${op.to}" already exists`;
        this.nodes.delete(op.from);
        this.nodes.set(op.to, { ...node, id: op.to });
        const moved = [...(this.incident.get(op.from) ?? [])].flatMap((id) => this.detachAll(id));
        this.incident.delete(op.from);
        for (const edge of moved) {
          this.attach({
            ...edge,
            source: edge.source === op.from ? op.to : edge.source,
            target: edge.target === op.from ? op.to : edge.target,
          });
        }
        return undefined;
      }
      case 'node.remove': {
        const node = this.nodes.get(op.node.id);
        if (!node) return `node "${op.node.id}" does not exist`;
        if (!nodeContentEquals(node, nodeFromJSON(op.node)))
          return `node "${op.node.id}" differs from the snapshot`;
        if (this.incident.get(op.node.id)?.size) return `node "${op.node.id}" still has edges`;
        this.nodes.delete(op.node.id);
        this.incident.delete(op.node.id);
        return undefined;
      }
      case 'node.add': {
        if (this.nodes.has(op.node.id)) return `node "${op.node.id}" already exists`;
        this.nodes.set(op.node.id, nodeFromJSON(op.node));
        return undefined;
      }
      case 'node.set': {
        const node = this.nodes.get(op.id);
        if (!node) return `node "${op.id}" does not exist`;
        if (!NODE_FIELDS.includes(op.field)) return `unknown node field "${String(op.field)}"`;
        if (!fieldValuesEqual(node[op.field], op.from))
          return `node "${op.id}" ${op.field} differs from "from"`;
        this.nodes.set(op.id, { ...node, [op.field]: op.to });
        return undefined;
      }
      case 'node.attr': {
        const node = this.nodes.get(op.id);
        if (!node) return `node "${op.id}" does not exist`;
        if (!attrValueEquals(ownAttr(node.attrs, op.key), op.from))
          return `node "${op.id}" attribute "${op.key}" differs from "from"`;
        this.nodes.set(op.id, { ...node, attrs: withAttr(node.attrs, op.key, op.to) });
        return undefined;
      }
      case 'edge.remove': {
        const id = this.identity(op.edge);
        if (!this.groups.has(id)) return 'edge not found';
        const removed = this.detachOne(id, this.content(edgeFromJSON(op.edge)));
        return removed ? undefined : 'edge differs from the snapshot';
      }
      case 'edge.add': {
        const edge = edgeFromJSON(op.edge);
        if (!this.nodes.has(edge.source)) return `source node "${edge.source}" does not exist`;
        if (!this.nodes.has(edge.target)) return `target node "${edge.target}" does not exist`;
        const group = this.groups.get(this.identity(edge));
        const clash =
          this.mode === 'id' && edge.id !== undefined
            ? group !== undefined
            : Boolean(group?.byContent.has(this.content(edge)));
        if (clash) return 'edge already exists';
        this.attach(edge);
        return undefined;
      }
      case 'edge.set': {
        const edge = this.locate(op.edge);
        if (typeof edge === 'string') return edge;
        const field: string = op.field;
        if (field !== 'label') return `unknown edge field "${field}"`;
        if (edge.label !== op.from) return 'edge label differs from "from"';
        this.replace(edge, { ...edge, label: op.to });
        return undefined;
      }
      case 'edge.attr': {
        const edge = this.locate(op.edge);
        if (typeof edge === 'string') return edge;
        if (!attrValueEquals(ownAttr(edge.attrs, op.key), op.from))
          return `edge attribute "${op.key}" differs from "from"`;
        this.replace(edge, { ...edge, attrs: withAttr(edge.attrs, op.key, op.to) });
        return undefined;
      }
      default: {
        const unknown: never = op;
        throw new KgdiffError(
          'invalid-input',
          `Unknown delta op "${String((unknown as { op?: unknown }).op)}"`,
          {
            op: unknown,
          },
        );
      }
    }
  }

  toGraph(meta: GraphMeta): KGraph {
    const nodes: NodeInput[] = [];
    for (const n of this.nodes.values()) nodes.push(nodeInput(n));
    const edges: EdgeInput[] = [];
    for (const group of this.groups.values()) {
      for (const copies of group.byContent.values()) {
        for (const e of copies) edges.push(e);
      }
    }
    return normalize({ meta, nodes, edges }, { edgeIdentity: this.mode });
  }
}

/** A copy of `attrs` with `key` set (or removed); any key, `__proto__` included, is data. */
function withAttr(attrs: Attrs, key: string, value: AttrValue | undefined): Attrs {
  const next = emptyAttrMap();
  for (const k of Object.keys(attrs)) if (k !== key) setAttr(next, k, attrs[k] as AttrValue);
  if (value !== undefined) setAttr(next, key, value);
  return next;
}

/** A node as normalize input, preserving `implicit` and `position`. */
export function nodeInput(node: KGNode): NodeInput {
  const input: NodeInput & { types: readonly string[]; implicit: boolean } = {
    id: node.id,
    label: node.label,
    types: node.types,
    aliases: node.aliases,
    attrs: node.attrs,
    deprecated: node.deprecated,
    replaces: node.replaces,
    replacedBy: node.replacedBy,
    implicit: node.implicit,
    ...(node.position ? { position: node.position } : {}),
  };
  return input;
}

/** Re-normalizes a graph under another edge identity (positions are kept). */
export function withEdgeIdentity(graph: KGraph, edgeIdentity: EdgeIdentity): KGraph {
  if (graph.edgeIdentity === edgeIdentity) return graph;
  return normalize(
    {
      meta: graph.meta,
      nodes: [...graph.nodes.values()].map(nodeInput),
      edges: [...graph.edges.values()],
    },
    { edgeIdentity },
  );
}

/**
 * Applies a delta (docs/delta-format.md). With `strict` (default) the base hash and every
 * op's precondition are verified and the first violation throws; otherwise ops whose
 * precondition fails are skipped and reported to `onSkip` (index, op, reason). The graph is
 * re-keyed to the delta's edge identity first.
 *
 * @throws KgdiffError `unsupported-version`, `delta-base-mismatch`, `delta-conflict`
 *   (`details: { opIndex, op, reason }`), `invalid-input`.
 */
export function applyDelta(graph: KGraph, delta: Delta, options: ApplyOptions = {}): KGraph {
  checkDelta(delta);
  const strict = options.strict ?? true;
  const base = withEdgeIdentity(graph, delta.edgeIdentity);
  if (strict) {
    const actual = hashGraph(base);
    if (actual !== delta.base.hash) {
      throw new KgdiffError(
        'delta-base-mismatch',
        `The graph (${actual}) is not the base of this delta (${delta.base.hash})`,
        { expected: delta.base.hash, actual },
      );
    }
  }
  const working = new WorkingGraph(base, delta.edgeIdentity);
  delta.ops.forEach((op, opIndex) => {
    const reason = working.apply(op);
    if (reason === undefined) return;
    if (!strict) {
      options.onSkip?.({ index: opIndex, op, reason });
      return;
    }
    throw new KgdiffError(
      'delta-conflict',
      `Cannot apply op #${opIndex} (${String(op.op)}): ${reason}`,
      {
        opIndex,
        op,
        reason,
      },
    );
  });
  const meta: Record<string, unknown> = { ...base.meta };
  if (delta.target.name !== undefined) meta.name = delta.target.name;
  if (delta.target.version !== undefined) meta.version = delta.target.version;
  return working.toGraph(meta);
}

// ─── Inversion ───────────────────────────────────────────────────────────────

function invertOp(op: DeltaOp): DeltaOp {
  switch (op.op) {
    case 'node.rekey':
      return { op: 'node.rekey', from: op.to, to: op.from };
    case 'edge.remove':
      return { op: 'edge.add', edge: op.edge };
    case 'edge.add':
      return { op: 'edge.remove', edge: op.edge };
    case 'node.remove':
      return { op: 'node.add', node: op.node };
    case 'node.add':
      return { op: 'node.remove', node: op.node };
    case 'node.set':
      return { op: 'node.set', id: op.id, field: op.field, from: op.to, to: op.from };
    case 'node.attr':
      return {
        op: 'node.attr',
        id: op.id,
        key: op.key,
        ...(op.to === undefined ? {} : { from: op.to }),
        ...(op.from === undefined ? {} : { to: op.from }),
      };
    case 'edge.set':
      return { op: 'edge.set', edge: op.edge, field: op.field, from: op.to, to: op.from };
    case 'edge.attr':
      return {
        op: 'edge.attr',
        edge: op.edge,
        key: op.key,
        ...(op.to === undefined ? {} : { from: op.to }),
        ...(op.from === undefined ? {} : { to: op.from }),
      };
    default: {
      const unknown: never = op;
      throw new KgdiffError(
        'invalid-input',
        `Unknown delta op "${String((unknown as { op?: unknown }).op)}"`,
      );
    }
  }
}

/**
 * The delta that undoes `delta`: ops reversed and inverted, base and target swapped.
 * `applyDelta(applyDelta(g, d), invertDelta(d)) ≅ g`. The result is valid but not in
 * canonical op order.
 */
export function invertDelta(delta: Delta): Delta {
  checkDelta(delta);
  const ops: DeltaOp[] = [];
  for (let i = delta.ops.length - 1; i >= 0; i--) ops.push(invertOp(delta.ops[i] as DeltaOp));
  return {
    format: 'kgdiff.delta',
    version: 1,
    edgeIdentity: delta.edgeIdentity,
    base: delta.target,
    target: delta.base,
    ops,
  };
}
