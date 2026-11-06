/**
 * `<kgdiff-title>` (RFC 0001 §3; experimental): the kgdiff mark and the root's compared names
 * and versions. Binds to a root (`for`, `htmlFor`, `rootElement`). Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Title } from '../ui/header.js';
import { BoundElement, define } from './bound.js';

/** @experimental See the module's description. */
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
