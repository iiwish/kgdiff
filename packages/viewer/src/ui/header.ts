/**
 * The canvas HUD: the title (brand and compared versions) floating top-left, the actions
 * (appearance menu, help, sidebar toggle) floating top-right. Both stay up while loading and on
 * errors. How the diff is viewed is chosen in the dock at the bottom (`dock.ts`).
 */
import type { Topic } from '../controller.js';
import { attr, h, iconButton, relabel, replace } from '../dom.js';
import type { UiContext } from './context.js';

/** The kgdiff mark: a soft accent diamond holding a node. */
function brandMark(): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML =
    '<svg class="brand-mark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
    '<rect x="4.1" y="4.1" width="11.8" height="11.8" rx="3.2" transform="rotate(45 10 10)" ' +
    'fill="var(--kgdiff-accent-soft)" stroke="var(--kgdiff-accent)" stroke-width="1.5"/>' +
    '<circle cx="10" cy="10" r="2.4" fill="var(--kgdiff-accent)"/></svg>';
  return tpl.content.firstElementChild as SVGSVGElement;
}

export class Header {
  readonly el: HTMLElement;
  readonly menuButton: HTMLButtonElement;
  readonly #brand: HTMLElement;
  readonly #versions: HTMLElement;
  readonly #actions: HTMLElement;
  readonly #end: HTMLElement;
  readonly #helpButton: HTMLButtonElement;
  readonly #sidebarButton: HTMLButtonElement;

  readonly #ctx: UiContext;

  constructor(ctx: UiContext) {
    this.#ctx = ctx;
    this.#brand = h(
      'div',
      { class: 'brand' },
      brandMark(),
      h('span', { class: 'brand-name', text: 'kgdiff' }),
    );
    this.#versions = h('div', { class: 'versions' });
    this.menuButton = iconButton('contrast', '', () => ctx.toggleMenu(), {
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    this.#helpButton = iconButton('help', '', () => ctx.openHelp());
    this.#sidebarButton = iconButton('sidebar', '', () => ctx.toggleSidebar());
    this.#actions = h(
      'div',
      { class: 'hud-actions card', role: 'group' },
      this.menuButton,
      this.#helpButton,
      this.#sidebarButton,
    );
    // The menu is a sibling of the actions card, not inside it: a backdrop filter would clip
    // the menu's own blur to the card.
    this.#end = h('div', { class: 'hud-end' }, this.#actions);
    this.el = h(
      'header',
      { class: 'hud' },
      h(
        'div',
        { class: 'hud-title card' },
        this.#brand,
        h('span', { class: 'header-sep', 'aria-hidden': 'true' }),
        this.#versions,
      ),
      this.#end,
    );
  }

  /** Place the appearance menu under the actions. */
  attachMenu(menu: HTMLElement): void {
    this.#end.appendChild(menu);
  }

  update(topics: ReadonlySet<Topic>): void {
    if (!(topics.has('locale') || topics.has('data') || topics.has('status'))) return;
    const tr = this.#ctx.tr();
    attr(this.#brand, 'title', `kgdiff — ${tr.t('brand.tagline')}`);
    attr(this.#actions, 'aria-label', tr.t('header.actions'));
    relabel(this.menuButton, tr.t('action.settings'));
    relabel(this.#helpButton, `${tr.t('action.help')} (?)`);
    relabel(this.#sidebarButton, `${tr.t('action.sidebar')} (\\)`);
    this.#renderVersions();
  }

  setSidebarState(open: boolean): void {
    attr(this.#sidebarButton, 'aria-pressed', String(open));
  }

  setMenuState(open: boolean): void {
    attr(this.menuButton, 'aria-expanded', String(open));
  }

  #renderVersions(): void {
    const data = this.#ctx.controller.data;
    if (!data) {
      replace(this.#versions);
      this.el.dataset.titled = 'false';
      return;
    }
    this.el.dataset.titled = 'true';
    const tr = this.#ctx.tr();
    const { names, versions } = data;
    const tag = (v: string | undefined) =>
      v ? h('span', { class: 'tag', title: v, text: v }) : null;
    const arrow = () => h('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' });
    attr(this.#versions, 'aria-label', tr.t('header.compare'));
    attr(this.#versions, 'role', 'group');
    if (names.before === names.after) {
      replace(
        this.#versions,
        h('span', {
          class: 'name',
          title: data.title ?? names.after,
          text: data.title ?? names.after,
        }),
        versions.before || versions.after
          ? h(
              'span',
              { class: 'side' },
              tag(versions.before ?? '—'),
              arrow(),
              tag(versions.after ?? '—'),
            )
          : null,
      );
      return;
    }
    replace(
      this.#versions,
      h(
        'span',
        { class: 'side' },
        h('span', { class: 'name', title: names.before, text: names.before }),
        tag(versions.before),
      ),
      arrow(),
      h(
        'span',
        { class: 'side' },
        h('span', { class: 'name', title: names.after, text: names.after }),
        tag(versions.after),
      ),
    );
  }
}
