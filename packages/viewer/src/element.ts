/**
 * `<kgdiff-viewer>`, the default layout (RFC 0001 §4): a root (the session, keyboard map, live
 * region, events and theme tokens; `root.ts`) and the regions bound to it, the stage with its
 * chrome, the change list, the search, the family filters and the detail panel, placed as they
 * always were (a 360 px sidebar; a bottom sheet below 760 px). Around them: attribute /
 * property reflection, lifecycle, the public methods and deep links.
 */
import { type Delta, KgdiffError, type Locale } from '@kgdiff/core';
import type { PaletteName } from '@kgdiff/scene';
import type { ViewerController } from './controller.js';
import { h } from './dom.js';
import { formatHash, parseHash } from './hash-sync.js';
import { detectLocale, translate, translator } from './i18n.js';
import type {
  FitOptions,
  KgdiffViewerElement,
  LoadOptions,
  ReportPayload,
  ReviewState,
  ThemePreference,
  ViewerChrome,
  ViewerLegend,
  ViewerMode,
  ViewerScope,
} from './index.js';
import { assertPayload } from './payload.js';
import {
  DEFAULT_LOOP_DELAY,
  LEGACY_CHANGES_MODE,
  toChrome,
  toDelay,
  toLegend,
  toLocale,
  toMode,
  toPalette,
  toScope,
  toTheme,
} from './prefs.js';
import { bindRegion, uiContext, ViewerRoot } from './root.js';
import { ALL_TOPICS, type Topic } from './session.js';
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

const OBSERVED = [
  'mode',
  'scope',
  'theme',
  'palette',
  'locale',
  'sidebar',
  'sync-hash',
  'chrome',
  'legend',
  'loop',
  'loop-delay',
  'pause-on-hover',
] as const;
const UPGRADED = [
  'mode',
  'scope',
  'theme',
  'palette',
  'locale',
  'chrome',
  'legend',
  'loop',
  'loopDelay',
  'pauseOnHover',
  'payload',
] as const;

/** Keys the page itself scrolls with: never taken at document level. */
const PAGE_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
  'Spacebar',
]);

/** Connected viewers, in connection order (`global-shortcuts` goes to the first opted-in one). */
const connected: KgdiffViewer[] = [];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export class KgdiffViewer extends HTMLElement implements KgdiffViewerElement {
  static get observedAttributes(): readonly string[] {
    return OBSERVED;
  }

  /** @internal */
  readonly controller: ViewerController;
  readonly #shadow: ShadowRoot;
  readonly #root: ViewerRoot;
  #ui: {
    root: HTMLElement;
    header: Header;
    stage: Stage;
    list: ChangeList;
    sidebar: Sidebar;
    menu: Menu;
    help: HelpDialog;
  } | null = null;
  #currentPayload: ReportPayload | null = null;
  #reflecting = false;
  #compact = false;
  readonly #cleanup: (() => void)[] = [];
  #lastHash = '';
  #upgraded = false;
  /** A mouse or pen rests on the graph (holds a looping replay with `pause-on-hover`). */
  #pointerOver = false;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
    this.#root = new ViewerRoot(this, this.#shadow, this.#actions(), (type) => {
      if (type === 'kgdiff-select' || type === 'kgdiff-mode') this.#writeHash();
    });
    this.controller = this.#root.controller;
    this.controller.locale = toLocale(this.getAttribute('locale')) ?? detectLocale();
    // The layout renders first, then the regions in the order they bound to the root.
    this.#root.attach({ update: (topics) => this.#update(topics) });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  connectedCallback(): void {
    if (!this.#upgraded) {
      this.#upgraded = true;
      // Properties set before the element was defined shadow the accessors: re-apply them.
      for (const prop of UPGRADED) {
        if (Object.hasOwn(this, prop)) {
          const value = (this as unknown as Record<string, unknown>)[prop];
          delete (this as unknown as Record<string, unknown>)[prop];
          (this as unknown as Record<string, unknown>)[prop] = value;
        }
      }
    }
    // Provide the session (the regions bind to it) and follow the system's preferences.
    this.#cleanup.push(this.#root.connect());
    if (!this.#ui) this.#build();
    connected.push(this);
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
    const onKey = (e: KeyboardEvent): void => this.#onKeyDown(e);
    document.addEventListener('keydown', onKey);
    this.#cleanup.push(() => document.removeEventListener('keydown', onKey));
    const onHash = (): void => this.#readHash();
    window.addEventListener('hashchange', onHash);
    this.#cleanup.push(() => window.removeEventListener('hashchange', onHash));
    this.controller.setChrome(() => ui.stage.chromeLayout());
    document.fonts?.ready?.then(() => this.#ui?.stage.layout()).catch(() => undefined);
    this.#readHash();
    this.#root.render(ALL_TOPICS);
  }

  disconnectedCallback(): void {
    const i = connected.indexOf(this);
    if (i >= 0) connected.splice(i, 1);
    for (const fn of this.#cleanup.splice(0)) fn();
    this.controller.detach();
    // Moved while hovered: no pointerleave follows.
    this.#pointerOver = false;
    this.#applyHold();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (this.#reflecting) return;
    switch (name) {
      case 'mode':
      case 'scope':
      case 'theme':
      case 'palette':
      case 'locale':
        this.#applyPreference(name, value, false);
        break;
      case 'sidebar':
        this.#applySidebar();
        break;
      case 'sync-hash':
        if (value !== null) this.#readHash();
        break;
      case 'chrome':
      case 'legend':
        this.#applyChrome();
        break;
      case 'loop':
      case 'loop-delay':
        this.controller.setLoop(this.loop ? this.loopDelay : null);
        this.#applyHold();
        break;
      case 'pause-on-hover':
        this.#applyHold();
        break;
      default:
        break;
    }
  }

  /**
   * Apply a preference from an attribute or a property. Valid values are explicit (a report's
   * `view` does not override them); invalid ones fall back to the default (`overlay`, `all`,
   * `auto`, `default`, the browser's language). Properties reflect the normalized value; the
   * legacy mode `changes` reflects as `overlay` + scope `changes`.
   */
  #applyPreference(
    name: 'mode' | 'scope' | 'theme' | 'palette' | 'locale',
    raw: unknown,
    reflect: boolean,
  ): void {
    const c = this.controller;
    // `mode="changes"` is rewritten to the attribute pair it stands for.
    const legacy = name === 'mode' && raw === LEGACY_CHANGES_MODE;
    let value: string | null;
    switch (name) {
      case 'mode': {
        if (legacy) {
          c.explicit.add('scope');
          c.setView('overlay', 'changes');
          value = 'overlay';
          break;
        }
        const v = toMode(raw);
        c.setMode(v ?? 'overlay');
        value = v;
        break;
      }
      case 'scope': {
        const v = toScope(raw);
        c.setScope(v ?? 'all');
        // A locked scope stays `changes`: the attribute says what is shown.
        value = v === null ? null : c.scope;
        break;
      }
      case 'theme': {
        const v = toTheme(raw);
        c.setThemePreference(v ?? 'auto');
        value = v;
        break;
      }
      case 'palette': {
        const v = toPalette(raw);
        c.setPalette(v ?? 'default');
        value = v;
        break;
      }
      case 'locale': {
        const v = toLocale(raw);
        c.setLocale(v ?? detectLocale());
        value = v;
        break;
      }
      default:
        return;
    }
    if (value === null) c.explicit.delete(name);
    else c.explicit.add(name);
    if (reflect || legacy) this.#reflect(name, value);
    if (legacy) this.#reflect('scope', c.scope);
  }

  // ─── Properties ───────────────────────────────────────────────────────────

  get mode(): ViewerMode {
    return this.controller.mode;
  }

  set mode(value: ViewerMode | typeof LEGACY_CHANGES_MODE) {
    this.#applyPreference('mode', value, true);
  }

  get scope(): ViewerScope {
    return this.controller.scope;
  }

  set scope(value: ViewerScope) {
    this.#applyPreference('scope', value, true);
  }

  get theme(): ThemePreference {
    return this.controller.themePreference;
  }

  set theme(value: ThemePreference) {
    this.#applyPreference('theme', value, true);
  }

  get palette(): PaletteName {
    return this.controller.palette;
  }

  set palette(value: PaletteName) {
    this.#applyPreference('palette', value, true);
  }

  get locale(): Locale {
    return this.controller.locale;
  }

  set locale(value: Locale) {
    this.#applyPreference('locale', value, true);
  }

  get chrome(): ViewerChrome {
    return toChrome(this.getAttribute('chrome')) ?? 'full';
  }

  set chrome(value: ViewerChrome) {
    this.#reflect('chrome', toChrome(value) === 'none' ? 'none' : null);
    this.#applyChrome();
  }

  get legend(): ViewerLegend {
    return toLegend(this.getAttribute('legend')) ?? 'auto';
  }

  set legend(value: ViewerLegend) {
    const v = toLegend(value);
    this.#reflect('legend', v === 'auto' ? null : v);
    this.#applyChrome();
  }

  get loop(): boolean {
    return this.hasAttribute('loop');
  }

  set loop(value: boolean) {
    this.toggleAttribute('loop', Boolean(value));
  }

  get loopDelay(): number {
    return toDelay(this.getAttribute('loop-delay')) ?? DEFAULT_LOOP_DELAY;
  }

  set loopDelay(value: number) {
    const v = toDelay(value);
    if (v === null) this.removeAttribute('loop-delay');
    else this.setAttribute('loop-delay', String(v));
  }

  get pauseOnHover(): boolean {
    return this.getAttribute('pause-on-hover') !== 'false';
  }

  set pauseOnHover(value: boolean) {
    if (value) this.removeAttribute('pause-on-hover');
    else this.setAttribute('pause-on-hover', 'false');
  }

  get payload(): ReportPayload | null {
    return this.#currentPayload;
  }

  set payload(value: ReportPayload | null) {
    this.#currentPayload = value;
    if (value === null || value === undefined) return;
    let payload: ReportPayload;
    try {
      payload = assertPayload(value);
    } catch (error) {
      this.controller.fail(error as Error);
      return;
    }
    this.controller.loadPayload(payload).catch(() => {
      // Already surfaced: error state + `kgdiff-error`.
    });
  }

  // ─── Methods ──────────────────────────────────────────────────────────────

  load(options: LoadOptions): Promise<void> {
    this.#currentPayload = null;
    return this.controller.load(options);
  }

  selectHunk(id: string | null): void {
    this.controller.selectHunkById(id, { fly: true });
  }

  next(): void {
    this.controller.next();
  }

  prev(): void {
    this.controller.prev();
  }

  play(): void {
    this.controller.play();
  }

  pause(): void {
    this.controller.pause();
  }

  fit(options?: FitOptions): Promise<void> {
    return this.controller.fit(options);
  }

  exportDelta(): Delta {
    const diff = this.controller.diff;
    if (!diff) throw new KgdiffError('invalid-input', translate('en', 'error.notLoaded'));
    // A copy: callers can never mutate the diff the viewer shows.
    return deepFreeze(structuredClone(diff.delta));
  }

  reviewState(): ReviewState {
    return this.controller.reviewState();
  }

  setReviewed(hunkId: string, reviewed: boolean): void {
    this.controller.setReviewed(hunkId, reviewed);
  }

  /** Show an error state (used for undecodable embedded payloads). */
  showError(error: Error): void {
    this.controller.fail(error);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  #reflect(name: string, value: string | null): void {
    if (this.getAttribute(name) === value) return;
    this.#reflecting = true;
    try {
      if (value === null) this.removeAttribute(name);
      else this.setAttribute(name, value);
    } finally {
      this.#reflecting = false;
    }
  }

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

  /** Hold a looping replay while the pointer is over the graph (`pause-on-hover`). */
  #applyHold(): void {
    this.controller.hold(this.#pointerOver && this.loop && this.pauseOnHover);
  }

  /** What the layout does for the regions: preferences reflect as attributes, panels open. */
  #actions(): UiActions {
    return {
      tr: () => translator(this.controller.locale),
      setMode: (mode) => this.controller.setMode(mode),
      toggleScope: () => this.controller.toggleScope(),
      setThemePreference: (pref) => {
        this.theme = pref;
      },
      setPalette: (p) => {
        this.palette = p;
      },
      setLocale: (l) => {
        this.locale = l;
      },
      toggleSidebar: (open) => this.#toggleSidebar(open),
      sidebarOpen: () => this.#sidebarOpen,
      toggleMenu: (open) => this.#toggleMenu(open),
      openHelp: () => this.#ui?.help.show(),
      focusSearch: () => this.#focusSearch(),
    };
  }

  #build(): void {
    const root = h('div', { class: 'root' });
    this.#shadow.append(root);
    // Each region binds to the root on its own (context protocol); the layout only places them.
    const header = bindRegion(root, (ui) => new Header(ui));
    const list = bindRegion(root, (ui) => new ChangeList(ui));
    const search = bindRegion(root, (ui) => new Search(ui));
    const filters = bindRegion(root, (ui) => new Filters(ui));
    const detail = bindRegion(root, (ui) => new Detail(ui));
    const stage = bindRegion(root, (ui) => new Stage(ui));
    const ui = uiContext(this.#root, this.#shadow);
    const menu = new Menu(ui);
    const help = new HelpDialog(ui);
    const sidebar = new Sidebar(ui.tr, list, search, filters, detail);
    // The title and the actions float over the canvas; the menu drops from the actions.
    header.attachMenu(menu.el);
    stage.el.appendChild(header.el);
    root.append(h('div', { class: 'body' }, stage.el, sidebar.el), help.el, this.#root.live);
    this.#ui = { root, header, stage, list, sidebar, menu, help };
    // Close the menu on outside clicks.
    root.addEventListener('pointerdown', (e) => {
      if (!menu.open) return;
      const path = e.composedPath();
      if (!path.includes(menu.el) && !path.includes(header.menuButton)) this.#toggleMenu(false);
    });
    const hover = (over: boolean) => (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      this.#pointerOver = over;
      this.#applyHold();
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
    if (topics.has('mode')) {
      this.#reflect('mode', c.mode);
      this.#reflect('scope', c.scope);
    }
    if (topics.has('theme')) {
      this.#reflect(
        'theme',
        c.themePreference === 'auto' && !this.hasAttribute('theme') ? null : c.themePreference,
      );
    }
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
    this.#reflect('sidebar', next ? 'open' : 'closed');
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
    this.#root.focus('search');
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

  #onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    const ui = this.#ui;
    if (!ui || this.chrome === 'none') return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      // Outside the component only with `global-shortcuts`, when nothing else has focus, for
      // the first such viewer, and never the keys pages scroll with.
      if (!this.hasAttribute('global-shortcuts') || PAGE_KEYS.has(e.key)) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      if (connected.find((v) => v.hasAttribute('global-shortcuts')) !== this) return;
    }
    if (ui.help.open || ui.menu.open) {
      if (e.key === 'Escape') {
        e.preventDefault();
        ui.help.hide();
        this.#toggleMenu(false);
      }
      return;
    }
    this.#root.handleKey(e);
  }

  // ─── Deep links ───────────────────────────────────────────────────────────

  #readHash(): void {
    if (!this.hasAttribute('sync-hash') || typeof location === 'undefined') return;
    if (location.hash === this.#lastHash) return;
    const state = parseHash(location.hash);
    this.#lastHash = location.hash;
    if (!state) return;
    if (state.mode || state.scope) {
      // A deep link outranks the large-graph default and a report's preferred view.
      const c = this.controller;
      if (state.mode) c.explicit.add('mode');
      if (state.scope) c.explicit.add('scope');
      c.setView(state.mode ?? c.mode, state.scope ?? c.scope);
    }
    if (state.hunk) this.controller.selectHunkById(state.hunk, { fly: true });
  }

  #writeHash(): void {
    if (!this.hasAttribute('sync-hash') || typeof location === 'undefined') return;
    const c = this.controller;
    const hunk = c.selectedHunk >= 0 ? c.scene?.hunks[c.selectedHunk]?.id : undefined;
    const hash = formatHash({
      ...(hunk !== undefined ? { hunk } : {}),
      mode: c.mode,
      scope: c.scope,
    });
    if (hash === location.hash) return;
    this.#lastHash = hash;
    try {
      history.replaceState(history.state, '', hash);
    } catch {
      location.hash = hash;
    }
  }
}
