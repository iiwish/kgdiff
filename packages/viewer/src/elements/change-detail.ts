/**
 * `<kgdiff-change-detail>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Detail } from '../ui/detail.js';
import { BoundElement, define } from './bound.js';

/**
 * The selected change, or the selected node: what changed first, then the unchanged rest; prev /
 * next and the reviewed toggle. A labelled region.
 *
 * @tagname kgdiff-change-detail
 */
export class KgdiffChangeDetail extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'change-detail';

  protected build(ui: UiContext): Region {
    const detail = new Detail(ui);
    this.shadow.append(detail.el);
    return detail;
  }
}

define('kgdiff-change-detail', KgdiffChangeDetail);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-change-detail': KgdiffBoundElement;
  }
}
