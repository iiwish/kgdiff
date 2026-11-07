/**
 * The canvas HUD: the title (`Title`, `<kgdiff-title>`: brand and compared versions) floating
 * top-left, the actions (`Actions`, `<kgdiff-actions>`: appearance menu, help, sidebar toggle)
 * floating top-right. Both stay up while loading and on errors. How the diff is viewed is
 * chosen in the dock at the bottom (`dock.ts`).
 */
import type { Topic } from '../controller.js';
import { attr, h, iconButton, moveFocusOut, relabel, replace } from '../dom.js';
import type { PanelState } from '../index.js';
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

/** The title card: the brand, then the compared names and versions. */
export class Title {
  readonly el: HTMLElement;
  readonly #brand: HTMLElement;
  readonly #versions: HTMLElement;
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
    this.el = h(
      'div',
      { class: 'hud-title card' },
      this.#brand,
      h('span', { class: 'header-sep', 'aria-hidden': 'true' }),
      this.#versions,
    );
  }

  update(topics: ReadonlySet<Topic>): void {
    if (!(topics.has('locale') || topics.has('data') || topics.has('status'))) return;
    attr(this.#brand, 'title', `kgdiff — ${this.#ctx.tr().t('brand.tagline')}`);
    this.#renderVersions();
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

/**
 * The actions: the appearance menu's button (the menu itself is placed next to the card with
 * `attachMenu`: a backdrop filter would clip its blur to the card), help, and, in the default
 * layout, the sidebar toggle.
 */
export class Actions {
  /** The card and, once attached, the menu next to it. */
  readonly el: HTMLElement;
  readonly menuButton: HTMLButtonElement;
  readonly sidebarButton: HTMLButtonElement | null;
  readonly #card: HTMLElement;
  readonly #helpButton: HTMLButtonElement;
  readonly #ctx: UiContext;

  /** `sidebar`: with the sidebar toggle (the default layout's). */
  constructor(ctx: UiContext, sidebar = true) {
    this.#ctx = ctx;
    this.menuButton = iconButton('contrast', '', () => ctx.toggleMenu(), {
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    this.#helpButton = iconButton('help', '', () => ctx.openHelp());
    this.sidebarButton = sidebar ? iconButton('sidebar', '', () => ctx.toggleSidebar()) : null;
    this.#card = h(
      'div',
      { class: 'hud-actions card', role: 'group' },
      this.menuButton,
      this.#helpButton,
      this.sidebarButton,
    );
    this.el = h('div', { class: 'hud-end' }, this.#card);
  }

  /** Place the appearance menu under the actions. */
  attachMenu(menu: HTMLElement): void {
    this.el.appendChild(menu);
  }

  update(topics: ReadonlySet<Topic>): void {
    if (!(topics.has('locale') || topics.has('data') || topics.has('status'))) return;
    const tr = this.#ctx.tr();
    attr(this.#card, 'aria-label', tr.t('header.actions'));
    relabel(this.menuButton, tr.t('action.settings'));
    relabel(this.#helpButton, `${tr.t('action.help')} (?)`);
    if (this.sidebarButton) relabel(this.sidebarButton, `${tr.t('action.sidebar')} (\\)`);
  }

  setMenuState(open: boolean): void {
    attr(this.menuButton, 'aria-expanded', String(open));
  }

  /** Whether the sidebar is open (the toggle's pressed state). */
  setSidebarState(open: boolean): void {
    if (this.sidebarButton) attr(this.sidebarButton, 'aria-pressed', String(open));
  }
}

/** The default layout's HUD: the title and the actions over the canvas. */
export class Header {
  readonly el: HTMLElement;
  readonly title: Title;
  readonly actions: Actions;
  readonly menuButton: HTMLButtonElement;
  readonly sidebarButton: HTMLButtonElement;
  readonly #ctx: UiContext;

  constructor(ctx: UiContext) {
    this.#ctx = ctx;
    this.title = new Title(ctx);
    this.actions = new Actions(ctx);
    this.menuButton = this.actions.menuButton;
    this.sidebarButton = this.actions.sidebarButton as HTMLButtonElement;
    this.el = h('header', { class: 'hud' }, this.title.el, this.actions.el);
  }

  /** Place the appearance menu under the actions. */
  attachMenu(menu: HTMLElement): void {
    this.actions.attachMenu(menu);
  }

  update(topics: ReadonlySet<Topic>): void {
    this.title.update(topics);
    this.actions.update(topics);
  }

  setSidebarState(open: boolean): void {
    this.actions.setSidebarState(open);
  }

  /**
   * Follow the panel states of the title and the actions (not shown unless open); the sidebar
   * button goes when the sidebar has nothing to show. Focus in the actions moves to `outside`.
   */
  setPanels(
    title: PanelState,
    actions: PanelState,
    sidebar: boolean,
    outside: () => HTMLElement | null,
  ): void {
    attr(this.title.el, 'data-panel', title);
    const end = this.actions.el;
    if (actions !== 'open') moveFocusOut(this.#ctx.root, end, outside);
    attr(end, 'data-panel', actions);
    end.inert = actions !== 'open';
    if (!sidebar) moveFocusOut(this.#ctx.root, this.sidebarButton, outside);
    this.sidebarButton.hidden = !sidebar;
  }

  setMenuState(open: boolean): void {
    this.actions.setMenuState(open);
  }
}
