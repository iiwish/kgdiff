/**
 * @kgdiff/g6: render kgdiff scenes with AntV G6 v5.
 *
 * For teams whose product already uses G6: the same visual language as the
 * kgdiff viewer (docs/visual-language.md), driven by the same `VisualResolver`,
 * expressed as G6 data, styles and animations.
 *
 *   map.ts         frame → GraphData (pure)
 *   node.ts        `kgdiff-node`: circle + ring, glow / offset-ring halo, pulse, struck old name
 *   options.ts     generated G6 options (no G6 theme, hover states, animations)
 *   controller.ts  view state → frames → setData / draw; replay; LOD; interaction
 *   replay.ts      replay sampling plan
 */
import { Graph, type GraphData } from '@antv/g6';
import type { FrameVisuals, Layer, Scene, Theme, ViewState } from '@kgdiff/scene';
import { DiffGraphControllerImpl } from './controller.js';
import { mapFrame } from './map.js';
import { registerKgdiffNode } from './node.js';

export type { ElementKind, KgdiffDatumData } from './map.js';

export interface ToG6DataOptions {
  /** Prefix for generated G6 element ids (default ''). */
  readonly idPrefix?: string;
  /** Include invisible elements with `visibility: 'hidden'` instead of omitting them. Default false. */
  readonly keepHidden?: boolean;
}

/**
 * Convert a resolved frame into G6 v5 `GraphData`: one node per scene node, one edge per
 * scene edge (+ glyph edges for merge/move arcs), with positions and fully resolved styles.
 * Pure; no G6 runtime needed.
 *
 * - Ids: `idPrefix + union id` for scene nodes and edges; glyphs
 *   `idPrefix + 'kgdiff-glyph-' + kind + ':' + JSON([source key, target key])` (keys are union
 *   ids, or anchor keys; stable across frames, so G6 animates them); anchors
 *   `idPrefix + 'kgdiff-anchor-' + JSON(key)`; collapsed pills
 *   `idPrefix + 'kgdiff-collapsed-' + group id`. A collision gets a `#2`, `#3`… suffix.
 * - `datum.data` is a `KgdiffDatumData`: kind, scene index, hunk, family (flat primitives).
 * - Edges are `line` or `quadratic` (`curveOffset` from the scene curvature) between the
 *   frame's endpoint nodes. Glyph arcs become extra edges between the visible nodes whose discs
 *   hold their endpoints; an end with no drawn node there (a split target before it emerges)
 *   attaches to an anchor: an invisible, non-interactive point node (`data.kgdiff: 'anchor'`),
 *   shared by the arcs of a frame. Arcs with both ends on one node are omitted. Pivot dots become
 *   small non-interactive nodes on their node's outline.
 * - Sizes the scene gives in px are world units here (exact at zoom 1). Level of detail is
 *   evaluated at zoom 1: labels / badges / arrowheads whose `minZoom` is above 1 are switched
 *   off (`createDiffGraph` re-evaluates it at the live zoom).
 * - Ring, glow, pulse and the struck old name use extra style keys drawn by the `kgdiff-node`
 *   type that `createDiffGraph` registers; on G6's plain `circle` they are ignored and the halo
 *   falls back to G6's built-in band.
 *
 * Deterministic; O(N + E + glyphs). Does not mutate its inputs.
 *
 * @throws KgdiffError(`invalid-input`) when `frame` was not resolved for `scene`.
 */
export function toG6Data(
  scene: Scene,
  frame: FrameVisuals,
  options: ToG6DataOptions = {},
): GraphData {
  return mapFrame(scene, frame, {
    idPrefix: options.idPrefix ?? '',
    keepHidden: options.keepHidden ?? false,
    zoom: 1,
  }).data;
}

export interface CreateDiffGraphOptions {
  /** Initial view state. */
  readonly view?: Partial<ViewState>;
  /** Extra G6 options merged into the generated ones (behaviors, plugins…). */
  readonly g6?: Record<string, unknown>;
  /** Default true: zoom-canvas, drag-canvas, hover highlight, click to select a hunk. */
  readonly interactive?: boolean;
}

export interface DiffGraphController {
  readonly graph: Graph;
  setLayer(layer: Exclude<Layer, 'replay'>): Promise<void>;
  /** Select a hunk by index (-1 clears) and focus it. */
  selectHunk(index: number): Promise<void>;
  /** Play the replay hunk by hunk with G6 animations; resolves when finished or stopped. */
  playReplay(options?: { readonly speed?: number }): Promise<void>;
  stop(): void;
  setTheme(theme: Theme): Promise<void>;
  destroy(): void;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/**
 * Create a G6 graph in `container` that renders `scene`.
 *
 * The graph uses no G6 theme (`theme: false`): kgdiff's own encodings, a background plugin in
 * `theme.canvas.background`, the `kgdiff-node` node type and a private hover state. Each view
 * change resolves one frame and sends G6 only the difference to the previous one (`addData`,
 * `updateData` with just the changed style keys, `removeData`) before `graph.draw()`; G6
 * animates it over `theme.motion.base` (layers, selection, themes) or the timeline (replay).
 * Calls made while a draw is still running are merged into one update (latest wins). Elements
 * the caller adds to `graph` are left alone; do not `setData` / `clear` the graph yourself.
 *
 * - `options.g6` is merged over the generated options: `behaviors` / `plugins` / `transforms`
 *   are appended, plain objects merge recursively, other values replace. `animation: false`
 *   disables every animation (replay still keeps its pace).
 * - Interaction (`interactive`, default true): zoom-canvas, drag-canvas, hover (stroke + label
 *   like the native viewer), click a changed element → select its hunk, click an unchanged node
 *   → select it, click the canvas → clear.
 * - Level of detail follows the camera: crossing a label / badge / arrow threshold re-maps.
 * - `selectHunk(i)` spotlights the hunk and pans to its nodes; in the replay layer it seeks to the
 *   end of the hunk's window. `playReplay({ speed })` (default 1×) resolves every window (every
 *   chapter in chapter mode) at the end of its spotlight, mid-transform, settle start and end,
 *   and lets G6 animate between them; the camera pans to units less than 70% in view. It
 *   resolves when finished or `stop()`ped; `setLayer` / `selectHunk` stop it.
 *
 * @throws KgdiffError(`invalid-input`) for invalid arguments (also from the controller's methods,
 *   which reject at once after `destroy()`; calls still pending at `destroy()` resolve).
 */
export async function createDiffGraph(
  container: HTMLElement | string,
  scene: Scene,
  options: CreateDiffGraphOptions = {},
): Promise<DiffGraphController> {
  registerKgdiffNode();
  const controller = new DiffGraphControllerImpl(scene, options, {
    createGraph: (graphOptions) => new Graph(graphOptions),
    wait,
    deadline: wait,
  });
  try {
    await controller.start(container);
  } catch (error) {
    controller.destroy();
    throw error;
  }
  return controller;
}
