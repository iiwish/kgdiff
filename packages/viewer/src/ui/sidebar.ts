/**
 * The default layout's sidebar (RFC 0001 §4): the change list with the search and the family
 * filters in its head, the search results in the list's place, and the detail panel below.
 * Below 760 px it is a resizable bottom sheet. The regions in it are bound to the root on their
 * own; the sidebar only places them, opens and closes, and resizes as a sheet.
 */
import { attr, h } from '../dom.js';
import type { Topic } from '../session.js';
import type { ChangeList } from './change-list.js';
import type { UiActions } from './context.js';
import type { Detail } from './detail.js';
import type { Filters } from './filters.js';
import type { Search } from './search.js';

export { HEADER_SLOT, ROW_SLOT } from './change-list.js';

export class Sidebar {
  readonly el: HTMLElement;
  readonly #handle: HTMLElement;
  readonly #tr: UiActions['tr'];

  constructor(
    tr: UiActions['tr'],
    list: ChangeList,
    search: Search,
    filters: Filters,
    detail: Detail,
  ) {
    this.#tr = tr;
    this.#handle = h('div', {
      class: 'sheet-handle',
      role: 'separator',
      'aria-orientation': 'horizontal',
      tabindex: '0',
    });
    this.#bindSheet();
    this.el = h(
      'aside',
      { class: 'sidebar', 'data-open': 'true' },
      h(
        'div',
        { class: 'sidebar-inner' },
        this.#handle,
        h('div', { class: 'sb-head' }, list.head, search.box, filters.el),
        h('div', { class: 'list-wrap' }, list.sticky, list.list, search.results, list.phases),
        detail.el,
      ),
    );
  }

  setOpen(open: boolean): void {
    attr(this.el, 'data-open', String(open));
    this.el.inert = !open;
  }

  update(topics: ReadonlySet<Topic>): void {
    if (topics.has('status') || topics.has('data') || topics.has('locale')) {
      const tr = this.#tr();
      attr(this.el, 'aria-label', tr.t('sidebar.label'));
      attr(this.#handle, 'aria-label', tr.t('sidebar.sheet'));
    }
  }

  // ─── Bottom sheet ────────────────────────────────────────────────────────

  /** Separator semantics: the sheet's height as a percentage of the available height. */
  #sheetValue(px: number, total: number): void {
    const pct = (v: number): number => Math.round((100 * v) / Math.max(1, total));
    attr(this.#handle, 'aria-valuemin', String(pct(120)));
    attr(this.#handle, 'aria-valuemax', String(pct(total - 96)));
    attr(this.#handle, 'aria-valuenow', String(pct(px)));
    attr(this.#handle, 'aria-valuetext', this.#tr().t('sidebar.sheetValue', { p: `${pct(px)}%` }));
  }

  /** Refresh the separator values (layout changes). */
  syncSheet(): void {
    const total = this.el.parentElement?.clientHeight ?? 0;
    if (total > 0) this.#sheetValue(this.el.getBoundingClientRect().height, total);
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
