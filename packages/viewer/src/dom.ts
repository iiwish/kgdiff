/**
 * A tiny DOM helper: `h(tag, props, ...children)`. Text is always set as text (never HTML);
 * only the static icon markup in `icons.ts` goes through `innerHTML`.
 */
import { ICONS, type IconName } from './icons.js';

type Child = Node | string | number | null | undefined | false | readonly Child[];

type Handler = (event: Event) => void;

export interface Props {
  readonly class?: string;
  readonly style?: string;
  readonly text?: string;
  readonly [attr: string]: string | number | boolean | null | undefined | Handler;
}

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child as readonly Child[]) append(parent, c);
    return;
  }
  parent.appendChild(
    typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : (child as Node),
  );
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') el.textContent = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value as EventListener);
      } else if (key === 'class') el.className = String(value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const c of children) append(el, c);
  return el;
}

/** Replace all children of `el`. */
export function replace(el: Element, ...children: Child[]): void {
  el.textContent = '';
  for (const c of children) append(el, c);
}

/**
 * Replace the children of `el` without losing keyboard focus: if focus was inside `el`, it moves
 * to the new element with the same `data-focus-key`, else to `fallback` (never to `<body>`).
 */
export function replaceKeepingFocus(
  root: DocumentOrShadowRoot,
  el: Element,
  fallback: HTMLElement | null,
  ...children: Child[]
): void {
  const active = root.activeElement as HTMLElement | null;
  const inside = active !== null && el.contains(active);
  const key = inside ? (active.dataset.focusKey ?? '') : '';
  replace(el, ...children);
  if (!inside) return;
  let next: HTMLElement | null = null;
  if (key) {
    for (const c of el.querySelectorAll<HTMLElement>('[data-focus-key]')) {
      if (c.dataset.focusKey === key && !(c as HTMLButtonElement).disabled) {
        next = c;
        break;
      }
    }
  }
  (next ?? fallback)?.focus({ preventScroll: true });
}

/** Set (or remove for null / false) an attribute only when it changes. */
export function attr(el: Element, name: string, value: string | boolean | null): void {
  if (value === null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const v = value === true ? '' : value;
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** An inline SVG icon (16 × 16, 1.5 px stroke, `currentColor`), hidden from assistive tech. */
export function icon(name: IconName, cls = 'icon'): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

/** An icon-only button with an accessible name and a tooltip. */
export function iconButton(
  name: IconName,
  label: string,
  onClick: (event: Event) => void,
  extra: Props = {},
): HTMLButtonElement {
  const button = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': label,
      title: label,
      onclick: onClick,
      ...extra,
    },
    icon(name),
  );
  return button;
}

/** Keep the accessible name and tooltip of an icon button in sync with the locale. */
export function relabel(el: Element, label: string): void {
  attr(el, 'aria-label', label);
  attr(el, 'title', label);
}

/**
 * Whether `el` is shown and can take focus: connected, and neither it nor an ancestor (across
 * shadow roots) is `hidden` or `inert`.
 */
export function isOpen(el: Element): boolean {
  if (!el.isConnected) return false;
  for (let n: Element | null = el; n; ) {
    if ((n as HTMLElement).hidden || (n as HTMLElement).inert) return false;
    n = n.parentElement ?? (n.getRootNode() as Partial<ShadowRoot>).host ?? null;
  }
  return true;
}

/**
 * Before `from` (a region) folds or hides: if focus is inside it, move focus to `to()`, or let
 * go of it when there is nowhere to go (focus never stays inside an inert region).
 */
export function moveFocusOut(
  root: DocumentOrShadowRoot,
  from: Element,
  to: () => HTMLElement | null | undefined,
): void {
  // A focused element inside a nested shadow root shows as its host here.
  const here = root.activeElement as HTMLElement | null;
  if (!here || !from.contains(here)) return;
  const next = to();
  if (next && !from.contains(next)) next.focus({ preventScroll: true });
  else here.blur();
}
