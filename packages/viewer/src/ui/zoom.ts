/**
 * The zoom buttons (RFC 0001 §3, `<kgdiff-zoom>`): zoom in, zoom out and fit, acting on one view
 * (a stage's camera), not on every view of the session as the `+` / `−` / `f` keys do.
 */
import { h, iconButton, relabel } from '../dom.js';
import type { Topic } from '../topics.js';
import type { UiContext } from './context.js';

/** What the buttons act on: a view (`StageView`). */
export interface ZoomTarget {
  zoom(direction: 1 | -1): void;
  fit(): Promise<void>;
}

export class ZoomBar {
  readonly el: HTMLElement;
  readonly #in: HTMLButtonElement;
  readonly #out: HTMLButtonElement;
  readonly #fit: HTMLButtonElement;
  readonly #ctx: UiContext;

  /** `target`: the view the buttons act on now (null: none yet, the buttons do nothing). */
  constructor(ctx: UiContext, target: () => ZoomTarget | null) {
    this.#ctx = ctx;
    this.#in = iconButton('plus', '', () => target()?.zoom(1));
    this.#out = iconButton('minus', '', () => target()?.zoom(-1));
    this.#fit = iconButton('fit', '', () => void target()?.fit());
    this.el = h('div', { class: 'zoom-bar card', role: 'toolbar' }, this.#in, this.#out, this.#fit);
  }

  update(topics: ReadonlySet<Topic>): void {
    if (!(topics.has('status') || topics.has('data') || topics.has('locale'))) return;
    const tr = this.#ctx.tr();
    relabel(this.#in, `${tr.t('action.zoomIn')} (+)`);
    relabel(this.#out, `${tr.t('action.zoomOut')} (−)`);
    relabel(this.#fit, `${tr.t('action.fit')} (F)`);
  }
}
