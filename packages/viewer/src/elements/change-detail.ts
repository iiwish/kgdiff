/**
 * `<kgdiff-change-detail>` (RFC 0001 §3; experimental): the selected change, or the selected
 * node: what changed first, then the unchanged rest; prev / next and the reviewed toggle. A
 * labelled region. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Detail } from '../ui/detail.js';
import { BoundElement, define } from './bound.js';

/** @experimental See the module's description. */
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
    /** @experimental In 0.6. */
    'kgdiff-change-detail': KgdiffBoundElement;
  }
}
