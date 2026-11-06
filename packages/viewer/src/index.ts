/**
 * @kgdiff/viewer: the drop-in `<kgdiff-viewer>` web component, and the elements it is made of.
 *
 * Importing this module defines `<kgdiff-viewer>` and the experimental elements
 * `<kgdiff-root>`, `<kgdiff-stage>`, `<kgdiff-change-list>`, `<kgdiff-change-detail>`,
 * `<kgdiff-search>` and `<kgdiff-filters>` (each not yet defined; each also has a subpath,
 * `@kgdiff/viewer/elements/<name>`, that defines only it). Behaviour: docs/interaction.md.
 * Visuals: docs/visual-language.md. Design: docs/rfcs/0001-viewer-components.md.
 *
 * Modules: `session.ts` (the headless diff session), `controller.ts` (its canvas view),
 * `root.ts` / `root-element.ts` (the root: keyboard map, live region, events, tokens,
 * preferences), `element.ts` (the default layout, with `panels.ts` and `layout-store.ts`),
 * `elements/*` (the public elements), `ui/*` (the regions: stage, change list, search, filters,
 * detail panel, header, sidebar, popovers), `context.ts` / `bind.ts` (how they find their root),
 * `i18n.ts`, `styles.ts`, `theme.ts`, `review-store.ts`, `hash-sync.ts`, `payload.ts`,
 * `text-diff.ts`, `keyboard.ts`.
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
import type { Keymap } from './keyboard.js';
import type { ShortcutScope } from './root-element.js';
import './elements/root.js';
import './elements/stage.js';
import './elements/change-list.js';
import './elements/change-detail.js';
import './elements/search.js';
import './elements/filters.js';
import './elements/view-dock.js';
import './elements/transport.js';
import './elements/legend.js';
import './elements/zoom.js';
import './elements/minimap.js';
import './elements/title.js';
import './elements/actions.js';
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
export type { Keymap, ShortcutName } from './keyboard.js';
export type { ShortcutScope } from './root-element.js';

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

/**
 * The version a `<kgdiff-stage>` draws whatever the mode (`version`): `before` or `after`, for
 * side-by-side canvases of one session.
 *
 * @experimental Like the elements, in 0.6.
 */
export type StageVersion = 'before' | 'after';

/**
 * The regions of `<kgdiff-stage>`'s built-in chrome (its `panels`).
 *
 * @experimental Like the elements, in 0.6.
 */
export type StageRegion = 'dock' | 'transport' | 'legend' | 'zoom' | 'minimap';

/**
 * The states of some of the stage's chrome regions; the others keep theirs.
 *
 * @experimental Like the elements, in 0.6.
 */
export type StagePanels = { readonly [R in StageRegion]?: PanelState };

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

/**
 * The events of `<kgdiff-viewer>` and `<kgdiff-root>` (`CustomEvent`s that bubble and are
 * composed). Merged into the global event maps, so `addEventListener('kgdiff-select', …)` on
 * any element, the document or the window types `event.detail`.
 */
export interface KgdiffEventMap {
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
 * What `<kgdiff-viewer>` and `<kgdiff-root>` share: a root of a diff session, its preferences,
 * methods and events (`KgdiffEventMap`, but `kgdiff-layout`).
 *
 * Boolean attribute `sync-hash`: deep links `#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`.
 *
 * `<kgdiff-viewer>` is stable; `<kgdiff-root>`, the element of this type on its own, is
 * experimental in 0.6 (its tag name map entry says so).
 */
export interface KgdiffRootElement extends HTMLElement {
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
  /**
   * Reflected to the `shortcuts` attribute: where the keyboard shortcuts apply. `scoped` (the
   * default): while focus is inside the root, or in an element bound to it with `for` (those
   * forward their keys). `global`: also when nothing on the page has focus (for full-page
   * viewers such as HTML reports), for the first such root, except the keys pages scroll with
   * (arrows, Home / End, Page Up / Down, Space); the boolean `global-shortcuts` attribute is an
   * alias. `none`: no shortcuts (a focused change list keeps its arrow keys, Home / End and
   * Enter).
   */
  shortcuts: ShortcutScope;
  /**
   * Single keys of the keyboard map bound to another shortcut, or unbound with `null`:
   * `{ x: null, r: 'review' }`. The `keymap` attribute takes the same as text,
   * `"x:none r:review"` (`Space` names the space bar). Keys are `KeyboardEvent.key` values; a
   * letter stands for both its cases unless the other case is named too; keys not named keep the
   * default map; entries naming no shortcut are ignored with a warning.
   *
   * @experimental The shortcut names (`ShortcutName`) are new in 0.6.
   */
  get keymap(): Keymap | null;
  set keymap(value: Keymap | string | null);
  /**
   * Draw the canvas with the `--kgdiff-*` tokens as computed now: after the page changed
   * tokens in a way the root cannot observe (a class on an ancestor, a new stylesheet). Theme,
   * palette and system color scheme changes are followed by themselves.
   */
  refreshTheme(): void;
}

/**
 * Public surface of the `<kgdiff-viewer>` element: a root (`KgdiffRootElement`) with the
 * default layout.
 *
 * `header="compact"` leaves the brand and the compared names out of the canvas, for hosts that
 * show their own (such as the playground): the preset `panels="title:hidden"`.
 * `sidebar="closed"` starts with the sidebar folded (`\` and the sidebar button open it).
 *
 * A small looping replay for another page: `mode="replay" chrome="none" loop` (with a height of
 * your choosing, such as 320px).
 *
 * The canvas has the slots of `<kgdiff-stage>` (`top-start`, `top-end`, `bottom-start`,
 * `bottom-center`, `bottom-end`; the top ones under the title and the actions): a child with
 * `slot="top-end"` goes over the canvas, kept clear of fits and flights. A chrome element
 * slotted in replaces the built-in region; `<kgdiff-zoom>` and `<kgdiff-minimap>` inside the
 * viewer act on its canvas.
 */
export interface KgdiffViewerElement extends KgdiffRootElement {
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
   * The page's declaration of panel states, reflected to the `panels` attribute: a string
   * (`"detail:collapsed minimap:hidden"`) or an object (`{ detail: 'collapsed' }`); reading it
   * gives the object. Regions not named keep their state; entries that name no region or
   * state are ignored with a warning. It wins over what the user chose before (remembered) and
   * a report's `view.panels`; the user can still open and close collapsed regions, and
   * declaring the same again keeps what they did. The presets `sidebar="closed"` (list,
   * detail, search and filters collapsed), `header="compact"` (title hidden) and
   * `chrome="none"` (everything but the canvas and the legend hidden) are panel states too;
   * `panels` wins over them for the regions it names. The states every region has now are in
   * `layout`.
   */
  get panels(): ViewerPanels;
  set panels(value: ViewerPanels | string | null);
  /** Every region's state and the sizes now (what `kgdiff-layout` reports, without `source`). */
  readonly layout: ViewerLayout;
  /**
   * Reflected to the `persist` attribute. `local` (the default): the layout remembers the
   * user's panel states, sizes, theme, palette and language in `localStorage` (under
   * `persistKey`, shared by the viewers of the origin with the same key). `none`: it remembers
   * nothing.
   */
  persist: 'local' | 'none';
  /**
   * Reflected to the `persist-key` attribute: the `localStorage` key the layout remembers
   * under. Viewers with the same key share what they remember; give each app on a shared origin
   * (a GitHub Pages user site, say) a key of its own. Default `kgdiff:viewer`.
   */
  persistKey: string;
  /**
   * Reflected to the `legend` attribute: `full` (the card), `mini` (one line: the families this
   * diff has, then unchanged), `none`. Default `auto`: `full`, or `mini` with `chrome="none"`.
   */
  legend: ViewerLegend;
}

/**
 * An element bound to a root (experimental): `<kgdiff-stage>`, `<kgdiff-change-list>`,
 * `<kgdiff-change-detail>`, `<kgdiff-search>`, `<kgdiff-filters>`. It shows the session of the
 * nearest `<kgdiff-root>` or `<kgdiff-viewer>` around it (across shadow roots), or of the one
 * named by its `for` attribute (an element id) anywhere on the page; a root defined or
 * connected later is found then. *
 * @experimental The elements are experimental in 0.6: names, attributes and markup may change
 * in a minor release before they are stable.
 */
export interface KgdiffBoundElement extends HTMLElement {
  /**
   * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
   * or '' for the nearest one around the element. Changing it binds again.
   */
  htmlFor: string;
  /** The root this element shows, or null while it waits for one. */
  readonly root: KgdiffRootElement | null;
}

/**
 * `<kgdiff-legend>`'s `variant`: `full` (the card of every family) or `mini` (one line).
 *
 * @experimental Like the elements, in 0.6.
 */
export type LegendVariant = 'full' | 'mini';

/**
 * `<kgdiff-legend>` (experimental): what the colors mean, bound to a root.
 *
 * @experimental The elements are experimental in 0.6: names, attributes and markup may change
 * in a minor release before they are stable.
 */
export interface KgdiffLegendElement extends KgdiffBoundElement {
  /** Reflected to `variant`: `full` (default) or `mini`; another value reads `full`. */
  variant: LegendVariant;
  /** Reflected to the boolean `open`: whether the card is open (the user's toggle too). */
  open: boolean;
}

/**
 * An element that acts on one stage's view (experimental): `<kgdiff-zoom>`,
 * `<kgdiff-minimap>`. It binds to the nearest `<kgdiff-stage>` around it, or to the one its
 * `stage` attribute (an element id) names anywhere on the page.
 *
 * @experimental The elements are experimental in 0.6: names, attributes and markup may change
 * in a minor release before they are stable.
 */
export interface KgdiffStageBoundElement extends HTMLElement {
  /**
   * Reflects the `stage` attribute: the id of the stage to act on, or '' for the nearest one
   * around the element. Changing it binds again.
   */
  stageId: string;
  /**
   * The stage this element acts on, or null while it waits for one. Inside a `<kgdiff-viewer>`
   * (or naming one) it is the viewer, whose built-in stage it acts on.
   */
  readonly stageElement: KgdiffStageElement | KgdiffViewerElement | null;
}

/**
 * `<kgdiff-minimap>` (experimental): an overview of one stage's view.
 *
 * @experimental The elements are experimental in 0.6: names, attributes and markup may change
 * in a minor release before they are stable.
 */
export interface KgdiffMinimapElement extends KgdiffStageBoundElement {
  /**
   * Whether the whole graph is in view, reflected to the boolean `overview` attribute; the
   * minimap hides while it is (`kgdiff-minimap[overview] { display: block }` keeps it).
   */
  readonly overview: boolean;
}

/**
 * `<kgdiff-stage>` (experimental): the canvas, with five named slots for the page's content
 * over it (`top-start`, `top-end`, `bottom-start`, `bottom-center`, `bottom-end`). Every
 * slotted element is kept clear of fits and flights. A chrome element slotted in
 * (`<kgdiff-view-dock>`, `<kgdiff-transport>`, `<kgdiff-legend>`, `<kgdiff-zoom>`,
 * `<kgdiff-minimap>`) replaces the built-in region; `panels` keeps applying to the rest. Content
 * placed anywhere else over the canvas is no obstacle unless registered (`registerObstacle`).
 *
 * @experimental The elements are experimental in 0.6: names, attributes and markup may change
 * in a minor release before they are stable.
 */
export interface KgdiffStageElement extends KgdiffBoundElement {
  /**
   * The states of the built-in chrome (`dock`, `transport`, `legend`, `zoom`, `minimap`),
   * reflected to the `panels` attribute, in the syntax of `<kgdiff-viewer>`'s `panels`:
   * `"minimap:hidden zoom:hidden"` or `{ minimap: 'hidden' }`; reading it gives the object.
   * Other regions are ignored with a warning. Default: all open, the legend collapsed.
   */
  get panels(): StagePanels;
  set panels(value: StagePanels | string | null);
  /**
   * Reflected to the `version` attribute: the version this stage draws whatever the root's
   * mode, `before` or `after` (two stages of one root side by side), or null to follow the
   * mode. Another value is ignored with a warning. Each stage has its own camera; the
   * selection, hover, filters and search are the root's, so both bring the same change into
   * view.
   */
  version: StageVersion | null;
  /**
   * Keep `element` (content over the canvas the stage does not place) clear of fits and
   * flights; returns the function that stops it. Also on the stage context descendants can
   * request (`Symbol.for('kgdiff.stage/1')`).
   */
  registerObstacle(element: Element): () => void;
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

/** @deprecated Use `KgdiffEventMap` (the same map, for the viewer and its elements). */
export type KgdiffViewerEventMap = KgdiffEventMap;

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-viewer': KgdiffViewerElement;
  }
  // The events bubble and are composed: elements, the document and the window all see them.
  interface GlobalEventHandlersEventMap extends KgdiffEventMap {}
}

defineViewer();
