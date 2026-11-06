/**
 * What `<kgdiff-viewer>` (the default layout) and `<kgdiff-root>` share (RFC 0001 §2–§5): an
 * element that is a root. It owns the session (`ViewerRoot`) and provides it to the regions and
 * elements bound to it, and carries everything about the session the host sets or reads: the
 * preferences as attributes and properties, the payload, the public methods, the events, the
 * keyboard map and its scope, deep links and the hover hold of a looping replay.
 */
import { type Delta, KgdiffError, type Locale } from '@kgdiff/core';
import type { PaletteName } from '@kgdiff/scene';
import type { ViewerController } from './controller.js';
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
import { assertPayload } from './payload.js';
import {
  DEFAULT_LOOP_DELAY,
  LEGACY_CHANGES_MODE,
  toDelay,
  toLocale,
  toMode,
  toPalette,
  toScope,
  toTheme,
} from './prefs.js';
import { ViewerRoot } from './root.js';
import { ALL_TOPICS, type Topic } from './session.js';
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
] as const;

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

export abstract class RootElement extends HTMLElement {
  /** @internal */
  readonly controller: ViewerController;
  /** @internal The root: session, keyboard map, live region, events, tokens. */
  protected readonly root: ViewerRoot;
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
    this.root = new ViewerRoot(this, this.shadow, this.actions(), (type) => {
      if (type === 'kgdiff-select' || type === 'kgdiff-mode') this.#writeHash();
    });
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

  /** An observed attribute that is not a root attribute changed. */
  protected attributeChanged(_name: string, _value: string | null): void {}

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

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
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
      default:
        this.attributeChanged(name, value);
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
    if (e.defaultPrevented || e.isComposing || !this.keysEnabled()) return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      // Outside the component only with `global-shortcuts`, when nothing else has focus, for
      // the first such viewer, and never the keys pages scroll with.
      if (!this.hasAttribute('global-shortcuts') || PAGE_KEYS.has(e.key)) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      if (connected.find((v) => v.hasAttribute('global-shortcuts')) !== this) return;
    }
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
