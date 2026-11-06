/**
 * The canvas area and its floating chrome: the view dock (`dock.ts`, with replay's caption and
 * transport stacked above it), swipe divider, legend (`legend.ts`: a card, or one line of dots
 * for chrome-less embeds), zoom controls (`zoom.ts`) + minimap (shown only while part of the
 * content is out of view), hover tooltip and the loading / identical / error / empty states.
 * Overlays never cover the current hunk: fits and flights frame it in the free part of the
 * canvas. The view (`view` once attached) draws the canvas; the chrome reads the session.
 *
 * With slots (`<kgdiff-stage>`, and `<kgdiff-viewer>` for the page's content), a chrome element
 * slotted in (`<kgdiff-transport slot="bottom-center">`) replaces the built-in one.
 */
import { KgdiffError, type Rect } from '@kgdiff/core';
import type { Family } from '@kgdiff/scene';
import type { Topic } from '../controller.js';
import { attr, h, icon, moveFocusOut, replace, setText } from '../dom.js';
import type { ChromeLayout } from '../framing.js';
import type { Translator } from '../i18n.js';
import type { PanelState, PanelStates, StageRegion, StageVersion } from '../index.js';
import type { StageView } from '../view.js';
import { sceneHunkGlyph, type UiContext } from './context.js';
import { Dock } from './dock.js';
import { Legend } from './legend.js';
import { Transport } from './transport.js';
import { ZoomBar } from './zoom.js';

/** How the legend shows: the card, one line of dots, or not at all. */
export type LegendStyle = 'full' | 'mini' | 'none';

/** The named slots of `<kgdiff-stage>`, where the page puts its own content over the canvas. */
export const STAGE_SLOTS = [
  'top-start',
  'top-end',
  'bottom-start',
  'bottom-center',
  'bottom-end',
] as const;

/** The chrome over a canvas: the stage's regions, and the viewer's title and actions. */
export type ChromeRegion = StageRegion | 'title' | 'actions';

/** The chrome elements, by the region a slotted one replaces. */
const CHROME_TAGS: Readonly<Record<string, ChromeRegion>> = {
  'kgdiff-view-dock': 'dock',
  'kgdiff-transport': 'transport',
  'kgdiff-legend': 'legend',
  'kgdiff-zoom': 'zoom',
  'kgdiff-minimap': 'minimap',
  'kgdiff-title': 'title',
  'kgdiff-actions': 'actions',
};

type ChromeStates = Pick<PanelStates, StageRegion>;

export class Stage {
  readonly el: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly minimapHost: HTMLElement;
  #view: StageView | null = null;
  /** Removes the stage's own minimap from the view; null while it has none. */
  #ownMinimap: (() => void) | null = null;

  /** The view drawing this stage's canvas (its camera, minimap, framing), once attached. */
  get view(): StageView | null {
    return this.#view;
  }

  set view(view: StageView | null) {
    if (view === this.#view) return;
    this.#ownMinimap?.();
    this.#ownMinimap = null;
    this.#view = view;
    this.#syncMinimap();
  }

  /**
   * The view draws the stage's own minimap unless a slotted `<kgdiff-minimap>` replaces it:
   * none is created, or drawn, while one is, and it comes back when that one leaves.
   */
  #syncMinimap(): void {
    const view = this.#view;
    const own = view !== null && !this.#replaced.has('minimap');
    if (own && !this.#ownMinimap) this.#ownMinimap = view.addMinimap(this.minimapHost);
    else if (!own && this.#ownMinimap) {
      this.#ownMinimap();
      this.#ownMinimap = null;
    }
  }
  readonly #chrome: HTMLElement;
  readonly #liveCanvasLabel: HTMLElement;
  // Replay
  readonly #caption: HTMLElement;
  readonly transport: Transport;
  // Swipe
  readonly #swipe: HTMLElement;
  readonly #divider: HTMLElement;
  readonly #chipBefore: HTMLElement;
  readonly #chipAfter: HTMLElement;
  // Dock
  readonly dock: Dock;
  readonly #dockWrap: HTMLElement;
  // Chrome
  readonly legend: Legend;
  readonly zoom: ZoomBar;
  readonly #mapCluster: HTMLElement;
  readonly tooltip: HTMLElement;
  readonly #state: HTMLElement;
  #pointer: { x: number; y: number } | null = null;
  #dragging: number | null = null;
  #stateKey = '';
  readonly #slots: HTMLSlotElement[] = [];
  /** Elements over the canvas that registered themselves (`registerObstacle`). */
  readonly #obstacles = new Set<Element>();
  #version: StageVersion | null = null;
  readonly #versionChip = h('div', { class: 'version-chip chip card', hidden: true });
  /** The chrome's panel states, and the regions a slotted chrome element replaces. */
  #states: ChromeStates | null = null;
  readonly #replaced = new Set<ChromeRegion>();
  /**
   * Called when the regions slotted elements replace change: the layout that draws the title
   * and the actions (`<kgdiff-viewer>`) applies its panels again.
   */
  onReplaced: (() => void) | null = null;
  /** Whether the stage is a named region (`asRegion`) rather than the main landmark. */
  #region = false;
  /** The legend's state applied last: the user's toggle stands until it changes. */
  #legendState: PanelState | null = null;

  readonly #ctx: UiContext;

  /**
   * `slots`: the stage has named slots for the page's content (stacked with the built-in chrome
   * in its corner).
   */
  constructor(ctx: UiContext, slots = false) {
    this.#ctx = ctx;
    const c = ctx.controller;
    this.canvasHost = h('div', { class: 'stage' });
    this.#liveCanvasLabel = h('div', { class: 'sr-only' });

    // Replay caption + transport
    this.#caption = h('div', {
      class: 'caption card',
      'aria-hidden': 'true',
      'data-empty': 'true',
    });
    this.transport = new Transport(ctx);

    // Swipe
    this.#chipBefore = h('div', { class: 'side-chip before chip card' });
    this.#chipAfter = h('div', { class: 'side-chip after chip card' });
    this.#divider = h(
      'div',
      {
        class: 'divider',
        role: 'slider',
        tabindex: '0',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-orientation': 'horizontal',
      },
      h(
        'span',
        { class: 'handle', 'aria-hidden': 'true' },
        icon('chevron-left'),
        icon('chevron-right'),
      ),
    );
    this.#bindDivider();
    this.#swipe = h(
      'div',
      { class: 'swipe', hidden: true },
      this.#chipBefore,
      this.#chipAfter,
      this.#divider,
    );

    // View dock, with replay's finished pill, caption and transport stacked above it.
    this.dock = new Dock(ctx);
    this.#dockWrap = h(
      'div',
      { class: 'dock' },
      this.transport.finished,
      this.#caption,
      this.transport.el,
      this.dock.el,
    );

    // Legend
    this.legend = new Legend(ctx, (open) => ctx.setPanel?.('legend', open ? 'open' : 'collapsed'));

    // Zoom + minimap: the buttons act on this stage's view.
    this.zoom = new ZoomBar(ctx, () => this.view);
    this.minimapHost = h('div', { class: 'minimap-host' });
    this.#mapCluster = h(
      'div',
      { class: 'map-cluster float bottom-right' },
      this.zoom.el,
      this.minimapHost,
    );

    this.tooltip = h('div', { class: 'tooltip card', role: 'tooltip', 'data-open': 'false' });
    this.#state = h('div', { class: 'state', hidden: true });
    let bottomStart: HTMLElement = this.legend.card;
    let bottomEnd: HTMLElement = this.#mapCluster;
    const corners: HTMLElement[] = [];
    if (slots) {
      const slot = (name: string): HTMLSlotElement => {
        const el = document.createElement('slot');
        el.name = name;
        el.addEventListener('slotchange', () => this.slotted());
        this.#slots.push(el);
        return el;
      };
      // Slotted content sits further from the corner than the built-in chrome.
      corners.push(
        h('div', { class: 'corner top-start' }, this.#versionChip, slot('top-start')),
        h('div', { class: 'corner top-end' }, slot('top-end')),
      );
      bottomStart = h(
        'div',
        { class: 'corner bottom-start' },
        slot('bottom-start'),
        this.legend.card,
      );
      bottomEnd = h('div', { class: 'corner bottom-end' }, slot('bottom-end'), this.#mapCluster);
      this.#dockWrap.prepend(slot('bottom-center'));
    }
    // The top corners first: the chrome reads and tabs from the top down.
    this.#chrome = h(
      'div',
      { class: 'chrome' },
      ...corners,
      this.#swipe,
      bottomStart,
      this.legend.mini,
      bottomEnd,
      this.#dockWrap,
      this.tooltip,
    );
    this.el = h(
      'main',
      { class: 'stage-wrap' },
      this.canvasHost,
      this.#liveCanvasLabel,
      this.#chrome,
      this.#state,
    );
    this.el.addEventListener('pointermove', (e) => {
      const r = this.el.getBoundingClientRect();
      this.#pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.tooltip.dataset.open === 'true') this.#placeTooltip();
    });
    this.el.addEventListener('pointerleave', () => {
      this.#pointer = null;
      c.clearHover();
    });
  }

  /**
   * The canvas size and the floating chrome currently drawn over it (canvas-relative rects),
   * for framing fits and flights around it.
   */
  chromeLayout(): ChromeLayout {
    const r = this.el.getBoundingClientRect();
    const obstacles: Rect[] = [];
    const parts: Element[] = [
      this.legend.card,
      this.legend.mini,
      this.zoom.el,
      this.dock.el,
      this.transport.el,
      this.transport.finished,
      this.#chipBefore,
      this.#chipAfter,
    ];
    if (this.#caption.dataset.empty !== 'true') parts.push(this.#caption);
    parts.push(this.#versionChip);
    if (this.minimapHost.dataset.hidden !== 'true') parts.push(this.minimapHost);
    // The HUD (title, actions) floats over the canvas too.
    for (const el of this.el.querySelectorAll<HTMLElement>('.hud .card')) parts.push(el);
    // The page's content in the slots, and what registered itself: one rule for all.
    for (const slot of this.#slots) parts.push(...slot.assignedElements({ flatten: true }));
    parts.push(...this.#obstacles);
    for (const el of parts) {
      if ((el as HTMLElement).hidden || el.closest('[hidden]')) continue;
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      obstacles.push({ x: b.left - r.left, y: b.top - r.top, width: b.width, height: b.height });
    }
    return { width: r.width, height: r.height, obstacles };
  }

  /**
   * Keep `el` clear of fits and flights, as the chrome is (content over the canvas the stage
   * does not place itself); returns the function that stops it.
   */
  registerObstacle(el: Element): () => void {
    this.#obstacles.add(el);
    return () => {
      this.#obstacles.delete(el);
    };
  }

  /** Re-measure what depends on rendered sizes (fonts, resizes). */
  layout(): void {
    this.dock.layout();
  }

  /**
   * The page's slotted content changed (and once the stage is in its shadow root): a chrome
   * element replaces the built-in one.
   */
  slotted(): void {
    const replaced = new Set<ChromeRegion>();
    for (const slot of this.#slots) {
      for (const el of slot.assignedElements({ flatten: true })) {
        const region = CHROME_TAGS[el.localName];
        if (region) replaced.add(region);
      }
    }
    const same =
      replaced.size === this.#replaced.size && [...replaced].every((r) => this.#replaced.has(r));
    if (!same) {
      this.#replaced.clear();
      for (const r of replaced) this.#replaced.add(r);
      this.#applyPanels();
      this.#syncMinimap();
      this.onReplaced?.();
    }
    this.view?.layoutChanged();
  }

  /** Whether a chrome element slotted into the stage replaces `region`. */
  replaces(region: ChromeRegion): boolean {
    return this.#replaced.has(region);
  }

  /**
   * Follow the panel states of the chrome over the canvas: the dock, the replay transport, the
   * legend (collapsed: folded to its head), the zoom buttons and the minimap. A region that is
   * not open is not shown (and inert); focus inside it moves to the canvas first. A region a
   * slotted chrome element replaces is not shown either, whatever its state.
   */
  setPanels(states: ChromeStates): void {
    this.#states = states;
    this.#applyPanels();
  }

  #applyPanels(): void {
    const given = this.#states;
    const state = (r: StageRegion): PanelState =>
      this.#replaced.has(r) ? 'hidden' : (given?.[r] ?? (r === 'legend' ? 'collapsed' : 'open'));
    // Nothing declared or replaced, ever: the chrome stays as built.
    if (!given && this.#replaced.size === 0 && this.#legendState === null) return;
    const canvas = (): HTMLElement | null => this.canvasHost.querySelector('canvas');
    const set = (s: PanelState, ...els: HTMLElement[]): void => {
      for (const el of els) {
        if (s !== 'open') moveFocusOut(this.#ctx.root, el, canvas);
        attr(el, 'data-panel', s);
        el.inert = s !== 'open';
      }
    };
    set(state('dock'), this.dock.el);
    set(state('transport'), this.transport.el, this.transport.finished);
    set(state('zoom'), this.zoom.el);
    set(state('minimap'), this.minimapHost);
    const legend = state('legend');
    if (legend === 'hidden') moveFocusOut(this.#ctx.root, this.legend.card, canvas);
    attr(this.legend.card, 'data-panel', legend);
    attr(this.legend.mini, 'data-panel', legend);
    this.legend.card.inert = legend === 'hidden';
    if (legend !== 'hidden' && legend !== this.#legendState) this.legend.setOpen(legend === 'open');
    this.#legendState = legend;
  }

  /**
   * The version a stage pinned to it draws (`<kgdiff-stage version>`): no swipe divider or
   * replay caption then, and a chip naming the version; null follows the mode.
   */
  setVersion(version: StageVersion | null): void {
    this.#version = version;
    if (version) this.el.dataset.version = version;
    else delete this.el.dataset.version;
    this.#renderMode();
    this.#renderVersion(this.#ctx.tr());
  }

  #renderVersion(tr: Translator): void {
    const v = this.#version;
    const version = v ? tr.t(v === 'before' ? 'detail.before' : 'detail.after') : '';
    this.#versionChip.hidden = v === null;
    if (v) setText(this.#versionChip, version);
    if (this.#region) {
      attr(this.el, 'aria-label', v ? `${tr.t('stage.label')} · ${version}` : tr.t('stage.label'));
    }
  }

  /**
   * A region named after the graph (and its version), not the page's main landmark: for a
   * `<kgdiff-stage>`, one of several on a page that has its own.
   */
  asRegion(): void {
    this.#region = true;
    this.el.setAttribute('role', 'region');
    this.#renderVersion(this.#ctx.tr());
  }

  /** Legend style, and whether clicks select (the tooltip only hints at clicking then). */
  setChrome(legend: LegendStyle, selectable: boolean): void {
    this.el.dataset.legend = legend;
    this.el.dataset.selectable = String(selectable);
  }

  update(topics: ReadonlySet<Topic>): void {
    const c = this.#ctx.controller;
    const tr = this.#ctx.tr();
    const all = topics.has('status') || topics.has('data') || topics.has('locale');
    if (all) {
      this.#renderVersion(tr);
      this.#renderLabels(tr);
      this.#renderState(tr);
      this.#renderCanvasLabel(tr);
    }
    this.legend.update(topics);
    this.zoom.update(topics);
    this.transport.update(topics);
    this.dock.update(topics);
    if (all || topics.has('mode')) this.#renderMode();
    if (all || topics.has('overview')) {
      attr(this.minimapHost, 'data-hidden', String(this.view?.overview ?? true));
    }
    if (all || topics.has('mode') || topics.has('replay')) this.#renderCaption(tr);
    if (all || topics.has('mode') || topics.has('swipe')) this.#renderSwipe();
    if (all || topics.has('hover') || topics.has('selection') || topics.has('focus')) {
      this.#renderTooltip(tr);
    }
    // Until a diff is ready the built-in chrome waits; the page's slotted content stays.
    attr(this.#chrome, 'data-ready', String(c.status === 'ready'));
  }

  #renderLabels(tr: Translator): void {
    setText(this.#chipBefore, tr.t('detail.before'));
    setText(this.#chipAfter, tr.t('detail.after'));
    attr(this.#divider, 'aria-label', tr.t('swipe.divider'));
    attr(this.minimapHost, 'aria-label', tr.t('minimap.label'));
    attr(this.minimapHost, 'title', tr.t('minimap.label'));
  }

  #renderCanvasLabel(tr: Translator): void {
    const stats = this.#ctx.controller.diff?.stats;
    const canvas = this.canvasHost.querySelector('canvas');
    if (!stats) return;
    const label = tr.t('aria.canvas', {
      nb: stats.before.nodes,
      eb: stats.before.edges,
      na: stats.after.nodes,
      ea: stats.after.edges,
      changes: tr.plural('aria.changes', this.#ctx.controller.hunkCount),
    });
    if (canvas) attr(canvas, 'aria-label', label);
    setText(this.#liveCanvasLabel, '');
  }

  #renderMode(): void {
    const mode = this.#ctx.controller.mode;
    const pinned = this.#version !== null;
    this.#caption.hidden = mode !== 'replay' || pinned;
    this.#swipe.hidden = mode !== 'swipe' || pinned;
  }

  /** The replay caption: the playing hunk (or chapter), else the last one played. */
  #renderCaption(tr: Translator): void {
    const c = this.#ctx.controller;
    const clock = c.clock;
    const scene = c.scene;
    if (c.mode !== 'replay' || !clock || !scene) return;
    const position = clock.position();
    const total = clock.total;
    let key = '';
    let content: (Node | string)[] = [];
    if (clock.t <= 0) {
      // Nothing has played yet: the canvas shows the before version.
    } else if (clock.timeline.mode === 'chapters') {
      const target = clock.activeTarget();
      const ch = target.index >= 0 ? clock.timeline.chapters[target.index] : undefined;
      if (ch) {
        key = `c${target.index}`;
        const first = scene.hunks[ch.hunks[0] ?? -1];
        content = [
          h('span', {
            class: 'glyph-box',
            'data-family': first?.family ?? 'neutral',
            text: first ? sceneHunkGlyph(first) : '·',
          }),
          h('span', { class: 'text', text: tr.t(`phase.${ch.phase}`) }),
          h('span', { class: 'count', text: tr.num(ch.hunks.length) }),
        ];
      }
    } else {
      let hIndex = clock.activeHunk();
      if (hIndex < 0 && position > 0) hIndex = clock.timeline.windows[position - 1]?.hunk ?? -1;
      const hunk = hIndex >= 0 ? scene.hunks[hIndex] : undefined;
      if (hunk) {
        key = `h${hIndex}|${position}`;
        content = [
          h('span', { class: 'glyph-box', 'data-family': hunk.family, text: sceneHunkGlyph(hunk) }),
          h('span', { class: 'text', text: hunk.title, title: hunk.title }),
          h('span', { class: 'count', text: `${position} / ${total}` }),
        ];
      }
    }
    if (this.#caption.dataset.key !== key) {
      this.#caption.dataset.key = key;
      attr(this.#caption, 'data-empty', String(key === ''));
      replace(this.#caption, ...content);
    }
    // The finished pill takes the caption's place above the transport.
    if (this.#version === null) this.#caption.hidden = clock.finished;
  }

  #renderSwipe(): void {
    const c = this.#ctx.controller;
    if (c.mode !== 'swipe') return;
    const pct = c.split * 100;
    this.#divider.style.left = `${pct}%`;
    attr(this.#divider, 'aria-valuenow', String(Math.round(pct)));
    attr(this.#divider, 'aria-valuetext', `${Math.round(pct)}%`);
  }

  #bindDivider(): void {
    const splitAt = (clientX: number): number => {
      const r = this.el.getBoundingClientRect();
      return r.width > 0 ? (clientX - r.left) / r.width : 0.5;
    };
    this.#divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.#dragging = e.pointerId;
      this.#divider.setPointerCapture?.(e.pointerId);
      this.#divider.classList.add('dragging');
      this.#divider.focus({ preventScroll: true });
    });
    this.#divider.addEventListener('pointermove', (e) => {
      if (this.#dragging === e.pointerId) this.#ctx.controller.setSplit(splitAt(e.clientX));
    });
    const end = (e: PointerEvent): void => {
      if (this.#dragging !== e.pointerId) return;
      this.#dragging = null;
      this.#divider.classList.remove('dragging');
    };
    this.#divider.addEventListener('pointerup', end);
    this.#divider.addEventListener('pointercancel', end);
    this.#divider.addEventListener('dblclick', () => this.#ctx.controller.setSplit(0.5));
    this.#divider.addEventListener('keydown', (e) => {
      const c = this.#ctx.controller;
      const to: Record<string, number> = {
        Home: 0,
        End: 1,
        PageUp: c.split - 0.1,
        PageDown: c.split + 0.1,
      };
      const next = to[e.key];
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      c.setSplit(next);
    });
  }

  // ─── Tooltip ─────────────────────────────────────────────────────────────

  #renderTooltip(tr: Translator): void {
    const c = this.#ctx.controller;
    const scene = c.scene;
    const diff = c.diff;
    if (!scene || !diff || this.#dragging !== null) {
      attr(this.tooltip, 'data-open', 'false');
      return;
    }
    const parts: (Node | null)[] = [];
    let family: Family = 'neutral';
    if (c.hoverNode >= 0) {
      const sn = scene.nodes[c.hoverNode];
      const un = sn ? diff.index.node(sn.id) : undefined;
      if (!sn || !un) return;
      family = sn.family;
      const hunk = sn.hunk >= 0 ? scene.hunks[sn.hunk] : undefined;
      const rekey = un.facets.find((f) => f.kind === 'rekey');
      const degree = Math.max(un.degree.before, un.degree.after);
      parts.push(
        h('div', { class: 't-label', text: sn.label }),
        sn.labelBefore ? h('div', { class: 't-old', text: sn.labelBefore }) : null,
        h('div', {
          class: 't-id',
          text: rekey && rekey.kind === 'rekey' ? `${rekey.from} → ${rekey.to}` : sn.id,
        }),
        h(
          'div',
          { class: 't-status', 'data-family': family },
          h('span', { class: 'dot' }),
          sn.status === 'unchanged'
            ? tr.t('status.unchanged')
            : `${tr.t(`status.${sn.status}`)} · ${tr.t(`family.${family}`)}`,
        ),
        h('div', {
          class: 't-sum',
          text: hunk ? hunk.title : tr.plural('tooltip.relations', degree),
        }),
        h('div', { class: 't-hint', text: tr.t('tooltip.select') }),
      );
    } else if (c.hoverEdge >= 0) {
      const se = scene.edges[c.hoverEdge];
      if (!se) return;
      family = se.family;
      const s = scene.nodes[se.s]?.label ?? '';
      const t = scene.nodes[se.t]?.label ?? '';
      const hunk = se.hunk >= 0 ? scene.hunks[se.hunk] : undefined;
      parts.push(
        h('div', { class: 't-label', text: `${s} —${se.label}→ ${t}` }),
        se.labelBefore ? h('div', { class: 't-old', text: se.labelBefore }) : null,
        h(
          'div',
          { class: 't-status', 'data-family': family },
          h('span', { class: 'dot' }),
          tr.t(`status.${se.status}`),
        ),
        hunk ? h('div', { class: 't-sum', text: hunk.title }) : null,
      );
    } else if (c.hoverGroup >= 0) {
      const g = c.focus?.collapsed[c.hoverGroup];
      if (!g) return;
      parts.push(
        h('div', { class: 't-label', text: g.label }),
        h('div', {
          class: 't-hint',
          text: tr.t(c.canExpand(c.hoverGroup) ? 'focus.expand' : 'focus.expandUnavailable'),
        }),
      );
    }
    if (parts.length === 0) {
      attr(this.tooltip, 'data-open', 'false');
      return;
    }
    replace(this.tooltip, ...parts);
    attr(this.tooltip, 'data-open', 'true');
    this.#placeTooltip();
  }

  #placeTooltip(): void {
    const p = this.#pointer;
    if (!p) {
      attr(this.tooltip, 'data-open', 'false');
      return;
    }
    const w = this.tooltip.offsetWidth;
    const hgt = this.tooltip.offsetHeight;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    let x = p.x + 16;
    let y = p.y + 18;
    if (x + w > W - 8) x = Math.max(8, p.x - w - 12);
    if (y + hgt > H - 8) y = Math.max(8, p.y - hgt - 12);
    this.tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ─── States ──────────────────────────────────────────────────────────────

  #renderState(tr: Translator): void {
    const c = this.#ctx.controller;
    const stats = c.diff?.stats;
    let key: string = c.status;
    if (c.status === 'loading') key += `|${c.step}|${c.steps.join(',')}`;
    if (c.status === 'ready') key += stats?.identical ? '|identical' : '';
    key += `|${tr.locale}`;
    if (c.status === 'error') key += `|${c.error?.message}`;
    if (key === this.#stateKey) return;
    this.#stateKey = key;
    this.#state.classList.remove('blocking');
    if (c.status === 'ready' && !stats?.identical) {
      this.#state.hidden = true;
      replace(this.#state);
      return;
    }
    this.#state.hidden = false;
    if (c.status === 'loading') {
      this.#state.classList.add('blocking');
      const current = c.step ? c.steps.indexOf(c.step) : -1;
      replace(
        this.#state,
        h('div', { class: 'skeleton-grid', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'state-card card', role: 'status', 'aria-live': 'polite' },
          h('h2', { text: tr.t('state.loading') }),
          h(
            'ol',
            { class: 'steps' },
            c.steps.map((s, i) =>
              h(
                'li',
                { 'data-state': i < current ? 'done' : i === current ? 'active' : 'pending' },
                h(
                  'span',
                  { class: 'mark', 'aria-hidden': 'true' },
                  i < current ? icon('check') : null,
                ),
                h('span', { text: `${tr.t(`step.${s}`)}${i === current ? '…' : ''}` }),
              ),
            ),
          ),
        ),
      );
    } else if (c.status === 'error') {
      this.#state.classList.add('blocking');
      const err = c.error;
      const code = err instanceof KgdiffError ? err.code : err?.name;
      const details = [code ? `[${code}]` : '', err?.message ?? '', err?.stack ?? '']
        .filter(Boolean)
        .join('\n');
      replace(
        this.#state,
        h(
          'div',
          { class: 'state-card card error', role: 'alert' },
          h('div', { class: 'state-icon' }, icon('alert')),
          h('h2', { text: tr.t('state.error.title') }),
          h('p', { text: err?.message ?? '' }),
          h(
            'details',
            null,
            h('summary', { text: tr.t('state.error.details') }),
            h('pre', { text: details }),
          ),
        ),
      );
    } else if (c.status === 'ready' && stats?.identical) {
      replace(
        this.#state,
        h(
          'div',
          { class: 'state-card card ok', role: 'status' },
          h('div', { class: 'state-icon' }, icon('check-circle')),
          h('h2', { text: tr.t('state.identical.title') }),
          h('p', {
            text: tr.t('state.identical.body', {
              nodes: tr.plural('count.nodes', stats.after.nodes),
              edges: tr.plural('count.edges', stats.after.edges),
            }),
          }),
        ),
      );
    } else {
      this.#state.classList.add('blocking');
      replace(
        this.#state,
        h(
          'div',
          { class: 'state-card' },
          h('div', { class: 'state-icon' }, icon('overlay')),
          h('h2', { text: tr.t('state.empty.title') }),
          h('p', { text: tr.t('state.empty.body') }),
        ),
      );
    }
  }
}
