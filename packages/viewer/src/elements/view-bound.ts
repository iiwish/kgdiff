/**
 * What the chrome that acts on one view shares (`<kgdiff-zoom>`, `<kgdiff-minimap>`; RFC 0001
 * §3): it binds to a stage, not to a root. The nearest `<kgdiff-stage>` around it (across
 * shadow roots, through the stage context `kgdiff.stage/1`), or the one its `stage="<id>"`
 * names anywhere on the page (a `<kgdiff-viewer>` is the stage of what it holds, and can be
 * named too); a stage defined or bound later is found then. It shows what the
 * stage's root says (language, tokens), acts on the stage's view, and follows the stage when it
 * binds again (a new view).
 */
import type { Region } from '../bind.js';
import type { KgdiffStageElement, KgdiffViewerElement } from '../index.js';
import type { ElementName } from '../styles.js';
import type { UiContext } from '../ui/context.js';
import type { StageView } from '../view.js';
import { bindContext, mount } from './bound.js';
import { type StageViewContext, stageContext } from './stage-context.js';

/** @experimental The base of the chrome elements that act on a stage's view, in 0.6. */
export abstract class ViewBoundElement extends HTMLElement {
  static get observedAttributes(): readonly string[] {
    return ['stage'];
  }

  protected readonly shadow: ShadowRoot;
  #stage: StageViewContext | null = null;
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
  get stageElement(): KgdiffStageElement | KgdiffViewerElement | null {
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
    const cancel = bindContext(this, stageContext, this.getAttribute('stage'), (ctx) => {
      const stage = ctx as StageViewContext;
      this.#stage = stage;
      this.#release.push(stage.watchView((view) => this.#build(view)));
    });
    this.#release.push(cancel);
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
    this.#stage = null;
    for (const fn of this.#regionRelease.splice(0)) fn();
    for (const fn of this.#release.splice(0)) fn();
    this.shadow.replaceChildren();
  }
}
