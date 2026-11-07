/**
 * The chrome elements (RFC 0001 §3, phase 3): slotted into a stage they replace its built-in
 * region while `panels` keeps applying to the rest; zoom and the minimap act on one stage's
 * view (the nearest, or `stage="<id>"`), the others on the session; placed outside a stage they
 * are no obstacle unless registered.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index.js';
import type { ChromeLayout } from '../src/framing.js';
import type {
  KgdiffLegendElement,
  KgdiffMinimapElement,
  KgdiffRootElement,
  KgdiffStageBoundElement,
  KgdiffStageElement,
} from '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import type { DiffSession } from '../src/session.js';
import { STYLES } from '../src/styles.js';
import { StageView } from '../src/view.js';
import { MockMinimap, type MockRenderer, mockBackend, tick, zoo } from './support.js';

/**
 * happy-dom has no `ElementInternals`: custom states, enough to read them back (the elements
 * are constructed in the tests, after this runs).
 */
const states = new WeakMap<Element, Set<string>>();
const hadInternals = 'attachInternals' in HTMLElement.prototype;
if (!hadInternals) {
  Object.defineProperty(HTMLElement.prototype, 'attachInternals', {
    configurable: true,
    value(this: HTMLElement) {
      const set = new Set<string>();
      states.set(this, set);
      return { states: set };
    },
  });
}
afterAll(() => {
  if (hadInternals) return;
  delete (HTMLElement.prototype as { attachInternals?: unknown }).attachInternals;
});

let backend: ReturnType<typeof mockBackend>;

beforeEach(() => {
  backend = mockBackend();
  setRenderBackend(backend);
  localStorage.clear();
});

afterEach(() => {
  document.body.textContent = '';
  setRenderBackend(null);
  vi.restoreAllMocks();
});

type Root = KgdiffRootElement & { controller: DiffSession };

function place<T extends Element = HTMLElement>(html: string, selector = 'kgdiff-root'): T {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  document.body.append(tpl.content);
  return document.querySelector(selector) as T;
}

async function loaded(root: Root): Promise<void> {
  await root.load(zoo());
  await tick();
}

function press(target: EventTarget, key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

const $ = <T extends HTMLElement = HTMLElement>(el: Element, sel: string): T =>
  el.shadowRoot?.querySelector(sel) as T;

/** The renderer drawing `stage`'s canvas. */
function rendererOf(stage: Element): MockRenderer {
  const r = backend.renderers.find((r) => (r.canvas.getRootNode() as ShadowRoot).host === stage);
  if (!r) throw new Error(`no renderer for #${stage.id}`);
  return r;
}

describe('slotted into a stage', () => {
  it('replaces the built-in region, while panels keeps applying to the rest', async () => {
    const root = place<Root>(`<kgdiff-root><kgdiff-stage panels="zoom:hidden">
      <kgdiff-legend slot="bottom-start"></kgdiff-legend>
      <kgdiff-view-dock slot="top-start"></kgdiff-view-dock>
    </kgdiff-stage></kgdiff-root>`);
    const stage = root.querySelector('kgdiff-stage') as KgdiffStageElement;
    await loaded(root);
    expect($(stage, '.legend').dataset.panel).toBe('hidden');
    expect($(stage, '.dock-bar').dataset.panel).toBe('hidden');
    expect($(stage, '.zoom-bar').dataset.panel).toBe('hidden');
    expect($(stage, '.minimap-host').dataset.panel).toBe('open');
    expect($(stage, '.transport').dataset.panel).toBe('open');
    // The elements show the same UI the stage built in.
    const legend = root.querySelector('kgdiff-legend') as Element;
    expect($(legend, '.legend .legend-head')).not.toBeNull();
    const dock = root.querySelector('kgdiff-view-dock') as Element;
    expect(dock.shadowRoot?.querySelectorAll('[role="radio"]').length).toBeGreaterThan(1);
    // Taken out again: the stage's own comes back, as panels says.
    legend.remove();
    await tick();
    expect($(stage, '.legend').dataset.panel).toBe('collapsed');
    stage.panels = { zoom: 'open', dock: 'collapsed' };
    expect($(stage, '.zoom-bar').dataset.panel).toBe('open');
    expect($(stage, '.dock-bar').dataset.panel).toBe('hidden');
    dock.remove();
    await tick();
    expect($(stage, '.dock-bar').dataset.panel).toBe('collapsed');
  });

  it('keeps the user’s toggle of the built-in legend when another region is replaced', async () => {
    const root = place<Root>('<kgdiff-root><kgdiff-stage></kgdiff-stage></kgdiff-root>');
    const stage = root.querySelector('kgdiff-stage') as KgdiffStageElement;
    await loaded(root);
    $<HTMLButtonElement>(stage, '.legend-head').click();
    expect($(stage, '.legend').dataset.open).toBe('true');
    const zoom = document.createElement('kgdiff-zoom');
    zoom.slot = 'bottom-end';
    stage.append(zoom);
    await tick();
    expect($(stage, '.zoom-bar').dataset.panel).toBe('hidden');
    expect($(stage, '.legend').dataset.open).toBe('true');
  });
});

describe('<kgdiff-zoom> and <kgdiff-minimap>', () => {
  it('act on the view of the nearest stage, or of the one stage= names', async () => {
    const root = place<Root>(`<kgdiff-root>
      <kgdiff-stage id="s1"><kgdiff-zoom slot="bottom-end"></kgdiff-zoom></kgdiff-stage>
      <kgdiff-stage id="s2"></kgdiff-stage>
    </kgdiff-root>
    <kgdiff-zoom id="far" stage="s2"></kgdiff-zoom>`);
    const [s1, s2] = [...root.querySelectorAll('kgdiff-stage')] as KgdiffStageElement[];
    if (!s1 || !s2) throw new Error('two stages');
    await loaded(root);
    const near = s1.querySelector('kgdiff-zoom') as KgdiffStageBoundElement;
    const far = document.getElementById('far') as KgdiffStageBoundElement;
    expect(near.stage).toBe('');
    expect(near.stageElement).toBe(s1);
    expect(far.stage).toBe('s2');
    expect(far.stageElement).toBe(s2);
    // Every element says which root it shows: the stage's.
    expect(near.rootElement).toBe(root);
    expect(far.rootElement).toBe(root);
    const zoomIn = (el: Element) => $<HTMLButtonElement>(el, '.zoom-bar button').click();
    zoomIn(near);
    expect(rendererOf(s1).camera.zooms).toHaveLength(1);
    expect(rendererOf(s2).camera.zooms).toHaveLength(0);
    zoomIn(far);
    expect(rendererOf(s2).camera.zooms).toHaveLength(1);
    // The built-in buttons act on their own stage too.
    zoomIn(s2);
    expect(rendererOf(s2).camera.zooms).toHaveLength(2);
    expect(rendererOf(s1).camera.zooms).toHaveLength(1);
    // The property and the attribute are one: changing either binds again.
    far.stage = 's1';
    expect(far.getAttribute('stage')).toBe('s1');
    expect(far.stageElement).toBe(s1);
    zoomIn(far);
    expect(rendererOf(s1).camera.zooms).toHaveLength(2);
    far.removeAttribute('stage');
    expect(far.stage).toBe('');
    expect(far.stageElement).toBeNull();
    expect(far.rootElement).toBeNull();
    // '' is the nearest stage: no attribute.
    far.stage = 's2';
    far.stage = '';
    expect(far.hasAttribute('stage')).toBe(false);
    expect(far.shadowRoot?.childElementCount).toBe(0);
  });

  it('wait for a stage that comes later, and follow it when it binds again', async () => {
    const zoom = place<KgdiffStageBoundElement>(
      '<kgdiff-zoom stage="later"></kgdiff-zoom>',
      'kgdiff-zoom',
    );
    expect(zoom.stageElement).toBeNull();
    const root = place<Root>('<kgdiff-root><kgdiff-stage id="later"></kgdiff-stage></kgdiff-root>');
    const stage = root.querySelector('kgdiff-stage') as KgdiffStageElement;
    await loaded(root);
    expect(zoom.stageElement).toBe(stage);
    expect($(zoom, '.zoom-bar')).not.toBeNull();
    // The stage moves to another root: a new view, which the buttons follow.
    const other = place<Root>('<kgdiff-root id="other"></kgdiff-root>', '#other');
    other.append(stage);
    await loaded(other);
    $<HTMLButtonElement>(zoom, '.zoom-bar button').click();
    expect(rendererOf(stage).camera.zooms).toHaveLength(1);
  });

  it('draw a minimap of the stage’s view, in the overview state while it all fits', async () => {
    const destroyed = vi.spyOn(MockMinimap.prototype, 'destroy');
    const root = place<Root>(`<kgdiff-root><kgdiff-stage>
      <kgdiff-minimap slot="bottom-end"></kgdiff-minimap>
    </kgdiff-stage></kgdiff-root>`);
    const stage = root.querySelector('kgdiff-stage') as KgdiffStageElement;
    const minimap = root.querySelector('kgdiff-minimap') as KgdiffMinimapElement;
    await loaded(root);
    await tick(20);
    // This one only: the stage creates none of its own while it is replaced.
    expect(backend.minimaps).toHaveLength(1);
    expect($(stage, '.minimap-host').dataset.panel).toBe('hidden');
    expect($(stage, '.minimap-host').childElementCount).toBe(0);
    expect($(minimap, '.minimap-host').getAttribute('aria-label')).toBeTruthy();
    expect(minimap.overview).toBe(true);
    expect(states.get(minimap)?.has('overview')).toBe(true);
    // A custom state, not an attribute: the host's attributes are the page's.
    expect(minimap.hasAttribute('overview')).toBe(false);
    // Slotted into a stage it replaces the stage's own, and hides in overview as that one does.
    expect(STYLES).toContain('::slotted(kgdiff-minimap:state(overview)) { display: none; }');
    // The user zooms in on the canvas.
    const r = rendererOf(stage);
    r.camera.zoomBy(4);
    r.emit('camera', { ...r.camera.state, source: 'user' });
    root.controller.flush();
    expect(minimap.overview).toBe(false);
    expect(states.get(minimap)?.has('overview')).toBe(false);
    minimap.remove();
    expect(destroyed).toHaveBeenCalledOnce();
    // Taken out: the stage's own comes back, drawn again.
    await tick();
    expect(backend.minimaps).toHaveLength(2);
    expect($(stage, '.minimap-host').dataset.panel).toBe('open');
    await tick(20);
    expect(backend.minimaps[1]?.updates).toBeGreaterThan(0);
  });

  it('keep a minimap the page places shown in overview, the state set for its CSS', async () => {
    const root = place<Root>(`<kgdiff-root><kgdiff-stage id="s"></kgdiff-stage></kgdiff-root>
      <aside><kgdiff-minimap stage="s"></kgdiff-minimap></aside>`);
    const minimap = document.querySelector('kgdiff-minimap') as KgdiffMinimapElement;
    await loaded(root);
    await tick(20);
    expect(minimap.overview).toBe(true);
    expect(states.get(minimap)?.has('overview')).toBe(true);
    expect(minimap.attributes).toHaveLength(1);
    // The element's own rules leave it shown: the page opts in to hiding it.
    const rules = (minimap.shadowRoot?.adoptedStyleSheets ?? []).flatMap((sheet) =>
      [...sheet.cssRules].map((rule) => rule.cssText),
    );
    expect(rules.some((rule) => rule.startsWith(':host'))).toBe(true);
    expect(rules.filter((rule) => rule.startsWith(':host') && rule.includes('overview'))).toEqual(
      [],
    );
    // Unbound, it is not in overview.
    minimap.remove();
    expect(minimap.overview).toBe(false);
    expect(states.get(minimap)?.has('overview')).toBe(false);
  });

  it('are no obstacle outside the stage unless registered', async () => {
    let provider: (() => ChromeLayout) | null = null;
    vi.spyOn(StageView.prototype, 'setChrome').mockImplementation((p) => {
      if (p) provider = p;
    });
    const root = place<Root>(`<kgdiff-root><kgdiff-stage id="s"></kgdiff-stage></kgdiff-root>
      <kgdiff-zoom stage="s"></kgdiff-zoom>`);
    const stage = root.querySelector('kgdiff-stage') as KgdiffStageElement;
    const zoom = document.querySelector('kgdiff-zoom') as HTMLElement;
    await loaded(root);
    const chrome = (): ChromeLayout => {
      if (!provider) throw new Error('no chrome layout');
      return provider();
    };
    $(stage, '.stage-wrap').getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    zoom.getBoundingClientRect = () => new DOMRect(700, 500, 40, 90);
    const outside = { x: 700, y: 500, width: 40, height: 90 };
    expect(chrome().obstacles).not.toContainEqual(outside);
    const off = stage.registerObstacle(zoom);
    expect(chrome().obstacles).toContainEqual(outside);
    off();
    expect(chrome().obstacles).not.toContainEqual(outside);
  });
});

describe('the session’s chrome', () => {
  it('<kgdiff-legend>: variant and open, reflected both ways', async () => {
    const root = place<Root>(
      '<kgdiff-root id="r"></kgdiff-root><kgdiff-legend for="r" open></kgdiff-legend>',
    );
    const legend = document.querySelector('kgdiff-legend') as KgdiffLegendElement;
    await loaded(root);
    expect(legend.variant).toBe('full');
    expect(legend.open).toBe(true);
    expect($(legend, '.legend').dataset.open).toBe('true');
    // The user's toggle is reflected, as on <details>.
    $<HTMLButtonElement>(legend, '.legend-head').click();
    expect(legend.open).toBe(false);
    expect(legend.hasAttribute('open')).toBe(false);
    legend.open = true;
    expect($(legend, '.legend').dataset.open).toBe('true');
    legend.variant = 'mini';
    expect(legend.getAttribute('variant')).toBe('mini');
    expect(legend.shadowRoot?.firstElementChild?.className).toContain('mini-legend');
    expect($(legend, '.mini-legend').textContent).not.toBe('');
    legend.setAttribute('variant', 'huge');
    expect(legend.variant).toBe('full');
    expect(legend.shadowRoot?.firstElementChild?.className).toContain('legend card');
    legend.variant = 'full';
    expect(legend.hasAttribute('variant')).toBe(false);
  });

  it('<kgdiff-transport> shows in replay only; <kgdiff-view-dock> sets the mode', async () => {
    const root = place<Root>(`<kgdiff-root id="r"></kgdiff-root>
      <kgdiff-view-dock for="r"></kgdiff-view-dock><kgdiff-transport for="r"></kgdiff-transport>`);
    const transport = document.querySelector('kgdiff-transport') as Element;
    const dock = document.querySelector('kgdiff-view-dock') as Element;
    await loaded(root);
    expect($(transport, '.transport').hidden).toBe(true);
    $<HTMLButtonElement>(dock, '[data-mode="replay"]').click();
    expect(root.mode).toBe('replay');
    root.controller.flush();
    expect($(transport, '.transport').hidden).toBe(false);
    expect($(dock, '[data-mode="replay"]').getAttribute('aria-checked')).toBe('true');
    expect($(transport, '[role="slider"]')).not.toBeNull();
  });

  it('<kgdiff-title> names the versions compared', async () => {
    const root = place<Root>('<kgdiff-root><kgdiff-title></kgdiff-title></kgdiff-root>');
    const title = root.querySelector('kgdiff-title') as Element;
    expect($(title, '.hud-title').dataset.titled).toBe('false');
    await loaded(root);
    expect($(title, '.hud-title').dataset.titled).toBe('true');
    expect($(title, '.versions').getAttribute('role')).toBe('group');
  });

  it('<kgdiff-actions>: the appearance menu, and the shortcuts dialog that ? opens', async () => {
    const root = place<Root>(
      '<kgdiff-root><kgdiff-stage></kgdiff-stage><kgdiff-actions></kgdiff-actions></kgdiff-root>',
    );
    const actions = root.querySelector('kgdiff-actions') as Element;
    const stage = root.querySelector('kgdiff-stage') as Element;
    await loaded(root);
    // The menu and the help; no sidebar in a composed root, so no sidebar toggle.
    const buttons = [...(actions.shadowRoot?.querySelectorAll('.hud-actions button') ?? [])];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Display settings',
      'Keyboard shortcuts (?)',
    ]);
    const button = $<HTMLButtonElement>(actions, '.hud-actions button');
    button.click();
    expect($(actions, '[role="menu"]').hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // A press elsewhere closes it.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect($(actions, '[role="menu"]').hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(press(stage, '?').defaultPrevented).toBe(true);
    expect($(actions, '.overlay-scrim').hidden).toBe(false);
    expect($(actions, '[role="dialog"]').getAttribute('aria-modal')).toBe('true');
  });

  it('lists the keys bound after keymap in the shortcuts dialog, and no sidebar key', async () => {
    const root = place<Root>(
      '<kgdiff-root keymap="x:none r:review 2:none"><kgdiff-actions></kgdiff-actions></kgdiff-root>',
    );
    const actions = root.querySelector('kgdiff-actions') as Element;
    await loaded(root);
    press(actions, '?');
    const rows = [...(actions.shadowRoot?.querySelectorAll('.key-row') ?? [])].map((row) => [
      row.firstElementChild?.textContent,
      [...row.querySelectorAll('kbd')].map((k) => k.textContent).join(' '),
    ]);
    expect(rows).toContainEqual(['Mark as reviewed', 'r']);
    // The modes, one key each no longer: a row each, swipe left out.
    expect(rows).toContainEqual(['Overlay', '1']);
    expect(rows).toContainEqual(['Replay', '3']);
    expect(rows.some(([label]) => label?.includes('Swipe'))).toBe(false);
    expect(rows.some(([, keys]) => keys === '\\')).toBe(false);
    expect(rows).toContainEqual(['Zoom in / Zoom out', '+ −']);
  });

  it('? does nothing in a composed root without <kgdiff-actions>', async () => {
    const root = place<Root>('<kgdiff-root><kgdiff-stage></kgdiff-stage></kgdiff-root>');
    await loaded(root);
    expect(() => press(root.querySelector('kgdiff-stage') as Element, '?')).not.toThrow();
  });
});

describe('in <kgdiff-viewer>', () => {
  type Viewer = Root & { readonly shadowRoot: ShadowRoot };

  it('takes the page’s content in the stage’s slots, as obstacles', async () => {
    let provider: (() => ChromeLayout) | null = null;
    vi.spyOn(StageView.prototype, 'setChrome').mockImplementation((p) => {
      if (p) provider = p;
    });
    const viewer = place<Viewer>(
      '<kgdiff-viewer><aside slot="top-end" id="card">card</aside></kgdiff-viewer>',
      'kgdiff-viewer',
    );
    await loaded(viewer);
    const card = document.getElementById('card') as HTMLElement;
    const slot = viewer.shadowRoot.querySelector('slot[name="top-end"]') as HTMLSlotElement;
    expect(slot.assignedElements()).toEqual([card]);
    $(viewer, '.stage-wrap').getBoundingClientRect = () => new DOMRect(0, 0, 1000, 700);
    card.getBoundingClientRect = () => new DOMRect(700, 64, 288, 100);
    const chrome = provider as (() => ChromeLayout) | null;
    if (!chrome) throw new Error('no chrome layout');
    expect(chrome().obstacles).toContainEqual({ x: 700, y: 64, width: 288, height: 100 });
  });

  it('lets a chrome element replace a built-in region; panels keeps applying to the rest', async () => {
    const viewer = place<Viewer>(
      `<kgdiff-viewer panels="dock:collapsed">
        <kgdiff-legend slot="bottom-start" variant="mini"></kgdiff-legend>
        <kgdiff-zoom slot="bottom-end"></kgdiff-zoom>
      </kgdiff-viewer>`,
      'kgdiff-viewer',
    );
    await loaded(viewer);
    expect($(viewer, '.legend').dataset.panel).toBe('hidden');
    expect($(viewer, '.zoom-bar').dataset.panel).toBe('hidden');
    expect($(viewer, '.minimap-host').dataset.panel).toBe('open');
    expect($(viewer, '.dock-bar').dataset.panel).toBe('collapsed');
    // The viewer's own minimap, drawn: nothing slotted replaces it.
    expect(backend.minimaps).toHaveLength(1);
    const legend = viewer.querySelector('kgdiff-legend') as KgdiffLegendElement;
    expect(legend.rootElement).toBe(viewer);
    expect($(legend, '.mini-legend')).not.toBeNull();
    // The zoom buttons act on the viewer's built-in stage.
    const zoom = viewer.querySelector('kgdiff-zoom') as KgdiffStageBoundElement;
    expect(zoom.stageElement).toBe(viewer);
    $<HTMLButtonElement>(zoom, '.zoom-bar button').click();
    expect(backend.last().camera.zooms).toHaveLength(1);
  });

  it('lets a slotted title or actions replace the HUD’s, as every chrome element does', async () => {
    const viewer = place<Viewer & { layout: { panels: Record<string, string> } }>(
      `<kgdiff-viewer>
        <kgdiff-title slot="top-start"></kgdiff-title>
        <kgdiff-actions slot="top-end"></kgdiff-actions>
      </kgdiff-viewer>`,
      'kgdiff-viewer',
    );
    await loaded(viewer);
    expect($(viewer, '.hud-title').dataset.panel).toBe('hidden');
    expect($(viewer, '.hud-end').dataset.panel).toBe('hidden');
    expect($(viewer, '.hud-end').inert).toBe(true);
    // The page's declaration and the resolved states are unchanged: the region is replaced.
    expect(viewer.layout.panels.title).toBe('open');
    // The corners move up into the HUD's place, so the elements sit where it did.
    expect($(viewer, '.stage-wrap').dataset.hud).toBe('');
    // Bound to a viewer, the actions have its sidebar toggle, kept up with the layout.
    const actions = viewer.querySelector('kgdiff-actions') as Element;
    const buttons = [...(actions.shadowRoot?.querySelectorAll('.hud-actions button') ?? [])];
    expect(buttons).toHaveLength(3);
    const toggle = buttons[2] as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(viewer.layout.panels.list).toBe('collapsed');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    viewer.setAttribute('panels', 'list:hidden detail:hidden search:hidden filters:hidden');
    expect(toggle.hidden).toBe(true);
    // Taken out, the HUD's own come back.
    viewer.querySelector('kgdiff-title')?.remove();
    actions.remove();
    await tick();
    expect($(viewer, '.hud-title').dataset.panel).toBe('open');
    expect($(viewer, '.hud-end').dataset.panel).toBe('open');
    expect($(viewer, '.stage-wrap').dataset.hud).toBe('title actions');
  });
});
