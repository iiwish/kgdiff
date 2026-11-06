/**
 * What the elements bound to a root share (RFC 0001 §2–§6): finding the root, in every
 * topology, and living with it.
 *
 * - **Binding.** The nearest `<kgdiff-root>` (or `<kgdiff-viewer>`) around the element, across
 *   shadow roots, or the one named by `for="<id>"` anywhere on the page. A root that is defined
 *   or connected later is found then (the context protocol replays the request; `for` waits
 *   for a root of that id to announce itself). Changing `for` binds again.
 * - **Rendering.** The element builds its region in its own shadow root once bound, and the root
 *   renders it on every notification from then on.
 * - **Outside the root's subtree** (`for`): the element adopts the root's token set (inside,
 *   tokens are inherited, page overrides on the root included) and forwards its key presses to
 *   the root, which owns the keyboard map.
 */
import { type Region, uiContext, type ViewerContext, viewerContext } from '../bind.js';
import { requestContext } from '../context.js';
import { type ElementName, elementSheet, stylesheet } from '../styles.js';
import { ALL_TOPICS } from '../topics.js';
import type { UiContext } from '../ui/context.js';

/** Whether `el` is inside `host`'s subtree, across shadow roots. */
function inside(el: Element, host: Element): boolean {
  for (let n: Node | null = el; n; ) {
    if (n === host) return true;
    n = n.parentNode ?? ((n as Partial<ShadowRoot>).host as Node | undefined) ?? null;
  }
  return false;
}

/** The element of `id` as `el` sees it: in its own tree first, then in the document. */
function byId(el: Element, id: string): Element | null {
  const tree = el.getRootNode() as { getElementById?: (id: string) => Element | null };
  return tree.getElementById?.(id) ?? el.ownerDocument.getElementById(id);
}

/** Define `name` once (another copy of the library may have defined it first). */
export function define(name: string, ctor: CustomElementConstructor): void {
  if (typeof customElements !== 'undefined' && customElements.get(name) === undefined) {
    customElements.define(name, ctor);
  }
}

export abstract class BoundElement extends HTMLElement {
  static get observedAttributes(): readonly string[] {
    return ['for'];
  }

  protected readonly shadow: ShadowRoot;
  #ctx: ViewerContext | null = null;
  #outside = false;
  /** Bumped on every (re)binding: answers to an older request are ignored. */
  #generation = 0;
  readonly #release: (() => void)[] = [];

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  /** The element's name after `kgdiff-` (its host rules). */
  protected abstract readonly name: ElementName;

  /** Build the region in the shadow root, bound to `ui`; `release` collects what to undo. */
  protected abstract build(
    ui: UiContext,
    ctx: ViewerContext,
    release: (fn: () => void) => void,
  ): Region;

  /** The root this element is bound to, or null while it waits for one. */
  protected get context(): ViewerContext | null {
    return this.#ctx;
  }

  connectedCallback(): void {
    this.#bind();
  }

  disconnectedCallback(): void {
    this.#unbind();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (name === 'for' && old !== value && this.isConnected) {
      this.#unbind();
      this.#bind();
    }
  }

  #bind(): void {
    const generation = ++this.#generation;
    const answer = (ctx: ViewerContext): void => {
      if (generation === this.#generation && this.#ctx === null) this.#attach(ctx);
    };
    const id = this.getAttribute('for');
    if (!id) {
      requestContext(this, viewerContext, answer);
      return;
    }
    const root = byId(this, id);
    if (root) {
      // Answered now, or replayed when that element becomes a root.
      requestContext(this, viewerContext, answer, root);
      return;
    }
    // No element of that id yet: wait for a root of that id to announce itself.
    const onProvider = (e: Event): void => {
      const host = e.composedPath()[0];
      if (!(host instanceof Element) || host.id !== id) return;
      document.removeEventListener('context-provider', onProvider);
      requestContext(this, viewerContext, answer, host);
    };
    document.addEventListener('context-provider', onProvider);
    this.#release.push(() => document.removeEventListener('context-provider', onProvider));
  }

  #attach(ctx: ViewerContext): void {
    this.#ctx = ctx;
    this.#outside = !inside(this, ctx.host);
    const release = (fn: () => void): void => {
      this.#release.push(fn);
    };
    const ui: UiContext = {
      ...uiContext(ctx, this.shadow),
      // Focus targets go when the element does.
      target: (name, focus, available) => {
        const off = ctx.target(name, focus, available);
        release(off);
        return off;
      },
    };
    this.#adopt();
    const region = this.build(ui, ctx, release);
    release(
      ctx.attach({
        update: (topics) => {
          if (this.#outside && topics.has('theme')) this.#adopt();
          if (topics.has('locale') || topics.has('status')) this.#lang(ctx);
          region.update(topics);
        },
      }),
    );
    if (this.#outside) {
      // The root owns the keyboard map; keys pressed here would not reach it.
      const forward = (e: KeyboardEvent): void => ctx.forwardKey(e);
      this.addEventListener('keydown', forward);
      release(() => this.removeEventListener('keydown', forward));
    }
    this.#lang(ctx);
    try {
      region.update(ALL_TOPICS);
    } catch (error) {
      console.error('[kgdiff] render failed:', error);
    }
  }

  /** The language of the session, on what the element shows. */
  #lang(ctx: ViewerContext): void {
    for (const el of this.shadow.children) el.setAttribute('lang', ctx.controller.locale);
  }

  /** The shared sheet, the host rules and, outside the root's subtree, its token set. */
  #adopt(): void {
    const doc = this.ownerDocument;
    const ctx = this.#ctx;
    this.shadow.adoptedStyleSheets = [
      stylesheet(doc),
      elementSheet(doc, this.name),
      ...(ctx && this.#outside ? [ctx.tokens(doc)] : []),
    ];
  }

  #unbind(): void {
    this.#generation++;
    this.#ctx = null;
    for (const fn of this.#release.splice(0)) fn();
    this.shadow.replaceChildren();
  }
}
