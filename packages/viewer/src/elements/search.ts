/**
 * `<kgdiff-search>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Search } from '../ui/search.js';
import { BoundElement, define } from './bound.js';

/**
 * Node search, a combobox and the results list it owns (its `aria-controls` and
 * `aria-activedescendant` stay inside the element). The results open below the box while the query
 * is not blank; ↑ / ↓ move through them, Enter chooses one (its node and change are selected, and
 * focus moves to the change list), Esc clears. The query lives in the session, so a change list
 * bound to the same root steps aside meanwhile. Registers itself as the root's `search` focus
 * target: `/` focuses the one registered last that is shown.
 *
 * @tagname kgdiff-search
 */
export class KgdiffSearch extends BoundElement implements KgdiffBoundElement {
  /** @internal */
  protected readonly name = 'search';

  /** @internal */
  protected build(ui: UiContext): Region {
    const search = new Search(ui);
    this.shadow.append(search.box, search.results);
    return search;
  }
}

define('kgdiff-search', KgdiffSearch);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-search': KgdiffBoundElement;
  }
}
