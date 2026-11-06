/**
 * `<kgdiff-viewer>` as a composition (RFC 0001 phase 1): regions bind to a root through the
 * context protocol in every topology, and share state only through the session and the root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext, provideContext, requestContext } from '../src/context.js';
import type { KgdiffViewer } from '../src/element.js';
import '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { type ViewerContext, ViewerRoot, viewerContext } from '../src/root.js';
import type { UiActions } from '../src/ui/context.js';
import { mockBackend, tick, zoo } from './support.js';

const ctx = createContext<string>('kgdiff.test/1');

function provider(value: string): HTMLElement {
  const el = document.createElement('div');
  el.dataset.value = value;
  return el;
}

/** What `consumer` was given, if anything (requested through `via`). */
function ask(consumer: Element, via: Element | null = null): string[] {
  const got: string[] = [];
  requestContext(consumer, ctx, (v) => got.push(v), via);
  return got;
}

afterEach(() => {
  document.body.textContent = '';
});

describe('context protocol', () => {
  it('answers a plain child and one inside a nested shadow root, nearest provider first', () => {
    const outer = provider('outer');
    const inner = provider('inner');
    document.body.append(outer);
    outer.append(inner);
    provideContext(outer, ctx, () => 'outer');
    provideContext(inner, ctx, () => 'inner');
    const child = document.createElement('span');
    inner.append(child);
    expect(ask(child)).toEqual(['inner']);
    const host = document.createElement('section');
    outer.append(host);
    const deep = document.createElement('span');
    host.attachShadow({ mode: 'open' }).append(deep);
    expect(ask(deep)).toEqual(['outer']);
  });

  it('replays a request when its provider connects later', () => {
    const root = provider('late');
    const child = document.createElement('span');
    root.append(child);
    document.body.append(root);
    const got = ask(child);
    expect(got).toEqual([]);
    provideContext(root, ctx, () => 'late');
    expect(got).toEqual(['late']);
  });

  it('reaches a provider elsewhere on the page through `via` (for=)', () => {
    const root = provider('root');
    const anchor = document.createElement('i');
    root.append(anchor);
    const elsewhere = document.createElement('span');
    document.body.append(root, elsewhere);
    let consumer: Element | null = null;
    provideContext(root, ctx, () => 'root');
    root.addEventListener('context-request', (e) => {
      consumer = (e as Event & { consumer: Element }).consumer;
    });
    expect(ask(elsewhere)).toEqual([]);
    expect(ask(elsewhere, anchor)).toEqual(['root']);
    // The provider sees who asked, not the element the request went through.
    expect(consumer).toBe(elsewhere);
  });

  it('keys contexts by Symbol.for, so another copy of the library finds the same root', () => {
    const root = provider('root');
    const child = document.createElement('span');
    root.append(child);
    document.body.append(root);
    provideContext(root, ctx, () => 'root');
    const copy = createContext<string>('kgdiff.test/1');
    expect(copy).not.toBe(ctx);
    const got: string[] = [];
    requestContext(child, copy, (v) => got.push(v));
    expect(got).toEqual(['root']);
  });

  it('forgets waiting requests of consumers that left the document', () => {
    const root = provider('root');
    const gone = document.createElement('span');
    const stays = document.createElement('span');
    root.append(gone, stays);
    document.body.append(root);
    const goneGot = ask(gone);
    gone.remove();
    const staysGot = ask(stays);
    root.append(gone);
    provideContext(root, ctx, () => 'root');
    expect(staysGot).toEqual(['root']);
    expect(goneGot).toEqual([]);
  });

  it('stops answering once the provider stops', () => {
    const root = provider('root');
    const child = document.createElement('span');
    root.append(child);
    document.body.append(root);
    const stop = provideContext(root, ctx, () => 'root');
    stop();
    expect(ask(child)).toEqual([]);
  });
});

describe('ViewerRoot', () => {
  const actions = (): UiActions => ({
    tr: () => {
      throw new Error('unused');
    },
    setMode: () => undefined,
    toggleScope: () => undefined,
    setThemePreference: () => undefined,
    setPalette: () => undefined,
    setLocale: () => undefined,
    toggleSidebar: () => undefined,
    sidebarOpen: () => true,
    toggleMenu: () => undefined,
    openHelp: () => undefined,
    focusSearch: () => undefined,
  });

  it('provides itself while connected; two roots never answer for each other', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    const ra = new ViewerRoot(a, a.attachShadow({ mode: 'open' }), actions());
    const rb = new ViewerRoot(b, b.attachShadow({ mode: 'open' }), actions());
    const stopA = ra.connect();
    const stopB = rb.connect();
    const inA = document.createElement('span');
    a.append(inA);
    const inB = document.createElement('span');
    b.shadowRoot?.append(inB);
    const got: ViewerContext[] = [];
    requestContext(inA, viewerContext, (v) => got.push(v));
    requestContext(inB, viewerContext, (v) => got.push(v));
    expect(got).toEqual([ra, rb]);
    stopA();
    stopB();
    ra.controller.destroy();
    rb.controller.destroy();
  });

  it('focuses the target registered last, and does nothing without one', () => {
    const host = document.createElement('div');
    const root = new ViewerRoot(host, host.attachShadow({ mode: 'open' }), actions());
    const seen: string[] = [];
    expect(root.focus('search')).toBe(false);
    const off = root.target('search', () => seen.push('first'));
    root.target('search', () => seen.push('second'))();
    expect(root.focus('search')).toBe(true);
    off();
    expect(root.focus('search')).toBe(false);
    expect(seen).toEqual(['first']);
    root.controller.destroy();
  });
});

describe('<kgdiff-viewer> regions', () => {
  let backend: ReturnType<typeof mockBackend>;

  beforeEach(() => {
    backend = mockBackend();
    setRenderBackend(backend);
    localStorage.clear();
  });

  afterEach(() => {
    setRenderBackend(null);
    expect(backend).toBeDefined();
  });

  async function loaded(): Promise<KgdiffViewer> {
    const el = document.createElement('kgdiff-viewer') as KgdiffViewer;
    document.body.append(el);
    await el.load(zoo());
    await tick();
    return el;
  }

  const $ = <T extends HTMLElement = HTMLElement>(el: Element, sel: string): T =>
    el.shadowRoot?.querySelector<T>(sel) as T;

  const press = (target: EventTarget, key: string): void => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }),
    );
  };

  it('binds its regions to the root the element provides', async () => {
    const el = await loaded();
    const got: ViewerContext[] = [];
    requestContext($(el, '.list'), viewerContext, (v) => got.push(v));
    expect(got).toHaveLength(1);
    expect(got[0]?.controller).toBe(el.controller);
    expect(got[0]?.host).toBe(el);
  });

  it('lets the change list step aside while the session has a search', async () => {
    const el = await loaded();
    el.controller.setQuery('gecko');
    expect($(el, '.list').hidden).toBe(true);
    expect($(el, '#kg-results').hidden).toBe(false);
    expect($<HTMLInputElement>(el, '.search input').value).toBe('gecko');
    el.controller.setQuery('');
    expect($(el, '.list').hidden).toBe(false);
    expect($(el, '#kg-results').hidden).toBe(true);
  });

  it('clears an active search on Escape first, back in the search box', async () => {
    const el = await loaded();
    el.next();
    $(el, '.list').focus();
    el.controller.setQuery('gecko');
    press(el, 'Escape');
    expect(el.controller.query).toBe('');
    expect(el.shadowRoot?.activeElement).toBe($(el, '.search input'));
    expect(el.controller.selectedHunk).toBeGreaterThanOrEqual(0);
    press(el, 'Escape');
    expect(el.controller.selectedHunk).toBe(-1);
  });

  it('starts a new query at its first hit, however the previous one ended', async () => {
    const el = await loaded();
    const input = $<HTMLInputElement>(el, '.search input');
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('kg-hit-1');
    press(el, 'Escape');
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    expect(input.getAttribute('aria-activedescendant')).toBe('kg-hit-0');
  });

  it('announces through the root’s single live region', async () => {
    const el = await loaded();
    el.next();
    await tick(60);
    const live = el.shadowRoot?.querySelectorAll('[aria-live]') ?? [];
    expect(live).toHaveLength(1);
    expect(live[0]?.textContent).toMatch(/^Change 1 of \d+: /);
  });
});
