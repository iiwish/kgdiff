/**
 * The default layout's sidebar (RFC 0001 §4): the change list with the search and the family
 * filters in its head, the search results in the list's place, and the detail panel below.
 * Below 760 px it is a resizable bottom sheet. The regions in it are bound to the root on their
 * own; the sidebar places them and follows their panel states: a collapsed region folds to the
 * control that opens it again (the list to its title, the detail panel to its bar, the search
 * and the filters to a button), and the sidebar folds away when all four are collapsed. It has
 * a draggable width, and a draggable split between the list and the detail panel; both
 * separators also move with the arrow keys.
 */
import { attr, h, icon, iconButton, moveFocusOut, relabel } from '../dom.js';
import type { PanelRegion, PanelState, PanelStates } from '../index.js';
import { SIDEBAR_REGIONS } from '../panels.js';
import type { Topic } from '../session.js';
import type { ChangeList } from './change-list.js';
import type { UiContext } from './context.js';
import type { Detail } from './detail.js';
import type { Filters } from './filters.js';
import type { Search } from './search.js';

export { HEADER_SLOT, ROW_SLOT } from './change-list.js';

/** The sidebar's default width and the range it can be dragged in, px. */
export const SIDEBAR_WIDTH = 360;
export const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 720;
/** The canvas keeps at least this much width next to the sidebar, px. */
const STAGE_MIN = 320;
/** Keyboard steps of the width (px) and of the split (share of the height). */
const WIDTH_STEP = 16;
const WIDTH_STEP_LARGE = 64;
const SPLIT_STEP = 0.05;
/** The change list keeps this much height, the detail panel this much, px. */
const LIST_MIN = 96;
const DETAIL_MIN = 64;

/** What the sidebar asks of the layout that owns it. */
export interface SidebarHost {
  /** The user opened or folded one of the sidebar's regions. */
  setPanel(region: PanelRegion, state: PanelState): void;
  /** The user resized the sidebar or moved the split; `done`: the drag (or key press) ended. */
  resized(width: number, detailShare: number | null, done: boolean): void;
  /** Where focus goes when the whole sidebar folds while it has focus. */
  focusOutside(): HTMLElement | null;
}

export class Sidebar {
  readonly el: HTMLElement;
  readonly #inner: HTMLElement;
  readonly #handle: HTMLElement;
  readonly #resize: HTMLElement;
  readonly #split: HTMLElement;
  readonly #head: HTMLElement;
  readonly #listHead: HTMLElement;
  readonly #listWrap: HTMLElement;
  readonly #listToggle: HTMLButtonElement;
  readonly #searchWrap: HTMLElement;
  readonly #searchButton: HTMLButtonElement;
  readonly #filtersWrap: HTMLElement;
  readonly #filtersButton: HTMLButtonElement;
  readonly #detailWrap: HTMLElement;
  readonly #detailBar: HTMLButtonElement;
  readonly #detail: Detail;
  readonly #ctx: UiContext;
  readonly #host: SidebarHost;
  #states: PanelStates | null = null;
  #width = SIDEBAR_WIDTH;
  #share: number | null = null;

  constructor(
    ctx: UiContext,
    host: SidebarHost,
    list: ChangeList,
    search: Search,
    filters: Filters,
    detail: Detail,
  ) {
    this.#ctx = ctx;
    this.#host = host;
    this.#detail = detail;
    this.#handle = h('div', {
      class: 'sheet-handle',
      role: 'separator',
      'aria-orientation': 'horizontal',
      tabindex: '0',
    });
    this.#bindSheet();
    const toggle = (region: PanelRegion) => () => {
      const open = this.#states?.[region] === 'open';
      host.setPanel(region, open ? 'collapsed' : 'open');
    };
    this.#listToggle = iconButton('chevron-up', '', toggle('list'), {
      class: 'icon-btn sm list-toggle',
      'aria-expanded': 'true',
      'aria-controls': 'kg-list-wrap',
    });
    this.#searchButton = iconButton('search', '', () => host.setPanel('search', 'open'), {
      class: 'icon-btn sm',
      hidden: true,
    });
    this.#filtersButton = iconButton('filter', '', () => host.setPanel('filters', 'open'), {
      class: 'icon-btn sm filters-btn',
      hidden: true,
    });
    this.#listHead = list.head;
    this.#head = h(
      'div',
      { class: 'sb-row' },
      list.head,
      this.#searchButton,
      this.#filtersButton,
      this.#listToggle,
    );
    this.#searchWrap = h('div', { class: 'search-wrap' }, search.box);
    this.#filtersWrap = h('div', { class: 'filters-wrap', id: 'kg-filters' }, filters.el);
    this.#listWrap = h(
      'div',
      { class: 'list-wrap', id: 'kg-list-wrap' },
      list.sticky,
      list.list,
      search.results,
      list.phases,
    );
    this.#split = h('div', {
      class: 'sb-split',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      tabindex: '0',
    });
    this.#detailBar = h(
      'button',
      {
        type: 'button',
        class: 'detail-bar',
        'aria-expanded': 'true',
        'aria-controls': 'kg-detail',
        onclick: toggle('detail'),
      },
      h('span', { class: 'lbl' }),
      icon('chevron-down'),
    );
    attr(detail.el, 'id', 'kg-detail');
    this.#detailWrap = h('div', { class: 'detail-wrap' }, this.#detailBar, detail.el);
    this.#inner = h(
      'div',
      { class: 'sidebar-inner' },
      this.#handle,
      h('div', { class: 'sb-head' }, this.#head, this.#searchWrap, this.#filtersWrap),
      this.#listWrap,
      this.#split,
      this.#detailWrap,
    );
    this.#resize = h('div', {
      class: 'sb-resize',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuemin': String(SIDEBAR_MIN),
      tabindex: '0',
    });
    this.el = h('aside', { class: 'sidebar', 'data-open': 'true' }, this.#resize, this.#inner);
    this.#bindResize();
    this.#bindSplit();
  }

  get width(): number {
    return this.#width;
  }

  get detailShare(): number | null {
    return this.#share;
  }

  /** Follow the panel states of the four regions (the sidebar folds when none is open). */
  setPanels(states: PanelStates): void {
    this.#states = states;
    const shown = SIDEBAR_REGIONS.filter((r) => states[r] !== 'hidden');
    const open = shown.some((r) => states[r] === 'open');
    const root = this.#ctx.root;
    if (!open) moveFocusOut(root, this.el, () => this.#host.focusOutside());
    const fold = (el: HTMLElement, state: PanelState, to: () => HTMLElement | null): void => {
      if (state !== 'open') moveFocusOut(root, el, to);
      el.hidden = state !== 'open';
      el.inert = state !== 'open';
    };
    fold(this.#searchWrap, states.search, () => this.#searchButton);
    fold(this.#filtersWrap, states.filters, () => this.#filtersButton);
    this.#searchButton.hidden = states.search !== 'collapsed';
    this.#filtersButton.hidden = states.filters !== 'collapsed';
    this.#listHead.hidden = states.list === 'hidden';
    this.#listToggle.hidden = states.list === 'hidden';
    attr(this.#listToggle, 'aria-expanded', String(states.list === 'open'));
    attr(this.#detailWrap, 'data-state', states.detail);
    this.#detailWrap.hidden = states.detail === 'hidden';
    if (states.detail !== 'open') moveFocusOut(root, this.#detail.el, () => this.#detailBar);
    this.#detail.el.inert = states.detail !== 'open';
    attr(this.#detailBar, 'aria-expanded', String(states.detail === 'open'));
    this.#placeList(this.#ctx.controller.query.trim() !== '');
    this.el.hidden = shown.length === 0;
    attr(this.el, 'data-open', String(open));
    this.el.inert = !open;
    this.#relabel();
  }

  /** Apply sizes (remembered, or after a drag); the width is clamped when the layout is known. */
  setSizes(width: number, detailShare: number | null): void {
    this.#width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)));
    this.#share = detailShare === null ? null : Math.max(0, Math.min(1, detailShare));
    this.el.style.setProperty('--sidebar-w', `${this.#width}px`);
    if (this.#share === null) {
      this.el.removeAttribute('data-split');
      this.el.style.removeProperty('--detail-share');
    } else {
      attr(this.el, 'data-split', 'true');
      this.el.style.setProperty('--detail-share', String(this.#share));
    }
    this.#syncSeparators();
  }

  update(topics: ReadonlySet<Topic>): void {
    if (topics.has('status') || topics.has('data') || topics.has('locale')) this.#relabel();
    if (topics.has('search') || topics.has('status')) {
      this.#placeList(this.#ctx.controller.query.trim() !== '');
    }
    if (topics.has('filters') || topics.has('status')) {
      attr(this.#filtersButton, 'data-active', String(this.#ctx.controller.families.size > 0));
    }
  }

  /**
   * The list's place shows the rows while the list is open and the search results while a
   * search is active, whatever the list's state (the results take its place).
   */
  #placeList(searching: boolean): void {
    const state = this.#states?.list ?? 'open';
    const shown = state === 'open' || searching;
    if (!shown) moveFocusOut(this.#ctx.root, this.#listWrap, () => this.#listToggle);
    this.#listWrap.hidden = !shown;
    this.#listWrap.inert = !shown;
    const detailOpen = (this.#states?.detail ?? 'open') === 'open';
    this.#split.hidden = !(shown && detailOpen);
    attr(this.el, 'data-list', shown ? 'open' : 'folded');
  }

  #relabel(): void {
    const tr = this.#ctx.tr();
    attr(this.el, 'aria-label', tr.t('sidebar.label'));
    attr(this.#handle, 'aria-label', tr.t('sidebar.sheet'));
    attr(this.#resize, 'aria-label', tr.t('sidebar.resize'));
    attr(this.#split, 'aria-label', tr.t('sidebar.split'));
    const listOpen = this.#states?.list !== 'collapsed';
    relabel(this.#listToggle, tr.t(listOpen ? 'sidebar.hideList' : 'sidebar.showList'));
    relabel(this.#searchButton, `${tr.t('sidebar.search')} (/)`);
    relabel(this.#filtersButton, tr.t('sidebar.filters'));
    const bar = this.#detailBar.querySelector('.lbl');
    if (bar) bar.textContent = tr.t('detail.label');
    attr(
      this.#detailBar,
      'title',
      tr.t(this.#states?.detail === 'collapsed' ? 'detail.show' : 'detail.hide'),
    );
  }

  // ─── Width ───────────────────────────────────────────────────────────────

  /** The widest the sidebar may be next to the canvas, px. */
  #maxWidth(): number {
    const total = this.el.parentElement?.clientWidth ?? 0;
    return total > 0
      ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, total - STAGE_MIN))
      : SIDEBAR_MAX;
  }

  #syncSeparators(): void {
    const max = this.#maxWidth();
    attr(this.#resize, 'aria-valuemax', String(max));
    const now = Math.min(this.#width, max);
    attr(this.#resize, 'aria-valuenow', String(now));
    attr(this.#resize, 'aria-valuetext', `${now} px`);
    const list = Math.round(100 * (1 - (this.#share ?? this.#measuredShare())));
    attr(this.#split, 'aria-valuenow', String(list));
    attr(this.#split, 'aria-valuetext', this.#ctx.tr().t('sidebar.splitValue', { p: `${list}%` }));
  }

  #bindResize(): void {
    let start: { x: number; w: number; id: number } | null = null;
    const set = (px: number, done: boolean): void => {
      const width = Math.max(SIDEBAR_MIN, Math.min(this.#maxWidth(), px));
      this.setSizes(width, this.#share);
      this.#host.resized(this.#width, this.#share, done);
    };
    this.#resize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start = { x: e.clientX, w: this.el.getBoundingClientRect().width, id: e.pointerId };
      this.#resize.setPointerCapture?.(e.pointerId);
      this.el.classList.add('dragging');
    });
    this.#resize.addEventListener('pointermove', (e) => {
      // The sidebar is on the right: dragging its edge left widens it.
      if (start && e.pointerId === start.id) set(start.w + (start.x - e.clientX), false);
    });
    const end = (e: PointerEvent): void => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      this.el.classList.remove('dragging');
      this.#host.resized(this.#width, this.#share, true);
    };
    this.#resize.addEventListener('pointerup', end);
    this.#resize.addEventListener('pointercancel', end);
    this.#resize.addEventListener('dblclick', () => set(SIDEBAR_WIDTH, true));
    this.#resize.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? WIDTH_STEP_LARGE : WIDTH_STEP;
      const to: Record<string, number> = {
        ArrowLeft: this.#width + step,
        ArrowRight: this.#width - step,
        PageUp: this.#width + WIDTH_STEP_LARGE,
        PageDown: this.#width - WIDTH_STEP_LARGE,
        Home: SIDEBAR_MIN,
        End: this.#maxWidth(),
      };
      const next = to[e.key];
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      set(next, true);
    });
  }

  // ─── Split between the list and the detail panel ────────────────────────

  /** The detail panel's share of the sidebar's height as laid out now (0 before layout). */
  #measuredShare(): number {
    const total = this.#inner.clientHeight;
    return total > 0 ? this.#detailWrap.getBoundingClientRect().height / total : 0;
  }

  /** Clamp a share so that the list and the detail panel keep their minimum heights. */
  #clampShare(share: number): number {
    const total = this.#inner.clientHeight;
    if (total <= 0) return Math.max(0.1, Math.min(0.9, share));
    const above = this.#head.parentElement?.getBoundingClientRect().height ?? 0;
    const max = Math.max(DETAIL_MIN, total - above - LIST_MIN) / total;
    return Math.max(DETAIL_MIN / total, Math.min(max, share));
  }

  #bindSplit(): void {
    let start: { y: number; share: number; id: number } | null = null;
    const set = (share: number, done: boolean): void => {
      this.setSizes(this.#width, this.#clampShare(share));
      this.#host.resized(this.#width, this.#share, done);
    };
    this.#split.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start = { y: e.clientY, share: this.#share ?? this.#measuredShare(), id: e.pointerId };
      this.#split.setPointerCapture?.(e.pointerId);
      this.el.classList.add('dragging');
    });
    this.#split.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const total = this.#inner.clientHeight;
      if (total > 0) set(start.share + (start.y - e.clientY) / total, false);
    });
    const end = (e: PointerEvent): void => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      this.el.classList.remove('dragging');
      this.#host.resized(this.#width, this.#share, true);
    };
    this.#split.addEventListener('pointerup', end);
    this.#split.addEventListener('pointercancel', end);
    // Back to the content's height.
    this.#split.addEventListener('dblclick', () => {
      this.setSizes(this.#width, null);
      this.#host.resized(this.#width, null, true);
    });
    this.#split.addEventListener('keydown', (e) => {
      const current = this.#share ?? this.#measuredShare();
      // Up moves the split up: the detail panel grows.
      const to: Record<string, number> = {
        ArrowUp: current + SPLIT_STEP,
        ArrowDown: current - SPLIT_STEP,
        PageUp: current + 2 * SPLIT_STEP,
        PageDown: current - 2 * SPLIT_STEP,
        Home: 1,
        End: 0,
      };
      const next = to[e.key];
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      set(next, true);
    });
  }

  // ─── Bottom sheet ────────────────────────────────────────────────────────

  /** Separator semantics: the sheet's height as a percentage of the available height. */
  #sheetValue(px: number, total: number): void {
    const pct = (v: number): number => Math.round((100 * v) / Math.max(1, total));
    attr(this.#handle, 'aria-valuemin', String(pct(120)));
    attr(this.#handle, 'aria-valuemax', String(pct(total - 96)));
    attr(this.#handle, 'aria-valuenow', String(pct(px)));
    attr(
      this.#handle,
      'aria-valuetext',
      this.#ctx.tr().t('sidebar.sheetValue', { p: `${pct(px)}%` }),
    );
  }

  /** Refresh the separator values (layout changes). */
  syncSheet(): void {
    const total = this.el.parentElement?.clientHeight ?? 0;
    if (total > 0) this.#sheetValue(this.el.getBoundingClientRect().height, total);
  }

  /** The layout changed size: keep the width within what fits, refresh the separators. */
  layout(compact: boolean): void {
    if (compact) this.syncSheet();
    else this.#syncSeparators();
  }

  #bindSheet(): void {
    let start: { y: number; h: number; id: number } | null = null;
    const host = (): HTMLElement | null => this.el.parentElement;
    const setHeight = (px: number): void => {
      const total = host()?.clientHeight ?? 600;
      const clamped = Math.max(120, Math.min(total - 96, px));
      this.el.style.setProperty('--sheet-h', `${Math.round(clamped)}px`);
      this.#sheetValue(clamped, total);
    };
    this.#handle.addEventListener('pointerdown', (e) => {
      start = { y: e.clientY, h: this.el.getBoundingClientRect().height, id: e.pointerId };
      this.#handle.setPointerCapture?.(e.pointerId);
      this.el.classList.add('dragging');
    });
    this.#handle.addEventListener('pointermove', (e) => {
      if (start && e.pointerId === start.id) setHeight(start.h + (start.y - e.clientY));
    });
    const end = (e: PointerEvent): void => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      this.el.classList.remove('dragging');
    };
    this.#handle.addEventListener('pointerup', end);
    this.#handle.addEventListener('pointercancel', end);
    this.#handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();
      const current = this.el.getBoundingClientRect().height;
      setHeight(current + (e.key === 'ArrowUp' ? 40 : -40));
    });
  }
}
