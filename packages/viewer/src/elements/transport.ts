/**
 * `<kgdiff-transport>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import { h } from '../dom.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Transport } from '../ui/transport.js';
import { BoundElement, define } from './bound.js';

/**
 * The replay transport of the root's diff. Previous, play / pause, next, the scrubber with one tick
 * per change, the position and the speed; at the end, "Replay finished · Restart" above it. Shown
 * in replay mode only. Binds to a root (`for`, `htmlFor`, `rootElement`). Slotted into a
 * `<kgdiff-stage>` (`slot="bottom-center"`, say) it replaces the stage's built-in transport; placed
 * anywhere else it is not kept clear of fits and flights unless registered. Importing this module
 * defines it.
 *
 * @tagname kgdiff-transport
 */
export class KgdiffTransport extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'transport';

  protected build(ui: UiContext): Region {
    const transport = new Transport(ui);
    this.shadow.append(h('div', { class: 'stack' }, transport.finished, transport.el));
    return transport;
  }
}

define('kgdiff-transport', KgdiffTransport);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-transport': KgdiffBoundElement;
  }
}
