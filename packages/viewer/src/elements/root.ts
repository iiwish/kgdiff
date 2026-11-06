/**
 * `<kgdiff-root>` (RFC 0001 §3; experimental): a root without visuals. It owns the session and
 * provides it to the elements inside it (`<kgdiff-stage>`, `<kgdiff-change-list>`, …) or naming
 * it with `for`, and owns what they share: the keyboard map, the live region announcing
 * navigation, the events and the theme tokens. It has the attributes, properties, methods and
 * events of `<kgdiff-viewer>` except the layout's (`panels`, `sidebar`, `header`, `chrome`,
 * `legend`, `persist`): the page lays the elements out, and nothing is remembered.
 *
 * It renders as `display: contents`, so its children are laid out by the page as if it were not
 * there. Importing this module defines it.
 */
import type { KgdiffRootElement } from '../index.js';
import { ROOT_ATTRIBUTES, RootElement } from '../root-element.js';
import { DiffSession, type SessionDeps, type SessionHost } from '../session.js';
import { elementSheet } from '../styles.js';
import type { UiActions } from '../ui/context.js';
import { define } from './bound.js';

/** @experimental See the module's description. */
export class KgdiffRoot extends RootElement implements KgdiffRootElement {
  static get observedAttributes(): readonly string[] {
    return ROOT_ATTRIBUTES;
  }

  #built = false;

  constructor() {
    super();
    this.root.attach({
      update: (topics) => {
        this.reflectSession(topics);
        if (topics.has('locale') || topics.has('status')) {
          this.root.live.setAttribute('lang', this.controller.locale);
        }
      },
    });
  }

  protected sheets(doc: Document): readonly CSSStyleSheet[] {
    return [elementSheet(doc, 'root')];
  }

  /** A session without a canvas of its own: each `<kgdiff-stage>` brings its view. */
  protected createSession(host: SessionHost, deps: SessionDeps): DiffSession {
    return new DiffSession(host, deps);
  }

  /** No layout of its own: `\` and `?` do nothing, `/` focuses the search registered last. */
  protected actions(): UiActions {
    return {
      ...this.baseActions(),
      toggleSidebar: () => undefined,
      sidebarOpen: () => false,
      toggleMenu: () => undefined,
      openHelp: () => undefined,
      focusSearch: () => {
        this.root.focus('search');
      },
    };
  }

  protected connected(): void {
    if (this.#built) return;
    this.#built = true;
    this.shadow.append(document.createElement('slot'), this.root.live);
  }

  protected disconnected(): void {}
}

define('kgdiff-root', KgdiffRoot);

declare global {
  interface HTMLElementTagNameMap {
    /** @experimental In 0.6. */
    'kgdiff-root': KgdiffRootElement;
  }
}
