/**
 * `<kgdiff-viewer>`: attribute / property reflection, lifecycle, public methods and events
 * around a `ViewerController` and the Shadow-DOM UI.
 */
import { type Delta, KgdiffError, type Locale } from '@kgdiff/core';
import type { PaletteName } from '@kgdiff/scene';
import { type ControllerHost, type Topic, ViewerController } from './controller.js';
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
import { isTypingTarget, keyAction } from './keyboard.js';
import { assertPayload } from './payload.js';
import {
  DEFAULT_LOOP_DELAY,
  LEGACY_CHANGES_MODE,
  THEME_PREFERENCES,
  toChrome,
  toDelay,
  toLegend,
  toLocale,
  toMode,
  toPalette,
  toScope,
  toTheme,
} from './prefs.js';
import { defaultStorage } from './review-store.js';
import { cancelFrame, nextPaint, requestFrame } from './schedule.js';
import { STYLES, themeVariables } from './styles.js';
import type { UiContext } from './ui/context.js';
import { Header } from './ui/header.js';
import { HelpDialog, Menu } from './ui/popovers.js';
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

function media(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
}

export class KgdiffViewer extends HTMLElement implements KgdiffViewerElement {
  static get observedAttributes(): readonly string[] {
    return OBSERVED;
  }

  /** @internal */
  readonly controller: ViewerController;
  readonly #shadow: ShadowRoot;
  #ui: {
    root: HTMLElement;
    vars: HTMLStyleElement;
    header: Header;
    stage: Stage;
    sidebar: Sidebar;
    menu: Menu;
    help: HelpDialog;
    live: HTMLElement;
  } | null = null;
  #currentPayload: ReportPayload | null = null;
  #renderFailed = false;
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
    const host: ControllerHost = {
      ready: (stats) => this.#emit('kgdiff-ready', { stats }),
      select: (hunk, node) => {
        this.#emit('kgdiff-select', { hunk, node });
        this.#writeHash();
      },
      mode: (mode, scope) => {
        this.#emit('kgdiff-mode', { mode, scope });
        this.#writeHash();
      },
      review: (hunk, reviewed, progress) =>
        this.#emit('kgdiff-review', { hunk, reviewed, progress }),
      error: (error) => this.#emit('kgdiff-error', { error }),
      announce: (text) => this.#announce(text),
      replayEnd: (loop) => this.#emit('kgdiff-replay-end', { loop }),
    };
    this.controller = new ViewerController(host, {
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      requestFrame,
      cancelFrame,
      yieldToPaint: nextPaint,
      storage: defaultStorage(),
    });
    this.controller.locale = toLocale(this.getAttribute('locale')) ?? detectLocale();
    this.controller.subscribe((topics) => this.#render(topics));
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
    this.#watchMedia();
    this.#watchSize();
    const onKey = (e: KeyboardEvent): void => this.#onKeyDown(e);
    document.addEventListener('keydown', onKey);
    this.#cleanup.push(() => document.removeEventListener('keydown', onKey));
    const onStorage = (e: StorageEvent): void => this.controller.syncReview(e.key);
    window.addEventListener('storage', onStorage);
    this.#cleanup.push(() => window.removeEventListener('storage', onStorage));
    const onHash = (): void => this.#readHash();
    window.addEventListener('hashchange', onHash);
    this.#cleanup.push(() => window.removeEventListener('hashchange', onHash));
    this.controller.setChrome(() => ui.stage.chromeLayout());
    document.fonts?.ready?.then(() => this.#ui?.stage.layout()).catch(() => undefined);
    this.#readHash();
    this.#render(
      new Set<Topic>([
        'status',
        'data',
        'mode',
        'theme',
        'locale',
        'filters',
        'review',
        'selection',
        'focus',
        'swipe',
        'replay',
        'overview',
      ]),
    );
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

  #emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

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

  #announce(text: string): void {
    const live = this.#ui?.live;
    if (!live) return;
    live.textContent = '';
    // A fresh text node in a later task makes screen readers announce repeats too.
    setTimeout(() => {
      live.textContent = text;
    }, 30);
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

  #build(): void {
    const style = h('style', { text: STYLES });
    const vars = h('style');
    const ctx: UiContext = {
      controller: this.controller,
      tr: () => translator(this.controller.locale),
      root: this.#shadow,
      setMode: (mode) => {
        this.controller.setMode(mode);
      },
      toggleScope: () => {
        this.controller.toggleScope();
      },
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
    const header = new Header(ctx);
    const stage = new Stage(ctx);
    const sidebar = new Sidebar(ctx);
    const menu = new Menu(ctx);
    const help = new HelpDialog(ctx);
    const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    // The title and the actions float over the canvas; the menu drops from the actions.
    header.attachMenu(menu.el);
    stage.el.appendChild(header.el);
    const root = h(
      'div',
      { class: 'root' },
      h('div', { class: 'body' }, stage.el, sidebar.el),
      help.el,
      live,
    );
    this.#shadow.append(style, vars, root);
    this.#ui = { root, vars, header, stage, sidebar, menu, help, live };
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

  /** Render, never throwing: a failure shows the error state with safe appearance defaults. */
  #render(topics: ReadonlySet<Topic>): void {
    try {
      this.#renderTopics(topics);
      this.#renderFailed = false;
    } catch (error) {
      console.error('[kgdiff] render failed:', error);
      if (this.#renderFailed) return;
      this.#renderFailed = true;
      const c = this.controller;
      c.explicit.clear();
      c.setThemePreference('auto');
      c.setPalette('default');
      c.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #renderTopics(topics: ReadonlySet<Topic>): void {
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
    if (topics.has('theme') || topics.has('status')) {
      ui.vars.textContent = `:host { ${themeVariables(c.theme)} }`;
      ui.root.dataset.theme = c.themeName;
    }
    if (topics.has('locale') || topics.has('status')) {
      ui.root.setAttribute('lang', c.locale);
      if (ui.menu.open) ui.menu.render();
      if (ui.help.open) ui.help.render();
    }
    if (topics.has('theme') && ui.menu.open) ui.menu.render();
    ui.header.update(topics);
    ui.sidebar.update(topics);
    ui.stage.update(topics);
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
    this.#ui?.sidebar.focusSearch();
  }

  #watchMedia(): void {
    const dark = media('(prefers-color-scheme: light)');
    const motion = media('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      this.controller.setSystemDark(!(dark?.matches ?? false));
      this.controller.setReducedMotion(motion?.matches ?? false);
    };
    apply();
    for (const q of [dark, motion]) {
      if (!q) continue;
      q.addEventListener?.('change', apply);
      this.#cleanup.push(() => q.removeEventListener?.('change', apply));
    }
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
      ui.sidebar.renderWindow();
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
    const target = path[0] ?? null;
    if (isTypingTarget(target)) return;
    const c = this.controller;
    const action = keyAction(e, c.mode, c.scope);
    if (!action) return;
    // Enter / Space on a focused control activate that control.
    const el = target as Element | null;
    if (
      (e.key === 'Enter' || e.key === ' ') &&
      el?.closest?.('button, a, summary, [role="radio"], [role="menuitemradio"]')
    ) {
      return;
    }
    if (c.status !== 'ready' && !['help', 'theme', 'sidebar', 'escape'].includes(action.type))
      return;
    e.preventDefault();
    switch (action.type) {
      case 'mode':
        c.setMode(action.mode);
        break;
      case 'scope':
        c.toggleScope();
        break;
      case 'next':
        c.next();
        break;
      case 'prev':
        c.prev();
        break;
      case 'first':
        c.first();
        break;
      case 'last':
        c.last();
        break;
      case 'fly':
        c.flyToSelection();
        break;
      case 'escape':
        if (!ui.sidebar.escape()) c.clearSelection();
        break;
      case 'play-pause':
        c.togglePlay();
        break;
      case 'step':
        c.stepReplay(action.direction);
        break;
      case 'divider':
        c.setSplit(c.split + action.delta);
        break;
      case 'fit':
        void c.fit();
        break;
      case 'zoom':
        c.zoom(action.direction);
        break;
      case 'search':
        this.#focusSearch();
        break;
      case 'review':
        c.toggleReviewed();
        break;
      case 'sidebar':
        this.#toggleSidebar();
        break;
      case 'theme': {
        const i = THEME_PREFERENCES.indexOf(c.themePreference);
        this.theme = THEME_PREFERENCES[(i + 1) % THEME_PREFERENCES.length] as ThemePreference;
        break;
      }
      case 'help':
        ui.help.show();
        break;
      case 'expand':
        c.expandNearest();
        break;
      default:
        action satisfies never;
    }
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
