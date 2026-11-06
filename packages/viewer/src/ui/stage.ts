/**
 * The canvas area and its floating chrome: the view dock (with replay's caption and transport
 * stacked above it), swipe divider, legend (a card, or one line of dots for chrome-less embeds),
 * zoom controls + minimap (shown only while part of the content is out of view), hover tooltip
 * and the loading / identical / error / empty states. Overlays never cover the current hunk:
 * fits and flights frame it in the free part of the canvas.
 */
import { KgdiffError, type Rect } from '@kgdiff/core';
import type { ChangeFamily, Family } from '@kgdiff/scene';
import type { Topic } from '../controller.js';
import {
  attr,
  h,
  icon,
  iconButton,
  moveFocusOut,
  relabel,
  replace,
  replaceKeepingFocus,
  setText,
} from '../dom.js';
import type { ChromeLayout } from '../framing.js';
import type { Translator } from '../i18n.js';
import type { PanelState, PanelStates } from '../index.js';
import { FAMILIES } from '../styles.js';
import { sceneHunkGlyph, type UiContext } from './context.js';
import { Dock } from './dock.js';
import { swatch } from './swatch.js';

const TICK_W = 1000;

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

export class Stage {
  readonly el: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly minimapHost: HTMLElement;
  readonly #chrome: HTMLElement;
  readonly #liveCanvasLabel: HTMLElement;
  // Replay
  readonly #caption: HTMLElement;
  readonly #transport: HTMLElement;
  readonly #playButton: HTMLButtonElement;
  readonly #prevButton: HTMLButtonElement;
  readonly #nextButton: HTMLButtonElement;
  readonly #scrubber: HTMLElement;
  readonly #fill: HTMLElement;
  readonly #knob: HTMLElement;
  readonly #ticks: SVGSVGElement;
  readonly #scrubTip: HTMLElement;
  readonly #pos: HTMLElement;
  readonly #speed: HTMLButtonElement;
  readonly #finished: HTMLElement;
  // Swipe
  readonly #swipe: HTMLElement;
  readonly #divider: HTMLElement;
  readonly #chipBefore: HTMLElement;
  readonly #chipAfter: HTMLElement;
  // Dock
  readonly dock: Dock;
  readonly #dockWrap: HTMLElement;
  // Chrome
  readonly #legend: HTMLElement;
  readonly #legendHead: HTMLButtonElement;
  readonly #legendBody: HTMLElement;
  readonly #miniLegend: HTMLElement;
  readonly #zoomIn: HTMLButtonElement;
  readonly #zoomOut: HTMLButtonElement;
  readonly #fitButton: HTMLButtonElement;
  readonly #mapCluster: HTMLElement;
  readonly #zoomBar: HTMLElement;
  readonly tooltip: HTMLElement;
  readonly #state: HTMLElement;
  #pointer: { x: number; y: number } | null = null;
  #scrubbing: number | null = null;
  #dragging: number | null = null;
  #legendOpen = false;
  #stateKey = '';
  readonly #slots: HTMLSlotElement[] = [];
  /** Elements over the canvas that registered themselves (`registerObstacle`). */
  readonly #obstacles = new Set<Element>();

  readonly #ctx: UiContext;

  /**
   * `slots`: the stage is `<kgdiff-stage>`, with named slots for the page's content (stacked
   * with the built-in chrome in its corner). The default layout's stage has none.
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
    this.#prevButton = iconButton('skip-back', '', () => c.stepReplay(-1), { class: 'icon-btn' });
    this.#playButton = iconButton('play', '', () => c.togglePlay(), { class: 'icon-btn play' });
    this.#nextButton = iconButton('skip-forward', '', () => c.stepReplay(1), { class: 'icon-btn' });
    this.#fill = h('div', { class: 'fill' });
    this.#knob = h('div', { class: 'knob' });
    this.#ticks = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.#ticks.setAttribute('class', 'ticks');
    this.#ticks.setAttribute('viewBox', `0 0 ${TICK_W} 14`);
    this.#ticks.setAttribute('preserveAspectRatio', 'none');
    this.#ticks.setAttribute('aria-hidden', 'true');
    this.#scrubTip = h('div', { class: 'scrub-tip card', hidden: true });
    this.#scrubber = h(
      'div',
      {
        class: 'scrubber',
        role: 'slider',
        tabindex: '0',
        'aria-valuemin': '0',
      },
      h('div', { class: 'track' }, this.#fill),
      this.#ticks,
      this.#knob,
      this.#scrubTip,
    );
    this.#bindScrubber();
    this.#pos = h('span', { class: 'pos', 'aria-hidden': 'true' });
    this.#speed = h('button', {
      type: 'button',
      class: 'speed',
      onclick: () => c.cycleSpeed(),
    });
    this.#transport = h(
      'div',
      { class: 'transport card', role: 'toolbar' },
      this.#prevButton,
      this.#playButton,
      this.#nextButton,
      this.#scrubber,
      this.#pos,
      this.#speed,
    );
    this.#finished = h('div', { class: 'finished card', role: 'status', hidden: true });

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
      this.#finished,
      this.#caption,
      this.#transport,
      this.dock.el,
    );

    // Legend
    this.#legendHead = h(
      'button',
      {
        type: 'button',
        class: 'legend-head',
        'aria-expanded': 'false',
        onclick: () => {
          this.#setLegend(!this.#legendOpen);
          ctx.setPanel?.('legend', this.#legendOpen ? 'open' : 'collapsed');
        },
      },
      h('span', { class: 'lbl' }),
      icon('chevron-down'),
    );
    this.#legendBody = h('div', { class: 'legend-body', id: 'kg-legend' });
    attr(this.#legendHead, 'aria-controls', 'kg-legend');
    this.#legend = h(
      'div',
      { class: 'legend card float bottom-left', 'data-open': 'false' },
      this.#legendHead,
      this.#legendBody,
    );
    this.#miniLegend = h('div', { class: 'mini-legend float bottom-left', role: 'list' });

    // Zoom + minimap
    this.#zoomIn = iconButton('plus', '', () => c.zoom(1));
    this.#zoomOut = iconButton('minus', '', () => c.zoom(-1));
    this.#fitButton = iconButton('fit', '', () => void c.fit());
    this.minimapHost = h('div', { class: 'minimap-host' });
    this.#zoomBar = h(
      'div',
      { class: 'zoom-bar card', role: 'toolbar' },
      this.#zoomIn,
      this.#zoomOut,
      this.#fitButton,
    );
    this.#mapCluster = h(
      'div',
      { class: 'map-cluster float bottom-right' },
      this.#zoomBar,
      this.minimapHost,
    );

    this.tooltip = h('div', { class: 'tooltip card', role: 'tooltip', 'data-open': 'false' });
    this.#state = h('div', { class: 'state', hidden: true });
    let bottomStart: HTMLElement = this.#legend;
    let bottomEnd: HTMLElement = this.#mapCluster;
    const corners: HTMLElement[] = [];
    if (slots) {
      const slot = (name: string): HTMLSlotElement => {
        const el = document.createElement('slot');
        el.name = name;
        el.addEventListener('slotchange', () => c.layoutChanged());
        this.#slots.push(el);
        return el;
      };
      // Slotted content sits further from the corner than the built-in chrome.
      corners.push(
        h('div', { class: 'corner top-start' }, slot('top-start')),
        h('div', { class: 'corner top-end' }, slot('top-end')),
      );
      bottomStart = h('div', { class: 'corner bottom-start' }, slot('bottom-start'), this.#legend);
      bottomEnd = h('div', { class: 'corner bottom-end' }, slot('bottom-end'), this.#mapCluster);
      this.#dockWrap.prepend(slot('bottom-center'));
    }
    this.#chrome = h(
      'div',
      { class: 'chrome' },
      this.#swipe,
      bottomStart,
      this.#miniLegend,
      bottomEnd,
      this.#dockWrap,
      ...corners,
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
      this.#legend,
      this.#miniLegend,
      this.#zoomBar,
      this.dock.el,
      this.#transport,
      this.#finished,
      this.#chipBefore,
      this.#chipAfter,
    ];
    if (this.#caption.dataset.empty !== 'true') parts.push(this.#caption);
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
   * Follow the panel states of the chrome over the canvas: the dock, the replay transport, the
   * legend (collapsed: folded to its head), the zoom buttons and the minimap. A region that is
   * not open is not shown (and inert); focus inside it moves to the canvas first.
   */
  setPanels(states: Pick<PanelStates, 'dock' | 'transport' | 'legend' | 'zoom' | 'minimap'>): void {
    const canvas = (): HTMLElement | null => this.canvasHost.querySelector('canvas');
    const set = (state: PanelState, ...els: HTMLElement[]): void => {
      for (const el of els) {
        if (state !== 'open') moveFocusOut(this.#ctx.root, el, canvas);
        attr(el, 'data-panel', state);
        el.inert = state !== 'open';
      }
    };
    set(states.dock, this.dock.el);
    set(states.transport, this.#transport, this.#finished);
    set(states.zoom, this.#zoomBar);
    set(states.minimap, this.minimapHost);
    const legend = states.legend;
    if (legend === 'hidden') moveFocusOut(this.#ctx.root, this.#legend, canvas);
    attr(this.#legend, 'data-panel', legend);
    attr(this.#miniLegend, 'data-panel', legend);
    this.#legend.inert = legend === 'hidden';
    if (legend !== 'hidden') this.#setLegend(legend === 'open');
  }

  #setLegend(open: boolean): void {
    this.#legendOpen = open;
    attr(this.#legend, 'data-open', String(open));
    attr(this.#legendHead, 'aria-expanded', String(open));
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
      this.#renderLabels(tr);
      this.#renderMiniLegend(tr);
      this.#renderState(tr);
      this.#renderTicks();
      this.#renderCanvasLabel(tr);
    }
    this.dock.update(topics);
    if (all || topics.has('mode')) this.#renderMode();
    if (all || topics.has('overview')) {
      attr(this.minimapHost, 'data-hidden', String(c.overview));
    }
    if (all || topics.has('mode') || topics.has('replay')) this.#renderReplay(tr);
    if (all || topics.has('mode') || topics.has('swipe')) this.#renderSwipe();
    if (all || topics.has('hover') || topics.has('selection') || topics.has('focus')) {
      this.#renderTooltip(tr);
    }
    if (topics.has('theme')) this.#renderTicks();
    // Until a diff is ready the built-in chrome waits; the page's slotted content stays.
    attr(this.#chrome, 'data-ready', String(c.status === 'ready'));
  }

  #renderLabels(tr: Translator): void {
    relabel(this.#prevButton, `${tr.t('detail.prev')} (←)`);
    relabel(this.#nextButton, `${tr.t('detail.next')} (→)`);
    attr(this.#transport, 'aria-label', tr.t('replay.label'));
    attr(this.#scrubber, 'aria-label', tr.t('replay.scrubber'));
    setText(this.#chipBefore, tr.t('detail.before'));
    setText(this.#chipAfter, tr.t('detail.after'));
    attr(this.#divider, 'aria-label', tr.t('swipe.divider'));
    setText(this.#legendHead.querySelector('.lbl') as Element, tr.t('legend.title'));
    attr(this.#legendHead, 'aria-label', tr.t('legend.toggle'));
    relabel(this.#zoomIn, `${tr.t('action.zoomIn')} (+)`);
    relabel(this.#zoomOut, `${tr.t('action.zoomOut')} (−)`);
    relabel(this.#fitButton, `${tr.t('action.fit')} (F)`);
    attr(this.minimapHost, 'aria-label', tr.t('minimap.label'));
    attr(this.minimapHost, 'title', tr.t('minimap.label'));
    const fams: Family[] = [...FAMILIES, 'neutral'];
    replace(
      this.#legendBody,
      fams.map((f) =>
        h(
          'div',
          { class: 'legend-row', 'data-family': f, title: tr.t(`familyHint.${f}`) },
          swatch(f),
          h('span', { class: 'name', text: tr.t(`family.${f}`) }),
        ),
      ),
    );
  }

  /** One line: the families this diff has, then the unchanged context. */
  #renderMiniLegend(tr: Translator): void {
    const scene = this.#ctx.controller.scene;
    const present = new Set<Family>(scene?.hunks.map((x) => x.family));
    if (scene?.nodes.some((n) => n.status === 'unchanged')) present.add('neutral');
    attr(this.#miniLegend, 'aria-label', tr.t('legend.title'));
    replace(
      this.#miniLegend,
      [...FAMILIES, 'neutral' as const]
        .filter((f) => present.has(f))
        .map((f) =>
          h(
            'span',
            {
              class: 'mini-item',
              role: 'listitem',
              'data-family': f,
              title: tr.t(`familyHint.${f}`),
            },
            h('span', { class: 'dot', 'aria-hidden': 'true' }),
            tr.t(`family.${f}`),
          ),
        ),
    );
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
    this.#transport.hidden = mode !== 'replay';
    this.#caption.hidden = mode !== 'replay';
    this.#swipe.hidden = mode !== 'swipe';
  }

  #renderReplay(tr: Translator): void {
    const c = this.#ctx.controller;
    const clock = c.clock;
    const scene = c.scene;
    if (c.mode !== 'replay' || !clock || !scene) {
      this.#finished.hidden = true;
      return;
    }
    const p = clock.progress;
    this.#fill.style.transform = `scaleX(${p})`;
    this.#knob.style.left = `${p * 100}%`;
    const position = clock.position();
    const total = clock.total;
    setText(this.#pos, tr.t('replay.position', { i: position, n: total }));
    attr(this.#scrubber, 'aria-valuemax', String(Math.round(clock.duration)));
    attr(this.#scrubber, 'aria-valuenow', String(Math.round(clock.t)));
    attr(this.#scrubber, 'aria-valuetext', tr.t('replay.position', { i: position, n: total }));
    const playing = clock.playing;
    const playLabel = `${tr.t(playing ? 'replay.pause' : 'replay.play')} (Space)`;
    if (this.#playButton.dataset.state !== String(playing)) {
      this.#playButton.dataset.state = String(playing);
      replace(this.#playButton, icon(playing ? 'pause' : 'play'));
    }
    relabel(this.#playButton, playLabel);
    setText(this.#speed, `${clock.speed}×`);
    relabel(this.#speed, tr.t('replay.speed', { s: `${clock.speed}×` }));
    this.#prevButton.disabled = clock.t <= 0;
    this.#nextButton.disabled = clock.t >= clock.duration;

    // Caption: the playing hunk (or chapter), else the last one played.
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
    const finished = clock.finished;
    this.#finished.hidden = !finished;
    // The finished pill takes the caption's place above the transport.
    this.#caption.hidden = finished;
    if (finished && this.#finished.childElementCount === 0) {
      replace(
        this.#finished,
        icon('check-circle'),
        h('span', { text: tr.t('replay.finished') }),
        h(
          'button',
          { type: 'button', class: 'btn', onclick: () => c.restart() },
          icon('restart'),
          tr.t('replay.restart'),
        ),
      );
    } else if (!finished && this.#finished.childElementCount > 0) {
      // Restart was pressed from the pill: keep focus in the transport.
      replaceKeepingFocus(this.#ctx.root, this.#finished, this.#playButton);
    }
  }

  #renderTicks(): void {
    const c = this.#ctx.controller;
    const clock = c.clock;
    const scene = c.scene;
    while (this.#ticks.firstChild) this.#ticks.removeChild(this.#ticks.firstChild);
    if (!clock || !scene || clock.duration <= 0) return;
    const paths = new Map<ChangeFamily, string[]>();
    for (const w of clock.timeline.windows) {
      const fam = scene.hunks[w.hunk]?.family;
      if (!fam) continue;
      const x = ((w.start / clock.duration) * TICK_W).toFixed(1);
      let list = paths.get(fam);
      if (!list) {
        list = [];
        paths.set(fam, list);
      }
      list.push(`M${x} 2V12`);
    }
    for (const [fam, d] of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d.join(''));
      p.setAttribute('stroke', `var(--kgdiff-${fam})`);
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      this.#ticks.appendChild(p);
    }
  }

  #bindScrubber(): void {
    const timeAt = (clientX: number): number => {
      const clock = this.#ctx.controller.clock;
      const r = this.#scrubber.getBoundingClientRect();
      if (!clock || r.width <= 0) return 0;
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * clock.duration;
    };
    this.#scrubber.addEventListener('pointerdown', (e) => {
      this.#scrubbing = e.pointerId;
      this.#scrubber.setPointerCapture?.(e.pointerId);
      this.#ctx.controller.pause();
      this.#ctx.controller.seek(timeAt(e.clientX));
    });
    this.#scrubber.addEventListener('pointermove', (e) => {
      if (this.#scrubbing === e.pointerId) this.#ctx.controller.seek(timeAt(e.clientX));
      this.#showScrubTip(e.clientX, timeAt(e.clientX));
    });
    const end = (e: PointerEvent): void => {
      if (this.#scrubbing === e.pointerId) this.#scrubbing = null;
    };
    this.#scrubber.addEventListener('pointerup', end);
    this.#scrubber.addEventListener('pointercancel', end);
    this.#scrubber.addEventListener('pointerleave', () => {
      this.#scrubTip.hidden = true;
    });
    this.#scrubber.addEventListener('keydown', (e) => {
      const c = this.#ctx.controller;
      if (e.key === 'Home') c.seek(0);
      else if (e.key === 'End') c.seek(c.clock?.duration ?? 0);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  #showScrubTip(clientX: number, t: number): void {
    const c = this.#ctx.controller;
    const clock = c.clock;
    const scene = c.scene;
    if (!clock || !scene) return;
    // Nearest window start: the tick under the pointer.
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (const w of clock.timeline.windows) {
      const d = Math.abs(w.start - t);
      if (d < bestD) {
        bestD = d;
        best = w.hunk;
      }
    }
    const hunk = scene.hunks[best];
    if (!hunk) {
      this.#scrubTip.hidden = true;
      return;
    }
    const r = this.#scrubber.getBoundingClientRect();
    this.#scrubTip.hidden = false;
    this.#scrubTip.style.left = `${clientX - r.left}px`;
    if (this.#scrubTip.dataset.hunk !== hunk.id) {
      this.#scrubTip.dataset.hunk = hunk.id;
      replace(
        this.#scrubTip,
        h('span', { class: 'glyph-box', 'data-family': hunk.family, text: sceneHunkGlyph(hunk) }),
        h('span', { text: hunk.title }),
      );
    }
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
