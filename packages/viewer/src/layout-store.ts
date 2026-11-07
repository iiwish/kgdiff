/**
 * What the default layout remembers of the user's choices (RFC 0001 §4, decision 3): panel
 * states, the sidebar's width, the split between the change list and the detail panel, theme,
 * palette and language. One `localStorage` entry (`kgdiff:viewer`, or the viewer's
 * `persist-key`), shared by the viewers of the origin that use the same key. Like review progress (`review-store.ts`), storage failures
 * (private mode, quota, sandboxed iframes) never break the viewer: nothing is remembered then.
 * Values are validated when read; an entry from another version is read as far as it is valid.
 */
import type { Locale } from '@kgdiff/core';
import type { PaletteName } from '@kgdiff/scene';
import type { ThemePreference, ViewerPanels } from './index.js';
import { toPanels } from './panels.js';
import { toLocale, toPalette, toTheme } from './prefs.js';
import type { StorageLike } from './review-store.js';

/** The default storage key (`persist-key`). */
export const LAYOUT_KEY = 'kgdiff:viewer';

export interface Remembered {
  readonly panels: ViewerPanels;
  readonly sidebarWidth?: number;
  /** Null: the user reset the split (the detail panel takes its content's height). */
  readonly detailShare?: number | null;
  readonly theme?: ThemePreference;
  readonly palette?: PaletteName;
  readonly locale?: Locale;
}

const NOTHING: Remembered = { panels: {} };

const finite = (x: unknown, min: number, max: number): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : undefined;

export function readRemembered(storage: StorageLike | null, key = LAYOUT_KEY): Remembered {
  if (!storage) return NOTHING;
  try {
    const raw = storage.getItem(key);
    if (!raw) return NOTHING;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return NOTHING;
    const o = v as Record<string, unknown>;
    const sidebarWidth = finite(o.sidebarWidth, 0, 10_000);
    const detailShare = finite(o.detailShare, 0, 1);
    const theme = toTheme(o.theme);
    const palette = toPalette(o.palette);
    const locale = toLocale(o.locale);
    return {
      panels: toPanels(o.panels).panels,
      ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
      ...(detailShare !== undefined ? { detailShare } : {}),
      ...(theme ? { theme } : {}),
      ...(palette ? { palette } : {}),
      ...(locale ? { locale } : {}),
    };
  } catch {
    return NOTHING;
  }
}

export function writeRemembered(
  storage: StorageLike | null,
  value: Remembered,
  key = LAYOUT_KEY,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ v: 1, ...value }));
  } catch {
    // Quota exceeded or storage blocked: the choice holds for this page only.
  }
}
