/**
 * `<kgdiff-legend>` (RFC 0001 §3; experimental): what the colors mean. `variant="full"` (the
 * default): a card of every family's swatch and name, folded to its head until opened; `open`
 * reflects whether it is (the user's toggle included, as on `<details>`). `variant="mini"`: one
 * line of dots for the families the root's diff has, then the unchanged context. Binds to a
 * root (`for`, `htmlFor`, `rootElement`). Slotted into a `<kgdiff-stage>` it replaces the stage's
 * built-in legend; placed anywhere else it is not kept clear of fits and flights unless
 * registered. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import type { KgdiffLegendElement, LegendVariant } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Legend } from '../ui/legend.js';
import { BoundElement, define } from './bound.js';

const VARIANTS: readonly LegendVariant[] = ['full', 'mini'];

/** @experimental See the module's description. */
export class KgdiffLegend extends BoundElement implements KgdiffLegendElement {
  static override get observedAttributes(): readonly string[] {
    return ['for', 'variant', 'open'];
  }

  protected readonly name = 'legend';
  #legend: Legend | null = null;
  #reflecting = false;

  /** `full` (the card) or `mini` (one line), reflected to `variant`; another value reads `full`. */
  get variant(): LegendVariant {
    const v = this.getAttribute('variant') as LegendVariant | null;
    return v !== null && VARIANTS.includes(v) ? v : 'full';
  }

  set variant(value: LegendVariant) {
    if (VARIANTS.includes(value) && value !== 'full') this.setAttribute('variant', value);
    else this.removeAttribute('variant');
  }

  /** Whether the card is open, reflected to the boolean `open` attribute (the user's toggle too). */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', Boolean(value));
  }

  override attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (name === 'for') super.attributeChangedCallback(name, old, value);
    else if (name === 'open' && !this.#reflecting) this.#legend?.setOpen(this.open);
    else if (name === 'variant') this.#place();
  }

  protected override upgradedProperties(): readonly string[] {
    return [...super.upgradedProperties(), 'variant', 'open'];
  }

  protected build(ui: UiContext): Region {
    const legend = new Legend(ui, (open) => {
      // The user's toggle, reflected as <details> does.
      this.#reflecting = true;
      try {
        this.toggleAttribute('open', open);
      } finally {
        this.#reflecting = false;
      }
    });
    this.#legend = legend;
    legend.setOpen(this.open);
    this.#place();
    return {
      update: (topics) => {
        if (this.#legend === legend) legend.update(topics);
      },
    };
  }

  /** Show the variant asked for. */
  #place(): void {
    const legend = this.#legend;
    if (!legend || !this.isConnected) return;
    const shown = this.variant === 'mini' ? legend.mini : legend.card;
    if (this.shadow.firstElementChild !== shown) this.shadow.replaceChildren(shown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#legend = null;
  }
}

define('kgdiff-legend', KgdiffLegend);

declare global {
  interface HTMLElementTagNameMap {
    /** @experimental In 0.6. */
    'kgdiff-legend': KgdiffLegendElement;
  }
}
