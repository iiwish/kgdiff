/**
 * What the chrome that acts on one view shares (`<kgdiff-zoom>`, `<kgdiff-minimap>`; RFC 0001
 * §3): it binds to a stage, not to a root. The nearest `<kgdiff-stage>` around it (across
 * shadow roots, through the stage context `kgdiff.stage/1`), or the one its `stage="<id>"`
 * names anywhere on the page; a stage defined or bound later is found then. It shows what the
 * stage's root says (language, tokens), acts on the stage's view, and follows the stage when it
 * binds again (a new view).
 */
import type { Region } from '../bind.js';
import { requestContext } from '../context.js';
import type { KgdiffStageElement } from '../index.js';
import type { ElementName } from '../styles.js';
import type { UiContext } from '../ui/context.js';
import type { StageView } from '../view.js';
import { mount } from './bound.js';
import { type StageViewContext, stageContext } from './stage-context.js';

function byId(el: Element, id: string): Element | null {
  const tree = el.getRootNode() as { getElementById?: (id: string) => Element | null };
  return tree.getElementById?.(id) ?? el.ownerDocument.getElementById(id);
}

/** @experimental The base of the chrome elements that act on a stage's view, in 0.6. */
export abstract class ViewBoundElement extends HTMLElement {
  static get observedAttributes(): readonly string[] {
    return ['stage'];
  }

  protected readonly shadow: ShadowRoot;
  #stage: StageViewContext | null = null;
  #generation = 0;
  /** Undone when the element unbinds from its stage. */
  readonly #release: (() => void)[] = [];
  /** Undone when the stage's view or root changes (the region is built again). */
  readonly #regionRelease: (() => void)[] = [];

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  /** The element's name after `kgdiff-` (its host rules). */
  protected abstract readonly name: ElementName;

  /** Build the region in the shadow root, for `view`; `release` collects what to undo. */
  protected abstract build(
    ui: UiContext,
    view: StageView,
    release: (fn: () => void) => void,
  ): Region;

  /**
   * Reflects the `stage` attribute: the id of the stage to act on, or '' for the nearest one
   * around the element. Changing it binds again.
   */
  get stageId(): string {
    return this.getAttribute('stage') ?? '';
  }

  set stageId(value: string) {
    this.setAttribute('stage', String(value));
  }

  /** The stage this element acts on, or null while it waits for one. */
  get stageElement(): KgdiffStageElement | null {
    return this.#stage?.stage ?? null;
  }

  connectedCallback(): void {
    if (Object.hasOwn(this, 'stageId')) {
      const value = (this as unknown as Record<string, unknown>).stageId;
      delete (this as unknown as Record<string, unknown>).stageId;
      this.stageId = String(value);
    }
    this.#bind();
  }

  disconnectedCallback(): void {
    this.#unbind();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (name === 'stage' && old !== value && this.isConnected) {
      this.#unbind();
      this.#bind();
    }
  }

  #bind(): void {
    const generation = ++this.#generation;
    const answer = (ctx: StageViewContext): void => {
      if (generation !== this.#generation || this.#stage !== null) return;
      this.#stage = ctx;
      this.#release.push(ctx.watchView((view) => this.#build(view)));
    };
    const id = this.getAttribute('stage');
    if (!id) {
      requestContext(this, stageContext, answer as (value: unknown) => void);
      return;
    }
    const stage = byId(this, id);
    if (stage) {
      requestContext(this, stageContext, answer as (value: unknown) => void, stage);
      return;
    }
    const onProvider = (e: Event): void => {
      const host = e.composedPath()[0];
      if (!(host instanceof Element) || host.id !== id) return;
      document.removeEventListener('context-provider', onProvider);
      requestContext(this, stageContext, answer as (value: unknown) => void, host);
    };
    document.addEventListener('context-provider', onProvider);
    this.#release.push(() => document.removeEventListener('context-provider', onProvider));
  }

  /** The stage has a view (again), or lost it: show the region for it. */
  #build(view: StageView | null): void {
    for (const fn of this.#regionRelease.splice(0)) fn();
    this.shadow.replaceChildren();
    const root = this.#stage?.root;
    if (!view || !root) return;
    const release = (fn: () => void): void => {
      this.#regionRelease.push(fn);
    };
    mount(this, this.shadow, this.name, root, (ui) => this.build(ui, view, release), release);
  }

  #unbind(): void {
    this.#generation++;
    this.#stage = null;
    for (const fn of this.#regionRelease.splice(0)) fn();
    for (const fn of this.#release.splice(0)) fn();
    this.shadow.replaceChildren();
  }
}
