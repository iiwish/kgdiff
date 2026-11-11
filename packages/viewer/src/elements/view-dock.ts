/**
 * `<kgdiff-view-dock>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Dock } from '../ui/dock.js';
import { BoundElement, define } from './bound.js';

/**
 * How the root's diff is viewed. The mode (overlay, swipe, replay; keys `1`–`3`) and "Changes only"
 * (key `4`) with its context hops and the nearest "+N" expansion. Binds to a root like the other
 * elements (`for`, `htmlFor`, `rootElement`). Slotted into a `<kgdiff-stage>` it replaces the
 * stage's built-in dock; placed anywhere else it is not kept clear of fits and flights unless
 * registered (`stage.registerObstacle`).
 *
 * @tagname kgdiff-view-dock
 */
export class KgdiffViewDock extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'view-dock';

  protected build(ui: UiContext, _ctx: unknown, release: (fn: () => void) => void): Region {
    const dock = new Dock(ui);
    this.shadow.append(dock.el);
    if (typeof ResizeObserver === 'function') {
      // Narrow docks drop their labels.
      const ro = new ResizeObserver(() => dock.layout());
      ro.observe(this);
      release(() => ro.disconnect());
    }
    return dock;
  }
}

define('kgdiff-view-dock', KgdiffViewDock);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-view-dock': KgdiffBoundElement;
  }
}
