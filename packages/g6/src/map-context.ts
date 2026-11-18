/**
 * Shared state and helpers of one `mapFrame` call (see map.ts): the element metadata type, LOD
 * and id bookkeeping, and label text resolution.
 */
import type { EdgeData, NodeData } from '@antv/g6';
import type { FrameVisuals, LabelVisual, Scene, Theme } from '@kgdiff/scene';
import { finite, unit } from './geometry.js';
import type { NodeLocator } from './locator.js';

export type NodeStyle = NonNullable<NodeData['style']>;
export type EdgeStyle = NonNullable<EdgeData['style']>;

/** Kind of a generated element, stored in `datum.data.kgdiff`. */
export type ElementKind = 'node' | 'edge' | 'glyph' | 'anchor' | 'collapsed';

/**
 * `datum.data` of every generated element. Flat primitives only (G6 compares `data` shallowly).
 * Part of the adapter's contract: a host may read it from `graph.getElementData(id).data` (or
 * through `DiffGraphController.hunkOf`), and these members keep their meaning.
 *  - `kgdiff`: what the element is (`ElementKind`).
 *  - `index`: scene node / edge index; for glyphs the index in `frame.glyphs`; for collapsed
 *    pills the index in `frame.collapsed`; for anchors (invisible points glyph arcs attach to
 *    where no node is drawn) the scene node at that point, or -1.
 *  - `hunk`: index into `scene.hunks` (glyphs: the hunk of their source node, else target;
 *    anchors: the hunk of their scene node), or -1 when no hunk changes the element.
 *  - `family`: the element's change family in this frame (`neutral` when unchanged).
 *  - `changed`: whether a change is drawn on the element.
 *  - `label`: the element's plain label (revealed on hover even when the frame hides it).
 *  - `glyph`: for glyphs their `GlyphKind` (`merge-arrow`…); '' for every other element.
 */
export type KgdiffDatumData = {
  readonly kgdiff: ElementKind;
  readonly index: number;
  readonly hunk: number;
  readonly family: string;
  readonly changed: boolean;
  readonly label: string;
  readonly glyph: string;
};

export interface Ctx {
  readonly scene: Scene;
  readonly frame: FrameVisuals;
  readonly theme: Theme;
  readonly bg: string;
  readonly prefix: string;
  readonly keepHidden: boolean;
  readonly zoom: number;
  /** 1 when the node is part of the output. */
  readonly present: Uint8Array;
  /** G6 id of every node index (also those left out). */
  readonly nodeIds: string[];
  readonly used: Set<string>;
  readonly lod: Set<number>;
  /** Drawn nodes, for attaching glyph ends (built lazily). */
  locator: NodeLocator | null;
  /** All scene nodes, for naming glyph anchors (built lazily). */
  anyLocator: NodeLocator | null;
  /** Anchor key → anchor node id, shared by the glyphs of one frame. */
  readonly anchors: Map<string, string>;
  /** Frozen default styles, built once per frame and spread into every element's style. */
  nodeBase: Readonly<NodeStyle> | null;
  edgeBase: Readonly<EdgeStyle> | null;
}

/** LOD: visible from `minZoom` on; a missing / NaN threshold shows it (native renderer rule). */
export function shown(minZoom: number, zoom: number): boolean {
  return !(zoom < minZoom);
}

export function noteLod(ctx: Ctx, minZoom: number): void {
  if (minZoom > 0 && Number.isFinite(minZoom)) ctx.lod.add(minZoom);
}

/** A unique id: `base`, else `base#2`, `base#3`… (deterministic in output order). */
export function claim(ctx: Ctx, base: string): string {
  let id = base;
  for (let k = 2; ctx.used.has(id); k++) id = `${base}#${k}`;
  ctx.used.add(id);
  return id;
}

export interface Text {
  readonly text: string;
  readonly show: boolean;
  readonly fill: string;
  readonly size: number;
  readonly weight: number;
  /** Absolute (owner alpha × label alpha). */
  readonly opacity: number;
  readonly strike: boolean;
  readonly offset: number;
}

export function text(
  l: LabelVisual | null,
  ownerAlpha: number,
  ctx: Ctx,
  fallbackSize: number,
  fallbackColor: string,
): Text {
  if (l === null) {
    return {
      text: '',
      show: false,
      fill: fallbackColor,
      size: fallbackSize,
      weight: ctx.theme.font.weightRegular,
      opacity: 0,
      strike: false,
      offset: 0,
    };
  }
  noteLod(ctx, l.minZoom);
  const opacity = unit(ownerAlpha * l.alpha);
  return {
    text: l.text,
    show: l.text.length > 0 && opacity > 0 && shown(l.minZoom, ctx.zoom),
    fill: l.color,
    size: finite(l.size, fallbackSize),
    weight: finite(l.weight, ctx.theme.font.weightRegular),
    opacity,
    strike: l.strike,
    offset: finite(l.offset, 0),
  };
}
