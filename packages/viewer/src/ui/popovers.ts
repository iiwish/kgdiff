/**
 * Popovers: the appearance menu (theme, palette, language) and the keyboard-shortcut dialog.
 */
import type { Locale } from '@kgdiff/core';
import { getTheme, type PaletteName } from '@kgdiff/scene';
import { attr, h, icon, iconButton, replaceKeepingFocus } from '../dom.js';
import type { MessageKey } from '../i18n.js';
import type { IconName } from '../icons.js';
import type { ThemePreference } from '../index.js';
import { type Keymap, type ShortcutName, shortcutKeys } from '../keyboard.js';
import { FAMILIES } from '../styles.js';
import type { UiContext } from './context.js';

interface RadioDef<T> {
  readonly value: T;
  readonly label: () => string;
  readonly icon?: IconName;
  readonly swatch?: readonly string[];
}

export class Menu {
  readonly el: HTMLElement;
  #returnFocus: HTMLElement | null = null;

  readonly #ctx: UiContext;

  constructor(ctx: UiContext) {
    this.#ctx = ctx;
    this.el = h('div', { class: 'menu card', role: 'menu', hidden: true, tabindex: '-1' });
    this.el.addEventListener('keydown', (e) => this.#onKey(e));
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(anchor: HTMLElement | null): void {
    this.#returnFocus = anchor;
    this.render();
    this.el.hidden = false;
    (this.el.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
  }

  hide(restoreFocus = true): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    if (restoreFocus) this.#returnFocus?.focus();
  }

  render(): void {
    const tr = this.#ctx.tr();
    const c = this.#ctx.controller;
    attr(this.el, 'aria-label', tr.t('action.settings'));
    const t = (key: MessageKey) => () => tr.t(key);
    const swatches = (p: PaletteName): string[] => {
      const family = getTheme(c.themeName, p).family;
      return FAMILIES.map((f) => family[f].base);
    };
    const themes: RadioDef<ThemePreference>[] = [
      { value: 'auto', label: t('theme.auto'), icon: 'monitor' },
      { value: 'light', label: t('theme.light'), icon: 'sun' },
      { value: 'dark', label: t('theme.dark'), icon: 'moon' },
    ];
    const palettes: RadioDef<PaletteName>[] = [
      { value: 'default', label: t('palette.default'), swatch: swatches('default') },
      { value: 'colorblind', label: t('palette.colorblind'), swatch: swatches('colorblind') },
    ];
    const locales: RadioDef<Locale>[] = [
      { value: 'en', label: () => 'English' },
      { value: 'zh-CN', label: () => '简体中文' },
    ];
    attr(this.el, 'aria-label', tr.t('action.settings'));
    replaceKeepingFocus(
      this.#ctx.root,
      this.el,
      this.el,
      this.#group(tr.t('menu.theme'), themes, c.themePreference, (v) =>
        this.#ctx.setThemePreference(v),
      ),
      this.#group(tr.t('menu.palette'), palettes, c.palette, (v) => this.#ctx.setPalette(v)),
      this.#group(tr.t('menu.language'), locales, c.locale, (v) => this.#ctx.setLocale(v)),
    );
  }

  #group<T extends string>(
    title: string,
    items: readonly RadioDef<T>[],
    current: T,
    onPick: (value: T) => void,
  ): HTMLElement {
    return h(
      'div',
      { class: 'menu-group', role: 'group', 'aria-label': title },
      h('div', { class: 'menu-label', 'aria-hidden': 'true', text: title }),
      items.map((item) =>
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item',
            role: 'menuitemradio',
            'data-focus-key': item.value,
            'aria-checked': String(item.value === current),
            tabindex: '-1',
            onclick: () => {
              onPick(item.value);
              this.render();
              (this.el.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
            },
          },
          item.icon ? icon(item.icon) : null,
          item.swatch
            ? h(
                'span',
                { class: 'sw', 'aria-hidden': 'true' },
                item.swatch.map((c) => h('i', { style: `background:${c}` })),
              )
            : null,
          h('span', { text: item.label() }),
          icon('check', 'icon check'),
        ),
      ),
    );
  }

  #onKey(e: KeyboardEvent): void {
    const items = [...this.el.querySelectorAll<HTMLElement>('.menu-item')];
    const i = items.indexOf(this.#ctx.root.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      e.stopPropagation();
      this.hide(e.key === 'Escape');
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
  }
}

type Label = MessageKey | readonly MessageKey[];

/**
 * Shortcut rows, by the shortcuts they list; labels reuse the controls' own names where they
 * exist. A row of several labels names one shortcut each.
 */
const SHORTCUTS: readonly (readonly [readonly ShortcutName[], Label])[] = [
  [
    ['overlay', 'swipe', 'replay'],
    ['mode.overlay', 'mode.swipe', 'mode.replay'],
  ],
  [['scope'], 'mode.changes'],
  [['next'], 'detail.next'],
  [['prev'], 'detail.prev'],
  [['first', 'last'], 'help.homeEnd'],
  [['fly'], 'help.enter'],
  [['escape'], 'help.esc'],
  [['play-pause'], 'help.space'],
  [['left', 'right'], 'help.arrows'],
  [['fit'], 'action.fit'],
  [
    ['zoom-in', 'zoom-out'],
    ['action.zoomIn', 'action.zoomOut'],
  ],
  [['search'], 'sidebar.search'],
  [['review'], 'review.mark'],
  [['sidebar'], 'action.sidebar'],
  [['theme'], 'help.theme'],
  [['expand'], 'help.expand'],
  [['help'], 'action.help'],
];

/** How a key shows in the dialog. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowDown: '↓',
  ArrowUp: '↑',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
  Escape: 'Esc',
  '-': '−',
};

/** The dialog's rows for the keys bound now: a shortcut with no key is left out. */
function shortcutRows(
  keymap: Keymap | null,
  omit: ReadonlySet<ShortcutName>,
): { keys: string[]; label: Label }[] {
  const bound = shortcutKeys(keymap);
  const keysOf = (name: ShortcutName): string[] =>
    omit.has(name) ? [] : (bound.get(name) ?? []).map((k) => KEY_LABELS[k] ?? k);
  const rows: { keys: string[]; label: Label }[] = [];
  for (const [names, label] of SHORTCUTS) {
    const keys = names.map(keysOf);
    if (typeof label !== 'string' && keys.some((k) => k.length !== 1)) {
      // Not one key each: a row per shortcut.
      names.forEach((_, i) => {
        const k = keys[i] ?? [];
        if (k.length > 0) rows.push({ keys: k, label: label[i] as MessageKey });
      });
    } else if (keys.flat().length > 0) rows.push({ keys: keys.flat(), label });
  }
  return rows;
}

export class HelpDialog {
  readonly el: HTMLElement;
  #returnFocus: Element | null = null;
  readonly #ctx: UiContext;
  readonly #omit: ReadonlySet<ShortcutName>;

  /** `omit`: shortcuts that do nothing in this layout (`sidebar` without a sidebar). */
  constructor(ctx: UiContext, omit: readonly ShortcutName[] = []) {
    this.#ctx = ctx;
    this.#omit = new Set(omit);
    this.el = h('div', { class: 'overlay-scrim', hidden: true });
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.hide();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      } else if (e.key === 'Tab') {
        // Keep focus inside the dialog (it has one focusable control).
        e.preventDefault();
        (this.el.querySelector('.icon-btn') as HTMLElement | null)?.focus();
      }
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(): void {
    this.#returnFocus = this.#ctx.root.activeElement;
    this.render();
    this.el.hidden = false;
    (this.el.querySelector('.icon-btn') as HTMLElement | null)?.focus();
  }

  hide(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    (this.#returnFocus as HTMLElement | null)?.focus?.();
  }

  render(): void {
    const tr = this.#ctx.tr();
    const keys = (list: readonly string[]): HTMLElement =>
      h(
        'span',
        { class: 'ks' },
        list.map((k, i) => [
          i > 0 ? h('span', { 'aria-hidden': 'true', text: '/' }) : null,
          h('kbd', { text: k }),
        ]),
      );
    // The keys bound now, after the root's `keymap`.
    const rows = shortcutRows(this.#ctx.keymap(), this.#omit).map(({ keys: list, label }) => {
      const text = typeof label === 'string' ? tr.t(label) : label.map((k) => tr.t(k)).join(' / ');
      return h('div', { class: 'key-row' }, h('span', { text }), keys(list));
    });
    replaceKeepingFocus(
      this.#ctx.root,
      this.el,
      null,
      h(
        'div',
        {
          class: 'dialog card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'kg-help-title',
        },
        h(
          'div',
          { class: 'dialog-head' },
          h('h2', { id: 'kg-help-title', text: tr.t('help.title') }),
          iconButton('close', tr.t('help.close'), () => this.hide(), {
            'data-focus-key': 'close',
          }),
        ),
        h('div', { class: 'dialog-body' }, h('div', { class: 'keys' }, rows)),
      ),
    );
  }
}
