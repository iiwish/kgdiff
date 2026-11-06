/**
 * `<kgdiff-minimap>` (RFC 0001 §3; experimental): an overview of one stage's view, with the
 * part in view outlined. While the whole graph is in view it has nothing to add: it carries
 * the `overview` attribute then and hides (`kgdiff-minimap[overview] { display: block }` keeps
 * it). Binds to the nearest `<kgdiff-stage>` around it, or to the one `stage="<id>"` names
 * (`stageId`, `stageElement`). Slotted into a stage it replaces the stage's built-in minimap;
 * placed anywhere else it is not kept clear of fits and flights unless registered. Importing
 * this module defines it.
 */
import type { Region } from '../bind.js';
import { attr, h } from '../dom.js';
import type { KgdiffMinimapElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import type { StageView } from '../view.js';
import { define } from './bound.js';
import { ViewBoundElement } from './view-bound.js';

/** @experimental See the module's description. */
export class KgdiffMinimap extends ViewBoundElement implements KgdiffMinimapElement {
  protected readonly name = 'minimap';

  /** Whether the whole graph is in view (the minimap hides then); reflected to `overview`. */
  get overview(): boolean {
    return this.hasAttribute('overview');
  }

  protected build(ui: UiContext, view: StageView, release: (fn: () => void) => void): Region {
    const host = h('div', { class: 'minimap-host' });
    this.shadow.append(host);
    release(view.addMinimap(host));
    release(() => this.removeAttribute('overview'));
    return {
      update: (topics) => {
        if (topics.has('status') || topics.has('data') || topics.has('locale')) {
          const label = ui.tr().t('minimap.label');
          attr(host, 'aria-label', label);
          attr(host, 'title', label);
        }
        this.toggleAttribute('overview', view.overview);
      },
    };
  }
}

define('kgdiff-minimap', KgdiffMinimap);

declare global {
  interface HTMLElementTagNameMap {
    /** @experimental In 0.6. */
    'kgdiff-minimap': KgdiffMinimapElement;
  }
}
