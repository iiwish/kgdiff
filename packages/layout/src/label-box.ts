/**
 * The label block reserved below a node, from `labelWidth`: the layout engine's bounds and
 * collision boxes.
 */
import { labelWidth } from './text-metrics.js';

// ─── Label geometry (shared with bounds and collision) ───────────────────────

/** Gap between the node circle and the top of its label (world units, visual-language §Typography). */
export const LABEL_GAP = 5;
/** Height of one label line in em (12 px text + its 3 px halo). */
export const LINE_HEIGHT_EM = 1.25;
/** Renamed nodes show the old name 14 px (at 12 px text) below the new one, at 11/12 size. */
export const SECONDARY_OFFSET_EM = 14 / 12;
export const SECONDARY_SIZE_RATIO = 11 / 12;
/**
 * Reserved label width is capped so a pathological label (a 300-character IRI) cannot blow up
 * the layout; renderers truncate long labels anyway. 32 em ≈ 55 Latin characters.
 */
export const MAX_LABEL_EM = 32;

export interface LabelBox {
  /** Full width of the label block (world units). */
  readonly width: number;
  /** Full height of the label block, all lines. */
  readonly height: number;
}

/**
 * The block of text drawn centered below a node: its label and, for renamed nodes, the struck
 * old label on a second, slightly smaller line.
 */
export function labelBox(
  label: string,
  labelBefore: string | undefined,
  fontSize: number,
): LabelBox {
  const max = MAX_LABEL_EM * fontSize;
  let width = Math.min(max, labelWidth(label, fontSize));
  let height = LINE_HEIGHT_EM * fontSize;
  if (labelBefore !== undefined && labelBefore !== label) {
    const secondary = fontSize * SECONDARY_SIZE_RATIO;
    width = Math.max(width, Math.min(max, labelWidth(labelBefore, secondary)));
    height += SECONDARY_OFFSET_EM * fontSize;
  }
  return { width, height };
}
