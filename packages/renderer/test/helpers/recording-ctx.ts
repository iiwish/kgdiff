import type {
  CollapsedGroup,
  EdgeVisual,
  FrameVisuals,
  GlyphVisual,
  LabelVisual,
  NodeVisual,
} from '@kgdiff/scene';
import type { Ctx2D, Surface, SurfaceFactory } from '../../src/ctx.js';

export interface Style {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  dash: number[];
  lineDashOffset: number;
  lineCap: CanvasLineCap;
  font: string;
  /** The current transform, as `setTransform`'s arguments. */
  transform: readonly number[];
  /** How many `clip()` regions are in force (saved and restored with the rest). */
  clips: number;
}

export interface Op {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly style: Style;
}

/** A `Ctx2D` that records every call with the style state at that moment. */
export class RecordingContext implements Ctx2D {
  readonly ops: Op[] = [];
  globalAlpha = 1;
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  miterLimit = 10;
  lineDashOffset = 0;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  imageSmoothingEnabled = true;
  private dash: number[] = [];
  private transform: readonly number[] = [1, 0, 0, 1, 0, 0];
  private clips = 0;
  private readonly stack: Style[] = [];

  style(): Style {
    return {
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      dash: [...this.dash],
      lineDashOffset: this.lineDashOffset,
      lineCap: this.lineCap,
      font: this.font,
      transform: this.transform,
      clips: this.clips,
    };
  }

  /** `save()` calls not yet matched by a `restore()`. */
  get depth(): number {
    return this.stack.length;
  }

  private rec(name: string, args: readonly unknown[]): void {
    this.ops.push({ name, args, style: this.style() });
  }

  calls(name: string): Op[] {
    return this.ops.filter((o) => o.name === name);
  }

  count(name: string): number {
    let n = 0;
    for (const o of this.ops) if (o.name === name) n++;
    return n;
  }

  clear(): void {
    this.ops.length = 0;
  }

  save(): void {
    this.stack.push(this.style());
    this.rec('save', []);
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.fillStyle = s.fillStyle as string;
      this.strokeStyle = s.strokeStyle as string;
      this.globalAlpha = s.globalAlpha;
      this.lineWidth = s.lineWidth;
      this.dash = s.dash;
      this.lineDashOffset = s.lineDashOffset;
      this.lineCap = s.lineCap;
      this.font = s.font;
      this.transform = s.transform;
      this.clips = s.clips;
    }
    this.rec('restore', []);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
    this.rec('setTransform', [a, b, c, d, e, f]);
  }
  setLineDash(segments: readonly number[]): void {
    this.dash = [...segments];
    this.rec('setLineDash', [this.dash]);
  }
  beginPath(): void {
    this.rec('beginPath', []);
  }
  closePath(): void {
    this.rec('closePath', []);
  }
  moveTo(x: number, y: number): void {
    this.rec('moveTo', [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.rec('lineTo', [x, y]);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.rec('quadraticCurveTo', [cpx, cpy, x, y]);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    this.rec('arc', [x, y, r, a0, a1]);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.rec('rect', [x, y, w, h]);
  }
  fill(): void {
    this.rec('fill', []);
  }
  stroke(): void {
    this.rec('stroke', []);
  }
  clip(): void {
    this.clips++;
    this.rec('clip', []);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec('fillRect', [x, y, w, h]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.rec('clearRect', [x, y, w, h]);
  }
  fillText(text: string, x: number, y: number): void {
    this.rec('fillText', [text, x, y]);
  }
  strokeText(text: string, x: number, y: number): void {
    this.rec('strokeText', [text, x, y]);
  }
  measureText(text: string): { width: number } {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    return { width: [...text].length * (m ? Number(m[1]) : 10) * 0.6 };
  }
  drawImage(image: CanvasImageSource, ...rest: number[]): void {
    this.rec('drawImage', [image, ...rest]);
  }
  createRadialGradient(): CanvasGradient {
    const stops: [number, string][] = [];
    return {
      addColorStop: (t: number, c: string) => stops.push([t, c]),
      stops,
    } as unknown as CanvasGradient;
  }
  createPattern(image: CanvasImageSource): CanvasPattern | null {
    const pattern = {
      image,
      transform: null as unknown,
      setTransform(m: unknown) {
        pattern.transform = m;
      },
    };
    this.rec('createPattern', [image]);
    return pattern as unknown as CanvasPattern;
  }
}

/** A surface factory whose surfaces are recording contexts (inspect them through `surfaces`). */
export function recordingFactory(): { factory: SurfaceFactory; surfaces: RecordingContext[] } {
  const surfaces: RecordingContext[] = [];
  const factory: SurfaceFactory = (width, height) => {
    const ctx = new RecordingContext();
    surfaces.push(ctx);
    const canvas = { width: Math.ceil(width), height: Math.ceil(height), id: surfaces.length };
    return { canvas: canvas as unknown as HTMLCanvasElement, ctx } satisfies Surface;
  };
  return { factory, surfaces };
}

/** A factory that never provides surfaces (no atlas, no sprites, no grid tiles). */
export const noSurfaces: SurfaceFactory = () => null;

// ─── Frame builders ─────────────────────────────────────────────────────────

export function lbl(text: string, o: Partial<LabelVisual> = {}): LabelVisual {
  return {
    text,
    color: '#fff',
    alpha: 1,
    size: 12,
    weight: 400,
    strike: false,
    priority: 0.5,
    minZoom: 0,
    offset: 5,
    ...o,
  };
}

export function node(x: number, y: number, o: Partial<NodeVisual> = {}): NodeVisual {
  return {
    visible: true,
    x,
    y,
    r: 6,
    alpha: 1,
    family: 'neutral',
    fill: '#4B5568',
    stroke: null,
    strokeWidth: 1.25,
    dash: null,
    ring: null,
    halo: null,
    label: null,
    secondaryLabel: null,
    badge: null,
    pulse: 0,
    z: 0,
    ...o,
  };
}

export function edge(a: NodeVisual, b: NodeVisual, o: Partial<EdgeVisual> = {}): EdgeVisual {
  return {
    visible: true,
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    r1: a.r,
    r2: b.r,
    curvature: 0,
    color: '#323A4A',
    width: 1,
    alpha: 1,
    dash: null,
    dashOffset: 0,
    arrow: false,
    arrowMinZoom: 0,
    progress: 1,
    fromTarget: false,
    label: null,
    z: 0,
    ...o,
  };
}

export function glyph(kind: GlyphVisual['kind'], o: Partial<GlyphVisual> = {}): GlyphVisual {
  return {
    kind,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    r1: 0,
    r2: 0,
    color: '#A78BFA',
    alpha: 1,
    width: 1.5,
    dash: null,
    progress: 1,
    curvature: 0,
    label: null,
    ...o,
  };
}

export function group(x: number, y: number, count: number, label = ''): CollapsedGroup {
  return { id: `g${x},${y}`, x, y, count, nodes: [], label };
}

export function frameOf(
  nodes: NodeVisual[],
  edges: EdgeVisual[] = [],
  o: Partial<FrameVisuals> = {},
): FrameVisuals {
  return { nodes, edges, glyphs: [], collapsed: [], spotlight: 0, ...o };
}
