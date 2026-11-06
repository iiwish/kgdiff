/**
 * The root of a viewer (RFC 0001 §2–§6): it owns the session and provides it to the regions
 * bound to it (context `kgdiff.viewer/1`), renders them on every notification, and owns what
 * they share: the keyboard map, the live region, the events, the focus targets and the theme
 * tokens. Regions never reference each other; everything goes through the session or the root.
 *
 * In phase 1 the root lives inside `<kgdiff-viewer>` (the element is its host) and the regions
 * are the default layout's; phase 2 makes it `<kgdiff-root>` and the regions elements of their
 * own.
 */
import type { Theme } from '@kgdiff/scene';
import { createContext, provideContext, requestContext } from './context.js';
import { type ControllerHost, ViewerController } from './controller.js';
import { h } from './dom.js';
import type { ThemePreference } from './index.js';
import { isTypingTarget, keyAction } from './keyboard.js';
import { THEME_PREFERENCES } from './prefs.js';
import { defaultStorage } from './review-store.js';
import { cancelFrame, nextPaint, requestFrame } from './schedule.js';
import type { Topic } from './session.js';
import { stylesheet } from './styles.js';
import { themeFromStyle, tokenSheet } from './theme.js';
import type { FocusTarget, UiActions, UiContext } from './ui/context.js';

/** Something the root renders: a region, or the layout itself. */
export interface Region {
  update(topics: ReadonlySet<Topic>): void;
}

/** What a root provides to the regions that bind to it. */
export interface ViewerContext {
  readonly controller: ViewerController;
  readonly actions: UiActions;
  /** The element the root's events are dispatched on and its tokens are set on. */
  readonly host: HTMLElement;
  /** Render `region` on every notification (in binding order); returns the detach. */
  attach(region: Region): () => void;
  target(name: FocusTarget, focus: () => void): () => void;
  focus(name: FocusTarget): boolean;
  /** The keyboard map, for a key event that reached the root. */
  handleKey(e: KeyboardEvent): void;
}

export const viewerContext = createContext<ViewerContext>('kgdiff.viewer/1');

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
  readonly #targets = new Map<FocusTarget, (() => void)[]>();
  #renderFailed = false;

  /**
   * `host` dispatches the events and computes the tokens set on `shadow` (its shadow root);
   * `emitted` runs after each event was dispatched.
   */
  constructor(
    host: HTMLElement,
    shadow: ShadowRoot,
    actions: UiActions,
    emitted?: (type: string) => void,
  ) {
    this.host = host;
    this.#shadow = shadow;
    this.actions = actions;
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
      // The canvas draws with the tokens as computed on the host (page styles win).
      theme: (base) => {
        this.#tokens(base);
        return typeof getComputedStyle === 'function'
          ? themeFromStyle(base, getComputedStyle(host))
          : base;
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

  target(name: FocusTarget, focus: () => void): () => void {
    const list = this.#targets.get(name) ?? [];
    this.#targets.set(name, list);
    list.push(focus);
    return () => {
      const i = list.indexOf(focus);
      if (i >= 0) list.splice(i, 1);
    };
  }

  focus(name: FocusTarget): boolean {
    const focus = this.#targets.get(name)?.at(-1);
    focus?.();
    return focus !== undefined;
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
      if (topics.has('theme') || topics.has('status')) this.#tokens(this.controller.builtinTheme);
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

  /** Apply the token set of `base` (a built-in theme) on the host. */
  #tokens(base: Theme): void {
    const tokens = tokenSheet(base);
    if (this.#shadow.adoptedStyleSheets[1] !== tokens) {
      this.#shadow.adoptedStyleSheets = [stylesheet(), tokens];
    }
  }

  handleKey(e: KeyboardEvent): void {
    const target = e.composedPath()[0] ?? null;
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

/** The UI context of a region placed in `root` (its shadow tree), bound to `ctx`. */
export function uiContext(ctx: ViewerContext, root: ShadowRoot): UiContext {
  return {
    ...ctx.actions,
    controller: ctx.controller,
    root,
    target: (name, focus) => ctx.target(name, focus),
    focus: (name) => ctx.focus(name),
  };
}

/**
 * Bind a region to the root nearest `anchor` (an element where the region is placed): `make`
 * builds it once the root answers, and the root renders it from then on.
 */
export function bindRegion<R extends Region>(anchor: Element, make: (ui: UiContext) => R): R {
  const bound: { region?: R } = {};
  requestContext(anchor, viewerContext, (ctx) => {
    if (bound.region) return;
    bound.region = make(uiContext(ctx, anchor.getRootNode() as ShadowRoot));
    ctx.attach(bound.region);
  });
  // Phase 1: regions are bound by the layout that owns the root, which answers at once.
  if (!bound.region) throw new Error('[kgdiff] a region found no root to bind to.');
  return bound.region;
}
