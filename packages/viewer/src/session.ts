/**
 * The diff session (RFC 0001 §1): everything about one loaded diff that does not depend on how
 * it is drawn.
 *
 * - load pipeline with progress steps (sources or a precomputed report);
 * - view (mode × scope), selection (with an animated spotlight `emphasis`), hover, family
 *   filters, the node search query and its hits, review progress;
 * - the `changes` scope's focus with expandable collapsed groups (`extendLayout` + scene rebuild);
 * - replay clock and loop, swipe position, theme / palette / locale (rebuilding the scene when
 *   they change), and the events reported to the host.
 *
 * No DOM, no renderer: the views that draw the session (`SessionView`: the canvas with its
 * camera, framing and minimap) are told what to draw and what to bring into view. One frame loop
 * advances the replay clock and the emphasis and lets the views draw; it sleeps when idle.
 * Listeners subscribe to topic notifications (batched per microtask) and read public fields.
 */
import type { DiffResult, DiffStats, Locale, Rect, UnionId } from '@kgdiff/core';
import { KgdiffError } from '@kgdiff/core';
import type { LayoutResult } from '@kgdiff/layout';
import {
  buildScene,
  type ChangeFamily,
  computeFocus,
  createViewState,
  createVisualResolver,
  type FocusState,
  frameBounds,
  getTheme,
  type Layer,
  type PaletteName,
  type Scene,
  type Theme,
  type ThemeName,
  type ViewState,
  type VisualResolver,
} from '@kgdiff/scene';
import { computeNow, computeStatus, loadCompute } from './compute-loader.js';
import { translate } from './i18n.js';
import type {
  LoadOptions,
  ReportPayload,
  ReviewState,
  ThemePreference,
  ViewerMode,
  ViewerScope,
} from './index.js';
import { buildList, EMPTY_LIST, type ListModel, stepHunk } from './list-model.js';
import { type LoadedDiff, type LoadStep, readPayload, runLoad } from './pipeline.js';
import { LEGACY_CHANGES_MODE, toLocale, toMode, toPalette, toScope, toTheme } from './prefs.js';
import { ReplayClock } from './replay.js';
import { ReviewStore, reviewKey, type StorageLike } from './review-store.js';
import { type SearchHit, SearchIndex } from './search.js';

export type Status = 'idle' | 'loading' | 'ready' | 'error';

export type Topic =
  | 'status'
  | 'data'
  | 'mode'
  | 'selection'
  | 'filters'
  | 'search'
  | 'review'
  | 'replay'
  | 'hover'
  | 'theme'
  | 'locale'
  | 'focus'
  | 'swipe'
  | 'overview';

/** Every topic: a full render. */
export const ALL_TOPICS: ReadonlySet<Topic> = new Set<Topic>([
  'status',
  'data',
  'mode',
  'selection',
  'filters',
  'search',
  'review',
  'replay',
  'hover',
  'theme',
  'locale',
  'focus',
  'swipe',
  'overview',
]);

/** What the session reports (`<kgdiff-viewer>` turns these into events and announcements). */
export interface SessionHost {
  ready(stats: DiffStats): void;
  select(hunk: string | null, node: string | null): void;
  mode(mode: ViewerMode, scope: ViewerScope): void;
  review(hunk: string, reviewed: boolean, progress: ReviewState): void;
  error(error: Error): void;
  announce(text: string): void;
  /** Playback reached the end of the replay; `loop`: it starts again after the loop delay. */
  replayEnd(loop: boolean): void;
}

export interface SessionDeps {
  readonly now: () => number;
  readonly requestFrame: (cb: (time: number) => void) => number;
  readonly cancelFrame: (id: number) => void;
  /** Resolves once the browser had a chance to paint (between loading steps). */
  readonly yieldToPaint: () => Promise<void>;
  readonly storage: StorageLike | null;
  /**
   * The theme to draw with, given the built-in one for the current theme and palette. A root
   * builds it from its computed CSS tokens (the theme's source of truth); without it the
   * built-in theme is used as it is.
   */
  readonly theme?: (base: Theme) => Theme;
}

/**
 * A view of the session: something that draws it (the canvas, with its camera, framing and
 * minimap). The session tells its views what changed and what to bring into view; how they
 * draw and frame it is theirs.
 */
export interface SessionView {
  /** Draw the session's current state (from the frame loop, when something changed). */
  draw(now: number): void;
  /** The scene was rebuilt, or the theme changed without a scene. */
  sceneChanged(): void;
  /** A new diff was installed: frame it once laid out. */
  installed(): void;
  /** What is drawn changed (mode, scope, focus, filters). */
  drawnChanged(): void;
  /** Bring `bounds` (world coordinates) into view. */
  show(bounds: Rect): void;
  /** Replay follows `bounds`: bring it into view unless it mostly is, or the user steered. */
  follow(bounds: Rect): void;
  /** A looping replay started again. */
  looped(): void;
  /** The world region in view, or null before layout. */
  viewport(): Rect | null;
}

export type Preference = 'mode' | 'scope' | 'theme' | 'palette' | 'locale';

/** Spotlight emphasis restarts here when switching directly between two hunks. */
const SWITCH_EMPHASIS = 0.35;
/** Search hits kept for a query. */
export const SEARCH_LIMIT = 50;

class Superseded extends Error {}

interface EmphasisAnimation {
  readonly from: number;
  readonly to: number;
  readonly start: number;
  readonly duration: number;
}

const ease = (u: number): number => 1 - (1 - u) ** 3;

export class DiffSession {
  status: Status = 'idle';
  /** Steps of the current load, in order; `step` is the running one. */
  steps: LoadStep[] = [];
  step: LoadStep | null = null;
  error: Error | null = null;

  data: LoadedDiff | null = null;
  layout: LayoutResult | null = null;
  scene: Scene | null = null;
  resolver: VisualResolver | null = null;
  list: ListModel = EMPTY_LIST;

  mode: ViewerMode = 'overlay';
  scope: ViewerScope = 'all';
  themePreference: ThemePreference = 'auto';
  palette: PaletteName = 'default';
  locale: Locale = 'en';
  systemDark = true;
  reducedMotion = false;
  /** Preferences set explicitly by the embedder (a report's `view` does not override them). */
  readonly explicit = new Set<Preference>();

  selectedHunk = -1;
  selectedNode = -1;
  /** An edge emphasized from the detail panel (drawn as hovered). */
  pinnedEdge = -1;
  hoverNode = -1;
  hoverEdge = -1;
  hoverGroup = -1;
  readonly families = new Set<ChangeFamily>();
  /** The node search as typed; while it is not blank, `hits` replace the change list. */
  query = '';
  hits: readonly SearchHit[] = [];
  hops = 1;
  readonly expanded = new Set<UnionId>();
  focus: FocusState | null = null;
  clock: ReplayClock | null = null;
  split = 0.5;
  emphasis = 1;

  #theme: Theme | null = null;
  #themeKey = '';
  #review: ReviewStore | null = null;
  #searchIndex: SearchIndex | null = null;
  readonly #views = new Set<SessionView>();
  #fadingHunk = -1;
  #emphasisAnim: EmphasisAnimation | null = null;
  #rafId = 0;
  #lastTick = 0;
  #frameDirty = false;
  #followed = '';
  #loadToken = 0;
  #pendingHunk: { readonly id: string; readonly fly: boolean } | null = null;
  /** A finished replay starts again this long (ms) after its end; null: it plays once. */
  #loopDelay: number | null = null;
  /** When a finished looping replay starts again (`deps.now()` time), else NaN. */
  #restartAt = Number.NaN;
  /** Playback is held (pointer over the graph); `#resume`: it was playing and continues after. */
  #held = false;
  #resume = false;
  readonly #listeners = new Set<(topics: ReadonlySet<Topic>) => void>();
  #pendingTopics = new Set<Topic>();
  #flushQueued = false;
  #destroyed = false;

  readonly #host: SessionHost;
  readonly #deps: SessionDeps;

  constructor(host: SessionHost, deps: SessionDeps) {
    this.#host = host;
    this.#deps = deps;
  }

  // ─── Subscriptions ────────────────────────────────────────────────────────

  subscribe(listener: (topics: ReadonlySet<Topic>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @internal Queue a notification (views report what they derive, e.g. `overview`). */
  notify(...topics: Topic[]): void {
    for (const t of topics) this.#pendingTopics.add(t);
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Deliver pending notifications now (also used by tests). */
  flush(): void {
    this.#flushQueued = false;
    if (this.#pendingTopics.size === 0) return;
    const topics = this.#pendingTopics;
    this.#pendingTopics = new Set();
    for (const fn of this.#listeners) fn(topics);
  }

  /** Draw on `view` from now on; returns the function that stops it. */
  addView(view: SessionView): () => void {
    this.#views.add(view);
    return () => this.#views.delete(view);
  }

  // ─── Derived state ────────────────────────────────────────────────────────

  get themeName(): ThemeName {
    if (this.themePreference === 'auto') return this.systemDark ? 'dark' : 'light';
    return this.themePreference;
  }

  /** The theme to draw with: the built-in one for theme and palette, as the root's CSS says. */
  get theme(): Theme {
    const key = `${this.themeName}/${this.palette}`;
    if (this.#theme === null || key !== this.#themeKey) {
      this.#themeKey = key;
      this.#theme = this.#resolveTheme();
    }
    return this.#theme;
  }

  /** The built-in theme of the current theme and palette (what the root's tokens start from). */
  get builtinTheme(): Theme {
    try {
      return getTheme(this.themeName, this.palette);
    } catch {
      return getTheme('dark', 'default');
    }
  }

  #resolveTheme(): Theme {
    const base = this.builtinTheme;
    return this.#deps.theme?.(base) ?? base;
  }

  get diff(): DiffResult | null {
    return this.data?.diff ?? null;
  }

  get hunkCount(): number {
    return this.scene?.hunks.length ?? 0;
  }

  isReviewed(hunkId: string): boolean {
    return this.#review?.has(hunkId) ?? false;
  }

  reviewState(): ReviewState {
    return this.#review?.state() ?? { reviewed: [], total: 0 };
  }

  search(query: string, limit?: number): SearchHit[] {
    const diff = this.diff;
    if (!diff) return [];
    this.#searchIndex ??= new SearchIndex(diff);
    return this.#searchIndex.search(query, limit);
  }

  /** Search the nodes for `query`; delivered at once, so the results follow every keystroke. */
  setQuery(query: string): void {
    this.query = query;
    this.#runSearch();
    this.notify('search');
    this.flush();
  }

  #runSearch(): void {
    const q = this.query.trim();
    this.hits = q ? this.search(q, SEARCH_LIMIT) : [];
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  async load(options: LoadOptions): Promise<void> {
    const text = (s: unknown): boolean =>
      typeof s === 'object' && s !== null && typeof (s as { text?: unknown }).text === 'string';
    const parse = text(options?.before) || text(options?.after);
    await this.#run(
      parse ? ['parse', 'match', 'layout', 'scene'] : ['match', 'layout', 'scene'],
      (onStep) => runLoad(options, onStep),
    );
  }

  async loadPayload(payload: ReportPayload): Promise<void> {
    await this.#run(['match', 'layout', 'scene'], (onStep) => readPayload(payload, onStep));
  }

  async #run(
    planned: LoadStep[],
    work: (onStep: (step: LoadStep) => Promise<void>) => Promise<LoadedDiff>,
  ): Promise<void> {
    const token = ++this.#loadToken;
    this.pause();
    this.status = 'loading';
    this.error = null;
    this.steps = planned;
    this.step = null;
    this.notify('status');
    const onStep = async (step: LoadStep): Promise<void> => {
      if (token !== this.#loadToken || this.#destroyed) throw new Superseded();
      this.step = step;
      this.notify('status');
      this.flush();
      await this.#deps.yieldToPaint();
      if (token !== this.#loadToken || this.#destroyed) throw new Superseded();
    };
    try {
      const loaded = await work(onStep);
      await onStep('scene');
      this.#install(loaded);
    } catch (error) {
      if (error instanceof Superseded) {
        throw new DOMException('Superseded by a newer load.', 'AbortError');
      }
      const err = error instanceof Error ? error : new KgdiffError('invalid-input', String(error));
      if (token === this.#loadToken) this.fail(err);
      throw err;
    }
  }

  /** Show an error state (bad payload, failed load). */
  fail(error: Error): void {
    this.#loadToken++;
    this.clock?.pause();
    this.#restartAt = Number.NaN;
    this.#resume = false;
    this.status = 'error';
    this.error = error;
    this.step = null;
    // Nothing stale stays on screen next to the error.
    this.data = null;
    this.layout = null;
    this.scene = null;
    this.resolver = null;
    this.list = EMPTY_LIST;
    this.clock = null;
    this.focus = null;
    this.#review = null;
    this.#searchIndex = null;
    this.#runSearch();
    this.selectedHunk = this.selectedNode = this.pinnedEdge = -1;
    this.notify('status', 'data', 'selection', 'filters', 'search', 'review', 'replay', 'focus');
    this.#host.error(error);
  }

  #install(loaded: LoadedDiff): void {
    const { diff, layout, view } = loaded;
    this.data = loaded;
    this.layout = layout;
    this.#searchIndex = null;
    this.#runSearch();
    this.families.clear();
    this.expanded.clear();
    this.hops = Math.max(0, Math.min(2, loaded.layoutOptions?.contextHops ?? 1));
    this.selectedHunk = -1;
    this.selectedNode = -1;
    this.pinnedEdge = -1;
    this.#fadingHunk = -1;
    this.emphasis = 1;
    this.#emphasisAnim = null;
    this.hoverNode = this.hoverEdge = this.hoverGroup = -1;
    this.split = 0.5;
    this.clock = null;
    this.#followed = '';
    if (view) {
      if (view.theme && !this.explicit.has('theme')) this.themePreference = view.theme;
      if (view.palette && !this.explicit.has('palette')) this.palette = view.palette;
      if (view.locale && !this.explicit.has('locale')) this.locale = view.locale;
    }
    const previousMode = this.mode;
    const previousScope = this.scope;
    if (!this.explicit.has('mode')) this.mode = view?.mode ?? 'overlay';
    if (layout.scope === 'changes') {
      // Only the changes are laid out: there is no whole graph to show.
      this.scope = 'changes';
    } else if (!this.explicit.has('scope')) {
      const threshold = loaded.layoutOptions?.largeGraphThreshold ?? 3000;
      this.scope = view?.scope ?? (diff.nodes.length > threshold ? 'changes' : 'all');
    }
    this.#review = new ReviewStore(
      this.#deps.storage,
      reviewKey(diff.delta.base.hash, diff.delta.target.hash),
      diff.hunks.map((h) => h.id),
    );
    this.#rebuildScene();
    this.status = 'ready';
    this.step = null;
    if (layout.scope === 'changes' && computeStatus() === 'unknown') {
      // Learn early whether out-of-layout groups can be expanded (standalone reports).
      loadCompute().then(
        () => this.notify('focus'),
        () => this.notify('focus'),
      );
    }
    this.notify(...ALL_TOPICS);
    // A new diff starts fitted, after the UI has shown its chrome (the notification above is
    // delivered first) and once the canvas has a size.
    for (const v of this.#views) v.installed();
    this.#host.ready(diff.stats);
    if (this.mode !== previousMode || this.scope !== previousScope) {
      this.#host.mode(this.mode, this.scope);
    }
    const pending = this.#pendingHunk;
    this.#pendingHunk = null;
    if (pending !== null) this.selectHunkById(pending.id, { fly: pending.fly });
    else this.#autoplay();
  }

  /** (Re)build scene, resolver, list, clock and focus; selection is carried over by id. */
  #rebuildScene(): void {
    const data = this.data;
    const layout = this.layout;
    if (!data || !layout) return;
    const old = this.scene;
    const keepHunk = old && this.selectedHunk >= 0 ? old.hunks[this.selectedHunk]?.id : undefined;
    const keepNode = old && this.selectedNode >= 0 ? old.nodes[this.selectedNode]?.id : undefined;
    const keepEdge = old && this.pinnedEdge >= 0 ? old.edges[this.pinnedEdge]?.id : undefined;
    const scene = buildScene(data.diff, layout, { theme: this.theme, locale: this.locale });
    this.scene = scene;
    this.resolver = createVisualResolver(scene);
    const prevClock = this.clock;
    this.clock = new ReplayClock(scene.timeline);
    if (prevClock) {
      this.clock.setSpeed(prevClock.speed);
      this.clock.seek(prevClock.t);
      if (prevClock.playing) this.clock.play();
    }
    this.selectedHunk = keepHunk !== undefined ? (scene.hunkIndex.get(keepHunk) ?? -1) : -1;
    this.selectedNode = keepNode !== undefined ? (scene.nodeIndex.get(keepNode) ?? -1) : -1;
    this.pinnedEdge = keepEdge !== undefined ? (scene.edgeIndex.get(keepEdge) ?? -1) : -1;
    this.#fadingHunk = -1;
    this.hoverNode = this.hoverEdge = this.hoverGroup = -1;
    this.list = buildList(scene, this.families);
    this.#updateFocus();
    for (const v of this.#views) v.sceneChanged();
    this.invalidate();
  }

  #updateFocus(): void {
    const scene = this.scene;
    if (!scene || this.scope !== 'changes') {
      this.focus = null;
      return;
    }
    const expanded = new Set<number>();
    for (const id of this.expanded) {
      const i = scene.nodeIndex.get(id);
      if (i !== undefined) expanded.add(i);
    }
    this.focus = computeFocus(scene, { hops: this.hops, expanded });
  }

  destroy(): void {
    this.#destroyed = true;
    this.sleep();
    this.#listeners.clear();
  }

  // ─── Frame loop ───────────────────────────────────────────────────────────

  /** Redraw on the next frame. */
  invalidate(): void {
    this.#frameDirty = true;
    this.#schedule();
  }

  /** @internal Drop the pending frame (the views are gone); `invalidate` wakes the loop. */
  sleep(): void {
    if (this.#rafId) this.#deps.cancelFrame(this.#rafId);
    this.#rafId = 0;
  }

  #schedule(): void {
    if (this.#rafId !== 0 || this.#destroyed) return;
    this.#rafId = this.#deps.requestFrame(this.#tick) || 0;
  }

  readonly #tick = (): void => {
    this.#rafId = 0;
    if (this.#destroyed) return;
    const now = this.#deps.now();
    const dt = this.#lastTick > 0 ? now - this.#lastTick : 0;
    let animating = false;
    const clock = this.clock;
    if (clock?.playing && this.mode === 'replay') {
      clock.advance(dt);
      this.#frameDirty = true;
      this.notify('replay');
      this.#follow();
      if (clock.playing) animating = true;
      else if (clock.finished) this.#ended();
    }
    if (!Number.isNaN(this.#restartAt) && !this.#held) {
      if (now >= this.#restartAt) this.#loopAgain();
      else animating = true;
    }
    if (this.#emphasisAnim) {
      const a = this.#emphasisAnim;
      const u = a.duration > 0 ? Math.min(1, (now - a.start) / a.duration) : 1;
      this.emphasis = a.from + (a.to - a.from) * ease(u);
      this.#frameDirty = true;
      if (u >= 1) {
        this.#emphasisAnim = null;
        if (this.#fadingHunk >= 0) {
          this.#fadingHunk = -1;
          this.emphasis = 1;
        }
      } else animating = true;
    }
    if (this.#frameDirty) {
      this.#frameDirty = false;
      for (const v of this.#views) v.draw(now);
    }
    if (animating) {
      this.#lastTick = now;
      this.#schedule();
    } else this.#lastTick = 0;
  };

  /** What a view draws for `layer` now. */
  viewState(layer: Layer): ViewState {
    const selected = this.selectedHunk >= 0 ? this.selectedHunk : this.#fadingHunk;
    return createViewState({
      layer,
      t: this.clock?.t ?? 0,
      selectedHunk: selected,
      hoveredNode: this.hoverNode,
      hoveredEdge: this.hoverEdge >= 0 ? this.hoverEdge : this.pinnedEdge,
      selectedNode: this.selectedNode,
      focus: this.focus,
      families: this.families,
      reducedMotion: this.reducedMotion,
      emphasis: this.emphasis,
    });
  }

  #startEmphasis(from: number): void {
    if (this.reducedMotion) {
      this.emphasis = 1;
      this.#emphasisAnim = null;
      this.#fadingHunk = -1;
      return;
    }
    this.emphasis = from;
    this.#emphasisAnim = {
      from,
      to: 1,
      start: this.#deps.now(),
      duration: this.theme.motion.base,
    };
  }

  #fadeOutEmphasis(hunk: number): void {
    if (this.reducedMotion || hunk < 0) {
      this.#fadingHunk = -1;
      this.#emphasisAnim = null;
      this.emphasis = 1;
      return;
    }
    this.#fadingHunk = hunk;
    this.#emphasisAnim = {
      from: this.emphasis,
      to: 0,
      start: this.#deps.now(),
      duration: this.theme.motion.base,
    };
  }

  #drawnChanged(): void {
    for (const v of this.#views) v.drawnChanged();
  }

  // ─── View: mode × scope ───────────────────────────────────────────────────

  /** Whether the scope is fixed to `changes` (the layout covers only the changes). */
  get scopeLocked(): boolean {
    return this.layout?.scope === 'changes';
  }

  /** Switch how the versions are compared. The legacy `changes` means overlay + `changes` scope. */
  setMode(value: ViewerMode | typeof LEGACY_CHANGES_MODE): void {
    if (value === LEGACY_CHANGES_MODE) {
      this.setView('overlay', 'changes');
      return;
    }
    const mode = toMode(value);
    if (mode !== null) this.setView(mode, this.scope);
  }

  /** Show the whole graph or only the changes, in any mode. */
  setScope(value: ViewerScope): void {
    const scope = toScope(value);
    if (scope !== null) this.setView(this.mode, scope);
  }

  /** Toggle the `changes` scope (key `4`); says why when the scope is locked. */
  toggleScope(): void {
    if (this.scopeLocked) {
      this.#host.announce(translate(this.locale, 'scope.locked'));
      return;
    }
    this.setScope(this.scope === 'changes' ? 'all' : 'changes');
  }

  /** Set mode and scope together (one notification, one `kgdiff-mode` event). */
  setView(mode: ViewerMode, scope: ViewerScope): void {
    const nextScope: ViewerScope = this.scopeLocked ? 'changes' : scope;
    const modeChanged = mode !== this.mode;
    const scopeChanged = nextScope !== this.scope;
    if (!modeChanged && !scopeChanged) return;
    this.mode = mode;
    this.scope = nextScope;
    if (mode !== 'replay') {
      this.clock?.pause();
      this.#restartAt = Number.NaN;
      this.#resume = false;
    }
    this.#followed = '';
    if (scopeChanged) this.#updateFocus();
    this.#drawnChanged();
    this.notify('mode', 'focus', 'replay');
    this.invalidate();
    if (this.status === 'ready') {
      this.#host.mode(mode, nextScope);
      const parts: string[] = [];
      if (modeChanged) {
        parts.push(
          translate(this.locale, 'announce.mode', { mode: translate(this.locale, `mode.${mode}`) }),
        );
      }
      if (scopeChanged) {
        parts.push(translate(this.locale, nextScope === 'changes' ? 'scope.on' : 'scope.off'));
      }
      this.#host.announce(parts.join(' · '));
    }
    // Switching to replay starts a looping replay; toggling the scope leaves playback alone.
    if (modeChanged && mode === 'replay') this.#autoplay();
  }

  // ─── Selection ────────────────────────────────────────────────────────────

  selectHunkById(id: string | null, options: { fly?: boolean } = {}): void {
    if (id === null) {
      this.#pendingHunk = null;
      this.clearSelection();
      return;
    }
    const scene = this.scene;
    if (!scene || this.status !== 'ready') {
      this.#pendingHunk = { id, fly: options.fly ?? true };
      return;
    }
    const h = scene.hunkIndex.get(id);
    if (h !== undefined) this.selectHunk(h, options);
  }

  /**
   * Select hunk `h` (scene index; -1 clears). `node` focuses one of its nodes in the detail
   * panel. `fly` (default true) brings it into view. In replay, seeks to the end of its window.
   */
  selectHunk(h: number, options: { fly?: boolean; node?: number } = {}): void {
    const scene = this.scene;
    if (!scene) return;
    if (h < 0 || h >= scene.hunks.length) {
      this.clearSelection();
      return;
    }
    const node = options.node ?? -1;
    const prev = this.selectedHunk;
    const changed = prev !== h || this.selectedNode !== node;
    this.selectedHunk = h;
    this.selectedNode = node;
    this.pinnedEdge = -1;
    if (prev !== h) {
      this.#fadingHunk = -1;
      this.#startEmphasis(prev >= 0 ? SWITCH_EMPHASIS : 0);
      if (this.mode === 'replay' && this.clock) {
        const end = this.clock.windowEnd(h);
        this.clock.pause();
        this.#restartAt = Number.NaN;
        this.#resume = false;
        if (end !== null) this.clock.seek(end);
        this.#followed = '';
        this.notify('replay');
      }
    }
    if (options.fly ?? true) this.flyToHunk(h);
    this.invalidate();
    if (!changed) return;
    this.notify('selection');
    const hunk = scene.hunks[h];
    if (!hunk) return;
    const nodeId = node >= 0 ? (scene.nodes[node]?.id ?? null) : null;
    this.#host.select(hunk.id, nodeId);
    if (prev !== h) {
      const rank = this.list.rank.get(h);
      this.#host.announce(
        translate(this.locale, 'announce.change', {
          i: (rank ?? h) + 1,
          n: rank !== undefined ? this.list.order.length : scene.hunks.length,
          title: hunk.title,
        }),
      );
    }
  }

  /** Select a node: its hunk when it has one, else the node itself. */
  selectNode(i: number, options: { fly?: boolean } = {}): void {
    const scene = this.scene;
    const n = scene?.nodes[i];
    if (!scene || !n) return;
    if (n.hunk >= 0) {
      this.selectHunk(n.hunk, { ...options, node: i });
      return;
    }
    const prev = this.selectedHunk;
    if (prev < 0 && this.selectedNode === i) {
      if (options.fly) this.flyToNode(i);
      return;
    }
    this.selectedHunk = -1;
    this.selectedNode = i;
    this.pinnedEdge = -1;
    if (prev >= 0) this.#fadeOutEmphasis(prev);
    if (options.fly) this.flyToNode(i);
    this.invalidate();
    this.notify('selection');
    this.#host.select(null, n.id);
    this.#host.announce(
      translate(this.locale, 'announce.node', {
        label: n.label,
        status: translate(this.locale, `status.${n.status}`),
      }),
    );
  }

  clearSelection(): void {
    if (this.selectedHunk < 0 && this.selectedNode < 0 && this.pinnedEdge < 0) return;
    const prev = this.selectedHunk;
    this.selectedHunk = -1;
    this.selectedNode = -1;
    this.pinnedEdge = -1;
    this.#fadeOutEmphasis(prev);
    this.invalidate();
    this.notify('selection');
    this.#host.select(null, null);
    this.#host.announce(translate(this.locale, 'announce.cleared'));
  }

  next(): void {
    this.#stepSelection(1);
  }

  prev(): void {
    this.#stepSelection(-1);
  }

  #stepSelection(direction: 1 | -1): void {
    const h = stepHunk(this.list, this.selectedHunk, direction);
    if (h >= 0) this.selectHunk(h);
  }

  first(): void {
    const h = this.list.order[0];
    if (h !== undefined) this.selectHunk(h);
  }

  last(): void {
    const h = this.list.order[this.list.order.length - 1];
    if (h !== undefined) this.selectHunk(h);
  }

  /** Emphasize an edge (from the detail panel) and fly to it. */
  pinEdge(j: number): void {
    const scene = this.scene;
    const e = scene?.edges[j];
    if (!scene || !e) return;
    this.pinnedEdge = j;
    const ids = [e.s, e.t, e.sb, e.tb];
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const i of ids) {
      const n = scene.nodes[i];
      if (!n) continue;
      x0 = Math.min(x0, n.x - n.r);
      y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r);
      y1 = Math.max(y1, n.y + n.r);
    }
    if (x0 <= x1) this.#show(padRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
    this.invalidate();
  }

  setHover(node: number, edge: number, group: number): void {
    if (node === this.hoverNode && edge === this.hoverEdge && group === this.hoverGroup) return;
    this.hoverNode = node;
    this.hoverEdge = edge;
    this.hoverGroup = group;
    this.notify('hover');
    this.invalidate();
  }

  /** Clear hover state (pointer left the canvas). */
  clearHover(): void {
    this.setHover(-1, -1, -1);
  }

  // ─── Bringing things into view ────────────────────────────────────────────

  #show(bounds: Rect): void {
    for (const v of this.#views) v.show(bounds);
  }

  /** “Change 3 of 23: …” for a replayed hunk, “Restructured: 722 changes” for a chapter. */
  #announceTarget(kind: 'hunk' | 'chapter', index: number): void {
    const scene = this.scene;
    const clock = this.clock;
    if (!scene || !clock) return;
    if (kind === 'chapter') {
      const ch = scene.timeline.chapters[index];
      if (!ch) return;
      this.#host.announce(
        translate(this.locale, 'announce.chapter', {
          phase: translate(this.locale, `phase.${ch.phase}`),
          n: ch.hunks.length,
        }),
      );
      return;
    }
    const hunk = scene.hunks[index];
    const order = clock.timeline.windows.findIndex((w) => w.hunk === index);
    if (!hunk || order < 0) return;
    this.#host.announce(
      translate(this.locale, 'announce.change', {
        i: order + 1,
        n: clock.total,
        title: hunk.title,
      }),
    );
  }

  /** Replay follows `hunks`: the views bring them into view unless they mostly are. */
  #followHunks(hunks: readonly number[]): void {
    const scene = this.scene;
    if (!scene || hunks.length === 0) return;
    const bounds = frameBounds(scene, hunks);
    for (const v of this.#views) v.follow(bounds);
  }

  /** Replay: follow (and announce) the playing hunk / chapter when it changes. */
  #follow(): void {
    const scene = this.scene;
    const clock = this.clock;
    if (!scene || !clock) return;
    const target = clock.activeTarget();
    if (target.index < 0) return;
    const key = `${target.kind}:${target.index}`;
    if (key === this.#followed) return;
    this.#followed = key;
    this.#announceTarget(target.kind, target.index);
    this.#followHunks(
      target.kind === 'chapter'
        ? (scene.timeline.chapters[target.index]?.hunks ?? [])
        : [target.index],
    );
  }

  #hunkBounds(h: number): Rect | null {
    const scene = this.scene;
    return scene?.hunks[h] ? frameBounds(scene, [h]) : null;
  }

  #nodeBounds(i: number): Rect | null {
    const n = this.scene?.nodes[i];
    return n ? padRect({ x: n.x - n.r, y: n.y - n.r, width: 2 * n.r, height: 2 * n.r }) : null;
  }

  /** Where the current selection is (world coordinates), or null. */
  selectionBounds(): Rect | null {
    if (this.selectedHunk >= 0) return this.#hunkBounds(this.selectedHunk);
    if (this.selectedNode >= 0) return this.#nodeBounds(this.selectedNode);
    return null;
  }

  flyToHunk(h: number): void {
    const b = this.#hunkBounds(h);
    if (b) this.#show(b);
  }

  flyToNode(i: number): void {
    const b = this.#nodeBounds(i);
    if (b) this.#show(b);
  }

  flyToSelection(): void {
    const b = this.selectionBounds();
    if (b) this.#show(b);
  }

  // ─── Filters, focus ───────────────────────────────────────────────────────

  toggleFamily(family: ChangeFamily): void {
    if (this.families.has(family)) this.families.delete(family);
    else this.families.add(family);
    this.#filtersChanged();
  }

  /** Replace the family filter (empty = all). Setting the current set again clears it. */
  setFamilies(families: readonly ChangeFamily[]): void {
    const same =
      families.length === this.families.size && families.every((f) => this.families.has(f));
    this.families.clear();
    if (!same) for (const f of families) this.families.add(f);
    this.#filtersChanged();
  }

  #filtersChanged(): void {
    if (this.scene) this.list = buildList(this.scene, this.families);
    this.#drawnChanged();
    this.notify('filters');
    this.invalidate();
  }

  setHops(hops: number): void {
    const h = Math.max(0, Math.min(2, Math.round(hops)));
    if (h === this.hops) return;
    this.hops = h;
    this.#focusChanged();
  }

  /**
   * Expand collapsed group `index` of the current focus: its in-scene members become visible
   * and, for a `changes`-scoped layout, the neighbours left out of the layout are placed with
   * `extendLayout` (nothing already placed moves) and the scene is rebuilt.
   */
  expandGroup(index: number): void {
    const group = this.focus?.collapsed[index];
    const scene = this.scene;
    if (!group || !scene) return;
    const ids: UnionId[] = group.nodes.map((i) => scene.nodes[i]?.id).filter(isString);
    if (!this.canExpand(index)) {
      // Without the layout engine only the members already laid out can be shown.
      if (ids.length > 0) void this.#expandIds(ids, []);
      return;
    }
    const owner = group.id.startsWith('near:')
      ? group.id.slice(5)
      : group.id.startsWith('component:')
        ? group.id.slice(10)
        : null;
    void this.#expandIds(ids, owner !== null ? [owner, ...ids] : ids);
  }

  /**
   * The collapsed group nearest the selection (else the view center), or -1. Groups that can
   * be expanded at least partly come first.
   */
  nearestGroup(): number {
    const groups = this.focus?.collapsed ?? [];
    if (groups.length === 0) return -1;
    const sel = this.selectionBounds();
    let view: Rect | null = null;
    for (const v of this.#views) view ??= v.viewport();
    const at = sel ?? view ?? this.scene?.bounds;
    const cx = at ? at.x + at.width / 2 : 0;
    const cy = at ? at.y + at.height / 2 : 0;
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    groups.forEach((g, i) => {
      const usable = this.canExpand(i) || g.nodes.length > 0;
      const score = Math.hypot(g.x - cx, g.y - cy) + (usable ? 0 : 1e12);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  /** Expand the group nearest the selection (keyboard `e`); announces what happened. */
  expandNearest(): void {
    const i = this.nearestGroup();
    const group = i >= 0 ? this.focus?.collapsed[i] : undefined;
    if (!group || (!this.canExpand(i) && group.nodes.length === 0)) {
      this.#host.announce(
        translate(this.locale, group ? 'focus.expandUnavailable' : 'announce.nothingHidden'),
      );
      return;
    }
    this.expandGroup(i);
    this.#host.announce(translate(this.locale, 'announce.expanded', { label: group.label }));
  }

  /**
   * Whether collapsed group `index` can be expanded completely: always, unless some members lie
   * outside a `changes`-scoped layout and the layout engine is known to be unavailable
   * (standalone report without the compute add-on).
   */
  canExpand(index: number): boolean {
    const group = this.focus?.collapsed[index];
    if (!group) return false;
    const outside = this.layout?.scope === 'changes' && group.count > group.nodes.length;
    return !outside || computeStatus() !== 'unavailable';
  }

  /**
   * Make `ids` visible, placing those outside the layout, plus the out-of-layout neighbours of
   * `neighboursOf`. Resolves once done (the layout engine may load lazily first).
   */
  #expandIds(ids: readonly UnionId[], neighboursOf: readonly UnionId[]): Promise<void> {
    const data = this.data;
    const layout = this.layout;
    if (!data || !layout) return Promise.resolve();
    for (const id of ids) this.expanded.add(id);
    const missing = new Set<UnionId>();
    if (layout.scope === 'changes') {
      for (const id of ids) if (!layout.positions.has(id)) missing.add(id);
      for (const id of neighboursOf) {
        for (const e of data.diff.index.edgesOf(id)) {
          for (const end of [e.source, e.target, e.sourceBefore, e.targetBefore]) {
            if (end !== undefined && !layout.positions.has(end)) missing.add(end);
          }
        }
      }
    }
    if (missing.size === 0) {
      this.#focusChanged();
      return Promise.resolve();
    }
    const place = (): void => {
      const compute = computeNow();
      const current = this.layout;
      if (!compute || !current || this.data !== data) return;
      const todo = [...missing].filter((id) => !current.positions.has(id));
      if (todo.length > 0) {
        this.layout = compute.extendLayout(data.diff, current, todo, data.layoutOptions);
        for (const id of todo) this.expanded.add(id);
        this.#rebuildScene();
        this.notify('data', 'selection', 'replay');
      }
      this.#focusChanged();
    };
    if (computeNow()) {
      place();
      return Promise.resolve();
    }
    // Standalone reports load the layout engine on demand.
    return loadCompute().then(place, () => this.#focusChanged());
  }

  #focusChanged(): void {
    this.#updateFocus();
    this.#drawnChanged();
    this.notify('focus');
    this.invalidate();
  }

  /** Bring a union node into the scene and the focus (search results), then select it. */
  revealNode(id: UnionId): Promise<void> {
    if (!this.data || !this.scene) return Promise.resolve();
    const select = (): void => {
      const i = this.scene?.nodeIndex.get(id);
      if (i !== undefined) this.selectNode(i, { fly: true });
    };
    if (this.scene.nodeIndex.has(id) && this.#isVisible(id)) {
      select();
      return Promise.resolve();
    }
    return this.#expandIds([id], []).then(select);
  }

  #isVisible(id: UnionId): boolean {
    const i = this.scene?.nodeIndex.get(id);
    return i !== undefined && (this.focus === null || this.focus.nodes[i] === 1);
  }

  // ─── Replay ───────────────────────────────────────────────────────────────

  play(): void {
    const clock = this.clock;
    if (!clock || this.status !== 'ready') return;
    if (this.mode !== 'replay') this.setMode('replay');
    this.#restartAt = Number.NaN;
    this.#resume = false;
    clock.play();
    this.#followed = '';
    this.#lastTick = 0;
    this.notify('replay');
    this.invalidate();
  }

  /** Pause; a looping replay stays paused (until `play`, a new diff or loop turned on again). */
  pause(): void {
    this.#restartAt = Number.NaN;
    this.#resume = false;
    if (!this.clock?.playing) return;
    this.clock.pause();
    this.notify('replay');
    this.invalidate();
  }

  togglePlay(): void {
    if (this.clock?.playing) this.pause();
    else this.play();
  }

  /**
   * Play the replay over and over: `delay` ms after it ends it starts again; null plays it
   * once. Turning the loop on starts a replay that is shown but not playing.
   */
  setLoop(delay: number | null): void {
    const was = this.#loopDelay;
    this.#loopDelay = delay === null ? null : Number.isFinite(delay) ? Math.max(0, delay) : 0;
    if (this.#loopDelay === null) this.#restartAt = Number.NaN;
    else if (was === null) this.#autoplay();
  }

  get loopDelay(): number | null {
    return this.#loopDelay;
  }

  /**
   * Hold playback while the pointer rests on the graph (`pause-on-hover`): a playing replay
   * pauses and continues on release; a pending loop restart waits for the release, then the
   * full loop delay.
   */
  hold(held: boolean): void {
    if (held === this.#held) return;
    this.#held = held;
    const clock = this.clock;
    if (held) {
      if (!clock?.playing) return;
      clock.pause();
      this.#resume = true;
      this.notify('replay');
      this.invalidate();
      return;
    }
    if (!Number.isNaN(this.#restartAt) && this.#loopDelay !== null) {
      this.#restartAt = this.#deps.now() + this.#loopDelay;
      this.#schedule();
    }
    if (this.#resume) this.play();
  }

  /** Looping and showing a replay that is not playing: start it (or after the hold). */
  #autoplay(): void {
    if (this.#loopDelay === null || this.status !== 'ready' || this.mode !== 'replay') return;
    if (!this.clock || this.clock.playing || !Number.isNaN(this.#restartAt)) return;
    if (this.#held) this.#resume = true;
    else this.play();
  }

  /** Playback reached the end: announce it, tell the host and arm the loop restart. */
  #ended(): void {
    this.#host.announce(translate(this.locale, 'announce.finished'));
    const loop = this.#loopDelay !== null;
    // Armed first, so a `kgdiff-replay-end` listener can still cancel it (pause, loop off).
    if (loop) this.#restartAt = this.#deps.now() + (this.#loopDelay ?? 0);
    this.#host.replayEnd(loop);
  }

  #loopAgain(): void {
    this.#restartAt = Number.NaN;
    for (const v of this.#views) v.looped();
    this.clock?.seek(0);
    this.play();
  }

  seek(t: number): void {
    const clock = this.clock;
    if (!clock) return;
    this.#restartAt = Number.NaN;
    clock.seek(t);
    this.notify('replay');
    this.#follow();
    this.invalidate();
  }

  stepReplay(direction: 1 | -1): void {
    const clock = this.clock;
    if (!clock) return;
    clock.step(direction);
    this.#restartAt = Number.NaN;
    this.#resume = false;
    this.#followed = '';
    // Follow (and announce) the hunk that just completed: stops sit at window ends.
    const w = clock.timeline.windows[clock.position() - 1];
    if (w) {
      if (clock.timeline.mode === 'chapters') this.#announceTarget('chapter', w.chapter);
      else this.#announceTarget('hunk', w.hunk);
      this.#followHunks(
        clock.timeline.mode === 'chapters'
          ? (clock.timeline.chapters[w.chapter]?.hunks ?? [w.hunk])
          : [w.hunk],
      );
    }
    this.notify('replay');
    this.invalidate();
  }

  restart(): void {
    this.clock?.seek(0);
    this.play();
  }

  cycleSpeed(): void {
    this.clock?.cycleSpeed();
    this.notify('replay');
  }

  setSpeed(speed: number): void {
    this.clock?.setSpeed(speed);
    this.notify('replay');
  }

  // ─── Swipe ────────────────────────────────────────────────────────────────

  setSplit(split: number): void {
    const s = Number.isFinite(split) ? Math.min(1, Math.max(0, split)) : 0.5;
    if (s === this.split) return;
    this.split = s;
    this.notify('swipe');
    if (this.mode === 'swipe') this.invalidate();
  }

  // ─── Review ───────────────────────────────────────────────────────────────

  setReviewed(hunkId: string, reviewed: boolean): void {
    const review = this.#review;
    if (!review?.setReviewed(hunkId, reviewed)) return;
    const progress = review.state();
    this.notify('review');
    this.#host.review(hunkId, reviewed, progress);
    const text = translate(this.locale, 'review.progress', {
      done: progress.reviewed.length,
      total: progress.total,
    });
    this.#host.announce(
      translate(this.locale, reviewed ? 'announce.reviewed' : 'announce.unreviewed', {
        progress: text,
      }),
    );
  }

  /** Another tab changed review progress (`storage` event): re-read it. */
  syncReview(key: string | null): void {
    if (this.#review?.reload(key)) this.notify('review');
  }

  toggleReviewed(hunkId?: string): void {
    const id =
      hunkId ?? (this.selectedHunk >= 0 ? this.scene?.hunks[this.selectedHunk]?.id : undefined);
    if (id !== undefined) this.setReviewed(id, !this.isReviewed(id));
  }

  // ─── Appearance ───────────────────────────────────────────────────────────

  #appearance(apply: () => void): void {
    const name = this.themeName;
    const palette = this.palette;
    const locale = this.locale;
    apply();
    const themeChanged = name !== this.themeName || palette !== this.palette;
    const localeChanged = locale !== this.locale;
    if (themeChanged || localeChanged) this.#rethemed();
    if (themeChanged) this.notify('theme');
    if (localeChanged) this.notify('locale', 'data');
  }

  /** Draw with the current theme and locale: rebuild the scene, or re-theme the views. */
  #rethemed(): void {
    if (this.data) this.#rebuildScene();
    else for (const v of this.#views) v.sceneChanged();
  }

  /**
   * @internal Read the theme again (`SessionDeps.theme`: the root's CSS tokens changed, e.g.
   * the host overrode one); redraws only when the result changed.
   */
  refreshTheme(): void {
    const next = this.#resolveTheme();
    if (next === this.#theme) return;
    this.#theme = next;
    this.#themeKey = `${this.themeName}/${this.palette}`;
    this.#rethemed();
    this.notify('theme');
  }

  setThemePreference(pref: ThemePreference): void {
    this.#appearance(() => {
      this.themePreference = toTheme(pref) ?? 'auto';
    });
    this.notify('theme');
  }

  setPalette(palette: PaletteName): void {
    this.#appearance(() => {
      this.palette = toPalette(palette) ?? 'default';
    });
  }

  setLocale(locale: Locale): void {
    this.#appearance(() => {
      this.locale = toLocale(locale) ?? 'en';
    });
  }

  setSystemDark(dark: boolean): void {
    this.#appearance(() => {
      this.systemDark = dark;
    });
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.invalidate();
  }
}

function isString(x: string | undefined): x is string {
  return x !== undefined;
}

/** Pad a small rect so a node is shown with its neighbourhood. */
export function padRect(r: Rect, min = 200, ratio = 1.4): Rect {
  const w = Math.max(min, r.width * ratio);
  const h = Math.max(min, r.height * ratio);
  return { x: r.x + r.width / 2 - w / 2, y: r.y + r.height / 2 - h / 2, width: w, height: h };
}
