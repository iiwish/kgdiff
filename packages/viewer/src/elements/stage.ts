/**
 * `<kgdiff-stage>` (RFC 0001 §3), documented on its class. Importing this module defines it.
 */
import { KgdiffError } from '@kgdiff/core';
import type { RendererLayer } from '@kgdiff/renderer';
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

export type { Context } from '../context.js';
export type { StageContext } from './stage-context.js';
export { stageContext } from './stage-context.js';

/**
 * The regions of the built-in chrome a stage has.
 */
const STAGE_REGIONS: readonly StageRegion[] = ['dock', 'transport', 'legend', 'zoom', 'minimap'];

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

/**
 * The canvas of the root it is bound to: the graph, the hover tooltip, the swipe divider, the
 * replay caption and the canvas chrome (view dock, replay transport, legend, zoom buttons and
 * minimap). Each stage is a view of its own: a root draws every stage bound to it, each with its
 * own camera, sharing the selection, the hover, the filters and the search; `version` pins one
 * to a version.
 *
 * Five named slots take the page's content over the canvas. The stage positions it (12–16 px
 * from the edges, stacked further from the corner than the chrome there), and every slotted
 * element is an obstacle: fits and flights frame the graph in the free part of the canvas. A
 * chrome element slotted in replaces the built-in region of its kind; `panels` keeps applying
 * to the rest. Content positioned some other way registers itself with `registerObstacle`, on
 * the element or on the stage context (`kgdiff.stage/1`) it provides to its descendants.
 *
 * @tagname kgdiff-stage
 * @slot top-start - The page's content in the top left corner, below the version chip.
 * @slot top-end - The page's content in the top right corner.
 * @slot bottom-start - The page's content in the bottom left corner, above the legend.
 * @slot bottom-center - The page's content above the view dock and the transport.
 * @slot bottom-end - The page's content in the bottom right corner, above the zoom buttons and the minimap.
 */
export class KgdiffStage extends BoundElement implements KgdiffStageElement {
  static override get observedAttributes(): readonly string[] {
    return ['for', 'panels', 'version'];
  }

  /** @internal */
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
  /** The page's layers, kept like the obstacles, with their removal from the current view. */
  readonly #layers = new Set<{ readonly layer: RendererLayer; remove: (() => void) | null }>();

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

  /** @internal */
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

  addLayer(layer: RendererLayer): () => void {
    const order = (layer as RendererLayer | null)?.order;
    if ((order !== 'under' && order !== 'over') || typeof layer.draw !== 'function') {
      // What the renderer would answer, also while there is none.
      throw new KgdiffError(
        'invalid-input',
        "addLayer: expected { order: 'under' | 'over', draw(ctx, view) }",
      );
    }
    const entry = { layer, remove: this.#view?.addLayer(layer) ?? null };
    this.#layers.add(entry);
    return () => {
      if (!this.#layers.delete(entry)) return;
      entry.remove?.();
      entry.remove = null;
    };
  }

  /** @internal */
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
    // One of the page's regions, not its main landmark.
    stage.asRegion();
    this.shadow.append(stage.el);
    // Content slotted before the stage was built.
    stage.slotted();
    // This stage's own view of the shared session: canvas, camera, framing, minimap.
    const view = new StageView(ctx.controller);
    view.version = this.#version;
    stage.view = view;
    stage.setVersion(this.#version);
    release(ctx.controller.addView(view));
    // The stage adds its own minimap to the view (unless a slotted one replaces it).
    view.attach(stage.canvasHost, null);
    view.setChrome(() => stage.chromeLayout());
    this.#setView(view);
    // Layers added before there was a renderer, or to the one before this binding.
    for (const entry of this.#layers) entry.remove = view.addLayer(entry.layer);
    release(() => {
      this.#setView(null);
      view.setChrome(null);
      // The view's renderer goes, and its layers with it.
      for (const entry of this.#layers) entry.remove = null;
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
    'kgdiff-stage': KgdiffStageElement;
  }
}
