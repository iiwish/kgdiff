/**
 * `<kgdiff-change-list>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import { h } from '../dom.js';
import type { KgdiffBoundElement } from '../index.js';
import { ChangeList } from '../ui/change-list.js';
import type { UiContext } from '../ui/context.js';
import { BoundElement, define } from './bound.js';

/**
 * The "Changes" title with the count and review progress, and the changes grouped by phase (a
 * virtualized listbox; `j` / `k` / `x`, Enter, Home / End). A labelled region. While a search is
 * active (the session's query is not blank) its rows step aside. Registers itself as the root's
 * `list` focus target (choosing a search result moves focus here).
 *
 * @tagname kgdiff-change-list
 */
export class KgdiffChangeList extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'change-list';

  protected build(ui: UiContext, _ctx: unknown, release: (fn: () => void) => void): Region {
    const list = new ChangeList(ui);
    const rows = h('div', { class: 'list-wrap' }, list.sticky, list.list, list.phases);
    this.shadow.append(
      h(
        'section',
        { class: 'change-list', 'aria-labelledby': 'kg-changes-title' },
        h('div', { class: 'sb-head' }, list.head),
        rows,
      ),
    );
    if (typeof ResizeObserver === 'function') {
      // The list draws the rows in view: it needs its height.
      const ro = new ResizeObserver(() => list.renderWindow());
      ro.observe(rows);
      release(() => ro.disconnect());
    }
    return list;
  }
}

define('kgdiff-change-list', KgdiffChangeList);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-change-list': KgdiffBoundElement;
  }
}
