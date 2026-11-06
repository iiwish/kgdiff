/**
 * `<kgdiff-minimap>` (RFC 0001 §3; experimental): an overview of one stage's view, with the
 * part in view outlined. While the whole graph is in view it has nothing to add: it is in the
 * custom state `overview` then (`:state(overview)`, and the read-only `overview` property). A
 * minimap the page places stays shown (`kgdiff-minimap:state(overview) { visibility: hidden }`
 * hides it without moving the layout); one slotted into a stage replaces the stage's own and
 * hides as it did. Binds to the nearest `<kgdiff-stage>` around it, or to the one `stage="<id>"` names
 * (`stage`, `stageElement`, `rootElement`). Slotted into a stage it replaces the stage's built-in minimap;
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

  /** The custom states (`:state(overview)`); null where `ElementInternals` is missing. */
  readonly #internals: ElementInternals | null =
    typeof this.attachInternals === 'function' ? this.attachInternals() : null;
  #overview = false;

  /** Whether the whole graph is in view: the custom state `overview` (`:state(overview)`). */
  get overview(): boolean {
    return this.#overview;
  }

  #setOverview(overview: boolean): void {
    if (overview === this.#overview) return;
    this.#overview = overview;
    const states = this.#internals?.states;
    if (!states) return;
    if (overview) states.add('overview');
    else states.delete('overview');
  }

  protected build(ui: UiContext, view: StageView, release: (fn: () => void) => void): Region {
    const host = h('div', { class: 'minimap-host' });
    this.shadow.append(host);
    release(view.addMinimap(host));
    release(() => this.#setOverview(false));
    return {
      update: (topics) => {
        if (topics.has('status') || topics.has('data') || topics.has('locale')) {
          const label = ui.tr().t('minimap.label');
          attr(host, 'aria-label', label);
          attr(host, 'title', label);
        }
        this.#setOverview(view.overview);
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
