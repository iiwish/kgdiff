/**
 * `normalize`: validate, canonicalize and index one graph version (docs/algorithms.md §1).
 *
 * O(N + E) apart from sorting the (tiny) per-node sets and the parallel-edge groups. The
 * result never depends on the order of the input nodes and edges.
 */
import { canonicalJSON, emptyAttrMap, ownAttr, setAttr, tripleKey } from './canonical.js';
import { KgdiffError } from './errors.js';
import { resolveEdgeIdentity } from './options.js';
import { nfc, predicateLabel, rawPredicateLabel } from './text.js';
import type {
  Attrs,
  AttrValue,
  EdgeIdentity,
  EdgeKey,
  GraphInput,
  GraphIssue,
  Id,
  KGEdge,
  KGNode,
  KGraph,
  NormalizeOptions,
  Point,
} from './types.js';
import { compareStrings, EMPTY, isRecord, pushTo, sortedUnique } from './util.js';

/**
 * Untrusted input record: every field is validated before use. Besides `NodeInput`, the
 * JSON transport's names (`NodeJSON.types`, `NodeJSON.implicit`) are accepted, so
 * `normalize(graphToJSON(g))` round-trips losslessly.
 */
type RawRecord = Readonly<Record<string, unknown>>;

interface NodeDraft {
  readonly id: Id;
  label?: string;
  types: readonly string[];
  aliases: readonly string[];
  attrs?: Attrs;
  deprecated?: boolean;
  replaces: readonly string[];
  replacedBy: readonly string[];
  implicit: boolean;
  position?: Point;
}

/** All declarations of one edge identity (an id, or a structural triple). */
interface EdgeGroup {
  readonly base: string;
  readonly idKeyed: boolean;
  readonly first: EdgeDraft;
  more?: EdgeDraft[];
  /** The edge of an identity that occurs once. */
  edge?: KGEdge;
  /** The edges of a repeated identity (merged or parallel copies). */
  edges?: KGEdge[];
}

/**
 * An edge before its key is known: already shaped like a `KGEdge`, so an edge whose identity
 * occurs once becomes the final object by receiving its key (no copy).
 */
interface EdgeDraft {
  key: EdgeKey;
  readonly id?: Id;
  readonly source: Id;
  readonly target: Id;
  readonly predicate: string;
  readonly label: string;
  readonly attrs: Attrs;
}

const EMPTY_ATTRS: Attrs = Object.freeze({});
const DANGLING_POLICIES: ReadonlySet<string> = new Set(['create', 'drop', 'error']);

/**
 * How display text is read: labels, aliases and types, and the label of an edge that has none of
 * its own. API input is composed to NFC (`normalize`). A kgdiff JSON snapshot holds text its writer
 * normalized already, so it is taken as written: `diffFromJSON` must open a report the same way
 * whatever Unicode version the runtime's ICU has, and checks the text by content hash instead.
 */
export interface TextForm {
  /** A label, alias or type. */
  readonly text: (text: string) => string;
  /** The label of an edge without one of its own. */
  readonly edgeLabel: (predicate: string) => string;
}

/** API input: NFC, and `predicateLabel`. */
export const INPUT_TEXT: TextForm = { text: nfc, edgeLabel: predicateLabel };

/** kgdiff JSON snapshots: as written, and `rawPredicateLabel` (no Unicode tables involved). */
export const SNAPSHOT_TEXT: TextForm = { text: (text) => text, edgeLabel: rawPredicateLabel };

function fail(message: string, details?: Record<string, unknown>): never {
  throw new KgdiffError('invalid-input', message, details);
}

/**
 * Checks the optional kgdiff JSON marker. Only `kgdiff.*` formats are kgdiff's: a `format`
 * field with any other value belongs to someone else and is ignored, like other unknown keys.
 */
function checkFormat(input: Readonly<Record<string, unknown>>): void {
  const { format, version } = input;
  if (typeof format !== 'string' || !format.startsWith('kgdiff.')) return;
  if (format !== 'kgdiff.graph') {
    throw new KgdiffError(
      'unsupported-version',
      `Expected a kgdiff graph (format "kgdiff.graph"), got format "${format}"`,
      { format },
    );
  }
  if (version !== 1) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported graph version ${String(version)}; this reader supports version 1`,
      { version },
    );
  }
}

/** Ids are strings; finite numbers are accepted and stringified. Empty → undefined. */
function coerceId(value: unknown): Id | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

// Validation messages name the element they are about — a node (`owner` = its id) or an edge
// (`owner` = source, `target` given) — and are only built on failure: no cost on the happy path.

function describe(owner: Id, target: Id | undefined): { what: string; ref: string } {
  return target === undefined
    ? { what: `Node "${owner}"`, ref: owner }
    : { what: `Edge ${owner} → ${target}`, ref: `${owner} → ${target}` };
}

function invalidField(owner: Id, target: Id | undefined, field: string, expected: string): never {
  const { what, ref } = describe(owner, target);
  return fail(`${what}: ${field} must be ${expected}`, { ref });
}

function optionalString(
  value: unknown,
  owner: Id,
  target: Id | undefined,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalidField(owner, target, field, 'a string');
  return value;
}

function stringArray(value: unknown, owner: Id, field: string): readonly string[] {
  if (value === undefined || value === null) return EMPTY;
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalidField(owner, undefined, field, 'an array of strings');
  }
  return value as string[];
}

/** Attribute values nested deeper than this are rejected (and cycles with them). */
const MAX_DEPTH = 1000;

/**
 * Turns an attribute value into JSON: NaN / ±Infinity become "NaN" / "Infinity" /
 * "-Infinity", bigints and dates become strings, objects with `toJSON` are converted, other
 * objects are copied (keys such as `__proto__` stay data).
 * Functions, symbols and `undefined` are not JSON: they are dropped from objects and become
 * `null` in arrays (like `JSON.stringify`), and reported through `onInvalid`.
 */
function sanitize(value: unknown, depth: number, onInvalid: () => void): AttrValue | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return String(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      onInvalid();
      return undefined;
    default:
      break;
  }
  if (value === null) return null;
  if (depth >= MAX_DEPTH) {
    throw new KgdiffError(
      'invalid-input',
      `Attribute values may be nested at most ${MAX_DEPTH} levels deep (or the value is cyclic)`,
    );
  }
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sanitize(item, depth + 1, onInvalid) ?? null);
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') return sanitize(toJSON.call(value), depth + 1, onInvalid);
  const out = emptyAttrMap();
  for (const key of Object.keys(value as object)) {
    const raw = (value as Record<string, unknown>)[key];
    // Fast path for the common flat case: strings, booleans and finite numbers are JSON.
    const item =
      typeof raw === 'string' ||
      typeof raw === 'boolean' ||
      (typeof raw === 'number' && Number.isFinite(raw))
        ? raw
        : sanitize(raw, depth + 1, onInvalid);
    if (item !== undefined) setAttr(out, key, item);
  }
  return out;
}

/** A validated attribute map (any key, `__proto__` included, is data), or undefined when absent. */
function attrsOf(
  value: unknown,
  owner: Id,
  target: Id | undefined,
  issues: GraphIssue[],
): Attrs | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalidField(owner, target, 'attrs', 'an object');
  let invalid = 0;
  const attrs = sanitize(value, 0, () => invalid++) as Attrs;
  if (invalid > 0) {
    const { what, ref } = describe(owner, target);
    issues.push({
      code: 'invalid-attr',
      message: `${what}: ${invalid} attribute value(s) that are not JSON (function, symbol or undefined) were dropped`,
      ref,
    });
  }
  return attrs;
}

function positionOf(value: unknown): Point | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y } = value;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

/** The fields `normalize` reads from a node record (a `KGNode` has them too). */
type NodeFields = {
  readonly [K in
    | 'id'
    | 'label'
    | 'type'
    | 'types'
    | 'aliases'
    | 'attrs'
    | 'deprecated'
    | 'replaces'
    | 'replacedBy'
    | 'implicit'
    | 'position']?: unknown;
};

function draftNode(raw: NodeFields, id: Id, issues: GraphIssue[], form: TextForm): NodeDraft {
  const types = stringArray(raw.type, id, 'type');
  const extraTypes = stringArray(raw.types, id, 'types');
  const aliases = stringArray(raw.aliases, id, 'aliases');
  const allTypes = extraTypes.length ? [...types, ...extraTypes] : types;
  const draft: NodeDraft = {
    id,
    types: allTypes.length ? allTypes.map(form.text) : EMPTY,
    aliases: aliases.length ? aliases.map(form.text) : EMPTY,
    replaces: stringArray(raw.replaces, id, 'replaces'),
    replacedBy: stringArray(raw.replacedBy, id, 'replacedBy'),
    implicit: raw.implicit === true,
  };
  const label = optionalString(raw.label, id, undefined, 'label');
  if (label) draft.label = form.text(label);
  const attrs = attrsOf(raw.attrs, id, undefined, issues);
  if (attrs) draft.attrs = attrs;
  if (raw.deprecated !== undefined && raw.deprecated !== null) {
    if (typeof raw.deprecated !== 'boolean') invalidField(id, undefined, 'deprecated', 'a boolean');
    draft.deprecated = raw.deprecated;
  }
  const position = positionOf(raw.position);
  if (position) draft.position = position;
  return draft;
}

/** The larger of two values by canonical JSON: an order-independent way to pick one. */
function maxByJSON<T>(a: T | undefined, b: T | undefined): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return canonicalJSON(b as AttrValue) > canonicalJSON(a as AttrValue) ? b : a;
}

/** Per key, the larger value by canonical JSON. */
function mergeAttrs(a: Attrs | undefined, b: Attrs | undefined): Attrs | undefined {
  if (!a || !b) return a ?? b;
  const out = emptyAttrMap();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const value = maxByJSON(ownAttr(a, key), ownAttr(b, key));
    if (value !== undefined) setAttr(out, key, value);
  }
  return out;
}

/**
 * Merges a duplicate declaration independently of declaration order: sets are united; each
 * scalar (label, deprecated, position, every attribute) takes the larger value by canonical
 * JSON among the declarations that give one.
 */
function mergeDraft(into: NodeDraft, next: NodeDraft): void {
  const label = maxByJSON(into.label, next.label);
  if (label !== undefined) into.label = label;
  const deprecated = maxByJSON(into.deprecated, next.deprecated);
  if (deprecated !== undefined) into.deprecated = deprecated;
  const position = maxByJSON(into.position, next.position);
  if (position) into.position = position;
  const attrs = mergeAttrs(into.attrs, next.attrs);
  if (attrs) into.attrs = attrs;
  into.types = [...into.types, ...next.types];
  into.aliases = [...into.aliases, ...next.aliases];
  into.replaces = [...into.replaces, ...next.replaces];
  into.replacedBy = [...into.replacedBy, ...next.replacedBy];
  into.implicit = into.implicit && next.implicit;
}

function finishNode(draft: NodeDraft): KGNode {
  const label = draft.label ?? draft.id;
  const aliases = sortedUnique(draft.aliases);
  const labelAt = aliases.indexOf(label);
  if (labelAt >= 0) aliases.splice(labelAt, 1);
  const node: {
    -readonly [K in keyof KGNode]: KGNode[K];
  } = {
    id: draft.id,
    label,
    types: draft.types.length ? sortedUnique(draft.types) : EMPTY,
    aliases: aliases.length ? aliases : EMPTY,
    attrs: draft.attrs ?? EMPTY_ATTRS,
    deprecated: draft.deprecated ?? false,
    replaces: draft.replaces.length ? sortedUnique(draft.replaces) : EMPTY,
    replacedBy: draft.replacedBy.length ? sortedUnique(draft.replacedBy) : EMPTY,
    implicit: draft.implicit,
  };
  if (draft.position) node.position = draft.position;
  return node;
}

/** Content of an edge that distinguishes parallel copies of one triple. */
function parallelContent(edge: EdgeDraft): string {
  return canonicalJSON([edge.label, edge.attrs]);
}

function makeEdge(key: EdgeKey, draft: EdgeDraft): KGEdge {
  return draft.id === undefined
    ? {
        key,
        source: draft.source,
        target: draft.target,
        predicate: draft.predicate,
        label: draft.label,
        attrs: draft.attrs,
      }
    : {
        key,
        id: draft.id,
        source: draft.source,
        target: draft.target,
        predicate: draft.predicate,
        label: draft.label,
        attrs: draft.attrs,
      };
}

/** Type guard distinguishing a normalized `KGraph` from a raw `GraphInput`. */
export function isKGraph(value: unknown): value is KGraph {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { nodes?: unknown }).nodes instanceof Map &&
    (value as { edges?: unknown }).edges instanceof Map
  );
}

/**
 * Validates and indexes a graph. Pure; never mutates `input`.
 *
 * - Nodes: `label` defaults to the id; `types`, `aliases`, `replaces`, `replacedBy` are sorted
 *   and de-duplicated; aliases equal to the label are dropped; empty ids are dropped
 *   (`empty-id`); duplicate ids are merged field-wise (`duplicate-node`).
 * - Edges: keyed per `edgeIdentity` (default `structure`). Parallel copies of one triple get
 *   `#2`, `#3`… in canonical content order (so keys do not depend on input order); copies that
 *   are identical in content are collapsed. With `id` identity, repeated ids are merged
 *   field-wise. Both cases record a `duplicate-edge` issue.
 * - Dangling endpoints (`danglingEdges`, default `create`): `create` adds an implicit node,
 *   `drop` discards the edge, `error` throws `KgdiffError('dangling-edge')`.
 * - The kgdiff JSON marker is optional; a `kgdiff.*` format other than `kgdiff.graph`, or a
 *   version other than 1, is rejected.
 *
 * @throws KgdiffError `invalid-input` for malformed input, `dangling-edge` (policy `error`),
 *   `unsupported-version` for another kgdiff format or graph version.
 */
export function normalize(
  input: GraphInput,
  options: NormalizeOptions = {},
  form: TextForm = INPUT_TEXT,
): KGraph {
  if (isRecord(input)) checkFormat(input);
  if (!isRecord(input) || !Array.isArray(input.nodes)) {
    fail('normalize expects a graph of the form { nodes: [...], edges: [...] }');
  }
  if (input.edges !== undefined && input.edges !== null && !Array.isArray(input.edges)) {
    fail('graph.edges must be an array');
  }
  const edgeIdentity: EdgeIdentity = resolveEdgeIdentity(options.edgeIdentity);
  const dangling = options.danglingEdges ?? 'create';
  if (!DANGLING_POLICIES.has(dangling)) {
    fail(`danglingEdges must be 'create', 'drop' or 'error' (got ${String(dangling)})`);
  }
  const issues: GraphIssue[] = [];

  // ── Nodes ──
  const drafts = new Map<Id, NodeDraft>();
  for (const raw of input.nodes as readonly unknown[]) {
    if (!isRecord(raw)) fail('graph.nodes must contain objects');
    const id = coerceId(raw.id);
    if (id === undefined) {
      issues.push({ code: 'empty-id', message: 'Dropped a node without an id' });
      continue;
    }
    const draft = draftNode(raw, id, issues, form);
    const existing = drafts.get(id);
    if (existing) {
      mergeDraft(existing, draft);
      issues.push({
        code: 'duplicate-node',
        message: `Node "${id}" is declared more than once; the declarations were merged`,
        ref: id,
      });
    } else {
      drafts.set(id, draft);
    }
  }

  // ── Edges: endpoints, defaults ──
  const labelCache = new Map<string, string>();
  const edgeDrafts: EdgeDraft[] = [];
  for (const raw of (input.edges ?? []) as readonly unknown[]) {
    if (!isRecord(raw)) fail('graph.edges must contain objects');
    const edge = raw;
    const source = coerceId(edge.source);
    const target = coerceId(edge.target);
    if (source === undefined || target === undefined) {
      issues.push({ code: 'empty-id', message: 'Dropped an edge with an empty endpoint' });
      continue;
    }
    const predicate = optionalString(edge.predicate, source, target, 'predicate') ?? '';
    const explicitLabel = optionalString(edge.label, source, target, 'label');
    let label = explicitLabel === undefined ? undefined : form.text(explicitLabel);
    if (label === undefined) {
      label = labelCache.get(predicate);
      if (label === undefined) {
        label = form.edgeLabel(predicate);
        labelCache.set(predicate, label);
      }
    }
    if (!drafts.has(source) || !drafts.has(target)) {
      handleDangling(source, predicate, target, dangling, drafts, issues);
      if (dangling === 'drop') continue;
    }
    const id = coerceId(edge.id);
    const attrs = attrsOf(edge.attrs, source, target, issues) ?? EMPTY_ATTRS;
    edgeDrafts.push(
      id === undefined
        ? { key: '', source, target, predicate, label, attrs }
        : { key: '', id, source, target, predicate, label, attrs },
    );
  }

  const nodes = new Map<Id, KGNode>();
  for (const [id, draft] of drafts) nodes.set(id, finishNode(draft));

  // ── Edges: identity keys ──
  // Edge ids and structural keys are grouped separately, and id-keyed groups are keyed first,
  // so an id that happens to look like a structural key can only push the structural key aside
  // (to `#2`), whatever the input order. Most identities occur once: repeats are kept aside
  // instead of allocating a list per edge.
  const groups: EdgeGroup[] = [];
  const byId = new Map<string, EdgeGroup>();
  const byTriple = new Map<string, EdgeGroup>();
  for (const draft of edgeDrafts) {
    const idKeyed = edgeIdentity === 'id' && draft.id !== undefined;
    const base = idKeyed
      ? (draft.id as string)
      : tripleKey(draft.source, draft.predicate, draft.target);
    const index = idKeyed ? byId : byTriple;
    const group = index.get(base);
    if (group) {
      if (group.more) group.more.push(draft);
      else group.more = [draft];
    } else {
      const created: EdgeGroup = { base, idKeyed, first: draft };
      index.set(base, created);
      groups.push(created);
    }
  }
  // Collisions between keys are only possible when ids and structural keys mix.
  const taken = edgeIdentity === 'id' ? new Set<EdgeKey>() : undefined;
  const unique = (key: EdgeKey): EdgeKey => {
    if (!taken) return key;
    let candidate = key;
    for (let n = 2; taken.has(candidate); n++) candidate = `${key}#${n}`;
    taken.add(candidate);
    return candidate;
  };
  for (const idKeyed of [true, false]) {
    for (const group of groups) {
      if (group.idKeyed !== idKeyed) continue;
      const { base, first, more } = group;
      if (!more) {
        first.key = unique(base);
        group.edge = first;
        continue;
      }
      const out: KGEdge[] = [];
      const insert = (key: EdgeKey, draft: EdgeDraft): void => {
        out.push(makeEdge(unique(key), draft));
      };
      if (idKeyed) {
        insert(base, mergeEdgeDrafts([first, ...more]));
        issues.push({
          code: 'duplicate-edge',
          message: `Edge id "${base}" is used ${more.length + 1} times; the declarations were merged`,
          ref: base,
        });
      } else {
        insertParallel(base, [first, ...more], insert, issues);
      }
      group.edges = out;
    }
  }
  // Edges keep the order in which their identity first appeared.
  const edges = new Map<EdgeKey, KGEdge>();
  for (const group of groups) {
    if (group.edge) edges.set(group.edge.key, group.edge);
    else for (const edge of group.edges ?? []) edges.set(edge.key, edge);
  }

  issues.sort(
    (a, b) =>
      compareStrings(a.code, b.code) ||
      compareStrings(a.ref ?? '', b.ref ?? '') ||
      compareStrings(a.message, b.message),
  );
  return indexGraph(input.meta, nodes, edges, edgeIdentity, issues);
}

/** Edge keys by source and by target node id, in edge order. */
export interface Adjacency {
  readonly outgoing: Map<Id, readonly EdgeKey[]>;
  readonly incoming: Map<Id, readonly EdgeKey[]>;
}

/**
 * The adjacency of `edges`, which lists the nodes that have edges; undefined when `nodes` is
 * given and an edge has an end that is not one of them.
 */
export function adjacencyOf(
  edges: ReadonlyMap<EdgeKey, KGEdge>,
  nodes?: ReadonlyMap<Id, KGNode>,
): Adjacency | undefined {
  const outgoing = new Map<Id, EdgeKey[]>();
  const incoming = new Map<Id, EdgeKey[]>();
  for (const edge of edges.values()) {
    if (nodes && !(nodes.has(edge.source) && nodes.has(edge.target))) return undefined;
    pushTo(outgoing, edge.source, edge.key);
    pushTo(incoming, edge.target, edge.key);
  }
  return { outgoing, incoming };
}

/** The graph of indexed nodes and keyed edges, with their adjacency (built when not given). */
export function indexGraph(
  meta: unknown,
  nodes: Map<Id, KGNode>,
  edges: Map<EdgeKey, KGEdge>,
  edgeIdentity: EdgeIdentity,
  issues: GraphIssue[],
  { outgoing, incoming } = adjacencyOf(edges) as Adjacency,
): KGraph {
  for (const id of nodes.keys()) {
    if (!outgoing.has(id)) outgoing.set(id, EMPTY);
    if (!incoming.has(id)) incoming.set(id, EMPTY);
  }
  return {
    meta: isRecord(meta) ? { ...meta } : {},
    nodes,
    edges,
    outgoing,
    incoming,
    edgeIdentity,
    issues,
  };
}

// ─── Single declarations ─────────────────────────────────────────────────────
// `diffFromJSON` reads graphs in which every node and edge is declared once (`canonicalGraphs`
// in json.ts). These make one of a snapshot the way `normalize` does with `SNAPSHOT_TEXT`,
// reporting into `issues`; merging repeats and dangling ends are the caller's to rule out.

/** The node `normalize` makes of the snapshot `raw` declared once, under `rawId` (`raw.id`). */
export function nodeOf(
  raw: NodeFields,
  issues: GraphIssue[],
  rawId: unknown = raw.id,
): KGNode | undefined {
  const id = coerceId(rawId);
  return id === undefined ? undefined : finishNode(draftNode(raw, id, issues, SNAPSHOT_TEXT));
}

/**
 * The edge `normalize` makes of the snapshot `raw` when no other edge has its identity and both
 * ends are nodes; undefined for an empty end. `key`: known already (it saves building it again).
 */
export function edgeOf(
  raw: RawRecord,
  edgeIdentity: EdgeIdentity,
  issues: GraphIssue[],
  key?: EdgeKey,
): KGEdge | undefined {
  const source = coerceId(raw.source);
  const target = coerceId(raw.target);
  if (source === undefined || target === undefined) return undefined;
  const predicate = optionalString(raw.predicate, source, target, 'predicate') ?? '';
  const explicitLabel = optionalString(raw.label, source, target, 'label');
  const label =
    explicitLabel === undefined
      ? SNAPSHOT_TEXT.edgeLabel(predicate)
      : SNAPSHOT_TEXT.text(explicitLabel);
  const id = coerceId(raw.id);
  const attrs = attrsOf(raw.attrs, source, target, issues) ?? EMPTY_ATTRS;
  const k =
    key ?? (edgeIdentity === 'id' && id !== undefined ? id : tripleKey(source, predicate, target));
  // The draft `normalize` makes, keyed.
  return id === undefined
    ? { key: k, source, target, predicate, label, attrs }
    : { key: k, id, source, target, predicate, label, attrs };
}

/** Applies the dangling-endpoint policy to an edge with at least one undeclared endpoint. */
function handleDangling(
  source: Id,
  predicate: string,
  target: Id,
  policy: string,
  drafts: Map<Id, NodeDraft>,
  issues: GraphIssue[],
): void {
  for (const endpoint of source === target ? [source] : [source, target]) {
    if (drafts.has(endpoint)) continue;
    if (policy === 'error') {
      throw new KgdiffError(
        'dangling-edge',
        `Edge ${tripleKey(source, predicate, target)} points to the missing node "${endpoint}"`,
        { source, predicate, target, missing: endpoint },
      );
    }
    if (policy === 'create') {
      drafts.set(endpoint, {
        id: endpoint,
        types: [],
        aliases: [],
        replaces: [],
        replacedBy: [],
        implicit: true,
      });
    }
    issues.push({
      code: 'dangling-edge',
      message:
        policy === 'create'
          ? `Edge endpoint "${endpoint}" is not declared; an implicit node was created`
          : `Dropped an edge whose endpoint "${endpoint}" is not declared`,
      ref: endpoint,
    });
  }
}

/**
 * Repeated edge ids (identity `id`), merged independently of declaration order: the
 * endpoints, predicate and label of the declaration that is largest by canonical JSON;
 * attributes merged per key, the larger value by canonical JSON winning.
 */
function mergeEdgeDrafts(group: readonly EdgeDraft[]): EdgeDraft {
  const structure = (d: EdgeDraft): string =>
    canonicalJSON([d.source, d.predicate, d.target, d.label]);
  let chosen = group[0] as EdgeDraft;
  let attrs: Attrs | undefined = chosen.attrs;
  for (let i = 1; i < group.length; i++) {
    const next = group[i] as EdgeDraft;
    if (structure(next) > structure(chosen)) chosen = next;
    attrs = mergeAttrs(attrs, next.attrs);
  }
  return { ...chosen, attrs: attrs ?? EMPTY_ATTRS };
}

/**
 * Parallel copies of one triple: copies identical in content collapse into one (keeping the
 * smallest edge id); distinct copies get `#2`, `#3`… in canonical content order.
 */
function insertParallel(
  base: string,
  group: readonly EdgeDraft[],
  insert: (key: EdgeKey, draft: EdgeDraft) => void,
  issues: GraphIssue[],
): void {
  // Content → kept copy; identical copies keep the smallest edge id. Linear in the group size.
  const byContent = new Map<string, EdgeDraft>();
  let collapsed = 0;
  for (const draft of group) {
    const content = parallelContent(draft);
    const kept = byContent.get(content);
    if (!kept) {
      byContent.set(content, draft);
      continue;
    }
    collapsed++;
    if (draft.id !== undefined && (kept.id === undefined || draft.id < kept.id))
      byContent.set(content, draft);
  }
  const ordered = [...byContent]
    .map(([content, draft]) => ({ draft, content }))
    .sort((a, b) => compareStrings(a.content, b.content));
  ordered.forEach(({ draft }, i) => {
    insert(i === 0 ? base : `${base}#${i + 1}`, draft);
  });
  if (collapsed > 0) {
    issues.push({
      code: 'duplicate-edge',
      message: `Edge ${base} is declared ${collapsed + 1} times with identical content; the copies were collapsed`,
      ref: base,
    });
  }
  if (ordered.length > 1) {
    issues.push({
      code: 'duplicate-edge',
      message: `Edge ${base} has ${ordered.length} parallel copies; they are keyed #2, #3…`,
      ref: base,
    });
  }
}
