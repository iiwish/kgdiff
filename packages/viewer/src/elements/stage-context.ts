/**
 * The view-level context a `<kgdiff-stage>` provides to its descendants (`kgdiff.stage/1`), in a
 * module of its own: the chrome that acts on a view finds its stage through it without pulling
 * the stage (and the renderer) into its subpath.
 */
import type { ViewerContext } from '../bind.js';
import { createContext } from '../context.js';
import type { KgdiffStageElement, KgdiffViewerElement } from '../index.js';
import type { StageView } from '../view.js';

/**
 * What a stage provides to its descendants (the view-level context).
 */
export interface StageContext {
  /** Keep `element` clear of fits and flights; returns the function that stops it. */
  registerObstacle(element: Element): () => void;
}

/** @internal What the chrome that acts on a view (`<kgdiff-zoom>`, `<kgdiff-minimap>`) gets. */
export interface StageViewContext extends StageContext {
  /** The stage element, or the viewer (its built-in stage). */
  readonly stage: KgdiffStageElement | KgdiffViewerElement;
  /** The root the stage is bound to now, or null while it waits for one. */
  readonly root: ViewerContext | null;
  /** The stage's view now, or null while the stage waits for its root. */
  readonly view: StageView | null;
  /** Call `listener` with the view now and whenever it changes; returns the stop. */
  watchView(listener: (view: StageView | null) => void): () => void;
}

/**
 * The context a `<kgdiff-stage>` (and a `<kgdiff-viewer>`, for its built-in stage) provides to its
 * descendants, keyed `Symbol.for('kgdiff.stage/1')`: content positioned over the canvas that the
 * stage does not place requests it with a `context-request` event (the community context
 * protocol) and registers itself with `registerObstacle`.
 */
export const stageContext = createContext<StageContext>('kgdiff.stage/1');
