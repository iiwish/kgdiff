/**
 * `<kgdiff-viewer>`, the default layout (RFC 0001 §4): a root (`root-element.ts`: the session,
 * keyboard map, live region, events, theme tokens, preferences and methods) and the regions
 * bound to it, the stage with its chrome, the change list, the search, the family filters and
 * the detail panel, placed as they always were (a 360 px sidebar; a bottom sheet below 760 px).
 *
 * Every region has a panel state (`panels.ts`): the host's `panels` attribute or property and
 * the presets `sidebar`, `header` and `chrome` set them, the user changes them (folding the
 * sidebar, the list or the detail panel, opening the legend, dragging the sidebar's width or
 * the list / detail split), and the layout remembers the user's choices, theme, palette and
 * language per origin (`layout-store.ts`; `persist="none"` turns that off). `kgdiff-layout`
 * reports every change.
 */
import { h } from './dom.js';
import type {
  KgdiffViewerElement,
  LoadOptions,
  PanelRegion,
  PanelStates,
  ReportPayload,
  ViewerChrome,
  ViewerLayout,
  ViewerLegend,
  ViewerPanels,
} from './index.js';
import { type Remembered, readRemembered, writeRemembered } from './layout-store.js';
import { presetPanels, resolvePanels, SIDEBAR_REGIONS, samePanels } from './panel-levels.js';
import { DEFAULT_PANELS, formatPanels, PANEL_REGIONS, parsePanels, toPanels } from './panels.js';
import { sanitizeView, toChrome, toLegend } from './prefs.js';
import { defaultStorage } from './review-store.js';
import { bindRegion, uiContext } from './root.js';
import { ROOT_ATTRIBUTES, RootElement } from './root-element.js';
import type { Topic } from './session.js';
import { stylesheet } from './styles.js';
import { ChangeList } from './ui/change-list.js';
import type { UiActions } from './ui/context.js';
import { Detail } from './ui/detail.js';
import { Filters } from './ui/filters.js';
import { Header } from './ui/header.js';
import { HelpDialog, Menu } from './ui/popovers.js';
import { Search } from './ui/search.js';
import { SIDEBAR_WIDTH, Sidebar } from './ui/sidebar.js';
import { Stage } from './ui/stage.js';

/** Below this width the sidebar becomes a bottom sheet. */
export const COMPACT_WIDTH = 760;
/** Below this width the title drops the version tags. */
const NARROW_WIDTH = 1100;

const OBSERVED = [
  ...ROOT_ATTRIBUTES,
  'sidebar',
  'header',
  'chrome',
  'legend',
  'panels',
  'persist',
] as const;

type Preset = 'sidebar' | 'header' | 'chrome';
type MutablePanels = { -readonly [R in PanelRegion]?: PanelStates[R] };

function warnPanels(invalid: readonly string[]): void {
  if (invalid.length > 0) console.warn(`[kgdiff] ignoring invalid panels: ${invalid.join(' ')}`);
}

export class KgdiffViewer extends RootElement implements KgdiffViewerElement {
  static get observedAttributes(): readonly string[] {
    return OBSERVED;
  }

  #ui: {
    root: HTMLElement;
    header: Header;
    stage: Stage;
    list: ChangeList;
    sidebar: Sidebar;
    menu: Menu;
    help: HelpDialog;
  } | null = null;
  #compact = false;
  readonly #cleanup: (() => void)[] = [];

  // Panel states, from the first level that names a region (see `panels.ts`).
  /** What the user changed in this page. */
  readonly #runtime: MutablePanels = {};
  /** The host's `panels`. */
  #hostPanels: ViewerPanels = {};
  /** The presets, from the attributes as the host set them (not as the layout reflects them). */
  readonly #presetAttrs: Record<Preset, string | null> = {
    sidebar: null,
    header: null,
    chrome: null,
  };
  #presets: ViewerPanels = {};
  /** What the user chose before (`persist`), read at the first connection. */
  #remembered: Remembered = { panels: {} };
  /** The report's `view.panels`. */
  #report: ViewerPanels = {};
  #states: PanelStates = DEFAULT_PANELS;
  /** The sidebar's regions that were open when the user folded it. */
  #folded: readonly PanelRegion[] | null = null;
  /** `kgdiff-layout` reports changes from the first connection on. */
  #layoutReady = false;
  readonly #storage = defaultStorage();

  constructor() {
    super();
    // The layout renders first, then the regions in the order they bound to the root.
    this.root.attach({ update: (topics) => this.#update(topics) });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  protected connected(): void {
    if (!this.#ui) this.#build();
    const ui = this.#ui;
    if (!ui) return;
    if (!this.#layoutReady) {
      this.#loadRemembered();
      this.#layoutReady = true;
    }
    this.controller.attach(ui.stage.canvasHost, ui.stage.minimapHost);
    // The graph takes keyboard focus (shortcuts apply where focus is), also on click.
    const canvas = this.#canvas();
    if (canvas) {
      canvas.tabIndex = this.chrome === 'none' ? -1 : 0;
      const focusCanvas = (): void => {
        if (this.chrome !== 'none') canvas.focus({ preventScroll: true });
      };
      canvas.addEventListener('pointerdown', focusCanvas);
      this.#cleanup.push(() => canvas.removeEventListener('pointerdown', focusCanvas));
    }
    this.#watchSize();
    this.controller.setChrome(() => ui.stage.chromeLayout());
    document.fonts?.ready?.then(() => this.#ui?.stage.layout()).catch(() => undefined);
  }

  protected disconnected(): void {
    for (const fn of this.#cleanup.splice(0)) fn();
    this.controller.detach();
  }

  protected override attributeChanged(name: string, value: string | null): void {
    switch (name) {
      case 'sidebar':
      case 'header':
        this.#preset(name, value);
        break;
      case 'chrome':
        this.#preset(name, value);
        this.#applyChrome();
        break;
      case 'legend':
        this.#applyChrome();
        break;
      case 'panels': {
        const { panels, invalid } = parsePanels(value ?? '');
        warnPanels(invalid);
        this.#setHostPanels(panels);
        break;
      }
      case 'persist':
        // Turned on in the page: what the user chose before applies now, as a host change.
        if (this.#layoutReady && this.persist === 'local') this.#remembered = this.#recall();
        this.#resolve('host');
        break;
      default:
        break;
    }
  }

  protected override upgradedProperties(): readonly string[] {
    return ['chrome', 'legend', 'panels', 'persist'];
  }

  protected sheets(doc: Document): readonly CSSStyleSheet[] {
    return [stylesheet(doc)];
  }

  protected override keysEnabled(): boolean {
    return this.#ui !== null && this.chrome !== 'none';
  }

  protected override interceptKey(e: KeyboardEvent): boolean {
    const ui = this.#ui;
    if (!ui || !(ui.help.open || ui.menu.open)) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      ui.help.hide();
      this.#toggleMenu(false);
    }
    return true;
  }

  protected override payloadSet(payload: ReportPayload): void {
    // Validated (and warned about) once more when it loads.
    this.#report = sanitizeView(payload.view, true)?.panels ?? {};
    this.#resolve('host');
  }

  override load(options: LoadOptions): Promise<void> {
    this.#report = {};
    this.#resolve('host');
    return super.load(options);
  }

  // ─── Properties ───────────────────────────────────────────────────────────

  get chrome(): ViewerChrome {
    return toChrome(this.getAttribute('chrome')) ?? 'full';
  }

  set chrome(value: ViewerChrome) {
    const v = toChrome(value) === 'none' ? 'none' : null;
    this.reflect('chrome', v);
    this.#preset('chrome', v);
    this.#applyChrome();
  }

  get legend(): ViewerLegend {
    return toLegend(this.getAttribute('legend')) ?? 'auto';
  }

  set legend(value: ViewerLegend) {
    const v = toLegend(value);
    this.reflect('legend', v === 'auto' ? null : v);
    this.#applyChrome();
  }

  get panels(): PanelStates {
    return { ...this.#states };
  }

  set panels(value: ViewerPanels | string | null) {
    const { panels, invalid } = toPanels(value);
    warnPanels(invalid);
    this.reflect('panels', formatPanels(panels) || null);
    this.#setHostPanels(panels);
  }

  get persist(): 'local' | 'none' {
    return this.getAttribute('persist') === 'none' ? 'none' : 'local';
  }

  set persist(value: 'local' | 'none') {
    if (value === 'none') this.setAttribute('persist', 'none');
    else this.removeAttribute('persist');
  }

  /** The panel states and sizes, as `kgdiff-layout` reports them. */
  get #layout(): ViewerLayout {
    const sidebar = this.#ui?.sidebar;
    return {
      panels: { ...this.#states },
      sidebarWidth: sidebar?.width ?? SIDEBAR_WIDTH,
      detailShare: sidebar?.detailShare ?? null,
    };
  }

  // ─── Panels ───────────────────────────────────────────────────────────────

  /** Some region's state may have changed: apply the new states, and report them. */
  #resolve(source: 'user' | 'host'): void {
    const remembered = this.persist === 'local' ? this.#remembered.panels : {};
    const next = resolvePanels([
      this.#runtime,
      this.#hostPanels,
      this.#presets,
      remembered,
      this.#report,
    ]);
    if (samePanels(next, this.#states)) return;
    this.#states = next;
    this.#applyPanels();
    if (this.#layoutReady) this.#emitLayout(source);
  }

  #emitLayout(source: 'user' | 'host'): void {
    this.dispatchEvent(
      new CustomEvent('kgdiff-layout', {
        detail: { ...this.#layout, source },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * The host declared `panels`. Where its value changed, what the user changed there in this
   * page gives way; declaring the same again (a framework re-rendering, an attribute set to
   * the value it has) leaves the user's change alone.
   */
  #setHostPanels(panels: ViewerPanels): void {
    this.#yield(this.#hostPanels, panels);
    this.#hostPanels = panels;
    this.#resolve('host');
  }

  #preset(name: Preset, value: string | null): void {
    this.#presetAttrs[name] = value;
    const { sidebar, header, chrome } = this.#presetAttrs;
    const next = presetPanels(sidebar, header, chrome);
    if (this.#yield(this.#presets, next).some((r) => SIDEBAR_REGIONS.includes(r))) {
      this.#folded = null;
    }
    this.#presets = next;
    this.#resolve('host');
  }

  /** Drop the user's in-page change of every region `before` and `after` disagree on. */
  #yield(before: ViewerPanels, after: ViewerPanels): PanelRegion[] {
    const changed = PANEL_REGIONS.filter((r) => before[r] !== after[r]);
    for (const r of changed) delete this.#runtime[r];
    return changed;
  }

  /** The user changed some regions: they hold in this page, and are remembered. */
  #userPanels(changes: ViewerPanels): void {
    Object.assign(this.#runtime, changes);
    this.#remember({ panels: { ...this.#remembered.panels, ...changes } });
    this.#resolve('user');
  }

  /** What the user chose before; theme, palette and language apply unless the host set them. */
  #recall(): Remembered {
    const r = readRemembered(this.#storage);
    // A preference the host set wins; one the user chose before wins over a report's view.
    const c = this.controller;
    if (r.theme && !this.hasAttribute('theme') && !c.explicit.has('theme')) {
      c.setThemePreference(r.theme);
      c.explicit.add('theme');
    }
    if (r.palette && !this.hasAttribute('palette') && !c.explicit.has('palette')) {
      c.setPalette(r.palette);
      c.explicit.add('palette');
    }
    if (r.locale && !this.hasAttribute('locale') && !c.explicit.has('locale')) {
      c.setLocale(r.locale);
      c.explicit.add('locale');
    }
    this.#ui?.sidebar.setSizes(r.sidebarWidth ?? SIDEBAR_WIDTH, r.detailShare ?? null, true);
    return r;
  }

  /** The first connection: the remembered states are the first ones (not a change, no event). */
  #loadRemembered(): void {
    if (this.persist !== 'local') return;
    this.#remembered = this.#recall();
    this.#resolve('host');
  }

  /** Remember the user's choice (merged into what other viewers of this origin wrote). */
  #remember(patch: Partial<Remembered>): void {
    if (this.persist !== 'local') return;
    const stored = readRemembered(this.#storage);
    const next: Remembered = {
      ...stored,
      ...patch,
      panels: { ...stored.panels, ...(patch.panels ?? {}) },
    };
    this.#remembered = { ...this.#remembered, ...patch, panels: next.panels };
    writeRemembered(this.#storage, next);
  }

  /** The user resized the sidebar or moved the split (once the drag or key press ended). */
  #resized(width: number, detailShare: number | null): void {
    this.#remember({ sidebarWidth: width, detailShare });
    this.#emitLayout('user');
  }

  #applyPanels(): void {
    const ui = this.#ui;
    if (!ui) return;
    const s = this.#states;
    ui.sidebar.setPanels(s);
    ui.stage.setPanels(s);
    const sidebar = SIDEBAR_REGIONS.some((r) => s[r] !== 'hidden');
    ui.header.setPanels(s.title, s.actions, sidebar, () => this.#canvas());
    ui.header.setSidebarState(this.#sidebarOpen);
  }

  #canvas(): HTMLElement | null {
    return this.#ui?.stage.canvasHost.querySelector('canvas') ?? null;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** The sidebar is open while one of its regions is. */
  get #sidebarOpen(): boolean {
    return SIDEBAR_REGIONS.some((r) => this.#states[r] === 'open');
  }

  /**
   * `chrome` and `legend`: what the stage shows, whether clicks select, whether the view stays
   * fitted. Which regions show is the `chrome="none"` preset's (see `panels.ts`).
   */
  #applyChrome(): void {
    const bare = this.chrome === 'none';
    const c = this.controller;
    c.autoFit = bare;
    c.selectOnClick = !bare;
    c.setLabelsInside(bare);
    const ui = this.#ui;
    if (!ui) return;
    ui.root.dataset.chrome = this.chrome;
    const legend = this.legend;
    ui.stage.setChrome(legend === 'auto' ? (bare ? 'mini' : 'full') : legend, !bare);
    const canvas = this.#canvas();
    if (canvas) canvas.tabIndex = bare ? -1 : 0;
    if (bare) {
      ui.help.hide();
      this.#toggleMenu(false);
    }
  }

  /** What the layout does for the regions: preferences reflect as attributes, panels open. */
  protected actions(): UiActions {
    return {
      ...this.baseActions(),
      setThemePreference: (pref) => {
        this.theme = pref;
        this.#remember({ theme: this.theme });
      },
      setPalette: (p) => {
        this.palette = p;
        this.#remember({ palette: this.palette });
      },
      setLocale: (l) => {
        this.locale = l;
        this.#remember({ locale: this.locale });
      },
      toggleSidebar: (open) => this.#toggleSidebar(open),
      sidebarOpen: () => this.#sidebarOpen,
      toggleMenu: (open) => this.#toggleMenu(open),
      openHelp: () => this.#ui?.help.show(),
      focusSearch: () => this.#focusSearch(),
      setPanel: (region, state) => this.#userPanels({ [region]: state }),
    };
  }

  #build(): void {
    const root = h('div', { class: 'root' });
    this.shadow.append(root);
    // Each region binds to the root on its own (context protocol); the layout only places them.
    const header = bindRegion(root, (ui) => new Header(ui));
    const list = bindRegion(root, (ui) => new ChangeList(ui));
    const search = bindRegion(root, (ui) => new Search(ui));
    const filters = bindRegion(root, (ui) => new Filters(ui));
    const detail = bindRegion(root, (ui) => new Detail(ui));
    const stage = bindRegion(root, (ui) => new Stage(ui));
    const ui = uiContext(this.root, this.shadow);
    const menu = new Menu(ui);
    const help = new HelpDialog(ui);
    const sidebar = new Sidebar(
      ui,
      {
        setPanel: (region, state) => this.#userPanels({ [region]: state }),
        resized: (width, share) => this.#resized(width, share),
        focusOutside: () => (header.sidebarButton.hidden ? this.#canvas() : header.sidebarButton),
      },
      list,
      search,
      filters,
      detail,
    );
    // The title and the actions float over the canvas; the menu drops from the actions.
    header.attachMenu(menu.el);
    stage.el.appendChild(header.el);
    root.append(h('div', { class: 'body' }, stage.el, sidebar.el), help.el, this.root.live);
    this.#ui = { root, header, stage, list, sidebar, menu, help };
    // Close the menu on outside clicks.
    root.addEventListener('pointerdown', (e) => {
      if (!menu.open) return;
      const path = e.composedPath();
      if (!path.includes(menu.el) && !path.includes(header.menuButton)) this.#toggleMenu(false);
    });
    const hover = (over: boolean) => (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      this.pointerOver(over);
    };
    stage.el.addEventListener('pointerenter', hover(true));
    stage.el.addEventListener('pointerleave', hover(false));
    sidebar.setSizes(SIDEBAR_WIDTH, null, true);
    this.#applyPanels();
    this.#applyChrome();
  }

  /** The layout's part of a render (the root renders the regions after it). */
  #update(topics: ReadonlySet<Topic>): void {
    const ui = this.#ui;
    const c = this.controller;
    this.reflectSession(topics);
    if (!ui) return;
    if (topics.has('theme') || topics.has('status')) ui.root.dataset.theme = c.themeName;
    if (topics.has('locale') || topics.has('status')) {
      ui.root.setAttribute('lang', c.locale);
      if (ui.menu.open) ui.menu.render();
      if (ui.help.open) ui.help.render();
    }
    if (topics.has('theme') && ui.menu.open) ui.menu.render();
    ui.sidebar.update(topics);
    if (topics.has('mode') || topics.has('status')) {
      ui.root.dataset.mode = c.mode;
      ui.root.dataset.scope = c.scope;
    }
  }

  /**
   * Fold the sidebar (its open regions collapse) or open it again (the regions that were open,
   * or all four). Reflected to the `sidebar` attribute.
   */
  #toggleSidebar(open?: boolean): void {
    const s = this.#states;
    const shown = SIDEBAR_REGIONS.filter((r) => s[r] !== 'hidden');
    if (shown.length === 0) return;
    const next = open ?? !this.#sidebarOpen;
    this.reflect('sidebar', next ? 'open' : 'closed');
    if (next === this.#sidebarOpen) return;
    const changes: MutablePanels = {};
    if (next) {
      const restore = this.#folded?.filter((r) => shown.includes(r)) ?? [];
      for (const r of restore.length > 0 ? restore : shown) changes[r] = 'open';
      this.#folded = null;
    } else {
      this.#folded = shown.filter((r) => s[r] === 'open');
      for (const r of shown) changes[r] = 'collapsed';
    }
    this.#userPanels(changes);
  }

  #toggleMenu(open?: boolean): void {
    const ui = this.#ui;
    if (!ui) return;
    const next = open ?? !ui.menu.open;
    if (next) ui.menu.show(ui.header.menuButton);
    else ui.menu.hide(false);
    ui.header.setMenuState(next);
  }

  /** `/`: an open search takes focus; else this layout's search opens, unless it is hidden. */
  #focusSearch(): void {
    if (this.root.focus('search')) return;
    if (this.#states.search === 'hidden') return;
    if (!this.#sidebarOpen) this.#toggleSidebar(true);
    if (this.#states.search === 'collapsed') this.#userPanels({ search: 'open' });
    this.root.focus('search');
  }

  #watchSize(): void {
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      const ui = this.#ui;
      if (!ui) return;
      const width = this.clientWidth;
      const compact = width > 0 && width < COMPACT_WIDTH;
      ui.root.dataset.narrow = String(width > 0 && width < NARROW_WIDTH);
      if (compact !== this.#compact) {
        this.#compact = compact;
        ui.root.dataset.compact = String(compact);
      }
      ui.stage.layout();
      ui.list.renderWindow();
      ui.sidebar.layout(compact);
      this.controller.layoutChanged();
    });
    ro.observe(this);
    // The canvas also changes size without the element (chrome shown or hidden).
    if (this.#ui) ro.observe(this.#ui.stage.el);
    this.#cleanup.push(() => ro.disconnect());
  }
}
