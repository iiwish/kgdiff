/**
 * The one place viewer preferences are validated: attributes, properties and a report's `view`
 * all go through these. Invalid values never reach the controller (they fall back, with a
 * console warning for payloads, which come from files rather than code).
 */
import type { Locale } from '@kgdiff/core';
import { isNodeShape, type NodeShape, type PaletteName } from '@kgdiff/scene';
import { normalizeLocale } from './i18n.js';
import type {
  ReportPayload,
  ThemePreference,
  ViewerChrome,
  ViewerLegend,
  ViewerMode,
  ViewerScope,
} from './index.js';
import { toPanels } from './panels.js';

const MODES: readonly ViewerMode[] = ['overlay', 'swipe', 'replay'];
const SCOPES: readonly ViewerScope[] = ['all', 'changes'];
const THEMES: readonly ThemePreference[] = ['auto', 'light', 'dark'];
const PALETTES: readonly PaletteName[] = ['default', 'colorblind'];
const CHROMES: readonly ViewerChrome[] = ['full', 'none'];
const LEGENDS: readonly ViewerLegend[] = ['auto', 'full', 'mini', 'none'];

/** Pause between the end of a looping replay and its next start, ms. */
export const DEFAULT_LOOP_DELAY = 1200;

export const THEME_PREFERENCES = THEMES;

export function toMode(value: unknown): ViewerMode | null {
  return MODES.includes(value as ViewerMode) ? (value as ViewerMode) : null;
}

export function toScope(value: unknown): ViewerScope | null {
  return SCOPES.includes(value as ViewerScope) ? (value as ViewerScope) : null;
}

export function toTheme(value: unknown): ThemePreference | null {
  return THEMES.includes(value as ThemePreference) ? (value as ThemePreference) : null;
}

export function toPalette(value: unknown): PaletteName | null {
  return PALETTES.includes(value as PaletteName) ? (value as PaletteName) : null;
}

export function toLocale(value: unknown): Locale | null {
  return typeof value === 'string' ? normalizeLocale(value) : null;
}

export function toChrome(value: unknown): ViewerChrome | null {
  return CHROMES.includes(value as ViewerChrome) ? (value as ViewerChrome) : null;
}

export function toLegend(value: unknown): ViewerLegend | null {
  return LEGENDS.includes(value as ViewerLegend) ? (value as ViewerLegend) : null;
}

/** A delay in ms (number or numeric string), at least 0. */
export function toDelay(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

type View = NonNullable<ReportPayload['view']>;

/** The entries of a report's `view.shapes` with a known shape, and the types of the others. */
function toShapes(value: unknown): {
  shapes: Readonly<Record<string, NodeShape>> | null;
  invalid: readonly string[];
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { shapes: null, invalid: value === undefined ? [] : ['shapes'] };
  }
  const shapes: Record<string, NodeShape> = {};
  const invalid: string[] = [];
  for (const [type, shape] of Object.entries(value)) {
    if (isNodeShape(shape)) shapes[type] = shape;
    else invalid.push(`shapes.${type}`);
  }
  return { shapes: Object.keys(shapes).length > 0 ? shapes : null, invalid };
}

/**
 * Keep only the valid fields of a report's `view`, warning about the rest (once per payload:
 * `quiet` for a second read of the same view).
 */
export function sanitizeView(view: unknown, quiet = false): View | undefined {
  if (typeof view !== 'object' || view === null) return undefined;
  const v = view as Record<string, unknown>;
  const mode = toMode(v.mode);
  const scope = toScope(v.scope);
  const theme = toTheme(v.theme);
  const palette = toPalette(v.palette);
  const locale = toLocale(v.locale);
  const read = v.panels === undefined ? null : toPanels(v.panels);
  const panels = read && Object.keys(read.panels).length > 0 ? read.panels : null;
  const dropped: string[] = (['mode', 'scope', 'theme', 'palette', 'locale'] as const).filter(
    (k) => v[k] !== undefined && { mode, scope, theme, palette, locale }[k] === null,
  );
  if (read && read.invalid.length > 0) dropped.push(`panels (${read.invalid.join(' ')})`);
  const { shapes, invalid } = toShapes(v.shapes);
  dropped.push(...invalid);
  if (dropped.length > 0 && !quiet && typeof console !== 'undefined') {
    console.warn(`[kgdiff] ignoring invalid report view preferences: ${dropped.join(', ')}`);
  }
  return {
    ...(mode ? { mode } : {}),
    ...(scope ? { scope } : {}),
    ...(theme ? { theme } : {}),
    ...(palette ? { palette } : {}),
    ...(locale ? { locale } : {}),
    ...(panels ? { panels } : {}),
    ...(shapes ? { shapes } : {}),
  };
}
