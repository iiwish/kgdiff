/**
 * The root of a viewer (RFC 0001 §2–§6): it owns the session and provides it to the regions
 * bound to it (context `kgdiff.viewer/1`), renders them on every notification, and owns what
 * they share: the keyboard map, the live region, the events, the focus targets and the theme
 * tokens. Regions never reference each other; everything goes through the session or the root.
 *
 * Its host is `<kgdiff-viewer>` (the default layout, whose regions render into its shadow
 * root) or `<kgdiff-root>` (whose elements are placed by the page).
 */
import type { Theme } from '@kgdiff/scene';
import type { Region, ViewerContext } from './bind.js';
import { viewerContext } from './bind.js';
import { provideContext } from './context.js';
import { type ControllerHost, ViewerController } from './controller.js';
import { h } from './dom.js';
import type { ThemePreference } from './index.js';
import { isTypingTarget, type Keymap, keyAction } from './keyboard.js';
import { THEME_PREFERENCES } from './prefs.js';
import { defaultStorage } from './review-store.js';
import { cancelFrame, nextPaint, requestFrame } from './schedule.js';
import type { Topic } from './session.js';
import { stylesheet } from './styles.js';
import { themeFromStyle, tokenSheet } from './theme.js';
import type { FocusTarget, UiActions } from './ui/context.js';

export type { Region, ViewerContext } from './bind.js';
export { bindRegion, uiContext, viewerContext, wasForwarded } from './bind.js';

/** Hosts of roots (the nearest root acts on a key; an outer one leaves it alone). */
const rootHosts = new WeakSet<EventTarget>();

/** Whether `target` is the host of a root. */
export function isRoot(target: EventTarget): boolean {
  return rootHosts.has(target);
}

/** What the element that owns a root adds to it. */
export interface RootOptions {
  /** The sheets the root's shadow root adopts before its token set (default: the viewer's). */
  readonly sheets?: (doc: Document) => readonly CSSStyleSheet[];
  /** A key forwarded by an element bound with `for` (default: the keyboard map). */
  readonly key?: (e: KeyboardEvent) => void;
  /** The pointer entered or left the graph. */
  readonly hover?: (over: boolean) => void;
}

/** The shortcuts a focused list keeps with `shortcuts="none"` (the listbox's own keys). */
const LIST_KEYS: ReadonlySet<string> = new Set(['next', 'prev', 'first', 'last', 'fly']);

interface Target {
  readonly focus: () => void;
  readonly available: () => boolean;
}

function media(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
}

export class ViewerRoot implements ViewerContext {
  readonly controller: ViewerController;
  /** The single polite live region announcing navigation ("Change 3 of 12: …"). */
  readonly live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  readonly host: HTMLElement;
  readonly actions: UiActions;
  readonly #shadow: ShadowRoot;
  readonly #regions: Region[] = [];
  readonly #targets = new Map<FocusTarget, Target[]>();
  readonly #options: RootOptions;
  #renderFailed = false;
  /** The built-in theme of the token set applied last. */
  #base: Theme | null = null;
  #stage: object | null = null;
  /** `keymap`: single keys bound to other shortcuts, or unbound. */
  keymap: Keymap | null = null;
  /** `shortcuts="none"`: no shortcuts, but a focused list keeps its own keys. */
  shortcutsOff = false;

  /**
   * `host` dispatches the events and computes the tokens set on `shadow` (its shadow root);
   * `emitted` runs after each event was dispatched.
   */
  constructor(
    host: HTMLElement,
    shadow: ShadowRoot,
    actions: UiActions,
    emitted?: (type: string) => void,
    options: RootOptions = {},
  ) {
    this.host = host;
    this.#shadow = shadow;
    this.actions = actions;
    this.#options = options;
    rootHosts.add(host);
    const emit = (type: string, detail: unknown): void => {
      host.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
      emitted?.(type);
    };
    const events: ControllerHost = {
      ready: (stats) => emit('kgdiff-ready', { stats }),
      select: (hunk, node) => emit('kgdiff-select', { hunk, node }),
      mode: (mode, scope) => emit('kgdiff-mode', { mode, scope }),
      review: (hunk, reviewed, progress) => emit('kgdiff-review', { hunk, reviewed, progress }),
      error: (error) => emit('kgdiff-error', { error }),
      announce: (text) => this.announce(text),
      replayEnd: (loop) => emit('kgdiff-replay-end', { loop }),
    };
    this.controller = new ViewerController(events, {
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      requestFrame,
      cancelFrame,
      yieldToPaint: nextPaint,
      storage: defaultStorage(),
      // The one place the token set is applied: the canvas then draws with the tokens as
      // computed on the host (page styles win).
      theme: (base) => {
        this.#tokens(base);
        const view = host.ownerDocument.defaultView;
        return view ? themeFromStyle(base, view.getComputedStyle(host)) : base;
      },
    });
    this.controller.subscribe((topics) => this.render(topics));
  }

  /**
   * Provide the session to the regions and follow the system's color scheme and motion
   * preference and other tabs' review progress; returns the function that stops it all.
   */
  connect(): () => void {
    const c = this.controller;
    const stop = [provideContext(this.host, viewerContext, () => this)];
    const dark = media('(prefers-color-scheme: light)');
    const motion = media('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      c.setSystemDark(!(dark?.matches ?? false));
      c.setReducedMotion(motion?.matches ?? false);
    };
    for (const q of [dark, motion]) {
      q?.addEventListener?.('change', apply);
      stop.push(() => q?.removeEventListener?.('change', apply));
    }
    apply();
    // Page styles may override tokens now that the host is in the document.
    c.refreshTheme();
    const onStorage = (e: StorageEvent): void => c.syncReview(e.key);
    window.addEventListener('storage', onStorage);
    stop.push(() => window.removeEventListener('storage', onStorage));
    return () => {
      for (const fn of stop) fn();
    };
  }

  attach(region: Region): () => void {
    this.#regions.push(region);
    return () => {
      const i = this.#regions.indexOf(region);
      if (i >= 0) this.#regions.splice(i, 1);
    };
  }

  target(name: FocusTarget, focus: () => void, available?: () => boolean): () => void {
    const list = this.#targets.get(name) ?? [];
    this.#targets.set(name, list);
    const target: Target = { focus, available: available ?? (() => true) };
    list.push(target);
    return () => {
      const i = list.indexOf(target);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Focus the `name` target registered last of those available (in an open region). */
  focus(name: FocusTarget): boolean {
    const list = this.#targets.get(name) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const target = list[i] as Target;
      if (!target.available()) continue;
      target.focus();
      return true;
    }
    return false;
  }

  announce(text: string): void {
    const live = this.live;
    live.textContent = '';
    // A fresh text node in a later task makes screen readers announce repeats too.
    setTimeout(() => {
      live.textContent = text;
    }, 30);
  }

  /** Render every region, never throwing: a failure shows the error state with safe defaults. */
  render(topics: ReadonlySet<Topic>): void {
    try {
      for (const region of this.#regions) region.update(topics);
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

  /** Apply the token set of `base` (a built-in theme) on the host, in the host's document. */
  #tokens(base: Theme): void {
    this.#base = base;
    const doc = this.host.ownerDocument;
    const tokens = tokenSheet(base, doc);
    if (this.#shadow.adoptedStyleSheets.at(-1) !== tokens) {
      const sheets = this.#options.sheets?.(doc) ?? [stylesheet(doc)];
      this.#shadow.adoptedStyleSheets = [...sheets, tokens];
    }
  }

  tokens(doc: Document): CSSStyleSheet {
    // Resolving the theme applies the token set (and remembers its base).
    if (!this.#base) void this.controller.theme;
    return tokenSheet(this.#base ?? this.controller.theme, doc);
  }

  forwardKey(e: KeyboardEvent): void {
    if (this.#options.key) this.#options.key(e);
    else this.handleKey(e);
  }

  hover(over: boolean): void {
    this.#options.hover?.(over);
  }

  claimStage(owner: object): boolean {
    if (this.#stage !== null && this.#stage !== owner) return false;
    this.#stage = owner;
    return true;
  }

  releaseStage(owner: object): void {
    if (this.#stage === owner) this.#stage = null;
  }

  handleKey(e: KeyboardEvent): void {
    const target = e.composedPath()[0] ?? null;
    if (isTypingTarget(target)) return;
    const c = this.controller;
    const action = keyAction(e, c.mode, c.scope, this.keymap);
    if (!action) return;
    if (
      this.shortcutsOff &&
      !(LIST_KEYS.has(action.type) && (target as Element | null)?.closest?.('[role="listbox"]'))
    ) {
      return;
    }
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
    const a = this.actions;
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
        // An active search is cleared first (focus goes back to it).
        if (c.query) {
          c.setQuery('');
          this.focus('search');
        } else c.clearSelection();
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
        a.focusSearch();
        break;
      case 'review':
        c.toggleReviewed();
        break;
      case 'sidebar':
        a.toggleSidebar();
        break;
      case 'theme': {
        const i = THEME_PREFERENCES.indexOf(c.themePreference);
        a.setThemePreference(
          THEME_PREFERENCES[(i + 1) % THEME_PREFERENCES.length] as ThemePreference,
        );
        break;
      }
      case 'help':
        a.openHelp();
        break;
      case 'expand':
        c.expandNearest();
        break;
      default:
        action satisfies never;
    }
  }
}
