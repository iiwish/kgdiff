/**
 * Accessibility checks of every region (RFC 0001 phase 3): roles and names of the controls in
 * each state, landmarks, the one live region, and the focus order, for the default layout and
 * for a composed root. What happy-dom cannot check (computed styles, sequential focus
 * navigation, what a screen reader says) is listed in docs/interaction.md §Accessibility.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index.js';
import type { KgdiffRootElement, KgdiffViewerElement } from '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import type { DiffSession } from '../src/session.js';
import { mockBackend, tick, zoo } from './support.js';

beforeEach(() => {
  setRenderBackend(mockBackend());
  localStorage.clear();
});

afterEach(() => {
  document.body.textContent = '';
  setRenderBackend(null);
  vi.restoreAllMocks();
});

type Root = KgdiffRootElement & { controller: DiffSession };

function place<T extends Element>(html: string, selector: string): T {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  document.body.append(tpl.content);
  return document.querySelector(selector) as T;
}

async function loaded(root: Root): Promise<void> {
  await root.load(zoo());
  await tick();
}

/** The flat tree in order: shadow roots instead of light children, slots by what they show. */
function* flat(node: Element | ShadowRoot): Generator<Element> {
  const children =
    node instanceof HTMLSlotElement
      ? node.assignedElements().length > 0
        ? node.assignedElements()
        : [...node.children]
      : [...((node as Element).shadowRoot ?? node).children];
  for (const el of children) {
    yield el;
    yield* flat(el);
  }
}

/** The flat-tree parent (the slot an element is assigned to, a shadow root's host). */
function parentOf(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  return el.parentElement ?? (el.getRootNode() as Partial<ShadowRoot>).host ?? null;
}

/** Not hidden or inert, itself or in the flat tree above it (styles aside). */
function shown(el: Element): boolean {
  for (let n: Element | null = el; n; n = parentOf(n)) {
    if ((n as HTMLElement).hidden || (n as HTMLElement).inert) return false;
    if (n.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
}

/** The accessible name, roughly: aria-labelledby, aria-label, then the text, then title. */
function nameOf(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (ids) {
    const tree = el.getRootNode() as ShadowRoot | Document;
    return ids
      .split(/\s+/)
      .map((id) => tree.getElementById?.(id)?.textContent ?? '')
      .join(' ')
      .trim();
  }
  return (
    el.getAttribute('aria-label') ??
    ((el.textContent ?? '').trim() || el.getAttribute('title') || '')
  );
}

/** Roles whose elements need a name (WAI-ARIA), and the native controls. */
const NAMED = new Set([
  'button',
  'checkbox',
  'combobox',
  'dialog',
  'img',
  'listbox',
  'menu',
  'menuitemradio',
  'radio',
  'radiogroup',
  'region',
  'separator',
  'slider',
  'toolbar',
]);

function roleOf(el: Element): string | null {
  const role = el.getAttribute('role');
  if (role) return role;
  if (el.localName === 'button') return 'button';
  if (el.localName === 'input') return 'textbox';
  return null;
}

/** The controls shown without a name, described for the failure message. */
function unnamed(top: Element): string[] {
  const out: string[] = [];
  for (const el of flat(top)) {
    const role = roleOf(el);
    if (!role || !NAMED.has(role) || !shown(el)) continue;
    // A separator needs a name only when it can be focused (a splitter).
    if (role === 'separator' && el.getAttribute('tabindex') === null) continue;
    if (nameOf(el) === '') out.push(`${el.localName}.${el.className} [${role}]`);
  }
  return out;
}

/** What takes focus with Tab, in the flat tree's order (styles aside). */
function tabbable(top: Element): Element[] {
  return [...flat(top)].filter((el) => {
    const native =
      ['button', 'input', 'select', 'textarea'].includes(el.localName) ||
      (el.localName === 'a' && el.hasAttribute('href'));
    if (!native && !el.hasAttribute('tabindex')) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    return (el as HTMLElement).tabIndex >= 0 && shown(el);
  });
}

/** Live regions: `aria-live`, and the roles that imply it. */
function liveRegions(top: Element): Element[] {
  return [...flat(top)].filter(
    (el) =>
      el.hasAttribute('aria-live') ||
      ['status', 'alert', 'log'].includes(el.getAttribute('role') ?? ''),
  );
}

describe('<kgdiff-viewer>', () => {
  type Viewer = KgdiffViewerElement & Root;

  it('names every control shown, in every state', async () => {
    const viewer = place<Viewer>('<kgdiff-viewer></kgdiff-viewer>', 'kgdiff-viewer');
    await loaded(viewer);
    const $ = (sel: string) => viewer.shadowRoot?.querySelector(sel) as HTMLElement;
    expect(unnamed(viewer)).toEqual([]);
    viewer.mode = 'swipe';
    viewer.controller.flush();
    expect(unnamed(viewer)).toEqual([]);
    viewer.mode = 'replay';
    viewer.controller.flush();
    expect($('.transport').hidden).toBe(false);
    expect(unnamed(viewer)).toEqual([]);
    viewer.mode = 'overlay';
    viewer.scope = 'changes';
    viewer.controller.flush();
    expect(unnamed(viewer)).toEqual([]);
    // The appearance menu, the search's results, the shortcuts dialog.
    ($('.hud-actions button') as HTMLButtonElement).click();
    expect($('[role="menu"]').hidden).toBe(false);
    expect(unnamed(viewer)).toEqual([]);
    const input = $('input[role="combobox"]') as HTMLInputElement;
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    input.focus();
    viewer.controller.flush();
    await tick(10);
    expect(unnamed(viewer)).toEqual([]);
    ($('.hud-actions button') as HTMLButtonElement).click();
    $('canvas').dispatchEvent(
      new KeyboardEvent('keydown', { key: '?', bubbles: true, composed: true }),
    );
    expect($('[role="dialog"]')).not.toBeNull();
    expect(unnamed(viewer)).toEqual([]);
  });

  it('has one main landmark, one live region, and tabs canvas, chrome, actions, sidebar', async () => {
    const viewer = place<Viewer>('<kgdiff-viewer></kgdiff-viewer>', 'kgdiff-viewer');
    await loaded(viewer);
    const all = [...flat(viewer)];
    expect(all.filter((el) => el.localName === 'main' && !el.hasAttribute('role'))).toHaveLength(1);
    expect(liveRegions(viewer).map((el) => el.getAttribute('aria-live'))).toEqual(['polite']);
    expect(all.filter((el) => (el as HTMLElement).tabIndex > 0)).toEqual([]);
    const AREAS = ['hud', 'sidebar', 'dock', 'zoom-bar', 'legend', 'swipe', 'stage'];
    const area = (el: Element): string =>
      AREAS.find((a) => el.closest(`.${a}`)) ?? `${el.localName}.${el.className}`;
    const order = tabbable(viewer)
      .map(area)
      .filter((a, i, list) => a !== list[i - 1]);
    expect(order).toEqual(['stage', 'legend', 'zoom-bar', 'dock', 'hud', 'sidebar']);
    // The page's content in a slot tabs where the slot is: top corners before the chrome.
    const card = document.createElement('button');
    card.slot = 'top-end';
    card.textContent = 'Page action';
    viewer.append(card);
    await tick();
    const withCard = tabbable(viewer);
    expect(withCard.indexOf(card)).toBe(1);
  });

  it('leaves no tab stop in a region that is collapsed or hidden', async () => {
    const viewer = place<Viewer>(
      '<kgdiff-viewer panels="dock:hidden zoom:hidden list:collapsed"></kgdiff-viewer>',
      'kgdiff-viewer',
    );
    await loaded(viewer);
    const stops = tabbable(viewer);
    expect(stops.some((el) => el.closest('.dock-bar'))).toBe(false);
    expect(stops.some((el) => el.closest('.zoom-bar'))).toBe(false);
    expect(
      stops.some((el) => el.closest('[role="listbox"]') || el.matches('[role="listbox"]')),
    ).toBe(false);
  });
});

describe('a composed root', () => {
  const html = `<kgdiff-root id="r">
      <kgdiff-title></kgdiff-title><kgdiff-actions></kgdiff-actions>
      <kgdiff-stage id="s1" version="before"><kgdiff-zoom slot="bottom-end"></kgdiff-zoom></kgdiff-stage>
      <kgdiff-stage id="s2" version="after"></kgdiff-stage>
      <kgdiff-view-dock></kgdiff-view-dock><kgdiff-transport></kgdiff-transport>
      <kgdiff-legend open></kgdiff-legend><kgdiff-minimap stage="s2"></kgdiff-minimap>
      <kgdiff-search></kgdiff-search><kgdiff-filters></kgdiff-filters>
      <kgdiff-change-list></kgdiff-change-list><kgdiff-change-detail></kgdiff-change-detail>
    </kgdiff-root>`;

  it('names every element’s controls, in every state', async () => {
    const root = place<Root>(html, 'kgdiff-root');
    await loaded(root);
    expect(unnamed(root)).toEqual([]);
    root.mode = 'replay';
    root.controller.flush();
    expect(unnamed(root)).toEqual([]);
    root.next();
    root.controller.flush();
    expect(unnamed(root)).toEqual([]);
    const actions = (root.querySelector('kgdiff-actions') as Element).shadowRoot as ShadowRoot;
    (actions.querySelector('.hud-actions button') as HTMLButtonElement).click();
    expect(unnamed(root)).toEqual([]);
    (actions.querySelectorAll('.hud-actions button')[1] as HTMLButtonElement).click();
    expect(actions.querySelector('[role="dialog"]')).not.toBeNull();
    expect(unnamed(root)).toEqual([]);
  });

  it('makes each stage a named region, not a main landmark; one live region, the root’s', async () => {
    const root = place<Root>(html, 'kgdiff-root');
    await loaded(root);
    const all = [...flat(document.body)];
    expect(all.filter((el) => el.localName === 'main' && !el.hasAttribute('role'))).toEqual([]);
    const regions = all.filter((el) => el.getAttribute('role') === 'region').map(nameOf);
    expect(regions).toEqual(['Graph diff · Before', 'Graph diff · After']);
    const live = liveRegions(document.body);
    expect(live).toHaveLength(1);
    expect(live[0]?.getRootNode()).toBe(root.shadowRoot);
    // The end of a replay is announced there, once: the pills are no status of their own.
    root.mode = 'replay';
    root.controller.flush();
    expect(liveRegions(document.body)).toHaveLength(1);
  });

  it('tabs through the elements in the page’s order, each in its own', async () => {
    const root = place<Root>(html, 'kgdiff-root');
    await loaded(root);
    const owner = (el: Element): string => {
      let host = (el.getRootNode() as Partial<ShadowRoot>).host ?? null;
      while (host && !host.localName.startsWith('kgdiff-')) {
        host = (host.getRootNode() as Partial<ShadowRoot>).host ?? null;
      }
      return host ? `${host.localName}${host.id ? `#${host.id}` : ''}` : el.localName;
    };
    // A change selected: its details have controls of their own.
    root.next();
    root.controller.flush();
    const order = tabbable(root)
      .map(owner)
      .filter((a, i, list) => a !== list[i - 1]);
    expect(order).toEqual([
      'kgdiff-actions',
      'kgdiff-stage#s1',
      'kgdiff-zoom',
      'kgdiff-stage#s1',
      'kgdiff-stage#s2',
      'kgdiff-view-dock',
      'kgdiff-legend',
      'kgdiff-search',
      'kgdiff-filters',
      'kgdiff-change-list',
      'kgdiff-change-detail',
    ]);
  });

  it('moves focus into the shortcuts dialog, keeps it there and gives it back', async () => {
    const root = place<Root>(html, 'kgdiff-root');
    await loaded(root);
    const actions = root.querySelector('kgdiff-actions') as Element;
    const help = actions.shadowRoot?.querySelectorAll(
      '.hud-actions button',
    )[1] as HTMLButtonElement;
    help.focus();
    help.click();
    const dialog = actions.shadowRoot?.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(nameOf(dialog)).toBe('Keyboard shortcuts');
    const close = dialog.querySelector('.icon-btn') as HTMLElement;
    expect(actions.shadowRoot?.activeElement).toBe(close);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(actions.shadowRoot?.activeElement).toBe(close);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(actions.shadowRoot?.activeElement).toBe(help);
  });
});
