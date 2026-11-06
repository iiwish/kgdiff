/**
 * How regions and elements find the root whose session they show (RFC 0001 §2): the context
 * the root provides (`kgdiff.viewer/1`), what it provides, and the binding helpers. Type-only
 * imports of the session: an element's subpath does not pull the session in through here.
 */
import { createContext, requestContext } from './context.js';
import type { ViewerController } from './controller.js';
import type { Topic } from './session.js';
import type { FocusTarget, UiActions, UiContext } from './ui/context.js';

/** Something the root renders: a region, or the layout itself. */
export interface Region {
  update(topics: ReadonlySet<Topic>): void;
}

/** What a root provides to the regions that bind to it. */
export interface ViewerContext {
  readonly controller: ViewerController;
  readonly actions: UiActions;
  /** The element the root's events are dispatched on and its tokens are set on. */
  readonly host: HTMLElement;
  /** Render `region` on every notification (in binding order); returns the detach. */
  attach(region: Region): () => void;
  target(name: FocusTarget, focus: () => void, available?: () => boolean): () => void;
  focus(name: FocusTarget): boolean;
  /** The keyboard map, for a key event that reached the root. */
  handleKey(e: KeyboardEvent): void;
  /** A key pressed in an element bound with `for` (outside the root): the root's rules apply. */
  forwardKey(e: KeyboardEvent): void;
  /** The root's token set as a sheet of `doc` (for elements outside the root's subtree). */
  tokens(doc: Document): CSSStyleSheet;
  /** The pointer entered or left the graph (holds a looping replay with `pause-on-hover`). */
  hover(over: boolean): void;
  /** Claim the root's one canvas for `owner`; false when another stage has it. */
  claimStage(owner: object): boolean;
  releaseStage(owner: object): void;
}

export const viewerContext = createContext<ViewerContext>('kgdiff.viewer/1');

/** Key events an element forwarded to its root: they belong to that root alone. */
const forwarded = new WeakSet<Event>();

/** Forward `e` to `ctx`'s root; no other root acts on it, whether it was handled or not. */
export function forwardKey(ctx: ViewerContext, e: KeyboardEvent): void {
  forwarded.add(e);
  ctx.forwardKey(e);
}

/** Whether `e` was forwarded to a root by an element bound with `for`. */
export function wasForwarded(e: Event): boolean {
  return forwarded.has(e);
}

/** The UI context of a region placed in `root` (its shadow tree), bound to `ctx`. */
export function uiContext(ctx: ViewerContext, root: ShadowRoot): UiContext {
  return {
    ...ctx.actions,
    controller: ctx.controller,
    root,
    target: (name, focus, available) => ctx.target(name, focus, available),
    focus: (name) => ctx.focus(name),
  };
}

/**
 * Bind a region to the root nearest `anchor` (an element where the region is placed): `make`
 * builds it once the root answers, and the root renders it from then on.
 */
export function bindRegion<R extends Region>(anchor: Element, make: (ui: UiContext) => R): R {
  const bound: { region?: R } = {};
  requestContext(anchor, viewerContext, (ctx) => {
    if (bound.region) return;
    bound.region = make(uiContext(ctx, anchor.getRootNode() as ShadowRoot));
    ctx.attach(bound.region);
  });
  // The default layout binds its regions to the root it owns, which answers at once.
  if (!bound.region) throw new Error('[kgdiff] a region found no root to bind to.');
  return bound.region;
}
