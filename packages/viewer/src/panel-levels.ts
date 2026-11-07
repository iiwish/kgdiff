/**
 * Which level decides a panel's state in the default layout: the first of these that names the
 * region. What the user changed in this page, the host (`panels`, then the presets `sidebar`,
 * `header` and `chrome`), what the user changed before (remembered, `layout-store.ts`), the
 * report's `view.panels`, the default.
 */
import type { PanelRegion, PanelStates, ViewerPanels } from './index.js';
import { DEFAULT_PANELS, PANEL_REGIONS } from './panels.js';

type MutablePanels = { -readonly [R in PanelRegion]?: PanelStates[R] };

/** The regions of the sidebar (the bottom sheet below 760 px). */
export const SIDEBAR_REGIONS: readonly PanelRegion[] = ['list', 'detail', 'search', 'filters'];

/**
 * What the existing switches stand for: `sidebar="closed"` (and `open`), `header="compact"`,
 * `chrome="none"` (everything but the stage hidden; the legend stays, as one line).
 */
export function presetPanels(
  sidebar: string | null,
  header: string | null,
  chrome: string | null,
): ViewerPanels {
  const out: MutablePanels = {};
  if (chrome === 'none') {
    for (const r of PANEL_REGIONS) if (r !== 'legend') out[r] = 'hidden';
    return out;
  }
  if (sidebar === 'closed' || sidebar === 'open') {
    for (const r of SIDEBAR_REGIONS) out[r] = sidebar === 'open' ? 'open' : 'collapsed';
  }
  if (header === 'compact') out.title = 'hidden';
  return out;
}

/** Every region's state: the first of `levels` that names it, else the default. */
export function resolvePanels(levels: readonly ViewerPanels[]): PanelStates {
  const out = { ...DEFAULT_PANELS };
  for (const r of PANEL_REGIONS) {
    for (const level of levels) {
      const state = level[r];
      if (state !== undefined) {
        out[r] = state;
        break;
      }
    }
  }
  return out;
}

export function samePanels(a: PanelStates, b: PanelStates): boolean {
  return PANEL_REGIONS.every((r) => a[r] === b[r]);
}
