/**
 * The public elements (RFC 0001 §3, phase 2): binding in every topology, the stage's slots as
 * obstacles, the root's keyboard map (forwarding, `shortcuts`, `keymap`), the `search` focus
 * target and the change list stepping aside, tokens for elements outside the root.
 */
import { getTheme } from '@kgdiff/scene';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../src/context.js';
import { ViewerController } from '../src/controller.js';
import { stageContext } from '../src/elements/stage.js';
import type { ChromeLayout } from '../src/framing.js';
import '../src/index.js';
import type { KgdiffRootElement, KgdiffStageElement } from '../src/index.js';
import { LAYOUT_KEY } from '../src/layout-store.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { tokenSheet } from '../src/theme.js';
import { mockBackend, tick, until, zoo } from './support.js';

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

type Root = KgdiffRootElement & { controller: ViewerController };

/** Build `html` in the body; returns the element of `selector`. */
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

const rows = (el: Element): number => el.shadowRoot?.querySelectorAll('.row').length ?? 0;

function press(target: EventTarget, key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

/** The element focused, through shadow roots. */
function focused(): Element | null {
  let at = document.activeElement;
  while (at?.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
  return at;
}

describe('binding', () => {
  it('binds a child, and one inside another component’s shadow root', async () => {
    const root = place<Root>(
      '<kgdiff-root><kgdiff-change-list></kgdiff-change-list><section id="host"></section></kgdiff-root>',
    );
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div><kgdiff-change-detail></kgdiff-change-detail></div>';
    await loaded(root);
    expect(rows(document.querySelector('kgdiff-change-list') as Element)).toBeGreaterThan(0);
    root.next();
    root.controller.flush();
    const detail = shadow.querySelector('kgdiff-change-detail') as Element;
    expect(detail.shadowRoot?.querySelector('.d-title')?.textContent).not.toBe('');
  });

  it('binds through for= to a root elsewhere on the page, and to a root that comes later', async () => {
    place('<aside><kgdiff-change-list for="later"></kgdiff-change-list></aside>', 'aside');
    const list = document.querySelector('kgdiff-change-list') as Element;
    expect(list.shadowRoot?.childElementCount).toBe(0);
    const root = place<Root>('<main><kgdiff-root id="later"></kgdiff-root></main>');
    await loaded(root);
    expect(rows(list)).toBeGreaterThan(0);
  });

  it('binds children of a root that joins the document later', async () => {
    const root = document.createElement('kgdiff-root') as Root;
    const list = document.createElement('kgdiff-change-list');
    root.append(list);
    const wrapper = document.createElement('div');
    wrapper.append(root);
    // Connected inside a wrapper that joins the document later.
    document.body.append(wrapper);
    await loaded(root);
    expect(rows(list)).toBeGreaterThan(0);
  });

  it('keeps two roots on one page apart: lists, keys and announcements', async () => {
    place(`
      <kgdiff-root id="a"><kgdiff-change-list></kgdiff-change-list></kgdiff-root>
      <kgdiff-root id="b"><kgdiff-change-list></kgdiff-change-list></kgdiff-root>`);
    const [a, b] = [...document.querySelectorAll('kgdiff-root')] as Root[];
    if (!a || !b) throw new Error('two roots');
    await Promise.all([loaded(a), loaded(b)]);
    const listA = a.querySelector('kgdiff-change-list') as Element;
    const listB = b.querySelector('kgdiff-change-list') as Element;
    const listbox = listA.shadowRoot?.querySelector('.list') as HTMLElement;
    press(listbox, 'j');
    press(listbox, 'j');
    expect(a.controller.selectedHunk).toBeGreaterThanOrEqual(0);
    expect(b.controller.selectedHunk).toBe(-1);
    await tick(60);
    const announced = (r: Element): string =>
      r.shadowRoot?.querySelector('[aria-live]')?.textContent ?? '';
    expect(announced(a)).toMatch(/^Change 2 of \d+: /);
    expect(announced(b)).toBe('');
    expect(rows(listB)).toBeGreaterThan(0);
  });

  it('binds again when for changes, and to <kgdiff-viewer> too', async () => {
    place('<kgdiff-viewer id="v"></kgdiff-viewer><kgdiff-root id="r"></kgdiff-root>', 'body');
    const viewer = document.getElementById('v') as Root;
    const root = document.getElementById('r') as Root;
    await Promise.all([loaded(viewer), loaded(root)]);
    const detail = document.createElement('kgdiff-change-detail');
    detail.setAttribute('for', 'v');
    document.body.append(detail);
    viewer.next();
    viewer.controller.flush();
    const title = (): string | null | undefined =>
      detail.shadowRoot?.querySelector('.d-title')?.textContent;
    expect(title()).toBeTruthy();
    detail.setAttribute('for', 'r');
    // The other root has nothing selected.
    expect(detail.shadowRoot?.querySelector('.d-title')).toBeNull();
    root.next();
    root.controller.flush();
    expect(title()).toBeTruthy();
  });

  it('gives elements outside the root its token set; inside they inherit it', async () => {
    place(`<kgdiff-root id="t" theme="light"><kgdiff-filters></kgdiff-filters></kgdiff-root>
      <kgdiff-filters for="t" id="out"></kgdiff-filters>`);
    const root = document.getElementById('t') as Root;
    await loaded(root);
    const light = tokenSheet(getTheme('light'), document);
    const sheets = (id: string | null): readonly CSSStyleSheet[] =>
      (id ? document.getElementById(id) : root.querySelector('kgdiff-filters'))?.shadowRoot
        ?.adoptedStyleSheets ?? [];
    expect(sheets('out')).toContain(light);
    expect(sheets(null)).not.toContain(light);
    root.theme = 'dark';
    await tick();
    expect(sheets('out')).toContain(tokenSheet(getTheme('dark'), document));
  });
});

describe('<kgdiff-stage>', () => {
  /** The chrome layout the stage gives the controller (framing reads it at every fit). */
  function chromeOf(): () => ChromeLayout {
    let provider: (() => ChromeLayout) | null = null;
    vi.spyOn(ViewerController.prototype, 'setChrome').mockImplementation((p) => {
      if (p) provider = p;
    });
    return () => {
      if (!provider) throw new Error('no chrome layout');
      return provider();
    };
  }

  const rect = (el: Element, x: number, y: number, w: number, h: number): void => {
    el.getBoundingClientRect = () => new DOMRect(x, y, w, h);
  };

  it('draws the root’s canvas and keeps slotted content clear of fits and flights', async () => {
    const chrome = chromeOf();
    const root = place<Root>(`<kgdiff-root><kgdiff-stage>
      <div slot="top-end" id="card">card</div><span slot="bogus">no slot</span>
    </kgdiff-stage></kgdiff-root>`);
    const stage = root.querySelector('kgdiff-stage') as KgdiffStageElement;
    await loaded(root);
    expect(stage.shadowRoot?.querySelector('canvas')).not.toBeNull();
    const names = [...(stage.shadowRoot?.querySelectorAll('slot') ?? [])].map((s) => s.name);
    expect(names.sort()).toEqual([
      'bottom-center',
      'bottom-end',
      'bottom-start',
      'top-end',
      'top-start',
    ]);
    rect(stage.shadowRoot?.querySelector('.stage-wrap') as Element, 100, 50, 800, 600);
    rect(document.getElementById('card') as Element, 640, 62, 248, 120);
    expect(chrome().obstacles).toContainEqual({ x: 540, y: 12, width: 248, height: 120 });
  });

  it('takes obstacles registered on the element and through the stage context', async () => {
    const chrome = chromeOf();
    const root = place<Root>(
      '<kgdiff-root><kgdiff-stage><p id="deep"></p></kgdiff-stage></kgdiff-root>',
    );
    const stage = root.querySelector('kgdiff-stage') as KgdiffStageElement;
    const floating = document.createElement('div');
    document.body.append(floating);
    // Registered before the stage is bound: kept.
    const off = stage.registerObstacle(floating);
    await loaded(root);
    rect(stage.shadowRoot?.querySelector('.stage-wrap') as Element, 0, 0, 800, 600);
    rect(floating, 10, 20, 30, 40);
    const deep = document.getElementById('deep') as HTMLElement;
    rect(deep, 400, 300, 50, 50);
    let viaContext: (() => void) | undefined;
    requestContext(deep, stageContext, (ctx) => {
      viaContext = ctx.registerObstacle(deep);
    });
    expect(viaContext).toBeTypeOf('function');
    expect(chrome().obstacles).toEqual(
      expect.arrayContaining([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: 400, y: 300, width: 50, height: 50 },
      ]),
    );
    off();
    viaContext?.();
    expect(chrome().obstacles).toEqual([]);
  });

  it('draws one stage per root for now; a second stays empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = place<Root>(
      '<kgdiff-root><kgdiff-stage></kgdiff-stage><kgdiff-stage></kgdiff-stage></kgdiff-root>',
    );
    await loaded(root);
    const [first, second] = [...root.querySelectorAll('kgdiff-stage')];
    expect(first?.shadowRoot?.querySelector('canvas')).not.toBeNull();
    expect(second?.shadowRoot?.childElementCount).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    // The first one leaves: the canvas goes, and a stage connected later takes it.
    first?.remove();
    second?.remove();
    root.append(second as Element);
    expect(second?.shadowRoot?.querySelector('canvas')).not.toBeNull();
  });
});

describe('keyboard', () => {
  it('forwards keys from elements bound with for to their root', async () => {
    place(`<kgdiff-root id="k"><kgdiff-stage></kgdiff-stage></kgdiff-root>
      <nav><kgdiff-change-list for="k"></kgdiff-change-list></nav>`);
    const root = document.getElementById('k') as Root;
    await loaded(root);
    const list = document.querySelector('kgdiff-change-list') as Element;
    const listbox = list.shadowRoot?.querySelector('.list') as HTMLElement;
    press(listbox, 'j');
    expect(root.controller.selectedHunk).toBe(root.controller.list.order[0]);
    press(listbox, 'j');
    press(listbox, 'k');
    expect(root.controller.selectedHunk).toBe(root.controller.list.order[0]);
    press(listbox, '2');
    expect(root.mode).toBe('swipe');
  });

  it('focuses the search registered last that is shown, on /', async () => {
    place(`<kgdiff-root id="s"><kgdiff-stage></kgdiff-stage></kgdiff-root>
      <header><kgdiff-search for="s" id="one"></kgdiff-search></header>`);
    const root = document.getElementById('s') as Root;
    await loaded(root);
    const canvas = root
      .querySelector('kgdiff-stage')
      ?.shadowRoot?.querySelector('canvas') as HTMLElement;
    const input = (id: string): HTMLInputElement =>
      document.getElementById(id)?.shadowRoot?.querySelector('input') as HTMLInputElement;
    press(canvas, '/');
    expect(focused()).toBe(input('one'));
    const two = document.createElement('kgdiff-search');
    two.id = 'two';
    two.setAttribute('for', 's');
    document.body.append(two);
    press(canvas, '/');
    expect(focused()).toBe(input('two'));
    two.hidden = true;
    press(canvas, '/');
    expect(focused()).toBe(input('one'));
    two.remove();
    document.getElementById('one')?.remove();
    // No search on the page: nothing happens.
    canvas.focus();
    expect(() => press(canvas, '/')).not.toThrow();
  });

  it('lets the change list step aside while the session has a search', async () => {
    const root = place<Root>(`<kgdiff-root><kgdiff-search></kgdiff-search>
      <kgdiff-change-list></kgdiff-change-list></kgdiff-root>`);
    await loaded(root);
    const search = root.querySelector('kgdiff-search') as Element;
    const list = root.querySelector('kgdiff-change-list') as Element;
    const input = search.shadowRoot?.querySelector('input') as HTMLInputElement;
    const listbox = list.shadowRoot?.querySelector('.list') as HTMLElement;
    input.value = 'gecko';
    input.dispatchEvent(new Event('input'));
    expect(listbox.hidden).toBe(true);
    const results = search.shadowRoot?.querySelector('#kg-results') as HTMLElement;
    expect(results.hidden).toBe(false);
    expect(input.getAttribute('aria-controls')).toBe('kg-results');
    expect(input.getAttribute('aria-activedescendant')).toBe('kg-hit-0');
    // Choosing a hit selects it and moves focus to the list, through the root.
    press(input, 'Enter');
    await until(() => root.controller.selectedNode >= 0 || root.controller.selectedHunk >= 0);
    expect(listbox.hidden).toBe(false);
    expect(focused()).toBe(listbox);
  });

  it('applies shortcuts="global" (and the global-shortcuts alias) and shortcuts="none"', async () => {
    const root = place<Root>(
      '<kgdiff-root shortcuts="global"><kgdiff-change-list></kgdiff-change-list></kgdiff-root>',
    );
    await loaded(root);
    expect(root.shortcuts).toBe('global');
    press(document.body, '2');
    expect(root.mode).toBe('swipe');
    root.removeAttribute('shortcuts');
    root.setAttribute('global-shortcuts', '');
    expect(root.shortcuts).toBe('global');
    press(document.body, '3');
    expect(root.mode).toBe('replay');
    root.shortcuts = 'none';
    press(document.body, '1');
    const listbox = root
      .querySelector('kgdiff-change-list')
      ?.shadowRoot?.querySelector('.list') as HTMLElement;
    press(listbox, '1');
    expect(root.mode).toBe('replay');
    // A focused list keeps its own keys.
    press(listbox, 'ArrowDown');
    expect(root.controller.selectedHunk).toBe(root.controller.list.order[0]);
    root.shortcuts = 'scoped';
    press(document.body, '1');
    expect(root.mode).toBe('replay');
    press(listbox, '1');
    expect(root.mode).toBe('overlay');
  });

  it('rebinds and unbinds single keys with keymap, as data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = place<Root>(
      '<kgdiff-root keymap="j:none n:next Space:fit q:bogus"><kgdiff-change-list></kgdiff-change-list></kgdiff-root>',
    );
    await loaded(root);
    expect(warn).toHaveBeenCalledOnce();
    expect(root.keymap).toEqual({ j: null, n: 'next', ' ': 'fit' });
    const listbox = root
      .querySelector('kgdiff-change-list')
      ?.shadowRoot?.querySelector('.list') as HTMLElement;
    press(listbox, 'j');
    expect(root.controller.selectedHunk).toBe(-1);
    press(listbox, 'n');
    expect(root.controller.selectedHunk).toBe(root.controller.list.order[0]);
    root.keymap = { k: null };
    expect(root.keymap).toEqual({ k: null });
    press(listbox, 'j');
    expect(root.controller.selectedHunk).toBe(root.controller.list.order[1]);
    press(listbox, 'k');
    expect(root.controller.selectedHunk).toBe(root.controller.list.order[1]);
    root.keymap = null;
    press(listbox, 'k');
    expect(root.controller.selectedHunk).toBe(root.controller.list.order[0]);
  });

  it('takes keys inside a nested root for the nearest root only', async () => {
    const outer = place<Root>(`<kgdiff-root id="outer"><kgdiff-root id="inner">
      <kgdiff-change-list></kgdiff-change-list></kgdiff-root></kgdiff-root>`);
    const inner = document.getElementById('inner') as Root;
    await Promise.all([loaded(outer), loaded(inner)]);
    const listbox = inner
      .querySelector('kgdiff-change-list')
      ?.shadowRoot?.querySelector('.list') as HTMLElement;
    press(listbox, '2');
    expect([inner.mode, outer.mode]).toEqual(['swipe', 'overlay']);
  });
});

describe('<kgdiff-root>', () => {
  it('has the methods and events of a root, refreshTheme, and remembers nothing', async () => {
    const root = place<Root>('<kgdiff-root><kgdiff-stage></kgdiff-stage></kgdiff-root>');
    const ready = vi.fn();
    root.addEventListener('kgdiff-ready', ready);
    await loaded(root);
    expect(ready).toHaveBeenCalledOnce();
    expect(root.reviewState().total).toBeGreaterThan(0);
    root.style.setProperty('--kgdiff-accent', '#ff00ff');
    root.refreshTheme();
    await tick();
    expect(backend.last().theme.accent.base).toBe('#ff00ff');
    const stage = root.querySelector('kgdiff-stage') as Element;
    press(stage.shadowRoot?.querySelector('canvas') as HTMLElement, 't');
    expect(root.theme).toBe('light');
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });
});
