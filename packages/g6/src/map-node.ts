/** Scene nodes and collapsed-group pills → G6 node data (see map.ts for the conventions). */
import type { NodeBadgeStyleProps, NodeData } from '@antv/g6';
import {
  type CollapsedGroup,
  evenShapeDash,
  type NodeVisual,
  type SceneNode,
  shapeDistance,
  shapeVertexRadius,
  shapeVertices,
} from '@kgdiff/scene';
import { composite } from './color.js';
import {
  BADGE_FONT_SIZE,
  BADGE_HEIGHT,
  BADGE_PAD_X,
  COLLAPSED_ID_PREFIX,
  GLOW_MIN_SCALE,
  HALO_RING_OFFSET,
  HALO_RING_WIDTH,
  LABEL_MAX_WIDTH,
  PILL_FONT_SIZE,
  PILL_HEIGHT,
  PILL_PAD_X,
  TEXT_HALO_ALPHA,
  TEXT_HALO_WIDTH,
  Z,
} from './constants.js';
import { band, evenCircleDash, finite, unit } from './geometry.js';
import {
  type Ctx,
  claim,
  type KgdiffDatumData,
  type NodeStyle,
  noteLod,
  shown,
  text,
} from './map-context.js';

const NO_BADGES = Object.freeze([]) as unknown as NodeBadgeStyleProps[];

/** Style keys shared by every node so updates never inherit stale values (see file comment). */
export function nodeBase(ctx: Ctx): Readonly<NodeStyle> {
  if (ctx.nodeBase === null) ctx.nodeBase = Object.freeze(buildNodeBase(ctx));
  return ctx.nodeBase;
}

function buildNodeBase(ctx: Ctx): NodeStyle {
  const t = ctx.theme;
  return {
    x: 0,
    y: 0,
    size: 0,
    zIndex: Z.node,
    visibility: 'visible',
    cursor: 'pointer',
    pointerEvents: 'auto',
    opacity: 1,
    fill: ctx.bg,
    fillOpacity: 1,
    stroke: ctx.bg,
    strokeOpacity: 1,
    lineWidth: 0,
    lineDash: 0,
    lineDashOffset: 0,
    shape: 'circle',
    halo: false,
    haloStroke: ctx.bg,
    haloStrokeOpacity: 0,
    haloLineWidth: 0,
    haloLineDash: 0,
    haloGlow: t.glow,
    haloRadius: 0,
    ring: false,
    ringStroke: ctx.bg,
    ringLineWidth: 0,
    ringGap: 0,
    ringOpacity: 0,
    pulse: 0,
    pulseStroke: t.accent.base,
    label: false,
    labelText: '',
    labelFill: t.neutral.label,
    labelFontSize: t.font.size,
    labelFontWeight: t.font.weightRegular,
    labelFontFamily: t.font.family,
    labelOpacity: 0,
    labelPlacement: 'bottom',
    labelOffsetX: 0,
    labelOffsetY: 0,
    labelTextDecorationLine: 'none',
    labelTextDecorationColor: t.neutral.label,
    labelStroke: ctx.bg,
    labelLineWidth: TEXT_HALO_WIDTH,
    labelStrokeOpacity: 0,
    labelLineJoin: 'round',
    labelMaxWidth: LABEL_MAX_WIDTH,
    labelWordWrap: true,
    labelMaxLines: 1,
    labelTextOverflow: '…',
    labelBackground: false,
    labelBackgroundFill: ctx.bg,
    labelBackgroundStroke: ctx.bg,
    labelBackgroundLineWidth: 0,
    labelBackgroundRadius: 0,
    labelBackgroundOpacity: 1,
    labelPadding: 0,
    sublabel: false,
    sublabelText: '',
    sublabelFill: t.text.muted,
    sublabelFontSize: t.font.size,
    sublabelFontWeight: t.font.weightRegular,
    sublabelFontFamily: t.font.family,
    sublabelOpacity: 0,
    sublabelOffsetY: 0,
    sublabelTextDecorationLine: 'none',
    sublabelStroke: ctx.bg,
    sublabelStrokeOpacity: 0,
    badge: false,
    badges: NO_BADGES,
  };
}

/**
 * Where the outermost outline meets the diagonal to the upper right, per axis, and the half size
 * of the key shape, whose corner G6 measures the badge from.
 */
function badgeAnchor(
  v: NodeVisual,
  r: number,
  grow: number,
): { reach: number; halfWidth: number; halfHeight: number } {
  const vertices = shapeVertices(v.shape);
  if (vertices.length === 0) return { reach: 0.7 * (r + grow), halfWidth: r, halfHeight: r };
  const radius = shapeVertexRadius(v.shape, r, 0);
  let halfWidth = 0;
  let halfHeight = 0;
  for (let i = 0; i < vertices.length; i += 2) {
    halfWidth = Math.max(halfWidth, Math.abs(vertices[i] as number) * radius);
    halfHeight = Math.max(halfHeight, Math.abs(vertices[i + 1] as number) * radius);
  }
  const reach = shapeDistance(v.shape, r, grow, Math.SQRT1_2, -Math.SQRT1_2) * Math.SQRT1_2;
  return { reach, halfWidth, halfHeight };
}

/** Ghost dashes along the outline: the pattern and its offset (`[0, 0]` when solid). */
function outlineDash(v: NodeVisual, r: number, stroked: boolean): [number | number[], number] {
  if (!stroked || v.dash === null || v.dash.length === 0) return [0, 0];
  if (shapeVertices(v.shape).length === 0) return [evenCircleDash(v.dash, r), 0];
  const dash: number[] = [];
  const offset = evenShapeDash(v.shape, v.dash, r, dash);
  return [dash, offset];
}

function badgeOf(v: NodeVisual, r: number, ctx: Ctx): NodeBadgeStyleProps[] {
  const b = v.badge;
  if (b === null) return NO_BADGES;
  noteLod(ctx, b.minZoom);
  if (b.text.length === 0 || !shown(b.minZoom, ctx.zoom)) return NO_BADGES;
  // The native pill sits at (x + 0.7·R − 2, y − 0.7·R − 15 + 2), R = outermost outline (ring
  // included). G6 anchors 'right-top' badges with their text's top-left at the key's corner.
  const ring = v.ring;
  const grow = ring !== null ? ring.gap + ring.width / 2 : 0;
  const padY = (BADGE_HEIGHT - BADGE_FONT_SIZE * 1.2) / 2;
  const { reach, halfWidth, halfHeight } = badgeAnchor(v, r, grow);
  return [
    {
      text: b.text,
      placement: 'right-top',
      offsetX: reach - 2 + BADGE_PAD_X - halfWidth,
      offsetY: halfHeight - reach - BADGE_HEIGHT + 2 + padY,
      fill: b.color,
      fontSize: BADGE_FONT_SIZE,
      fontWeight: 600,
      fontFamily: ctx.theme.font.mono,
      // Translucent tints are composited over the canvas, like the native opaque underlay.
      backgroundFill: composite(b.background, ctx.bg),
      backgroundOpacity: 1,
      padding: [padY, BADGE_PAD_X, padY, BADGE_PAD_X],
    },
  ];
}

export function mapNode(sn: SceneNode, v: NodeVisual, ctx: Ctx): NodeData | null {
  if (!v.visible && !ctx.keepHidden) return null;
  const t = ctx.theme;
  const alpha = unit(v.alpha);
  const r = Math.max(0, finite(v.r, 0));
  const hasStroke = v.stroke !== null && v.strokeWidth > 0;
  const ring = v.ring !== null && v.ring.width > 0 ? v.ring : null;
  const halo = v.halo;
  const label = text(v.label, alpha, ctx, t.font.size, t.neutral.label);
  const sub = text(v.secondaryLabel, alpha, ctx, t.font.size, t.text.muted);
  const badges = badgeOf(v, r, ctx);
  const changed = v.family !== 'neutral';
  const pulse = v.pulse > 0 && v.pulse < 1 ? v.pulse : 0;
  const [lineDash, lineDashOffset] = outlineDash(v, r, hasStroke);
  const style: NodeStyle = {
    ...nodeBase(ctx),
    x: finite(v.x, 0),
    y: finite(v.y, 0),
    size: 2 * r,
    zIndex: band(Z.node, v.z, Z.span),
    visibility: v.visible ? 'visible' : 'hidden',
    opacity: alpha,
    // Ghosts (fill null) are filled with the canvas so edges do not show through.
    fill: v.fill ?? ctx.bg,
    stroke: v.stroke ?? v.fill ?? ctx.bg,
    lineWidth: hasStroke ? v.strokeWidth : 0,
    lineDash,
    lineDashOffset,
    shape: v.shape ?? 'circle',
    halo: halo !== null,
    haloStroke: halo?.color ?? ctx.bg,
    haloStrokeOpacity: halo !== null ? unit(halo.alpha) : 0,
    // Plain G6 circles draw the halo as a band centred on the outline: cover r → glow radius
    // (dark) or the offset ring (light). kgdiff-node replaces it with the real glow / ring.
    haloLineWidth:
      halo === null
        ? 0
        : t.glow
          ? 2 * Math.max(0, Math.max(halo.radius, GLOW_MIN_SCALE * r) - r)
          : 2 * (HALO_RING_OFFSET + HALO_RING_WIDTH),
    haloRadius: halo !== null ? Math.max(0, finite(halo.radius, r)) : 0,
    ring: ring !== null,
    ringStroke: ring?.color ?? ctx.bg,
    ringLineWidth: ring?.width ?? 0,
    ringGap: ring?.gap ?? 0,
    ringOpacity: ring !== null ? unit(ring.alpha) : 0,
    pulse,
    pulseStroke: ring?.color ?? v.stroke ?? v.fill ?? t.accent.base,
    label: label.show,
    labelText: label.text,
    labelFill: label.fill,
    labelFontSize: label.size,
    labelFontWeight: label.weight,
    labelOpacity: label.opacity,
    labelOffsetY: label.offset,
    labelTextDecorationLine: label.strike ? 'line-through' : 'none',
    // G strikes with the current stroke style unless told otherwise — the background halo.
    labelTextDecorationColor: label.fill,
    labelStrokeOpacity: TEXT_HALO_ALPHA * label.opacity,
    sublabel: sub.show,
    sublabelText: sub.text,
    sublabelFill: sub.fill,
    sublabelFontSize: sub.size,
    sublabelFontWeight: sub.weight,
    sublabelOpacity: sub.opacity,
    sublabelOffsetY: sub.offset,
    sublabelTextDecorationLine: sub.strike ? 'line-through' : 'none',
    sublabelStrokeOpacity: TEXT_HALO_ALPHA * sub.opacity,
    badge: badges.length > 0,
    badges,
  };
  const data: KgdiffDatumData = {
    kgdiff: 'node',
    index: sn.index,
    hunk: sn.hunk,
    family: v.family,
    changed,
    label: label.text.length > 0 ? label.text : sn.label,
    glyph: '',
  };
  return { id: ctx.nodeIds[sn.index] as string, style, data };
}

// ─── Collapsed groups ───────────────────────────────────────────────────────

function pillText(g: CollapsedGroup): string {
  return typeof g.label === 'string' && g.label.length > 0
    ? g.label
    : `+${g.count.toLocaleString('en-US')}`;
}

/** “+38 unchanged” pill: an invisible point node whose centred label has a pill background. */
export function mapCollapsed(g: CollapsedGroup, i: number, ctx: Ctx): NodeData | null {
  if (!(g.count > 0) || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
  const t = ctx.theme;
  const padY = (PILL_HEIGHT - PILL_FONT_SIZE * 1.2) / 2;
  const label = pillText(g);
  const style: NodeStyle = {
    ...nodeBase(ctx),
    x: g.x,
    y: g.y,
    size: 1,
    zIndex: Z.collapsed,
    cursor: 'default',
    fill: 'transparent',
    stroke: 'transparent',
    label: true,
    labelText: label,
    labelFill: t.text.secondary,
    labelFontSize: PILL_FONT_SIZE,
    labelFontWeight: 500,
    labelOpacity: 1,
    labelPlacement: 'center',
    labelLineWidth: 0,
    labelWordWrap: false,
    labelBackground: true,
    labelBackgroundFill: t.surface.raised,
    labelBackgroundStroke: t.surface.borderStrong,
    labelBackgroundLineWidth: 1,
    labelBackgroundRadius: PILL_HEIGHT / 2,
    labelBackgroundOpacity: 1,
    labelPadding: [padY, PILL_PAD_X, padY, PILL_PAD_X],
  };
  const data: KgdiffDatumData = {
    kgdiff: 'collapsed',
    index: i,
    hunk: -1,
    family: 'neutral',
    changed: false,
    label,
    glyph: '',
  };
  return { id: claim(ctx, `${ctx.prefix}${COLLAPSED_ID_PREFIX}${g.id}`), style, data };
}
