/**
 * `<kgdiff-stage>` (RFC 0001 §3; experimental): the canvas of the root it is bound to, with the
 * graph, the hover tooltip, the swipe divider, the replay caption and, in this release, the
 * canvas chrome (view dock, replay transport, legend, zoom and minimap; they become elements of
 * their own in a later release).
 *
 * Five named slots take the page's content over the canvas: `top-start`, `top-end`,
 * `bottom-start`, `bottom-center` and `bottom-end`. The stage positions it (12–16 px from the
 * edges, stacked further from the corner than the chrome there), and every slotted element is
 * an obstacle: fits and flights frame the graph in the free part of the canvas, as they do for
 * the chrome. Content positioned some other way registers itself with `registerObstacle`, on the
 * element or on the stage context (`kgdiff.stage/1`) it provides to its descendants.
 *
 * A root draws one stage for now; a second one bound to the same root stays empty. Importing
 * this module defines it.
 */
import type { Region, ViewerContext } from '../bind.js';
import { createContext, provideContext } from '../context.js';
import type { KgdiffStageElement } from '../index.js';
import type { UiContext } from '../ui/context.js';
import { Stage } from '../ui/stage.js';
import { BoundElement, define } from './bound.js';

/** What a stage provides to its descendants (the view-level context). */
export interface StageContext {
  /** Keep `element` clear of fits and flights; returns the function that stops it. */
  registerObstacle(element: Element): () => void;
}

export const stageContext = createContext<StageContext>('kgdiff.stage/1');

export class KgdiffStage extends BoundElement implements KgdiffStageElement {
  protected readonly name = 'stage';
  #stage: Stage | null = null;
  /** Registered obstacles, kept across rebinding (the stage is rebuilt then). */
  readonly #obstacles = new Map<Element, () => void>();

  registerObstacle(element: Element): () => void {
    if (!this.#obstacles.has(element)) {
      this.#obstacles.set(element, this.#stage?.registerObstacle(element) ?? (() => undefined));
    }
    return () => {
      this.#obstacles.get(element)?.();
      this.#obstacles.delete(element);
    };
  }

  protected build(ui: UiContext, ctx: ViewerContext, release: (fn: () => void) => void): Region {
    release(
      provideContext(this, stageContext, () => ({
        registerObstacle: (el) => this.registerObstacle(el),
      })),
    );
    if (!ctx.claimStage(this)) {
      console.warn('[kgdiff] a root draws one <kgdiff-stage> for now: this one stays empty.');
      return { update: () => undefined };
    }
    release(() => ctx.releaseStage(this));
    const stage = new Stage(ui, true);
    this.#stage = stage;
    for (const el of this.#obstacles.keys()) this.#obstacles.set(el, stage.registerObstacle(el));
    release(() => {
      this.#stage = null;
    });
    stage.setChrome('full', true);
    this.shadow.append(stage.el);
    const c = ctx.controller;
    c.attach(stage.canvasHost, stage.minimapHost);
    c.setChrome(() => stage.chromeLayout());
    release(() => {
      c.setChrome(null);
      c.detach();
    });
    // The graph takes keyboard focus (shortcuts apply where focus is), also on click.
    const canvas = stage.canvasHost.querySelector('canvas');
    if (canvas) {
      canvas.tabIndex = 0;
      const focusCanvas = (): void => canvas.focus({ preventScroll: true });
      canvas.addEventListener('pointerdown', focusCanvas);
      release(() => canvas.removeEventListener('pointerdown', focusCanvas));
    }
    const hover = (over: boolean) => (e: PointerEvent) => {
      if (e.pointerType !== 'touch') ctx.hover(over);
    };
    stage.el.addEventListener('pointerenter', hover(true));
    stage.el.addEventListener('pointerleave', hover(false));
    release(() => ctx.hover(false));
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        stage.layout();
        c.layoutChanged();
      });
      ro.observe(stage.el);
      release(() => ro.disconnect());
    }
    document.fonts?.ready?.then(() => this.#stage?.layout()).catch(() => undefined);
    return stage;
  }
}

define('kgdiff-stage', KgdiffStage);

declare global {
  interface HTMLElementTagNameMap {
    'kgdiff-stage': KgdiffStageElement;
  }
}
