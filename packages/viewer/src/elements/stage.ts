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
 * `panels` turns the built-in chrome's regions (`dock`, `transport`, `legend`, `zoom`,
 * `minimap`) open, collapsed or hidden, in the syntax of `<kgdiff-viewer>`'s `panels`; the
 * user's changes (opening the legend) hold until the page declares another state for that
 * region. Nothing is remembered.
 *
 * A root draws one stage for now; a second one bound to the same root stays empty. Importing
 * this module defines it.
 */
import type { Region, ViewerContext } from '../bind.js';
import { createContext, provideContext } from '../context.js';
import type { KgdiffStageElement, PanelState, StagePanels, StageRegion } from '../index.js';
import { DEFAULT_PANELS, formatPanels, toPanels } from '../panels.js';
import type { UiContext } from '../ui/context.js';
import { Stage } from '../ui/stage.js';
import { BoundElement, define } from './bound.js';

/**
 * What a stage provides to its descendants (the view-level context).
 *
 * @experimental Like the stage, in 0.6.
 */
export interface StageContext {
  /** Keep `element` clear of fits and flights; returns the function that stops it. */
  registerObstacle(element: Element): () => void;
}

/** @experimental The stage context's key (`Symbol.for('kgdiff.stage/1')`). */
export const stageContext = createContext<StageContext>('kgdiff.stage/1');

/**
 * The regions of the built-in chrome a stage has.
 *
 * @experimental Like the stage, in 0.6.
 */
export const STAGE_REGIONS: readonly StageRegion[] = [
  'dock',
  'transport',
  'legend',
  'zoom',
  'minimap',
];

type MutableStagePanels = { -readonly [R in StageRegion]?: PanelState };

/** Panels from an attribute or a property, keeping the stage's regions (warning about the rest). */
function stagePanels(value: unknown): StagePanels {
  const { panels, invalid } = toPanels(value);
  const out: MutableStagePanels = {};
  for (const [region, state] of Object.entries(panels)) {
    if (STAGE_REGIONS.includes(region as StageRegion)) out[region as StageRegion] = state;
    else invalid.push(`${region}:${state}`);
  }
  if (invalid.length > 0) {
    console.warn(`[kgdiff] <kgdiff-stage> ignoring invalid panels: ${invalid.join(' ')}`);
  }
  return out;
}

/** @experimental See the module's description. */
export class KgdiffStage extends BoundElement implements KgdiffStageElement {
  static override get observedAttributes(): readonly string[] {
    return ['for', 'panels'];
  }

  protected readonly name = 'stage';
  #stage: Stage | null = null;
  /** The page's `panels`, and what the user changed since (the legend's head). */
  #declared: StagePanels = {};
  readonly #runtime: MutableStagePanels = {};
  #reflecting = false;
  /** Registered obstacles, kept across rebinding (the stage is rebuilt then). */
  readonly #obstacles = new Map<Element, () => void>();

  get panels(): StagePanels {
    return { ...this.#declared };
  }

  set panels(value: StagePanels | string | null) {
    const panels = stagePanels(value);
    this.#reflecting = true;
    try {
      const text = formatPanels(panels);
      if (text) this.setAttribute('panels', text);
      else this.removeAttribute('panels');
    } finally {
      this.#reflecting = false;
    }
    this.#declare(panels);
  }

  override attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (name !== 'panels') super.attributeChangedCallback(name, old, value);
    else if (!this.#reflecting) this.#declare(stagePanels(value ?? ''));
  }

  protected override upgradedProperties(): readonly string[] {
    return [...super.upgradedProperties(), 'panels'];
  }

  /** A region the page declares another state for gives way; the same again changes nothing. */
  #declare(panels: StagePanels): void {
    for (const r of STAGE_REGIONS) if (panels[r] !== this.#declared[r]) delete this.#runtime[r];
    this.#declared = panels;
    this.#applyPanels();
  }

  #applyPanels(): void {
    const states = { ...DEFAULT_PANELS, ...this.#declared, ...this.#runtime };
    this.#stage?.setPanels(states);
  }

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
    // The user opening or folding the legend holds until the page declares the legend again.
    const stage = new Stage(
      {
        ...ui,
        setPanel: (region, state) => {
          if (STAGE_REGIONS.includes(region as StageRegion)) {
            this.#runtime[region as StageRegion] = state;
          }
        },
      },
      true,
    );
    this.#stage = stage;
    this.#applyPanels();
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
    /** @experimental In 0.6. */
    'kgdiff-stage': KgdiffStageElement;
  }
}
