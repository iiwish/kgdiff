/**
 * @kgdiff/viewer: the drop-in `<kgdiff-viewer>` web component.
 *
 * Importing this module defines `<kgdiff-viewer>` (if not yet defined).
 * Behaviour: docs/interaction.md. Visuals: docs/visual-language.md.
 *
 * Modules: `element.ts` (the custom element), `controller.ts` (state, load pipeline, replay
 * clock, camera follow), `ui/*` (header, sidebar, detail panel, canvas chrome, popovers),
 * `i18n.ts`, `styles.ts`, `review-store.ts`, `hash-sync.ts`, `payload.ts`, `text-diff.ts`,
 * `keyboard.ts`.
 */
import type {
  Delta,
  DiffJSON,
  DiffOptions,
  DiffStats,
  GraphInput,
  KGraph,
  Locale,
  PackedDiffJSON,
} from '@kgdiff/core';
import type { ParseOptions } from '@kgdiff/formats';
import type { LayoutJSON, LayoutOptions } from '@kgdiff/layout';
import type { PaletteName } from '@kgdiff/scene';
import { KgdiffViewer } from './element.js';
import { hydrate } from './payload.js';
import { viewerTags } from './registry.js';

/** How the two versions are told apart: by color (overlay), side by side (swipe) or over time (replay). */
export type ViewerMode = 'overlay' | 'swipe' | 'replay';
/** What is drawn, in any mode: the whole graph, or only the changes with a few hops of context. */
export type ViewerScope = 'all' | 'changes';
export type ThemePreference = 'auto' | 'light' | 'dark';
/** `none`: the graph alone, for small embeds (see `KgdiffViewerElement.chrome`). */
export type ViewerChrome = 'full' | 'none';
/** The legend card, one line of dots, no legend, or `auto` (the card, one line without chrome). */
export type ViewerLegend = 'auto' | 'full' | 'mini' | 'none';

/**
 * A region of the default layout (`KgdiffViewerElement.panels`): the change list, the detail
 * panel, the search, the family filters (the sidebar's four), the view dock, the replay
 * transport, the legend, the zoom buttons, the minimap, the title and the actions.
 */
export type PanelRegion =
  | 'list'
  | 'detail'
  | 'search'
  | 'filters'
  | 'dock'
  | 'transport'
  | 'legend'
  | 'zoom'
  | 'minimap'
  | 'title'
  | 'actions';

/**
 * `open`; `collapsed`: folded to the control that opens it again (the list to its title, the
 * detail panel to its bar, the search to a button, the filters to a button, the legend to its
 * head; the sidebar folds away when all four of its regions are collapsed) and inert; `hidden`:
 * not shown, and no control brings it back. Regions without a fold of their own (dock,
 * transport, zoom, minimap, title, actions) are not shown while collapsed.
 */
export type PanelState = 'open' | 'collapsed' | 'hidden';

/** The state of every region. */
export type PanelStates = { readonly [R in PanelRegion]: PanelState };

/** The states of some regions; the others keep theirs. */
export type ViewerPanels = { readonly [R in PanelRegion]?: PanelState };

/** The default layout's panel states and sizes (`kgdiff-layout`). */
export interface ViewerLayout {
  readonly panels: PanelStates;
  /** The sidebar's width, px (360 by default). */
  readonly sidebarWidth: number;
  /**
   * The detail panel's share of the sidebar's height (0–1), once the user dragged the split
   * between it and the change list; null while it takes its content's height (up to 58%).
   */
  readonly detailShare: number | null;
}

/** A precomputed diff + layout: what the CLI embeds in HTML reports. Deterministic. */
export interface ReportPayload {
  readonly format: 'kgdiff.report';
  readonly version: 1;
  /** The diff, packed (`packDiffJSON`, what the CLI writes) or not. */
  readonly diff: DiffJSON | PackedDiffJSON;
  readonly layout: LayoutJSON;
  readonly meta: {
    readonly title?: string;
    /** e.g. `kgdiff 0.1.0`. */
    readonly generator: string;
    /** ISO timestamp; omitted for reproducible reports. */
    readonly generatedAt?: string;
    readonly before: { readonly name: string; readonly format?: string };
    readonly after: { readonly name: string; readonly format?: string };
  };
  /** Initial view preferences. */
  readonly view?: {
    /** `changes` (from reports made before scopes existed) means `overlay` + scope `changes`. */
    readonly mode?: ViewerMode;
    readonly scope?: ViewerScope;
    readonly theme?: ThemePreference;
    readonly palette?: PaletteName;
    readonly locale?: Locale;
    /**
     * Initial panel states of the default layout (`panels`). A choice the user made in the
     * viewer before, or a `panels` attribute the page sets, wins over these.
     */
    readonly panels?: ViewerPanels;
  };
}

/** A graph to load: already structured, or text to parse with @kgdiff/formats. */
export type GraphSource =
  | GraphInput
  | KGraph
  | { readonly text: string; readonly filename?: string; readonly parse?: ParseOptions };

export interface LoadOptions {
  readonly before: GraphSource;
  readonly after: GraphSource;
  readonly diff?: DiffOptions;
  readonly layout?: LayoutOptions;
  readonly names?: { readonly before?: string; readonly after?: string };
  readonly title?: string;
}

export interface ReviewState {
  /** Reviewed hunk ids, in review order. */
  readonly reviewed: readonly string[];
  readonly total: number;
}

export interface KgdiffViewerEventMap {
  'kgdiff-ready': CustomEvent<{ readonly stats: DiffStats }>;
  'kgdiff-select': CustomEvent<{ readonly hunk: string | null; readonly node: string | null }>;
  'kgdiff-mode': CustomEvent<{ readonly mode: ViewerMode; readonly scope: ViewerScope }>;
  'kgdiff-review': CustomEvent<{
    readonly hunk: string;
    readonly reviewed: boolean;
    readonly progress: ReviewState;
  }>;
  'kgdiff-error': CustomEvent<{ readonly error: Error }>;
  /**
   * Playback reached the end of the replay (not fired for seeking or stepping there). `loop`:
   * it starts again after `loopDelay` ms; set `loop = false` or call `pause()` to stop it.
   */
  'kgdiff-replay-end': CustomEvent<{ readonly loop: boolean }>;
  /**
   * The default layout changed: a panel opened, collapsed or was hidden, or a size changed (once
   * a drag ends). `source`: the user did it in the viewer, or the host (attributes, properties,
   * a report's `view.panels`).
   */
  'kgdiff-layout': CustomEvent<ViewerLayout & { readonly source: 'user' | 'host' }>;
}

export interface FitOptions {
  /** Default true (false with reduced motion). */
  readonly animate?: boolean;
  /** Room kept around the graph and its labels, px. Default 24; later automatic fits keep it. */
  readonly padding?: number;
}

/**
 * Public surface of the `<kgdiff-viewer>` element.
 *
 * Boolean attributes: `sync-hash` (deep links `#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`) and
 * `global-shortcuts`: keyboard shortcuts normally apply only while focus is inside the viewer;
 * with this attribute they also apply when nothing on the page has focus (for full-page
 * viewers such as HTML reports), except the keys pages scroll with (arrows, Home / End, Page
 * Up / Down, Space).
 *
 * `header="compact"` leaves the brand and the compared names out of the canvas, for hosts that
 * show their own (such as the playground).
 *
 * A small looping replay for another page: `mode="replay" chrome="none" loop` (with a height of
 * your choosing, such as 320px).
 */
export interface KgdiffViewerElement extends HTMLElement {
  /** Reflected to the `mode` attribute. Default `overlay`. */
  get mode(): ViewerMode;
  /** The legacy `changes` mode sets `overlay` + scope `changes`. */
  set mode(value: ViewerMode | 'changes');
  /**
   * Reflected to the `scope` attribute. Default `all` (`changes` for large graphs). Fixed to
   * `changes` when the layout covers only the changes.
   */
  scope: ViewerScope;
  /** Reflected to the `theme` attribute. Default `auto`. */
  theme: ThemePreference;
  /** Reflected to the `palette` attribute. Default `default`. */
  palette: PaletteName;
  /** Reflected to the `locale` attribute. Default from `navigator.language`. */
  locale: Locale;
  /**
   * Reflected to the `chrome` attribute. `none` shows the graph alone: no title, actions, view
   * dock (with the step caption and playback bar), change list, zoom buttons, minimap or legend
   * card; the hover tooltip and a one-line legend stay. Clicks and keyboard shortcuts do nothing, the minimum height drops
   * from 420px to 120px, and the view stays fitted: when the canvas is resized (unless the user
   * panned or zoomed since) and at the start of every loop. Labels are never cut at the edge:
   * one pushed from its spot by a neighbour moves inside or is left out. Default `full`.
   */
  chrome: ViewerChrome;
  /**
   * Panel states of the layout, as the `panels` attribute (`"detail:collapsed minimap:hidden"`)
   * or an object (`{ detail: 'collapsed' }`). Regions not named keep their state; entries that
   * name no region or state are ignored with a warning. Set by the page, they win over what
   * the user chose before (remembered) and a report's `view.panels`; the user can still open
   * and close collapsed regions. Reading it gives every region's current state. The presets
   * `sidebar="closed"` (list, detail, search and filters collapsed), `header="compact"` (title
   * hidden) and `chrome="none"` (everything but the canvas and the legend hidden) are panel
   * states too; `panels` wins over them for the regions it names.
   */
  get panels(): PanelStates;
  set panels(value: ViewerPanels | string | null);
  /**
   * Reflected to the `persist` attribute. `local` (the default): the layout remembers the
   * user's panel states, sizes, theme, palette and language in `localStorage`, for every
   * viewer of this origin. `none`: it remembers nothing.
   */
  persist: 'local' | 'none';
  /**
   * Reflected to the `legend` attribute: `full` (the card), `mini` (one line: the families this
   * diff has, then unchanged), `none`. Default `auto`: `full`, or `mini` with `chrome="none"`.
   */
  legend: ViewerLegend;
  /**
   * Reflected to the boolean `loop` attribute. In `replay` mode the replay plays by itself and
   * starts again `loopDelay` ms after it ends. `pause()` stops it until `play()`. Default false.
   */
  loop: boolean;
  /** Reflected to `loop-delay`: ms between the end of a looping replay and its restart. Default 1200. */
  loopDelay: number;
  /**
   * With `loop`, the replay pauses while the pointer is over the graph and continues when it
   * leaves (a mouse or pen; not touch). Reflected as `pause-on-hover="false"` when off. Default true.
   */
  pauseOnHover: boolean;
  /** Set a precomputed report (no diff / layout work in the browser). */
  payload: ReportPayload | null;
  /** Parse (if needed), diff, lay out and show two graphs. Rejects with a KgdiffError on bad input. */
  load(options: LoadOptions): Promise<void>;
  /** Select a hunk by id (null clears) and bring it into view. */
  selectHunk(id: string | null): void;
  next(): void;
  prev(): void;
  play(): void;
  pause(): void;
  /** Fit the whole graph, labels included, into view. */
  fit(options?: FitOptions): Promise<void>;
  /** The full delta of the current diff. */
  exportDelta(): Delta;
  reviewState(): ReviewState;
  setReviewed(hunkId: string, reviewed: boolean): void;
}

/**
 * Global through which the optional compute add-on (`@kgdiff/viewer/standalone/compute`, i.e.
 * `kgdiff-viewer-compute.js`) hands the diff engine and force layout to the standalone viewer:
 * the add-on assigns `globalThis[COMPUTE_GLOBAL]`. The viewer reads it lazily, each time it needs
 * them (`load()`, expanding a group outside a `changes`-scoped layout), so the add-on can be
 * inlined right after the viewer bundle — or loaded later — without a reload. Without it,
 * reports work fully except those two features (the expand pill says why). The ES module build
 * does not need it: it imports the same code on demand.
 */
export { COMPUTE_GLOBAL } from './compute-loader.js';

/** MIME type of the `<script>` element that carries an embedded report payload. */
export const PAYLOAD_SCRIPT_TYPE = 'application/kgdiff+json';

let constructorUsed = false;

/** Define the custom element under `tagName` (idempotent). Called automatically on import. */
export function defineViewer(tagName = 'kgdiff-viewer'): void {
  if (typeof customElements === 'undefined') return;
  const name = tagName.toLowerCase();
  if (customElements.get(name) === undefined) {
    // A constructor can be registered once: further names get a trivial subclass.
    const ctor = constructorUsed ? class extends KgdiffViewer {} : KgdiffViewer;
    customElements.define(name, ctor);
    constructorUsed = true;
  }
  viewerTags.add(name);
}

/**
 * Read embedded payloads: every `<script type="application/kgdiff+json">` (optionally with
 * `data-encoding="gzip-base64"`) is decoded and assigned to the `<kgdiff-viewer>` it targets
 * (`data-for="<element id>"`, else the first viewer in the document).
 */
export function hydrateEmbeddedPayloads(root?: ParentNode): Promise<void> {
  const scope = root ?? (typeof document !== 'undefined' ? document : undefined);
  return scope ? hydrate(scope) : Promise.resolve();
}

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-viewer': KgdiffViewerElement;
  }
}

defineViewer();
