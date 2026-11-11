/**
 * `<kgdiff-zoom>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffStageBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { ZoomBar } from '../ui/zoom.js';
import type { StageView } from '../view.js';
import { define } from './bound.js';
import { ViewBoundElement } from './view-bound.js';

/**
 * Zoom in, zoom out and fit, for one stage's view (the `+` / `−` / `f` keys act on every stage of
 * the root). Binds to the nearest `<kgdiff-stage>` around it, or to the one `stage="<id>"` names
 * (`stage`, `stageElement`, `rootElement`). Slotted into a stage it replaces the stage's built-in
 * zoom buttons; placed anywhere else it is not kept clear of fits and flights unless registered.
 *
 * @tagname kgdiff-zoom
 */
export class KgdiffZoom extends ViewBoundElement implements KgdiffStageBoundElement {
  protected readonly name = 'zoom';

  protected build(ui: UiContext, view: StageView): Region {
    const zoom = new ZoomBar(ui, () => view);
    this.shadow.append(zoom.el);
    return zoom;
  }
}

define('kgdiff-zoom', KgdiffZoom);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-zoom': KgdiffStageBoundElement;
  }
}
