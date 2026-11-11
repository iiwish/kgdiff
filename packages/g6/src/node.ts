/**
 * `kgdiff-node`: G6's built-in `circle` plus what it cannot express — a concentric ring, a replay
 * pulse, a struck-through old name under the label and visible strike-throughs — and a halo drawn the way
 * the visual language specifies it (a soft radial glow in dark themes, a crisp offset ring in
 * light ones) instead of G6's flat band. With `shape`, the key and its ring, pulse and light halo
 * are that polygon's outline (grown by their gap), and edges stop at it.
 *
 * It reads the extra keys `toG6Data` emits (`shape`, `ring*`, `pulse*`, `sublabel*`, `haloGlow`,
 * `haloRadius`); a plain `circle` ignores them, so the same data degrades gracefully. Every
 * sub-shape has a `get<Name>Style` method, which is what G6 animates during updates.
 */
import {
  Circle,
  type CircleStyleProps,
  ExtensionCategory,
  Label,
  type LabelStyleProps,
  type Point,
  register,
} from '@antv/g6';
import { type NodeShape, shapeDistance, shapeVertices } from '@kgdiff/scene';
import { glowGradient } from './color.js';
import {
  GLOW_MIN_SCALE,
  HALO_RING_OFFSET,
  HALO_RING_WIDTH,
  LABEL_MAX_WIDTH,
  NODE_TYPE,
  TEXT_HALO_WIDTH,
} from './constants.js';
import { outlinePoints } from './geometry.js';

/** Style keys of kgdiff-node beyond G6's circle (all optional; see map.ts for their meaning). */
export interface KgdiffNodeStyleProps extends CircleStyleProps {
  /** Absent means `circle`. */
  shape?: NodeShape;
  haloGlow?: boolean;
  haloRadius?: number;
  ring?: boolean;
  ringStroke?: string;
  ringLineWidth?: number;
  ringGap?: number;
  /** Relative to the node's opacity. */
  ringOpacity?: number;
  /** Replay pulse progress in (0, 1); 0 = none. */
  pulse?: number;
  pulseStroke?: string;
  sublabel?: boolean;
  sublabelText?: string;
  sublabelFill?: string;
  sublabelFontSize?: number;
  sublabelFontWeight?: number;
  sublabelFontFamily?: string;
  /** Absolute. */
  sublabelOpacity?: number;
  sublabelOffsetY?: number;
  sublabelTextDecorationLine?: 'none' | 'line-through';
  sublabelStroke?: string;
  sublabelStrokeOpacity?: number;
}

type Attrs = Required<CircleStyleProps>;
type Extras = Partial<Omit<KgdiffNodeStyleProps, keyof CircleStyleProps>>;
type Container = NonNullable<Parameters<Circle['render']>[1]>;
type ShapeStyle = Record<string, unknown>;

/** Keys of ours that must not leak onto the key circle. */
const OWN = /^(ring|pulse|sublabel|shape$)/;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** Which G shape draws a style: one with `points` is a polygon outline. */
function shapeClass(style: false | ShapeStyle): 'polygon' | 'circle' {
  return style !== false && 'points' in style ? 'polygon' : 'circle';
}

export class KgdiffNode extends Circle {
  private extras(attributes: Attrs): Extras {
    // G6 stores every style key on the element; ours are simply not in its declared type.
    return attributes as Attrs & Extras;
  }

  private radius(attributes: Attrs): number {
    return Math.min(...this.getSize(attributes)) / 2;
  }

  /** The node's outline grown by `grow`, as the style of a polygon; null for a circle. */
  private outline(attributes: Attrs, grow: number): ShapeStyle | null {
    const points = outlinePoints(this.extras(attributes).shape, this.radius(attributes), grow);
    return points === null ? null : { points, lineJoin: 'round' };
  }

  protected override getKeyStyle(attributes: Attrs): ReturnType<Circle['getKeyStyle']> {
    const style = super.getKeyStyle(attributes);
    for (const key of Object.keys(style)) if (OWN.test(key)) Reflect.deleteProperty(style, key);
    const outline = this.outline(attributes, 0);
    if (outline === null) return style;
    Reflect.deleteProperty(style, 'r');
    return { ...style, ...outline };
  }

  protected override drawKeyShape(
    attributes: Attrs,
    container: Container,
  ): ReturnType<Circle['drawKeyShape']> {
    if (shapeVertices(this.extras(attributes).shape).length === 0) {
      return super.drawKeyShape(attributes, container);
    }
    return this.upsert('key', 'polygon', this.getKeyStyle(attributes), container);
  }

  /** The glow stays a disc on every shape; only the light halo follows the outline. */
  protected override drawHaloShape(attributes: Attrs, container: Container): void {
    const style = this.getHaloStyle(attributes);
    this.upsert('halo', shapeClass(style), style as never, container);
  }

  /** Where a line from the center to `point` crosses the outline. */
  public override getIntersectPoint(point: Point, useExtendedLine = false): Point {
    const shape = this.extras(this.parsedAttributes).shape;
    if (shapeVertices(shape).length === 0) return super.getIntersectPoint(point, useExtendedLine);
    const center = this.getCenter();
    const cx = center[0] as number;
    const cy = center[1] as number;
    const cz = center[2] ?? 0;
    const s = useExtendedLine ? -1 : 1;
    const dx = s * (point[0] - cx);
    const dy = s * (point[1] - cy);
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return [cx, cy, cz];
    const d = shapeDistance(shape, this.radius(this.parsedAttributes), 0, dx / len, dy / len);
    return [cx + (dx / len) * d, cy + (dy / len) * d, cz];
  }

  /** Dark: radial glow of radius max(haloRadius, 1.6·r). Light: 2-wide ring 5 outside r (or the ring). */
  protected override getHaloStyle(attributes: Attrs): false | ShapeStyle {
    if (attributes.halo === false) return false;
    const a = this.extras(attributes);
    const r = this.radius(attributes);
    const color = str(attributes.haloStroke, '#888');
    const opacity = num(attributes.opacity, 1) * num(attributes.haloStrokeOpacity, 0);
    const common = { opacity, pointerEvents: 'none', zIndex: -2, lineDash: 0 };
    if (a.haloGlow !== false) {
      return {
        ...common,
        r: Math.max(num(a.haloRadius, 0), GLOW_MIN_SCALE * r),
        fill: glowGradient(color),
        stroke: 'none',
        lineWidth: 0,
      };
    }
    const ringOuter = a.ring === true ? r + num(a.ringGap, 0) + num(a.ringLineWidth, 0) / 2 : 0;
    const base = Math.max(num(a.haloRadius, r), 0);
    const radius = Math.max(base + HALO_RING_OFFSET, ringOuter + 1.5 + HALO_RING_WIDTH / 2);
    return {
      ...common,
      ...(this.outline(attributes, radius - r) ?? { r: radius }),
      fill: 'none',
      stroke: color,
      lineWidth: HALO_RING_WIDTH,
    };
  }

  /** Concentric ring at r + gap. */
  protected getRingStyle(attributes: Attrs): false | ShapeStyle {
    const a = this.extras(attributes);
    const width = num(a.ringLineWidth, 0);
    if (a.ring !== true || width <= 0) return false;
    const gap = num(a.ringGap, 0);
    return {
      ...(this.outline(attributes, gap) ?? { r: this.radius(attributes) + gap }),
      fill: 'none',
      stroke: str(a.ringStroke, '#888'),
      lineWidth: width,
      opacity: num(attributes.opacity, 1) * num(a.ringOpacity, 1),
      pointerEvents: 'none',
      zIndex: -1,
    };
  }

  /** One expanding ring that fades out as `pulse` goes 0 → 1 (native renderer geometry). */
  protected getPulseStyle(attributes: Attrs): false | ShapeStyle {
    const a = this.extras(attributes);
    const p = num(a.pulse, 0);
    if (!(p > 0 && p < 1)) return false;
    const r = this.radius(attributes);
    const fade = 1 - p;
    const grow = 3 + p * (12 + r * 0.6);
    return {
      ...(this.outline(attributes, grow) ?? { r: r + grow }),
      fill: 'none',
      stroke: str(a.pulseStroke, '#888'),
      lineWidth: 0.75 + 1.75 * fade,
      opacity: num(attributes.opacity, 1) * fade * fade * 0.85,
      pointerEvents: 'none',
      zIndex: -1,
    };
  }

  /** The old name, struck through, `sublabelOffsetY` below the node (like the primary label). */
  protected getSublabelStyle(attributes: Attrs): false | LabelStyleProps {
    const a = this.extras(attributes);
    const text = typeof a.sublabelText === 'string' ? a.sublabelText : '';
    if (a.sublabel !== true || text.length === 0) return false;
    const key = this.getShape('key');
    const bottom = key ? key.getLocalBounds().max[1] : this.radius(attributes);
    const opacity = num(a.sublabelOpacity, 1);
    const fill = str(a.sublabelFill, '#888');
    return {
      text,
      fill,
      fontSize: num(a.sublabelFontSize, 11),
      fontWeight: num(a.sublabelFontWeight, 400),
      fontFamily: str(a.sublabelFontFamily, 'system-ui, sans-serif'),
      opacity,
      textAlign: 'center',
      textBaseline: 'top',
      // Struck by `getSubstrikeStyle`; G's own decoration ignores its color (see below).
      textDecorationLine: 'none',
      stroke: str(a.sublabelStroke, 'transparent'),
      lineWidth: TEXT_HALO_WIDTH,
      strokeOpacity: num(a.sublabelStrokeOpacity, 0),
      lineJoin: 'round',
      wordWrap: true,
      wordWrapWidth: LABEL_MAX_WIDTH,
      maxLines: 1,
      textOverflow: '…',
      transform: [['translate', 0, num(bottom, 0) + num(a.sublabelOffsetY, 0)]],
      pointerEvents: 'none',
      zIndex: 0,
    };
  }

  /**
   * G 6.3 keeps `textDecorationColor` unparsed and then reads `.r/.g/.b` from it, so a
   * `line-through` is drawn in whatever stroke style is current — the background-colored text
   * halo, i.e. invisible. kgdiff-node turns G's decoration off and strikes with a line instead.
   */
  protected override getLabelStyle(attributes: Attrs): false | LabelStyleProps {
    const style = super.getLabelStyle(attributes);
    return style === false ? false : { ...style, textDecorationLine: 'none' };
  }

  /** A 1-wide line through the middle of a label shape's text, in node coordinates. */
  private strike(shape: string, color: string, opacity: number): false | ShapeStyle {
    const label = this.getShape(shape);
    if (!label) return false;
    // Local bounds include the text halo's stroke; G also shifts the text by half of it.
    const b = label.getLocalBounds();
    const inset = TEXT_HALO_WIDTH / 2;
    const x1 = b.min[0] + inset;
    const x2 = b.max[0] - inset;
    const y = (b.min[1] + b.max[1]) / 2;
    if (!(x2 > x1) || !Number.isFinite(y)) return false;
    return { x1, y1: y, x2, y2: y, stroke: color, lineWidth: 1, opacity, pointerEvents: 'none' };
  }

  protected getStrikeStyle(attributes: Attrs): false | ShapeStyle {
    if (attributes.label === false || attributes.labelTextDecorationLine !== 'line-through') {
      return false;
    }
    const color = str(attributes.labelFill, '#888');
    return this.strike('label', color, num(attributes.labelOpacity, num(attributes.opacity, 1)));
  }

  protected getSubstrikeStyle(attributes: Attrs): false | ShapeStyle {
    const a = this.extras(attributes);
    if (a.sublabel !== true || a.sublabelTextDecorationLine !== 'line-through') return false;
    return this.strike('sublabel', str(a.sublabelFill, '#888'), num(a.sublabelOpacity, 1));
  }

  public override render(attributes = this.parsedAttributes, container: Container = this): void {
    super.render(attributes, container);
    if (!this.getShape('key')) return;
    const ring = this.getRingStyle(attributes);
    this.upsert('ring', shapeClass(ring), ring, container);
    const pulse = this.getPulseStyle(attributes);
    this.upsert('pulse', shapeClass(pulse), pulse, container);
    this.upsert('sublabel', Label, this.getSublabelStyle(attributes), container);
    this.upsert('strike', 'line', this.getStrikeStyle(attributes), container);
    this.upsert('substrike', 'line', this.getSubstrikeStyle(attributes), container);
  }
}

let registered = false;

/** Register `kgdiff-node` with G6 (once per module instance). */
export function registerKgdiffNode(): void {
  if (registered) return;
  register(ExtensionCategory.NODE, NODE_TYPE, KgdiffNode);
  registered = true;
}
