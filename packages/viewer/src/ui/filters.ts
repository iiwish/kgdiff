/**
 * The family filters (RFC 0001 §3, `<kgdiff-filters>` from phase 2): one chip per family the
 * diff has, with its count and the legend's swatch, toggling the session's family filter, and
 * "show all" while a filter is on.
 */
import { attr, h, setText } from '../dom.js';
import { familyCounts } from '../list-model.js';
import type { Topic } from '../session.js';
import { FAMILIES } from '../styles.js';
import type { UiContext } from './context.js';
import { swatch } from './swatch.js';

export class Filters {
  readonly el: HTMLElement;
  readonly #chips = new Map<string, HTMLButtonElement>();
  readonly #showAll: HTMLButtonElement;

  readonly #ctx: UiContext;

  constructor(ctx: UiContext) {
    this.#ctx = ctx;
    const c = ctx.controller;
    this.el = h('div', { class: 'filters', role: 'group' });
    for (const f of FAMILIES) {
      const chip = h(
        'button',
        {
          type: 'button',
          class: 'fchip',
          'data-family': f,
          'aria-pressed': 'false',
          onclick: () => c.toggleFamily(f),
        },
        swatch(f),
        h('span', { class: 'lbl' }),
        h('span', { class: 'n' }),
      );
      this.#chips.set(f, chip);
      this.el.appendChild(chip);
    }
    this.#showAll = h('button', {
      type: 'button',
      class: 'link-btn',
      hidden: true,
      onclick: () => c.setFamilies([]),
    });
    this.el.appendChild(this.#showAll);
  }

  update(topics: ReadonlySet<Topic>): void {
    const all = topics.has('status') || topics.has('data') || topics.has('locale');
    if (all) this.#renderChips();
    if (all || topics.has('filters')) this.#renderState();
  }

  #renderChips(): void {
    const tr = this.#ctx.tr();
    const scene = this.#ctx.controller.scene;
    const counts = scene ? familyCounts(scene) : null;
    attr(this.el, 'aria-label', tr.t('sidebar.filters'));
    setText(this.#showAll, tr.t('sidebar.clearFilters'));
    this.el.hidden = !scene || scene.hunks.length === 0;
    for (const [f, chip] of this.#chips) {
      const n = counts ? counts[f as keyof typeof counts] : 0;
      setText(chip.querySelector('.lbl') as Element, tr.t(`family.${f as keyof typeof counts}`));
      setText(chip.querySelector('.n') as Element, tr.num(n));
      chip.hidden = n === 0;
      attr(chip, 'title', tr.t(`familyHint.${f as keyof typeof counts}`));
    }
  }

  #renderState(): void {
    const fams = this.#ctx.controller.families;
    for (const [f, chip] of this.#chips) {
      attr(chip, 'aria-pressed', String(fams.has(f as never)));
    }
    this.#showAll.hidden = fams.size === 0;
  }
}
