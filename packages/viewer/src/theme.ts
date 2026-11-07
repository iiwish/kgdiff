/**
 * The theme as CSS (RFC 0001 §6; decision 1: CSS is the theme's single source of truth).
 *
 * Colors and fonts are custom properties named `--kgdiff-*`. The built-in themes (dark / light
 * × default / color-blind palette, `getTheme` in @kgdiff/scene, whose contrast is tested there)
 * are token sets a root applies on `:host` (`tokenSheet`). The canvas is drawn with the tokens
 * as computed on the root (`themeFromStyle`), so a token the host overrides with ordinary CSS
 * changes the panels and the canvas alike. Motion and the interaction tints are written as
 * tokens too, for the panels; the canvas keeps the theme's own (they stay in JavaScript).
 */
import { contrastRatio, type Theme } from '@kgdiff/scene';
import { FAMILIES, sheetFor } from './styles.js';

/**
 * The public tokens (after `--kgdiff-`), each with where its value lives in a `Theme`: the
 * manifest's CSS custom properties are generated from this list.
 */
export const TOKENS: readonly (readonly [token: string, path: string])[] = [
  ['background', 'canvas.background'],
  ['grid', 'canvas.grid'],
  ['panel', 'surface.panel'],
  ['raised', 'surface.raised'],
  ['overlay', 'surface.overlay'],
  ['border', 'surface.border'],
  ['border-strong', 'surface.borderStrong'],
  ['control-border', 'surface.controlBorder'],
  ['shadow', 'surface.shadow'],
  ['text', 'text.primary'],
  ['text-secondary', 'text.secondary'],
  ['text-muted', 'text.muted'],
  ['accent', 'accent.base'],
  ['accent-strong', 'accent.strong'],
  ['accent-soft', 'accent.soft'],
  ['accent-text', 'accent.text'],
  ['neutral', 'neutral.node'],
  ['neutral-stroke', 'neutral.nodeStroke'],
  ['neutral-edge', 'neutral.edge'],
  ['neutral-label', 'neutral.label'],
  ['font', 'font.family'],
  ['font-mono', 'font.mono'],
  ...FAMILIES.flatMap((f) => [
    [f, `family.${f}.base`] as const,
    [`${f}-strong`, `family.${f}.strong`] as const,
    [`${f}-soft`, `family.${f}.soft`] as const,
    [`${f}-text`, `family.${f}.text`] as const,
  ]),
];

/** Tokens that are not colors (taken as they are). */
export const VERBATIM: ReadonlySet<string> = new Set(['shadow', 'font', 'font-mono']);

type Tree = { readonly [key: string]: unknown };

function get(theme: Theme, path: string): string {
  let at: unknown = theme;
  for (const key of path.split('.')) at = (at as Tree)[key];
  return at as string;
}

/** A copy of `tree` with `value` at `keys` (copy on write: untouched branches are shared). */
function put(tree: Tree, keys: readonly string[], value: string): Tree {
  const [key = '', ...rest] = keys;
  return { ...tree, [key]: rest.length > 0 ? put(tree[key] as Tree, rest, value) : value };
}

/** CSS custom properties for `theme` (a `:host` rule body). */
export function themeVariables(theme: Theme): string {
  const dark = theme.name === 'dark';
  const vars: [string, string][] = [['color-scheme', dark ? 'dark' : 'light']];
  for (const [token, path] of TOKENS) vars.push([token, get(theme, path)]);
  vars.push(
    ['fast', `${theme.motion.fast}ms`],
    ['base', `${theme.motion.base}ms`],
    ['slow', `${theme.motion.slow}ms`],
    ['ease', `cubic-bezier(${theme.motion.easing.join(', ')})`],
    // Derived interaction tints (not color-coded: hover / press / inputs / scrims).
    ['hover', dark ? 'rgba(255,255,255,0.045)' : 'rgba(15,23,42,0.04)'],
    ['press', dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.07)'],
    ['input', dark ? theme.surface.raised : '#F3F5F8'],
    ['selected', dark ? theme.surface.raised : '#F5F7FB'],
    ['scrim', dark ? 'rgba(5,7,11,0.56)' : 'rgba(15,23,42,0.18)'],
    ['skeleton', dark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.05)'],
    ['skeleton-hi', dark ? 'rgba(255,255,255,0.09)' : 'rgba(15,23,42,0.09)'],
    ['track', dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)'],
    ['kbd', dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)'],
  );
  return vars.map(([k, v]) => `${k === 'color-scheme' ? k : `--kgdiff-${k}`}: ${v};`).join(' ');
}

const sheets = new WeakMap<Document, Map<Theme, CSSStyleSheet>>();

/** The built-in `theme` as a token set on `:host`, parsed once per document. */
export function tokenSheet(theme: Theme, doc: Document): CSSStyleSheet {
  let byTheme = sheets.get(doc);
  if (!byTheme) {
    byTheme = new Map();
    sheets.set(doc, byTheme);
  }
  let sheet = byTheme.get(theme);
  if (!sheet) {
    sheet = sheetFor(doc, `:host { ${themeVariables(theme)} }`);
    byTheme.set(theme, sheet);
  }
  return sheet;
}

let probe: CanvasRenderingContext2D | null | undefined;
const warned = new Set<string>();

/**
 * `value` as a color the scene can parse (`#rrggbb`, `rgba()`), or null. A canvas normalizes
 * whatever sRGB color syntax the browser knows (names, `hsl()`, `color-mix()`, …).
 */
function canvasColor(value: string): string | null {
  probe ??=
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  let color = value;
  if (probe) {
    probe.fillStyle = '#000';
    probe.fillStyle = value;
    color = String(probe.fillStyle);
    probe.fillStyle = '#fff';
    probe.fillStyle = value;
    if (String(probe.fillStyle) !== color) return null;
  }
  try {
    contrastRatio(color, color);
    return color;
  } catch {
    return null;
  }
}

/** Themes built from computed tokens, by base theme and overrides (stable identities). */
const built = new Map<string, Theme>();

/**
 * The theme the canvas draws with: `base` (the built-in theme of the root's token set) with
 * every token the root's computed `style` sets to another value. Unchanged tokens keep the
 * base's identity, so caches keyed by the theme survive; a value the canvas cannot draw is
 * ignored with a warning.
 */
export function themeFromStyle(
  base: Theme,
  style: { getPropertyValue(name: string): string },
): Theme {
  const overrides: [string, string][] = [];
  for (const [token, path] of TOKENS) {
    const raw = style.getPropertyValue(`--kgdiff-${token}`).trim();
    if (!raw || raw === get(base, path)) continue;
    const value = VERBATIM.has(token) ? raw : canvasColor(raw);
    if (value === null) {
      if (!warned.has(raw)) {
        warned.add(raw);
        console.warn(`[kgdiff] --kgdiff-${token}: ${raw} is not a color the canvas draws.`);
      }
    } else if (value !== get(base, path)) overrides.push([path, value]);
  }
  if (overrides.length === 0) return base;
  const key = `${base.name}/${base.palette}|${overrides.join('|')}`;
  let theme = built.get(key);
  if (!theme) {
    let tree: Tree = base as unknown as Tree;
    for (const [path, value] of overrides) tree = put(tree, path.split('.'), value);
    theme = tree as unknown as Theme;
    if (built.size >= 16) built.clear();
    built.set(key, theme);
  }
  return theme;
}
