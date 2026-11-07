/**
 * `@kgdiff/viewer/panels`: the syntax of the default layout's panel states (RFC 0001 §4), every
 * region `open`, `collapsed` or `hidden`. The `panels` attribute
 * (`"detail:collapsed minimap:hidden"`), its object property, a report's `view.panels` and the
 * CLI's `--panels` all go through `parsePanels` / `toPanels`. No DOM: the CLI imports it.
 * Which level decides a region's state is `panel-levels.ts`.
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
