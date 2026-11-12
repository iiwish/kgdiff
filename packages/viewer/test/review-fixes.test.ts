/** Regression tests for the independent review (one block per finding). */
import { diff, diffToJSON } from '@kgdiff/core';
import { layoutDiff, layoutToJSON } from '@kgdiff/layout';
import { frameBounds } from '@kgdiff/scene';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewerController } from '../src/controller.js';
import type { KgdiffViewer } from '../src/element.js';
import { frameTarget } from '../src/framing.js';
import '../src/index.js';
import type { ReportPayload } from '../src/index.js';
import { keyAction } from '../src/keyboard.js';
import { familyCounts } from '../src/list-model.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { reviewKey } from '../src/review-store.js';
import {
  hub,
  MemoryStorage,
  manualDeps,
  mockBackend,
  recordingHost,
  tick,
  until,
  VIEWPORT,
  zoo,
} from './support.js';

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

async function payload(view?: unknown, graphs = zoo()): Promise<ReportPayload> {
  const d = await diff(graphs.before, graphs.after);
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: diffToJSON(d),
    layout: layoutToJSON(await layoutDiff(d)),
    meta: { generator: 'test', before: { name: 'a' }, after: { name: 'b' } },
    ...(view !== undefined ? { view: view as ReportPayload['view'] } : {}),
  };
}

function mount(attrs: Record<string, string> = {}): KgdiffViewer {
  const el = document.createElement('kgdiff-viewer') as unknown as KgdiffViewer;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
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

const $ = <T extends Element = HTMLElement>(el: Element, sel: string): T =>
  el.shadowRoot?.querySelector<T>(sel) as T;

/** The CSS of the stylesheets the shadow root adopted. */
const css = (el: Element): string =>
  (el.shadowRoot?.adoptedStyleSheets ?? [])
    .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
    .join('\n');

const press = (target: EventTarget, key: string): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe('1 · invalid preferences never break the viewer', () => {
  it('drops invalid report view fields and keeps rendering later payloads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = mount({ locale: 'en' });
    await ready(el, await payload({ theme: 'neon', locale: 'fr', mode: 'bogus', palette: 42 }));
    expect(warn).toHaveBeenCalledOnce();
    expect(el.controller.status).toBe('ready');
    expect([el.theme, el.palette, el.locale, el.mode]).toEqual([
      'auto',
      'default',
      'en',
      'overlay',
    ]);
    expect(el.getAttribute('mode')).toBe('overlay');
    expect($(el, '.list').querySelectorAll('.row').length).toBeGreaterThan(0);
    await ready(el, await payload({ theme: 'light', mode: 'swipe' }));
    expect([el.theme, el.mode]).toEqual(['light', 'swipe']);
  });

  it('treats the removed report mode changes as unknown: ignored, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = mount({ locale: 'en' });
    await ready(el, await payload({ mode: 'changes' }));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('mode');
    expect([el.mode, el.scope]).toEqual(['overlay', 'all']);
    // An explicit scope in the same view is kept.
    await ready(el, await payload({ mode: 'changes', scope: 'changes' }));
    expect([el.mode, el.scope]).toEqual(['overlay', 'changes']);
  });

  it('normalizes attributes and properties through the same rules', () => {
    const el = mount();
    el.setAttribute('palette', 'rainbow');
    expect(el.palette).toBe('default');
    el.locale = 'zh' as never;
    expect(el.locale).toBe('zh-CN');
    expect(el.getAttribute('locale')).toBe('zh-CN');
    el.locale = 'fr' as never;
    expect(['en', 'zh-CN']).toContain(el.locale);
  });
});

describe('2 · an initial selection is framed instead of the whole graph', () => {
  const chrome = () => ({ width: VIEWPORT.width, height: VIEWPORT.height, obstacles: [] });

  it('frames a deep-linked hunk at first layout', async () => {
    const c = new ViewerController(recordingHost(), manualDeps());
    c.attach(document.createElement('div'), null);
    c.setChrome(chrome);
    c.selectHunkById('remove:E');
    await c.load(zoo());
    await tick();
    const cam = backend.last().camera;
    const scene = c.scene;
    if (!scene) throw new Error('no scene');
    const h = scene.hunkIndex.get('remove:E') as number;
    const target = frameBounds(scene, [h]);
    expect(cam.fits).toBe(0);
    expect(cam.flights.at(-1)).toEqual(target);
    const opts = cam.flightOptions.at(-1);
    const insets = typeof opts?.padding === 'object' ? opts.padding : null;
    expect(insets).not.toBeNull();
    expect(cam.get()).toEqual(
      frameTarget(
        target,
        VIEWPORT.width,
        VIEWPORT.height,
        insets as never,
        0.05,
        opts?.maxZoom ?? 2.5,
      ),
    );
    c.destroy();
  });

  it('frames a hunk selected from a kgdiff-ready handler', async () => {
    const el = mount();
    el.controller.setChrome(chrome);
    el.addEventListener('kgdiff-ready', () => el.selectHunk('add:G'));
    await ready(el, await payload());
    const cam = backend.last().camera;
    expect(cam.fits).toBe(0);
    expect(el.controller.scene?.hunks[el.controller.selectedHunk]?.id).toBe('add:G');
  });
});

describe('3 · focus survives detail and menu re-renders', () => {
  it('keeps focus on next / reviewed / show-more after they re-render the panel', async () => {
    const el = mount();
    await ready(el, await payload());
    el.selectHunk('remove:E');
    await tick();
    for (const key of ['next', 'review', 'next']) {
      const button = $(el, `.detail [data-focus-key="${key}"]`) as HTMLButtonElement;
      button.focus();
      button.click();
      await tick();
      expect((el.shadowRoot?.activeElement as HTMLElement | null)?.dataset.focusKey, key).toBe(key);
    }
  });

  it('keeps focus on the chosen menu item', async () => {
    const el = mount({ theme: 'dark' });
    await ready(el, await payload());
    ($(el, '.hud [aria-haspopup="menu"]') as HTMLButtonElement).click();
    const light = $(el, '.menu [data-focus-key="light"]') as HTMLButtonElement;
    light.focus();
    light.click();
    await tick();
    expect(el.theme).toBe('light');
    expect((el.shadowRoot?.activeElement as HTMLElement | null)?.dataset.focusKey).toBe('light');
  });
});

describe('5 · listbox semantics', () => {
  it('options carry set size, position and their group, and contain no buttons', async () => {
    const el = mount();
    await ready(el, await payload());
    const rows = [...$(el, '.list').querySelectorAll<HTMLElement>('[role="option"]')];
    expect(rows.length).toBe(el.reviewState().total);
    rows.forEach((row, i) => {
      expect(row.getAttribute('aria-setsize')).toBe(String(rows.length));
      expect(row.getAttribute('aria-posinset')).toBe(String(i + 1));
      const group = el.shadowRoot?.getElementById(row.getAttribute('aria-describedby') ?? '');
      expect(group?.textContent).toMatch(/\(\d+\)$/);
      expect(row.querySelector('button, [tabindex]')).toBeNull();
    });
  });
});

describe('6 · hidden context is keyboard-expandable', () => {
  it('e (and the dock button) expands the group nearest the selection', async () => {
    expect(keyAction({ key: 'e' }, 'overlay', 'changes')).toEqual({ type: 'expand' });
    expect(keyAction({ key: 'e' }, 'replay', 'changes')).toEqual({ type: 'expand' });
    expect(keyAction({ key: 'e' }, 'overlay')).toBeNull();
    const el = mount();
    await ready(el, await payload(undefined, hub(6)));
    el.scope = 'changes';
    el.controller.setHops(0);
    await tick();
    const before = el.controller.focus?.collapsed.length ?? 0;
    expect(before).toBeGreaterThan(0);
    const button = $(el, '.dock-bar .context .expand') as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    press(el, 'e');
    expect(el.controller.focus?.collapsed.length ?? 0).toBeLessThan(before);
  });
});

describe('7 · moving the element keeps the camera', () => {
  it('restores the camera on re-attach', async () => {
    const el = mount();
    await ready(el, await payload());
    backend.last().camera.state = { x: 12, y: -34, k: 1.7 };
    el.remove();
    document.body.appendChild(el);
    expect(backend.last().camera.get()).toEqual({ x: 12, y: -34, k: 1.7 });
  });
});

describe('8 · bottom sheet handle', () => {
  it('is a 28 px separator with values', async () => {
    const el = mount();
    await ready(el, await payload());
    const handle = $(el, '.sheet-handle');
    expect(handle.getAttribute('role')).toBe('separator');
    press(handle, 'ArrowUp');
    expect(handle.getAttribute('aria-valuenow')).not.toBeNull();
    expect(handle.getAttribute('aria-valuemin')).not.toBeNull();
    expect(handle.getAttribute('aria-valuemax')).not.toBeNull();
    expect(css(el)).toMatch(/sheet-handle \{[^}]*height: 28px/);
  });
});

describe('9 · filter chips', () => {
  it('count hunks per family, also for edge-only diffs, and wear the legend swatches', async () => {
    const el = mount();
    const edgeOnly = {
      before: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },
      after: {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b', predicate: 'p' }],
      },
    };
    await ready(el, await payload(undefined, edgeOnly));
    const filters = $(el, '.filters');
    expect(filters.hidden).toBe(false);
    const counts = familyCounts(el.controller.scene as never);
    const chips = [...filters.querySelectorAll<HTMLElement>('.fchip:not([hidden])')];
    expect(chips.map((c) => c.querySelector('.n')?.textContent)).toEqual(
      Object.values(counts)
        .filter((n) => n > 0)
        .map(String),
    );
    for (const chip of chips) expect(chip.querySelector('svg.swatch')).not.toBeNull();
  });
});

describe('10 · announcements', () => {
  it('announces replay steps and review progress once', async () => {
    const el = mount();
    await ready(el, await payload());
    el.mode = 'replay';
    press(el, 'ArrowRight');
    await tick(60);
    const live = $(el, '[aria-live="polite"].sr-only');
    expect(live.textContent).toMatch(/^Change 1 of \d+: /);
    expect($(el, '.progress').getAttribute('role')).toBeNull();
    expect(el.shadowRoot?.querySelectorAll('[role="status"].progress').length).toBe(0);
  });
});

describe('11 · misc', () => {
  it('a superseded load rejects with an AbortError', async () => {
    const el = mount();
    const first = el.load(zoo());
    const second = el.load(hub(3));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBeUndefined();
  });

  it('exportDelta returns a frozen copy', async () => {
    const el = mount();
    await ready(el, await payload());
    const a = el.exportDelta();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.ops)).toBe(true);
    expect(a).not.toBe(el.controller.diff?.delta);
    expect(a).toEqual(el.controller.diff?.delta);
  });

  it('syncs review progress from other tabs', async () => {
    const el = mount();
    await ready(el, await payload());
    const d = el.controller.diff;
    const key = reviewKey(d?.delta.base.hash ?? '', d?.delta.target.hash ?? '');
    localStorage.setItem(key, JSON.stringify({ v: 1, reviewed: ['add:G'] }));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    await tick();
    expect(el.reviewState().reviewed).toEqual(['add:G']);
    expect($(el, '.progress').textContent).toContain('1 of');
    expect(new MemoryStorage().getItem('x')).toBeNull();
  });

  it('Home / End on the swipe divider move it to the edges, not the selection', async () => {
    const el = mount();
    await ready(el, await payload());
    el.mode = 'swipe';
    const divider = $(el, '.swipe .divider');
    press(divider, 'End');
    expect(el.controller.split).toBe(1);
    press(divider, 'Home');
    expect(el.controller.split).toBe(0);
    expect(el.controller.selectedHunk).toBe(-1);
  });
});

describe('12 · contrast tokens', () => {
  it('exposes the control border and uses it for review circles; focus uses solid accent', async () => {
    const el = mount();
    await ready(el, await payload());
    const styles = css(el);
    expect(styles).toContain('--kgdiff-control-border:');
    expect(styles).toMatch(/\.rv \.ring \{[^}]*var\(--kgdiff-control-border\)/);
    expect(styles).toMatch(
      /\.list:focus-visible \.row\[aria-selected="true"\] \{ box-shadow: inset 0 0 0 2px var\(--kgdiff-accent\)/,
    );
  });
});
