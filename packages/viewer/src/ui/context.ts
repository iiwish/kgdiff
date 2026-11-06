/**
 * What UI components share: the session (`controller`), the layout's actions, the translator
 * and the root's focus targets.
 */
import type { AttrValue, HunkKind, Locale } from '@kgdiff/core';
import type { ChangeFamily, PaletteName, SceneHunk } from '@kgdiff/scene';
import type { ViewerController } from '../controller.js';
import type { Translator } from '../i18n.js';
import type { ThemePreference, ViewerMode } from '../index.js';

/**
 * What the layout does for the regions (preferences it reflects as attributes, the panels and
 * popovers it owns).
 */
export interface UiActions {
  readonly tr: () => Translator;
  setMode(mode: ViewerMode): void;
  /** Toggle the `changes` scope (explains itself when it is locked). */
  toggleScope(): void;
  setThemePreference(pref: ThemePreference): void;
  setPalette(palette: PaletteName): void;
  setLocale(locale: Locale): void;
  toggleSidebar(open?: boolean): void;
  sidebarOpen(): boolean;
  toggleMenu(open?: boolean): void;
  openHelp(): void;
  /** Show and focus the search (`/`). */
  focusSearch(): void;
}

/** Elements of a region that others move focus to, through the root. */
export type FocusTarget = 'search' | 'list';

/** What a region gets from the root it is bound to: the session, the actions, focus moves. */
export interface UiContext extends UiActions {
  readonly controller: ViewerController;
  /** Root of the region's shadow tree (for focus management). */
  readonly root: ShadowRoot;
  /** Register `focus` as the root's `name` target; returns the function that unregisters it. */
  target(name: FocusTarget, focus: () => void): () => void;
  /** Focus the root's `name` target registered last; false when there is none. */
  focus(name: FocusTarget): boolean;
}

/** One-character glyph of a hunk (docs/interaction.md §Change list): `+ − ~ ⇄ ⊕ ⑂`. */
export function hunkGlyph(kind: HunkKind, family: ChangeFamily): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'remove':
      return '−';
    case 'merge':
      return '⊕';
    case 'split':
      return '⑂';
    case 'relations':
      return '⇄';
    case 'modify':
      return family === 'structure' ? '⇄' : family === 'identity' ? '≡' : '~';
    default:
      return '~';
  }
}

export function sceneHunkGlyph(h: SceneHunk): string {
  return hunkGlyph(h.kind, h.family);
}

/** Single-line display form of an attribute value. */
export function formatValue(value: AttrValue | undefined): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => formatValue(v as AttrValue)).join(', ');
  return JSON.stringify(value);
}

/** Items of a list-like value (arrays of scalars), else null. */
export function listItems(value: AttrValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value as readonly AttrValue[]) {
    if (typeof v === 'object' && v !== null) return null;
    out.push(formatValue(v));
  }
  return out;
}
