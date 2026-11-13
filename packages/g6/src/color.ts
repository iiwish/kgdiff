/**
 * The few color operations G6 cannot do for us: compositing translucent badge tints over the
 * canvas (the native renderer paints an opaque base first) and building glow gradients.
 * Scene tokens are `#rgb` / `#rrggbb` / `#rrggbbaa` or `rgb()` / `rgba()`; anything else is
 * passed through unchanged.
 */

/** [r, g, b] in 0–255 and alpha in [0, 1]. */
export type Rgba = readonly [number, number, number, number];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// No `\s*` before the group: `[^)]*` takes the spaces too (the split below drops them), and two
// quantifiers that both match spaces made the match quadratic in a long unclosed `rgb(`.
const FUNC = /^rgba?\(([^)]*)\)$/i;

function clampByte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function clampUnit(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Parse a hex or `rgb()` / `rgba()` color; null for anything else. */
export function parseColor(color: string): Rgba | null {
  const s = color.trim();
  const hex = HEX.exec(s);
  if (hex !== null) {
    let h = hex[1] as string;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = FUNC.exec(s);
  if (fn === null) return null;
  const parts = (fn[1] as string).split(/[\s,/]+/).filter((p) => p.length > 0);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const nums = parts.map((p) =>
    p.endsWith('%') ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p),
  );
  if (nums.some((v) => !Number.isFinite(v))) return null;
  const alphaPart = parts[3];
  const alpha =
    alphaPart === undefined
      ? 1
      : alphaPart.endsWith('%')
        ? Number.parseFloat(alphaPart) / 100
        : Number.parseFloat(alphaPart);
  return [
    clampByte(nums[0] as number),
    clampByte(nums[1] as number),
    clampByte(nums[2] as number),
    clampUnit(alpha),
  ];
}

/** `rgba(r, g, b, a)` with `a` multiplied into the color's own alpha. */
export function withAlpha(color: Rgba, alpha: number): string {
  const a = Math.round(clampUnit(color[3] * alpha) * 1000) / 1000;
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${a})`;
}

/**
 * `top` painted over `bottom` (source-over) as an opaque `rgb()` color. Returns `top` unchanged
 * when either color cannot be parsed, and `top` itself when it is already opaque.
 */
export function composite(top: string, bottom: string): string {
  const t = parseColor(top);
  const b = parseColor(bottom);
  if (t === null || b === null || t[3] >= 1) return top;
  const a = t[3];
  const mix = (i: 0 | 1 | 2): number => clampByte(t[i] * a + b[i] * (1 - a));
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** Glow falloff of the native renderer: (radius fraction, alpha) — a soft, roughly Gaussian profile. */
const GLOW_STOPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.3, 0.9],
  [0.5, 0.6],
  [0.7, 0.28],
  [0.86, 0.08],
  [1, 0],
];

const gradients = new Map<string, string>();

/**
 * A CSS radial gradient (parsed by AntV G) filling a circle with the native glow profile in
 * `color`; `closest-side` makes the gradient end exactly at the circle's radius. Memoized: the
 * string doubles as G's gradient cache key. Falls back to the plain color when unparsable.
 */
export function glowGradient(color: string): string {
  let g = gradients.get(color);
  if (g !== undefined) return g;
  const rgba = parseColor(color);
  if (rgba === null) return color;
  const stops = GLOW_STOPS.map(([at, alpha]) => `${withAlpha(rgba, alpha)} ${at * 100}%`);
  g = `radial-gradient(circle closest-side, ${stops.join(', ')})`;
  if (gradients.size > 256) gradients.clear();
  gradients.set(color, g);
  return g;
}
