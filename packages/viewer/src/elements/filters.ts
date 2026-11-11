/**
 * `<kgdiff-filters>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Filters } from '../ui/filters.js';
import { BoundElement, define } from './bound.js';

/**
 * One chip per kind of change the diff has, with its count and the legend's swatch, toggling the
 * session's family filter, and "Show all" while a filter is on.
 *
 * @tagname kgdiff-filters
 */
export class KgdiffFilters extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'filters';

  protected build(ui: UiContext): Region {
    const filters = new Filters(ui);
    this.shadow.append(filters.el);
    return filters;
  }
}

define('kgdiff-filters', KgdiffFilters);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-filters': KgdiffBoundElement;
  }
}
