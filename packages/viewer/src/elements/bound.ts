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
import { forwardKey, type Region, uiContext, type ViewerContext, viewerContext } from '../bind.js';
import { type Context, type ContextProviderEvent, requestContext } from '../context.js';
import type { KgdiffBoundElement, KgdiffRootElement } from '../index.js';
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

/**
 * Find the provider of `context` for `consumer`: the nearest one around it when `id` is empty,
 * else the element of that id as `consumer` sees it (its own tree first, then the document),
 * now, once that element provides `context` (the protocol replays the request), or once a
 * provider of that id announces itself. `answer` gets the first value only, and none after the
 * returned function cancels (a rebinding or a disconnection).
 */
export function bindContext<T>(
  consumer: Element,
  context: Context<T>,
  id: string | null,
  answer: (value: T) => void,
): () => void {
  let live = true;
  const once = (value: T): void => {
    if (!live) return;
    live = false;
    answer(value);
  };
  if (!id) {
    requestContext(consumer, context, once);
    return () => {
      live = false;
    };
  }
  const named = byId(consumer, id);
  if (named) {
    requestContext(consumer, context, once, named);
    return () => {
      live = false;
    };
  }
  // No element of that id yet: wait for a provider of that id to announce itself.
  const onProvider = (e: Event): void => {
    const host = e.composedPath()[0];
    if ((e as ContextProviderEvent<unknown>).context?.key !== context.key) return;
    if (!(host instanceof Element) || host.id !== id) return;
    document.removeEventListener('context-provider', onProvider);
    requestContext(consumer, context, once, host);
  };
  document.addEventListener('context-provider', onProvider);
  return () => {
    live = false;
    document.removeEventListener('context-provider', onProvider);
  };
}

/** Define `name` once (another copy of the library may have defined it first). */
export function define(name: string, ctor: CustomElementConstructor): void {
  if (typeof customElements !== 'undefined' && customElements.get(name) === undefined) {
    customElements.define(name, ctor);
  }
}

/**
 * Show `build`'s region in `host`'s shadow root, bound to the root `ctx`: the shared sheet, the
 * host rules and, outside the root's subtree, its token set (kept up with theme changes); the
 * session's language; the root's notifications; and, outside its subtree, the keys pressed in
 * `host`, forwarded to the root (which owns the keyboard map). `release` collects the undo.
 */
export function mount(
  host: HTMLElement,
  shadow: ShadowRoot,
  name: ElementName,
  ctx: ViewerContext,
  build: (ui: UiContext) => Region,
  release: (fn: () => void) => void,
): void {
  const outside = !inside(host, ctx.host);
  const adopt = (): void => {
    const doc = host.ownerDocument;
    shadow.adoptedStyleSheets = [
      stylesheet(doc),
      elementSheet(doc, name),
      ...(outside ? [ctx.tokens(doc)] : []),
    ];
  };
  const lang = (): void => {
    for (const el of shadow.children) el.setAttribute('lang', ctx.controller.locale);
  };
  const ui: UiContext = {
    ...uiContext(ctx, shadow),
    // Focus targets go when the element does.
    target: (target, focus, available) => {
      const off = ctx.target(target, focus, available);
      release(off);
      return off;
    },
  };
  adopt();
  const region = build(ui);
  release(
    ctx.attach({
      update: (topics) => {
        if (outside && topics.has('theme')) adopt();
        if (topics.has('locale') || topics.has('status')) lang();
        region.update(topics);
      },
    }),
  );
  if (outside) {
    // The root owns the keyboard map; keys pressed here would not reach it (and a root this
    // element sits in must leave them alone).
    const forward = (e: KeyboardEvent): void => forwardKey(ctx, e);
    host.addEventListener('keydown', forward);
    release(() => host.removeEventListener('keydown', forward));
  }
  lang();
  try {
    region.update(ALL_TOPICS);
  } catch (error) {
    console.error('[kgdiff] render failed:', error);
  }
}

/** @experimental The base of the bound elements (`KgdiffBoundElement`), in 0.6. */
export abstract class BoundElement extends HTMLElement implements KgdiffBoundElement {
  static get observedAttributes(): readonly string[] {
    return ['for'];
  }

  protected readonly shadow: ShadowRoot;
  #ctx: ViewerContext | null = null;
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

  /** Properties a page may set before the element is defined (they shadow the accessors). */
  protected upgradedProperties(): readonly string[] {
    return ['htmlFor'];
  }

  /**
   * Reflects `for`, as on `<label>` and `<output>`: the id of the root to show; '' (no
   * attribute) for the nearest one.
   */
  get htmlFor(): string {
    return this.getAttribute('for') ?? '';
  }

  set htmlFor(value: string) {
    const id = String(value);
    if (id === '') this.removeAttribute('for');
    else this.setAttribute('for', id);
  }

  /** The root this element shows, or null while it waits for one. */
  get rootElement(): KgdiffRootElement | null {
    return (this.#ctx?.host as KgdiffRootElement | undefined) ?? null;
  }

  connectedCallback(): void {
    for (const prop of this.upgradedProperties()) {
      if (!Object.hasOwn(this, prop)) continue;
      const value = (this as unknown as Record<string, unknown>)[prop];
      delete (this as unknown as Record<string, unknown>)[prop];
      (this as unknown as Record<string, unknown>)[prop] = value;
    }
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
    const cancel = bindContext(this, viewerContext, this.getAttribute('for'), (ctx) =>
      this.#attach(ctx),
    );
    this.#release.push(cancel);
  }

  #attach(ctx: ViewerContext): void {
    this.#ctx = ctx;
    const release = (fn: () => void): void => {
      this.#release.push(fn);
    };
    mount(this, this.shadow, this.name, ctx, (ui) => this.build(ui, ctx, release), release);
  }

  #unbind(): void {
    this.#ctx = null;
    for (const fn of this.#release.splice(0)) fn();
    this.shadow.replaceChildren();
  }
}
