/**
 * The change list (RFC 0001 §3, `<kgdiff-change-list>` from phase 2): the "Changes" title with
 * the count and review progress, and the phase-grouped list of changes (virtualized, sticky
 * group headers, a `listbox` with `aria-activedescendant`). While a search is active (the
 * session's query is not blank) it steps aside. Registers itself as the root's `list` focus
 * target.
 */
import type { SceneHunk } from '@kgdiff/scene';
import { attr, h, icon, replace, setText } from '../dom.js';
import type { ListItem } from '../list-model.js';
import { requestFrame } from '../schedule.js';
import type { Topic } from '../session.js';
import { sceneHunkGlyph, type UiContext } from './context.js';

/** Row slot and group-header heights (px); rows are 52 px tall inside a 56 px slot. */
export const ROW_SLOT = 56;
export const HEADER_SLOT = 32;
const OVERSCAN = 320;

function itemHeight(item: ListItem): number {
  return item.kind === 'header' ? HEADER_SLOT : ROW_SLOT;
}

export class ChangeList {
  /** Title, count and review progress. */
  readonly head: HTMLElement;
  readonly list: HTMLElement;
  readonly sticky: HTMLElement;
  /** Visually hidden group names the options are described by. */
  readonly phases: HTMLElement = h('div', { class: 'sr-only' });
  readonly #title: HTMLElement;
  readonly #count: HTMLElement;
  readonly #progress: HTMLElement;
  readonly #progressText: HTMLElement;
  readonly #progressBar: HTMLElement;
  readonly #listInner: HTMLElement;
  #offsets: number[] = [];
  #rendered = new Map<number, HTMLElement>();
  #scrollQueued = false;

  readonly #ctx: UiContext;

  constructor(ctx: UiContext) {
    this.#ctx = ctx;
    const c = ctx.controller;
    this.#title = h('h2', { id: 'kg-changes-title' });
    this.#count = h('span', { class: 'count-badge' });
    this.#progressText = h('span');
    this.#progressBar = h('div');
    this.#progress = h(
      'div',
      { class: 'progress' },
      this.#progressText,
      h('span', { class: 'bar', 'aria-hidden': 'true' }, this.#progressBar),
    );
    this.head = h('div', { class: 'sb-title' }, this.#title, this.#count, this.#progress);
    this.#listInner = h('div', { class: 'list-inner', role: 'presentation' });
    this.list = h(
      'div',
      {
        class: 'list scroll',
        role: 'listbox',
        tabindex: '0',
        'aria-labelledby': 'kg-changes-title',
        'aria-keyshortcuts': 'J K X Enter Home End',
      },
      this.#listInner,
    );
    this.list.addEventListener('scroll', () => this.#queueWindow(), { passive: true });
    this.list.addEventListener('click', (e) => this.#onListClick(e));
    this.list.addEventListener('dblclick', (e) => {
      const row = (e.target as Element).closest('.row');
      if (row) c.flyToSelection();
    });
    this.sticky = h('div', { class: 'sticky', 'aria-hidden': 'true', hidden: true });
    ctx.target('list', () => this.list.focus({ preventScroll: true }));
  }

  update(topics: ReadonlySet<Topic>): void {
    const tr = this.#ctx.tr();
    const all = topics.has('status') || topics.has('data') || topics.has('locale');
    if (all) {
      setText(this.#title, tr.t('sidebar.changes'));
      const scene = this.#ctx.controller.scene;
      setText(this.#count, tr.num(scene?.hunks.length ?? 0));
      this.#count.hidden = !scene;
    }
    if (all || topics.has('filters')) this.#layoutList();
    if (all || topics.has('review')) {
      this.#renderProgress();
      this.#refreshRows();
    }
    if (topics.has('selection')) {
      this.#refreshRows();
      this.#revealSelected();
    }
    if (all || topics.has('search')) this.#stepAside();
  }

  /**
   * The search's results take the list's place while the query is not blank. Coming back, the
   * list measures itself on the next frame, once every region has updated (the results it
   * shared its space with are hidden by then, whatever order the regions update in).
   */
  #stepAside(): void {
    const searching = this.#ctx.controller.query.trim() !== '';
    if (this.list.hidden === searching) return;
    this.list.hidden = searching;
    if (searching) this.sticky.hidden = true;
    else this.#queueWindow();
  }

  #renderProgress(): void {
    const tr = this.#ctx.tr();
    const state = this.#ctx.controller.reviewState();
    const done = state.reviewed.length;
    const total = state.total;
    this.#progress.hidden = total === 0;
    const complete = total > 0 && done === total;
    attr(this.#progress, 'data-complete', String(complete));
    setText(
      this.#progressText,
      complete ? tr.t('review.complete') : tr.t('review.progress', { done, total }),
    );
    this.#progressBar.style.transform = `scaleX(${total > 0 ? done / total : 0})`;
  }

  // ─── Virtual list ────────────────────────────────────────────────────────

  #layoutList(): void {
    const c = this.#ctx.controller;
    const tr = this.#ctx.tr();
    replace(
      this.phases,
      c.list.items.map((it) =>
        it.kind === 'header'
          ? h('span', {
              id: `kg-phase-${it.phase}`,
              text: `${tr.t(`phase.${it.phase}`)} (${tr.num(it.count)})`,
            })
          : null,
      ),
    );
    for (const el of this.#rendered.values()) el.remove();
    this.#rendered.clear();
    const items = c.list.items;
    this.#offsets = new Array(items.length);
    let y = 0;
    for (let i = 0; i < items.length; i++) {
      this.#offsets[i] = y;
      y += itemHeight(items[i] as ListItem);
    }
    this.#listInner.style.height = `${y + 8}px`;
    this.#renderEmpty();
    this.renderWindow();
  }

  #renderEmpty(): void {
    const c = this.#ctx.controller;
    const tr = this.#ctx.tr();
    const existing = this.#listInner.querySelector('.list-empty, .skeleton');
    existing?.remove();
    if (c.status === 'loading' || c.status === 'idle') {
      const sk = h('div', { class: 'skeleton', 'aria-hidden': 'true' });
      if (c.status === 'loading') {
        for (let i = 0; i < 6; i++) {
          sk.appendChild(
            h(
              'div',
              { class: 'skeleton-row shimmer' },
              h('span', { class: 'g' }),
              h('span', { class: 'b' }),
            ),
          );
        }
      }
      this.#listInner.appendChild(sk);
      return;
    }
    if (c.status !== 'ready' || c.list.items.length > 0) return;
    const filtered = c.families.size > 0 && c.hunkCount > 0;
    this.#listInner.appendChild(
      h(
        'div',
        { class: 'list-empty' },
        icon(filtered ? 'search' : 'check-circle'),
        h('span', { text: tr.t(filtered ? 'sidebar.filteredEmpty' : 'sidebar.noChanges') }),
        filtered
          ? h('button', {
              type: 'button',
              class: 'btn',
              text: tr.t('sidebar.clearFilters'),
              onclick: () => c.setFamilies([]),
            })
          : null,
      ),
    );
  }

  #queueWindow(): void {
    if (this.#scrollQueued) return;
    this.#scrollQueued = true;
    requestFrame(() => {
      this.#scrollQueued = false;
      this.renderWindow();
    });
  }

  /** First item index whose bottom is below `y` (binary search over offsets). */
  #indexAt(y: number): number {
    let lo = 0;
    let hi = this.#offsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.#offsets[mid] as number) + ROW_SLOT <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  renderWindow(): void {
    const items = this.#ctx.controller.list.items;
    const top = this.list.scrollTop;
    const height = this.list.clientHeight || 640;
    const from = this.#indexAt(Math.max(0, top - OVERSCAN));
    const limit = top + height + OVERSCAN;
    const needed = new Set<number>();
    for (let i = from; i < items.length && (this.#offsets[i] as number) < limit; i++) needed.add(i);
    for (const [i, el] of this.#rendered) {
      if (!needed.has(i)) {
        el.remove();
        this.#rendered.delete(i);
      }
    }
    for (const i of needed) {
      if (this.#rendered.has(i)) continue;
      const el = this.#renderItem(items[i] as ListItem, this.#offsets[i] as number);
      this.#rendered.set(i, el);
      this.#listInner.appendChild(el);
    }
    this.#renderSticky(top);
  }

  #renderItem(item: ListItem, y: number): HTMLElement {
    const tr = this.#ctx.tr();
    const c = this.#ctx.controller;
    if (item.kind === 'header') {
      return h(
        'div',
        { class: 'group', role: 'presentation', style: `top: ${y}px` },
        h('span', { text: tr.t(`phase.${item.phase}`) }),
        h('span', { class: 'n', text: tr.num(item.count) }),
      );
    }
    const hunk = c.scene?.hunks[item.hunk] as SceneHunk;
    const reviewed = c.isReviewed(hunk.id);
    // Pointer shortcut only: options hold no interactive children. Keyboard users press `x` or
    // use the detail panel's "Reviewed" button.
    const rv = h(
      'span',
      {
        class: 'rv',
        'aria-hidden': 'true',
        'data-pressed': String(reviewed),
        title: tr.t(reviewed ? 'review.unmark' : 'review.mark'),
        'data-hunk': hunk.id,
      },
      h('span', { class: 'ring' }, icon('check')),
    );
    const rank = c.list.rank.get(item.hunk) ?? 0;
    const row = h(
      'div',
      {
        class: 'row',
        role: 'option',
        id: `kg-opt-${item.hunk}`,
        'data-index': String(item.hunk),
        'data-family': hunk.family,
        'data-reviewed': String(reviewed),
        'aria-selected': String(c.selectedHunk === item.hunk),
        'aria-setsize': String(c.list.order.length),
        'aria-posinset': String(rank + 1),
        'aria-describedby': `kg-phase-${hunk.phase}`,
        style: `top: ${y + 2}px`,
      },
      h('span', { class: 'glyph-box', 'aria-hidden': 'true', text: sceneHunkGlyph(hunk) }),
      h(
        'span',
        { class: 'txt' },
        h('span', { class: 'title', title: hunk.title, text: hunk.title }),
        h('span', { class: 'sub', text: hunk.subtitle }),
      ),
      rv,
    );
    this.#labelRow(row, hunk, reviewed);
    return row;
  }

  #labelRow(row: HTMLElement, hunk: SceneHunk, reviewed: boolean): void {
    const tr = this.#ctx.tr();
    const parts = [hunk.title];
    if (hunk.subtitle) parts.push(hunk.subtitle);
    if (reviewed) parts.push(tr.t('review.toggle'));
    attr(row, 'aria-label', parts.join('. '));
  }

  /** Update selection / reviewed state of the rendered rows in place. */
  #refreshRows(): void {
    const c = this.#ctx.controller;
    const tr = this.#ctx.tr();
    for (const el of this.#rendered.values()) {
      if (!el.classList.contains('row')) continue;
      const index = Number(el.dataset.index);
      const hunk = c.scene?.hunks[index];
      if (!hunk) continue;
      const reviewed = c.isReviewed(hunk.id);
      attr(el, 'aria-selected', String(index === c.selectedHunk));
      attr(el, 'data-reviewed', String(reviewed));
      const rv = el.querySelector('.rv') as HTMLElement;
      attr(rv, 'data-pressed', String(reviewed));
      attr(rv, 'title', tr.t(reviewed ? 'review.unmark' : 'review.mark'));
      this.#labelRow(el, hunk, reviewed);
    }
    const sel = c.selectedHunk;
    attr(
      this.list,
      'aria-activedescendant',
      sel >= 0 && c.list.rank.has(sel) ? `kg-opt-${sel}` : null,
    );
  }

  #revealSelected(): void {
    const c = this.#ctx.controller;
    const item = c.list.itemOf.get(c.selectedHunk);
    if (item === undefined) return;
    const y = this.#offsets[item] as number;
    const top = this.list.scrollTop;
    // Not laid out yet (hidden sheet): position it for when it shows.
    const height = this.list.clientHeight || 640;
    // The first row of a group scrolls its group header into view too.
    const above =
      c.list.items[item - 1]?.kind === 'header'
        ? (this.#offsets[item - 1] as number)
        : y - HEADER_SLOT;
    if (y < top + HEADER_SLOT) this.list.scrollTop = Math.max(0, above);
    else if (y + ROW_SLOT > top + height) this.list.scrollTop = y + ROW_SLOT - height + 8;
    this.renderWindow();
    this.#refreshRows();
  }

  #renderSticky(top: number): void {
    const items = this.#ctx.controller.list.items;
    let current = -1;
    let next = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.kind !== 'header') continue;
      if ((this.#offsets[i] as number) <= top) current = i;
      else {
        next = i;
        break;
      }
    }
    if (current < 0 || top <= 0) {
      this.sticky.hidden = true;
      return;
    }
    const item = items[current] as Extract<ListItem, { kind: 'header' }>;
    const tr = this.#ctx.tr();
    this.sticky.hidden = false;
    const label = `${tr.t(`phase.${item.phase}`)}|${item.count}`;
    if (this.sticky.dataset.key !== label) {
      this.sticky.dataset.key = label;
      replace(
        this.sticky,
        h(
          'div',
          { class: 'group' },
          h('span', { text: tr.t(`phase.${item.phase}`) }),
          h('span', { class: 'n', text: tr.num(item.count) }),
        ),
      );
    }
    const push = next >= 0 ? Math.min(0, (this.#offsets[next] as number) - top - HEADER_SLOT) : 0;
    this.sticky.style.transform = `translateY(${push}px)`;
  }

  #onListClick(e: MouseEvent): void {
    const c = this.#ctx.controller;
    const target = e.target as Element;
    const rv = target.closest('.rv') as HTMLElement | null;
    if (rv?.dataset.hunk) {
      e.stopPropagation();
      c.toggleReviewed(rv.dataset.hunk);
      return;
    }
    const row = target.closest('.row') as HTMLElement | null;
    if (!row) return;
    const index = Number(row.dataset.index);
    if (Number.isInteger(index)) c.selectHunk(index);
  }
}
