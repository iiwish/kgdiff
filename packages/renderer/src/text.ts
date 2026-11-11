/** Fonts, cached text measurement and ellipsis fitting for screen-space labels. */
import type { Theme } from '@kgdiff/scene';
import type { Ctx2D } from './ctx.js';

/** Labels longer than this (css px) are truncated with an ellipsis. */
export const LABEL_MAX_WIDTH = 240;
const MAX_CACHED = 20_000;

/** Line box height for a font size (px). */
export function lineHeight(size: number): number {
  return Math.round(size * 1.3);
}

/** Interned CSS font strings (the theme's stacks are long; never rebuilt per frame). */
export class Fonts {
  private readonly cache = new Map<number, string>();
  private family: string;
  private mono: string;

  constructor(theme: Theme) {
    this.family = theme.font.family;
    this.mono = theme.font.mono;
  }

  setTheme(theme: Theme): void {
    if (theme.font.family === this.family && theme.font.mono === this.mono) return;
    this.family = theme.font.family;
    this.mono = theme.font.mono;
    this.cache.clear();
  }

  /** `weight size family` for the label (or mono) stack. */
  get(size: number, weight: number, mono = false): string {
    const key = (mono ? -1 : 1) * (Math.round(weight) * 10_000 + Math.round(size * 100));
    let font = this.cache.get(key);
    if (font === undefined) {
      font = `${Math.round(weight)} ${Math.round(size * 100) / 100}px ${mono ? this.mono : this.family}`;
      this.cache.set(key, font);
    }
    return font;
  }
}

const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;

/** Width estimate when no 2D context exists (tests, workers without OffscreenCanvas). */
function estimateWidth(font: string, text: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  const size = m ? Number(m[1]) : 12;
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? size : size * 0.58;
  return w;
}

/** Measures text with a 2D context, caching widths per font + text. */
export class TextMeasurer {
  private readonly widths = new Map<string, Map<string, number>>();
  private readonly fitted = new Map<string, Map<string, string>>();
  private count = 0;
  private font = '';

  constructor(private ctx: Ctx2D | null) {}

  setContext(ctx: Ctx2D | null): void {
    this.ctx = ctx;
    this.clear();
  }

  /** Forget everything (fonts finished loading, theme fonts changed). */
  clear(): void {
    this.widths.clear();
    this.fitted.clear();
    this.count = 0;
    this.font = '';
  }

  width(font: string, text: string): number {
    let byText = this.widths.get(font);
    if (!byText) {
      byText = new Map();
      this.widths.set(font, byText);
    }
    let w = byText.get(text);
    if (w === undefined) {
      w = this.measure(font, text);
      if (++this.count > MAX_CACHED) {
        this.widths.clear();
        this.fitted.clear();
        this.count = 0;
        byText = new Map();
        this.widths.set(font, byText);
      }
      byText.set(text, w);
    }
    return w;
  }

  /** `text`, truncated with “…” so it is at most `maxWidth` px wide (code-point safe). */
  fit(font: string, text: string, maxWidth: number = LABEL_MAX_WIDTH): string {
    if (this.width(font, text) <= maxWidth) return text;
    let byText = this.fitted.get(font);
    if (!byText) {
      byText = new Map();
      this.fitted.set(font, byText);
    }
    const hit = byText.get(text);
    if (hit !== undefined) return hit;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.measure(font, `${chars.slice(0, mid).join('').trimEnd()}…`) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    const out = `${chars.slice(0, lo).join('').trimEnd()}…`;
    byText.set(text, out);
    return out;
  }

  private measure(font: string, text: string): number {
    const ctx = this.ctx;
    if (!ctx) return estimateWidth(font, text);
    if (this.font !== font) {
      ctx.font = font;
      this.font = font;
    }
    return ctx.measureText(text).width;
  }
}
