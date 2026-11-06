/**
 * `<kgdiff-viewer>`, the default layout (RFC 0001 §4): a root (`root-element.ts`: the session,
 * keyboard map, live region, events, theme tokens, preferences and methods) and the regions
 * bound to it, the stage with its chrome, the change list, the search, the family filters and
 * the detail panel, placed as they always were (a 360 px sidebar; a bottom sheet below 760 px).
 */

import { h } from './dom.js';
import type { KgdiffViewerElement, ViewerChrome, ViewerLegend } from './index.js';
import { toChrome, toLegend } from './prefs.js';
import { bindRegion, uiContext } from './root.js';
import { ROOT_ATTRIBUTES, RootElement } from './root-element.js';
import type { Topic } from './session.js';
import { ChangeList } from './ui/change-list.js';
import type { UiActions } from './ui/context.js';
import { Detail } from './ui/detail.js';
import { Filters } from './ui/filters.js';
import { Header } from './ui/header.js';
import { HelpDialog, Menu } from './ui/popovers.js';
import { Search } from './ui/search.js';
import { Sidebar } from './ui/sidebar.js';
import { Stage } from './ui/stage.js';

/** Below this width the sidebar becomes a bottom sheet. */
export const COMPACT_WIDTH = 760;
/** Below this width the title drops the version tags. */
const NARROW_WIDTH = 1100;

const OBSERVED = [...ROOT_ATTRIBUTES, 'sidebar', 'chrome', 'legend'] as const;

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
    this.controller.attach(ui.stage.canvasHost, ui.stage.minimapHost);
    // The graph takes keyboard focus (shortcuts apply where focus is), also on click.
    const canvas = ui.stage.canvasHost.querySelector('canvas');
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

  protected override attributeChanged(name: string): void {
    switch (name) {
      case 'sidebar':
        this.#applySidebar();
        break;
      case 'chrome':
      case 'legend':
        this.#applyChrome();
        break;
      default:
        break;
    }
  }

  protected override upgradedProperties(): readonly string[] {
    return ['chrome', 'legend'];
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

  // ─── Properties ───────────────────────────────────────────────────────────

  get chrome(): ViewerChrome {
    return toChrome(this.getAttribute('chrome')) ?? 'full';
  }

  set chrome(value: ViewerChrome) {
    this.reflect('chrome', toChrome(value) === 'none' ? 'none' : null);
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

  // ─── Internals ────────────────────────────────────────────────────────────

  get #sidebarOpen(): boolean {
    return this.getAttribute('sidebar') !== 'closed';
  }

  #applySidebar(): void {
    const ui = this.#ui;
    if (!ui) return;
    ui.sidebar.setOpen(this.#sidebarOpen);
    ui.header.setSidebarState(this.#sidebarOpen);
  }

  /**
   * `chrome` and `legend`: what the stage shows, whether clicks select, whether the view stays
   * fitted. The CSS hides the rest (`.root[data-chrome="none"]`).
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
    const canvas = ui.stage.canvasHost.querySelector('canvas');
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
      toggleSidebar: (open) => this.#toggleSidebar(open),
      sidebarOpen: () => this.#sidebarOpen,
      toggleMenu: (open) => this.#toggleMenu(open),
      openHelp: () => this.#ui?.help.show(),
      focusSearch: () => this.#focusSearch(),
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
    const sidebar = new Sidebar(ui.tr, list, search, filters, detail);
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
    this.#applySidebar();
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

  #toggleSidebar(open?: boolean): void {
    const next = open ?? !this.#sidebarOpen;
    this.reflect('sidebar', next ? 'open' : 'closed');
    this.#applySidebar();
  }

  #toggleMenu(open?: boolean): void {
    const ui = this.#ui;
    if (!ui) return;
    const next = open ?? !ui.menu.open;
    if (next) ui.menu.show(ui.header.menuButton);
    else ui.menu.hide(false);
    ui.header.setMenuState(next);
  }

  #focusSearch(): void {
    if (!this.#sidebarOpen) this.#toggleSidebar(true);
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
      if (compact) ui.sidebar.syncSheet();
      this.controller.layoutChanged();
    });
    ro.observe(this);
    // The canvas also changes size without the element (chrome shown or hidden).
    if (this.#ui) ro.observe(this.#ui.stage.el);
    this.#cleanup.push(() => ro.disconnect());
  }
}
