/**
 * What `<kgdiff-viewer>` (the default layout) and `<kgdiff-root>` share (RFC 0001 §2–§5): an
 * element that is a root. It owns the session (`ViewerRoot`) and provides it to the regions and
 * elements bound to it, and carries everything about the session the host sets or reads: the
 * preferences as attributes and properties, the payload, the public methods, the events, the
 * keyboard map and its scope, deep links and the hover hold of a looping replay.
 */
import { type Delta, KgdiffError, type Locale } from '@kgdiff/core';
import type { PaletteName } from '@kgdiff/scene';
import { formatHash, parseHash } from './hash-sync.js';
import { detectLocale, translate, translator } from './i18n.js';
import type {
  FitOptions,
  LoadOptions,
  ReportPayload,
  ReviewState,
  ThemePreference,
  ViewerMode,
  ViewerScope,
} from './index.js';
import { type Keymap, toKeymap } from './keyboard.js';
import { assertPayload } from './payload.js';
import {
  DEFAULT_LOOP_DELAY,
  LEGACY_CHANGES_MODE,
  sanitizeView,
  toDelay,
  toLocale,
  toMode,
  toPalette,
  toScope,
  toTheme,
} from './prefs.js';
import { isRoot, ViewerRoot, wasForwarded } from './root.js';
import {
  ALL_TOPICS,
  type DiffSession,
  type SessionDeps,
  type SessionHost,
  type Topic,
} from './session.js';
import type { UiActions } from './ui/context.js';

/** Attributes every root observes. */
export const ROOT_ATTRIBUTES = [
  'mode',
  'scope',
  'theme',
  'palette',
  'locale',
  'sync-hash',
  'loop',
  'loop-delay',
  'pause-on-hover',
  'shortcuts',
  'keymap',
] as const;

/** Where keyboard shortcuts apply (`shortcuts`). */
export type ShortcutScope = 'scoped' | 'global' | 'none';
const SCOPES: readonly ShortcutScope[] = ['scoped', 'global', 'none'];

/** Properties a page may set before the element is defined (they shadow the accessors). */
const UPGRADED = [
  'mode',
  'scope',
  'theme',
  'palette',
  'locale',
  'loop',
  'loopDelay',
  'pauseOnHover',
  'payload',
  'shortcuts',
  'keymap',
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

/** Connected roots, in connection order (`global-shortcuts` goes to the first opted-in one). */
const connected: RootElement[] = [];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * @attr {boolean} sync-hash - Keep the selection, mode and scope in the page's URL hash
 *   (`#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`) and follow it: deep links.
 * @attr {boolean} global-shortcuts - The same as `shortcuts="global"`.
 */
export abstract class RootElement<S extends DiffSession = DiffSession> extends HTMLElement {
  /** @internal */
  readonly controller: S;
  /** @internal The root: session, keyboard map, live region, events, tokens. */
  protected readonly root: ViewerRoot<S>;
  protected readonly shadow: ShadowRoot;
  #currentPayload: ReportPayload | null = null;
  #reflecting = false;
  readonly #cleanup: (() => void)[] = [];
  #lastHash = '';
  #upgraded = false;
  /** A mouse or pen rests on the graph (holds a looping replay with `pause-on-hover`). */
  #pointerOver = false;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.root = new ViewerRoot(
      this,
      this.shadow,
      this.actions(),
      (type) => {
        if (type === 'kgdiff-select' || type === 'kgdiff-mode') this.#writeHash();
      },
      {
        session: (host, deps) => this.createSession(host, deps),
        sheets: (doc) => this.sheets(doc),
        key: (e) => this.#key(e),
        hover: (over) => this.pointerOver(over),
      },
    );
    this.controller = this.root.controller;
    this.controller.locale = toLocale(this.getAttribute('locale')) ?? detectLocale();
  }

  // ─── Hooks ────────────────────────────────────────────────────────────────

  /** What the layout does for the regions (`UiActions`); its closures run later. */
  protected abstract actions(): UiActions;

  /** Connected: build and attach what the element shows (before the first render). */
  protected abstract connected(): void;

  /** Disconnected (after the root stopped providing). */
  protected abstract disconnected(): void;

  /** An observed attribute that is not a root attribute changed (from `_old`). */
  protected attributeChanged(_name: string, _value: string | null, _old: string | null): void {}

  /** The session this root holds (the default layout's has its canvas built in). */
  protected abstract createSession(host: SessionHost, deps: SessionDeps): S;

  /** The sheets the shadow root adopts before the token set. */
  protected abstract sheets(doc: Document): readonly CSSStyleSheet[];

  /** Properties of the subclass a page may set before the element is defined. */
  protected upgradedProperties(): readonly string[] {
    return [];
  }

  /** Whether keys do anything at all (`chrome="none"` turns them off in the default layout). */
  protected keysEnabled(): boolean {
    return true;
  }

  /** A key reached the root: return true when the layout took it (an open popover). */
  protected interceptKey(_e: KeyboardEvent): boolean {
    return false;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  connectedCallback(): void {
    if (!this.#upgraded) {
      this.#upgraded = true;
      // Properties set before the element was defined shadow the accessors: re-apply them.
      for (const prop of [...UPGRADED, ...this.upgradedProperties()]) {
        if (Object.hasOwn(this, prop)) {
          const value = (this as unknown as Record<string, unknown>)[prop];
          delete (this as unknown as Record<string, unknown>)[prop];
          (this as unknown as Record<string, unknown>)[prop] = value;
        }
      }
    }
    // Provide the session (the regions bind to it) and follow the system's preferences.
    this.#cleanup.push(this.root.connect());
    this.connected();
    connected.push(this);
    const onKey = (e: KeyboardEvent): void => this.#onKeyDown(e);
    document.addEventListener('keydown', onKey);
    this.#cleanup.push(() => document.removeEventListener('keydown', onKey));
    const onHash = (): void => this.#readHash();
    window.addEventListener('hashchange', onHash);
    this.#cleanup.push(() => window.removeEventListener('hashchange', onHash));
    this.#readHash();
    this.root.render(ALL_TOPICS);
  }

  disconnectedCallback(): void {
    const i = connected.indexOf(this);
    if (i >= 0) connected.splice(i, 1);
    for (const fn of this.#cleanup.splice(0)) fn();
    this.disconnected();
    // Moved while hovered: no pointerleave follows.
    this.#pointerOver = false;
    this.#applyHold();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (this.#reflecting) return;
    switch (name) {
      case 'mode':
      case 'scope':
      case 'theme':
      case 'palette':
      case 'locale':
        this.applyPreference(name, value, false);
        break;
      case 'sync-hash':
        if (value !== null) this.#readHash();
        break;
      case 'loop':
      case 'loop-delay':
        this.controller.setLoop(this.loop ? this.loopDelay : null);
        this.#applyHold();
        break;
      case 'pause-on-hover':
        this.#applyHold();
        break;
      case 'shortcuts':
        this.root.shortcutsOff = this.shortcuts === 'none';
        break;
      case 'keymap':
        this.#setKeymap(value);
        break;
      default:
        this.attributeChanged(name, value, old);
    }
  }

  /**
   * Apply a preference from an attribute or a property. Valid values are explicit (a report's
   * `view` does not override them); invalid ones fall back to the default (`overlay`, `all`,
   * `auto`, `default`, the browser's language). Properties reflect the normalized value; the
   * legacy mode `changes` reflects as `overlay` + scope `changes`.
   */
  protected applyPreference(
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
    if (reflect || legacy) this.reflect(name, value);
    if (legacy) this.reflect('scope', c.scope);
  }

  // ─── Properties ───────────────────────────────────────────────────────────

  get mode(): ViewerMode {
    return this.controller.mode;
  }

  set mode(value: ViewerMode | typeof LEGACY_CHANGES_MODE) {
    this.applyPreference('mode', value, true);
  }

  get scope(): ViewerScope {
    return this.controller.scope;
  }

  set scope(value: ViewerScope) {
    this.applyPreference('scope', value, true);
  }

  get theme(): ThemePreference {
    return this.controller.themePreference;
  }

  set theme(value: ThemePreference) {
    this.applyPreference('theme', value, true);
  }

  get palette(): PaletteName {
    return this.controller.palette;
  }

  set palette(value: PaletteName) {
    this.applyPreference('palette', value, true);
  }

  get locale(): Locale {
    return this.controller.locale;
  }

  set locale(value: Locale) {
    this.applyPreference('locale', value, true);
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

  /**
   * Where the keyboard shortcuts apply. `scoped` (the default): while focus is inside the root
   * (keys of elements bound with `for` are forwarded to it). `global`: also when nothing on the
   * page has focus, for the first such root, except the keys pages scroll with; the boolean
   * `global-shortcuts` attribute is an alias. `none`: no shortcuts (a focused change list keeps
   * its arrow keys).
   */
  get shortcuts(): ShortcutScope {
    const v = this.getAttribute('shortcuts') as ShortcutScope | null;
    if (v !== null && SCOPES.includes(v)) return v;
    return this.hasAttribute('global-shortcuts') ? 'global' : 'scoped';
  }

  set shortcuts(value: ShortcutScope) {
    if (SCOPES.includes(value)) this.setAttribute('shortcuts', value);
    else this.removeAttribute('shortcuts');
  }

  /**
   * Keys bound to other shortcuts, or unbound with null: `{ x: null, r: 'review' }`, or as the
   * `keymap` attribute `"x:none r:review"`. Keys not named keep the default map.
   */
  get keymap(): Keymap | null {
    return this.root.keymap;
  }

  set keymap(value: Keymap | string | null) {
    this.#setKeymap(value);
  }

  #setKeymap(value: unknown): void {
    const { keymap, invalid } = toKeymap(value);
    if (invalid.length > 0) console.warn(`[kgdiff] ignoring invalid keymap: ${invalid.join(' ')}`);
    this.root.keymap = keymap;
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
    // The report's theme, palette and language apply at once (the loading steps show in
    // them), unless the host or the user chose (validated, and warned about, when it loads).
    const view = sanitizeView(payload.view, true);
    const c = this.controller;
    if (view?.theme && !c.explicit.has('theme')) c.setThemePreference(view.theme);
    if (view?.palette && !c.explicit.has('palette')) c.setPalette(view.palette);
    if (view?.locale && !c.explicit.has('locale')) c.setLocale(view.locale);
    this.payloadSet(payload);
    this.controller.loadPayload(payload).catch(() => {
      // Already surfaced: error state + `kgdiff-error`.
    });
  }

  /** A valid payload was set, before it loads. */
  protected payloadSet(_payload: ReportPayload): void {}

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

  /**
   * Draw the canvas with the `--kgdiff-*` tokens as computed now. Call it after changing tokens
   * in a way the root cannot observe (a class on an ancestor, a stylesheet); theme, palette and
   * system color scheme changes are followed by themselves.
   */
  refreshTheme(): void {
    this.controller.refreshTheme();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  protected reflect(name: string, value: string | null): void {
    if (this.getAttribute(name) === value) return;
    this.#reflecting = true;
    try {
      if (value === null) this.removeAttribute(name);
      else this.setAttribute(name, value);
    } finally {
      this.#reflecting = false;
    }
  }

  /** The actions every root has: preferences reflect as attributes. */
  protected baseActions(): Pick<
    UiActions,
    'tr' | 'setMode' | 'toggleScope' | 'setThemePreference' | 'setPalette' | 'setLocale'
  > {
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
    };
  }

  /** The pointer entered or left the graph (holds a looping replay with `pause-on-hover`). */
  protected pointerOver(over: boolean): void {
    this.#pointerOver = over;
    this.#applyHold();
  }

  /** Hold a looping replay while the pointer is over the graph (`pause-on-hover`). */
  #applyHold(): void {
    this.controller.hold(this.#pointerOver && this.loop && this.pauseOnHover);
  }

  /** Reflect what the session changed (mode, scope, theme) back to the attributes. */
  protected reflectSession(topics: ReadonlySet<Topic>): void {
    const c = this.controller;
    if (topics.has('mode')) {
      this.reflect('mode', c.mode);
      this.reflect('scope', c.scope);
    }
    if (topics.has('theme')) {
      this.reflect(
        'theme',
        c.themePreference === 'auto' && !this.hasAttribute('theme') ? null : c.themePreference,
      );
    }
  }

  #onKeyDown(e: KeyboardEvent): void {
    // A key an element forwarded to its own root is that root's, even when it did nothing.
    if (wasForwarded(e)) return;
    // The nearest root takes a key pressed inside it; an outer one leaves it alone.
    const nearest = e.composedPath().find(isRoot);
    if (nearest !== undefined && nearest !== this) return;
    if (nearest === undefined) {
      // Outside every root only with `shortcuts="global"`, when nothing else has focus, for the
      // first such root, and never the keys pages scroll with.
      if (this.shortcuts !== 'global' || PAGE_KEYS.has(e.key)) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      if (connected.find((v) => v.shortcuts === 'global') !== this) return;
    }
    this.#key(e);
  }

  /** A key for this root: pressed inside it, or forwarded by an element bound with `for`. */
  #key(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing || !this.keysEnabled()) return;
    if (this.interceptKey(e)) return;
    this.root.handleKey(e);
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
