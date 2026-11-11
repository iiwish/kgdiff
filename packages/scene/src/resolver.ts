/**
 * `createVisualResolver`: ViewState → FrameVisuals, the per-frame heart of the visual language.
 *
 * Construction precomputes everything static (per-layer styles, label strings, color ramps,
 * the replay choreography, glyph specs). `resolve(view, out)` then copies styles into the
 * reused `out` objects, animates only the elements inside active replay windows and applies
 * the view modulators (focus, family filter, spotlight, hover, selection, LOD).
 *
 * Allocation guarantee: with `out`, steady-state frames allocate no objects and no arrays —
 * element objects, nested ring / halo / label / badge objects and glyph objects are pooled per
 * frame object, and every per-element number is read from flat typed-array snapshots. What
 * remains is transient V8 HeapNumber boxing of doubles in code the JIT has not inlined or
 * optimized yet: none in static frames (union / before / after, hover, selection, filters), a
 * few boxes per *animating* element in replay (measured ≲ 1–10 KB per frame for thousands of
 * nodes, depending on JIT tier and module format). That is short-lived young-generation garbage,
 * collected by scavenges in well under a millisecond, and is tolerated by design.
 *
 * Alpha convention: `NodeVisual.alpha` / `EdgeVisual.alpha` / `GlyphVisual.alpha` apply to the
 * mark; nested alphas (ring, halo, labels; badges have none) are relative to it.
 */
import { KgdiffError } from '@kgdiff/core';
import {
  CHOREO,
  type Choreography,
  choreograph,
  EA_FADE,
  EA_FOLLOW_MERGE,
  EA_FOLLOW_SPLIT,
  EA_GROW,
  EA_NONE,
  EA_RETRACT,
  EA_SWAP,
  EA_SWING,
  NA_ADD,
  NA_EMERGE,
  NA_FADE,
  NA_NONE,
  NA_REMOVE,
  NA_TRAVEL,
} from './choreography.js';
import { type ColorRamp, rampAt } from './color.js';
import {
  DASH_DOTTED,
  DASH_EDGE,
  DASH_GHOST,
  EMPHASIS,
  LABEL,
  LOD,
  PHASE,
  STROKE,
} from './constants.js';
import { backOut, bump, clamp01, easeInOut, easeStandard, lerp, segment } from './easing.js';
import { edgeCurvatures } from './geometry.js';
import { shapeDistance } from './shapes.js';
import {
  type EdgeStyle,
  EL_BEFORE,
  EL_NONE,
  EL_UNION,
  edgeLayerStyles,
  F_IDENTITY,
  F_NEUTRAL,
  F_REMOVED,
  F_STRUCTURE,
  FAMILY_BY_CODE,
  familyCode,
  type NodeStyle,
  nodeLayerStyles,
  StyleBook,
  type Tokens,
  tokensFor,
} from './styles.js';
import type {
  BadgeVisual,
  ChangeFamily,
  CollapsedGroup,
  EdgeVisual,
  Family,
  FocusState,
  FrameVisuals,
  GlyphKind,
  GlyphVisual,
  LabelVisual,
  NodeShape,
  NodeVisual,
  Scene,
  ViewState,
  VisualResolver,
} from './types.js';

type Ring = NonNullable<NodeVisual['ring']>;
type Halo = NonNullable<NodeVisual['halo']>;

const L_UNION = 0;
const L_BEFORE = 1;
const L_AFTER = 2;
const L_REPLAY = 3;

const SPOT_END = PHASE.spotlightEnd;
const SETTLE = PHASE.settleStart;
const TRANSFORM = SETTLE - SPOT_END;

const CHANGE_FAMILIES: readonly ChangeFamily[] = [
  'added',
  'removed',
  'content',
  'structure',
  'identity',
];
const NO_GROUPS: readonly CollapsedGroup[] = Object.freeze([]);

/** Glyph roles (what a glyph spec is for). */
const G_TRAIL = 0;
const G_REPLACEMENT = 1;
const G_GHOST = 2;
const G_PIVOT = 3;
const G_SUGGESTION = 4;

interface GlyphSpec {
  readonly role: number;
  readonly kind: GlyphKind;
  /** From / to node indices (pivot: the fixed node / the new far end). */
  readonly a: number;
  readonly b: number;
  /** Driving edge (ghost, pivot) or -1. */
  readonly edge: number;
  /** Driving node (trail traveller, deprecated node) or -1. */
  readonly node: number;
  readonly hunk: number;
  readonly family: number;
  readonly color: string;
  readonly alpha: number;
  readonly width: number;
  readonly dash: readonly number[] | null;
  readonly curvature: number;
  /** Extra world-unit clearance beyond each endpoint's radius. */
  readonly clearA: number;
  readonly clearB: number;
  readonly label: string | null;
}

interface FramePool {
  readonly n: number;
  readonly m: number;
  readonly rings: Ring[];
  readonly halos: Halo[];
  readonly labels: LabelVisual[];
  readonly secondaries: LabelVisual[];
  readonly badges: BadgeVisual[];
  readonly edgeLabels: LabelVisual[];
  readonly glyphs: GlyphVisual[];
  readonly glyphLabels: LabelVisual[];
}

const newLabel = (): LabelVisual => ({
  text: '',
  color: '',
  alpha: 0,
  size: 0,
  weight: 400,
  strike: false,
  priority: 0,
  minZoom: 0,
  offset: 0,
});

const newNode = (): NodeVisual => ({
  visible: false,
  x: 0,
  y: 0,
  r: 0,
  alpha: 0,
  family: 'neutral',
  fill: null,
  stroke: null,
  strokeWidth: 0,
  dash: null,
  ring: null,
  halo: null,
  label: null,
  secondaryLabel: null,
  badge: null,
  pulse: 0,
  z: 0,
});

const newEdge = (): EdgeVisual => ({
  visible: false,
  x1: 0,
  y1: 0,
  x2: 0,
  y2: 0,
  r1: 0,
  r2: 0,
  curvature: 0,
  color: '',
  width: 0,
  alpha: 0,
  dash: null,
  dashOffset: 0,
  arrow: false,
  arrowMinZoom: 0,
  progress: 1,
  fromTarget: false,
  label: null,
  z: 0,
});

const newGlyph = (): GlyphVisual => ({
  kind: 'pivot',
  x1: 0,
  y1: 0,
  x2: 0,
  y2: 0,
  r1: 0,
  r2: 0,
  color: '',
  alpha: 0,
  width: 0,
  dash: null,
  progress: 1,
  curvature: 0,
  label: null,
});

function hideNode(v: NodeVisual): void {
  v.visible = false;
  v.alpha = 0;
  v.ring = null;
  v.halo = null;
  v.label = null;
  v.secondaryLabel = null;
  v.badge = null;
  v.pulse = 0;
}

function hideEdge(v: EdgeVisual): void {
  v.visible = false;
  v.alpha = 0;
  v.label = null;
}

class SceneResolver implements VisualResolver {
  readonly scene: Scene;
  private readonly t: Tokens;
  private readonly N: number;
  private readonly M: number;
  private readonly H: number;

  // Static per-element data.
  private readonly nStyles: readonly (readonly [NodeStyle, NodeStyle, NodeStyle])[];
  private readonly eStyles: readonly (readonly [EdgeStyle, EdgeStyle, EdgeStyle])[];
  private readonly nFam: Uint8Array;
  private readonly nHunk: Int32Array;
  private readonly nHunkFam: Uint8Array;
  private readonly eFam: Uint8Array;
  private readonly eHunk: Int32Array;
  private readonly eHunkFam: Uint8Array;
  private readonly eUnionText: readonly string[];
  private readonly ghostCurv: Float64Array;
  private readonly fillRamp: (ColorRamp | null)[];
  private readonly strokeRamp: (ColorRamp | null)[];
  private readonly ringRamp: (ColorRamp | null)[];
  private readonly c: Choreography;
  private readonly glyphs: readonly GlyphSpec[];
  private readonly glyphLists: readonly (readonly number[])[];
  private readonly famBit: Uint8Array;

  // Flat snapshots of the scene. Scene objects come in several shapes (optional fields), and
  // reading their double fields at a megamorphic site boxes a fresh heap number per load; flat
  // arrays keep the frame loop monomorphic and allocation-free.
  private readonly nx: Float64Array;
  private readonly ny: Float64Array;
  private readonly nr: Float64Array;
  private readonly nImp: Float64Array;
  private readonly nFlow: Int32Array;
  private readonly nLabel: readonly string[];
  private readonly nLabelBefore: readonly (string | null)[];
  private readonly nBadge: readonly (string | null)[];
  /** Shape by node index; null when every node is a circle (then frames carry no shape keys). */
  private readonly nShape: readonly (NodeShape | undefined)[] | null;
  private readonly eS: Int32Array;
  private readonly eT: Int32Array;
  private readonly eSB: Int32Array;
  private readonly eTB: Int32Array;
  private readonly eCurv: Float64Array;
  private readonly eLabel: readonly string[];
  private readonly eLabelBefore: readonly (string | null)[];
  private readonly eUnchanged: Uint8Array;
  private readonly hNodes: readonly Int32Array[];
  private readonly hContext: readonly Int32Array[];
  private readonly hEdges: readonly Int32Array[];
  private readonly hFam: Uint8Array;
  private readonly chapterMode: boolean;
  private readonly chStart: Float64Array;
  private readonly chEnd: Float64Array;
  private readonly chHunks: readonly Int32Array[];

  // Replay state.
  private readonly wStart: Float64Array;
  private readonly wEnd: Float64Array;
  private readonly hState: Uint8Array;
  private readonly hP: Float64Array;
  private readonly levelGen: Uint32Array;
  private readonly level: Uint8Array;
  private readonly edgeGen: Uint32Array;
  private readonly pulseGen: Uint32Array;
  private readonly pulseVal: Float32Array;
  private gen = 0;
  private env = 0;

  // Selection state (cached per selected hunk).
  private readonly selNode: Uint8Array;
  private selHunk = -1;

  // Per-frame context.
  private view: ViewState | null = null;
  private layer = L_UNION;
  private famMask = 0;
  private reduced = false;
  /** Set by style application: whether the drawn style is "changed" and its family code. */
  private curChanged = false;
  private curFamily = F_NEUTRAL;
  /**
   * Per-element doubles are handed to helper methods through these fields rather than as
   * arguments: V8 boxes a double argument or return value at every non-inlined call, while a
   * double field is updated in place.
   */
  private u = 0;
  private tau = 0;
  private time = 0;
  /** `view.emphasis`, clamped: strength of the selection spotlight. */
  private emph = 1;
  /** Relative alpha of labels outside the selected hunk and its context (fade out as emph → 1). */
  private restLabels = 1;
  /** Label LOD thresholds for this frame (small scenes label more). */
  private lodChanged: number = LOD.changedLabel;
  private lodNeutral: number = LOD.neutralLabel;
  private lodImportant: number = LOD.importantNeutralLabel;
  /** Visible-node count per focus object (cached: a focus is immutable). */
  private countedFocus: FocusState | null = null;
  private focusCount = 0;
  private px = 0;
  private py = 0;

  private readonly pools = new WeakMap<FrameVisuals, FramePool>();

  constructor(scene: Scene) {
    this.scene = scene;
    this.t = tokensFor(scene.theme);
    const N = scene.nodes.length;
    const M = scene.edges.length;
    const H = scene.hunks.length;
    this.N = N;
    this.M = M;
    this.H = H;
    const book = new StyleBook(this.t);
    this.nStyles = scene.nodes.map((n) => nodeLayerStyles(book, n));
    this.eStyles = scene.edges.map((e) => edgeLayerStyles(book, e));

    const hunkFam = (h: number): number => {
      const hunk = h >= 0 ? scene.hunks[h] : undefined;
      return hunk === undefined ? F_NEUTRAL : familyCode(hunk.family);
    };
    this.nFam = Uint8Array.from(scene.nodes, (n) => familyCode(n.family));
    this.nHunk = Int32Array.from(scene.nodes, (n) => n.hunk);
    this.nHunkFam = Uint8Array.from(scene.nodes, (n) => hunkFam(n.hunk));
    this.eFam = Uint8Array.from(scene.edges, (e) => familyCode(e.family));
    this.eHunk = Int32Array.from(scene.edges, (e) => e.hunk);
    this.eHunkFam = Uint8Array.from(scene.edges, (e) => hunkFam(e.hunk));
    this.eUnionText = scene.edges.map((e) =>
      e.labelBefore === undefined ? e.label : `${e.labelBefore} → ${e.label}`,
    );
    this.ghostCurv = edgeCurvatures(scene.edges).ghost;
    this.famBit = Uint8Array.from([1, 2, 4, 8, 16, 0]);
    this.nx = Float64Array.from(scene.nodes, (n) => n.x);
    this.ny = Float64Array.from(scene.nodes, (n) => n.y);
    this.nr = Float64Array.from(scene.nodes, (n) => n.r);
    this.nImp = Float64Array.from(scene.nodes, (n) => n.importance);
    this.nFlow = Int32Array.from(scene.nodes, (n) => n.flow ?? -1);
    this.nLabel = scene.nodes.map((n) => n.label);
    this.nLabelBefore = scene.nodes.map((n) => n.labelBefore ?? null);
    this.nBadge = scene.nodes.map((n) => n.badge ?? null);
    this.nShape = scene.nodes.some((n) => n.shape !== undefined)
      ? scene.nodes.map((n) => n.shape)
      : null;
    this.eS = Int32Array.from(scene.edges, (e) => e.s);
    this.eT = Int32Array.from(scene.edges, (e) => e.t);
    this.eSB = Int32Array.from(scene.edges, (e) => e.sb);
    this.eTB = Int32Array.from(scene.edges, (e) => e.tb);
    this.eCurv = Float64Array.from(scene.edges, (e) => e.curvature);
    this.eLabel = scene.edges.map((e) => e.label);
    this.eLabelBefore = scene.edges.map((e) => e.labelBefore ?? null);
    this.eUnchanged = Uint8Array.from(scene.edges, (e) => (e.status === 'unchanged' ? 1 : 0));
    this.hNodes = scene.hunks.map((h) => Int32Array.from(h.nodes));
    this.hContext = scene.hunks.map((h) => Int32Array.from(h.context));
    this.hEdges = scene.hunks.map((h) => Int32Array.from(h.edges));
    this.hFam = Uint8Array.from(scene.hunks, (h) => familyCode(h.family));
    this.chapterMode = scene.timeline.mode === 'chapters';
    this.chStart = Float64Array.from(scene.timeline.chapters, (c) => c.start);
    this.chEnd = Float64Array.from(scene.timeline.chapters, (c) => c.end);
    this.chHunks = scene.timeline.chapters.map((c) => Int32Array.from(c.hunks));

    // Color ramps for crossfading styles (only where the colors differ).
    const bg = this.t.background;
    const ramps = this.t.ramps;
    this.fillRamp = [];
    this.strokeRamp = [];
    this.ringRamp = [];
    for (let i = 0; i < N; i++) {
      const [, B, A] = this.nStyles[i] as readonly [NodeStyle, NodeStyle, NodeStyle];
      const bFill = B.hidden ? null : B.fill;
      const aFill = A.hidden ? null : A.fill;
      // REMOVE drains the fill into the background; FADE ramps before → after.
      this.fillRamp.push(
        !B.hidden && A.hidden
          ? ramps.get(bFill ?? bg, bg)
          : bFill !== aFill && !B.hidden
            ? ramps.get(bFill ?? bg, aFill ?? bg)
            : null,
      );
      this.strokeRamp.push(
        !B.hidden && !A.hidden && B.stroke !== A.stroke && B.stroke !== null && A.stroke !== null
          ? ramps.get(B.stroke, A.stroke)
          : null,
      );
      this.ringRamp.push(
        B.ring !== null && A.ring !== null && B.ring !== A.ring ? ramps.get(B.ring, A.ring) : null,
      );
    }
    this.c = choreograph(scene, this.nStyles, this.eStyles);

    // Glyph specs and per-layer lists.
    const specs = this.buildGlyphs();
    this.glyphs = specs;
    const union: number[] = [];
    const after: number[] = [];
    const replay: number[] = [];
    specs.forEach((g, k) => {
      union.push(k);
      if (g.role === G_REPLACEMENT) after.push(k);
      if (g.role !== G_SUGGESTION) replay.push(k);
    });
    this.glyphLists = [union, [], after, replay];

    // Replay buffers.
    this.wStart = new Float64Array(H);
    this.wEnd = new Float64Array(H);
    for (const w of scene.timeline.windows) {
      if (w.hunk >= 0 && w.hunk < H) {
        this.wStart[w.hunk] = w.start;
        this.wEnd[w.hunk] = w.end;
      }
    }
    this.hState = new Uint8Array(H);
    this.hP = new Float64Array(H);
    this.levelGen = new Uint32Array(N);
    this.level = new Uint8Array(N);
    this.edgeGen = new Uint32Array(M);
    this.pulseGen = new Uint32Array(N);
    this.pulseVal = new Float32Array(N);
    this.selNode = new Uint8Array(N);
  }

  // ─── Construction helpers ─────────────────────────────────────────────────

  private buildGlyphs(): GlyphSpec[] {
    const { scene, t } = this;
    const out: GlyphSpec[] = [];
    // One literal shape for every spec keeps reads in the frame loop monomorphic.
    const specs = {
      push: (g: GlyphSpec): void => {
        out.push({
          role: g.role,
          kind: g.kind,
          a: g.a,
          b: g.b,
          edge: g.edge,
          node: g.node,
          hunk: g.hunk,
          family: g.family,
          color: g.color,
          alpha: g.alpha,
          width: g.width,
          dash: g.dash,
          curvature: g.curvature,
          clearA: g.clearA,
          clearB: g.clearB,
          label: g.label,
        });
      },
    };
    const arc = (
      role: number,
      kind: GlyphKind,
      a: number,
      b: number,
      node: number,
      hunk: number,
    ): GlyphSpec => ({
      role,
      kind,
      a,
      b,
      edge: -1,
      node,
      hunk,
      family: F_IDENTITY,
      color: t.base[F_IDENTITY] as string,
      alpha: 0.9,
      width: STROKE.glyph,
      dash: null,
      curvature: CHOREO.arc,
      clearA: 4,
      clearB: 4,
      label: null,
    });
    for (const n of scene.nodes) {
      if (n.flow === undefined) continue;
      if (n.role === 'merge-source')
        specs.push(arc(G_TRAIL, 'merge-arrow', n.index, n.flow, n.index, n.hunk));
      else if (n.role === 'split-target')
        specs.push(arc(G_TRAIL, 'split-arrow', n.flow, n.index, n.index, n.hunk));
      else if (n.role === 'deprecated')
        specs.push(arc(G_REPLACEMENT, 'replacement-arrow', n.index, n.flow, n.index, n.hunk));
    }
    for (const e of scene.edges) {
      if (e.role !== 'retarget' && e.role !== 'carried') continue;
      if (e.sb === e.s && e.tb === e.t) continue;
      const fam = e.role === 'retarget' ? F_REMOVED : F_IDENTITY;
      specs.push({
        role: G_GHOST,
        kind: 'edge-ghost',
        a: e.sb,
        b: e.tb,
        edge: e.index,
        node: -1,
        hunk: e.hunk,
        family: familyCode(e.family),
        color: t.edge[fam] as string,
        alpha: EMPHASIS.ghostEdge,
        width: STROKE.changedEdge,
        dash: DASH_EDGE,
        curvature: this.ghostCurv[e.index] as number,
        clearA: 0,
        clearB: 0,
        label: null,
      });
      if (e.role !== 'retarget') continue;
      const pivot = e.s === e.sb ? e.s : e.t === e.tb ? e.t : -1;
      if (pivot < 0) continue;
      specs.push({
        role: G_PIVOT,
        kind: 'pivot',
        a: pivot,
        b: pivot === e.s ? e.t : e.s,
        edge: e.index,
        node: -1,
        hunk: e.hunk,
        family: F_STRUCTURE,
        color: t.base[F_STRUCTURE] as string,
        alpha: 1,
        width: STROKE.pivot,
        dash: null,
        curvature: 0,
        clearA: 0,
        clearB: 0,
        label: null,
      });
    }
    for (const s of scene.suggestions) {
      specs.push({
        role: G_SUGGESTION,
        kind: 'suggestion',
        a: s.before,
        b: s.after,
        edge: -1,
        node: -1,
        hunk: -1,
        family: F_IDENTITY,
        color: t.base[F_IDENTITY] as string,
        alpha: 0.85,
        width: STROKE.suggestion,
        dash: DASH_DOTTED,
        curvature: 0.12,
        clearA: 2,
        clearB: 2,
        label: '?',
      });
    }
    return out;
  }

  private newFrame(): FrameVisuals {
    return { nodes: [], edges: [], glyphs: [], collapsed: NO_GROUPS, spotlight: 1 };
  }

  private prepare(frame: FrameVisuals): FramePool {
    if (frame.nodes.length !== this.N) frame.nodes.length = this.N;
    if (frame.edges.length !== this.M) frame.edges.length = this.M;
    for (let i = 0; i < this.N; i++) if (frame.nodes[i] === undefined) frame.nodes[i] = newNode();
    for (let j = 0; j < this.M; j++) if (frame.edges[j] === undefined) frame.edges[j] = newEdge();
    let pool = this.pools.get(frame);
    if (pool === undefined || pool.n !== this.N || pool.m !== this.M) {
      const make = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);
      pool = {
        n: this.N,
        m: this.M,
        rings: make(this.N, (): Ring => ({ color: '', width: 0, gap: 0, alpha: 0 })),
        halos: make(this.N, (): Halo => ({ color: '', radius: 0, alpha: 0 })),
        labels: make(this.N, newLabel),
        secondaries: make(this.N, newLabel),
        badges: make(
          this.N,
          (): BadgeVisual => ({ text: '', color: '', background: '', minZoom: 0 }),
        ),
        edgeLabels: make(this.M, newLabel),
        glyphs: make(this.glyphs.length, newGlyph),
        glyphLabels: make(this.glyphs.length, newLabel),
      };
      this.pools.set(frame, pool);
      this.adoptShapes(frame, pool);
    }
    return pool;
  }

  /**
   * Shapes do not animate, so a node's is written once, when a frame is first seen. Its keys are
   * added to every element at once, so all elements of a frame keep one hidden class. Without
   * shapes nothing is added; a frame that served a shaped scene before is cleared.
   */
  private adoptShapes(frame: FrameVisuals, pool: FramePool): void {
    const shapes = this.nShape;
    for (let i = 0; i < this.N; i++) {
      const v = frame.nodes[i] as NodeVisual;
      if (shapes !== null) v.shape = shapes[i];
      else if (v.shape !== undefined) v.shape = undefined;
    }
    for (let j = 0; j < this.M; j++) {
      const e = frame.edges[j] as EdgeVisual;
      if (shapes !== null || e.shape1 !== undefined || e.shape2 !== undefined) {
        e.shape1 = undefined;
        e.shape2 = undefined;
      }
    }
    for (const g of pool.glyphs) {
      if (shapes !== null || g.shape1 !== undefined || g.shape2 !== undefined) {
        g.shape1 = undefined;
        g.shape2 = undefined;
      }
    }
  }

  // ─── Frame ────────────────────────────────────────────────────────────────

  resolve(view: ViewState, out?: FrameVisuals): FrameVisuals {
    const frame = out ?? this.newFrame();
    const pool = this.prepare(frame);
    this.begin(view);
    const nodes = frame.nodes;
    for (let i = 0; i < this.N; i++) this.resolveNode(i, nodes[i] as NodeVisual, pool);
    const edges = frame.edges;
    for (let j = 0; j < this.M; j++) this.resolveEdge(j, edges[j] as EdgeVisual, nodes, pool);
    this.resolveGlyphs(frame, pool);
    frame.collapsed = view.focus === null ? NO_GROUPS : view.focus.collapsed;
    frame.spotlight = this.layer === L_REPLAY ? this.env : this.selHunk >= 0 ? this.emph : 0;
    this.view = null;
    return frame;
  }

  private begin(view: ViewState): void {
    this.view = view;
    switch (view.layer) {
      case 'union':
        this.layer = L_UNION;
        break;
      case 'before':
        this.layer = L_BEFORE;
        break;
      case 'after':
        this.layer = L_AFTER;
        break;
      case 'replay':
        this.layer = L_REPLAY;
        break;
      default:
        throw new KgdiffError('invalid-input', `Unknown layer "${String(view.layer)}".`);
    }
    let mask = 0;
    if (view.families.size > 0) {
      for (let k = 0; k < CHANGE_FAMILIES.length; k++) {
        if (view.families.has(CHANGE_FAMILIES[k] as ChangeFamily)) mask |= 1 << k;
      }
    }
    this.famMask = mask;
    this.reduced = view.reducedMotion;
    const e = view.emphasis;
    this.emph = Number.isFinite(e) ? clamp01(e) : 1;
    this.restLabels = 1 - this.emph;
    const focus = view.focus;
    if (
      focus !== null &&
      (focus.nodes.length !== this.N ||
        focus.edges.length !== this.M ||
        focus.context.length !== this.N)
    ) {
      throw new KgdiffError(
        'invalid-input',
        'view.focus does not belong to this scene (array lengths differ); recompute it with computeFocus(scene).',
      );
    }
    const visibleNodes = focus === null ? this.N : this.focusVisible(focus);
    const small = visibleNodes <= LOD.smallScene;
    this.lodChanged = small ? LOD.smallChangedLabel : LOD.changedLabel;
    this.lodNeutral = small ? LOD.smallNeutralLabel : LOD.neutralLabel;
    this.lodImportant = small ? LOD.smallNeutralLabel : LOD.importantNeutralLabel;
    this.updateSelection(
      view.selectedHunk >= 0 && view.selectedHunk < this.H ? view.selectedHunk : -1,
    );
    this.env = 0;
    if (this.layer === L_REPLAY) {
      this.time = Number.isFinite(view.t) ? view.t : 0;
      this.updateReplay();
    }
  }

  private focusVisible(focus: FocusState): number {
    if (focus !== this.countedFocus) {
      let n = 0;
      const nodes = focus.nodes;
      for (let i = 0; i < nodes.length; i++) if (nodes[i] === 1) n++;
      this.countedFocus = focus;
      this.focusCount = n;
    }
    return this.focusCount;
  }

  private updateSelection(h: number): void {
    if (h === this.selHunk) return;
    this.selNode.fill(0);
    if (h >= 0) {
      const context = this.hContext[h] as Int32Array;
      for (let k = 0; k < context.length; k++) this.selNode[context[k] as number] = 1;
      const nodes = this.hNodes[h] as Int32Array;
      for (let k = 0; k < nodes.length; k++) this.selNode[nodes[k] as number] = 2;
    }
    this.selHunk = h;
  }

  private updateReplay(): void {
    const { H, hState, hP, wStart, wEnd } = this;
    const t = this.time;
    let active = -1;
    for (let h = 0; h < H; h++) {
      const s = wStart[h] as number;
      const e = wEnd[h] as number;
      if (t < s) hState[h] = 0;
      else if (t >= e) hState[h] = 2;
      else {
        hState[h] = 1;
        hP[h] = (t - s) / (e - s);
        active = h;
      }
    }
    this.gen = (this.gen + 1) >>> 0;
    if (this.gen === 0) {
      this.levelGen.fill(0);
      this.edgeGen.fill(0);
      this.pulseGen.fill(0);
      this.gen = 1;
    }
    if (!this.chapterMode) {
      if (active >= 0) {
        // Ramps in over the spotlight phase and out over the settle phase.
        const p = hP[active] as number;
        this.env =
          p < SPOT_END
            ? easeStandard(p / SPOT_END)
            : p > SETTLE
              ? easeStandard((1 - p) / (1 - SETTLE))
              : 1;
        this.markHunk(active);
      }
      return;
    }
    // Chapters: the whole chapter is spotlighted, ramping over its first window's spotlight phase.
    for (let c = 0; c < this.chHunks.length; c++) {
      const start = this.chStart[c] as number;
      const end = this.chEnd[c] as number;
      if (t < start || t >= end) continue;
      const hunks = this.chHunks[c] as Int32Array;
      const first = hunks.length > 0 ? (hunks[0] as number) : -1;
      const ramp = first < 0 ? 1 : SPOT_END * ((wEnd[first] as number) - (wStart[first] as number));
      this.env = easeStandard(clamp01(Math.min(t - start, end - t) / Math.max(ramp, 1e-9)));
      for (let k = 0; k < hunks.length; k++) this.markHunk(hunks[k] as number);
      break;
    }
  }

  /** Emphasize a hunk for the replay spotlight and schedule its pulse. */
  private markHunk(h: number): void {
    const context = this.hContext[h];
    const nodes = this.hNodes[h];
    const edges = this.hEdges[h];
    if (context === undefined || nodes === undefined || edges === undefined) return;
    const { gen, levelGen, level, pulseGen, pulseVal } = this;
    const pulsing = this.hState[h] === 1 && (this.hP[h] as number) < SPOT_END && !this.reduced;
    const pulse = pulsing ? (this.hP[h] as number) / SPOT_END : 0;
    for (let k = 0; k < context.length; k++) {
      const i = context[k] as number;
      if (levelGen[i] !== gen) {
        levelGen[i] = gen;
        level[i] = 1;
      }
      if (pulsing && this.c.hPulseContext[h] === 1) {
        pulseGen[i] = gen;
        pulseVal[i] = pulse;
      }
    }
    for (let k = 0; k < nodes.length; k++) {
      const i = nodes[k] as number;
      levelGen[i] = gen;
      level[i] = 2;
      if (pulsing && this.c.nPulse[i] === 1) {
        pulseGen[i] = gen;
        pulseVal[i] = pulse;
      }
    }
    for (let k = 0; k < edges.length; k++) this.edgeGen[edges[k] as number] = gen;
  }

  /** Spotlight level of a node: 2 emphasized hunk, 1 its context, 0 the rest. */
  private nodeLevel(i: number): number {
    if (this.layer === L_REPLAY)
      return this.levelGen[i] === this.gen ? (this.level[i] as number) : 0;
    return this.selNode[i] as number;
  }

  /**
   * Alpha factor of the spotlight for an element at `level`: the replay spotlight ramps with its
   * window envelope, the selection spotlight with `view.emphasis`.
   */
  private spotlight(level: number): number {
    if (this.layer === L_REPLAY) {
      if (this.env <= 0 || level === 2) return 1;
      return lerp(1, level === 1 ? EMPHASIS.replayContext : EMPHASIS.replayRest, this.env);
    }
    if (this.selHunk < 0 || level === 2) return 1;
    return lerp(1, level === 1 ? EMPHASIS.selectedContext : EMPHASIS.selectedRest, this.emph);
  }

  /** Labels outside the selected hunk and its context fade out with the selection spotlight. */
  private fadesRestLabels(level: number): boolean {
    return this.layer !== L_REPLAY && this.selHunk >= 0 && level === 0;
  }

  private filtered(fam: number, hunkFam: number): boolean {
    const mask = this.famMask;
    return (
      mask !== 0 &&
      ((this.famBit[fam] as number) & mask) === 0 &&
      ((this.famBit[hunkFam] as number) & mask) === 0
    );
  }

  // ─── Nodes ────────────────────────────────────────────────────────────────

  private resolveNode(i: number, v: NodeVisual, pool: FramePool): void {
    v.x = this.nx[i] as number;
    v.y = this.ny[i] as number;
    v.r = this.nr[i] as number;
    v.family = FAMILY_BY_CODE[this.nFam[i] as number] as Family;
    v.pulse = 0;
    v.strokeWidth = STROKE.node;
    const styles = this.nStyles[i] as readonly [NodeStyle, NodeStyle, NodeStyle];
    let ok: boolean;
    if (this.layer !== L_REPLAY) ok = this.applyNode(v, i, styles[this.layer] as NodeStyle, pool);
    else {
      const h = this.nHunk[i] as number;
      const state = h < 0 ? 2 : (this.hState[h] as number);
      if (state === 0) ok = this.applyNode(v, i, styles[L_BEFORE], pool);
      else if (state === 2) ok = this.applyNode(v, i, styles[L_AFTER], pool);
      else {
        const p = this.hP[h] as number;
        if (p < SPOT_END) ok = this.applyNode(v, i, styles[L_BEFORE], pool);
        else if (p >= SETTLE) ok = this.applyNode(v, i, styles[L_AFTER], pool);
        else {
          this.u = (p - SPOT_END) / TRANSFORM;
          ok = this.animateNode(v, i, styles, pool);
        }
      }
      if (ok && this.pulseGen[i] === this.gen) v.pulse = this.pulseVal[i] as number;
    }
    if (!ok) {
      hideNode(v);
      return;
    }
    this.modulateNode(v, i, pool);
  }

  /** Copy a static style into `v` (position / radius already set). Returns visibility. */
  private applyNode(v: NodeVisual, i: number, st: NodeStyle, pool: FramePool): boolean {
    if (st.hidden) return false;
    const t = this.t;
    const before = this.nLabelBefore[i] ?? null;
    v.visible = true;
    v.alpha = 1;
    v.family = FAMILY_BY_CODE[st.family] as Family;
    v.fill = st.fill;
    v.stroke = st.stroke;
    v.dash = st.dash;
    v.z = st.z;
    if (st.ring !== null) {
      const ring = pool.rings[i] as Ring;
      ring.color = st.ring;
      ring.width = STROKE.ring;
      ring.gap = STROKE.ringGap;
      ring.alpha = 1;
      v.ring = ring;
    } else v.ring = null;
    if (st.halo !== null) {
      const halo = pool.halos[i] as Halo;
      halo.color = st.halo;
      halo.radius = v.r * t.haloScale;
      halo.alpha = t.haloAlpha;
      v.halo = halo;
    } else v.halo = null;
    const label = pool.labels[i] as LabelVisual;
    label.text = st.labelBefore && before !== null ? before : (this.nLabel[i] as string);
    label.color = st.labelColor;
    label.alpha = 1;
    label.size = LABEL.size;
    label.weight = st.labelWeight;
    label.strike = st.strike;
    label.offset = LABEL.offset;
    v.label = label;
    if (st.secondary && before !== null) {
      const sec = pool.secondaries[i] as LabelVisual;
      sec.text = before;
      sec.color = t.muted;
      sec.alpha = 1;
      sec.size = LABEL.oldSize;
      sec.weight = t.weightRegular;
      sec.strike = true;
      sec.offset = LABEL.offset + LABEL.secondaryGap;
      v.secondaryLabel = sec;
    } else v.secondaryLabel = null;
    const badge = this.nBadge[i] ?? null;
    if (st.badge && badge !== null) this.setBadge(v, i, badge, st.family, pool);
    else v.badge = null;
    this.curChanged = st.changed;
    this.curFamily = st.family;
    return true;
  }

  private setBadge(v: NodeVisual, i: number, text: string, family: number, pool: FramePool): void {
    const badge = pool.badges[i] as BadgeVisual;
    badge.text = text;
    badge.color = this.t.text[family] as string;
    badge.background = this.t.soft[family] as string;
    v.badge = badge;
  }

  private animateNode(
    v: NodeVisual,
    i: number,
    styles: readonly [NodeStyle, NodeStyle, NodeStyle],
    pool: FramePool,
  ): boolean {
    const c = this.c;
    const u = this.u;
    const kind = c.nKind[i] as number;
    const B = styles[L_BEFORE];
    const A = styles[L_AFTER];
    const reduced = this.reduced;
    switch (kind) {
      case NA_FADE:
        return this.animFade(v, i, B, A, pool);
      case NA_REMOVE:
      case NA_TRAVEL: {
        if (!this.applyNode(v, i, B, pool)) return false;
        if (reduced) {
          v.alpha = 1 - easeStandard(u);
          return v.alpha > 0;
        }
        return kind === NA_REMOVE ? this.animRemove(v, i, B) : this.animTravel(v, i);
      }
      case NA_ADD:
      case NA_EMERGE: {
        if (!this.applyNode(v, i, A, pool)) return false;
        if (reduced) {
          v.alpha = easeStandard(u);
          return v.alpha > 0;
        }
        return kind === NA_ADD ? this.animAdd(v, i) : this.animEmerge(v, i);
      }
      case NA_NONE:
        return this.applyNode(v, i, u < 0.5 ? B : A, pool);
      default:
        return this.applyNode(v, i, A, pool);
    }
  }

  private animFade(v: NodeVisual, i: number, B: NodeStyle, A: NodeStyle, pool: FramePool): boolean {
    const c = this.c;
    const u = this.u;
    const labelBefore = this.nLabelBefore[i] ?? null;
    const badge = this.nBadge[i] ?? null;
    const reduced = this.reduced;
    const k = reduced
      ? easeStandard(u)
      : easeStandard(segment(u, c.nA[i] as number, c.nB[i] as number));
    if (!this.applyNode(v, i, k < 0.5 ? B : A, pool)) return false;
    const t = this.t;
    // Colors.
    const fillRamp = this.fillRamp[i] ?? null;
    if (fillRamp !== null && k > 0 && k < 1) v.fill = rampAt(fillRamp, k);
    const strokeRamp = this.strokeRamp[i] ?? null;
    if (strokeRamp !== null && k > 0 && k < 1) v.stroke = rampAt(strokeRamp, k);
    // Ring: color ramp when both have one, else fade in / out.
    const ring = pool.rings[i] as Ring;
    if (B.ring !== null || A.ring !== null) {
      const ringRamp = this.ringRamp[i] ?? null;
      ring.color =
        A.ring !== null && B.ring !== null
          ? ringRamp !== null
            ? rampAt(ringRamp, k)
            : A.ring
          : (A.ring ?? B.ring ?? '');
      ring.width = STROKE.ring;
      ring.gap = STROKE.ringGap;
      ring.alpha = A.ring !== null && B.ring !== null ? 1 : A.ring !== null ? k : 1 - k;
      v.ring = ring.alpha > 0 ? ring : null;
    }
    if (!reduced && (c.nFlashA[i] as number) >= 0 && v.ring !== null) {
      const f = bump(segment(u, c.nFlashA[i] as number, c.nFlashB[i] as number));
      ring.width = STROKE.ring + STROKE.ring * f;
      ring.alpha = Math.max(ring.alpha, f);
    }
    // Halo.
    if (B.halo !== null || A.halo !== null) {
      const halo = pool.halos[i] as Halo;
      halo.color = (A.halo ?? B.halo) as string;
      halo.radius = v.r * t.haloScale;
      halo.alpha =
        t.haloAlpha * (A.halo !== null && B.halo !== null ? 1 : A.halo !== null ? k : 1 - k);
      v.halo = halo.alpha > 0 ? halo : null;
    }
    // Label: the old name slides up and fades while the new one rises in (crossfade in place
    // with reduced motion).
    if (c.nLabelSwap[i] === 1 && labelBefore !== null) {
      const kOut = reduced ? k : easeStandard(segment(u, CHOREO.labelOut[0], CHOREO.labelOut[1]));
      const kIn = reduced ? k : easeStandard(segment(u, CHOREO.labelIn[0], CHOREO.labelIn[1]));
      const label = pool.labels[i] as LabelVisual;
      label.text = this.nLabel[i] as string;
      label.color = A.labelColor;
      label.weight = A.labelWeight;
      label.strike = A.strike;
      label.alpha = kIn;
      label.offset = LABEL.offset + (reduced ? 0 : CHOREO.labelSlide * (1 - kIn));
      v.label = label;
      const old = pool.secondaries[i] as LabelVisual;
      old.text = labelBefore;
      old.color = B.labelColor;
      old.size = LABEL.size;
      old.weight = B.labelWeight;
      old.strike = false;
      old.alpha = 1 - kOut;
      old.offset = LABEL.offset - (reduced ? 0 : CHOREO.labelSlide * kOut);
      v.secondaryLabel = old.alpha > 0 ? old : null;
    }
    // Badge: ticks in; merge targets count their arrivals up.
    const arrivals = c.nArrivals[i] ?? null;
    const steps = c.nBadgeSteps[i] ?? null;
    if (arrivals !== null && steps !== null) {
      let count = 0;
      if (reduced) count = k >= 0.5 ? arrivals.length : 0;
      else while (count < arrivals.length && (arrivals[count] as number) <= u) count++;
      if (count > 0) this.setBadge(v, i, steps[count - 1] as string, A.family, pool);
      else v.badge = null;
    } else if ((c.nBadgeAt[i] as number) <= 1 && badge !== null) {
      if (reduced ? k >= 0.5 : u >= (c.nBadgeAt[i] as number))
        this.setBadge(v, i, badge, A.family, pool);
      else v.badge = null;
    }
    return true;
  }

  private animRemove(v: NodeVisual, i: number, B: NodeStyle): boolean {
    const c = this.c;
    const u = this.u;
    const s = easeStandard(segment(u, c.nA[i] as number, c.nB[i] as number));
    if (s > 0) {
      v.r = (this.nr[i] as number) * (1 - 0.4 * s);
      const ramp = this.fillRamp[i] ?? null;
      v.fill = s >= 1 || ramp === null ? null : rampAt(ramp, s);
      v.dash = DASH_GHOST;
      v.stroke = this.t.base[B.family] as string;
      if (v.label !== null) v.label.strike = true;
      if (v.ring !== null) v.ring.alpha = 1 - s;
      if (v.halo !== null) {
        v.halo.alpha *= 1 - s;
        v.halo.radius = v.r * this.t.haloScale;
      }
    }
    v.alpha = 1 - easeStandard(segment(u, c.nC[i] as number, 1));
    return v.alpha > 0;
  }

  /** Point at `this.tau` on the travel arc from node `from` to node `to`, into (px, py). */
  private arcPoint(from: number, to: number): void {
    const { nx, ny } = this;
    const x0 = nx[from] as number;
    const y0 = ny[from] as number;
    const x1 = nx[to] as number;
    const y1 = ny[to] as number;
    const tau = this.tau;
    const cx = (x0 + x1) / 2 - CHOREO.arc * (y1 - y0);
    const cy = (y0 + y1) / 2 + CHOREO.arc * (x1 - x0);
    const a = (1 - tau) * (1 - tau);
    const b = 2 * (1 - tau) * tau;
    const d = tau * tau;
    this.px = a * x0 + b * cx + d * x1;
    this.py = a * y0 + b * cy + d * y1;
  }

  private animTravel(v: NodeVisual, i: number): boolean {
    const c = this.c;
    const u = this.u;
    const target = this.nFlow[i] as number;
    if (target < 0) return true;
    const a = c.nA[i] as number;
    const b = c.nB[i] as number;
    this.tau = easeInOut(segment(u, a, b));
    this.arcPoint(i, target);
    v.x = this.px;
    v.y = this.py;
    v.z = 3;
    v.alpha = 1 - segment(u, b, b + CHOREO.arrivalFade);
    if (v.label !== null) v.label.alpha = 1 - segment(u, (a + b) / 2, b);
    if (v.halo !== null) v.halo.radius = v.r * this.t.haloScale;
    return v.alpha > 0;
  }

  private animAdd(v: NodeVisual, i: number): boolean {
    const c = this.c;
    const u = this.u;
    const pop = segment(u, c.nA[i] as number, c.nB[i] as number);
    v.r = pop > 0 ? (this.nr[i] as number) * backOut(pop) : 0;
    if (pop <= 0) return false;
    v.alpha = Math.min(1, pop * 4);
    if (v.halo !== null) v.halo.radius = v.r * this.t.haloScale;
    const labelStart = c.nC[i] as number;
    const la = easeStandard(segment(u, labelStart, Math.min(1, labelStart + CHOREO.labelFadeIn)));
    if (v.label !== null) v.label.alpha = la;
    if (v.secondaryLabel !== null) v.secondaryLabel.alpha = la;
    if (la < 1) v.badge = null;
    return true;
  }

  private animEmerge(v: NodeVisual, i: number): boolean {
    const c = this.c;
    const u = this.u;
    const source = this.nFlow[i] as number;
    if (source < 0) return true;
    const a = c.nA[i] as number;
    const b = c.nB[i] as number;
    const tau = easeInOut(segment(u, a, b));
    this.tau = tau;
    this.arcPoint(source, i);
    v.x = this.px;
    v.y = this.py;
    v.r = (this.nr[i] as number) * (0.5 + 0.5 * tau);
    v.z = 3;
    v.alpha = segment(u, a, a + 0.1);
    if (v.halo !== null) v.halo.radius = v.r * this.t.haloScale;
    const la = easeStandard(segment(u, b - 0.05, Math.min(1, b + CHOREO.labelFadeIn)));
    if (v.label !== null) v.label.alpha = la;
    if (v.secondaryLabel !== null) v.secondaryLabel.alpha = la;
    if (la < 1) v.badge = null;
    return v.alpha > 0;
  }

  private modulateNode(v: NodeVisual, i: number, pool: FramePool): void {
    const view = this.view as ViewState;
    const t = this.t;
    let f = 1;
    const focus = view.focus;
    if (focus !== null) {
      if (focus.nodes[i] !== 1) {
        hideNode(v);
        return;
      }
      if (focus.context[i] === 1) f *= EMPHASIS.focusContext;
    }
    let changed = this.curChanged;
    let family = this.curFamily;
    let neutral = false;
    if (this.filtered(this.nFam[i] as number, this.nHunkFam[i] as number)) {
      neutral = true;
      changed = false;
      family = F_NEUTRAL;
      v.family = 'neutral';
      if (v.fill !== null) v.fill = t.base[F_NEUTRAL] as string;
      v.stroke = t.strong[F_NEUTRAL] as string;
      v.ring = null;
      v.halo = null;
      v.badge = null;
      v.secondaryLabel = null;
      if (v.label !== null) {
        v.label.color = t.neutralLabel;
        v.label.weight = t.weightRegular;
      }
      f *= EMPHASIS.filtered;
    }
    const level = this.nodeLevel(i);
    f *= this.spotlight(level);
    const selLevel = this.selHunk >= 0 ? (this.selNode[i] as number) : 0;
    const fadeLabels = this.fadesRestLabels(selLevel);
    // The selected hunk's elements get halos (fading in with the emphasis).
    if (selLevel === 2 && !neutral && v.halo === null && this.emph > 0) {
      const halo = pool.halos[i] as Halo;
      halo.color = t.base[family] as string;
      halo.radius = v.r * t.haloScale;
      halo.alpha = t.haloAlpha * this.emph;
      v.halo = halo;
    }
    const hovered = view.hoveredNode === i;
    const picked = view.selectedNode === i;
    if (hovered) {
      v.strokeWidth = STROKE.hoveredNode;
      v.stroke = changed ? (t.strong[family] as string) : t.secondary;
      v.z = 4;
    }
    if (picked) {
      const ring = pool.rings[i] as Ring;
      ring.color = t.accent;
      ring.width = STROKE.hoveredNode;
      ring.gap = STROKE.ringGap;
      ring.alpha = 1;
      v.ring = ring;
      v.z = 4;
    }
    v.alpha *= f;
    // LOD and collision priority.
    const imp = this.nImp[i] as number;
    let minZoom: number = changed
      ? this.lodChanged
      : imp >= LOD.importantThreshold
        ? this.lodImportant
        : this.lodNeutral;
    let priority = changed ? 1 + imp : imp;
    if (hovered) {
      minZoom = 0;
      priority = 2 + imp;
    }
    if (selLevel === 2 || picked) {
      minZoom = 0;
      priority = 3 + imp;
    }
    if (fadeLabels && !hovered && !picked) {
      const rest = this.restLabels;
      if (rest <= 0) {
        v.label = null;
        v.secondaryLabel = null;
      } else {
        if (v.label !== null) v.label.alpha *= rest;
        if (v.secondaryLabel !== null) v.secondaryLabel.alpha *= rest;
      }
      // Badges have no alpha of their own: drop them halfway through the fade.
      if (rest < 0.5) v.badge = null;
    }
    // Nested alphas stay relative to v.alpha (renderers multiply).
    if (v.label !== null) {
      v.label.minZoom = minZoom;
      v.label.priority = priority;
    }
    if (v.secondaryLabel !== null) {
      v.secondaryLabel.minZoom = minZoom;
      v.secondaryLabel.priority = priority - 0.5;
    }
    if (v.badge !== null) v.badge.minZoom = selLevel === 2 ? 0 : LOD.badge;
  }

  // ─── Edges ────────────────────────────────────────────────────────────────

  private resolveEdge(
    j: number,
    ev: EdgeVisual,
    nodes: readonly NodeVisual[],
    pool: FramePool,
  ): void {
    const styles = this.eStyles[j] as readonly [EdgeStyle, EdgeStyle, EdgeStyle];
    let ok: boolean;
    if (this.layer !== L_REPLAY)
      ok = this.applyEdge(ev, j, styles[this.layer] as EdgeStyle, nodes, pool);
    else {
      const h = this.eHunk[j] as number;
      const state = h < 0 ? 2 : (this.hState[h] as number);
      if (state === 0) ok = this.applyEdge(ev, j, styles[L_BEFORE], nodes, pool);
      else if (state === 2) ok = this.applyEdge(ev, j, styles[L_AFTER], nodes, pool);
      else {
        const p = this.hP[h] as number;
        if (p < SPOT_END) ok = this.applyEdge(ev, j, styles[L_BEFORE], nodes, pool);
        else if (p >= SETTLE) ok = this.applyEdge(ev, j, styles[L_AFTER], nodes, pool);
        else {
          this.u = (p - SPOT_END) / TRANSFORM;
          ok = this.animateEdge(ev, j, styles, nodes, pool);
        }
      }
    }
    if (!ok) {
      hideEdge(ev);
      return;
    }
    this.modulateEdge(ev, j, pool);
  }

  private setEnds(ev: EdgeVisual, a: NodeVisual, b: NodeVisual): void {
    ev.x1 = a.x;
    ev.y1 = a.y;
    ev.r1 = a.r;
    ev.x2 = b.x;
    ev.y2 = b.y;
    ev.r2 = b.r;
    if (this.nShape !== null) {
      ev.shape1 = a.shape;
      ev.shape2 = b.shape;
    }
  }

  private applyEdge(
    ev: EdgeVisual,
    j: number,
    st: EdgeStyle,
    nodes: readonly NodeVisual[],
    pool: FramePool,
  ): boolean {
    if (st.hidden) return false;
    const es = this.eS[j] as number;
    const et = this.eT[j] as number;
    const esb = this.eSB[j] as number;
    const etb = this.eTB[j] as number;
    const before = st.before && (esb !== es || etb !== et);
    this.setEnds(
      ev,
      nodes[before ? esb : es] as NodeVisual,
      nodes[before ? etb : et] as NodeVisual,
    );
    ev.curvature = (before ? this.ghostCurv[j] : this.eCurv[j]) as number;
    ev.visible = true;
    ev.color = st.color;
    ev.width = st.width;
    ev.alpha = st.alpha;
    ev.dash = st.dash;
    ev.dashOffset = 0;
    ev.arrow = st.arrow;
    ev.arrowMinZoom = st.changed ? 0 : LOD.arrow;
    ev.progress = 1;
    ev.fromTarget = false;
    ev.z = st.z;
    if (st.label === EL_NONE) ev.label = null;
    else {
      const label = pool.edgeLabels[j] as LabelVisual;
      label.text =
        st.label === EL_UNION
          ? (this.eUnionText[j] as string)
          : st.label === EL_BEFORE
            ? (this.eLabelBefore[j] ?? (this.eLabel[j] as string))
            : (this.eLabel[j] as string);
      label.color = st.labelColor;
      label.alpha = 1;
      label.size = LABEL.edgeSize;
      label.weight = this.t.weightRegular;
      label.strike = st.strike;
      label.offset = 0;
      ev.label = label;
    }
    this.curChanged = st.changed;
    this.curFamily = st.family;
    return true;
  }

  private animateEdge(
    ev: EdgeVisual,
    j: number,
    styles: readonly [EdgeStyle, EdgeStyle, EdgeStyle],
    nodes: readonly NodeVisual[],
    pool: FramePool,
  ): boolean {
    const c = this.c;
    const u = this.u;
    const B = styles[L_BEFORE];
    const A = styles[L_AFTER];
    const a = c.eA[j] as number;
    const b = c.eB[j] as number;
    const reduced = this.reduced;
    switch (c.eKind[j]) {
      case EA_GROW: {
        if (!this.applyEdge(ev, j, A, nodes, pool)) return false;
        if (reduced) {
          ev.alpha *= easeStandard(u);
          return ev.alpha > 0;
        }
        const g = easeStandard(segment(u, a, b));
        if (g <= 0) return false;
        ev.progress = g;
        ev.fromTarget = c.eFromTarget[j] === 1;
        if (ev.label !== null)
          ev.label.alpha = easeStandard(segment(u, b - 0.05, Math.min(1, b + 0.15)));
        return true;
      }
      case EA_RETRACT: {
        if (!this.applyEdge(ev, j, B, nodes, pool)) return false;
        if (reduced) {
          ev.alpha *= 1 - easeStandard(u);
          return ev.alpha > 0;
        }
        const g = easeStandard(segment(u, a, b));
        if (g >= 1) return false;
        ev.progress = 1 - g;
        ev.fromTarget = c.eFromTarget[j] === 1;
        if (ev.label !== null) ev.label.alpha = 1 - segment(u, a, a + 0.1);
        return true;
      }
      case EA_SWING: {
        if (!this.applyEdge(ev, j, A, nodes, pool)) return false;
        if (reduced) {
          ev.alpha *= easeStandard(u);
          return ev.alpha > 0;
        }
        this.tau = easeInOut(segment(u, a, b));
        this.swing(ev, j, nodes);
        return true;
      }
      case EA_FOLLOW_MERGE: {
        if (reduced) {
          if (A.hidden) {
            if (!this.applyEdge(ev, j, B, nodes, pool)) return false;
            ev.alpha *= 1 - easeStandard(u);
          } else {
            if (!this.applyEdge(ev, j, A, nodes, pool)) return false;
            ev.alpha *= easeStandard(u);
          }
          return ev.alpha > 0;
        }
        if (u < b || A.hidden) {
          // Rides the travelling source (before form reads its animated position).
          if (!this.applyEdge(ev, j, B, nodes, pool)) return false;
          ev.alpha *= 1 - segment(u, b, b + CHOREO.arrivalFade);
          return ev.alpha > 0;
        }
        return this.applyEdge(ev, j, A, nodes, pool);
      }
      case EA_FOLLOW_SPLIT: {
        if (!this.applyEdge(ev, j, A, nodes, pool)) return false;
        if (reduced) ev.alpha *= easeStandard(u);
        return ev.alpha > 0;
      }
      case EA_FADE: {
        const k = easeStandard(segment(u, a, b));
        if (!this.applyEdge(ev, j, k < 0.5 ? B : A, nodes, pool)) return false;
        if (ev.label !== null && B.label !== A.label) ev.label.alpha = Math.abs(1 - 2 * k);
        if (!reduced) ev.width += bump(k);
        return true;
      }
      case EA_SWAP: {
        if (!this.applyEdge(ev, j, A, nodes, pool)) return false;
        ev.alpha *= easeStandard(reduced ? u : segment(u, a, b));
        return ev.alpha > 0;
      }
      case EA_NONE:
        return this.applyEdge(ev, j, u < 0.5 ? B : A, nodes, pool);
      default:
        return this.applyEdge(ev, j, A, nodes, pool);
    }
  }

  /** Swing the changed end around the pivot (polar interpolation) at progress `this.tau`. */
  private swing(ev: EdgeVisual, j: number, nodes: readonly NodeVisual[]): void {
    const s = this.tau;
    const pivot = this.c.ePivot[j] as number;
    const fixedIsSource = pivot === this.eS[j];
    const from = nodes[(fixedIsSource ? this.eTB[j] : this.eSB[j]) as number] as NodeVisual;
    const to = nodes[(fixedIsSource ? this.eT[j] : this.eS[j]) as number] as NodeVisual;
    const p = nodes[pivot] as NodeVisual;
    const a0 = Math.atan2(from.y - p.y, from.x - p.x);
    let da = Math.atan2(to.y - p.y, to.x - p.x) - a0;
    if (da > Math.PI) da -= 2 * Math.PI;
    else if (da < -Math.PI) da += 2 * Math.PI;
    const rho = lerp(Math.hypot(from.x - p.x, from.y - p.y), Math.hypot(to.x - p.x, to.y - p.y), s);
    const angle = a0 + da * s;
    const x = p.x + rho * Math.cos(angle);
    const y = p.y + rho * Math.sin(angle);
    const r = lerp(from.r, to.r, s);
    if (fixedIsSource) {
      ev.x2 = x;
      ev.y2 = y;
      ev.r2 = r;
      if (this.nShape !== null) ev.shape2 = s < 0.5 ? from.shape : to.shape;
    } else {
      ev.x1 = x;
      ev.y1 = y;
      ev.r1 = r;
      if (this.nShape !== null) ev.shape1 = s < 0.5 ? from.shape : to.shape;
    }
    ev.curvature = lerp(this.ghostCurv[j] as number, this.eCurv[j] as number, s);
  }

  private modulateEdge(ev: EdgeVisual, j: number, pool: FramePool): void {
    const view = this.view as ViewState;
    const es = this.eS[j] as number;
    const et = this.eT[j] as number;
    const t = this.t;
    let f = 1;
    const focus = view.focus;
    if (focus !== null) {
      if (focus.edges[j] !== 1) {
        hideEdge(ev);
        return;
      }
      if (this.eUnchanged[j] === 1 && (focus.context[es] === 1 || focus.context[et] === 1)) {
        f *= EMPHASIS.focusContext;
      }
    }
    let changed = this.curChanged;
    if (this.filtered(this.eFam[j] as number, this.eHunkFam[j] as number)) {
      changed = false;
      ev.color = t.edge[F_NEUTRAL] as string;
      ev.width = STROKE.neutralEdge;
      ev.arrowMinZoom = LOD.arrow;
      if (ev.label !== null) ev.label.color = t.neutralLabel;
      f *= EMPHASIS.filtered;
    }
    let level: number;
    if (this.layer === L_REPLAY) {
      level =
        this.edgeGen[j] === this.gen
          ? 2
          : this.nodeLevel(es) >= 1 && this.nodeLevel(et) >= 1
            ? 1
            : 0;
    } else {
      level =
        this.selHunk >= 0 && this.eHunk[j] === this.selHunk
          ? 2
          : (this.selNode[es] as number) >= 1 && (this.selNode[et] as number) >= 1
            ? 1
            : 0;
    }
    f *= this.spotlight(level);
    const selected = this.selHunk >= 0 && this.eHunk[j] === this.selHunk;
    const hovered = view.hoveredEdge === j;
    let minZoom: number = changed ? LOD.edgeLabel : 0;
    let priority = changed ? 0.9 : 0.4;
    if (selected) {
      if (ev.width < STROKE.selectedEdge) ev.width += (STROKE.selectedEdge - ev.width) * this.emph;
      ev.arrowMinZoom = 0;
      ev.z = Math.max(ev.z, 3);
      minZoom = 0;
      priority = 3;
    }
    if (hovered) {
      ev.width = Math.max(ev.width, STROKE.selectedEdge);
      ev.arrowMinZoom = 0;
      ev.z = 4;
      if (ev.label === null) {
        const label = pool.edgeLabels[j] as LabelVisual;
        label.text = this.eLabel[j] as string;
        label.color = t.neutralLabel;
        label.alpha = 1;
        label.size = LABEL.edgeSize;
        label.weight = t.weightRegular;
        label.strike = false;
        label.offset = 0;
        ev.label = label;
      }
      minZoom = 0;
      priority = Math.max(priority, 2.5);
    }
    if (ev.label !== null && this.fadesRestLabels(level) && !hovered) {
      if (this.restLabels <= 0) ev.label = null;
      else ev.label.alpha *= this.restLabels;
    }
    ev.alpha *= f;
    if (ev.label !== null) {
      ev.label.minZoom = minZoom;
      ev.label.priority = priority;
    }
  }

  // ─── Glyphs ───────────────────────────────────────────────────────────────

  private resolveGlyphs(frame: FrameVisuals, pool: FramePool): void {
    const out = frame.glyphs;
    const list = this.glyphLists[this.layer] as readonly number[];
    let count = 0;
    for (let k = 0; k < list.length; k++) {
      const spec = this.glyphs[list[k] as number] as GlyphSpec;
      const g = pool.glyphs[count] as GlyphVisual;
      if (this.writeGlyph(spec, g, pool.glyphLabels[count] as LabelVisual, frame.nodes)) {
        if (out[count] !== g) out[count] = g;
        count++;
      }
    }
    if (out.length !== count) out.length = count;
  }

  /** Glyph line between node centers; renderers stop it at `r1` / `r2` like an edge. */
  private glyphLine(g: GlyphVisual, spec: GlyphSpec): void {
    const { nx, ny, nr } = this;
    g.x1 = nx[spec.a] as number;
    g.y1 = ny[spec.a] as number;
    g.x2 = nx[spec.b] as number;
    g.y2 = ny[spec.b] as number;
    g.r1 = (nr[spec.a] as number) + spec.clearA;
    g.r2 = (nr[spec.b] as number) + spec.clearB;
    const shapes = this.nShape;
    if (shapes !== null) {
      g.shape1 = shapes[spec.a];
      g.shape2 = shapes[spec.b];
    }
  }

  private writeGlyph(
    spec: GlyphSpec,
    g: GlyphVisual,
    label: LabelVisual,
    nodes: readonly NodeVisual[],
  ): boolean {
    const view = this.view as ViewState;
    const focus = view.focus;
    if (focus !== null && (focus.nodes[spec.a] !== 1 || focus.nodes[spec.b] !== 1)) return false;
    let alpha = spec.alpha;
    let progress = 1;
    let color = spec.color;
    let dash = spec.dash;
    let width = spec.width;
    if (this.layer === L_REPLAY) {
      const h = spec.hunk;
      if (h < 0) return false;
      const state = this.hState[h] as number;
      const p = this.hP[h] as number;
      const inTransform = state === 1 && p >= SPOT_END && p < SETTLE;
      const u = inTransform ? (p - SPOT_END) / TRANSFORM : 0;
      const c = this.c;
      switch (spec.role) {
        case G_TRAIL: {
          if (!inTransform || this.reduced) return false;
          const a = c.nA[spec.node] as number;
          const b = c.nB[spec.node] as number;
          progress = easeInOut(segment(u, a, b));
          alpha *= 0.6 * (1 - segment(u, b + 0.05, 1));
          if (progress <= 0 || alpha <= 0) return false;
          break;
        }
        case G_REPLACEMENT: {
          if (state === 0 || (state === 1 && p < SPOT_END)) return false;
          if (inTransform) {
            if (this.reduced) alpha *= easeStandard(u);
            else progress = easeStandard(segment(u, 0.4, 0.9));
            if (progress <= 0 || alpha <= 0) return false;
          }
          break;
        }
        case G_GHOST: {
          if (!inTransform) return false;
          const kind = c.eKind[spec.edge] as number;
          if (kind === EA_SWING && !this.reduced) {
            alpha *= 1 - easeStandard(segment(u, CHOREO.ghostFade[0], CHOREO.ghostFade[1]));
          } else if (kind === EA_SWAP || kind === EA_SWING || this.reduced) {
            // Crossfade: the old form in its before style fades out as the new one fades in.
            const before = (this.eStyles[spec.edge] as readonly EdgeStyle[])[L_BEFORE] as EdgeStyle;
            color = before.color;
            dash = before.dash;
            width = before.width;
            alpha =
              1 -
              easeStandard(
                this.reduced ? u : segment(u, c.eA[spec.edge] as number, c.eB[spec.edge] as number),
              );
          } else return false;
          if (alpha <= 0) return false;
          break;
        }
        case G_PIVOT: {
          if (!inTransform || this.reduced || c.eKind[spec.edge] !== EA_SWING) return false;
          alpha *= 1 - segment(u, CHOREO.pivotFade[0], CHOREO.pivotFade[1]);
          if (alpha <= 0) return false;
          break;
        }
        default:
          return false;
      }
    } else if (spec.role === G_SUGGESTION && !view.showSuggestions) return false;
    else if (spec.edge >= 0 && nodes[spec.a]?.visible !== true) return false;

    g.kind = spec.kind;
    if (spec.role === G_PIVOT) {
      const { nx, ny, nr } = this;
      const px = nx[spec.a] as number;
      const py = ny[spec.a] as number;
      const pr = nr[spec.a] as number;
      const dx = (nx[spec.b] as number) - px;
      const dy = (ny[spec.b] as number) - py;
      const len = Math.sqrt(dx * dx + dy * dy);
      // The dot sits on the outline, facing the new end.
      const shape = this.nShape === null ? undefined : this.nShape[spec.a];
      const reach =
        shape !== undefined && len > 0 ? shapeDistance(shape, pr, 0, dx / len, dy / len) : pr;
      g.x1 = len > 0 ? px + (dx / len) * reach : px;
      g.y1 = len > 0 ? py + (dy / len) * reach : py - pr;
      g.x2 = g.x1;
      g.y2 = g.y1;
      g.r1 = 0;
      g.r2 = 0;
      g.curvature = 0;
    } else {
      this.glyphLine(g, spec);
      g.curvature = spec.curvature;
    }
    // Modulators: filter, spotlight.
    let f = 1;
    if (this.filtered(spec.family, spec.hunk >= 0 ? (this.hFam[spec.hunk] as number) : F_NEUTRAL)) {
      color = this.t.edge[F_NEUTRAL] as string;
      f *= EMPHASIS.filtered;
    }
    const level = Math.max(this.nodeLevel(spec.a), this.nodeLevel(spec.b));
    f *= this.spotlight(level);
    g.color = color;
    g.alpha = alpha * f;
    g.width = width;
    g.dash = dash;
    g.progress = progress;
    const fade = this.fadesRestLabels(level);
    if (spec.label !== null && !(fade && this.restLabels <= 0)) {
      label.text = spec.label;
      label.color = this.t.text[F_IDENTITY] as string;
      label.alpha = fade ? this.restLabels : 1;
      label.size = LABEL.size;
      label.weight = this.t.weightStrong;
      label.strike = false;
      label.priority = 1;
      label.minZoom = this.lodChanged;
      label.offset = 0;
      g.label = label;
    } else g.label = null;
    return g.alpha > 0;
  }
}

/**
 * A resolver that turns a `ViewState` into drawable primitives for `scene`
 * (docs/visual-language.md). Construction is O(N + E); `resolve` is O(N + E) per frame and,
 * when `out` is passed back in, allocates no objects or arrays (see the module notes for the
 * transient number boxing V8 may still do while replay animations run).
 */
export function createVisualResolver(scene: Scene): VisualResolver {
  return new SceneResolver(scene);
}
