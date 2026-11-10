/**
 * @kgdiff/core: public data model.
 *
 * The model has three layers:
 *
 *  1. Input       `GraphInput`: what callers hand us. Loose and JSON-friendly.
 *  2. Normalized  `KGraph`: validated, indexed, immutable. One per version.
 *  3. Diff        `DiffResult`: the *union* of both versions. Every element is
 *                 annotated with a status and semantic facets, grouped into
 *                 review hunks, and backed by a low-level invertible `Delta`.
 *
 * Conventions
 *  - Every value produced by this package is deeply immutable (readonly).
 *  - Arrays in results are deterministically ordered (docs/algorithms.md §Determinism).
 *    The same inputs and options always produce byte-identical `diffToJSON` output.
 *  - Union ids identify elements across both versions (see `UnionId`).
 *  - Nothing here depends on the DOM or Node; the package runs everywhere.
 */

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Identifier of a node within one graph version (IRI, CURIE, or any string). */
export type Id = string;

/**
 * Identifier of an element in the union graph.
 *
 * Nodes: the after-version id for nodes present after; otherwise the before-version
 * id. If that collides with an after-version id (only possible when ids are not used
 * for matching), the suffix `@before` is appended.
 *
 * Edges: in `structure` identity mode `JSON.stringify([source, predicate, target])`
 * computed on *union* node ids (plus `#2`, `#3`… for parallel duplicates); in `id`
 * mode the edge id (with `@before` on collision).
 */
export type UnionId = string;

/** Identity key of an edge within one graph version. See `EdgeIdentity`. */
export type EdgeKey = string;

/** JSON-compatible attribute value. */
export type AttrValue =
  | string
  | number
  | boolean
  | null
  | readonly AttrValue[]
  | { readonly [key: string]: AttrValue };

export type Attrs = { readonly [key: string]: AttrValue };

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type Locale = 'en' | 'zh-CN';

// ─── 1. Input ────────────────────────────────────────────────────────────────

export interface NodeInput {
  readonly id: Id;
  /** Display name. Defaults to the id. */
  readonly label?: string;
  /** Class / category / rdf:type. */
  readonly type?: string | readonly string[];
  /** Synonyms (skos:altLabel, OBO synonyms…). */
  readonly aliases?: readonly string[];
  readonly attrs?: Attrs;
  /** Obsolete / deprecated, but still present (OBO `is_obsolete`, `owl:deprecated`). */
  readonly deprecated?: boolean;
  /** Ids (in the *other* version) this node replaces. A strong merge hint. */
  readonly replaces?: readonly Id[];
  /** Ids this node is replaced by (OBO `replaced_by`, IAO:0100001). A strong merge hint. */
  readonly replacedBy?: readonly Id[];
  /** Optional pinned layout position. Never part of the diff itself. */
  readonly position?: Point;
}

export interface EdgeInput {
  /** Explicit edge id. Only used for identity when `edgeIdentity: 'id'`. */
  readonly id?: Id;
  readonly source: Id;
  readonly target: Id;
  /** Relation type (IRI, CURIE or plain name). Defaults to ''. */
  readonly predicate?: string;
  /** Display label of the relation. Defaults to a readable form of the predicate. */
  readonly label?: string;
  readonly attrs?: Attrs;
}

export interface GraphMeta {
  readonly name?: string;
  readonly version?: string;
  /** Where the graph came from (file name, URL…). */
  readonly source?: string;
  readonly [key: string]: unknown;
}

export interface GraphInput {
  /**
   * Format marker of kgdiff JSON, as `graphToJSON` writes it. Optional; when present, `version`
   * must be 1 (anything else is rejected with `unsupported-version`).
   */
  readonly format?: 'kgdiff.graph';
  readonly version?: 1;
  readonly nodes: readonly NodeInput[];
  readonly edges: readonly EdgeInput[];
  readonly meta?: GraphMeta;
}

// ─── 2. Normalized graph ─────────────────────────────────────────────────────

export interface KGNode {
  readonly id: Id;
  /** Never empty: falls back to the id. */
  readonly label: string;
  /** Sorted, unique. */
  readonly types: readonly string[];
  /** Sorted, unique, never contains `label`. */
  readonly aliases: readonly string[];
  readonly attrs: Attrs;
  readonly deprecated: boolean;
  /** Sorted, unique. */
  readonly replaces: readonly Id[];
  /** Sorted, unique. */
  readonly replacedBy: readonly Id[];
  /** True when the node was created implicitly for a dangling edge endpoint. */
  readonly implicit: boolean;
  readonly position?: Point;
}

export interface KGEdge {
  readonly key: EdgeKey;
  readonly id?: Id;
  readonly source: Id;
  readonly target: Id;
  readonly predicate: string;
  readonly label: string;
  readonly attrs: Attrs;
}

/**
 * - `duplicate-node` / `duplicate-edge`: repeated declarations, merged or collapsed.
 * - `dangling-edge`: an edge endpoint that is not declared.
 * - `empty-id`: a node or edge endpoint without an id (dropped).
 * - `invalid-attr`: an attribute value that is not JSON (function, symbol, undefined), dropped.
 */
export type GraphIssueCode =
  | 'duplicate-node'
  | 'dangling-edge'
  | 'duplicate-edge'
  | 'empty-id'
  | 'invalid-attr';

export interface GraphIssue {
  readonly code: GraphIssueCode;
  readonly message: string;
  /** Node id or edge key the issue refers to. */
  readonly ref?: string;
}

/** Normalized, indexed, immutable graph. Produced by `normalize`. */
export interface KGraph {
  readonly meta: GraphMeta;
  readonly nodes: ReadonlyMap<Id, KGNode>;
  readonly edges: ReadonlyMap<EdgeKey, KGEdge>;
  /** Edge keys by source node id, in edge insertion order. */
  readonly outgoing: ReadonlyMap<Id, readonly EdgeKey[]>;
  /** Edge keys by target node id, in edge insertion order. */
  readonly incoming: ReadonlyMap<Id, readonly EdgeKey[]>;
  readonly edgeIdentity: EdgeIdentity;
  readonly issues: readonly GraphIssue[];
}

/**
 * How edges are identified within a version and matched across versions.
 *  - `structure` (default): an edge *is* its (source, predicate, target) triple.
 *  - `id`: edges carry stable ids (falls back to structure for edges without one).
 */
export type EdgeIdentity = 'structure' | 'id';

export interface NormalizeOptions {
  readonly edgeIdentity?: EdgeIdentity;
  /**
   * What to do with edges whose endpoints are missing.
   * `create` (default) adds an implicit node, `drop` discards the edge, `error` throws.
   */
  readonly danglingEdges?: 'create' | 'drop' | 'error';
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface MatchOptions {
  /**
   * - `id`: nodes match when their ids are equal (or through a 1:1 replacement hint).
   * - `auto` (default): exact ids first, then 1:1 replacement hints, then similarity matching
   *   for the leftovers.
   * - `similarity`: ignore ids entirely (e.g. LLM extractions with random ids); 1:1
   *   replacement hints still match.
   */
  readonly strategy?: 'id' | 'auto' | 'similarity';
  /** Minimum score (0–1) to accept a similarity match. Default 0.82. */
  readonly threshold?: number;
  /** Minimum score (0–1) to surface a pair as a suggestion. Default 0.6. */
  readonly suggestThreshold?: number;
  /** Candidate pairs considered per node. Default 8. */
  readonly maxCandidates?: number;
}

export interface DiffOptions {
  readonly match?: MatchOptions;
  readonly edgeIdentity?: EdgeIdentity;
  /**
   * Predicates that place a node in a hierarchy (child → parent). Changing a
   * node's parents is reported as a `move`. Default `DEFAULT_HIERARCHY_PREDICATES`.
   */
  readonly hierarchyPredicates?: readonly string[];
  /** Detect N→1 merges. Default true. */
  readonly detectMerges?: boolean;
  /** Detect 1→N splits. Default true. */
  readonly detectSplits?: boolean;
  /** Attribute keys ignored when comparing (still kept in snapshots). */
  readonly ignoreAttrs?: readonly string[];
}

export interface ResolvedDiffOptions {
  readonly match: Required<MatchOptions>;
  readonly edgeIdentity: EdgeIdentity;
  readonly hierarchyPredicates: readonly string[];
  readonly detectMerges: boolean;
  readonly detectSplits: boolean;
  readonly ignoreAttrs: readonly string[];
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * - `id`: equal ids.
 * - `hint`: a 1:1 replacement (`x.replacedBy ∋ y` or `y.replaces ∋ x`, e.g. an OBO term that
 *   got a new id and keeps the old one as `alt_id`), score 1.
 * - `similarity`: label / neighbour / type / attribute evidence.
 */
export type MatchMethod = 'id' | 'hint' | 'similarity';

/** Per-signal similarity breakdown, each in [0, 1]. NaN-free; missing signals are 0. */
export interface MatchEvidence {
  readonly label: number;
  readonly neighbors: number;
  readonly types: number;
  readonly attrs: number;
}

export interface NodeMatch {
  readonly before: Id;
  readonly after: Id;
  readonly method: MatchMethod;
  /** 1 for id and hint matches. */
  readonly score: number;
  readonly evidence?: MatchEvidence;
}

/** A plausible pairing that was *not* applied. Rendered as a dotted "maybe the same?" link. */
export interface MatchSuggestion {
  readonly before: Id;
  readonly after: Id;
  readonly score: number;
  readonly evidence: MatchEvidence;
  readonly reason: 'below-threshold' | 'ambiguous';
}

export interface MatchResult {
  /** All accepted matches (id, hint and similarity), sorted by `after`. */
  readonly matches: readonly NodeMatch[];
  readonly suggestions: readonly MatchSuggestion[];
}

// ─── 3. Diff: the union graph ────────────────────────────────────────────────

export type ChangeStatus = 'unchanged' | 'added' | 'removed' | 'modified';

/** `before` undefined → attribute added; `after` undefined → removed. Sorted by key. */
export interface AttrChange {
  readonly key: string;
  readonly before?: AttrValue;
  readonly after?: AttrValue;
}

export interface SetChange {
  /** Sorted. */
  readonly added: readonly string[];
  /** Sorted. */
  readonly removed: readonly string[];
}

export type NodeFacet =
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'rekey'; readonly from: Id; readonly to: Id; readonly score: number }
  | ({ readonly kind: 'types' } & SetChange)
  | ({ readonly kind: 'aliases' } & SetChange)
  | { readonly kind: 'attrs'; readonly changes: readonly AttrChange[] }
  | {
      readonly kind: 'move';
      readonly predicate: string;
      /** Parents removed (union ids, sorted). */
      readonly from: readonly UnionId[];
      /** Parents added (union ids, sorted). */
      readonly to: readonly UnionId[];
    }
  /** `deprecated: true` became deprecated; `false` was un-deprecated. */
  | { readonly kind: 'deprecate'; readonly deprecated: boolean }
  /**
   * The replacement links changed (`replaces` / `replacedBy`, ids as written). A side that did
   * not change is an empty `SetChange`.
   */
  | { readonly kind: 'replacement'; readonly replaces: SetChange; readonly replacedBy: SetChange }
  | {
      readonly kind: 'mergedInto';
      readonly target: UnionId;
      readonly confidence: number;
      readonly via: 'hint' | 'heuristic';
    }
  | { readonly kind: 'mergeTarget'; readonly sources: readonly UnionId[] }
  | {
      readonly kind: 'splitFrom';
      readonly source: UnionId;
      readonly confidence: number;
      readonly via: 'hint' | 'heuristic';
    }
  | { readonly kind: 'splitInto'; readonly targets: readonly UnionId[] };

export type EdgeFacet =
  | {
      readonly kind: 'retarget';
      /** Which endpoint changed. */
      readonly end: 'source' | 'target';
      readonly from: UnionId;
      readonly to: UnionId;
      /** Why: a direct edit, or carried along by a merge / split / hierarchy move. */
      readonly cause: 'edit' | 'merge' | 'split' | 'move';
    }
  | { readonly kind: 'predicate'; readonly from: string; readonly to: string }
  | { readonly kind: 'label'; readonly from: string; readonly to: string }
  | { readonly kind: 'attrs'; readonly changes: readonly AttrChange[] }
  /** Removed because, after a merge, it would duplicate the union edge `into`. */
  | { readonly kind: 'collapsed'; readonly into: UnionId };

export type NodeFacetKind = NodeFacet['kind'];
export type EdgeFacetKind = EdgeFacet['kind'];
export type FacetKind = NodeFacetKind | EdgeFacetKind;

/** What every union node has, whatever its status. */
export interface UnionNodeBase {
  readonly id: UnionId;
  /** In canonical facet order (docs/algorithms.md §Facet order). */
  readonly facets: readonly NodeFacet[];
  /** The hunk this node's change belongs to. Unchanged nodes have none. */
  readonly hunk?: string;
  /** Display label: after.label ?? before.label. */
  readonly label: string;
  /** after.types ?? before.types. */
  readonly types: readonly string[];
  readonly degree: { readonly before: number; readonly after: number };
}

/** A node of the after version only. */
export interface AddedUnionNode extends UnionNodeBase {
  readonly status: 'added';
  readonly afterId: Id;
  readonly after: KGNode;
  readonly beforeId?: undefined;
  readonly before?: undefined;
}

/** A node of the before version only. */
export interface RemovedUnionNode extends UnionNodeBase {
  readonly status: 'removed';
  readonly beforeId: Id;
  readonly before: KGNode;
  readonly afterId?: undefined;
  readonly after?: undefined;
}

/** A node in both versions (the same id, a replacement hint or a similarity match). */
export interface MatchedUnionNode extends UnionNodeBase {
  /** `modified` exactly when it has a facet. */
  readonly status: 'unchanged' | 'modified';
  readonly beforeId: Id;
  readonly afterId: Id;
  readonly before: KGNode;
  readonly after: KGNode;
}

/**
 * A node of the union graph. `status` decides which versions it is in: `added` has only `after`,
 * `removed` only `before`, `unchanged` and `modified` both (narrow on `status` to read them).
 */
export type UnionNode = AddedUnionNode | RemovedUnionNode | MatchedUnionNode;

/** What every union edge has, whatever its status. */
export interface UnionEdgeBase {
  readonly id: UnionId;
  /** Endpoints in the after version (or the before version for removed edges). */
  readonly source: UnionId;
  readonly target: UnionId;
  readonly predicate: string;
  readonly label: string;
  readonly facets: readonly EdgeFacet[];
  readonly hunk?: string;
  /** True when the predicate is a hierarchy predicate. */
  readonly hierarchical: boolean;
}

/** An edge of the after version only. */
export interface AddedUnionEdge extends UnionEdgeBase {
  readonly status: 'added';
  readonly afterKey: EdgeKey;
  readonly after: KGEdge;
  readonly beforeKey?: undefined;
  readonly before?: undefined;
  readonly sourceBefore?: undefined;
  readonly targetBefore?: undefined;
  readonly predicateBefore?: undefined;
}

/** An edge of the before version only. */
export interface RemovedUnionEdge extends UnionEdgeBase {
  readonly status: 'removed';
  readonly beforeKey: EdgeKey;
  readonly before: KGEdge;
  readonly afterKey?: undefined;
  readonly after?: undefined;
  readonly sourceBefore?: undefined;
  readonly targetBefore?: undefined;
  readonly predicateBefore?: undefined;
}

/** An edge in both versions, paired by identity, by a merge / split, or as a retarget. */
export interface MatchedUnionEdge extends UnionEdgeBase {
  /** `modified` exactly when it has a facet. */
  readonly status: 'unchanged' | 'modified';
  readonly beforeKey: EdgeKey;
  readonly afterKey: EdgeKey;
  readonly before: KGEdge;
  readonly after: KGEdge;
  /** Present only when the before-version endpoint differs (retarget / carried edges). */
  readonly sourceBefore?: UnionId;
  readonly targetBefore?: UnionId;
  /** Present only when the predicate changed. */
  readonly predicateBefore?: string;
}

/**
 * An edge of the union graph. Like `UnionNode`, `status` decides which versions it is in; only
 * edges in both can have changed endpoints or predicate (`sourceBefore`, `targetBefore`,
 * `predicateBefore`).
 */
export type UnionEdge = AddedUnionEdge | RemovedUnionEdge | MatchedUnionEdge;

// ─── Hunks ──────────────────────────────────────────────────────────────────

/**
 * - `add` / `remove`: a connected group of added / removed nodes and their edges.
 * - `merge` / `split`: an identity restructuring with its carried edges.
 * - `modify`: one node's own changes (rename, attrs, types, aliases, move,
 *    deprecation, rekey) plus its outgoing edge changes.
 * - `relations`: edge-only changes owned by an otherwise unchanged source node.
 */
export type HunkKind = 'add' | 'remove' | 'merge' | 'split' | 'modify' | 'relations';

/** Replay order: clean up, restructure, refine, grow. */
export type ReplayPhase = 'remove' | 'restructure' | 'modify' | 'add';

export interface CountTriplet {
  readonly added: number;
  readonly removed: number;
  readonly modified: number;
}

export interface HunkSummary {
  readonly nodes: CountTriplet;
  readonly edges: CountTriplet;
  /** Distinct facet kinds present in the hunk, in canonical order. */
  readonly facets: readonly FacetKind[];
}

export interface Hunk {
  /**
   * `${kind}:${anchor}`, unique in a diff. It depends on the kind and the anchor only: the same
   * two graphs and options give the same ids, and the id says where the hunk is, not what it
   * holds. A contract from 0.9: docs/algorithms.md §7, "Hunk ids", says which edits leave ids
   * alone, which ones group the changes again under other ids, and how to store review progress
   * under an id. Read `kind` and `anchor` instead of parsing the id, since node ids may contain
   * `:`.
   */
  readonly id: string;
  readonly kind: HunkKind;
  readonly phase: ReplayPhase;
  /** The node the hunk is about: camera target, list label. */
  readonly anchor: UnionId;
  /** Changed nodes owned by this hunk (sorted, anchor first; empty for `relations`). */
  readonly nodes: readonly UnionId[];
  /** Changed edges owned by this hunk (sorted). */
  readonly edges: readonly UnionId[];
  /**
   * Nodes needed to read the hunk that it does not own (sorted): endpoints of its edges
   * (old and new), parents named by its moves, and the neighbours of a merge target / split
   * source. They may be unchanged, or changed and owned by another hunk.
   */
  readonly context: readonly UnionId[];
  /**
   * Indices into `delta.ops` that implement this hunk (ascending). Ops that belong to no hunk
   * (id-only rekeys under strategy `similarity`) come first in the delta.
   */
  readonly ops: readonly number[];
  /**
   * Ids of the hunks that must be applied (or played) before this one, derived from the op
   * dependencies (an edge to a node added elsewhere, a node whose edges are removed elsewhere,
   * …), sorted. Applying the hunk-less ops and then every hunk's ops in an order that respects
   * `requires` — such as `order` — succeeds strictly and yields the after graph.
   */
  readonly requires: readonly string[];
  readonly summary: HunkSummary;
  /**
   * Default review order, 0-based and dense: a topological order of `requires`; among the
   * hunks ready at each step, earlier phase first, then larger, then by anchor label, then id.
   * Renderers may refine it (spatially) as long as `requires` stays respected.
   */
  readonly order: number;
}

// ─── Delta: low-level, invertible patch ──────────────────────────────────────

/** Compact JSON form of a node (defaults omitted). */
export interface NodeJSON {
  readonly id: Id;
  readonly label?: string;
  readonly types?: readonly string[];
  readonly aliases?: readonly string[];
  readonly attrs?: Attrs;
  readonly deprecated?: boolean;
  readonly replaces?: readonly Id[];
  readonly replacedBy?: readonly Id[];
  readonly implicit?: boolean;
}

/** Compact JSON form of an edge (defaults omitted). */
export interface EdgeJSON {
  readonly id?: Id;
  readonly source: Id;
  readonly target: Id;
  readonly predicate?: string;
  readonly label?: string;
  readonly attrs?: Attrs;
}

export type NodeField = 'label' | 'types' | 'aliases' | 'deprecated' | 'replaces' | 'replacedBy';
export type NodeFieldValue = string | readonly string[] | boolean;

/**
 * Primitive operations. Every op carries enough "before" information to be
 * inverted and to verify its precondition when applied (docs/delta-format.md).
 */
export type DeltaOp =
  | { readonly op: 'node.rekey'; readonly from: Id; readonly to: Id }
  | { readonly op: 'edge.remove'; readonly edge: EdgeJSON }
  | { readonly op: 'node.remove'; readonly node: NodeJSON }
  | {
      readonly op: 'node.set';
      readonly id: Id;
      readonly field: NodeField;
      readonly from: NodeFieldValue;
      readonly to: NodeFieldValue;
    }
  | {
      readonly op: 'node.attr';
      readonly id: Id;
      readonly key: string;
      readonly from?: AttrValue;
      readonly to?: AttrValue;
    }
  | { readonly op: 'node.add'; readonly node: NodeJSON }
  | { readonly op: 'edge.add'; readonly edge: EdgeJSON }
  | {
      readonly op: 'edge.set';
      readonly edge: EdgeJSON;
      readonly field: 'label';
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly op: 'edge.attr';
      readonly edge: EdgeJSON;
      readonly key: string;
      readonly from?: AttrValue;
      readonly to?: AttrValue;
    };

export type DeltaOpKind = DeltaOp['op'];

export interface GraphRef {
  readonly name?: string;
  readonly version?: string;
  /** Content hash of the normalized graph, e.g. `c53:00f3a9…` (see `hashGraph`). */
  readonly hash: string;
  readonly nodes: number;
  readonly edges: number;
}

export interface Delta {
  readonly format: 'kgdiff.delta';
  readonly version: 1;
  readonly edgeIdentity: EdgeIdentity;
  readonly base: GraphRef;
  readonly target: GraphRef;
  /** In canonical op order (docs/delta-format.md §Canonical order). */
  readonly ops: readonly DeltaOp[];
}

export interface ApplyOptions {
  /** Verify `delta.base.hash` and every op's precondition. Default true. */
  readonly strict?: boolean;
  /**
   * Non-strict mode only: called for every op that is skipped because its precondition fails,
   * with its index in `delta.ops`, the op and the reason — the same text strict mode would put
   * in the `delta-conflict` error. Called in op order, synchronously.
   */
  readonly onSkip?: (skipped: {
    readonly index: number;
    readonly op: DeltaOp;
    readonly reason: string;
  }) => void;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface CountDelta extends CountTriplet {
  readonly unchanged: number;
}

export interface TypeStat extends CountDelta {
  readonly type: string;
}

export interface DiffStats {
  readonly nodes: CountDelta;
  readonly edges: CountDelta;
  readonly before: { readonly nodes: number; readonly edges: number };
  readonly after: { readonly nodes: number; readonly edges: number };
  /** Number of union elements (nodes + edges) carrying each facet kind. */
  readonly facets: Readonly<Record<FacetKind, number>>;
  readonly hunks: Readonly<Record<HunkKind, number>>;
  /** Per node type, sorted by total changes desc then type asc. Untyped nodes use type ''. */
  readonly byType: readonly TypeStat[];
  readonly identical: boolean;
}

// ─── Result ─────────────────────────────────────────────────────────────────

export interface DiffIndex {
  node(id: UnionId): UnionNode | undefined;
  edge(id: UnionId): UnionEdge | undefined;
  hunk(id: string): Hunk | undefined;
  nodeByBefore(id: Id): UnionNode | undefined;
  nodeByAfter(id: Id): UnionNode | undefined;
  /** Incident union edges (both directions), sorted by id. */
  edgesOf(id: UnionId): readonly UnionEdge[];
}

export interface DiffResult {
  readonly before: KGraph;
  readonly after: KGraph;
  readonly options: ResolvedDiffOptions;
  /** Sorted by id. */
  readonly nodes: readonly UnionNode[];
  /** Sorted by id. */
  readonly edges: readonly UnionEdge[];
  /** Sorted by `order`. */
  readonly hunks: readonly Hunk[];
  /**
   * The matches that are not implied by equal ids — methods `hint` and `similarity` — sorted by
   * `after`. (Unlike `MatchResult.matches` from `matchNodes`, which also lists `id` matches.)
   */
  readonly matches: readonly NodeMatch[];
  readonly suggestions: readonly MatchSuggestion[];
  readonly delta: Delta;
  readonly stats: DiffStats;
  /** O(1) lookups. Not serialized. */
  readonly index: DiffIndex;
}

// ─── JSON transport ─────────────────────────────────────────────────────────

/** kgdiff JSON (docs/formats.md §kgdiff JSON), schema `schema/graph.v1.json`. */
export interface GraphJSON {
  readonly format: 'kgdiff.graph';
  readonly version: 1;
  readonly meta?: GraphMeta;
  readonly nodes: readonly NodeJSON[];
  readonly edges: readonly EdgeJSON[];
}

export interface UnionNodeJSON {
  readonly id: UnionId;
  readonly beforeId?: Id;
  readonly afterId?: Id;
  readonly before?: NodeJSON;
  readonly after?: NodeJSON;
  readonly status: ChangeStatus;
  readonly facets?: readonly NodeFacet[];
  readonly hunk?: string;
}

export interface UnionEdgeJSON {
  readonly id: UnionId;
  readonly source: UnionId;
  readonly target: UnionId;
  readonly sourceBefore?: UnionId;
  readonly targetBefore?: UnionId;
  readonly predicateBefore?: string;
  readonly before?: EdgeJSON;
  readonly after?: EdgeJSON;
  readonly status: ChangeStatus;
  readonly facets?: readonly EdgeFacet[];
  readonly hunk?: string;
}

/** Lossless serialization of a `DiffResult` (the graphs are rebuilt from the union). */
export interface DiffJSON {
  readonly format: 'kgdiff.diff';
  readonly version: 1;
  readonly meta: { readonly before: GraphMeta; readonly after: GraphMeta };
  readonly options: ResolvedDiffOptions;
  readonly nodes: readonly UnionNodeJSON[];
  readonly edges: readonly UnionEdgeJSON[];
  readonly hunks: readonly Hunk[];
  readonly matches: readonly NodeMatch[];
  readonly suggestions: readonly MatchSuggestion[];
  readonly delta: Delta;
  readonly stats: DiffStats;
}

/**
 * A `DiffJSON` with its unchanged elements packed into tables (`packDiffJSON`, `unpackDiffJSON`):
 * what HTML reports embed. Unchanged nodes and edges are most of a diff's bytes, so their ids and
 * predicates are written once, in `strings`, and referenced by index. Unpacking gives back the
 * `DiffJSON`, byte for byte. Schema `schema/diff-packed.v1.json`.
 */
export interface PackedDiffJSON extends Omit<DiffJSON, 'format' | 'nodes' | 'edges'> {
  readonly format: 'kgdiff.diff.packed';
  readonly version: 1;
  /** The ids and predicates `unchangedNodes` and `unchangedEdges` refer to, each once. */
  readonly strings: readonly string[];
  /**
   * Unchanged nodes whose union, before and after ids are one id and whose before snapshot is not
   * stored, as flat pairs: the id (an index into `strings`), then the after snapshot without its
   * `id` (0 when nothing else is left).
   */
  readonly unchangedNodes: readonly (number | Omit<NodeJSON, 'id'>)[];
  /**
   * Unchanged edges identified by their triple, with no id, label or attributes of their own, as
   * flat triples of indices into `strings`: source, predicate ('' for none), target.
   */
  readonly unchangedEdges: readonly number[];
  /** Every other union node, as in `DiffJSON`, sorted by id. */
  readonly nodes: readonly UnionNodeJSON[];
  /** Every other union edge, as in `DiffJSON`, sorted by id. */
  readonly edges: readonly UnionEdgeJSON[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type KgdiffErrorCode =
  | 'invalid-input'
  | 'dangling-edge'
  | 'delta-base-mismatch'
  | 'delta-conflict'
  | 'unsupported-version';
