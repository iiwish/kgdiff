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
 * Each stage has its own view of the root's session (canvas, camera, fits and flights, tooltip,
 * minimap); several stages of one root share selection, hover, mode, scope, the replay clock,
 * filters and search. `version` pins a stage to the before or after version (side by side).
 * Importing this module defines it.
 */
import type { Region, ViewerContext } from '../bind.js';
import { provideContext } from '../context.js';
import type {
  KgdiffStageElement,
  PanelState,
  StagePanels,
  StageRegion,
  StageVersion,
} from '../index.js';
import { DEFAULT_PANELS, formatPanels, toPanels } from '../panels.js';
import type { UiContext } from '../ui/context.js';
import { Stage } from '../ui/stage.js';
import { StageView } from '../view.js';
import { BoundElement, define } from './bound.js';
import { type StageViewContext, stageContext } from './stage-context.js';

export type { StageContext } from './stage-context.js';
export { stageContext } from './stage-context.js';

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

const VERSIONS: readonly StageVersion[] = ['before', 'after'];

/** A version from an attribute or a property; anything else follows the mode, with a warning. */
function toVersion(value: unknown): StageVersion | null {
  if (value === null || value === undefined || value === '') return null;
  if (VERSIONS.includes(value as StageVersion)) return value as StageVersion;
  console.warn(`[kgdiff] <kgdiff-stage> ignoring version ${JSON.stringify(value)} (before, after)`);
  return null;
}

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
    return ['for', 'panels', 'version'];
  }

  protected readonly name = 'stage';
  #stage: Stage | null = null;
  /** The page's `panels`, and what the user changed since (the legend's head). */
  #declared: StagePanels = {};
  readonly #runtime: MutableStagePanels = {};
  #reflecting = false;
  #version: StageVersion | null = null;
  #view: StageView | null = null;
  readonly #viewListeners = new Set<(view: StageView | null) => void>();
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

  /**
   * The version this stage draws whatever the mode, reflected to the `version` attribute:
   * `before` or `after` (side by side with another stage of the same root), or null to follow
   * the root's mode (overlay, swipe, replay).
   */
  get version(): StageVersion | null {
    return this.#version;
  }

  set version(value: StageVersion | null) {
    const v = toVersion(value);
    this.#reflecting = true;
    try {
      if (v) this.setAttribute('version', v);
      else this.removeAttribute('version');
    } finally {
      this.#reflecting = false;
    }
    this.#setVersion(v);
  }

  override attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (this.#reflecting) return;
    if (name === 'panels') this.#declare(stagePanels(value ?? ''));
    else if (name === 'version') this.#setVersion(toVersion(value));
    else super.attributeChangedCallback(name, old, value);
  }

  protected override upgradedProperties(): readonly string[] {
    return [...super.upgradedProperties(), 'panels', 'version'];
  }

  /** @internal This stage's view (its camera), for the dev harness and tests. */
  get view(): StageView | null {
    return this.#view;
  }

  #setVersion(version: StageVersion | null): void {
    if (version === this.#version) return;
    this.#version = version;
    if (this.#view) this.#view.version = version;
    this.#stage?.setVersion(version);
  }

  #setView(view: StageView | null): void {
    this.#view = view;
    for (const listener of this.#viewListeners) listener(view);
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
      provideContext(this, stageContext, (): StageViewContext => {
        const stage = this;
        return {
          stage,
          get root() {
            return stage.context;
          },
          registerObstacle: (el) => stage.registerObstacle(el),
          get view() {
            return stage.#view;
          },
          watchView: (listener) => {
            stage.#viewListeners.add(listener);
            listener(stage.#view);
            return () => {
              stage.#viewListeners.delete(listener);
            };
          },
        };
      }),
    );
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
    // Content slotted before the stage was built.
    stage.slotted();
    // This stage's own view of the shared session: canvas, camera, framing, minimap.
    const view = new StageView(ctx.controller);
    view.version = this.#version;
    stage.view = view;
    stage.setVersion(this.#version);
    release(ctx.controller.addView(view));
    view.attach(stage.canvasHost, stage.minimapHost);
    view.setChrome(() => stage.chromeLayout());
    this.#setView(view);
    release(() => {
      this.#setView(null);
      view.setChrome(null);
      view.detach();
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
        view.layoutChanged();
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
