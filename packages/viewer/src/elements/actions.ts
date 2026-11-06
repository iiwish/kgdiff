/**
 * `<kgdiff-actions>` (RFC 0001 §3; experimental): the appearance menu (theme, color palette,
 * language: the root's `theme`, `palette` and `locale`) and the keyboard shortcuts dialog,
 * which `?` opens too. Binds to a root (`for`, `htmlFor`, `rootElement`); a composed root has no
 * sidebar, so there is no sidebar toggle. Importing this module defines it.
 */
import type { Region } from '../bind.js';
import { isOpen } from '../dom.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Actions } from '../ui/header.js';
import { HelpDialog, Menu } from '../ui/popovers.js';
import { BoundElement, define } from './bound.js';

/** @experimental See the module's description. */
export class KgdiffActions extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'actions';

  protected build(ui: UiContext, _ctx: unknown, release: (fn: () => void) => void): Region {
    let menu: Menu | null = null;
    let help: HelpDialog | null = null;
    let actions: Actions | null = null;
    const toggle = (open?: boolean): void => {
      if (!menu || !actions) return;
      const next = open ?? !menu.open;
      if (next) menu.show(actions.menuButton);
      else menu.hide(false);
      actions.setMenuState(next);
    };
    // The menu and the dialog are this element's: they open here, not in the root's layout.
    const local: UiContext = {
      ...ui,
      toggleMenu: toggle,
      openHelp: () => help?.show(),
      toggleSidebar: () => undefined,
      sidebarOpen: () => false,
    };
    menu = new Menu(local);
    // No sidebar in a composed root: `\` does nothing there.
    help = new HelpDialog(local, ['sidebar']);
    actions = new Actions(local, false);
    actions.attachMenu(menu.el);
    this.shadow.append(actions.el, help.el);
    const shown = actions;
    const dialog = help;
    const popover = menu;
    // `?` opens this element's dialog (the root's `help` target).
    ui.target(
      'help',
      () => dialog.show(),
      () => isOpen(shown.el),
    );
    // The menu closes on Escape by itself: keep the button's state up with it.
    popover.el.addEventListener('keydown', () =>
      queueMicrotask(() => shown.setMenuState(popover.open)),
    );
    const outside = (e: PointerEvent): void => {
      if (!popover.open) return;
      const path = e.composedPath();
      if (!path.includes(popover.el) && !path.includes(shown.menuButton)) toggle(false);
    };
    document.addEventListener('pointerdown', outside);
    release(() => document.removeEventListener('pointerdown', outside));
    return {
      update: (topics) => {
        shown.update(topics);
        if (popover.open && (topics.has('locale') || topics.has('theme'))) popover.render();
        if (dialog.open && topics.has('locale')) dialog.render();
      },
    };
  }
}

define('kgdiff-actions', KgdiffActions);

declare global {
  interface HTMLElementTagNameMap {
    /** @experimental In 0.6. */
    'kgdiff-actions': KgdiffBoundElement;
  }
}
