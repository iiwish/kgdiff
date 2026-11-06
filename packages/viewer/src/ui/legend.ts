/**
 * The legend (RFC 0001 §3, `<kgdiff-legend>`): a card of every family's swatch and name, folded
 * to its head until opened, or one line of dots for the families this diff has, then the
 * unchanged context. Which one shows is the layout's (`.stage-wrap[data-legend]`).
 */
import type { Family } from '@kgdiff/scene';
import { attr, h, icon, replace, setText } from '../dom.js';
import type { Translator } from '../i18n.js';
import { FAMILIES } from '../styles.js';
import type { Topic } from '../topics.js';
import type { UiContext } from './context.js';
import { swatch } from './swatch.js';

export class Legend {
  /** The card (a toggle head and the rows). */
  readonly card: HTMLElement;
  /** The one-line legend. */
  readonly mini: HTMLElement;
  readonly #head: HTMLButtonElement;
  readonly #body: HTMLElement;
  #open = false;

  readonly #ctx: UiContext;

  /** `toggled`: the user opened or folded the card from its head. */
  constructor(ctx: UiContext, toggled: (open: boolean) => void = () => undefined) {
    this.#ctx = ctx;
    this.#head = h(
      'button',
      {
        type: 'button',
        class: 'legend-head',
        'aria-expanded': 'false',
        onclick: () => {
          this.setOpen(!this.#open);
          toggled(this.#open);
        },
      },
      h('span', { class: 'lbl' }),
      icon('chevron-down'),
    );
    this.#body = h('div', { class: 'legend-body', id: 'kg-legend' });
    attr(this.#head, 'aria-controls', 'kg-legend');
    this.card = h(
      'div',
      { class: 'legend card float bottom-left', 'data-open': 'false' },
      this.#head,
      this.#body,
    );
    this.mini = h('div', { class: 'mini-legend float bottom-left', role: 'list' });
  }

  get open(): boolean {
    return this.#open;
  }

  setOpen(open: boolean): void {
    this.#open = open;
    attr(this.card, 'data-open', String(open));
    attr(this.#head, 'aria-expanded', String(open));
  }

  update(topics: ReadonlySet<Topic>): void {
    if (!(topics.has('status') || topics.has('data') || topics.has('locale'))) return;
    const tr = this.#ctx.tr();
    this.#renderCard(tr);
    this.#renderMini(tr);
  }

  #renderCard(tr: Translator): void {
    setText(this.#head.querySelector('.lbl') as Element, tr.t('legend.title'));
    attr(this.#head, 'aria-label', tr.t('legend.toggle'));
    const fams: Family[] = [...FAMILIES, 'neutral'];
    replace(
      this.#body,
      fams.map((f) =>
        h(
          'div',
          { class: 'legend-row', 'data-family': f, title: tr.t(`familyHint.${f}`) },
          swatch(f),
          h('span', { class: 'name', text: tr.t(`family.${f}`) }),
        ),
      ),
    );
  }

  /** One line: the families this diff has, then the unchanged context. */
  #renderMini(tr: Translator): void {
    const scene = this.#ctx.controller.scene;
    const present = new Set<Family>(scene?.hunks.map((x) => x.family));
    if (scene?.nodes.some((n) => n.status === 'unchanged')) present.add('neutral');
    attr(this.mini, 'aria-label', tr.t('legend.title'));
    replace(
      this.mini,
      [...FAMILIES, 'neutral' as const]
        .filter((f) => present.has(f))
        .map((f) =>
          h(
            'span',
            {
              class: 'mini-item',
              role: 'listitem',
              'data-family': f,
              title: tr.t(`familyHint.${f}`),
            },
            h('span', { class: 'dot', 'aria-hidden': 'true' }),
            tr.t(`family.${f}`),
          ),
        ),
    );
  }
}
