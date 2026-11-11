import { KgdiffError } from '@kgdiff/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KgdiffViewer } from '../src/element.js';
import { defineViewer, type KgdiffViewerElement } from '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { hub, mockBackend, tick, until, zoo } from './support.js';

let backend: ReturnType<typeof mockBackend>;

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

const $ = <T extends Element = HTMLElement>(el: Element, selector: string): T => {
  const found = el.shadowRoot?.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} not found`);
  return found;
};

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  backend = mockBackend();
  setRenderBackend(backend);
  localStorage.clear();
});

afterEach(() => {
  document.body.textContent = '';
  setRenderBackend(null);
  history.replaceState(null, '', '/');
});

describe('registration', () => {
  it('defines <kgdiff-viewer> on import and is idempotent', () => {
    const ctor = customElements.get('kgdiff-viewer');
    expect(ctor).toBeDefined();
    defineViewer();
    defineViewer('kgdiff-viewer');
    expect(customElements.get('kgdiff-viewer')).toBe(ctor);
  });

  it('can be registered under another tag name', () => {
    defineViewer('my-diff-viewer');
    defineViewer('my-diff-viewer');
    const el = document.createElement('my-diff-viewer') as KgdiffViewerElement;
    expect(typeof el.load).toBe('function');
    expect(el.mode).toBe('overlay');
  });

  it('renders an open shadow root with the empty state before anything is loaded', () => {
    const el = mount();
    expect(el.shadowRoot).not.toBeNull();
    expect($(el, '.state').textContent).toContain('Nothing to compare yet');
    expect(backend.renderers).toHaveLength(1);
  });

  it('applies properties set before the element was upgraded', async () => {
    const el = document.createElement('div') as unknown as Record<string, unknown>;
    expect(el).toBeDefined();
    const pre = document.createElement('kgdiff-viewer');
    document.body.appendChild(pre);
    expect((pre as KgdiffViewerElement).mode).toBe('overlay');
  });
});

describe('attributes and properties', () => {
  it('combines any mode with the changes scope, and ignores the removed changes mode', async () => {
    const el = await loaded();
    el.mode = 'swipe';
    el.scope = 'changes';
    expect([el.mode, el.scope]).toEqual(['swipe', 'changes']);
    expect(el.getAttribute('scope')).toBe('changes');
    expect(el.controller.focus).not.toBeNull();
    el.setAttribute('scope', 'all');
    expect(el.controller.focus).toBeNull();
    el.setAttribute('scope', 'bogus');
    expect(el.scope).toBe('all');
    // `changes` used to be a mode; now it is an unknown one: the default, and the scope stays.
    el.scope = 'changes';
    el.setAttribute('mode', 'changes');
    expect([el.mode, el.scope]).toEqual(['overlay', 'changes']);
    expect(el.getAttribute('mode')).toBe('changes'); // left as written, like any invalid value
    el.mode = 'replay';
    expect([el.mode, el.scope]).toEqual(['replay', 'changes']);
  });

  it('keeps the scope attribute on changes while a changes-scoped layout locks it', async () => {
    const el = mount();
    await el.load({ ...hub(12), layout: { largeGraphThreshold: 4 } });
    await tick();
    expect(el.scope).toBe('changes');
    el.scope = 'all';
    expect(el.scope).toBe('changes');
    expect(el.getAttribute('scope')).toBe('changes');
    expect($(el, '.dock-bar .scope-btn').getAttribute('aria-disabled')).toBe('true');
  });

  it('reflects mode, theme, palette and locale both ways', async () => {
    const el = mount({ locale: 'zh' });
    expect(el.locale).toBe('zh-CN');
    el.mode = 'swipe';
    expect(el.getAttribute('mode')).toBe('swipe');
    el.setAttribute('mode', 'replay');
    expect(el.mode).toBe('replay');
    // Invalid values fall back to the default (and are no longer explicit).
    el.setAttribute('mode', 'bogus');
    expect(el.mode).toBe('overlay');
    el.mode = 'replay';
    el.theme = 'light';
    expect(el.getAttribute('theme')).toBe('light');
    el.setAttribute('theme', 'dark');
    expect(el.theme).toBe('dark');
    el.palette = 'colorblind';
    expect(el.getAttribute('palette')).toBe('colorblind');
    el.locale = 'en';
    expect(el.getAttribute('locale')).toBe('en');
    el.theme = 'neon' as never;
    expect(el.theme).toBe('auto');
    expect(el.hasAttribute('theme')).toBe(false);
    el.setAttribute('theme', 'dark');
    expect(el.theme).toBe('dark');
    await tick();
    expect(backend.last().theme.palette).toBe('colorblind');
  });

  it('opens and closes the sidebar through the attribute and the \\ key', async () => {
    const el = await loaded();
    const sidebar = $(el, '.sidebar');
    expect(sidebar.dataset.open).toBe('true');
    el.setAttribute('sidebar', 'closed');
    expect(sidebar.dataset.open).toBe('false');
    press(el, '\\');
    expect(el.getAttribute('sidebar')).toBe('open');
  });
});

describe('loading', () => {
  it('shows loading steps, then the graph, and fires kgdiff-ready with stats', async () => {
    const el = mount();
    const events: string[] = [];
    el.addEventListener('kgdiff-ready', (e) => {
      events.push(`ready:${(e as CustomEvent).detail.stats.nodes.added}`);
    });
    const done = el.load(zoo());
    await tick();
    expect($(el, '.state').textContent).toContain('Preparing the diff');
    await done;
    await tick();
    expect(events).toEqual(['ready:1']);
    expect($(el, '.state').hidden).toBe(true);
    expect(backend.last().frameCount).toBeGreaterThan(0);
    expect($(el, '.list').querySelectorAll('.row').length).toBe(el.reviewState().total);
    expect($(el, '.versions').textContent).toContain('Zoo');
    expect(backend.last().canvas.getAttribute('aria-label')).toMatch(
      /Graph diff\. Before: 6 nodes/,
    );
  });

  it('rejects bad input, shows the error state and fires kgdiff-error', async () => {
    const el = mount();
    const errors: Error[] = [];
    el.addEventListener('kgdiff-error', (e) => errors.push((e as CustomEvent).detail.error));
    await expect(
      el.load({ before: { nodes: 'x' } as never, after: zoo().after }),
    ).rejects.toBeInstanceOf(KgdiffError);
    await tick();
    expect(errors).toHaveLength(1);
    expect($(el, '.state-card.error').textContent).toContain('could not be shown');
    expect($(el, '.state-card details pre').textContent).toContain('invalid-input');
  });

  it('shows the identical state for equal graphs', async () => {
    const el = mount();
    const { before } = zoo();
    await el.load({ before, after: before });
    await tick();
    expect($(el, '.state').textContent).toContain('No differences');
    expect($(el, '.state').textContent).toContain('Both versions have 6 nodes and 5 edges.');
  });

  it('exportDelta returns the delta and throws before loading', async () => {
    const el = mount();
    expect(() => el.exportDelta()).toThrow(KgdiffError);
    await el.load(zoo());
    expect(el.exportDelta().format).toBe('kgdiff.delta');
  });
});

describe('selection and events', () => {
  it('selectHunk / next / prev fire kgdiff-select and update the list and details', async () => {
    const el = await loaded();
    const selected: (string | null)[] = [];
    el.addEventListener('kgdiff-select', (e) => selected.push((e as CustomEvent).detail.hunk));
    el.selectHunk('modify:C');
    await tick();
    expect(selected).toEqual(['modify:C']);
    const row = $(el, '.row[aria-selected="true"]');
    expect(row.textContent).toContain('Renamed');
    expect($(el, '.list').getAttribute('aria-activedescendant')).toBe(row.id);
    const detail = $(el, '.detail');
    expect(detail.querySelector('.d-title')?.textContent).toContain('Cat');
    expect(detail.querySelector('del.hl')?.textContent).toBe('Cat');
    expect(detail.querySelector('ins.hl')?.textContent).toBe('Kitty');
    el.next();
    el.prev();
    expect(selected).toHaveLength(3);
    el.selectHunk(null);
    expect(selected.at(-1)).toBeNull();
  });

  it('shows word-level attribute diffs', async () => {
    const el = await loaded();
    el.selectHunk('modify:D');
    await tick();
    const table = $(el, '.detail table.attrs');
    expect(table.textContent).toContain('sound');
    expect(table.querySelector('del.hl')?.textContent?.trim()).toBe('woof');
    expect(table.querySelector('ins.hl')?.textContent?.trim()).toBe('loud');
  });

  const sectionTitles = (el: KgdiffViewer): (string | null | undefined)[] =>
    [...$(el, '.detail').querySelectorAll('.section > h3')].map((h3) => h3.firstChild?.textContent);

  it('leads with the changes, reads set changes as edits and folds the unchanged rest', async () => {
    const node = (aliases: string[], type: string) => ({
      id: 'X',
      label: 'Debtor',
      aliases,
      type,
      attrs: { since: '2020', status: 'open' },
    });
    const el = mount();
    await el.load({
      before: { nodes: [node(['Deadbeat'], 'List')], edges: [] },
      after: { nodes: [node(['Defaulter'], 'Measure')], edges: [] },
    });
    el.selectHunk('modify:X');
    await tick();
    expect(sectionTitles(el)).toEqual(['Changes', 'Overview']);
    const rows = [...$(el, '.detail .changes').querySelectorAll('tr')].map((tr) => {
      const p = tr.querySelector('.pair');
      return [tr.firstChild?.textContent, p?.firstChild?.textContent, p?.lastChild?.textContent];
    });
    expect(rows).toEqual([
      ['Types', 'List', 'Measure'],
      ['Synonyms', 'Deadbeat', 'Defaulter'],
    ]);
    const toggle = $(el, '.detail [data-focus-key="attrs-more"]');
    expect(toggle.textContent).toContain('2 unchanged attributes');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect($(el, '.detail').querySelectorAll('table')).toHaveLength(1);
    toggle.click();
    await tick();
    const tables = $(el, '.detail').querySelectorAll('table');
    expect(tables).toHaveLength(2);
    expect(tables[1]?.textContent).toBe('since2020statusopen');
  });

  it('shows a relation change before the unchanged node it starts from', async () => {
    const nodes = [
      { id: 'A', label: 'Holder', attrs: { note: 'x' } },
      { id: 'B', label: 'Company' },
      { id: 'C', label: 'Listed company' },
    ];
    const el = mount();
    await el.load({
      before: { nodes, edges: [{ source: 'A', target: 'B', predicate: 'holds' }] },
      after: { nodes, edges: [{ source: 'A', target: 'C', predicate: 'holds' }] },
    });
    el.next();
    await tick();
    expect(sectionTitles(el)).toEqual(['Relations', 'Overview']);
    expect($(el, '.detail [data-focus-key="attrs-more"]').textContent).toContain(
      '1 unchanged attribute',
    );
    // Inspected on its own, the node shows what it is first, attributes open.
    backend.last().click({ type: 'node', index: el.controller.scene?.nodeIndex.get('A') ?? -1 });
    await tick();
    expect(sectionTitles(el)).toEqual(['Overview', 'Attributes', 'Relations']);
  });

  it('marks hunks reviewed, persists it and fires kgdiff-review', async () => {
    const el = await loaded();
    const events: unknown[] = [];
    el.addEventListener('kgdiff-review', (e) => events.push((e as CustomEvent).detail));
    el.setReviewed('remove:E', true);
    await tick();
    expect(events).toEqual([
      { hunk: 'remove:E', reviewed: true, progress: { reviewed: ['remove:E'], total: 5 } },
    ]);
    expect($(el, '.progress').textContent).toContain('1 of 5 reviewed');
    const again = await loaded();
    expect(again.reviewState().reviewed).toEqual(['remove:E']);
  });

  it('announces navigation in a polite live region', async () => {
    const el = await loaded();
    el.next();
    await tick(60);
    const live = $(el, '[aria-live="polite"].sr-only');
    expect(live.textContent).toMatch(/^Change 1 of 5: /);
  });

  it('emits kgdiff-mode on mode and scope changes', async () => {
    const el = await loaded();
    const views: unknown[] = [];
    el.addEventListener('kgdiff-mode', (e) => views.push((e as CustomEvent).detail));
    el.scope = 'changes';
    el.play();
    expect(views).toEqual([
      { mode: 'overlay', scope: 'changes' },
      { mode: 'replay', scope: 'changes' },
    ]);
    el.pause();
    await expect(el.fit()).resolves.toBeUndefined();
    expect(backend.last().camera.fits).toBe(1);
  });
});

describe('keyboard', () => {
  it('drives modes, navigation, review, theme and help', async () => {
    const el = await loaded();
    press(el, '2');
    expect(el.mode).toBe('swipe');
    press(el, 'ArrowRight', { shiftKey: true });
    expect(el.controller.split).toBeCloseTo(0.6);
    press(el, '1');
    press(el, 'j');
    expect(el.controller.selectedHunk).toBe(el.controller.list.order[0]);
    press(el, 'x');
    expect(el.reviewState().reviewed).toHaveLength(1);
    press(el, 't');
    expect(el.theme).toBe('light');
    press(el, '?');
    expect($(el, '.overlay-scrim').hidden).toBe(false);
    press(el.shadowRoot?.activeElement ?? el, 'Escape');
    expect($(el, '.overlay-scrim').hidden).toBe(true);
    press(el, 'Escape');
    expect(el.controller.selectedHunk).toBe(-1);
    press(el, '+');
    expect(backend.last().camera.zooms).toEqual([1.4]);
  });

  it('toggles the changes scope with 4, keeping the mode', async () => {
    const el = await loaded();
    press(el, '3');
    press(el, '4');
    expect([el.mode, el.scope]).toEqual(['replay', 'changes']);
    await tick();
    expect($(el, '.dock-bar .scope-btn').getAttribute('aria-pressed')).toBe('true');
    expect($(el, '.dock-bar .context').hidden).toBe(false);
    press(el, '4');
    expect([el.mode, el.scope]).toEqual(['replay', 'all']);
    await tick();
    expect($(el, '.dock-bar .context').hidden).toBe(true);
  });

  it('plays and steps the replay with space and arrows', async () => {
    const el = await loaded();
    press(el, '3');
    press(el, 'ArrowRight');
    expect(el.controller.clock?.position()).toBe(1);
    const e = press(el, ' ');
    expect(e.defaultPrevented).toBe(true);
    expect(el.controller.clock?.playing).toBe(true);
    press(el, ' ');
    expect(el.controller.clock?.playing).toBe(false);
  });

  it('ignores shortcuts while typing and focuses search with /', async () => {
    const el = await loaded();
    press(el, '/');
    const input = $<HTMLInputElement>(el, '.search input');
    expect(el.shadowRoot?.activeElement).toBe(input);
    press(input, '2');
    expect(el.mode).toBe('overlay');
    input.value = 'gecko';
    input.dispatchEvent(new Event('input'));
    const results = $(el, '#kg-results');
    expect(results.hidden).toBe(false);
    expect(results.textContent).toContain('Gecko');
    press(input, 'Enter');
    await tick();
    expect(el.controller.scene?.nodes[el.controller.selectedNode]?.id).toBe('G');
    expect(input.value).toBe('');
  });

  it('ignores document-level keys unless global-shortcuts is set, and never takes page keys', async () => {
    const a = await loaded();
    const b = await loaded();
    press(document.body, '2');
    expect(a.mode).toBe('overlay');
    expect(b.mode).toBe('overlay');
    b.setAttribute('global-shortcuts', '');
    press(document.body, '2');
    expect(a.mode).toBe('overlay');
    expect(b.mode).toBe('swipe');
    for (const key of ['ArrowDown', 'End', ' ', 'PageDown']) {
      const e = press(document.body, key);
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(b.controller.selectedHunk).toBe(-1);
  });

  it('takes keys while focus is inside, e.g. on the canvas after a click', async () => {
    const el = await loaded();
    const canvas = el.shadowRoot?.querySelector('.stage canvas') as HTMLCanvasElement;
    expect(canvas.tabIndex).toBe(0);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(el.shadowRoot?.activeElement).toBe(canvas);
    const e = press(canvas, 'ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(el.controller.selectedHunk).toBe(el.controller.list.order[0]);
  });
});

describe('sync-hash', () => {
  it('writes and reads #kgdiff deep links', async () => {
    history.replaceState(null, '', '#kgdiff=hunk:add%3AG;mode:overlay;scope:changes');
    const el = await loaded({ 'sync-hash': '' });
    expect([el.mode, el.scope]).toEqual(['overlay', 'changes']);
    expect(el.controller.scene?.hunks[el.controller.selectedHunk]?.id).toBe('add:G');
    el.selectHunk('remove:E');
    expect(location.hash).toBe('#kgdiff=hunk:remove%3AE;mode:overlay;scope:changes');
    history.replaceState(null, '', '#kgdiff=hunk:modify%3AC;mode:swipe');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await until(() => el.mode === 'swipe');
    expect(el.scope).toBe('changes');
    expect(el.controller.scene?.hunks[el.controller.selectedHunk]?.id).toBe('modify:C');
    history.replaceState(null, '', '#kgdiff=mode:replay;scope:all');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await until(() => el.mode === 'replay');
    expect(el.scope).toBe('all');
  });

  it('leaves the hash alone without the attribute', async () => {
    const el = await loaded();
    el.selectHunk('remove:E');
    expect(location.hash).toBe('');
  });
});

describe('lifecycle', () => {
  it('destroys the renderer on disconnect and recreates it on reconnect', async () => {
    const el = await loaded();
    const first = backend.last();
    el.remove();
    expect(first.destroyed).toBe(true);
    document.body.appendChild(el);
    await tick(20);
    expect(backend.last()).not.toBe(first);
    expect(backend.last().frameCount).toBeGreaterThan(0);
  });
});

describe('embedding a small looping replay', () => {
  const families = (el: Element): string[] =>
    [...(el.shadowRoot?.querySelectorAll('.mini-item') ?? [])].map(
      (i) => i.getAttribute('data-family') ?? '',
    );

  function hover(el: KgdiffViewer, type: 'pointerenter' | 'pointerleave', pointerType = 'mouse') {
    $(el, '.stage-wrap').dispatchEvent(new PointerEvent(type, { pointerType }));
  }

  it('chrome="none" shows the graph alone, with a one-line legend and no shortcuts', async () => {
    const el = await loaded({ chrome: 'none' });
    expect(el.chrome).toBe('none');
    expect($(el, '.root').dataset.chrome).toBe('none');
    const stage = $(el, '.stage-wrap');
    expect(stage.dataset.legend).toBe('mini');
    expect(stage.dataset.selectable).toBe('false');
    // The zoo has every family but identity, then the unchanged context.
    expect(families(el)).toEqual(['added', 'removed', 'content', 'structure', 'neutral']);
    expect($(el, '.mini-legend').textContent).toContain('Unchanged');
    expect(el.controller.autoFit).toBe(true);
    expect(el.controller.selectOnClick).toBe(false);
    expect(backend.last().labelsInside).toBe(true);
    expect(el.shadowRoot?.querySelector('canvas')?.tabIndex).toBe(-1);
    press(el, '2');
    press(el, '?');
    expect(el.mode).toBe('overlay');
    expect($(el, '.overlay-scrim').hidden).toBe(true);
    el.chrome = 'full';
    expect(el.hasAttribute('chrome')).toBe(false);
    expect(stage.dataset.legend).toBe('full');
    expect(el.controller.autoFit).toBe(false);
    expect(backend.last().labelsInside).toBe(false);
    expect(el.shadowRoot?.querySelector('canvas')?.tabIndex).toBe(0);
    press(el, '2');
    expect(el.mode).toBe('swipe');
  });

  it('chooses the legend with the legend attribute', async () => {
    const el = await loaded({ chrome: 'none', legend: 'none' });
    const stage = $(el, '.stage-wrap');
    expect(stage.dataset.legend).toBe('none');
    el.legend = 'full';
    expect(el.getAttribute('legend')).toBe('full');
    expect(stage.dataset.legend).toBe('full');
    el.setAttribute('legend', 'bogus');
    expect(el.legend).toBe('auto');
    expect(stage.dataset.legend).toBe('mini');
    el.removeAttribute('chrome');
    el.legend = 'mini';
    expect(stage.dataset.legend).toBe('mini');
    el.legend = 'auto';
    expect(el.hasAttribute('legend')).toBe(false);
    expect(stage.dataset.legend).toBe('full');
  });

  it('reflects loop, loop-delay and pause-on-hover', () => {
    const el = mount();
    expect([el.loop, el.loopDelay, el.pauseOnHover]).toEqual([false, 1200, true]);
    el.loop = true;
    el.loopDelay = 500;
    el.pauseOnHover = false;
    expect(el.hasAttribute('loop')).toBe(true);
    expect(el.getAttribute('loop-delay')).toBe('500');
    expect(el.getAttribute('pause-on-hover')).toBe('false');
    expect(el.controller.loopDelay).toBe(500);
    el.setAttribute('loop-delay', 'soon');
    expect(el.loopDelay).toBe(1200);
    expect(el.controller.loopDelay).toBe(1200);
    el.loopDelay = -1;
    expect(el.hasAttribute('loop-delay')).toBe(false);
    el.loop = false;
    el.pauseOnHover = true;
    expect(el.hasAttribute('loop')).toBe(false);
    expect(el.hasAttribute('pause-on-hover')).toBe(false);
    expect(el.controller.loopDelay).toBeNull();
  });

  it('loops a replay by itself and fires kgdiff-replay-end each time it ends', async () => {
    const el = await loaded({ mode: 'replay', chrome: 'none', loop: '', 'loop-delay': '0' });
    const ends: boolean[] = [];
    el.addEventListener('kgdiff-replay-end', (e) => ends.push((e as CustomEvent).detail.loop));
    const clock = el.controller.clock;
    expect(clock?.playing).toBe(true);
    clock?.seek(clock.duration - 1);
    await until(() => ends.length === 1);
    expect(ends).toEqual([true]);
    await until(() => el.controller.clock?.playing === true);
    // Turned off from the listener: the replay stays at its end.
    el.addEventListener('kgdiff-replay-end', () => {
      el.loop = false;
    });
    el.controller.clock?.seek((el.controller.clock?.duration ?? 0) - 1);
    await until(() => ends.length === 2);
    await tick(50);
    expect(el.controller.clock?.finished).toBe(true);
  });

  it('pauses a looping replay while a mouse is over the graph', async () => {
    const el = await loaded({ mode: 'replay', loop: '' });
    const clock = el.controller.clock;
    hover(el, 'pointerenter', 'touch');
    expect(clock?.playing).toBe(true);
    hover(el, 'pointerenter');
    expect(clock?.playing).toBe(false);
    hover(el, 'pointerleave');
    expect(clock?.playing).toBe(true);
    el.pauseOnHover = false;
    hover(el, 'pointerenter');
    expect(clock?.playing).toBe(true);
    el.pauseOnHover = true;
    expect(clock?.playing).toBe(false);
    el.loop = false;
    expect(clock?.playing).toBe(true);
    hover(el, 'pointerleave');
    el.pause();
    hover(el, 'pointerenter');
    hover(el, 'pointerleave');
    expect(clock?.playing).toBe(false);
  });

  it('fit() passes its options on', async () => {
    const el = await loaded();
    await el.fit({ padding: 8, animate: false });
    expect(backend.last().camera.fitCalls.at(-1)?.options).toMatchObject({ animate: false });
  });
});
