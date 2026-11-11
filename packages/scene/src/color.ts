/**
 * Color math for the design tokens: parsing, alpha compositing, WCAG contrast and
 * derived colors (mixes, desaturation, precomputed ramps for animation).
 *
 * Everything here allocates; it runs when tokens or a resolver are built. Hot paths
 * (the resolver at 60 fps) only index into precomputed `ColorRamp`s.
 */
import { KgdiffError } from '@kgdiff/core';

/** sRGB color with straight (non-premultiplied) alpha. Channels 0–255, alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function invalid(css: string, why: string): never {
  throw new KgdiffError(
    'invalid-input',
    `Unsupported color ${JSON.stringify(css)}: ${why}. Use #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() or rgba().`,
    { color: css },
  );
}

function parseHex(css: string, hex: string): Rgba {
  if (!/^[0-9a-f]+$/i.test(hex)) invalid(css, 'not a hex color');
  const short = hex.length === 3 || hex.length === 4;
  if (!short && hex.length !== 6 && hex.length !== 8)
    invalid(css, 'hex colors have 3, 4, 6 or 8 digits');
  const channel = (i: number): number =>
    short
      ? Number.parseInt(hex.charAt(i) + hex.charAt(i), 16)
      : Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  const hasAlpha = hex.length === 4 || hex.length === 8;
  return { r: channel(0), g: channel(1), b: channel(2), a: hasAlpha ? channel(3) / 255 : 1 };
}

function parseChannel(css: string, token: string, scale: number): number {
  const percent = token.endsWith('%');
  const value = Number(percent ? token.slice(0, -1) : token);
  if (token === '' || !Number.isFinite(value)) invalid(css, `bad component "${token}"`);
  return clamp(percent ? (value / 100) * scale : value, 0, scale);
}

function parseFunctional(css: string, body: string): Rgba {
  // Both `rgb(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`.
  const [channels = '', alphaPart, extra] = body.split('/');
  if (extra !== undefined) invalid(css, 'more than one "/"');
  const parts = channels
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (alphaPart !== undefined) parts.push(alphaPart.trim());
  if (parts.length !== 3 && parts.length !== 4) invalid(css, 'expected 3 or 4 components');
  const [r = '', g = '', b = '', a] = parts;
  return {
    r: parseChannel(css, r, 255),
    g: parseChannel(css, g, 255),
    b: parseChannel(css, b, 255),
    a: a === undefined ? 1 : parseChannel(css, a, 1),
  };
}

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` and `transparent`. */
export function parseColor(css: string): Rgba {
  const s = css.trim().toLowerCase();
  if (s.startsWith('#')) return parseHex(css, s.slice(1));
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = /^rgba?\((.*)\)$/.exec(s);
  if (m) return parseFunctional(css, m[1] ?? '');
  return invalid(css, 'unknown syntax');
}

/** Source-over compositing of `fg` onto `bg` (both may be translucent). */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (f: number, b: number): number => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a };
}

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance of an opaque color. */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/**
 * WCAG 2.x contrast ratio in [1, 21]. A translucent foreground is composited over the
 * background first; a translucent background is composited over white (the initial CSS
 * canvas), since what lies beneath it is unknown.
 */
export function contrastRatio(foreground: string, background: string): number {
  let bg = parseColor(background);
  if (bg.a < 1) bg = composite(bg, WHITE);
  const fg = composite(parseColor(foreground), bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const hex2 = (v: number): string =>
  Math.round(clamp(v, 0, 255))
    .toString(16)
    .padStart(2, '0');

/** `#rrggbb` when opaque, else `rgba(r, g, b, a)` (alpha rounded to 3 decimals). */
export function formatColor(c: Rgba): string {
  if (c.a >= 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();
  const r = Math.round(clamp(c.r, 0, 255));
  const g = Math.round(clamp(c.g, 0, 255));
  const b = Math.round(clamp(c.b, 0, 255));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(c.a, 0, 1) * 1000) / 1000})`;
}

/** Interpolate in sRGB with premultiplied alpha (no dark fringes when fading to transparent). */
function mixRgba(a: Rgba, b: Rgba, t: number): Rgba {
  const u = clamp(t, 0, 1);
  const alpha = a.a + (b.a - a.a) * u;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (x: number, y: number): number => (x * a.a * (1 - u) + y * b.a * u) / alpha;
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: alpha };
}

/** `a` → `b` at `t` ∈ [0, 1]. */
export function mix(a: string, b: string, t: number): string {
  return formatColor(mixRgba(parseColor(a), parseColor(b), t));
}

/** The same color with its alpha replaced. */
export function withAlpha(color: string, alpha: number): string {
  return formatColor({ ...parseColor(color), a: clamp(alpha, 0, 1) });
}

/** Move a color toward the gray of equal luma by `amount` ∈ [0, 1] (alpha kept). */
export function desaturate(color: string, amount: number): string {
  const c = parseColor(color);
  const gray = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const u = clamp(amount, 0, 1);
  return formatColor({
    r: c.r + (gray - c.r) * u,
    g: c.g + (gray - c.g) * u,
    b: c.b + (gray - c.b) * u,
    a: c.a,
  });
}

/** Precomputed interpolation `from` → `to` for allocation-free animation. */
export type ColorRamp = readonly string[];

/** Number of steps in a ramp: smooth to the eye over the ≤ 1 s transitions it is used for. */
export const RAMP_STEPS = 33;

export function colorRamp(from: string, to: string, steps: number = RAMP_STEPS): ColorRamp {
  const a = parseColor(from);
  const b = parseColor(to);
  const out: string[] = [];
  for (let i = 0; i < steps; i++) out.push(formatColor(mixRgba(a, b, i / (steps - 1))));
  // Exact endpoints: animations must settle on the very token strings.
  out[0] = from;
  out[steps - 1] = to;
  return Object.freeze(out);
}

/** Sample a ramp at `t` ∈ [0, 1]. Allocation-free. */
export function rampAt(ramp: ColorRamp, t: number): string {
  const n = ramp.length - 1;
  const i = t <= 0 ? 0 : t >= 1 ? n : Math.round(t * n);
  return ramp[i] as string;
}

/** Memoizes ramps by endpoint pair so equal transitions share one array. */
export class RampCache {
  private readonly cache = new Map<string, ColorRamp>();

  get(from: string, to: string): ColorRamp {
    const key = `${from}\u0000${to}`;
    let ramp = this.cache.get(key);
    if (ramp === undefined) {
      ramp = colorRamp(from, to);
      this.cache.set(key, ramp);
    }
    return ramp;
  }
}
