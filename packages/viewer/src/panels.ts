/**
 * Panel states of the default layout (RFC 0001 §4): every region is `open`, `collapsed` or
 * `hidden`. The `panels` attribute (`"detail:collapsed minimap:hidden"`), its object property, a
 * report's `view.panels` and the CLI's `--panels` all go through `parsePanels` / `toPanels`.
 *
 * A region's state comes from the first of these that names it: what the user changed in this
 * page, the host (`panels`, then the presets `sidebar`, `header` and `chrome`), what the user
 * changed before (remembered, `layout-store.ts`), the report's `view.panels`, the default.
 */
import type { PanelRegion, PanelState, PanelStates, ViewerPanels } from './index.js';

export const PANEL_REGIONS: readonly PanelRegion[] = [
  'list',
  'detail',
  'search',
  'filters',
  'dock',
  'transport',
  'legend',
  'zoom',
  'minimap',
  'title',
  'actions',
];

export const PANEL_STATES: readonly PanelState[] = ['open', 'collapsed', 'hidden'];

/** The regions of the sidebar (the bottom sheet below 760 px). */
export const SIDEBAR_REGIONS: readonly PanelRegion[] = ['list', 'detail', 'search', 'filters'];

/** Today's layout. The legend card starts folded to its head. */
export const DEFAULT_PANELS: PanelStates = {
  list: 'open',
  detail: 'open',
  search: 'open',
  filters: 'open',
  dock: 'open',
  transport: 'open',
  legend: 'collapsed',
  zoom: 'open',
  minimap: 'open',
  title: 'open',
  actions: 'open',
};

type MutablePanels = { -readonly [R in PanelRegion]?: PanelState };

const isRegion = (r: unknown): r is PanelRegion => PANEL_REGIONS.includes(r as PanelRegion);
const isState = (s: unknown): s is PanelState => PANEL_STATES.includes(s as PanelState);

/**
 * Read `"region:state …"` (pairs separated by spaces or commas). Pairs that name no region or
 * no state are left out and returned in `invalid`; a region named twice takes the last state.
 */
export function parsePanels(text: string): { panels: ViewerPanels; invalid: string[] } {
  const panels: MutablePanels = {};
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (token === '') continue;
    const [region, state, ...rest] = token.split(':');
    if (rest.length === 0 && isRegion(region) && isState(state)) panels[region] = state;
    else invalid.push(token);
  }
  return { panels, invalid };
}

/** Panels from an attribute, a property or a report (a string or an object), as `parsePanels`. */
export function toPanels(value: unknown): { panels: ViewerPanels; invalid: string[] } {
  if (typeof value === 'string') return parsePanels(value);
  const panels: MutablePanels = {};
  const invalid: string[] = [];
  if (typeof value === 'object' && value !== null) {
    for (const [region, state] of Object.entries(value)) {
      if (isRegion(region) && isState(state)) panels[region] = state;
      else invalid.push(`${region}:${String(state)}`);
    }
  } else if (value !== null && value !== undefined) invalid.push(String(value));
  return { panels, invalid };
}

/** The attribute form of `panels`, in region order. */
export function formatPanels(panels: ViewerPanels): string {
  return PANEL_REGIONS.filter((r) => panels[r] !== undefined)
    .map((r) => `${r}:${panels[r]}`)
    .join(' ');
}

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
