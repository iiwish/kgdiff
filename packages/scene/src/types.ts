/**
 * @kgdiff/scene: the renderer-agnostic visual model of a graph diff.
 *
 * scene = diff semantics → visual primitives. Renderers (canvas, G6, …) never
 * interpret diff semantics themselves: they draw the `FrameVisuals` produced by
 * a `VisualResolver` for a given `ViewState`. This keeps every renderer
 * pixel-consistent and puts the visual language in exactly one place
 * (docs/visual-language.md).
 *
 * Coordinates are world units (y down). Sizes marked "px" are screen pixels and
 * must NOT be scaled by the camera zoom.
 *
 * Curve convention (edges and glyphs): a line from P1 to P2 with curvature `c` is the quadratic
 * Bézier whose control point is the chord midpoint + `c · (−dy, dx)` with `(dx, dy) = P2 − P1`
 * (so the apex lies `c / 2 · |P2 − P1|` from the chord). `c = 0` is straight; the sign is
 * relative to the line's own direction.
 */
import type {
  ChangeStatus,
  DiffStats,
  GraphMeta,
  HunkKind,
  Locale,
  Rect,
  ReplayPhase,
  UnionId,
} from '@kgdiff/core';

// ─── Design tokens ───────────────────────────────────────────────────────────

export type ThemeName = 'light' | 'dark';
export type PaletteName = 'default' | 'colorblind';

/**
 * Meaning families: the core of the visual language. Color always means one of these.
 *  - added:     exists only in the after version
 *  - removed:   exists only in the before version
 *  - content:   same thing, different content (rename, attributes, types, aliases, deprecation)
 *  - structure: same thing, different place (hierarchy move, retarget, predicate change)
 *  - identity:  the notion of "which thing" changed (merge, split, rekey, suggestions)
 *  - neutral:   unchanged context
 */
export type Family = 'added' | 'removed' | 'content' | 'structure' | 'identity' | 'neutral';
export type ChangeFamily = Exclude<Family, 'neutral'>;

export interface FamilyColors {
  /** Marks: fills, strokes, rings. ≥ 3:1 contrast against the canvas background. */
  readonly base: string;
  /** Emphasis: selected / hovered marks. */
  readonly strong: string;
  /** Translucent tint: badge backgrounds, halos, row highlights. */
  readonly soft: string;
  /**
   * Text on panels and canvas. ≥ 4.5:1 against `surface.panel`, `surface.raised` and
   * `canvas.background`, and over its own `soft` tint composited on each of them (badges, chips).
   */
  readonly text: string;
}

export interface Theme {
  readonly name: ThemeName;
  readonly palette: PaletteName;
  readonly canvas: {
    readonly background: string;
    /** Dot-grid color (already includes its alpha). */
    readonly grid: string;
  };
  readonly surface: {
    readonly panel: string;
    readonly raised: string;
    /** Translucent overlay (floating toolbars) — used with backdrop blur. */
    readonly overlay: string;
    /** Hairlines (dividers, card edges). Decorative: no contrast requirement. */
    readonly border: string;
    readonly borderStrong: string;
    /**
     * Boundaries of interactive controls (inputs, the unchecked "reviewed" circle, toggles):
     * ≥ 3:1 against panel, raised and canvas (WCAG 1.4.11).
     */
    readonly controlBorder: string;
    /** CSS box-shadow for floating surfaces. */
    readonly shadow: string;
  };
  /** All ≥ 4.5:1 against `surface.panel`, `surface.raised` and `canvas.background`. */
  readonly text: {
    readonly primary: string;
    readonly secondary: string;
    /** Informative small text (old names, captions). */
    readonly muted: string;
  };
  /**
   * Selection, focus rings and primary UI affordances. Never used to encode change.
   * `base` ≥ 3:1 against panel, raised and canvas (usable as a 2 px focus indicator).
   */
  readonly accent: FamilyColors;
  readonly neutral: {
    readonly node: string;
    readonly nodeStroke: string;
    readonly edge: string;
    readonly label: string;
  };
  readonly family: Readonly<Record<ChangeFamily, FamilyColors>>;
  /** Dark themes render halos as soft glows; light themes as crisp offset rings. */
  readonly glow: boolean;
  readonly font: {
    /** CSS font-family stack including CJK fallbacks. */
    readonly family: string;
    readonly mono: string;
    /** Base label size (px). */
    readonly size: number;
    readonly weightRegular: number;
    readonly weightStrong: number;
  };
  readonly motion: {
    /** ms */
    readonly fast: number;
    readonly base: number;
    readonly slow: number;
    /** cubic-bezier control points. */
    readonly easing: readonly [number, number, number, number];
  };
}

// ─── Scene ──────────────────────────────────────────────────────────────────

export type NodeRole =
  | 'unchanged'
  | 'added'
  | 'removed'
  | 'modified'
  | 'deprecated'
  | 'merge-source'
  | 'merge-target'
  | 'split-source'
  | 'split-target';

/**
 * What a node is drawn as: what kind of thing it is, never what changed about it
 * (docs/visual-language.md §Shape says what kind). Every shape fits the square of half side `r`
 * around the node's center, so the layout does not depend on it.
 *
 * @experimental Becomes stable in 1.0.
 */
export type NodeShape = 'circle' | 'square' | 'diamond' | 'hexagon';

export type EdgeRole =
  | 'unchanged'
  | 'added'
  | 'removed'
  | 'modified'
  /** Endpoint changed by an edit or a hierarchy move. */
  | 'retarget'
  /** Endpoint changed because a merge / split carried it. */
  | 'carried'
  /** Removed because a merge made it a duplicate. */
  | 'collapsed';

export interface SceneNode {
  readonly index: number;
  readonly id: UnionId;
  readonly x: number;
  readonly y: number;
  /** World units. */
  readonly r: number;
  readonly status: ChangeStatus;
  readonly role: NodeRole;
  readonly family: Family;
  /**
   * Family the node is drawn in in the `before` layer: merge / split targets that existed before
   * show their own facets there (`neutral` when they have none); otherwise equal to `family`.
   */
  readonly familyBefore: Family;
  /** Current (after) display label, or the before label for removed nodes. */
  readonly label: string;
  /** Set only when renamed. */
  readonly labelBefore?: string;
  /** Compact change summary for badges, e.g. `+2 −1 ~1`. */
  readonly badge?: string;
  /**
   * From `SceneOptions.shapes`; absent means a circle.
   *
   * @experimental Becomes stable in 1.0.
   */
  readonly shape?: NodeShape;
  /**
   * merge-source / split-target: index of the node it flows into / out of during replay;
   * deprecated: index of its replacement (`replacedBy`), when in the scene.
   */
  readonly flow?: number;
  /** Index into `scene.hunks`, or -1. */
  readonly hunk: number;
  readonly presentBefore: boolean;
  readonly presentAfter: boolean;
  readonly implicit: boolean;
  readonly degree: number;
  /** Neighbours left out of the layout (scope `changes`). */
  readonly hidden: number;
  /**
   * Label priority in [0, 1] from the degree percentile: changed nodes 0.8–1, unchanged 0–0.75
   * (so every changed node outranks every unchanged one).
   */
  readonly importance: number;
}

export interface SceneEdge {
  readonly index: number;
  readonly id: UnionId;
  /** Node indices of the after-version endpoints (before-version for removed edges). */
  readonly s: number;
  readonly t: number;
  /** Node indices of the before-version endpoints (equal to s / t unless retargeted / carried). */
  readonly sb: number;
  readonly tb: number;
  readonly status: ChangeStatus;
  readonly role: EdgeRole;
  readonly family: Family;
  readonly label: string;
  /** Set only when the label or predicate changed. */
  readonly labelBefore?: string;
  /**
   * Signed curvature for parallel edges between the same pair (0 = straight): ±0.18·k fanned
   * around the pair; a lone edge is straight. See the curve convention above.
   */
  readonly curvature: number;
  /** Index into `scene.hunks`, or -1. */
  readonly hunk: number;
  readonly presentBefore: boolean;
  readonly presentAfter: boolean;
  readonly hierarchical: boolean;
}

export interface SceneHunk {
  readonly index: number;
  readonly id: string;
  readonly kind: HunkKind;
  readonly phase: ReplayPhase;
  readonly family: ChangeFamily;
  /** Localized (core `formatHunk`). */
  readonly title: string;
  readonly subtitle: string;
  /** Node index of the anchor, or -1 when it is outside the layout. */
  readonly anchor: number;
  readonly nodes: readonly number[];
  readonly edges: readonly number[];
  readonly context: readonly number[];
  /** Bounds of nodes + context, padded for labels (camera target). */
  readonly bounds: Rect;
}

/** A dotted "maybe the same?" link between an unmatched removed and added node. */
export interface SceneSuggestion {
  readonly before: number;
  readonly after: number;
  readonly score: number;
}

export interface TimelineWindow {
  readonly hunk: number;
  /** ms at 1× speed. Windows of one chapter may overlap (chapter mode plays them together). */
  readonly start: number;
  readonly end: number;
  readonly chapter: number;
}

export interface TimelineChapter {
  readonly phase: ReplayPhase;
  readonly start: number;
  readonly end: number;
  readonly hunks: readonly number[];
  readonly bounds: Rect;
}

export interface Timeline {
  /** ms at 1× speed. */
  readonly duration: number;
  /** One per hunk, in play order. */
  readonly windows: readonly TimelineWindow[];
  readonly chapters: readonly TimelineChapter[];
  /** `hunks`: one hunk at a time. `chapters`: many small hunks play together per phase. */
  readonly mode: 'hunks' | 'chapters';
}

/** A type of `SceneOptions.shapes` that decided the shape of at least one node of the scene. */
export interface SceneShape {
  readonly type: string;
  readonly shape: NodeShape;
}

export interface Scene {
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  /** In review / replay order (spatially refined). */
  readonly hunks: readonly SceneHunk[];
  readonly suggestions: readonly SceneSuggestion[];
  /** Bounds of everything, padded for labels. */
  readonly bounds: Rect;
  readonly stats: DiffStats;
  readonly timeline: Timeline;
  readonly theme: Theme;
  readonly locale: Locale;
  readonly meta: { readonly before: GraphMeta; readonly after: GraphMeta };
  /** Node index by union id. */
  readonly nodeIndex: ReadonlyMap<UnionId, number>;
  readonly edgeIndex: ReadonlyMap<UnionId, number>;
  readonly hunkIndex: ReadonlyMap<string, number>;
  /**
   * The entries of `SceneOptions.shapes` in use, in their order, for legends. Absent without
   * `shapes` or when no node has one of its types.
   *
   * @experimental Becomes stable in 1.0.
   */
  readonly shapes?: readonly SceneShape[];
}

export interface SceneOptions {
  /** Default `dark`. */
  readonly theme?: Theme | ThemeName;
  /** Default `default`. Ignored when `theme` is a Theme object. */
  readonly palette?: PaletteName;
  /** Default `en`. */
  readonly locale?: Locale;
  readonly replay?: {
    /** Average ms per hunk at 1×. Default 1100. */
    readonly pace?: number;
    /** Above this many hunks the timeline switches to chapter mode. Default 40. */
    readonly chapterThreshold?: number;
  };
  /**
   * Node type → shape. A node takes the shape of the first entry, in this order, that is among
   * its types (the after version's; the before version's for a removed node); with none, a
   * circle. A change of type does not animate the shape.
   *
   * @experimental Becomes stable in 1.0.
   */
  readonly shapes?: Readonly<Record<string, NodeShape>>;
}

// ─── View state ─────────────────────────────────────────────────────────────

/**
 * Which version is shown:
 *  - `union`: overlay of both versions (default).
 *  - `before` / `after`: one version only, with changed elements still colored.
 *  - `replay`: the before version morphing into the after version, driven by `t`.
 */
export type Layer = 'union' | 'before' | 'after' | 'replay';

export interface FocusState {
  /** 1 = visible, by node index. */
  readonly nodes: Uint8Array;
  /** 1 = visible, by edge index. */
  readonly edges: Uint8Array;
  /** 1 = shown as context (rendered quieter), by node index. */
  readonly context: Uint8Array;
  readonly collapsed: readonly CollapsedGroup[];
}

/** Hidden unchanged nodes summarized as one pill: “+38 unchanged”. */
export interface CollapsedGroup {
  /** Stable across rebuilds: `near:<union id>` (behind a visible node) or `component:<union id>`. */
  readonly id: string;
  /** World position of the pill: centroid of its in-scene members, else just outside its node. */
  readonly x: number;
  readonly y: number;
  /** Hidden nodes, including neighbours left out of the layout (`SceneNode.hidden`). */
  readonly count: number;
  /** In-scene member node indices (may be empty when every member is outside the layout). */
  readonly nodes: readonly number[];
  /**
   * Localized pill text in `scene.locale`, e.g. “+38 unchanged” / “+38 个未变节点”
   * (“+3 hidden” / “+3 个隐藏节点” when a hunk-restricted focus also hides changed nodes).
   */
  readonly label: string;
}

export interface ViewState {
  readonly layer: Layer;
  /** Replay time in ms within [0, timeline.duration]. Used when layer is `replay`. */
  readonly t: number;
  /** Hunk index or -1. Emphasizes the hunk and dims the rest. */
  readonly selectedHunk: number;
  readonly hoveredNode: number;
  readonly hoveredEdge: number;
  readonly selectedNode: number;
  /** Changes-only view; null shows everything. */
  readonly focus: FocusState | null;
  /** Hunk families to emphasize (filter chips). Empty = all. */
  readonly families: ReadonlySet<ChangeFamily>;
  readonly showSuggestions: boolean;
  /** Respect prefers-reduced-motion (crossfades instead of motion). */
  readonly reducedMotion: boolean;
  /**
   * Strength of the selection spotlight in [0, 1] (default 1). Hosts animate it 0 → 1 over
   * `theme.motion.base` when `selectedHunk` changes; the resolver interpolates the dim levels
   * (context 100% → 70%, rest 100% → 18%, rest labels fading out), the selection halos, the
   * selected-edge width and `FrameVisuals.spotlight` by it. The replay spotlight is driven by `t`
   * and ignores it.
   */
  readonly emphasis: number;
}

// ─── Visual primitives (what renderers draw) ────────────────────────────────

export interface LabelVisual {
  text: string;
  color: string;
  /** Relative to the owning node / edge / glyph alpha (renderers multiply). */
  alpha: number;
  /** px */
  size: number;
  weight: number;
  strike: boolean;
  /** Higher wins label collisions. */
  priority: number;
  /** Hidden below this camera zoom (LOD). 0 = always. */
  minZoom: number;
  /**
   * Node labels: px below the node's edge, i.e. the label's top sits at `r·k + offset` below the
   * center (primary 5, the struck old name 19; animated during replay). Edge and glyph labels:
   * px from the curve midpoint (0 = centered on it).
   */
  offset: number;
}

/** Drawn with the owning node's alpha. */
export interface BadgeVisual {
  text: string;
  color: string;
  background: string;
  /** Hidden below this camera zoom (LOD). 0 = always. */
  minZoom: number;
}

export interface NodeVisual {
  visible: boolean;
  x: number;
  y: number;
  /** World units. */
  r: number;
  /** Alpha of the mark; nested ring / halo / label / badge alphas are relative to it. */
  alpha: number;
  /**
   * The family the node is currently drawn in: its own, `neutral` when drawn as context (filtered
   * out, unchanged), `content` for deprecated nodes. For minimaps and legends.
   */
  family: Family;
  /** null = hollow ghost (background-colored fill so edges do not show through). */
  fill: string | null;
  stroke: string | null;
  /** px */
  strokeWidth: number;
  dash: readonly number[] | null;
  /** Concentric ring at `r·k + gap` px, `width` px. `alpha` relative to the node's. */
  ring: { color: string; width: number; gap: number; alpha: number } | null;
  /**
   * Glow (dark themes, `theme.glow`): radial glow of `radius` world units (2.6·r).
   * Offset ring (light themes): `radius` = r, drawn 5 px outside it, 2 px wide.
   * `alpha` relative to the node's.
   */
  halo: { color: string; radius: number; alpha: number } | null;
  label: LabelVisual | null;
  /** Old name under the primary label (renames), drawn struck through. */
  secondaryLabel: LabelVisual | null;
  badge: BadgeVisual | null;
  /**
   * Replay emphasis pulse: 0 = none; otherwise the progress in (0, 1) of one expanding ring that
   * fades out (draw it at growing radius with alpha `1 − pulse`).
   */
  pulse: number;
  /** Draw order inside its pass; higher = later. */
  z: number;
  /**
   * Absent means `circle`; a renderer that does not read it draws circles. The ring, the light
   * halo, the pulse and the ghost's dashes follow the outline; the dark glow stays radial.
   *
   * @experimental Becomes stable in 1.0.
   */
  shape?: NodeShape;
}

export interface EdgeVisual {
  visible: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Radii of the endpoints so the line stops at the node boundary (world units). */
  r1: number;
  r2: number;
  /**
   * Shapes of the endpoints, whose outlines at size `r1` / `r2` the line stops at. Absent means
   * `circle`.
   *
   * @experimental Becomes stable in 1.0.
   */
  shape1?: NodeShape;
  shape2?: NodeShape;
  /** See the curve convention above. */
  curvature: number;
  color: string;
  /** px */
  width: number;
  /** Alpha of the line; the label's alpha is relative to it. */
  alpha: number;
  dash: readonly number[] | null;
  /** Dash offset for flow animation (px). */
  dashOffset: number;
  /** The edge has an arrowhead at its target (every edge is directed). */
  arrow: boolean;
  /**
   * Arrowhead LOD: drawn from this camera zoom on. 0 for changed / selected / hovered edges
   * (always), 1.2 for neutral context.
   */
  arrowMinZoom: number;
  /** Fraction of the edge drawn from the source end, in [0, 1] (grow / retract animations). */
  progress: number;
  /** When true `progress` grows from the target end instead. */
  fromTarget: boolean;
  label: LabelVisual | null;
  z: number;
}

export type GlyphKind =
  | 'merge-arrow'
  | 'split-arrow'
  | 'replacement-arrow'
  | 'edge-ghost'
  | 'move-arrow'
  | 'suggestion'
  | 'pivot';

/**
 * Annotations drawn above edges and below labels.
 *  - `merge-arrow`: arc with arrowhead from a merge source to the node that absorbs it.
 *  - `split-arrow`: arc with arrowhead from a split source to one of its targets.
 *  - `replacement-arrow`: arc with arrowhead from a deprecated node to its replacement.
 *  - `edge-ghost`: the before form of a retargeted / carried edge (where the edge was), drawn
 *    like an edge with an arrowhead: dashed ghost in overlays, solid while crossfading in replay.
 *  - `move-arrow`: reserved; not emitted by the scene.
 *  - `suggestion`: dotted link between a removed and an added node that may be the same, with a
 *    `?` label.
 *  - `pivot`: a dot of diameter `width` px at (x1, y1) — the endpoint a retargeted edge keeps.
 */
export interface GlyphVisual {
  kind: GlyphKind;
  /** Endpoint centers (world units); for `pivot` both are the dot position. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * Radii (world units) at which the line starts / stops, like `EdgeVisual.r1` / `r2`: the node
   * radius plus clearance for its ring. 0 when the endpoint is not a node (`pivot`).
   */
  r1: number;
  r2: number;
  /**
   * Shapes of the endpoints, like `EdgeVisual.shape1` / `shape2`.
   *
   * @experimental Becomes stable in 1.0.
   */
  shape1?: NodeShape;
  shape2?: NodeShape;
  color: string;
  /** Absolute; the label's alpha is relative to it. */
  alpha: number;
  /** px */
  width: number;
  dash: readonly number[] | null;
  /** Fraction drawn, [0, 1]. */
  progress: number;
  /** Bend of the arc (signed, 0 = straight); see the curve convention above. */
  curvature: number;
  label: LabelVisual | null;
}

export interface FrameVisuals {
  /** Same length and order as `scene.nodes`. */
  nodes: NodeVisual[];
  /** Same length and order as `scene.edges`. */
  edges: EdgeVisual[];
  glyphs: GlyphVisual[];
  collapsed: readonly CollapsedGroup[];
  /**
   * Spotlight strength in [0, 1], for renderer-wide effects (e.g. dimming the grid): 0 = no
   * spotlight; 1 = non-emphasized elements fully dimmed (a selected hunk at `view.emphasis` 1,
   * or a replay window between its spotlight and settle phases; both ramp in between).
   */
  spotlight: number;
}

export interface VisualResolver {
  readonly scene: Scene;
  /**
   * Resolve every element for `view`. When `out` is given its arrays and element objects are
   * reused: no object or array allocations in steady state (replay at 60 fps). Transient V8
   * number boxing while replay animations run (a few KB per frame at most) is tolerated. Since
   * `out` is mutated in place, hand it to the renderer again (`renderer.setFrame(frame)`) after
   * each call; every call is a change.
   */
  resolve(view: ViewState, out?: FrameVisuals): FrameVisuals;
}
