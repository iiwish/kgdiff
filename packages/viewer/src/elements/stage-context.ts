/**
 * The view-level context a `<kgdiff-stage>` provides to its descendants (`kgdiff.stage/1`), in a
 * module of its own: the chrome that acts on a view finds its stage through it without pulling
 * the stage (and the renderer) into its subpath.
 */
import type { ViewerContext } from '../bind.js';
import { createContext } from '../context.js';
import type { KgdiffStageElement } from '../index.js';
import type { StageView } from '../view.js';

/**
 * What a stage provides to its descendants (the view-level context).
 *
 * @experimental Like the stage, in 0.6.
 */
export interface StageContext {
  /** Keep `element` clear of fits and flights; returns the function that stops it. */
  registerObstacle(element: Element): () => void;
}

/** @internal What the chrome that acts on a view (`<kgdiff-zoom>`, `<kgdiff-minimap>`) gets. */
export interface StageViewContext extends StageContext {
  /** The stage element. */
  readonly stage: KgdiffStageElement;
  /** The root the stage is bound to now, or null while it waits for one. */
  readonly root: ViewerContext | null;
  /** The stage's view now, or null while the stage waits for its root. */
  readonly view: StageView | null;
  /** Call `listener` with the view now and whenever it changes; returns the stop. */
  watchView(listener: (view: StageView | null) => void): () => void;
}

/** @experimental The stage context's key (`Symbol.for('kgdiff.stage/1')`). */
export const stageContext = createContext<StageContext>('kgdiff.stage/1');
