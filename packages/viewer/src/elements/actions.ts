/**
 * `<kgdiff-actions>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import type { Region, ViewerContext } from '../bind.js';
import { isOpen } from '../dom.js';
import type { KgdiffBoundElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Actions } from '../ui/header.js';
import { HelpDialog, Menu } from '../ui/popovers.js';
import { BoundElement, define } from './bound.js';

/**
 * The appearance menu (theme, color palette, language: the root's `theme`, `palette` and `locale`)
 * and the keyboard shortcuts dialog, which `?` opens too. Binds to a root (`for`, `htmlFor`,
 * `rootElement`); bound to a `<kgdiff-viewer>` it has the sidebar toggle too (a composed root has
 * no sidebar). Slotted into a viewer it replaces the actions over its canvas.
 *
 * @tagname kgdiff-actions
 * @experimental In 0.6; stable from 0.7 (RFC 0001, decision 7).
 */
export class KgdiffActions extends BoundElement implements KgdiffBoundElement {
  protected readonly name = 'actions';

  protected build(ui: UiContext, ctx: ViewerContext, release: (fn: () => void) => void): Region {
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
    const local: UiContext = { ...ui, toggleMenu: toggle, openHelp: () => help?.show() };
    // The sidebar toggle where the root has a sidebar (a `<kgdiff-viewer>`); none in a
    // composed root, where `\` does nothing.
    const hasSidebar = ui.hasSidebar;
    menu = new Menu(local);
    help = new HelpDialog(local, hasSidebar ? [] : ['sidebar']);
    actions = new Actions(local, hasSidebar !== undefined);
    actions.attachMenu(menu.el);
    const sidebar = (): void => {
      const button = actions?.sidebarButton;
      if (!button || !hasSidebar) return;
      button.hidden = !hasSidebar();
      actions?.setSidebarState(ui.sidebarOpen());
    };
    if (hasSidebar) {
      // The viewer reports every change of its panels, the sidebar's folds included.
      sidebar();
      ctx.host.addEventListener('kgdiff-layout', sidebar);
      release(() => ctx.host.removeEventListener('kgdiff-layout', sidebar));
    }
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
