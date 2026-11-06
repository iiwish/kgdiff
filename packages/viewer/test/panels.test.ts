/**
 * The default layout's panel states (RFC 0001 §4): `panels`, the presets it replaces, collapse
 * controls, splitters, `kgdiff-layout`, and what the layout remembers (and in which order a
 * region's state is decided: the host, then the user's earlier choice, then the report).
 */
import { diff, diffToJSON } from '@kgdiff/core';
import { layoutDiff, layoutToJSON } from '@kgdiff/layout';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KgdiffViewer } from '../src/element.js';
import '../src/index.js';
import type { ReportPayload, ViewerLayout } from '../src/index.js';
import { LAYOUT_KEY, readRemembered } from '../src/layout-store.js';
import {
  DEFAULT_PANELS,
  formatPanels,
  parsePanels,
  presetPanels,
  resolvePanels,
  toPanels,
} from '../src/panels.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { mockBackend, tick, until, zoo } from './support.js';

beforeEach(() => {
  setRenderBackend(mockBackend());
  localStorage.clear();
});

afterEach(() => {
  document.body.textContent = '';
  setRenderBackend(null);
  vi.restoreAllMocks();
});

function mount(attrs: Record<string, string> = {}): KgdiffViewer {
  const el = document.createElement('kgdiff-viewer') as unknown as KgdiffViewer;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

async function loaded(attrs: Record<string, string> = {}): Promise<KgdiffViewer> {
  const el = mount(attrs);
  await el.load(zoo());
  await tick();
  return el;
}

function payload(view?: ReportPayload['view']): ReportPayload {
  const graphs = zoo();
  const d = diff(graphs.before, graphs.after);
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: diffToJSON(d),
    layout: layoutToJSON(layoutDiff(d)),
    meta: { generator: 'test', before: { name: 'a' }, after: { name: 'b' } },
    ...(view !== undefined ? { view } : {}),
  };
}

async function ready(el: KgdiffViewer, p: ReportPayload): Promise<void> {
  let done = false;
  el.addEventListener('kgdiff-ready', () => {
    done = true;
  });
  el.payload = p;
  await until(() => done);
  await tick();
}

const $ = <T extends Element = HTMLElement>(el: Element, sel: string): T => {
  const found = el.shadowRoot?.querySelector<T>(sel);
  if (!found) throw new Error(`${sel} not found`);
  return found;
};

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init }),
  );
}

/** Record the `kgdiff-layout` events of `el`. */
function layouts(el: Element): (ViewerLayout & { source: string })[] {
  const seen: (ViewerLayout & { source: string })[] = [];
  el.addEventListener('kgdiff-layout', (e) =>
    seen.push((e as CustomEvent<ViewerLayout & { source: string }>).detail),
  );
  return seen;
}

const remember = (value: object): void =>
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, ...value }));

describe('panels syntax', () => {
  it('reads region:state pairs separated by spaces or commas, reporting the rest', () => {
    expect(parsePanels('detail:collapsed  minimap:hidden,legend:open')).toEqual({
      panels: { detail: 'collapsed', minimap: 'hidden', legend: 'open' },
      invalid: [],
    });
    expect(parsePanels('detail:shut sidebar:hidden detail detail:open:x list:open')).toEqual({
      panels: { list: 'open' },
      invalid: ['detail:shut', 'sidebar:hidden', 'detail', 'detail:open:x'],
    });
    expect(parsePanels('')).toEqual({ panels: {}, invalid: [] });
  });

  it('takes objects too, and writes the attribute form in region order', () => {
    expect(toPanels({ minimap: 'hidden', detail: 'collapsed', bogus: 'open' })).toEqual({
      panels: { minimap: 'hidden', detail: 'collapsed' },
      invalid: ['bogus:open'],
    });
    expect(formatPanels({ minimap: 'hidden', detail: 'collapsed' })).toBe(
      'detail:collapsed minimap:hidden',
    );
    expect(toPanels(null)).toEqual({ panels: {}, invalid: [] });
  });

  it('turns the existing switches into presets', () => {
    expect(presetPanels('closed', null, null)).toEqual({
      list: 'collapsed',
      detail: 'collapsed',
      search: 'collapsed',
      filters: 'collapsed',
    });
    expect(presetPanels(null, 'compact', null)).toEqual({ title: 'hidden' });
    const bare = presetPanels(null, null, 'none');
    expect(Object.keys(bare)).toHaveLength(10);
    expect(bare.legend).toBeUndefined();
    expect(Object.values(bare).every((s) => s === 'hidden')).toBe(true);
  });

  it('decides each region by the first level that names it', () => {
    const states = resolvePanels([{ detail: 'open' }, { detail: 'hidden', zoom: 'hidden' }, {}]);
    expect(states).toEqual({ ...DEFAULT_PANELS, detail: 'open', zoom: 'hidden' });
    expect(DEFAULT_PANELS.legend).toBe('collapsed');
  });
});

describe('<kgdiff-viewer panels>', () => {
  it('opens with today’s layout and reads every region’s state back', async () => {
    const el = await loaded();
    expect(el.panels).toEqual(DEFAULT_PANELS);
    expect($(el, '.sidebar').dataset.open).toBe('true');
    expect($(el, '.detail-wrap').dataset.state).toBe('open');
  });

  it('collapses the detail panel to its bar, inert, and opens it from the bar', async () => {
    const el = await loaded({ panels: 'detail:collapsed' });
    const seen = layouts(el);
    expect(el.panels.detail).toBe('collapsed');
    const bar = $<HTMLButtonElement>(el, '.detail-bar');
    expect($(el, '.detail-wrap').dataset.state).toBe('collapsed');
    expect($(el, '.detail').inert).toBe(true);
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    // The list and the rest of the sidebar stay.
    expect($(el, '.sidebar').dataset.open).toBe('true');
    // Updated while collapsed.
    el.next();
    el.controller.flush();
    expect($(el, '.d-title').textContent).not.toBe('');
    bar.click();
    expect(el.panels.detail).toBe('open');
    expect($(el, '.detail').inert).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe('user');
    expect(seen[0]?.panels.detail).toBe('open');
  });

  it('takes the object form as a property, reflected, warning about what it ignores', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = await loaded();
    const seen = layouts(el);
    el.panels = { detail: 'collapsed', minimap: 'hidden', nope: 'open' } as never;
    expect(warn).toHaveBeenCalledOnce();
    expect(el.getAttribute('panels')).toBe('detail:collapsed minimap:hidden');
    expect(el.panels).toEqual({ ...DEFAULT_PANELS, detail: 'collapsed', minimap: 'hidden' });
    expect(seen.map((e) => e.source)).toEqual(['host']);
    // Regions not named keep their default.
    el.panels = 'zoom:hidden';
    expect(el.panels).toEqual({ ...DEFAULT_PANELS, zoom: 'hidden' });
    el.panels = null;
    expect(el.hasAttribute('panels')).toBe(false);
    expect(el.panels).toEqual(DEFAULT_PANELS);
  });

  it('folds the sidebar when its four regions are collapsed, and \\ restores what was open', async () => {
    const el = await loaded({ panels: 'detail:collapsed' });
    press(el, '\\');
    expect($(el, '.sidebar').dataset.open).toBe('false');
    expect($(el, '.sidebar').inert).toBe(true);
    expect(el.getAttribute('sidebar')).toBe('closed');
    expect(el.panels).toMatchObject({
      list: 'collapsed',
      detail: 'collapsed',
      search: 'collapsed',
      filters: 'collapsed',
    });
    press(el, '\\');
    expect(el.getAttribute('sidebar')).toBe('open');
    expect(el.panels).toMatchObject({ list: 'open', detail: 'collapsed', search: 'open' });
  });

  it('folds the list to its title and the search and filters to buttons', async () => {
    const el = await loaded({ panels: 'list:collapsed search:collapsed filters:collapsed' });
    expect($(el, '.list-wrap').hidden).toBe(true);
    expect($(el, '.sb-title').hidden).toBe(false);
    expect($(el, '.search-wrap').hidden).toBe(true);
    expect($(el, '.filters-wrap').hidden).toBe(true);
    const buttons = el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.sb-row > .icon-btn');
    const shown = [...(buttons ?? [])].filter((b) => !b.hidden);
    expect(shown).toHaveLength(3);
    // A search shows its results in the list's place, even with the list folded.
    el.controller.setQuery('gecko');
    expect($(el, '.list-wrap').hidden).toBe(false);
    expect($(el, '#kg-results').hidden).toBe(false);
    el.controller.setQuery('');
    expect($(el, '.list-wrap').hidden).toBe(true);
    $<HTMLButtonElement>(el, '.list-toggle').click();
    expect(el.panels.list).toBe('open');
    expect($(el, '.list-wrap').hidden).toBe(false);
  });

  it('hides regions with no way back, and the sidebar with its toggle once all four are', async () => {
    const el = await loaded({ panels: 'list:hidden detail:hidden search:hidden filters:hidden' });
    expect($(el, '.sidebar').hidden).toBe(true);
    expect($<HTMLButtonElement>(el, '.hud-actions [aria-label^="Toggle sidebar"]').hidden).toBe(
      true,
    );
    press(el, '\\');
    expect(el.panels.list).toBe('hidden');
    press(el, '/');
    expect(el.panels.search).toBe('hidden');
  });

  it('applies the chrome regions to the canvas chrome', async () => {
    const el = await loaded({ panels: 'dock:hidden zoom:collapsed legend:open title:hidden' });
    expect($(el, '.dock-bar').dataset.panel).toBe('hidden');
    expect($(el, '.zoom-bar').dataset.panel).toBe('collapsed');
    expect($(el, '.hud-title').dataset.panel).toBe('hidden');
    expect($(el, '.legend').dataset.open).toBe('true');
    const seen = layouts(el);
    $<HTMLButtonElement>(el, '.legend-head').click();
    expect(el.panels.legend).toBe('collapsed');
    expect(seen.map((e) => [e.source, e.panels.legend])).toEqual([['user', 'collapsed']]);
  });

  it('moves focus out of a region before it folds', async () => {
    const el = await loaded();
    el.next();
    el.controller.flush();
    const next = el.shadowRoot?.querySelector<HTMLButtonElement>('[data-focus-key="next"]');
    next?.focus();
    expect(el.shadowRoot?.activeElement).toBe(next);
    el.panels = 'detail:collapsed';
    expect(el.shadowRoot?.activeElement).toBe($(el, '.detail-bar'));
    $(el, '.list').focus();
    press($(el, '.list'), '\\');
    expect(el.shadowRoot?.activeElement?.getAttribute('aria-label')).toMatch(/^Toggle sidebar/);
  });

  it('opens a collapsed search on / and focuses it', async () => {
    const el = await loaded({ panels: 'search:collapsed' });
    press(el, '/');
    expect(el.panels.search).toBe('open');
    expect(el.shadowRoot?.activeElement).toBe($(el, '.search input'));
  });
});

describe('presets', () => {
  it('sidebar, header and chrome set panel states; panels wins for the regions it names', async () => {
    const el = await loaded({ sidebar: 'closed', header: 'compact' });
    expect(el.panels).toMatchObject({ list: 'collapsed', detail: 'collapsed', title: 'hidden' });
    el.setAttribute('panels', 'detail:open');
    expect(el.panels).toMatchObject({ list: 'collapsed', detail: 'open' });
    expect($(el, '.sidebar').dataset.open).toBe('true');
    el.removeAttribute('header');
    expect(el.panels.title).toBe('open');
    el.chrome = 'none';
    const { legend: _legend, detail: _detail, ...bare } = el.panels;
    expect(Object.values(bare).every((s) => s === 'hidden')).toBe(true);
    expect(el.panels.detail).toBe('open');
    el.chrome = 'full';
    expect(el.panels).toMatchObject({ dock: 'open', list: 'collapsed', detail: 'open' });
  });

  it('the host restating a preset overrides what the user changed in the page', async () => {
    const el = await loaded({ sidebar: 'closed' });
    press(el, '\\');
    expect(el.panels.list).toBe('open');
    el.setAttribute('sidebar', 'closed');
    expect(el.panels.list).toBe('collapsed');
  });
});

describe('sizes', () => {
  it('resizes the sidebar from the keyboard, reporting and remembering it', async () => {
    const el = await loaded();
    const seen = layouts(el);
    const edge = $(el, '.sb-resize');
    expect(edge.getAttribute('role')).toBe('separator');
    expect(edge.getAttribute('aria-orientation')).toBe('vertical');
    expect(edge.getAttribute('aria-valuenow')).toBe('360');
    press(edge, 'ArrowLeft');
    expect(edge.getAttribute('aria-valuenow')).toBe('376');
    expect($(el, '.sidebar').style.getPropertyValue('--sidebar-w')).toBe('376px');
    press(edge, 'Home');
    expect(edge.getAttribute('aria-valuenow')).toBe('280');
    expect(seen.map((e) => e.sidebarWidth)).toEqual([376, 280]);
    expect(readRemembered(localStorage).sidebarWidth).toBe(280);
  });

  it('moves the list / detail split from the keyboard, and resets it on double click', async () => {
    const el = await loaded();
    const seen = layouts(el);
    const split = $(el, '.sb-split');
    expect(split.getAttribute('aria-orientation')).toBe('horizontal');
    press(split, 'ArrowUp');
    expect($(el, '.sidebar').hasAttribute('data-split')).toBe(true);
    expect(seen.at(-1)?.detailShare).toBeGreaterThan(0);
    expect(readRemembered(localStorage).detailShare).toBe(seen.at(-1)?.detailShare);
    split.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect($(el, '.sidebar').hasAttribute('data-split')).toBe(false);
    expect(seen.at(-1)?.detailShare).toBeNull();
    expect(readRemembered(localStorage).detailShare).toBeUndefined();
  });
});

describe('persistence', () => {
  it('remembers the user’s panel states and applies them in the next viewer', async () => {
    const first = await loaded();
    $<HTMLButtonElement>(first, '.detail-bar').click();
    expect(readRemembered(localStorage).panels).toEqual({ detail: 'collapsed' });
    first.remove();
    const second = await loaded();
    expect(second.panels.detail).toBe('collapsed');
  });

  it('opens at the remembered sizes, without animating to them', async () => {
    remember({ panels: {}, sidebarWidth: 420, detailShare: 0.4 });
    const el = mount();
    const sidebar = $(el, '.sidebar');
    expect(sidebar.style.getPropertyValue('--sidebar-w')).toBe('420px');
    expect(sidebar.style.getPropertyValue('--detail-share')).toBe('0.4');
    expect(sidebar.classList.contains('dragging')).toBe(true);
    await tick(60);
    expect(sidebar.classList.contains('dragging')).toBe(false);
    expect($(el, '.sb-resize').getAttribute('aria-valuenow')).toBe('420');
  });

  it('host attribute > remembered > the report’s view > default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    remember({ panels: { detail: 'open', zoom: 'hidden' } });
    const el = mount({ panels: 'zoom:open' });
    await ready(
      el,
      payload({ panels: { detail: 'collapsed', minimap: 'hidden', list: 'nope' } as never }),
    );
    expect(el.panels).toMatchObject({
      zoom: 'open', // the host
      detail: 'open', // remembered, over the report
      minimap: 'hidden', // the report, over the default
      list: 'open', // the default (the report's value was invalid)
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('panels (list:nope)');
  });

  it('keeps an older payload without panels at today’s layout', async () => {
    const el = mount();
    await ready(el, payload({ mode: 'replay' }));
    expect(el.panels).toEqual(DEFAULT_PANELS);
  });

  it('remembers theme, palette and language; the host’s attributes win over them', async () => {
    const first = await loaded({ theme: 'dark' });
    press(first, 't');
    expect(first.theme).toBe('auto');
    expect(readRemembered(localStorage).theme).toBe('auto');
    press(first, 't');
    expect(readRemembered(localStorage).theme).toBe('light');
    remember({ ...readRemembered(localStorage), palette: 'colorblind', locale: 'zh-CN' });
    first.remove();
    const second = await loaded();
    expect([second.theme, second.palette, second.locale]).toEqual(['light', 'colorblind', 'zh-CN']);
    second.remove();
    const third = await loaded({ theme: 'dark', locale: 'en' });
    expect([third.theme, third.palette, third.locale]).toEqual(['dark', 'colorblind', 'en']);
  });

  it('applies the report’s theme and language as soon as the payload is set', () => {
    const el = mount();
    el.payload = payload({ theme: 'light', locale: 'zh-CN', panels: { detail: 'collapsed' } });
    expect([el.theme, el.locale, el.panels.detail]).toEqual(['light', 'zh-CN', 'collapsed']);
  });

  it('remembered preferences win over the report’s view', async () => {
    remember({ panels: {}, theme: 'light', locale: 'zh-CN' });
    const el = mount();
    await ready(el, payload({ theme: 'dark', locale: 'en' }));
    expect([el.theme, el.locale]).toEqual(['light', 'zh-CN']);
  });

  it('persist="none" reads and writes nothing', async () => {
    remember({ panels: { detail: 'collapsed' }, theme: 'light', sidebarWidth: 500 });
    const before = localStorage.getItem(LAYOUT_KEY);
    const el = await loaded({ persist: 'none' });
    expect(el.persist).toBe('none');
    expect(el.panels.detail).toBe('open');
    expect(el.theme).toBe('auto');
    expect($(el, '.sb-resize').getAttribute('aria-valuenow')).toBe('360');
    $<HTMLButtonElement>(el, '.detail-bar').click();
    press(el, 't');
    press($(el, '.sb-resize'), 'ArrowLeft');
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
  });

  it('survives storage that throws', async () => {
    let reads = 0;
    const blocked = {
      getItem: () => {
        reads++;
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(readRemembered(blocked)).toEqual({ panels: {} });
    vi.stubGlobal('localStorage', blocked);
    try {
      const el = await loaded();
      $<HTMLButtonElement>(el, '.detail-bar').click();
      press(el, 't');
      expect(el.panels.detail).toBe('collapsed');
      expect(reads).toBeGreaterThan(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports host changes, but not the first states', async () => {
    remember({ panels: { detail: 'collapsed' } });
    const el = document.createElement('kgdiff-viewer') as unknown as KgdiffViewer;
    const seen = layouts(el);
    el.setAttribute('panels', 'zoom:hidden');
    document.body.append(el);
    await el.load(zoo());
    expect(seen).toEqual([]);
    expect(el.panels).toMatchObject({ detail: 'collapsed', zoom: 'hidden' });
    el.setAttribute('panels', 'zoom:open');
    expect(seen.map((e) => [e.source, e.panels.zoom])).toEqual([['host', 'open']]);
  });
});
