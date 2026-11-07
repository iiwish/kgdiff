/**
 * `<kgdiff-title>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Title } from '../ui/header.js';
import { BoundElement, define } from './bound.js';

/**
 * The kgdiff mark and the root's compared names and versions. Binds to a root (`for`, `htmlFor`,
 * `rootElement`). Slotted into a `<kgdiff-viewer>` it replaces the title over its canvas.
 *
 * @tagname kgdiff-title
 * @experimental In 0.6; stable from 0.7 (RFC 0001, decision 7).
 */
export class KgdiffTitle extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'title';

  protected build(ui: UiContext): Region {
    const title = new Title(ui);
    this.shadow.append(title.el);
    return title;
  }
}

define('kgdiff-title', KgdiffTitle);

declare global {
  interface HTMLElementTagNameMap {
    /** @experimental In 0.6. */
    'kgdiff-title': KgdiffBoundElement;
  }
}
